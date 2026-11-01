/**
 * 三条旁路的封堵验证 + 同意结果落审计的读数（同意语义）。
 *
 * 要证的不是「代码里写了 requestConsent」，而是**调用方自称同意时到底发生了什么**。
 * 所以这个探针把三条路径都真的跑一遍，用可编程的假系统窗口当同意来源：
 *
 *   ① ss:agent:confirm(true)                    —— 渲染层直接宣称用户已批准
 *   ② ss:scripts:run(id, pid, {confirmed:true}) —— 渲染层宣称整段回放已批准
 *   ③ POST /profiles/:id/act {"confirm":true}   —— 外部脚本在请求体里宣称已批准
 *
 * 三条的共同前提都是「同意可以由发起方自己声明」。修好之后：
 *   - ① 通道已经不存在（名字叫 confirm、行为是取消的东西留着更危险）；
 *   - ② `confirmed` 字段已经不存在，传了也会照样弹窗口；
 *   - ③ `confirm` 字段已经不存在，L2 一律弹窗口，没人点就 409。
 *
 * 假窗口由 tools/stub-electron.mjs 提供（vite 别名把 electron 指过去），
 * 所以**生产代码里没有任何测试后门**：没有 `if (test) return true` 这种分支。
 *
 * 用法：node tools/probe-consent.mjs
 */

import { createServer } from 'vite'
import { resolve, join } from 'node:path'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dirname, '..')

/* ────────────────────────────── 假世界 ────────────────────────────── */

const snapshot = {
  url: 'https://example.com/',
  title: 'probe',
  viewport: { width: 1280, height: 800 },
  scroll: { y: 0, maxY: 0 },
  text: '',
  elements: [
    {
      id: 'e1',
      tag: 'a',
      role: 'link',
      name: '下一页',
      disabled: false,
      inViewport: true,
      box: { x: 0, y: 0, w: 10, h: 10 }
    },
    {
      id: 'e2',
      tag: 'button',
      role: 'button',
      name: '立即支付',
      disabled: false,
      inViewport: true,
      box: { x: 0, y: 0, w: 10, h: 10 }
    }
  ],
  capturedAt: Date.now(),
  truncated: false
}

/** 任何属性都返回一个「空但形状齐全」的 store：探针不关心持久化 */
function fakeStore() {
  return new Proxy(
    {},
    {
      get: (_t, key) => {
        if (key === 'then') return undefined
        return {
          list: () => [],
          get: () => null,
          add: (x) => x,
          update: () => null,
          remove: () => undefined,
          clear: () => undefined,
          count: () => 0,
          set: () => ({}),
          newId: (p) => `${String(p)}_stub`
        }
      }
    }
  )
}

/** 审计用真的数组：`appendAudit` 会读 list() 算 seq/prev，探针要能读到写进去的行 */
const auditRows = []

const stores = {
  profiles: {
    list: () => [],
    get: (id) => (id === 'p1' ? { id: 'p1', name: '探针环境', fingerprint: {} } : null),
    count: () => 1,
    create: (x) => x,
    update: () => null,
    remove: () => undefined,
    clone: (x) => x,
    regenerate: (x) => x
  },
  /**
   * settings 用代理：审计链会往这里写锚点（`setAuditHead`），
   * 而这块正在被另一个 worker 改，方法名还会长。代理让探针只依赖
   * 「能被调用」这一件事，不必跟着每次 API 扩张改一行。
   */
  settings: new Proxy(
    {},
    {
      get: (_t, key) => {
        if (key === 'then') return undefined
        if (key === 'get') return () => ({ auditHead: null })
        if (key === 'set') return () => ({ auditHead: null })
        return () => undefined
      }
    }
  ),
  scripts: {
    list: () => [],
    get: (id) => (id === 'scr_pay' ? script : null),
    add: (x) => x,
    update: () => null,
    remove: () => undefined
  },
  audit: {
    list: () => auditRows.slice(),
    add: (e) => {
      auditRows.push(e)
      return e
    },
    get: () => null,
    remove: () => undefined,
    count: () => auditRows.length
  },
  tasks: fakeStore(),
  proxies: fakeStore(),
  templates: fakeStore(),
  history: fakeStore(),
  downloads: fakeStore()
}

const script = {
  id: 'scr_pay',
  name: '探针脚本',
  steps: [
    // 选择器里带不可逆语义；元素名也是「立即支付」，两层都指向 L2
    { action: 'click', selector: 'name=立即支付', delayMs: 0, note: '支付' }
  ],
  createdAt: Date.now(),
  updatedAt: Date.now()
}

const stubCdp = {
  attach: async () => undefined,
  attached: true,
  send: async () => ({ ok: true }),
  on: () => undefined,
  once: () => undefined,
  off: () => undefined
}

globalThis.__SS_STUB_DATA_DIR__ = mkdtempSync(join(tmpdir(), 'ss-probe-consent-'))
globalThis.__SS_STUB_STORES__ = stores
globalThis.__SS_STUB_CDP__ = stubCdp
globalThis.__SS_STUB_SNAPSHOT__ = snapshot
/** 真的走到页面层的动作会记在这里；被闸门拦下的不会 */
globalThis.__SS_STUB_ACTIONS__ = []
globalThis.__SS_STUB_DIALOG_LOG__ = []
globalThis.__SS_IPC__ = new Map()
/**
 * 伪装状态：默认「页面侧全部装上了」。
 *
 * 它是 L2 的另一个前提（`judgeMask`），与同意是两个独立条件：
 * 同意回答「人批准了吗」，伪装回答「此刻的页面还是那个被伪装过的页面吗」。
 * 探针只把后者当常量，除非某一段显式改它。
 */
globalThis.__SS_STUB_MASK__ = {
  webContentsId: 1,
  profileId: 'p1',
  state: 'ok',
  failed: [],
  at: Date.now()
}

/* ────────────────────────────── 启动 ────────────────────────────── */

const wm = { getTab: () => ({ wc: {} }), listWindows: () => [], getWindow: () => null }
const runtime = { launch: async () => undefined, stop: async () => undefined, isRunning: () => true }

/**
 * 起一个独立的模块图。
 *
 * 为什么要能起第二个：`SS_CONSENT_TTL_MS` 在 consent.ts 加载时就被固化，
 * 而「超时」这条路径只有在 TTL 短到毫秒级时才测得出来。每个 vite 实例
 * 有自己的一套模块，所以换 TTL 只能换实例。
 */
async function boot(ttlMs) {
  if (ttlMs === undefined) delete process.env.SS_CONSENT_TTL_MS
  else process.env.SS_CONSENT_TTL_MS = String(ttlMs)

  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, watch: null, ws: false },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: {
      alias: [
        // 具体路径必须排在 @main 前面，否则会被前缀规则先吃掉。
        //
        // secret-at-rest 指回**真文件**：它只 import node:fs，纯 Node 里跑得动。
        // 能跑真的就别替 —— 替身只用来切断 electron / 磁盘那两条链，
        // 不用来简化被测逻辑。
        { find: '@main/store/secret-at-rest', replacement: resolve(root, 'src/main/store/secret-at-rest.ts') },
        { find: '@main/store/seed-seal', replacement: resolve(root, 'tools/probe-stubs/main-deps.mjs') },
        { find: '@main/store', replacement: resolve(root, 'tools/probe-stubs/main-deps.mjs') },
        { find: '@main/core/cdp', replacement: resolve(root, 'tools/probe-stubs/main-deps.mjs') },
        { find: '@main/agent/snapshot', replacement: resolve(root, 'tools/probe-stubs/main-deps.mjs') },
        { find: '@shared', replacement: resolve(root, 'src/shared') },
        { find: '@main', replacement: resolve(root, 'src/main') },
        { find: '@renderer', replacement: resolve(root, 'src/renderer') },
        { find: 'electron', replacement: resolve(root, 'tools/stub-electron.mjs') }
      ]
    }
  })

  const handlers = await server.ssrLoadModule('/src/main/ipc/handlers.ts')
  // registerHandlers 同时做两件事：把所有通道接到假 ipcMain、把同意结果接到审计链
  handlers.registerHandlers({ wm, runtime })

  // 伪装状态查询也是注入的（执行器在纯 Node 里加载，不能 import windows.ts）。
  // 组合根在 index.ts 里注入，探针得自己补上 —— 不补的话 maskLookup 恒为 null，
  // 而 judgeMask(null) 是「拒绝」，所有 L2 都会停在伪装那一步，测不到同意。
  const actions = await server.ssrLoadModule('/src/main/agent/actions.ts')
  actions.setMaskStateLookup(() => globalThis.__SS_STUB_MASK__)

  delete process.env.SS_CONSENT_TTL_MS

  return { server }
}

/** 调 handlers.ts 里的通道：外面包了一层 {ok,data} */
async function callIpc(channel, ...args) {
  const fn = globalThis.__SS_IPC__.get(channel)
  if (!fn) throw new Error(`ipcMain 上没有这个通道：${channel}`)
  const res = await fn({ sender: { id: 1, isDestroyed: () => false, send: () => undefined } }, ...args)
  if (res && res.ok === false) throw new Error(`通道 ${channel} 返回失败：${res.error?.message}`)
  return res?.data
}

let failed = 0
function check(ok, name, detail) {
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` → ${detail}`}`)
}

const dialogs = () => globalThis.__SS_STUB_DIALOG_LOG__
const touched = () => globalThis.__SS_STUB_ACTIONS__

/** 最后一次同意询问写下的审计行（`requestConsent` 的落点） */
function lastConsentRow() {
  for (let i = auditRows.length - 1; i >= 0; i -= 1) {
    if (auditRows[i].action === '闸门·同意') return auditRows[i]
  }
  return null
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

const main = await boot()

try {
  /* ── ① ss:agent:confirm ── */
  console.log('\n① ss:agent:confirm 通道已删除，渲染层没有批准入口')

  {
    check(
      !globalThis.__SS_IPC__.has('ss:agent:confirm'),
      'ipcMain 上没有注册 ss:agent:confirm',
      [...globalThis.__SS_IPC__.keys()].filter((k) => k.includes('confirm')).join(',') || '（没有任何 confirm 通道）'
    )
    // 旧攻击路径现在连入口都没有：能调的只有 run / cancel / snapshot
    const agentChannels = [...globalThis.__SS_IPC__.keys()].filter((k) => k.startsWith('ss:agent:'))
    check(
      agentChannels.sort().join(',') === 'ss:agent:cancel,ss:agent:run,ss:agent:snapshot',
      'agent 域只剩 run / cancel / snapshot',
      agentChannels.join(',')
    )
    check(touched().length === 0, '没有任何动作被执行', `touched=${touched().length}`)
  }

  /* ── ② scripts.run({confirmed:true}) ── */
  console.log('\n② ss:scripts:run(..., {confirmed:true}) 无法绕过')

  {
    process.env.SS_STUB_DIALOG_RESPONSE = '0' // 用户点「取消」
    const before = dialogs().length
    const res = await callIpc('ss:scripts:run', 'scr_pay', 'p1', { confirmed: true })
    check(dialogs().length - before === 1, '传了 confirmed:true 仍然弹了一次确认窗口', `asked=${dialogs().length - before}`)
    check(
      res.needsConfirm === true && res.executed === 0,
      '用户没允许 → 回放停在第一步，一步都没执行',
      JSON.stringify({ ok: res.ok, needsConfirm: res.needsConfirm, executed: res.executed })
    )
    check(
      (res.error ?? '').includes('取消'),
      '错误文案说明了「本机用户点了取消」',
      res.error
    )

    process.env.SS_STUB_DIALOG_RESPONSE = '1'
    const before2 = dialogs().length
    const ok = await callIpc('ss:scripts:run', 'scr_pay', 'p1', { confirmed: true })
    check(dialogs().length - before2 === 1, '允许路径同样经过系统窗口', `asked=${dialogs().length - before2}`)
    check(ok.ok === true && ok.executed === 1, '用户点允许后那一步真的执行了', JSON.stringify({ ok: ok.ok, executed: ok.executed }))
  }

  /* ── ③ localapi ── */
  console.log('\n③ ss.localApi.state() 里没有 token；/act 的 confirm:true 无效')

  let apiPort = 0
  {
    const state = await callIpc('ss:localApi:state')
    console.log(`   state() 实际返回：${JSON.stringify(state)}`)
    check(!('token' in state), 'state() 返回值里没有 token 字段', Object.keys(state).join(','))
    check(state.running === false, '服务未启动时也一样（这正是原来泄露凭证的时机）', `running=${state.running}`)

    const copied = await callIpc('ss:localApi:copyToken')
    const token = globalThis.__SS_STUB_CLIPBOARD__
    check(
      copied?.copied === true && /^[0-9a-f]{64}$/.test(String(token)),
      'copyToken 把 64 hex 写进剪贴板（明文不经过渲染层）',
      `len=${String(token ?? '').length}`
    )

    apiPort = 17717
    const started = await callIpc('ss:localApi:start', apiPort)
    check(started.running === true && !('token' in started), 'start() 返回值里同样没有 token', Object.keys(started).join(','))

    const call = async (path, body) => {
      const res = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
      })
      return { status: res.status, json: await res.json() }
    }

    // 拒绝
    process.env.SS_STUB_DIALOG_RESPONSE = '0'
    const before = dialogs().length
    const denied = await call('/profiles/p1/act', { action: { type: 'click', id: 'e2' }, confirm: true })
    check(dialogs().length - before === 1, 'L2 动作弹了一次系统窗口（confirm 字段没让它跳过）', `asked=${dialogs().length - before}`)
    check(
      denied.status === 409 && denied.json?.error?.code === 'E_CONSENT_DENIED',
      '人点了取消 → 409 E_CONSENT_DENIED',
      `${denied.status} ${denied.json?.error?.code}`
    )

    // 不可用：窗口根本弹不出来
    process.env.SS_STUB_DIALOG_THROW = '1'
    const unavailable = await call('/profiles/p1/act', { action: { type: 'click', id: 'e2' } })
    delete process.env.SS_STUB_DIALOG_THROW
    check(
      unavailable.status === 503 && unavailable.json?.error?.code === 'E_CONSENT_UNAVAILABLE',
      '窗口弹不出来 → 503 E_CONSENT_UNAVAILABLE',
      `${unavailable.status} ${unavailable.json?.error?.code}`
    )

    // 允许
    process.env.SS_STUB_DIALOG_RESPONSE = '1'
    const allowed = await call('/profiles/p1/act', { action: { type: 'click', id: 'e2' }, confirm: true })
    check(allowed.status === 200 && allowed.json?.ok === true, '有人点允许 → 200 执行成功', `${allowed.status}`)

    // L1 不弹窗
    const beforeL1 = dialogs().length
    const l1 = await call('/profiles/p1/act', { action: { type: 'click', id: 'e1' } })
    check(l1.status === 200 && dialogs().length === beforeL1, 'L1 动作不弹窗、直接执行', `${l1.status} dialogs+${dialogs().length - beforeL1}`)

    await callIpc('ss:localApi:stop')
  }

  /* ── ④ 同意结果落审计（真跑，贴读数） ── */
  console.log('\n④ 同意结果的审计读数（denied / unavailable / granted 各一条）')

  {
    const rows = () => auditRows.filter((r) => r.action === '闸门·同意')

    const deniedRow = rows().find((r) => r.detail.includes('点了「取消」'))
    check(deniedRow !== undefined, '拒签写进了审计链', deniedRow ? `seq=${deniedRow.seq}` : '（没有这条记录）')
    if (deniedRow) console.log(`   [denied]      action=${deniedRow.action}  target=${deniedRow.target}\n                 detail=${deniedRow.detail}`)

    const unavailableRow = rows().find((r) => r.detail.includes('无法弹出'))
    check(unavailableRow !== undefined, '不可用写进了审计链', unavailableRow ? `seq=${unavailableRow.seq}` : '（没有这条记录）')
    if (unavailableRow) console.log(`   [unavailable] action=${unavailableRow.action}  target=${unavailableRow.target}\n                 detail=${unavailableRow.detail}`)

    const grantedRow = rows().find((r) => r.detail.includes('允许执行'))
    check(grantedRow !== undefined, '同意来源写进了审计链', grantedRow ? `seq=${grantedRow.seq}` : '（没有这条记录）')
    if (grantedRow) console.log(`   [granted]     action=${grantedRow.action}  target=${grantedRow.target}\n                 detail=${grantedRow.detail}`)

    // 批准的动作必须有两条：一条同意来源，一条执行点
    const execRow = auditRows.find((r) => r.action === '闸门·不可逆' && r.detail.includes('票据消费成功'))
    check(execRow !== undefined, '执行点另写一条（票据消费成功），不是与同意来源合并', execRow ? `seq=${execRow.seq}` : '（没有这条记录）')
    if (execRow) console.log(`   [执行点]      action=${execRow.action}  target=${execRow.target}\n                 detail=${execRow.detail}`)

    // 被拦下的 L2 不能写「票据消费成功」。
    //
    // 这一段不靠读代码断言：真的调执行器，让它自己重算等级、自己消费票。
    // 用的是同一套模块图里的 consent.ts，所以那张票是真票 —— 第一次能过，
    // 第二次必须被拒（票是一次性能力，重放是它唯一有意义的攻击方式）。
    {
      const { requestConsent } = await main.server.ssrLoadModule('/src/main/agent/consent.ts')
      const { executeAction } = await main.server.ssrLoadModule('/src/main/agent/actions.ts')
      const { auditGate } = await main.server.ssrLoadModule('/src/main/modules/audit.ts')

      process.env.SS_STUB_DIALOG_RESPONSE = '1'
      const outcome = await requestConsent(
        {
          action: { type: 'click', id: 'e2' },
          level: 'L2',
          reason: '这一步会发起支付并产生扣款，确认后才会执行',
          target: '点击「立即支付」',
          origin: 'script'
        },
        1
      )
      const ticket = outcome.kind === 'granted' ? outcome.ticket : ''
      check(outcome.kind === 'granted', '探针从真对话框拿到一张票', outcome.kind)

      const action = { type: 'click', id: 'e2' }
      const approval = { ticket, origin: 'script', senderId: 1, onGate: (ev) => auditGate(stores, ev) }
      const first = await executeAction(stubCdp, action, snapshot, approval)
      check(first.ok === true, '第一次用这张票 → 执行成功', JSON.stringify({ ok: first.ok }))

      let replay = null
      try {
        await executeAction(stubCdp, action, snapshot, approval)
      } catch (err) {
        replay = err
      }
      check(
        replay !== null && replay.name === 'ApprovalRequiredError',
        '同一张票第二次使用 → 被拒（重放）',
        replay?.name ?? '没抛错，说明票可以重复使用'
      )
    }

    const blocked = auditRows.find((r) => r.action === '闸门·不可逆' && r.detail.includes('未获授权'))
    check(blocked !== undefined, '被拦下的 L2 写「本次执行未获授权」', blocked ? `seq=${blocked.seq}` : '（没有这条记录）')
    if (blocked) console.log(`   [被拦下]      detail=${blocked.detail}`)

    // L1 不许写「未授权」
    const l1Rows = auditRows.filter((r) => r.action === '闸门·可回退')
    check(l1Rows.length > 0, 'L1 动作有记录', `count=${l1Rows.length}`)
    check(
      l1Rows.every((r) => !r.detail.includes('未授权')),
      'L1 记录里没有「未授权」这种制造恐慌的说法',
      l1Rows[0]?.detail ?? '（无）'
    )
    if (l1Rows[0]) console.log(`   [L1]          detail=${l1Rows[0].detail}`)

    // 全部记录都必须带淘汰保护前缀，否则 5000 条上限时会被当普通记录丢掉
    const unprotected = auditRows.filter((r) => !r.action.startsWith('闸门·'))
    check(unprotected.length === 0, '所有闸门/同意记录都带 AUDIT_RETAIN 保护前缀', `未保护=${unprotected.length}`)
  }

  /* ── ⑤ 超时（需要短 TTL 的独立模块图） ── */
  console.log('\n⑤ 超时路径：120 秒无人确认 → 拒绝，且审计写得出来')

  {
    // 换一套模块图：TTL 在 consent.ts 加载时就被固化，只有 50ms 才等得到「超时」。
    // 它注册的通道会覆盖同名通道（同一张假 ipcMain），所以这一段只碰 localApi。
    const short = await boot(50)
    const timeoutPort = 17718
    const token = globalThis.__SS_STUB_CLIPBOARD__
    await callIpc('ss:localApi:start', timeoutPort)

    try {
      // 对话框要 400ms 才「被点」，而 TTL 只有 50ms → 一定超时
      process.env.SS_STUB_DIALOG_DELAY_MS = '400'
      const res = await fetch(`http://127.0.0.1:${timeoutPort}/profiles/p1/act`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: { type: 'click', id: 'e2' } })
      })
      const json = await res.json()
      delete process.env.SS_STUB_DIALOG_DELAY_MS

      check(
        res.status === 409 && json?.error?.code === 'E_CONSENT_TIMEOUT',
        '超时 → 409 E_CONSENT_TIMEOUT（不是挂起，也不是放行）',
        `${res.status} ${json?.error?.code}`
      )

      const row = lastConsentRow()
      check(row !== null && row.detail.includes('120 秒内无人确认'), '超时也写进了审计链', row ? `seq=${row.seq}` : '（没有这条记录）')
      if (row) console.log(`   [timeout]     action=${row.action}  target=${row.target}\n                 detail=${row.detail}`)

      await callIpc('ss:localApi:stop')
    } finally {
      await short.server.close()
    }
  }

  /* ── ⑥ 旧契约的字段不许回来 ── */
  console.log('\n⑥ 旧契约的字段不许回来')

  {
    const read = (p) => readFileSync(join(root, p), 'utf8')
    // 注释里会解释「为什么不再有 confirmed」，那不该被当成违规。
    const stripComments = (text) =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const code = (p) => stripComments(read(p))

    const actions = code('src/main/agent/actions.ts')
    const approvalBlock = /export type Approval = \{([\s\S]*?)\n\}/.exec(actions)
    check(approvalBlock !== null, '找到了 Approval 定义')
    check(
      approvalBlock !== null && !/approvedBy/.test(approvalBlock[1]),
      'Approval 里没有 approvedBy（授权不再是声明）'
    )

    check(!/\bconfirmed\b/.test(code('src/main/modules/scripts.ts')), 'scripts.ts 的代码里没有 confirmed')

    const runOpts = /export interface ScriptRunOptions \{([\s\S]*?)\n\}/.exec(code('src/shared/ipc.ts'))
    check(runOpts !== null && !/confirmed/.test(runOpts[1]), 'ScriptRunOptions 里没有 confirmed')

    const apiState = /export interface LocalApiState \{([\s\S]*?)\n\}/.exec(code('src/shared/types.ts'))
    check(apiState !== null && !/\btoken\??:/.test(apiState[1]), 'LocalApiState 里没有 token 字段')

    check(!/payload\.confirm/.test(code('src/main/modules/localapi.ts')), 'localapi.ts 不再读请求体里的 confirm')

    const ipc = code('src/shared/ipc.ts')
    check(!/agent\.confirm|confirm\(approved/.test(ipc), 'IPC 契约里没有 agent.confirm')
    check(!/confirm\(approved/.test(code('src/preload/index.ts')), 'preload 不再暴露 confirm')

    const offenders = []
    for (const file of [
      'src/main/agent/loop.ts',
      'src/main/modules/scripts.ts',
      'src/main/modules/localapi.ts'
    ]) {
      if (/approvedBy:\s*'(user|api|none)'/.test(code(file))) offenders.push(file)
    }
    check(offenders.length === 0, '三个调用点都不再自己声明 approvedBy', offenders.join(',') || 'none')
  }

  /* ── ⑦ 伪装状态与同意的先后（两个独立前提） ── */
  console.log('\n⑦ 伪装状态缺失时 L2 被拦，且用户点的那次「允许」没有被白白烧掉')

  {
    const { requestConsent } = await main.server.ssrLoadModule('/src/main/agent/consent.ts')
    const { executeAction } = await main.server.ssrLoadModule('/src/main/agent/actions.ts')
    const { auditGate } = await main.server.ssrLoadModule('/src/main/modules/audit.ts')

    const action = { type: 'click', id: 'e2' }
    process.env.SS_STUB_DIALOG_RESPONSE = '1'
    const outcome = await requestConsent(
      {
        action,
        level: 'L2',
        reason: '这一步会发起支付并产生扣款，确认后才会执行',
        target: '点击「立即支付」',
        origin: 'script'
      },
      1
    )
    const ticket = outcome.kind === 'granted' ? outcome.ticket : ''
    const approval = { ticket, origin: 'script', senderId: 1, onGate: (ev) => auditGate(stores, ev) }

    // 伪装状态查不到 —— 执行器必须拒绝，理由必须是「伪装」，不能是「未获授权」
    globalThis.__SS_STUB_MASK__ = null
    let blocked = null
    try {
      await executeAction(stubCdp, action, snapshot, approval)
    } catch (err) {
      blocked = err
    }
    check(blocked !== null, '伪装状态缺失 → L2 不执行', blocked?.name ?? '居然执行了')
    check(
      (blocked?.message ?? '').includes('伪装'),
      '拒绝理由说的是伪装，不是「未获授权」',
      (blocked?.message ?? '').slice(0, 40)
    )

    // 恢复伪装状态，同一张票仍然可用：证明「先判伪装、再烧票」——
    // 顺序反过来的话，用户这次点击会被一次与他无关的环境故障白白消耗掉。
    globalThis.__SS_STUB_MASK__ = {
      webContentsId: 1,
      profileId: 'p1',
      state: 'ok',
      failed: [],
      at: Date.now()
    }
    const retried = await executeAction(stubCdp, action, snapshot, approval)
    check(retried.ok === true, '伪装恢复后同一张票仍可用（票没被伪装失败烧掉）', JSON.stringify({ ok: retried.ok }))

    // 再试一次就必须被拒：票仍然是一次性的，恢复不等于复活
    let again = null
    try {
      await executeAction(stubCdp, action, snapshot, approval)
    } catch (err) {
      again = err
    }
    check(again !== null, '但这张票依旧只能用一次', again?.name ?? '第二次也过了')
  }
} finally {
  await main.server.close()
}

if (failed > 0) {
  console.error(`\n${failed} 条旁路验证未通过`)
  process.exit(1)
}
console.log('\n三条旁路已封：同意只能来自主进程弹出的系统原生窗口')
