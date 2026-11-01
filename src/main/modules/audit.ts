/**
 * 审计日志（哈希链）与指纹一致性自检。
 *
 * 审计：每条记录把「上一条的 hash + 本条内容」一起做 SHA-256，形成单向链。
 * 只追加、不修改，任何人删改中间一条都会让后续所有 hash 对不上，
 * 所以「验证完整性」只要从头重算一遍就能定位断点。
 *
 * 自检：把环境里配置的指纹与页面真实读数逐项对照。
 * 这里刻意不复用 tools/audit-fp.mjs —— 那是外部独立脚本，
 * 靠 Playwright 驱动整个应用，主进程内嵌不了，只借用了它的探测思路。
 *
 * 归属：audit-agent
 */

import { CH } from '@shared/ipc'
import { describeAction } from '@shared/protocol'
import type {
  AuditEntry,
  AuditVerifyResult,
  CheckSeverity,
  ConsistencyItem,
  ConsistencyReport,
  FingerprintConfig,
  OSKind
} from '@shared/types'
import { CollectionStore, GATE_ACTION_PREFIX, type Stores } from '@main/store'
import { bridgeFor } from '@main/core/cdp'
import { judgeMask } from '@main/core/mask-gate'
import type { GateEvent } from '@main/agent/actions'
import type { ConsentOutcome, ConsentRequest } from '@main/agent/consent'
import { digest, verifyChain, ZERO_HASH } from './audit-chain'
import { boundDetail, boundMatched, boundTarget } from './audit-bound'
import type { ModuleContext } from './context'

/* ────────────────────────────── 审计：写入与校验 ────────────────────────────── */

/**
 * 追加一条审计记录。供其他模块直接调用，所以参数保持扁平，
 * 也允许不传 target/detail（哈希里按空串参与计算）。
 */
export function appendAudit(
  stores: Stores,
  action: string,
  target?: string,
  detail?: string,
  actor = 'local'
): AuditEntry {
  const all = stores.audit.list()
  const last = all.length > 0 ? all[all.length - 1] : null
  const seq = last ? last.seq + 1 : 1
  const prev = last ? last.hash : ZERO_HASH
  const at = Date.now()

  // 收口点只有这一个：所有调用方的 target / detail 都从这里过。
  //
  // 为什么不是逐个插值点各截一次：`auditGate` / `auditConsent` 里已经各截过一次
  // `matched`，但 `reason` 和 `target` 都漏了 —— 页面写的元素名内嵌在 `reason`
  // 里，10KB 的名字照样落盘。逐个补的做法等于每加一个字段就多一个漏点，
  // 而这次已经证明了会漏。收口点只有一个，才谈得上「不会再漏」。
  //
  // 注意 hash 必须用**收口后**的值：如果 hash 覆盖原文而存储的是截断版，
  // 校验时会重算出不一致的 hash，把一次正常截断报成一次篡改。
  //
  // 与之配套的一条约束：**`verifyChain()` 重算时不得再施加收口。**
  // 它用的是 `e.target` / `e.detail`，也就是盘上的存储值 —— 旧记录写入时
  // hash 覆盖的就是它当时那份原始值，重算也用同一份，仍然自洽。
  // 谁要是「顺手统一一下」在校验侧也调 `boundDetail`，盘上所有超过 400 字的
  // 历史记录会集体报篡改：一条修 bug 的改动制造一整批假警报。
  // 收口只发生在**写入时**，这是单向的。
  const safeTarget = boundTarget(target)
  const safeDetail = boundDetail(detail)

  const entry: AuditEntry = {
    id: CollectionStore.newId('aud'),
    seq,
    at,
    actor,
    action,
    target: safeTarget,
    detail: safeDetail,
    prev,
    hash: digest(prev, seq, at, actor, action, safeTarget ?? '', safeDetail ?? '')
  }
  stores.audit.add(entry)
  // 追加成功后立刻把尾部锚点写到 settings（**另一个文件**）。
  //
  // 顺序不能反：先写锚点再追加的话，崩溃会留下「锚点指向一条不存在的记录」，
  // 那和「尾部被删」在校验时长得一模一样，只能靠文案去猜。现在这个顺序崩溃时
  // 留下的是「锚点落后于日志」，语义明确，而且下一次追加会自动对齐。
  //
  // setAuditHead 内部吞掉写盘失败（见 store/settings.ts）：记录已经落盘了，
  // 不能因为锚点写不进去就把这次追加报成失败。
  stores.settings.setAuditHead({ seq: entry.seq, hash: entry.hash })
  return entry
}

/**
 * 发起方在审计里怎么写。这只是「谁发起的」，不是「谁批准的」。
 *
 * 五个键不是冗余：`Approval.origin` 用的是 'agent'|'script'|'api'，
 * `ConsentRequest.origin` 用的是 'loop'|'script'|'localapi'（同一件事的两种叫法）。
 * 与其在两处各写一份映射、然后某天改一边忘另一边，不如一张表同时认这两种写法 ——
 * 落进审计的永远是同一句人话。
 */
const ORIGIN_LABEL: Record<string, string> = {
  agent: '智能体循环',
  loop: '智能体循环',
  script: '脚本回放',
  api: '本地 API',
  localapi: '本地 API'
}

/**
 * 把一次风险闸门判定写进审计链。
 *
 * 为什么单独抽一个函数：原先「动作要不要确认」这件事在 agent loop 里判、
 * 在本地 API 里判、在脚本回放里判，三处各自决定要不要记审计 ——
 * 结果只有脚本那条记了，agent 跑 40 步一个字节都不留。
 * 现在判定下沉到执行器，留痕也一起下沉，三处共用这一个落点。
 *
 * `approvedBy` 的语义变了一次，这一列必须跟着改：
 * 以前它记的是「调用方声明的授权来源」，于是 `授权=api` 和 `授权=user` 都可能是
 * 调用方自己写上去的，事后读审计根本分不清「有人点过」和「有人自称点过」。
 * 现在它由凭证是否被消费推导，只有两种取值，且 `user` 严格等价于
 * 「有人在系统原生窗口上点了允许」。发起方单独一列，两者不再混在一起。
 */
export function auditGate(stores: Stores, event: GateEvent): void {
  const action = event.action
  const { target, marker } = describeAction(action)

  // matched 是从判定语义串里正则匹配出来的，而那段串由 `[元素名, thought]` 拼成：
  // 元素名被 `nameOf()` 截到 90（页面那半有界），`thought` 是模型写的、无长度限制。
  // 所以能撑爆审计的是**模型**，不是页面 —— 这一点原先写反了。
  // 截断必须可见：`paypal` + 5000 空格 + `checkout` 能命中 `paypal\s*checkout`，
  // 实测 matched.length = 5014。静默截成 24 个字，读审计的人会以为命中的就是这些。
  const matched = boundMatched(event.matched)

  // 这一列只陈述**执行点看到的事实**，不替同意来源作证。
  //
  // 原先它写「授权=用户在系统确认窗口点了允许」，而这个函数根本不知道票有没有被
  // 消费过 —— 它拿到的只是一个推导出来的布尔值。一条断言了没发生的事的审计记录，
  // 比没有记录更坏：事后追责会照着它得出错误结论。
  // 「用户点了允许」这件事由 requestConsent 自己写一条，两条记录各证一半。
  //
  // L1 单独一种说法：L1 根本不进闸门、不需要授权，写「未授权」会让用户以为
  // 「有个操作没经过我同意就执行了」—— 那是在制造恐慌，不是在记录事实。
  const authority =
    event.level !== 'L2'
      ? '不需要授权（可回退动作，不进闸门）'
      : event.approvedBy === 'user'
        ? '本次执行已获授权（票据消费成功）'
        : '本次执行未获授权（无有效票据），动作已拦下'
  const from = `发起=${ORIGIN_LABEL[event.origin] ?? event.origin}`

  appendAudit(
    stores,
    // 前缀是淘汰保护的判据（见 store/index.ts 的 AUDIT_RETAIN），
    // 两边必须用同一个常量 —— 写字面量的话改一边另一边会静默失效：
    // 记录还在写，但已经不再受保护了。
    GATE_ACTION_PREFIX + (event.level === 'L2' ? '不可逆' : '可回退'),
    target,
    `${authority}；${from}；${event.reason}${matched ? `；命中「${matched}」` : ''}${marker}`
  )
}

/** 同意来源在审计里的写法 */
const CONSENT_TEXT: Record<ConsentOutcome['kind'], string> = {
  granted: '用户在系统确认窗口点了「允许执行」，已发出一张一次性凭证',
  denied: '用户在系统确认窗口点了「取消」',
  timeout: '系统确认窗口 120 秒内无人确认，按拒绝处理',
  unavailable: '系统确认窗口无法弹出（无可用窗口/环境异常），按拒绝处理'
}

/**
 * 把一次**同意询问**的结果写进审计链。
 *
 * 与 `auditGate` 的分工：这个函数证明「凭证从哪来」，`auditGate` 证明
 * 「执行器校验过凭证」。合成一条必然有一半是猜的。
 *
 * 挂载点在 `consent.ts` 的 `requestConsent` 里 —— loop / script / localapi 三条
 * 路径唯一的汇聚点，所以「拒签不写审计」这种漏记不可能发生。
 * 前缀必须是 `GATE_ACTION_PREFIX`：`store/index.ts` 的 `AUDIT_RETAIN` 只保留
 * 这个前缀，写别的会在 5000 条上限时被当成普通记录淘汰掉 ——
 * 而「谁拒了一次支付」正是最不该被淘汰的那种记录。
 */
export function auditConsent(stores: Stores, outcome: ConsentOutcome, req: ConsentRequest): void {
  const action = req.action
  const { target, marker } = describeAction(action)
  const matched = boundMatched(req.matched)

  appendAudit(
    stores,
    GATE_ACTION_PREFIX + '同意',
    target,
    `同意来源=${CONSENT_TEXT[outcome.kind]}；发起=${ORIGIN_LABEL[req.origin] ?? req.origin}；` +
      `${req.reason}${matched ? `；命中「${matched}」` : ''}${marker}`
  )
}

/** 最新在前，默认 200 条：面板只需要近期记录，全量拉过来既慢又没必要 */
export function listAudit(stores: Stores, limit = 200): AuditEntry[] {
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 200
  return stores.audit.list().reverse().slice(0, cap)
}

/**
 * 审计链校验。
 *
 * 最重要的一条不是「怎么验」，而是**先确认读得到**。
 *
 * 原先这里第一行就是 `stores.audit.list()`，然后 `if (all.length === 0) return { ok: true }`。
 * 而 `list()` 在文件损坏时是**降级返回空数组**的（见 store/json-file.ts 的 quarantine）——
 * 于是「有人删了/写坏了审计文件」在界面上显示为「链路为空」，`ok: true`，绿灯。
 * 这不是文案问题：它把一次可能的证据销毁报成了「一切正常」。
 *
 * 现在的顺序是「读 → 问 corruption → 再谈链」，注意这三步的次序不能换：
 * `corruption` 是上一次读失败留下的**判定**，不先读一次它恒为 null，
 * 于是「先查 corruption」在冷进程里等于没查（IPC 不保证面板一定先 list 再 verify）。
 *
 * 并且 `unreadable` 是「不知道」，不是「链断了」—— 两者在界面上必须区分开。
 *
 * 校验内核在 `./audit-chain.ts`：那边零依赖，能被 Node 单测。
 */
export function verifyAudit(stores: Stores): AuditVerifyResult {
  // 先读一次，再问「读到了吗」。
  //
  // `corruption` 是**上一次读失败**留下的判定，没读过就恒为 null —— 先查它，
  // 在一个还没读过审计文件的进程里永远查不到（IPC 调用顺序不保证面板一定先
  // list 再 verify）。顺序反了，一个损坏的审计文件会被报成「链路为空」= 通过。
  const all = stores.audit.list()
  const corruption = stores.audit.corruption
  if (corruption !== null) {
    // 文案按 kind 分支：`io` 是「读不到」（文件被占用/没权限），数据本身可能完好；
    // 其余是「文件已损坏」。说反了会把人引去做错误的补救动作。
    //
    // 刻意不提「从备份恢复」：现在没有任何面向用户的备份/恢复机制，
    // 写那句话等于让用户去找一个不存在的东西。
    const why =
      corruption.kind === 'io'
        ? '审计文件读不到（文件被占用或没有权限）'
        : '审计文件已损坏'
    return {
      consistent: false,
      total: 0,
      kind: 'unreadable',
      message: `${why}，无法判断链路是否完整：${corruption.file}`
    }
  }

  // 链内校验 + 链外锚点比对都在 `./audit-chain.ts` 里 —— 那个文件零依赖，
  // 能被 Node 直接单测（这里 import 了 electron，测不了）。
  // 这一层只做三件事：读盘、把锚点递进去、把内核要求建立的锚点落盘。
  const verdict = verifyChain(all, stores.settings.getAuditHead())
  if (verdict.adoptHead !== undefined) {
    // unanchored：升级上来的旧数据，或 settings.json 被删。内核不落盘（它必须是纯函数），
    // 所以这里补一次写。**这一轮仍然返回不通过** —— 锚点只对以后的校验有效。
    stores.settings.setAuditHead(verdict.adoptHead)
  }
  const { adoptHead: _adopt, ...result } = verdict
  return result
}

/* ────────────────────────────── 自检：页面探针 ────────────────────────────── */

interface ProbeResult {
  ua: string
  platform: string
  uaDataPlatform: string
  languages: string[]
  screen: [number, number]
  colorDepth: number
  dpr: number
  tz: string
  offsetJan: number
  offsetJul: number
  utcHour: number
  webgl: { vendor: string; renderer: string }
  /** 连续两次渲染的哈希，用来判断噪声是否真的在起作用 */
  canvas: [string, string]
  audio: [string, string]
  rtc: string[]
  fonts: Record<string, { check: boolean; measure: boolean }>
  intlLocale: string
  speechLang: string
  mqMatch: boolean
  mqWidth: number
}

/**
 * 探针脚本在页面里执行，只能用 ES2017 语法和 DOM API，不能引用任何 Node 侧变量。
 * 字体名单由主进程注入：既要验证白名单里的字体在不在，也要看白名单外是否漏了真机字体。
 */
function buildProbe(fontNames: string[]): string {
  return `(async () => {
  const canvasHash = () => {
    try {
      const c = document.createElement('canvas')
      c.width = 200
      c.height = 40
      const x = c.getContext('2d')
      x.textBaseline = 'top'
      x.font = '14px Arial'
      x.fillStyle = '#f60'
      x.fillRect(0, 0, 200, 40)
      x.fillStyle = '#069'
      x.fillText('ShadowSurf audit', 2, 2)
      const d = c.toDataURL()
      let h = 0
      for (let i = 0; i < d.length; i += 1) h = (h * 31 + d.charCodeAt(i)) | 0
      return (h >>> 0).toString(16)
    } catch (e) {
      return 'ERR'
    }
  }

  const audioHash = async () => {
    try {
      const ctx = new OfflineAudioContext(1, 44100, 44100)
      const osc = ctx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.value = 10000
      const comp = ctx.createDynamicsCompressor()
      osc.connect(comp)
      comp.connect(ctx.destination)
      osc.start(0)
      const buf = await ctx.startRendering()
      const d = buf.getChannelData(0)
      let sum = 0
      for (let i = 4500; i < 5000; i += 1) sum += Math.abs(d[i])
      return sum.toFixed(8)
    } catch (e) {
      return 'ERR'
    }
  }

  // 双路探测：document.fonts.check 会被字体覆盖脚本直接影响，
  // canvas 度量则反映排版真实用到的字体，两者都命中才算存在。
  const fontHit = (name) => {
    let check = false
    try {
      check = document.fonts.check('16px "' + name + '"')
    } catch (e) {
      check = false
    }
    let measure = false
    try {
      const c = document.createElement('canvas').getContext('2d')
      const bases = ['monospace', 'sans-serif', 'serif']
      for (const b of bases) {
        c.font = '16px ' + b
        const w1 = c.measureText('mmmmmmmmmmlli').width
        c.font = '16px "' + name + '", ' + b
        const w2 = c.measureText('mmmmmmmmmmlli').width
        if (Math.abs(w1 - w2) > 0.1) {
          measure = true
          break
        }
      }
    } catch (e) {
      measure = false
    }
    return { check: check, measure: measure }
  }

  const gl = (() => {
    try {
      const c = document.createElement('canvas')
      const g = c.getContext('webgl')
      if (!g) return { vendor: 'N/A', renderer: 'N/A' }
      const ext = g.getExtension('WEBGL_debug_renderer_info')
      return {
        vendor: String(ext ? g.getParameter(ext.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR)),
        renderer: String(ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER))
      }
    } catch (e) {
      return { vendor: 'ERR', renderer: 'ERR' }
    }
  })()

  const fonts = {}
  const names = ${JSON.stringify(fontNames)}
  for (let i = 0; i < names.length; i += 1) fonts[names[i]] = fontHit(names[i])

  // 候选里出现内网地址说明 WebRTC 没被挡住，这是最容易被风控抓到的一类泄漏
  const rtc = await new Promise((resolve) => {
    const out = []
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve(out)
    }
    try {
      const pc = new RTCPeerConnection({ iceServers: [] })
      pc.onicecandidate = (e) => {
        if (!e.candidate) {
          try { pc.close() } catch (err) {}
          finish()
          return
        }
        out.push(e.candidate.candidate)
      }
      pc.createDataChannel('probe')
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .catch(() => finish())
      setTimeout(() => {
        try { pc.close() } catch (err) {}
        finish()
      }, 1500)
    } catch (e) {
      finish()
    }
  })

  const uaData = navigator.userAgentData || null
  const intl = Intl.DateTimeFormat().resolvedOptions()
  let speechLang = 'none'
  try {
    const voices = speechSynthesis.getVoices()
    if (voices.length > 0) speechLang = voices[0].lang
  } catch (e) {
    speechLang = 'ERR'
  }

  // 二分出媒体查询眼中的设备宽度：screen.width 可以被 JS 改写，CSS 媒体查询改不了，
  // 两边不一致就是一眼假的破绽。
  let mqWidth = 0
  try {
    let lo = 200
    let hi = 10000
    for (let i = 0; i < 14; i += 1) {
      const mid = Math.round((lo + hi) / 2)
      if (matchMedia('(min-device-width: ' + mid + 'px)').matches) lo = mid
      else hi = mid
    }
    mqWidth = lo
  } catch (e) {
    mqWidth = 0
  }

  let mqMatch = false
  try {
    mqMatch = matchMedia('(device-width: ' + screen.width + 'px)').matches
  } catch (e) {
    mqMatch = false
  }

  const c1 = canvasHash()
  const c2 = canvasHash()
  const a1 = await audioHash()
  const a2 = await audioHash()

  return {
    ua: navigator.userAgent,
    platform: navigator.platform,
    uaDataPlatform: uaData ? String(uaData.platform) : 'N/A',
    languages: Array.prototype.slice.call(navigator.languages || []),
    screen: [screen.width, screen.height],
    colorDepth: screen.colorDepth,
    dpr: devicePixelRatio,
    tz: intl.timeZone,
    offsetJan: new Date(2026, 0, 15).getTimezoneOffset(),
    offsetJul: new Date(2026, 6, 15).getTimezoneOffset(),
    // 用 UTC 时间戳取本地小时：只改了 getTimezoneOffset 而没平移时钟的假时区会在这里露馅
    utcHour: new Date(Date.UTC(2026, 0, 15, 20, 0, 0)).getHours(),
    webgl: gl,
    canvas: [c1, c2],
    audio: [a1, a2],
    rtc: rtc,
    fonts: fonts,
    intlLocale: intl.locale,
    speechLang: speechLang,
    mqMatch: mqMatch,
    mqWidth: mqWidth
  }
})()`
}

/* ────────────────────────────── 自检：期望值计算 ────────────────────────────── */

const NAV_PLATFORM: Record<OSKind, string> = {
  windows: 'Win32',
  macos: 'MacIntel',
  linux: 'Linux x86_64'
}

const UADATA_PLATFORM: Record<OSKind, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux'
}

/** 目标时区在某一时刻的 UTC 偏移（分钟，东为正）；时区名非法时返回 null */
function tzOffsetMinutes(timeZone: string, at: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).formatToParts(at)
    const pick = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
    // 把「该时区的墙上时间」当成 UTC 再减回真实时刻，差值就是偏移
    const asUtc = Date.UTC(
      pick('year'),
      pick('month') - 1,
      pick('day'),
      pick('hour') % 24,
      pick('minute'),
      pick('second')
    )
    return Math.round((asUtc - at.getTime()) / 60_000)
  } catch {
    return null
  }
}

/** 目标时区在某一时刻的墙上小时数；用于验证页面本地时间是否被平移 */
function hourInZone(timeZone: string, at: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      hour: '2-digit'
    }).formatToParts(at)
    const hour = Number(parts.find((p) => p.type === 'hour')?.value)
    return Number.isFinite(hour) ? hour % 24 : null
  } catch {
    return null
  }
}

function item(
  key: string,
  label: string,
  expected: string,
  actual: string,
  severity: CheckSeverity,
  hint?: string
): ConsistencyItem {
  return { key, label, expected, actual, severity, hint }
}

/** 从 ICE 候选串里挑出内网地址：私有 IPv4 与链路本地 IPv6 都算泄漏 */
function privateAddrs(candidates: string[]): string[] {
  const found: string[] = []
  const v4 = /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})\b/
  for (const c of candidates) {
    const m = v4.exec(c)
    if (m) {
      if (!found.includes(m[1])) found.push(m[1])
      continue
    }
    if (/fe80::/i.test(c)) found.push('fe80::/10')
  }
  return found
}

const FONT_EXTRA = ['Arial', 'Segoe UI', 'Helvetica Neue', 'Consolas', 'DejaVu Sans', 'Noto Sans', 'Menlo']

/** 把配置与读数逐项对照，顺序即面板里的展示顺序：越容易被识破的越靠前 */
function compare(probe: ProbeResult, fp: FingerprintConfig): ConsistencyItem[] {
  const items: ConsistencyItem[] = []

  items.push(
    item(
      'ua',
      'User-Agent',
      fp.userAgent,
      probe.ua,
      probe.ua === fp.userAgent ? 'pass' : 'fail',
      probe.ua === fp.userAgent ? undefined : '站点读到的 UA 与配置不一致，UA 覆盖没有生效或被页面脚本改写'
    )
  )

  const navExpected = NAV_PLATFORM[fp.os]
  items.push(
    item(
      'platform',
      'navigator.platform',
      navExpected,
      probe.platform,
      probe.platform === navExpected ? 'pass' : 'fail',
      probe.platform === navExpected ? undefined : '平台标识与 UA 宣称的系统矛盾，是最常见的组合破绽'
    )
  )

  const uaDataExpected = UADATA_PLATFORM[fp.os]
  items.push(
    item(
      'uaDataPlatform',
      'UA-CH 平台',
      uaDataExpected,
      probe.uaDataPlatform,
      probe.uaDataPlatform === uaDataExpected ? 'pass' : 'warn',
      probe.uaDataPlatform === uaDataExpected ? undefined : 'UA-CH 与 UA 对不上时，现代风控会优先相信 UA-CH'
    )
  )

  const langExpected = fp.languages.join(', ')
  const langActual = probe.languages.join(', ')
  const langOk =
    probe.languages.length > 0 &&
    probe.languages[0].toLowerCase() === (fp.languages[0] ?? '').toLowerCase() &&
    probe.languages.length === fp.languages.length
  items.push(
    item(
      'languages',
      '语言列表',
      langExpected,
      langActual,
      langOk ? 'pass' : 'fail',
      langOk ? undefined : '首选语言或列表长度不一致，Accept-Language 与 JS 读数会被交叉验证'
    )
  )

  const localeOk =
    probe.intlLocale.toLowerCase() === fp.locale.toLowerCase() ||
    probe.intlLocale.toLowerCase().startsWith(fp.locale.toLowerCase())
  items.push(
    item(
      'locale',
      'Intl 区域',
      fp.locale,
      probe.intlLocale,
      localeOk ? 'pass' : 'warn',
      localeOk ? undefined : 'Intl 默认区域没跟随配置，数字/日期格式会与声明地区不符'
    )
  )

  const sizeOk = probe.screen[0] === fp.screen.width && probe.screen[1] === fp.screen.height
  const depthOk = probe.colorDepth === fp.screen.colorDepth
  const dprOk = Math.abs(probe.dpr - fp.screen.dpr) < 0.01
  items.push(
    item(
      'screen',
      '屏幕与像素比',
      `${fp.screen.width}×${fp.screen.height} @${fp.screen.dpr}x · ${fp.screen.colorDepth}bit`,
      `${probe.screen[0]}×${probe.screen[1]} @${probe.dpr}x · ${probe.colorDepth}bit`,
      sizeOk ? (dprOk && depthOk ? 'pass' : 'warn') : 'fail',
      sizeOk
        ? dprOk && depthOk
          ? undefined
          : '宽高对了但像素比或色深没对齐，缩放比例会被反推出来'
        : '屏幕宽高与配置不同，screen 覆盖没有生效'
    )
  )

  const tzOk = probe.tz === fp.timezone
  items.push(
    item(
      'timezone',
      '时区名称',
      fp.timezone,
      probe.tz,
      tzOk ? 'pass' : 'fail',
      tzOk ? undefined : 'Intl 时区名与配置不同，和代理出口地区的矛盾最容易被识破'
    )
  )

  const refJan = new Date(Date.UTC(2026, 0, 15, 12, 0, 0))
  const refJul = new Date(Date.UTC(2026, 6, 15, 12, 0, 0))
  const expJan = tzOffsetMinutes(fp.timezone, refJan)
  const expJul = tzOffsetMinutes(fp.timezone, refJul)
  const offJan = expJan === null ? null : -expJan
  const offJul = expJul === null ? null : -expJul
  const offsetOk =
    offJan !== null && offJul !== null && probe.offsetJan === offJan && probe.offsetJul === offJul
  items.push(
    item(
      'tzOffset',
      '时区偏移',
      offJan === null ? '无法解析该时区' : `冬 ${offJan} / 夏 ${offJul} 分钟`,
      `冬 ${probe.offsetJan} / 夏 ${probe.offsetJul} 分钟`,
      offsetOk ? 'pass' : expJan === null ? 'warn' : 'fail',
      offsetOk ? undefined : '时区名与 getTimezoneOffset 不符，只改名称没改偏移会立刻暴露'
    )
  )

  // 20:00 UTC 在目标时区应是几点；页面本地 getter 必须给出同一个小时
  const expectedHour = hourInZone(fp.timezone, new Date(Date.UTC(2026, 0, 15, 20, 0, 0)))
  const hourOk = expectedHour !== null && probe.utcHour === expectedHour
  items.push(
    item(
      'localTime',
      '本地时间平移',
      expectedHour === null ? '无法解析该时区' : `${expectedHour} 时（UTC 20:00 对应的本地小时）`,
      `${probe.utcHour} 时`,
      hourOk ? 'pass' : expectedHour === null ? 'warn' : 'fail',
      hourOk ? undefined : 'Date 的本地 getter 没跟着目标时区走，只改偏移不改时钟会被脚本算出来'
    )
  )

  const glExpected = `${fp.webgl.vendor} / ${fp.webgl.renderer}`
  const glActual = `${probe.webgl.vendor} / ${probe.webgl.renderer}`
  const glVendorOk = probe.webgl.vendor.toLowerCase() === fp.webgl.vendor.toLowerCase()
  const glRendererOk = probe.webgl.renderer.toLowerCase() === fp.webgl.renderer.toLowerCase()
  items.push(
    item(
      'webgl',
      'WebGL 渲染器',
      glExpected,
      glActual,
      glRendererOk ? (glVendorOk ? 'pass' : 'warn') : 'fail',
      glRendererOk
        ? glVendorOk
          ? undefined
          : '渲染器对了但厂商串没对齐，两者是成对出现的'
        : 'WebGL 读数与配置不同，GPU 串是高熵信号，风控会优先采信'
    )
  )

  // 噪声是哈希派生的，不是 Math.random()：同一环境每次渲染必须完全一致，
  // 换环境才变。所以「两次渲染一致」才是正确结果，不一致反而说明噪声接成了随机数，
  // 那种指纹在同一环境里每次刷新都变，比不伪装更容易被判定为异常。
  const canvasNoise = fp.canvas === 'noise'
  const canvasVaries = probe.canvas[0] !== probe.canvas[1]
  items.push(
    item(
      'canvas',
      'Canvas 噪声',
      canvasNoise ? '同环境恒定（哈希派生）' : '渲染结果稳定（off）',
      canvasVaries ? '两次渲染不同' : '两次渲染一致',
      canvasVaries ? 'warn' : 'pass',
      canvasVaries
        ? '同一环境内两次渲染结果不同，说明噪声用了随机数；跨环境差异无法在单个环境内验证，需要开两个环境对比'
        : canvasNoise
          ? '符合确定性要求；跨环境是否不同需要在另一个环境里再跑一次对比'
          : undefined
    )
  )

  const audioNoise = fp.audio === 'noise'
  const audioVaries = probe.audio[0] !== probe.audio[1]
  items.push(
    item(
      'audio',
      'Audio 噪声',
      audioNoise ? '同环境恒定（哈希派生）' : '渲染结果稳定（off）',
      audioVaries ? '两次渲染不同' : '两次渲染一致',
      audioVaries ? 'warn' : 'pass',
      audioVaries
        ? '同一环境内两次采样不同，说明噪声用了随机数，应当改为按种子派生'
        : audioNoise
          ? '符合确定性要求；跨环境是否不同需要在另一个环境里再跑一次对比'
          : undefined
    )
  )

  const leaks = privateAddrs(probe.rtc)
  const rtcCount = probe.rtc.length
  let rtcSeverity: CheckSeverity = 'pass'
  let rtcHint: string | undefined
  if (fp.webrtc === 'real') {
    rtcSeverity = leaks.length > 0 ? 'warn' : 'pass'
    rtcHint = '当前策略允许暴露真实网络，站点可直接读到本机地址'
  } else if (leaks.length > 0) {
    rtcSeverity = 'fail'
    rtcHint = `候选里出现了内网地址（${leaks.join('、')}），WebRTC 没有被代理或屏蔽挡住`
  } else if (fp.webrtc === 'disabled' && rtcCount > 0) {
    rtcSeverity = 'warn'
    rtcHint = '配置为屏蔽，但仍产生了 ICE 候选，建议确认屏蔽规则是否覆盖 host 候选'
  }
  items.push(
    item(
      'webrtc',
      'WebRTC 候选',
      fp.webrtc === 'disabled'
        ? '不应产生任何 ICE 候选'
        : fp.webrtc === 'proxy'
          ? '仅经代理，不应出现内网 IP'
          : '允许暴露真实网络',
      rtcCount === 0 ? '无候选' : `${rtcCount} 条候选 · ${leaks.length > 0 ? leaks.join('、') : '无内网地址'}`,
      rtcSeverity,
      rtcHint
    )
  )

  const detected = Object.keys(probe.fonts).filter(
    (name) => probe.fonts[name].check || probe.fonts[name].measure
  )
  const missing = fp.fonts.filter((f) => !detected.includes(f))
  const extra = fp.fonts.length > 0 ? detected.filter((f) => !fp.fonts.includes(f)) : []
  let fontSeverity: CheckSeverity = 'pass'
  let fontHint: string | undefined
  if (missing.length > 0) {
    fontSeverity = 'warn'
    fontHint = `白名单字体未生效：${missing.join('、')}`
  } else if (extra.length > 0) {
    fontSeverity = 'warn'
    fontHint = `出现白名单外的字体：${extra.join('、')}，真机字体仍在泄漏`
  }
  items.push(
    item(
      'fonts',
      '字体',
      fp.fonts.length > 0 ? fp.fonts.join('、') : '不干预（白名单为空）',
      detected.length > 0 ? `命中 ${detected.length} 款：${detected.join('、')}` : '未探测到任何测试字体',
      fontSeverity,
      fontHint
    )
  )

  const speechWanted = (fp.languages[0] ?? fp.locale).toLowerCase()
  const speechActual = probe.speechLang.toLowerCase()
  const speechOk = speechActual !== 'none' && speechActual !== 'err' && speechActual.split('-')[0] === speechWanted.split('-')[0]
  items.push(
    item(
      'speech',
      '语音合成语言',
      `与 ${fp.languages[0] ?? fp.locale} 同语种`,
      probe.speechLang,
      speechOk ? 'pass' : 'warn',
      speechOk ? undefined : '语音列表为空或语言不符；voices 需要页面交互后才填充，可交互后重测'
    )
  )

  // mqWidth 靠二分得到，个别内核禁用了 min-device-width 时会量不出来；
  // 此时只信 matches 的结果，避免测量失败被误判成指纹造假。
  const mqOk =
    probe.mqMatch && (probe.mqWidth <= 0 || Math.abs(probe.mqWidth - fp.screen.width) <= 1)
  items.push(
    item(
      'matchMedia',
      '媒体查询设备宽度',
      `${fp.screen.width}px（应与 screen.width 一致）`,
      probe.mqWidth > 0 ? `${probe.mqWidth}px` : '无法测量',
      mqOk ? 'pass' : 'fail',
      mqOk ? undefined : 'screen.width 被改写但 CSS 媒体查询没跟着改，两边对不上就是假的'
    )
  )

  return items
}

/* ────────────────────────────── 自检：执行 ────────────────────────────── */

async function runSelfCheck(ctx: ModuleContext, profileId: string): Promise<ConsistencyReport> {
  const profile = ctx.stores.profiles.get(profileId)
  if (!profile) throw new Error('环境不存在，可能已被删除')

  const handle = ctx.wm.getTab(profileId)
  if (!handle) throw new Error('请先打开该环境再自检')

  const fp = profile.fingerprint
  // 白名单字体必须探，另外固定探一批常见系统字体，用来发现「白名单之外还在泄漏」
  const fontNames = Array.from(new Set([...fp.fonts, ...FONT_EXTRA]))

  const bridge = bridgeFor(handle.wc)
  await bridge.attach()
  // 页面要跑 WebRTC 与两轮音频渲染，默认 15s 在慢机器上偏紧
  const raw = await bridge.send<{
    result?: { value?: unknown }
    exceptionDetails?: { text?: string; exception?: { description?: string } }
  }>(
    'Runtime.evaluate',
    {
      expression: buildProbe(fontNames),
      awaitPromise: true,
      returnByValue: true,
      userGesture: false
    },
    // 第三参现在是 sessionId（CDP 原生顺序），超时挪到第四参。
    // 这里不传 sessionId：审计探针跑在主世界（根 session）。
    undefined,
    20_000
  )

  if (raw.exceptionDetails) {
    const detail = raw.exceptionDetails.exception?.description ?? raw.exceptionDetails.text ?? '未知异常'
    throw new Error(`页面探针执行失败：${detail.split('\n')[0]}`)
  }
  const probe = raw.result?.value as ProbeResult | undefined
  if (!probe || typeof probe !== 'object' || !Array.isArray(probe.screen)) {
    throw new Error('页面探针没有返回有效读数，请确认标签页仍在加载完成状态')
  }

  const items = compare(probe, fp)

  /* ── 运行时注入台账：必须进报告，且阈值必须与门禁同一个 ──
   *
   * 探针比的是「读数和配置一致吗」，它比不出「注入根本没跑」这件事的**原因**：
   * 一个属性都没装上时，读数会和配置大面积不符（分数很低），但用户看到的只是
   * 「一致性 43 分」，不知道该去修词表还是去修注入。
   *
   * 更关键的是**阈值不能各写一份**：界面说红、门禁放行（或反过来）比没有这条更坏 ——
   * 用户会按界面去关掉整个机制。所以这里直接调 `judgeMask`，与 `actions.ts`
   * 拦 L2 用的是同一个函数、同一张判定表。
   *
   * 三档的语义：
   *   pass = 状态 ok，全部属性装上
   *   warn = 门禁放行、但有子目标缺口（例如 Worker 降级）—— 不可逆动作仍可执行，
   *          用户需要知道「这个环境对 Worker 是漏的」
   *   fail = 门禁会拒绝 —— 不可逆动作此刻做不了，必须先修
   */
  const maskRecord = ctx.wm.maskStateOf(handle.wc.id)
  const maskVerdict = judgeMask(maskRecord)
  const maskDetail =
    maskRecord === null
      ? '查不到（窗口刚开或已关闭）'
      : maskRecord.state === 'ok'
        ? 'ok（全部属性装上）'
        : `${maskRecord.state}：` +
          maskRecord.failed.map((f) => `${f.source}/${f.attr}`).join('、')
  items.unshift({
    key: 'mask.ledger',
    label: '注入台账（运行时，非落盘）',
    expected: 'ok（页面侧全部属性装上）',
    actual: maskDetail,
    severity: maskVerdict.allow
      ? maskRecord !== null && maskRecord.state === 'ok'
        ? 'pass'
        : 'warn'
      : 'fail',
    hint: maskVerdict.allow
      ? maskVerdict.state === 'ok'
        ? undefined
        : '门禁仍放行不可逆动作，但该环境有子目标没伪装住（站点可用 Worker / OOPIF 探测）'
      : `${maskVerdict.reason}。当前状态下不可逆动作会被拦下`
  })

  const passed = items.filter((i) => i.severity === 'pass').length
  // 只把 pass 计入分子：warn 是「无法确证」，不算通过，分数才有区分度
  const score = items.length > 0 ? Math.round((passed / items.length) * 100) : 0

  appendAudit(
    ctx.stores,
    '指纹自检',
    profile.name,
    `一致性得分 ${score}（通过 ${passed}/${items.length}）`
  )

  return {
    profileId: profile.id,
    profileName: profile.name,
    score,
    checkedAt: Date.now(),
    items
  }
}

/* ────────────────────────────── 注册 ────────────────────────────── */

export function registerAuditModule(ctx: ModuleContext): void {
  ctx.handle(CH.audit.list, (_event, limit) =>
    listAudit(ctx.stores, typeof limit === 'number' ? limit : 200)
  )
  ctx.handle(CH.audit.verify, () => verifyAudit(ctx.stores))
  ctx.handle(CH.selfcheck.run, (_event, profileId) => runSelfCheck(ctx, String(profileId)))
}
