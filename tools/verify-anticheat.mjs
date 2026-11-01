#!/usr/bin/env node
/**
 * 反检测运行时验证（12 条）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这个脚本存在的理由
 * ─────────────────────────────────────────────────────────────────────
 * `tests/structure.test.ts` 里的断言全是**源码文本匹配**：它能证明「有人写了
 * `Function.prototype.toString` 这几个字」，不能证明「页面读到的确实是 native」。
 * 两者之间隔着一次运行 —— 而我们已经踩过「代码看起来对、运行时全失效」的坑
 * （`_masked` 被 `var` 提升重置为空数组，所有伪装静默失效，源码 grep 全绿）。
 * 所以这里所有断言都读**页面真实返回值**，不读源码。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 断言的是值，不是外观（第 6 条，别改回去）
 * ─────────────────────────────────────────────────────────────────────
 * `navigator.plugins` 只在 `_maskAll` 清单里，**没有 defVal 伪造值**。
 * 也就是说 getter 的 `toString()` 现在返回 native 串（外观对了），
 * 但 `navigator.plugins.length` 仍是 Electron 的真实值（值没改）。
 * 任何只看 toString 的检查都会把这里判成「已修」—— 这是本仓库出现过两次的
 * 假阳性类型，所以第 6 条必须断 `length > 0` 且含 PDF 条目。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 门禁 vs 探针
 * ─────────────────────────────────────────────────────────────────────
 * gate=true   失败 → 退出码 1，接进 PR 门禁（AC-01~10、AC-13~21）
 * gate=false  只记录读数，永远不判红（AC-11 Electron 探测面、AC-12 跨环境）
 * 基线没拿到就断死，只会让门禁一上来就红，然后就没人看了 —— 所以先采数。
 *
 * ─────────────────────────────────────────────────────────────────────
 * AC-14 / AC-21 是「别的 world」的两条，别再把它们降回 probe
 * ─────────────────────────────────────────────────────────────────────
 * 其余检查全在主世界跑，所以它们全绿也证明不了两件事：
 *   AC-14  Worker 里读到什么 —— Worker 是独立目标，主世界的注入到不了；
 *   AC-21  跨站 iframe 里读到什么 —— OOPIF 同样是独立目标。
 * 这两条早先是 probe（pass=null），即「永远不判红」：读到多离谱的矛盾都是绿的，
 * 缺口只活在报告里。现在都是 gate，且判据是**多字段全等**（20 项 / 8 项）——
 * 只比 ua/platform/cores/languages/tz 那几项的话，改三行就能变绿而缺口依旧，
 * 因为 ua/platform 一致只是 `ses.setUserAgent` 的会话级副作用，不是注入生效的证据。
 *
 * ─────────────────────────────────────────────────────────────────────
 * AC-13 是给 AC-01/AC-02 兜底的，别删
 * ─────────────────────────────────────────────────────────────────────
 * 原生函数本来就返回 `[native code]`、本来就没有 `prototype`。
 * 所以「全部 native / 全部无 prototype」这个读数，在**注入完全没跑**的情况下
 * 同样成立 —— 是一句空断言。AC-13 用行为证据（时区平移、canvas/音频/clientRects
 * 噪声）证明函数确实被替换过，那两条才有意义。
 *
 * 跑法：
 *   npm run verify:anticheat              # 门禁模式，单环境
 *   npm run verify:anticheat -- --nightly # 加跑跨环境一致性（两次启动）
 *
 * 退出码（与 tools/check-build-fresh.mjs 对齐，只有三档含义）：
 *   0 = 通过
 *   1 = 断言失败（测到了，确实不达标）
 *   2 = 脚本自身崩了（探针/环境问题，不是被测对象的问题）
 *   3 = 未测量（拿不到窗口 / 读数无效 / 零条门禁）—— 不是通过，也不是失败
 *
 * 环境变量（都是为了「让不可复现的分支可以复现」）：
 *   SS_KEEP_USERDATA=1        跑完保留临时 userData，便于看现场
 *   SS_USERDATA_DIR=<path>    指定 userData（用来复现撞锁/启动失败那两条路径）
 *   SS_FORCE_LOCALE_ROUND=1   强制走「另建非 en-US profile」分支（在中文/en-GD 宿主上默认不走）
 *
 * 输出：
 *   终端一张表 + artifacts/anticheat-<sha>.json
 *
 * 已知坑（写这个脚本时踩过）：
 *   1. 主窗口开着时合成器不出帧，Playwright screenshot 会一直等到超时 ——
 *      所以本脚本不截图，只取 `executeJavaScript` 的返回值。
 *   2. `tools/*.mjs` 里不要写 `/tmp/x.json`，Windows 下会被解析成 `G:\tmp`。
 *      一律 `path.resolve`。
 */

import { _electron as electron } from 'playwright-core'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { tmpdir, cpus } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACTS = resolve(ROOT, 'artifacts')
const NIGHTLY = process.argv.includes('--nightly')

const sha = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim()
  } catch {
    return 'nogit'
  }
})()

/**
 * 构建态指纹。没有这三个字段，产物里「改完没提交」和「提交后没构建」长得一模一样。
 *
 * 这个坑已经真实发生过一次：本脚本启动的是 `out/`（构建产物），而 `sha` 取的是
 * `git rev-parse HEAD`（源码）。两者不一致时，AC 的结论会指向错误的代码版本 ——
 * 有人因此得出了「AC-16 是假阳性」的结论，白绕一圈。
 *
 * 判读规则：
 *   dirty=true  → 工作区有未提交改动，本次读数**不代表 HEAD**
 *   outSha1     → 与上次不同即产物变了；与 dirty 一起看才能确定测的是哪份代码
 */
const buildState = (() => {
  const out = { dirty: null, outSha1: null, outMtime: null }
  try {
    const st = execSync('git status --porcelain', { cwd: ROOT }).toString()
    out.dirty = st.trim().length > 0
  } catch {}
  try {
    const buf = readFileSync(resolve(ROOT, 'out/main/index.js'))
    out.outSha1 = createHash('sha1').update(buf).digest('hex').slice(0, 12)
    out.outMtime = statSync(resolve(ROOT, 'out/main/index.js')).mtime.toISOString()
  } catch {}
  return out
})()

/* ────────────────────────────── 页面探针 ────────────────────────────── */

/**
 * 在主世界（页面自己的 world）里跑，返回**原始读数**。
 * 这里不做任何判定 —— 判定全在 Node 侧，这样读数能原样进 JSON 基线，
 * 换断言条件不需要重跑。
 */
async function pageProbe() {
  /** 沿原型链找描述符：detector 也是这么找的，own 与 inherited 都要覆盖 */
  const findDesc = (obj, prop) => {
    let o = obj
    while (o) {
      const d = Object.getOwnPropertyDescriptor(o, prop)
      if (d) return d
      o = Object.getPrototypeOf(o)
    }
    return null
  }
  const fnOf = (obj, prop) => {
    const d = findDesc(obj, prop)
    if (!d) return null
    if (typeof d.get === 'function') return d.get
    if (typeof d.value === 'function') return d.value
    return null
  }
  const srcOf = (fn) => {
    try {
      return Function.prototype.toString.call(fn)
    } catch (e) {
      return 'THROW:' + e.message
    }
  }
  const isNative = (fn) => {
    const s = srcOf(fn)
    return /\[native code\]\s*\}\s*$/.test(s)
  }
  const hasProto = (fn) => {
    try {
      return 'prototype' in fn
    } catch (e) {
      return 'THROW'
    }
  }

  /* 1 / 2：被 patch 过的每一个入口 —— toString 外观 + prototype 枚举洞 */
  const targets = [
    ['navigator.userAgent', Navigator.prototype, 'userAgent'],
    ['navigator.platform', Navigator.prototype, 'platform'],
    ['navigator.languages', Navigator.prototype, 'languages'],
    ['navigator.plugins', Navigator.prototype, 'plugins'],
    ['screen.width', Screen.prototype, 'width'],
    ['window.devicePixelRatio', window, 'devicePixelRatio'],
    ['Date.getHours', Date.prototype, 'getHours'],
    ['Date.toString', Date.prototype, 'toString'],
    ['Element.getBoundingClientRect', Element.prototype, 'getBoundingClientRect'],
    ['Canvas2D.measureText', CanvasRenderingContext2D.prototype, 'measureText'],
    ['HTMLCanvasElement.toDataURL', HTMLCanvasElement.prototype, 'toDataURL'],
    ['AudioBuffer.getChannelData', AudioBuffer.prototype, 'getChannelData'],
    ['WebGL.getParameter', WebGLRenderingContext.prototype, 'getParameter'],
    ['Geolocation.getCurrentPosition', Geolocation.prototype, 'getCurrentPosition'],
    ['AnalyserNode.getFloatFrequencyData', AnalyserNode.prototype, 'getFloatFrequencyData'],
    ['Function.prototype.toString', Function.prototype, 'toString']
  ]
  const mask = targets.map(([name, obj, prop]) => {
    const fn = fnOf(obj, prop)
    if (!fn) return { name, missing: true }
    return { name, fnName: fn.name, src: srcOf(fn), native: isNative(fn), hasProto: hasProto(fn) }
  })

  /* 3：全局标记 —— 一个都不该有 */
  const markers = [
    '__SS_FP__',
    '__SS__',
    '__ss',
    '_masked',
    '_fakeSrc',
    '_maskOne',
    '_maskAt',
    '_maskAll',
    '_patched',
    '_fts',
    '_noProto'
  ].filter((k) => k in window)

  /* 4：UA 与 UA-CH */
  const ua = navigator.userAgent
  const uaData = navigator.userAgentData
    ? {
        brands: (navigator.userAgentData.brands || []).map((b) => b.brand + ' ' + b.version),
        mobile: navigator.userAgentData.mobile,
        platform: navigator.userAgentData.platform
      }
    : null

  /* 5：navigator 值 */
  const nav = {
    userAgent: ua,
    platform: navigator.platform,
    vendor: navigator.vendor,
    languages: navigator.languages ? Array.prototype.slice.call(navigator.languages) : null,
    language: navigator.language,
    cores: navigator.hardwareConcurrency,
    memory: typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null,
    maxTouchPoints: navigator.maxTouchPoints,
    webdriver: navigator.webdriver,
    pdfViewerEnabled: navigator.pdfViewerEnabled
  }

  /* 6：plugins 的**值**（不是 getter 外观） */
  const plugins = []
  try {
    for (let i = 0; i < navigator.plugins.length; i++) plugins.push(navigator.plugins[i].name)
  } catch (e) {
    plugins.push('THROW:' + e.message)
  }
  const mimeTypes = (() => {
    try {
      const out = []
      for (let i = 0; i < navigator.mimeTypes.length; i++) out.push(navigator.mimeTypes[i].type)
      return out
    } catch (e) {
      return ['THROW:' + e.message]
    }
  })()

  /* 7：screen / DPR 与 CSS 媒体查询 */
  const screenProbe = {
    width: screen.width,
    height: screen.height,
    availWidth: screen.availWidth,
    availHeight: screen.availHeight,
    colorDepth: screen.colorDepth,
    dpr: window.devicePixelRatio,
    mqDeviceWidth: matchMedia('(device-width: ' + screen.width + 'px)').matches,
    mqDeviceHeight: matchMedia('(device-height: ' + screen.height + 'px)').matches,
    mqResolution: matchMedia('(resolution: ' + window.devicePixelRatio + 'dppx)').matches,
    // 二分出媒体查询实际认为的设备宽度：JS 报 2560、媒体查询报 1707 这种矛盾
    // 光靠 matches 布尔值是发现不了的（两个都「匹配」各自的数）
    mqRealWidth: (() => {
      let lo = 200
      let hi = 5000
      for (let i = 0; i < 12; i++) {
        const mid = Math.round((lo + hi) / 2)
        if (matchMedia('(min-device-width: ' + mid + 'px)').matches) lo = mid
        else hi = mid
      }
      return lo
    })()
  }

  /* 8：构造器身份自洽 */
  const identity = {
    dtfInstanceCtor: new Intl.DateTimeFormat().constructor === Intl.DateTimeFormat,
    dtfProtoCtor: Intl.DateTimeFormat.prototype.constructor === Intl.DateTimeFormat,
    nfInstanceCtor: new Intl.NumberFormat().constructor === Intl.NumberFormat,
    nfProtoCtor: Intl.NumberFormat.prototype.constructor === Intl.NumberFormat,
    collatorProtoCtor: Intl.Collator.prototype.constructor === Intl.Collator,
    dtfName: Intl.DateTimeFormat.name,
    dtfLength: Intl.DateTimeFormat.length,
    tz: (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone
      } catch (e) {
        return 'THROW'
      }
    })(),
    locale: (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().locale
      } catch (e) {
        return 'THROW'
      }
    })()
  }
  try {
    identity.rtcInstanceCtor = new RTCPeerConnection().constructor === RTCPeerConnection
    identity.rtcProtoCtor = RTCPeerConnection.prototype.constructor === RTCPeerConnection
    identity.rtcName = RTCPeerConnection.name
  } catch (e) {
    identity.rtcInstanceCtor = 'THROW:' + e.message
  }

  /* 9：WebGL
   *
   * 【为什么要多采 vendorRaw / rendererRaw / hasDebugRendererInfo】
   * `UNMASKED_*` 依赖 `WEBGL_debug_renderer_info` 这个扩展。扩展缺失时
   * `c.getParameter(e.UNMASKED_VENDOR_WEBGL)` 会因为 `e === null` 抛
   * `Illegal invocation` / TypeError —— 而这个异常在报告里长得和「注入被回滚」一模一样。
   * 实测就踩过：Worker 侧 GL 段抛 `WebGL.getParameter: Illegal invocation`，
   * 整块注入因此回滚，Date 段跟着一起红，看起来像「时区实现有 bug」。
   * 把「扩展在不在」「未走扩展的原始串」单独记下来，才能把
   * **探针环境问题** 和 **注入缺失** 分开。原始串本身不设期望值（见 AC-14 说明）。
   */
  const webgl = (() => {
    try {
      const c = document.createElement('canvas').getContext('webgl')
      const e = c.getExtension('WEBGL_debug_renderer_info')
      const out = {
        vendor: null,
        renderer: null,
        // 不经过 debug 扩展的两条读数：扩展被伪造/被摘掉时仍然读得到
        vendorRaw: null,
        rendererRaw: null,
        hasDebugRendererInfo: !!e
      }
      try {
        out.vendorRaw = c.getParameter(c.VENDOR)
        out.rendererRaw = c.getParameter(c.RENDERER)
      } catch (e2) {
        out.vendorRaw = 'ERR:' + ((e2 && e2.message) || e2)
      }
      if (e) {
        out.vendor = c.getParameter(e.UNMASKED_VENDOR_WEBGL)
        out.renderer = c.getParameter(e.UNMASKED_RENDERER_WEBGL)
      } else {
        // 明确记成「扩展缺失」，不要用 UNMASKED 的异常去顶替 —— 那是两回事
        out.vendor = 'NOEXT'
        out.renderer = 'NOEXT'
      }
      return out
    } catch (e) {
      return { vendor: 'ERR:' + e.message, renderer: 'ERR:' + e.message, vendorRaw: null, rendererRaw: null, hasDebugRendererInfo: null }
    }
  })()

  /* 10：WebRTC 候选泄漏 */
  const rtcCandidates = await new Promise((done) => {
    const found = []
    let settled = false
    const fin = () => {
      if (settled) return
      settled = true
      try {
        pc.close()
      } catch (e) {}
      done(found)
    }
    let pc
    try {
      pc = new RTCPeerConnection({ iceServers: [] })
      pc.onicecandidate = (e) => {
        if (!e.candidate) return fin()
        const m = /([0-9]{1,3}(\.[0-9]{1,3}){3}|[a-f0-9]{1,4}(:[a-f0-9]{0,4}){2,}|[^\s]+\.local)/i.exec(
          e.candidate.candidate
        )
        if (m) found.push(m[1])
      }
      pc.createDataChannel('x')
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .catch(() => {})
      setTimeout(fin, 1500)
    } catch (e) {
      done(['THROW:' + e.message])
    }
  })

  /* 11：Electron 特有探测面（探针，先采基线） */
  // 关键：必须把「符号不存在」和「符号存在但拒绝」分开记。
  // 两者在检测方眼里完全不是一回事：前者是可伪造的缺口，后者与真 headless Chrome 不可区分。
  const widevine = await (async () => {
    try {
      if (typeof navigator.requestMediaKeySystemAccess !== 'function') return 'no-api'
      await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [
        { initDataTypes: ['cenc'], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }] }
      ])
      return 'available'
    } catch (e) {
      return 'rejected:' + (e && e.name ? e.name : 'err')
    }
  })()

  const electronSurface = {
    chrome: typeof window.chrome,
    // Object.keys 对 window.chrome 不可靠（属性不可枚举），必须用 `in`
    chromeIn: window.chrome ? ['loadTimes', 'csi', 'app', 'runtime'].filter((k) => k in window.chrome) : [],
    // 真实 Chrome 156 实测：getOwnPropertyNames(window.chrome) === ['app','csi','loadTimes']（3 个，顺序不定）
    // Electron 45.2.1 原生：0 个。这是「差额可枚举」的那一类缺口，能直接做门禁。
    chromeOwn: window.chrome ? Object.getOwnPropertyNames(window.chrome).sort() : null,
    chromeLoadTimes: window.chrome ? typeof window.chrome.loadTimes : 'no-chrome',
    chromeCsi: window.chrome ? typeof window.chrome.csi : 'no-chrome',
    chromeRuntime: window.chrome ? typeof window.chrome.runtime : 'no-chrome',
    // EME 两个符号：真实 Chrome 156 有、Electron 原生没有。
    // 但「播不了 Widevine」本身不是 tell —— 真 headless Chrome 也抛 NotSupportedError。
    emeRequest: typeof navigator.requestMediaKeySystemAccess,
    emeMediaKeys: typeof window.MediaKeys,
    process: typeof window.process,
    require: typeof window.require,
    module: typeof window.module,
    uaHasElectron: /Electron/i.test(navigator.userAgent),
    widevine
  }

  /* 13：替换生效性证据。
     这是给 AC-01 / AC-02 兜底的 —— 原生函数本来就返回 native、本来就没有 prototype，
     所以「全部 native」这个读数在**注入完全没跑**的情况下同样成立，是一句空断言。
     只有证明函数确实被换掉了，那两条才有意义。这里挑「没有配置值可对照」的目标做。 */
  const behavior = {}

  // Date：宿主在 UTC+8、环境配洛杉矶时，getHours 必须被平移。
  // 取一个固定 UTC 时刻，同时记下页面自报的 offset，两者必须自洽。
  const instant = new Date(Date.UTC(2026, 0, 15, 20, 0, 0))
  behavior.date = {
    hour: instant.getHours(),
    offset: instant.getTimezoneOffset(),
    string: instant.toString(),
    timeString: instant.toTimeString()
  }

  /* 注意：不要用「连读两次看结果是否不同」来判断噪声有没有生效 ——
     那是错的。噪声必须是**同文档内确定性的**（h32 按坐标/值做哈希），
     否则站点连读 100 次取平均就能把噪声抵消掉，伪装等于没做。
     正确做法是拿「未打补丁时的已知结果」做对照：纯白填充读像素、渲染静音读样本、
     整数尺寸量矩形。 */

  // clientRects：整数尺寸元素。未打补丁时四个分量都是整数；补丁加 ±0.01 抖动
  behavior.rect = (() => {
    try {
      const el = document.createElement('div')
      el.style.cssText = 'position:absolute;top:0;left:0;width:100px;height:50px'
      document.body.appendChild(el)
      const r = el.getBoundingClientRect()
      el.remove()
      const frac = (v) => Math.abs(v - Math.round(v))
      const jitter = Math.max(frac(r.width), frac(r.height), frac(r.left), frac(r.top))
      return { width: r.width, height: r.height, left: r.left, top: r.top, jitter }
    } catch (e) {
      return { error: e.message }
    }
  })()

  // canvas：纯白填充后读像素。未打补丁时全是 255；补丁把最低位换成噪声位 → 出现 254
  behavior.canvas = (() => {
    try {
      const c = document.createElement('canvas')
      c.width = 32
      c.height = 32
      const x = c.getContext('2d')
      x.fillStyle = '#ffffff'
      x.fillRect(0, 0, 32, 32)
      const d = x.getImageData(0, 0, 32, 32).data
      let altered = 0
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] !== 255 || d[i + 1] !== 255 || d[i + 2] !== 255) altered++
      }
      return { altered, total: d.length / 4 }
    } catch (e) {
      return { error: e.message }
    }
  })()

  // 音频：渲染静音后读样本。未打补丁时全 0；补丁每 997 个样本加一次偏移
  behavior.audio = await (async () => {
    try {
      const ctx = new OfflineAudioContext(1, 44100, 44100)
      const buf = await ctx.startRendering()
      const d = buf.getChannelData(0)
      let nonZero = 0
      let max = 0
      for (let i = 0; i < d.length; i++) {
        if (d[i] !== 0) {
          nonZero++
          if (Math.abs(d[i]) > max) max = Math.abs(d[i])
        }
      }
      return { nonZero, max, len: d.length }
    } catch (e) {
      return { error: e.message }
    }
  })()

  // plugins 到底是真 PluginArray 还是伪造的普通对象 —— 决定 AC-06 的通过是真通过还是碰巧
  behavior.pluginArrayTag = (() => {
    try {
      return Object.prototype.toString.call(navigator.plugins)
    } catch (e) {
      return 'THROW'
    }
  })()

  /* 12：Worker 上下文 —— 20 项，每项都要「主世界 vs Worker」成对比较
   *
   * 【为什么从 5 项扩到 20 项】
   * 早先只比 ua/platform/cores/languages/tz。其中 ua/platform 是
   * `ses.setUserAgent` 的**会话级副作用** —— 它本来就会同时作用于 Worker，
   * 跟「注入生效」没有任何关系。于是只要把 cores/languages/tz 三项对齐，
   * 这条检查就会变绿，而实测存在的另外十几条矛盾一条都不会红。
   * 那不是门禁，是给自己发的合格证。
   *
   * 【为什么加 Intl 六个构造器 / Date 五项】
   * 注入是逐构造器包装的，漏一个就只剩那一个构造器露宿主值。单看
   * `Intl.DateTimeFormat` 绿了，不代表 `Intl.ListFormat` 也被接管 —— 这两者的
   * 包装清单在不同版本里本来就不一致。六个构造器分开比，才能定位到「漏了哪个」。
   * Date 同理：`getHours`（注入过）、`toString`（注入过）、`toLocaleString`
   * （内部走 %DateTimeFormat% 内在对象，**不读全局属性**）三者会给出三个不同答案。
   *
   * 【为什么加 OffscreenCanvas + WebGL】
   * Worker 里能开 OffscreenCanvas 并拿到 `WEBGL_debug_renderer_info`，
   * 这是 Worker 侧唯一能读到 GPU 的通道。实测主世界报配置的卡、Worker 报宿主的卡 ——
   * 两条 GPU 串并存，比任何一项 navigator 读数都硬。
   */
  const worker = await new Promise((done) => {
    try {
      const code =
        'self.onmessage=function(){' +
        'var T=function(f){try{return f()}catch(e){return "THROW:"+((e&&e.name)||"err")}};' +
        // 必须 `new C()`：Intl.DateTimeFormat / NumberFormat / Collator 允许不带 new 调用
        // （legacy 行为），但 PluralRules / RelativeTimeFormat / ListFormat **不允许** ——
        // 不带 new 会抛 TypeError。第一版漏了 new，于是这三项被记成「Worker 报 THROW」，
        // 看着像注入矛盾、其实是我自己的探针写错。探针的 bug 会伪装成被测对象的 bug，
        // 所以这里统一走 L()，不给逐条手写留机会。
        'var L=function(C){return T(function(){return new C().resolvedOptions().locale})};' +
        'var o={};' +
        'o.ua=navigator.userAgent;' +
        'o.platform=navigator.platform;' +
        'o.cores=T(function(){return navigator.hardwareConcurrency});' +
        'o.memory=typeof navigator.deviceMemory==="number"?navigator.deviceMemory:null;' +
        'o.languages=navigator.languages?Array.prototype.slice.call(navigator.languages):null;' +
        'o.language=T(function(){return navigator.language});' +
        // Intl 六个构造器分开采：包装清单漏一个，只会露这一个
        'o.intlDTF=L(Intl.DateTimeFormat);' +
        'o.intlNF=L(Intl.NumberFormat);' +
        'o.intlCollator=L(Intl.Collator);' +
        'o.intlPluralRules=L(Intl.PluralRules);' +
        'o.intlRTF=L(Intl.RelativeTimeFormat);' +
        'o.intlListFormat=L(Intl.ListFormat);' +
        'o.tz=T(function(){return Intl.DateTimeFormat().resolvedOptions().timeZone});' +
        'o.tzNameLong=T(function(){var p=new Intl.DateTimeFormat("en-US",{timeZoneName:"long"}).formatToParts(new Date(0));' +
        'for(var i=0;i<p.length;i++){if(p[i].type==="timeZoneName")return p[i].value}return null});' +
        // ── Date 采样点：**三个**，不是只有 epoch ──────────────────────────
        // `new Date(0)` 是个被污染的样本：Europe/London 在 1968–1971 全年 BST，
        // Australia/Sydney 在 1971 之前叫 AEST 且偏移不同 —— 拿 epoch 单点比，
        // 会得到「配置时区与实际偏移对不上」的假红，或者反过来掩盖真问题。
        // 所以取三个点：epoch + 冬 + 夏。三个点里能同时覆盖 DST 两侧的时区
        // （America/*、Europe/*）才有「半成功护栏」—— 见判定侧说明。
        'var INST=[Date.UTC(1970,0,1,0,0,0),Date.UTC(2024,0,15,12,0,0),Date.UTC(2024,6,15,12,0,0)];' +
        'var MAP=function(f){return INST.map(function(t){return T(function(){return f(t)})})};' +
        // 五项独立读数，各自走不同的实现路径：
        //   getTimezoneOffset / getHours —— 注入过的 getter
        //   toString                     —— 注入过的 Date.prototype.toString
        //   toLocaleString / toLocaleTimeString —— 内部走 %DateTimeFormat% 内在对象
        'o.dateOffsets=MAP(function(t){return new Date(t).getTimezoneOffset()});' +
        'o.dateHours=MAP(function(t){return new Date(t).getHours()});' +
        'o.dateString=MAP(function(t){return new Date(t).toString()});' +
        'o.dateToLocaleString=MAP(function(t){return new Date(t).toLocaleString()});' +
        'o.dateTZShort=MAP(function(t){return new Date(t).toLocaleTimeString("en-US",{timeZoneName:"short"})});' +
        // toLocaleDateString 单独一条：它的**输出语言**可以直接和 profile 的
        // languages[0] 对照，是「locale 注入到底有没有生效」唯一不看宿主巧合的证据。
        'o.dateLocaleDate=MAP(function(t){return new Date(t).toLocaleDateString()});' +
        // GPU：Worker 里唯一的通道。
        // 扩展缺失时**不要**让 getParameter 抛 —— 抛出去的异常会被上层当成
        // 「注入被回滚」，把一条环境问题伪装成一条注入问题。显式回 'NOEXT'。
        'o.glHasExt=T(function(){var c=new OffscreenCanvas(1,1).getContext("webgl");' +
        'return !!c.getExtension("WEBGL_debug_renderer_info")});' +
        'o.glVendor=T(function(){var c=new OffscreenCanvas(1,1).getContext("webgl");' +
        'var e=c.getExtension("WEBGL_debug_renderer_info");if(!e)return "NOEXT";' +
        'return c.getParameter(e.UNMASKED_VENDOR_WEBGL)});' +
        'o.glRenderer=T(function(){var c=new OffscreenCanvas(1,1).getContext("webgl");' +
        'var e=c.getExtension("WEBGL_debug_renderer_info");if(!e)return "NOEXT";' +
        'return c.getParameter(e.UNMASKED_RENDERER_WEBGL)});' +
        // UA-CH：主世界由 Network.setUserAgentOverride 改，Worker 未必吃得到
        'o.uaData=T(function(){if(!navigator.userAgentData)return null;' +
        'return {brands:(navigator.userAgentData.brands||[]).map(function(b){return b.brand+" "+b.version}),' +
        'platform:navigator.userAgentData.platform}});' +
        'postMessage(o)}'
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
      const w = new Worker(url)
      const timer = setTimeout(() => {
        try {
          w.terminate()
        } catch (e) {}
        done({ timeout: true })
      }, 2500)
      w.onmessage = (e) => {
        clearTimeout(timer)
        try {
          w.terminate()
        } catch (err) {}
        done(e.data)
      }
      w.onerror = (e) => {
        clearTimeout(timer)
        done({ error: String((e && e.message) || e) })
      }
      w.postMessage('go')
    } catch (e) {
      done({ error: e.message })
    }
  })

  /* 附：全局 patch toString 的代价 —— 原生抛错时栈里没有自己的具名帧 */
  const toStringStack = (() => {
    try {
      Function.prototype.toString.call(1)
      return 'no-throw'
    } catch (e) {
      return /at .*toString/.test(String(e.stack)) ? 'has-own-frame' : 'clean'
    }
  })()

  /* 16：Intl 构造器一致性 —— 包装清单不全时会露出「有的用伪 locale、有的用宿主 locale」 */
  const intlConsistency = (() => {
    let base
    try {
      const d = new Intl.DateTimeFormat().resolvedOptions()
      base = { locale: d.locale, timeZone: d.timeZone }
    } catch (e) {
      return { error: e.message }
    }
    const entries = []
    // Intl 上的构造器是数据属性还是访问器属性 —— 决定了 `Intl[nm] = W` 这种
    // 直接赋值能不能生效。访问器属性没有 setter 时赋值**静默失败**（非严格模式），
    // 结果就是「枚举到了、也进 _IN 了，但根本没换掉」。
    const descOf = (k) => {
      try {
        const dd = Object.getOwnPropertyDescriptor(Intl, k)
        if (!dd) return 'none'
        if (dd.get || dd.set) return 'accessor'
        return dd.writable ? 'data-writable' : 'data-readonly'
      } catch (e) {
        return 'err'
      }
    }
    for (const k of Object.getOwnPropertyNames(Intl)) {
      if (typeof Intl[k] !== 'function') continue
      // Locale 不是 formatter，没有 resolvedOptions
      if (k === 'Locale') continue
      // 这三个读数决定「判据选得对不对」，不能省：
      //   hasSLO   —— 源码里 _IN 的筛选条件就是它；缺它的构造器根本不会被接管
      //   hasRO    —— 我主张的判据（resolvedOptions 存在即格式化器）
      //   noNewOk  —— **是否真被换过**。唯一不可自欺的判据：
      //               注入的包装器是 `function W(locales, options) { return new Orig(...) }`，
      //               所以**不带 new 调用会成功**；原生 Intl 构造器不带 new 一律 TypeError。
      //   注意：不能用 `Intl[k].prototype.constructor === Intl[k]` 判断 ——
      //   原生构造器本来就满足这条，那个断言恒真，是个空断言（我第一版就写错了）。
      const hasSLO = typeof Intl[k].supportedLocalesOf === 'function'
      const hasRO = !!Intl[k].prototype && typeof Intl[k].prototype.resolvedOptions === 'function'
      let noNewOk = null
      try {
        Intl[k]('en-US')
        noNewOk = true
      } catch (e) {
        noNewOk = false
      }
      try {
        const inst = new Intl[k]()
        if (!inst || typeof inst.resolvedOptions !== 'function') continue
        const ro = inst.resolvedOptions()
        // 探「显式 locale 是否被尊重」：不尊重 = 这个构造器根本不读 locales 参数，
        // 那 _IN 那套「把 undefined 换成 _lang」的包装对它天然无效，修法要另想。
        let explicit = null
        let enus = null
        try {
          explicit = new Intl[k]('de-DE').resolvedOptions().locale
        } catch (e) {}
        try {
          // 这一条是关键：如果显式传 'en-US'（就是 _lang 的值）能回 en-US，
          // 说明构造器尊重 locale、包装器却**没有把 _lang 填进去**；
          // 如果显式 'en-US' 也回 zh-CN，那是 V8 自身的怪癖，与注入无关。
          enus = new Intl[k]('en-US').resolvedOptions().locale
        } catch (e) {}
        entries.push({ k, locale: ro.locale, timeZone: ro.timeZone, hasSLO, hasRO, noNewOk, explicit, enus, desc: descOf(k) })
      } catch (e) {
        // DisplayNames 之类需要必填参数，构造不出来 —— 记下来但不算不一致
        entries.push({ k, error: e.name, hasSLO, hasRO, noNewOk, desc: descOf(k) })
      }
    }
    return { base, entries }
  })()

  /* 16b：成对读数一致性 —— 同一事实的两个 API 必须给出同一个答案。
     这类断言不依赖「我事先知道有哪些 API」，所以能抓到未来新增的漏点。
     已知最容易漏的一对：`Intl.NumberFormat` 被换成了包装器，但
     `Number.prototype.toLocaleString` 内部构造的是 %Intl.NumberFormat% **内在对象**，
     不读全局属性 —— 于是它继续用宿主 locale，和 resolvedOptions 直接矛盾。 */
  const pairs = (() => {
    const out = {}
    try {
      out.intlNumberLocale = new Intl.NumberFormat().resolvedOptions().locale
      out.intlNumberFormat = new Intl.NumberFormat().format(1234.56)
    } catch (e) {
      out.intlNumberError = e.message
    }
    try {
      out.numberToLocaleString = (1234.56).toLocaleString()
    } catch (e) {
      out.numberToLocaleString = 'THROW:' + e.message
    }
    try {
      out.bigintToLocaleString = (1234567n).toLocaleString()
    } catch (e) {
      out.bigintToLocaleString = 'THROW:' + e.message
    }
    try {
      out.dateToLocaleString = new Date(2026, 0, 15, 12, 0, 0).toLocaleString()
      out.intlDateFormat = new Intl.DateTimeFormat(undefined, {
        dateStyle: 'short',
        timeStyle: 'medium'
      }).format(new Date(2026, 0, 15, 12, 0, 0))
    } catch (e) {
      out.dateError = e.message
    }
    try {
      out.intlNumberParts = new Intl.NumberFormat().formatToParts(1234.56).map((p) => p.value).join('')
    } catch (e) {
      out.intlNumberParts = 'THROW'
    }
    /* 数组的 toLocaleString 是「转发型」出口：它会把自己的 locales/options 转给元素。
       两类漏法方向相反，必须分开测：
         - 漏：默认 locale 没被接管 → 数组走宿主 locale，与元素自己走的不一致
         - 过接：显式 locale 被默认值盖掉 → 显式 'en-US' 也变成 profile locale
       只测默认那一条会漏掉「过接」，而 _withLoc / _withTz 这类包装最容易犯的正是过接。 */
    try {
      out.arrayToLocaleString = [1234.56].toLocaleString()
    } catch (e) {
      out.arrayToLocaleString = 'THROW:' + e.message
    }
    try {
      out.arrayToLocaleStringEn = [1234.56].toLocaleString('en-US')
    } catch (e) {
      out.arrayToLocaleStringEn = 'THROW:' + e.message
    }
    try {
      out.arrayDateExplicitTz = [new Date(0)].toLocaleString('en-US', { timeZone: 'Pacific/Midway' })
    } catch (e) {
      out.arrayDateExplicitTz = 'THROW:' + e.message
    }
    /* 关键补强：纯十进制数字在 zh-CN 和 en-US 下**格式完全相同**（都是 1,234.56），
       所以「期望值 = profile locale 的 format()」这种比较在中文宿主上恒绿 —— 空断言。
       下面两条挑的是「同一份数字、不同语言渲染不同」的样式，才能真的区分宿主与 profile：
         currency: zh-CN "US$1,234.56"  vs  en-US "$1,234.56"
         unit    : zh-CN "1,234.56公里"  vs  en-US "1,234.56 km"
       locale 参数一律传 undefined，让它走「默认 locale」那条路径 —— 那才是被接管的地方。 */
    try {
      out.currencyDefaultLocale = (1234.56).toLocaleString(undefined, { style: 'currency', currency: 'USD' })
    } catch (e) {
      out.currencyDefaultLocale = 'THROW:' + e.message
    }
    try {
      out.unitDefaultLocale = (1234.56).toLocaleString(undefined, { style: 'unit', unit: 'kilometer' })
    } catch (e) {
      out.unitDefaultLocale = 'THROW:' + e.message
    }
    return out
  })()

  /* 17：RTC 全局接口 —— 要么全在，要么全不在。删一半比不删更可疑 */
  const rtcGlobals = Object.getOwnPropertyNames(window)
    .filter((k) => /^RTC/.test(k))
    .sort()

  /* 22：hook 住在哪一层 —— 实例上多出来的自有属性是最硬的一种 tell。
     真实 Chrome 156 实测：`Object.getOwnPropertyNames(new RTCPeerConnection())` 是 []。
     把 hook 直接挂到实例上（而不是原型）会得到 ['addEventListener','onicecandidate'] 之类，
     而 `_maskOne` 只修 name/length/toString，**修不了属性住在哪一层**。
     注意判据必须是 getOwnPropertyNames，**不能是 for..in**：
     WebIDL 原型方法本身 enumerable，真 Chrome 的 for..in 也列一堆，用它会得到假绿。 */
  const rtcInstance = (() => {
    const out = { own: null, error: null }
    try {
      const pc = new RTCPeerConnection()
      out.own = Object.getOwnPropertyNames(pc).sort()
      try {
        pc.close()
      } catch (e) {}
    } catch (e) {
      out.error = e && e.name ? e.name : 'err'
    }
    return out
  })()

  /* 6b：plugins 的行为证据（Symbol.toStringTag 可以一行伪造，方法造不出来） */
  const pluginBehavior = (() => {
    try {
      const p = navigator.plugins
      if (!p || p.length === 0) return { empty: true }
      const first = p[0]
      return {
        itemWorks: typeof p.item === 'function' && p.item(0) === first,
        namedItemWorks: typeof p.namedItem === 'function' && p.namedItem(first.name) === first,
        hasRefresh: typeof p.refresh === 'function'
      }
    } catch (e) {
      return { error: e.message }
    }
  })()

  /* 20 项对比的**主世界侧**读数 —— 字段名必须与 Worker 侧逐字对应。
     为什么单独再采一遍、而不是在 Node 侧从 nav/identity/behavior 里拼：
     拼的话「字段含义」散落在判定逻辑里，一侧改了另一侧没改，就会拿一对名字不同、
     实际同源的值去比，判定恒真 —— 那正是这条检查早先失效的方式。
     字段名一一对应，是这条断言的骨架。 */
  const T2 = (f) => {
    try {
      return f()
    } catch (e) {
      return 'THROW:' + ((e && e.name) || 'err')
    }
  }
  const localeOf = (C) => T2(() => new C().resolvedOptions().locale)
  // 与 Worker 侧**逐字同源**的三个采样点（Date.UTC，与宿主时区无关）
  const WORKER_INSTANTS = [Date.UTC(1970, 0, 1, 0, 0, 0), Date.UTC(2024, 0, 15, 12, 0, 0), Date.UTC(2024, 6, 15, 12, 0, 0)]
  const MAP2 = (f) => WORKER_INSTANTS.map((t) => T2(() => f(t)))
  const workerPairs = {
    ua: ua,
    platform: nav.platform,
    cores: nav.cores,
    memory: nav.memory,
    languages: nav.languages,
    language: nav.language,
    intlDTF: localeOf(Intl.DateTimeFormat),
    intlNF: localeOf(Intl.NumberFormat),
    intlCollator: localeOf(Intl.Collator),
    intlPluralRules: localeOf(Intl.PluralRules),
    intlRTF: localeOf(Intl.RelativeTimeFormat),
    intlListFormat: localeOf(Intl.ListFormat),
    tz: identity.tz,
    tzNameLong: T2(() => {
      const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'long' }).formatToParts(new Date(0))
      for (const p of parts) if (p.type === 'timeZoneName') return p.value
      return null
    }),
    dateOffsets: MAP2((t) => new Date(t).getTimezoneOffset()),
    dateHours: MAP2((t) => new Date(t).getHours()),
    dateString: MAP2((t) => new Date(t).toString()),
    dateToLocaleString: MAP2((t) => new Date(t).toLocaleString()),
    dateTZShort: MAP2((t) => new Date(t).toLocaleTimeString('en-US', { timeZoneName: 'short' })),
    dateLocaleDate: MAP2((t) => new Date(t).toLocaleDateString()),
    glVendor: webgl.vendor,
    glRenderer: webgl.renderer,
    uaData: uaData ? { brands: uaData.brands, platform: uaData.platform } : null
  }

  return {
    mask,
    markers,
    ua,
    uaData,
    nav,
    workerPairs,
    // 采样点从探针里带出来，判定侧不再自己写一份 —— 两份常量漂移会让「三点采样」
    // 悄悄退回一点，而读数看起来照旧正常。
    workerInstants: WORKER_INSTANTS,
    plugins,
    mimeTypes,
    pluginBehavior,
    screen: screenProbe,
    identity,
    webgl,
    rtcCandidates,
    rtcGlobals,
    rtcInstance,
    intlConsistency,
    pairs,
    electronSurface,
    behavior,
    worker,
    toStringStack
  }
}

const PROBE_SRC = '(' + pageProbe.toString() + ')()'

/* ────────────────────────────── OOPIF 探针（AC-21） ────────────────────────────── */

/**
 * 跨站 iframe 的注入覆盖。**这条以前完全没有** —— 全脚本里 `iframe` 零命中。
 *
 * 为什么必须单开一条：`Page.addScriptToEvaluateOnNewDocument` 是下给**页面目标**的。
 * 同进程的子 frame 会一起吃到；跨站 iframe 在 Chromium 里是独立目标（OOPIF），
 * 拿不到这条注入 —— 于是父页是伪装值、子帧是宿主真值，而**父页自己的探针看不见这件事**：
 * 它读的是自己的 world。只有主动造一个跨站 iframe 并让子帧自报读数才能发现。
 *
 * 为什么用 postMessage 而不是 `iframe.contentWindow.navigator...`：
 * 跨域访问会抛 SecurityError，直接读根本采不到数。但子帧自己的脚本可以读自己的
 * navigator —— 这正是广告 iframe / 第三方组件的真实攻击形态（它们自报指纹给上游）。
 * 所以：父页把 reader 的**源码**发过去，子帧 eval 后回传读数。
 * 这样两侧跑的是同一份代码，不存在「父页采 A、子帧采 B」的错位比较。
 *
 * 参数 frameUrl 由调用方注入（本函数会被 toString 后单独执行，不能引用外部变量）。
 */
async function oopifProbe(frameUrl) {
  const readFacts = function () {
    const T = (f) => {
      try {
        return f()
      } catch (e) {
        return 'THROW:' + ((e && e.name) || 'err')
      }
    }
    const gl = (which) =>
      T(() => {
        const c = document.createElement('canvas').getContext('webgl')
        const e = c.getExtension('WEBGL_debug_renderer_info')
        return c.getParameter(which === 'vendor' ? e.UNMASKED_VENDOR_WEBGL : e.UNMASKED_RENDERER_WEBGL)
      })
    return {
      cores: T(() => navigator.hardwareConcurrency),
      memory: typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null,
      languages: navigator.languages ? Array.prototype.slice.call(navigator.languages) : null,
      language: T(() => navigator.language),
      dtfLocale: T(() => Intl.DateTimeFormat().resolvedOptions().locale),
      tz: T(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
      glVendor: gl('vendor'),
      glRenderer: gl('renderer')
    }
  }

  const out = {
    main: null,
    frame: null,
    mode: null,
    error: null,
    crossOrigin: null,
    frameUrl: frameUrl,
    href: null
  }

  try {
    out.main = readFacts()
    out.href = location.href
  } catch (e) {
    out.error = 'main:' + ((e && e.message) || e)
    return out
  }

  const f = document.createElement('iframe')
  f.id = 'ss-oopif'
  f.width = '320'
  f.height = '120'
  f.src = frameUrl

  const loaded = await new Promise((done) => {
    const timer = setTimeout(() => done(false), 8000)
    f.addEventListener('load', () => {
      clearTimeout(timer)
      done(true)
    })
    try {
      document.body.appendChild(f)
    } catch (e) {
      clearTimeout(timer)
      done(false)
    }
  })
  if (!loaded) {
    out.error = 'iframe 未在 8s 内 load（本地两个 origin 起不来？）'
    return out
  }

  // 同源的话直接读得到 —— 读到数值说明「跨站」这个前提没成立，本条测试无效。
  // 不能把它记成「一致」：那是测试自己坏了，不是被测对象没问题。
  try {
    out.crossOrigin = 'readable:' + f.contentWindow.navigator.hardwareConcurrency
  } catch (e) {
    out.crossOrigin = 'blocked:' + ((e && e.name) || 'err')
  }

  const reply = await new Promise((done) => {
    const timer = setTimeout(() => done({ timeout: true }), 8000)
    const onMsg = (ev) => {
      if (!ev.data || ev.data.ss !== 'oopif-reply') return
      if (ev.source !== f.contentWindow) return
      clearTimeout(timer)
      removeEventListener('message', onMsg)
      done(ev.data)
    }
    addEventListener('message', onMsg)
    try {
      f.contentWindow.postMessage({ ss: 'oopif-probe', src: readFacts.toString() }, '*')
    } catch (e) {
      clearTimeout(timer)
      done({ error: 'postMessage:' + ((e && e.message) || e) })
    }
  })

  if (reply.timeout) out.error = '子帧 8s 内没有回传读数（postMessage 通道不通）'
  else if (reply.error) out.error = '子帧执行失败：' + reply.error
  else {
    out.frame = reply.value
    out.mode = 'postMessage'
  }
  return out
}

/* ────────────────────────────── 探针页 ────────────────────────────── */

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(
    '<!doctype html><meta charset="utf-8"><title>anticheat probe</title>' +
      '<body style="font:14px system-ui">probe</body>'
  )
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const PAGE_URL = 'http://127.0.0.1:' + PORT + '/'

/* 第二个 origin：AC-21 要跨站 iframe，就必须真的换 host。
   只换端口不算跨站 —— Chromium 的 site 键不含端口，同 host 不同端口仍是同进程，
   那样测出来的「一致」是「注入覆盖了同进程子 frame」，不是「覆盖了 OOPIF」。
   127.0.0.2 与 127.0.0.1 是不同 host，各自是独立的 site，才会真的分进程。 */
const frameServer = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(
    '<!doctype html><meta charset="utf-8"><title>oopif frame</title>' +
      '<body style="font:14px system-ui">frame B' +
      '<script>' +
      "addEventListener('message',function(e){var d=e.data;" +
      "if(!d||d.ss!=='oopif-probe')return;" +
      'try{var fn=(0,eval)("("+d.src+")");' +
      "e.source.postMessage({ss:'oopif-reply',value:fn()},'*')}" +
      "catch(err){e.source.postMessage({ss:'oopif-reply',error:String((err&&err.message)||err)},'*')}" +
      '})' +
      '</script>'
  )
})
// 绑不上 127.0.0.2 不能让整个脚本崩 —— 崩了就是「一条门禁都没跑」，
// 而「0 条门禁」在 CI 里比「一条红」更危险（它长得像通过）。所以降级成 AC-21 判红 + 说明原因。
let FRAME_URL = null
let OOPIF_PAGE_URL = null
let FRAME_BIND_ERROR = null
try {
  await new Promise((res, rej) => {
    frameServer.once('error', rej)
    frameServer.listen(0, '127.0.0.2', res)
  })
  FRAME_URL = 'http://127.0.0.2:' + frameServer.address().port + '/'
  OOPIF_PAGE_URL = 'http://127.0.0.1:' + PORT + '/oopif'
} catch (e) {
  FRAME_BIND_ERROR = String((e && e.message) || e)
}
const OOPIF_PROBE_SRC = FRAME_URL
  ? '(' + oopifProbe.toString() + ')(' + JSON.stringify(FRAME_URL) + ')'
  : null

/* ────────────────────────────── 启动 Electron ────────────────────────────── */

const electronBinary = () => {
  try {
    const p = require('electron')
    if (typeof p === 'string') return p
  } catch {}
  return resolve(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
}

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE

/* 每次运行用**独立的临时 userData**（Chromium 的 --user-data-dir）。
 *
 * 为什么必须隔离：Chromium 对整个 userData 目录有一个 ProcessSingleton 锁。
 * 实测撞过三种后果，全都是「读数不可信」而不是「脚本坏了」：
 *   1) `electron.launch()` 直接抛 `Target page ... has been closed`；
 *   2) launch 与 firstWindow 都「成功」，但第一次 evaluate 就
 *      `Render frame was disposed`（连上的是另一个实例的窗口）；
 *   3) 磁盘缓存报 `Unable to move the cache: 拒绝访问`，页面行为异常。
 * 触发源不一定是本 app：同目录下任何 Electron 进程（例如队友的 probe 脚本、
 * 或用户自己开着的浏览器）只要用同一个 userData 就会互相挤。
 *
 * 隔离之后：
 *   - 用户开着浏览器时也能跑门禁（不需要「先关掉」）；
 *   - 每次运行的初始状态一致（没有残留 cookie/缓存/profile），读数可复现；
 *   - 代价：临时 userData 里没有任何 profile，所以**门禁自己建 profile**（见主流程）。
 *     这对门禁是好事 —— 读数不再依赖用户本地有什么环境。
 *
 * 不做「启动前扫进程 / kill 残留」：扫进程会误判 VS Code、Slack 等任何 Electron 应用；
 * kill 更不行，用户可能正在用浏览器。隔离比清理安全。 */
/* `SS_USERDATA_DIR=<path>` 可以指定 userData，用来复现「两个实例抢同一把锁」这类问题。
 * 不指定时一律新建临时目录 —— 那是默认行为，也是门禁该走的路。
 * 有这个开关才能验证「拿不到窗口 → 退出码 3、一行表格都不打印」这条分支：
 * 否则它只在真的撞锁时出现，而撞锁本身不可控。 */
const TMP_USERDATA = process.env.SS_USERDATA_DIR
  ? (mkdirSync(resolve(process.env.SS_USERDATA_DIR), { recursive: true }), resolve(process.env.SS_USERDATA_DIR))
  : mkdtempSync(join(tmpdir(), 'ss-anticheat-'))
const CLEAN_USERDATA = !process.env.SS_KEEP_USERDATA && !process.env.SS_USERDATA_DIR

/* 单实例锁：本 app 用 `app.requestSingleInstanceLock()`（src/main/index.ts:17）。
 * 隔离 userData 之后这条基本不会再触发，但保留为兜底 —— 一旦触发，说明启动链本身
 * 有问题（崩溃 / 锁），必须 fail fast 而不是打印一张可能来自别处的表。 */
/* ── 产物完整性：任何 AC 之前先验 ──
 *
 * 为什么必须有这一步：`electron-vite build` 的 `prepareOutDir` 会先 `emptyDir(out/)`。
 * 在 Windows 上这一步可能失败（实测：`[safe-delete] 操作失败 … trash operation aborted`），
 * 而失败发生在**清空之后、重建之前**，于是 `out/` 会停在「main 建好、preload 没了」的残缺状态。
 *
 * 此时如果直接跑 AC，得到的是「Electron 起不来」或「渲染层一片空」，
 * 会被读成一整批安全回归 —— 有人会去改本来没坏的代码。**那比漏测更糟。**
 *
 * 所以：产物不全 → 退出码 2（环境崩溃），且必须打印「未测量」。
 * 退出码语义与全局一致：0 通过 / 1 断言失败 / 2 脚本或环境崩溃 / 3 未测量。
 * 这里选 2 而不是 3：3 表示「测了但没拿到读数」，2 表示「连跑都没跑起来」。
 */
const REQUIRED_PRODUCTS = [
  'out/main/index.js',
  'out/preload/index.js',
  'out/renderer/index.html'
]
const productSizes = {}
const missingProducts = []
for (const rel of REQUIRED_PRODUCTS) {
  try {
    const st = statSync(join(ROOT, rel))
    if (!st.isFile() || st.size === 0) missingProducts.push(rel + '（空文件或不是普通文件）')
    else productSizes[rel] = st.size
  } catch {
    missingProducts.push(rel + '（不存在）')
  }
}
if (missingProducts.length > 0) {
  console.error('')
  console.error('产物不完整，本次未测量（exit 2，**不是**安全回归）：')
  for (const m of missingProducts) console.error('  · ' + m)
  console.error('  已就绪：' + (Object.keys(productSizes).join(', ') || '（无）'))
  console.error('  常见原因：build 在 prepareOutDir 的 emptyDir 上失败（Windows 上表现为')
  console.error('  `[safe-delete] 操作失败 … trash operation aborted`），此时 out/ 被清掉一半；')
  console.error('  另一个原因是有别人同时在 build，两个 prepareOutDir 互相清对方的产物。')
  console.error('  → 先 `npm run build` 跑完再测。不要在这一步去改 AC。')
  process.exit(2)
}
console.log('产物完整性：' + Object.entries(productSizes).map(([k, v]) => k + '=' + v + 'B').join('  '))

const lockHint =
  '  常见原因：单实例锁（userData 被另一个实例占着）或启动崩溃。\n' +
  '  → 本脚本已用临时 userData 隔离，若仍撞锁，说明还有进程在用同一个目录。\n' +
  '  → 不会替你 kill 进程：你可能正在用它。看上面的 electron 日志确认是否崩溃。'

const dieNoWindow = (detail) => {
  console.error('')
  console.error('启动失败：拿不到主窗口，本次不产出任何读数（不是「通过」，是「没测」）。')
  if (detail) console.error(detail)
  try {
    server.close()
  } catch {}
  try {
    frameServer.close()
  } catch {}
  try {
    if (CLEAN_USERDATA) rmSync(TMP_USERDATA, { recursive: true, force: true })
  } catch {}
  // 退出码 3 = 未测量（与 check-build-fresh / aborted 同档）。
  // 这条路径连 payload 都写不出来（app 都没起来），所以退出码必须自带含义。
  process.exit(3)
}

let app = null
try {
  app = await electron.launch({
    executablePath: electronBinary(),
    args: ['.', '--user-data-dir=' + TMP_USERDATA],
    cwd: ROOT,
    env,
    timeout: 40000
  })
} catch (err) {
  const msg = String((err && err.message) || err)
  const firstLine = msg.split('\n')[0]
  dieNoWindow('  electron.launch 直接失败：' + firstLine + '\n' + lockHint)
}

const appProc = app.process()
let main = null
let launchError = null
try {
  main = await Promise.race([
    app.firstWindow({ timeout: 25000 }),
    new Promise((_res, rej) => {
      const onExit = (code) =>
        rej(Object.assign(new Error('electron 进程在窗口出现前退出'), { exitCode: 5, procExit: code }))
      if (!appProc) return
      if (appProc.exitCode !== null) return onExit(appProc.exitCode)
      appProc.once('exit', onExit)
    })
  ])
} catch (err) {
  launchError = err
}

if (!main) {
  const lock = launchError && launchError.exitCode === 5
  try {
    await app.close()
  } catch {}
  dieNoWindow(
    lock
      ? '  electron 进程在窗口出现前就退出了（exitCode=' + launchError.procExit + '）。\n' + lockHint
      : '  ' + (launchError && launchError.message ? launchError.message : String(launchError))
  )
}

/* 等壳层真正就绪，而不是「睡 1.5 秒就当它好了」。
 *
 * 实测：换成临时 userData 后首次启动会慢一些，1.5s 时渲染进程还在导航 ——
 * `main.evaluate` 会抛 `Render frame was disposed before the request completed`。
 * 这类失败只看错误信息会被误判成「脚本坏了」或「单实例锁」，真正原因是「还没准备好」。
 * 所以判据必须是「window.ss 能调通」，不是「睡够了」。 */
let shellReady = false
{
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      const ok = await main.evaluate(
        async () => typeof window !== 'undefined' && !!window.ss && typeof window.ss.profiles.list === 'function'
      )
      if (ok) {
        shellReady = true
        break
      }
    } catch (e) {
      // 帧被换掉 → 重新取一个窗口再试
      try {
        if (main.isClosed()) main = await app.firstWindow({ timeout: 10000 })
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}
if (!shellReady) {
  console.error('')
  console.error('壳层 30s 内没就绪（window.ss 调不通），本次不产出任何读数。')
  console.error('  常见原因：渲染进程崩溃 / preload 没加载 / out/ 与 src/ 不匹配。')
  try {
    await app.close()
  } catch {}
  try {
    server.close()
  } catch {}
  try {
    frameServer.close()
  } catch {}
  try {
    if (CLEAN_USERDATA) rmSync(TMP_USERDATA, { recursive: true, force: true })
  } catch {}
  process.exit(5)
}

/** 主窗口 evaluate：帧被换掉时重取窗口重试，而不是让一次竞态毁掉整轮 */
async function evalMain(fn, arg) {
  let lastErr = null
  for (let i = 0; i < 3; i++) {
    try {
      if (!main || main.isClosed()) main = await app.firstWindow({ timeout: 15000 })
      return await main.evaluate(fn, arg)
    } catch (e) {
      lastErr = e
      const msg = String((e && e.message) || e)
      if (!/Render frame was disposed|Target closed|has been closed/i.test(msg)) throw e
      await new Promise((r) => setTimeout(r, 1200))
      try {
        main = await app.firstWindow({ timeout: 15000 })
      } catch {}
    }
  }
  throw lastErr
}

/* ────────────────────────────── 采集一个环境 ────────────────────────────── */

async function collect(profileId, label) {
  await evalMain(async (id) => {
    await window.ss.profiles.launch(id)
  }, profileId)
  await main.waitForTimeout(6000)

  /* 怎么认定「这个视图就是那个 profile 的」—— 这一条比什么都重要。
   *
   * 早先按 URL 找窗口：先是只匹配 `role=browser`（多环境时可能拿到别人的窗口，
   * 读数被归错环境：实测出现过打印 profile=审计-Windows、主世界却读到 MacIntel）；
   * 改成再加 `profileId` 子串匹配后又发现 URL 形状本身不可靠 ——
   * 有的启动路径只带 `?role=browser&windowId=...`，根本没有 profileId 参数。
   *
   * 真正可靠的标识是 **session partition**：`partitionFor(profileId)` = `persist:ss_<id>`，
   * 一个 profile 一个分区，跨窗口唯一、且是 Electron 侧的强标识（不是页面自报的字符串）。
   * 按 partition 反查 WebContentsView，拿不到就抛错 —— 绝不退化成「拿第一个 role=browser 的窗口凑合」。
   * 双轨窗口里有两个 WebContentsView（人轨 + 影子轨），同 profile 同分区，取第一个即可。
   */
  const PARTITION = 'persist:ss_' + profileId
  const viewId = await app.evaluate(async ({ BrowserWindow, session }, partition) => {
    const want = session.fromPartition(partition)
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.webContents.getURL().includes('role=browser')) continue
      for (const c of w.contentView.children || []) {
        const wc = c && c.webContents
        if (wc && !wc.isDestroyed() && wc.session === want) return wc.id
      }
    }
    return null
  }, PARTITION)
  if (!viewId) {
    throw new Error(
      '找不到 profile「' + label + '」的浏览器视图（partition=' + PARTITION + '）—— ' +
        '读不到就说明窗口没开或开在了别的环境上，读数不可信，拒绝继续'
    )
  }

  const isDisposed = (e) =>
    /Render frame was disposed|Target closed|has been closed|视图已销毁|Object has been destroyed/i.test(
      String((e && e.message) || e)
    )

  // 导航到探针页：必须真的停在探针页上，否则后面 executeJavaScript 读到的是别的文档
  const navigate = async (url) => {
    await app.evaluate(
      async ({ webContents }, a) => {
        const wc = webContents.fromId(a.id)
        if (!wc || wc.isDestroyed()) throw new Error('视图已销毁')
        // 首屏（默认主页，可能是远端首页）还在加载时直接 loadURL 会被 ERR_ABORTED 打断
        try {
          wc.stop()
        } catch (e) {}
        await new Promise((r) => setTimeout(r, 400))
        for (let i = 0; i < 4; i++) {
          try {
            await wc.loadURL(a.url)
          } catch (e) {}
          if (wc.getURL().indexOf(a.host) === 0) return
          await new Promise((r) => setTimeout(r, 400))
        }
        throw new Error('页面没能停在探针页（当前 ' + wc.getURL() + '）')
      },
      { id: viewId, url, host: 'http://127.0.0.1:' }
    )
  }

  /* executeJavaScript 带重试：探针本身要跑 2~3 秒（Worker/RTC/音频），
     期间如果文档被换掉（重载、首页迟到、渲染进程崩溃重建），会抛
     `Render frame was disposed`。一次竞态不该把整轮门禁变成 exit 5，
     但也不能吞掉 —— 重试 3 次仍失败就抛出，由上层判「没测」。 */
  const execOn = async (script, url) => {
    let lastErr = null
    for (let i = 0; i < 3; i++) {
      try {
        return await app.evaluate(
          async ({ webContents }, a) => {
            const wc = webContents.fromId(a.id)
            if (!wc || wc.isDestroyed()) throw new Error('视图已销毁')
            return await wc.executeJavaScript(a.script)
          },
          { id: viewId, script }
        )
      } catch (e) {
        lastErr = e
        if (!isDisposed(e)) throw e
        await main.waitForTimeout(1500)
        try {
          await navigate(url)
          await main.waitForTimeout(800)
        } catch (e2) {}
      }
    }
    throw lastErr
  }

  await navigate(PAGE_URL)
  await main.waitForTimeout(1500)
  const data = await execOn(PROBE_SRC, PAGE_URL)

  /* AC-21：换到「会自己嵌一个跨站 iframe」的页面再采一次。
     必须在同一个 webContents 里做 —— 注入是按 webContents 下的，
     换一个窗口就等于换了一个被测对象。 */
  if (!OOPIF_PAGE_URL) {
    data.oopif = {
      error: '第二个 origin 起不来（127.0.0.2 绑定失败：' + FRAME_BIND_ERROR + '），跨站 iframe 场景无法构造'
    }
    data.oopifFrames = null
  } else {
    await navigate(OOPIF_PAGE_URL)
    await main.waitForTimeout(1200)
    data.oopif = await execOn(OOPIF_PROBE_SRC, OOPIF_PAGE_URL)

    // 子帧到底是不是独立进程 —— 这决定了 AC-21 测到的是「OOPIF 缺口」还是
    // 「同进程跨域子 frame 缺口」。两者修法不同，读数不能混为一谈。
    data.oopifFrames = await app.evaluate(async ({ webContents }, id) => {
      try {
        const wc = webContents.fromId(id)
        if (!wc || wc.isDestroyed()) return { error: '视图已销毁' }
        const mf = wc.mainFrame
        const all = mf.framesInSubtree || mf.frames || []
        return {
          main: { processId: mf.processId, url: mf.url },
          frames: Array.from(all).map((f) => ({ processId: f.processId, url: f.url }))
        }
      } catch (e) {
        return { error: String((e && e.message) || e) }
      }
    }, viewId)
  }

  // 关掉承载这个视图的窗口（按视图 id 反查，不按 URL 猜）
  await app.evaluate(async ({ BrowserWindow }, id) => {
    for (const w of BrowserWindow.getAllWindows()) {
      const kids = w.contentView.children || []
      if (kids.some((c) => c && c.webContents && c.webContents.id === id)) {
        try {
          w.close()
        } catch (e) {}
        return
      }
    }
  }, viewId)
  await main.waitForTimeout(1200)

  return data
}

/* ────────────────────────────── 判定 ────────────────────────────── */

const results = []
const add = (id, name, expected, actual, pass, note, opts = {}) => {
  results.push({
    id,
    name,
    expected,
    actual,
    pass,
    gate: opts.gate !== false,
    // skipped：本条在当前模式下不适用（例：AC-12 需要 --nightly）。不计入分母。
    skipped: !!opts.skipped,
    /* unmeasured：本条**应该**测，但这次没测到（例：AC-14 的 Worker 侧因注入停用而未测量）。
     *
     * 和 skipped 的区别是「该不该测」：skipped 是「这个模式不需要它」，
     * unmeasured 是「需要它，但拿不到读数」。后者**必须留在分母里** ——
     * 把它当成 skipped 去掉，`19/20 通过` 就会退化成 `19/19 通过`，
     * 「少测一项」被伪装成「测了 19 项全过」。这是本仓库最常见的假绿形态。 */
    unmeasured: !!opts.unmeasured,
    // 分组只影响**呈现**（同一 P0 组的多条判据并排看），不影响计数：
    // 合并成一条会丢掉「主世界 vs Worker」和「父页 vs 子帧」这两种视角的区分度，
    // 而它们红的修法完全不同（前者是 Worker 目标没挂注入，后者是 OOPIF 目标没挂）。
    group: opts.group || null,
    note: note || ''
  })
}

const PRIVATE_IP =
  /^(10\.|192\.168\.|169\.254\.|127\.|172\.(1[6-9]|2[0-9]|3[01])\.|fc|fd|fe80)|\.local$/i

const PLATFORM_JS = { windows: 'Win32', macos: 'MacIntel', linux: 'Linux x86_64' }
const PLATFORM_CH = { windows: 'Windows', macos: 'macOS', linux: 'Linux' }

/** 某 IANA 时区在给定时刻的偏移（分钟，符号与 Date#getTimezoneOffset 一致） */
function tzOffset(tz, date) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    const p = {}
    for (const x of dtf.formatToParts(date)) p[x.type] = x.value
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second)
    return Math.round((date.getTime() - asUTC) / 60000)
  } catch (e) {
    return null
  }
}

/**
 * 时区偏移的**第二条独立路径**：`timeZoneName: 'shortOffset'` 的字符串。
 *
 * 为什么必须有第二条：`tzOffset()` 和渲染层实现（`_targetOff`）用的是同一套算术 ——
 * 「取本地年月日时分秒 → 拼回 UTC → 相减」。判据如果照抄实现，两边同时漏掉 DST
 * 时依然全绿，判据就成了实现的复读机。`shortOffset` 是 ICU 直接吐的字符串
 * （`GMT` / `GMT+8` / `GMT-5` / `GMT+5:30`），不经过任何日期算术。
 *
 * 返回值的符号与 `Date#getTimezoneOffset()` 一致（西为正）：`GMT+8` → `-480`。
 * 这一点必须写在注释里 —— 符号反了会让整条判据在 UTC 时区上「碰巧通过」。
 */
function tzOffsetByShortOffset(tz, date) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(date)
    const raw = (parts.find((p) => p.type === 'timeZoneName') || {}).value
    if (!raw) return { offset: null, raw: null }
    const m = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(raw)
    if (!m) return { offset: null, raw }
    if (!m[1]) return { offset: 0, raw }
    const east = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0))
    return { offset: -east, raw }
  } catch (e) {
    return { offset: null, raw: null, error: String((e && e.message) || e) }
  }
}

/**
 * 鉴别力前置断言（cores / timezone / locale 三处共用的唯一一份实现）。
 *
 * 一条判据如果在**当前环境**下「不管注入有没有生效都成立」，它就没有鉴别力，
 * 这时它给出的绿是假绿。最典型的三个：
 *   - cores：宿主机 12 核、profile 也配 12 核 → 读到 12 不代表注入生效；
 *   - timezone：宿主与 profile 同时区 → 偏移相等是必然的；
 *   - locale：宿主 en-US、profile en-US → 日期输出语言恒为英文。
 *
 * 三种情况的处置完全一样：**标记「无鉴别力」并跳过，绝不算通过**。
 * 所以抽成一个 helper —— 写三遍的话，只要有一遍写成「跳过 = 通过」，
 * 整条门禁就又退回假绿，而且退化点极难发现。
 *
 * @param {string} what          判据名（写进报告）
 * @param {*} host               宿主侧的值（不注入时会读到的值）
 * @param {*} prof               profile 配置值（注入生效后应该读到的值）
 * @param {(a:any,b:any)=>boolean} differs  「两个值足以区分」的判定
 * @param {string} how           无鉴别力时给人看的解释
 * @returns {{power:boolean, why:string, host:any, prof:any}}
 */
function powerCheck(what, host, prof, differs, how) {
  if (prof === null || prof === undefined || prof === '' || (Array.isArray(prof) && prof.length === 0)) {
    return { power: false, why: `${what}：profile 侧没有配置值，无法判定 —— 标为「没测到」，不算通过`, host, prof }
  }
  if (host === null || host === undefined) {
    return { power: false, why: `${what}：宿主侧读数采不到 —— 标为「没测到」，不算通过`, host, prof }
  }
  if (differs(host, prof)) return { power: true, why: '', host, prof }
  return {
    power: false,
    why: `${what}：${how}（宿主=${JSON.stringify(host)} profile=${JSON.stringify(prof)}）—— 本次环境里无鉴别力，标为「没测到」，不算通过`,
    host,
    prof
  }
}

function judge(fp, d, runs, ctx = {}) {
  /* 1 —— toString 外观 */
  const notNative = d.mask.filter((m) => m.missing || !m.native).map((m) => m.name + (m.missing ? '(缺失)' : ':' + (m.src || '').slice(0, 48)))
  add(
    'AC-01',
    '被 patch 的入口 toString 必须是 [native code]',
    '全部 native',
    notNative.length ? notNative : '全部 native',
    notNative.length === 0,
    notNative.length ? '漏登记或未收口，一次 toString 就能枚举出全部 hook' : ''
  )

  /* 2 —— prototype 枚举洞 */
  const withProto = d.mask.filter((m) => !m.missing && m.hasProto !== false).map((m) => m.name)
  add(
    'AC-02',
    "被 patch 的入口不得有 prototype（'prototype' in fn）",
    '全部 false',
    withProto.length ? withProto : '全部 false',
    withProto.length === 0,
    withProto.length ? '原生方法/getter 没有 prototype，普通函数字面量有 —— 一行枚举整张 hook 清单' : ''
  )

  /* 3 —— 全局标记 */
  add('AC-03', '主世界不得残留内部标记', '[]', d.markers, d.markers.length === 0, '')

  /* 4 —— UA / UA-CH */
  const uaProblems = []
  if (/Electron/i.test(d.ua)) uaProblems.push('UA 含 Electron')
  if (/HeadlessChrome/i.test(d.ua)) uaProblems.push('UA 含 HeadlessChrome')
  if (d.ua !== fp.userAgent) uaProblems.push('UA 与 profile 不一致')
  if (!d.uaData) uaProblems.push('navigator.userAgentData 缺失')
  else {
    if (!d.uaData.brands.some((b) => b.startsWith('Google Chrome'))) uaProblems.push('brands 缺 Google Chrome')
    if (d.uaData.platform !== PLATFORM_CH[fp.os]) uaProblems.push('UA-CH platform=' + d.uaData.platform)
    if (d.uaData.mobile !== false) uaProblems.push('UA-CH mobile=' + d.uaData.mobile)
  }
  add(
    'AC-04',
    'UA 与 UA-CH 一致且不含 Electron/Headless',
    'UA=' + fp.userAgent + ' / platform=' + PLATFORM_CH[fp.os],
    { ua: d.ua, uaData: d.uaData },
    uaProblems.length === 0,
    uaProblems.join('；')
  )

  /* 5 —— navigator 值 */
  const navProblems = []
  if (d.nav.platform !== PLATFORM_JS[fp.os]) navProblems.push('platform=' + d.nav.platform + ' ≠ ' + PLATFORM_JS[fp.os])
  if (d.nav.cores !== fp.hardware.cpuCores) navProblems.push('cores=' + d.nav.cores + ' ≠ ' + fp.hardware.cpuCores)
  if (JSON.stringify(d.nav.languages) !== JSON.stringify(fp.languages)) navProblems.push('languages=' + JSON.stringify(d.nav.languages))
  if (d.identity.tz !== fp.timezone) navProblems.push('timeZone=' + d.identity.tz + ' ≠ ' + fp.timezone)
  if (!String(d.identity.locale || '').startsWith(String(fp.locale).slice(0, 2))) navProblems.push('locale=' + d.identity.locale + ' ≠ ' + fp.locale)
  if (d.nav.webdriver !== false) navProblems.push('webdriver=' + d.nav.webdriver)
  add(
    'AC-05',
    'navigator 读数与 profile 配置一致',
    'platform/cores/languages/timeZone/locale 全部匹配',
    { platform: d.nav.platform, cores: d.nav.cores, languages: d.nav.languages, tz: d.identity.tz, locale: d.identity.locale, webdriver: d.nav.webdriver },
    navProblems.length === 0,
    navProblems.join('；')
  )

  /* 6 —— plugins 的值（这条最容易假阳性） */
  const hasPdf = d.plugins.some((n) => /pdf/i.test(n))
  const pluginReal = d.behavior.pluginArrayTag === '[object PluginArray]'
  // Symbol.toStringTag 一行就能伪造 tag，所以还要行为证据：item / namedItem 造不出来
  const pb = d.pluginBehavior || {}
  const pluginBehaviorOk = pb.empty ? true : pb.itemWorks === true && pb.namedItemWorks === true
  const pluginOk = d.plugins.length > 0 && hasPdf && d.mimeTypes.length > 0 && pluginReal && pluginBehaviorOk
  add(
    'AC-06',
    'navigator.plugins 的值必须非空、含 PDF 条目、且行为像 PluginArray',
    'length>0 且含 PDF，mimeTypes 非空，tag=[object PluginArray]，item/namedItem 可用',
    {
      length: d.plugins.length,
      names: d.plugins,
      mimeCount: d.mimeTypes.length,
      tag: d.behavior.pluginArrayTag,
      behavior: pb
    },
    pluginOk,
    pluginOk
      ? '注意：这是**真 PluginArray**，说明 plugins 根本没被伪造 —— 本次通过靠的是 Electron 自带的 Chromium 默认列表恰好和 Chrome 一样，不是伪装生效。这条只能防「列表被清空」「被换成裸数组」这类回归，不能证明「已伪造」。'
      : 'plugins 只在 _maskAll 清单里、没有 defVal 伪造值：toString 已伪装但值是 Electron 真实值，这是「外观修好了、值没修」的典型假阳性'
  )

  /* 7 —— screen 与媒体查询 */
  const scr = d.screen
  const scrProblems = []
  if (scr.width !== fp.screen.width || scr.height !== fp.screen.height) scrProblems.push('screen=' + scr.width + 'x' + scr.height + ' ≠ ' + fp.screen.width + 'x' + fp.screen.height)
  if (Math.abs(scr.dpr - fp.screen.dpr) > 0.001) scrProblems.push('dpr=' + scr.dpr + ' ≠ ' + fp.screen.dpr)
  if (scr.colorDepth !== fp.screen.colorDepth) scrProblems.push('colorDepth=' + scr.colorDepth + ' ≠ ' + fp.screen.colorDepth)
  if (!scr.mqDeviceWidth) scrProblems.push('媒体查询 device-width 与 screen.width 矛盾')
  if (!scr.mqDeviceHeight) scrProblems.push('媒体查询 device-height 与 screen.height 矛盾')
  if (!scr.mqResolution) scrProblems.push('媒体查询 resolution 与 dpr 矛盾')
  if (scr.mqRealWidth !== scr.width) scrProblems.push('媒体查询实际宽度=' + scr.mqRealWidth + ' ≠ ' + scr.width)
  add(
    'AC-07',
    'screen / DPR 与 CSS 媒体查询一致',
    fp.screen.width + 'x' + fp.screen.height + ' @' + fp.screen.dpr + 'x',
    scr,
    scrProblems.length === 0,
    scrProblems.join('；')
  )

  /* 8 —— 构造器身份自洽 */
  const idt = d.identity
  const idProblems = []
  if (idt.dtfInstanceCtor !== true) idProblems.push('new Intl.DateTimeFormat().constructor 不是 Intl.DateTimeFormat')
  if (idt.dtfProtoCtor !== true) idProblems.push('Intl.DateTimeFormat.prototype.constructor 指回原生')
  if (idt.nfInstanceCtor !== true) idProblems.push('NumberFormat 实例 constructor 不一致')
  if (idt.nfProtoCtor !== true) idProblems.push('NumberFormat.prototype.constructor 指回原生')
  if (idt.collatorProtoCtor !== true) idProblems.push('Collator.prototype.constructor 不一致')
  if (idt.rtcInstanceCtor !== true) idProblems.push('new RTCPeerConnection().constructor 不一致（可据此拿回未加固构造器）')
  if (idt.rtcProtoCtor !== true) idProblems.push('RTCPeerConnection.prototype.constructor 指回原生（可绕过 _guard）')
  if (idt.dtfName !== 'DateTimeFormat') idProblems.push('Intl.DateTimeFormat.name=' + idt.dtfName)
  if (idt.rtcName !== 'RTCPeerConnection') idProblems.push('RTCPeerConnection.name=' + idt.rtcName)
  add(
    'AC-08',
    '包装构造器身份自洽（X.prototype.constructor === X）',
    '全部 true / name 为原生名',
    { dtf: [idt.dtfInstanceCtor, idt.dtfProtoCtor, idt.dtfName], nf: [idt.nfInstanceCtor, idt.nfProtoCtor], rtc: [idt.rtcInstanceCtor, idt.rtcProtoCtor, idt.rtcName] },
    idProblems.length === 0,
    idProblems.join('；')
  )

  /* 9 —— WebGL */
  const glOk = d.webgl.vendor === fp.webgl.vendor && d.webgl.renderer === fp.webgl.renderer
  add(
    'AC-09',
    'WebGL vendor/renderer 与配置一致',
    fp.webgl.vendor + ' / ' + fp.webgl.renderer,
    d.webgl,
    glOk,
    glOk ? '' : '未伪装或伪装未生效，真实 GPU 型号直接外泄'
  )

  /* 10 —— WebRTC */
  const leaks = d.rtcCandidates.filter((ip) => typeof ip === 'string' && (ip.startsWith('THROW') || PRIVATE_IP.test(ip)))
  const rtcOk = fp.webrtc === 'real' ? true : leaks.length === 0
  add(
    'AC-10',
    'WebRTC 不泄漏内网/链路本地候选',
    fp.webrtc === 'real' ? 'real 模式不判定' : '无内网 IP、无 .local',
    d.rtcCandidates,
    rtcOk,
    rtcOk ? (d.rtcCandidates.length === 0 ? '本次未产出候选（无网络或无 ICE 服务器），条件断言未真正施压' : '') : '泄漏：' + leaks.join(', ')
  )

  /* 11 —— Electron 探测面（探针） */
  add(
    'AC-11',
    '[探针] Electron 特有探测面',
    '先采基线，不断死',
    d.electronSurface,
    null,
    'window.chrome 形状已补齐：自有属性 = app/csi/loadTimes 三个，与真实 Chrome 156 实测一致（细节见 AC-19）；' +
      'chrome.runtime 故意不加 —— 真实 Chrome 也没有，stub 它反而造出新的假红；' +
      'process/require/module 全 undefined，UA 不含 Electron；' +
      '剩下唯一的缺口是 toString 栈形状 = ' +
      d.toStringStack +
      '：这是**已接受的代价**（要检测方主动踩异常路径才看得到），不是待修项 —— ' +
      'Proxy 方案会把这条换成「fn.name 与 toString 名字矛盾」，那个被检查得更频繁，AC-15 已钉住。' +
      'EME 见 AC-19/AC-20。',
    { gate: false }
  )

  /* 19 —— window.chrome 的形状
     基线来自真实 Chrome 156.0.0.0 实测：getOwnPropertyNames(window.chrome) = ['app','csi','loadTimes']
     Electron 45.2.1 原生 = 0 个。所以这不是「可能有缺口」，是确定且可枚举的差额。
     为什么现在不 gate：注入侧还没实现，断死会长期红且没人能修 —— 与「探针先采基线」同一条口径。
     改成门禁的条件：把 { gate: false } 换成 { gate: true }，并在 injectFingerprint 里补三个 stub。
     stub 的硬要求：值必须从 performance.timing / performance.navigation 派生，不能写常量 ——
     常量跨页完全相同，本身就是比「缺 chrome.loadTimes」更容易被抓的指纹。
     chrome.runtime 不要补：真实 Chrome 也没有，补了就是新的假红。 */
  const CHROME_OWN = ['app', 'csi', 'loadTimes']
  const chromeOwn = Array.isArray(d.electronSurface.chromeOwn) ? d.electronSurface.chromeOwn : []
  const chromeOwnMissing = CHROME_OWN.filter((k) => !chromeOwn.includes(k))
  add(
    'AC-19',
    'window.chrome 自有属性 = 真实 Chrome 的 3 个',
    CHROME_OWN,
    { own: chromeOwn, missing: chromeOwnMissing },
    chromeOwnMissing.length === 0 && chromeOwn.length === CHROME_OWN.length,
    chromeOwn.length === 0
      ? '当前 0 个（Electron 原生即 0），真实 Chrome 156 是 3 个。'
      : '缺 ' + chromeOwnMissing.join(', ') + '（真实 Chrome 有这 3 个）',
    { gate: true }
  )

  /* 20 —— EME stage-1 行为
     先认一个错：本条第一版断言的是「两个符号必须存在」。实测两个符号本来就在
     （typeof navigator.requestMediaKeySystemAccess === 'function'、typeof window.MediaKeys === 'function'），
     所以那是个空断言 —— 和 AC-01/AC-02 完全同一个坑：断的是「本来就是真的东西」。

     真正的可观测点不是符号存在性，是 stage-1 的**行为**：
       真 Chrome 156：requestMediaKeySystemAccess('com.widevine.alpha') → resolve
                     紧接着 createMediaKeys() → reject NotSupportedError
       本仓库实测：    requestMediaKeySystemAccess 直接 reject NotSupportedError
     所以「播不了 Widevine」本身不是 tell（真 headless 也播不了，检测方不能因此判负），
     但「stage-1 就拒绝」是 —— 大多数检测方只做 stage-1（一行 await，不踩异常路径，成本极低）。

     修法不需要内核工作：stub 一个 resolved 的 access 对象（带 keySystem / getConfiguration），
     让 createMediaKeys() 抛 NotSupportedError，就与 headless Chrome 不可区分。
     改成门禁的条件：widevine 读数从 rejected:* 变成 available 后，把 gate 换成 true。 */
  const emeStage1 = d.electronSurface.widevine
  const emeGranted = emeStage1 === 'available'
  add(
    'AC-20',
    'EME stage-1 必须 resolve（能否播 Widevine 与判定无关）',
    'available',
    {
      stage1: emeStage1,
      requestMediaKeySystemAccess: d.electronSurface.emeRequest,
      MediaKeys: d.electronSurface.emeMediaKeys
    },
    emeGranted,
    emeGranted
      ? 'stage-1 resolve；stage-2（createMediaKeys）抛 NotSupportedError 是允许的 —— 真 headless Chrome 同样如此。'
      : '符号都在（都是 function），所以「符号缺失」这个方向不成立；缺的是 stage-1 行为：本处直接 ' +
        emeStage1 +
        '，而真 Chrome 156 在 stage-1 是 resolve 的、stage-2 才抛 NotSupportedError。' +
        '一行 await navigator.requestMediaKeySystemAccess("com.widevine.alpha") 就能分开两者。',
    { gate: true }
  )

  /* 13 —— 替换生效性（给 AC-01/AC-02 兜底）
     原生函数本来就返回 native、本来就没有 prototype，所以 AC-01/AC-02 在
     「注入完全没跑」时同样全绿 —— 那是空断言。这里证明函数确实被换掉了。

     【期望值必须来自另一条路径】
     早先这里用 `tzOffset()`（取本地时分秒 → 拼回 UTC → 相减）。而渲染层的实现
     也是「取本地时分秒 → 相减」。两条路径同源时，同一处 DST 逻辑漏掉会在两边
     同时出错，判据照样全绿 —— 判据变成了实现的复读机。
     现在改用 `tzOffsetByShortOffset()`：ICU 直接给的 `GMT±H[:MM]` 字符串，
     不做任何日期算术。两条路径只在「都对」的时候才一致。 */
  const b = d.behavior
  const evProblems = []
  const evNotes = []

  const AC13_INSTANT = new Date(Date.UTC(2026, 0, 15, 20, 0, 0))
  const short = tzOffsetByShortOffset(fp.timezone, AC13_INSTANT)
  const expectedOffset = short.offset
  // 实现侧读到的值（页面里 `new Date(...).getTimezoneOffset()`）—— 只做对比，不参与算期望
  const expectedOffsetArith = tzOffset(fp.timezone, AC13_INSTANT)
  if (expectedOffset === null) {
    evProblems.push('无法解析时区 ' + fp.timezone + '（shortOffset 原始值=' + JSON.stringify(short.raw) + '）')
  } else {
    if (b.date.offset !== expectedOffset) {
      evProblems.push(
        'getTimezoneOffset=' + b.date.offset + '，但 ' + fp.timezone + ' 在 ' + AC13_INSTANT.toISOString() +
          ' 应为 ' + expectedOffset + '（shortOffset=' + short.raw + '）'
      )
    }
    // 两条路径互相印证：不一致说明「期望值算法」本身有问题，先修判据再谈实现
    if (expectedOffsetArith !== null && expectedOffsetArith !== expectedOffset) {
      evProblems.push(
        '判据自身矛盾：shortOffset 给出 ' + expectedOffset + '（' + short.raw + '），' +
          '日期算术给出 ' + expectedOffsetArith + ' —— 两条独立路径不一致，先修判据'
      )
    }
    const expectedHour = (((20 - expectedOffset / 60) % 24) + 24) % 24
    if (b.date.hour !== expectedHour) {
      evProblems.push('getHours=' + b.date.hour + '，但 ' + fp.timezone + ' 应为 ' + expectedHour + '（Date 本地 getter 未平移）')
    }
  }

  if (fp.canvas === 'noise' && !(b.canvas.altered > 0)) {
    evProblems.push('canvas 配置为 noise，但纯白填充读回仍是纯 255 → getImageData 未被替换')
  } else if (fp.canvas === 'noise') {
    evNotes.push('canvas 噪声生效（' + b.canvas.altered + '/' + b.canvas.total + ' 像素被改动）')
  }

  if (fp.audio === 'noise' && !(b.audio.nonZero > 0)) {
    evProblems.push('audio 配置为 noise，但渲染静音读回全 0 → getChannelData 未被替换')
  } else if (fp.audio === 'noise') {
    evNotes.push('音频噪声生效（' + b.audio.nonZero + ' 个非零样本）')
  }

  if (fp.clientRectsNoise && !(b.rect.jitter > 1e-9)) {
    evProblems.push('clientRectsNoise 为 true，但整数尺寸元素量出的四个分量全是整数 → getBoundingClientRect 未被替换')
  } else if (fp.clientRectsNoise) {
    evNotes.push('clientRects 抖动生效（最大偏移 ' + b.rect.jitter + '）')
  }

  add(
    'AC-13',
    '替换生效性（否则 AC-01/AC-02 是空断言）',
    '时区平移 + 各噪声开关与配置一致',
    { date: b.date, expectedOffset, expectedFrom: 'shortOffset:' + String(short.raw), expectedArith: expectedOffsetArith, canvas: b.canvas, audio: b.audio, rect: b.rect },
    evProblems.length === 0,
    [evProblems.join('；'), evNotes.join('、')].filter(Boolean).join('  |  ')
  )

  /* 15 —— 函数身份自洽：fn.name 必须与 toString 里出现的名字一致
     这条专门挡「用 Proxy 包一层」这种看起来干净的迁移方案。实测（Node 22 / Chromium 同规范）：
       原生        Function.prototype.toString.call(Array.prototype.push) → function push() { [native code] }
       Proxy 之后  Function.prototype.toString.call(proxy)              → function () { [native code] }
     Proxy 没有 [[SourceText]]，toString 只能退回通用 NativeFunction 串，**名字丢了**，
     而 proxy.name 仍然是 "push" —— 名字对得上、源码对不上，本身就是一对矛盾。
     换句话说：Proxy 能消掉 has-own-frame，但会换来一个更常被检查的 tell。 */
  const nameMismatch = []
  for (const m of d.mask) {
    if (m.missing) continue
    const inSrc = /^function\s+(?:get\s+|set\s+)?([\w$]+)/.exec(m.src || '')
    const expected = String(m.fnName || '').replace(/^(get|set)\s+/, '')
    if (!inSrc) {
      nameMismatch.push(m.name + ':toString 里没有函数名（' + (m.src || '').slice(0, 40) + '）')
    } else if (inSrc[1] !== expected) {
      nameMismatch.push(m.name + ':name=' + m.fnName + ' 但 toString 里是 ' + inSrc[1])
    }
  }
  add(
    'AC-15',
    '函数身份自洽（fn.name 与 toString 内的名字一致）',
    '全部一致',
    nameMismatch.length ? nameMismatch : '全部一致',
    nameMismatch.length === 0,
    nameMismatch.length
      ? '名字与源码对不上，站点不需要任何参照值就能判定「这个函数被换过」'
      : ''
  )

  /* 16 —— Intl 构造器一致性
     包装清单靠手工维护，漏一个就是「有的 formatter 用伪 locale、有的用宿主 locale」——
     一次 resolvedOptions 对比就能看出来，而且不需要任何参照值。

     注意比较的是**语言子标签**不是完整 locale：ICU 对不同 API 的规范化不一致，
     实测 DateTimeFormat('en-US') 回 "en-US" 而 PluralRules('en-US') 回 "en"，
     按完整串比会把已包装的判成漏包装。真正的泄漏表现为语言不同（zh vs en）。 */
  const ic = d.intlConsistency
  const langOf = (s) => String(s || '').split('-')[0].toLowerCase()
  const intlProblems = []
  const intlNotes = []
  if (ic.error) {
    intlProblems.push('读数失败：' + ic.error)
  } else {
    const baseLang = langOf(ic.base.locale)
    for (const e of ic.entries) {
      if (e.error) {
        intlNotes.push(`${e.k}: 无法构造（${e.error}）`)
        continue
      }
      if (langOf(e.locale) !== baseLang) {
        intlProblems.push(`${e.k}: locale=${e.locale}（宿主语言）≠ ${ic.base.locale}（环境语言）`)
      } else if (e.locale !== ic.base.locale) {
        intlNotes.push(`${e.k}: locale=${e.locale}（语言相同，规范化差异）`)
      }
      if (e.timeZone && e.timeZone !== ic.base.timeZone) {
        intlProblems.push(`${e.k}: timeZone=${e.timeZone} ≠ ${ic.base.timeZone}`)
      }
    }
  }
  add(
    'AC-16',
    'Intl 全部构造器必须用同一套 locale/timeZone',
    '语言子标签与 timeZone 与 DateTimeFormat 相同',
    ic,
    intlProblems.length === 0,
    [intlProblems.join('；'), intlNotes.join('；')].filter(Boolean).join('  |  ') +
      (intlProblems.length
        ? '  ══ 诊断结论（推翻了「判据选错」这个假设）：两个漏点 hasSLO=true、hasRO=true、desc=data-writable，' +
          '也就是**它们满足 _IN 的筛选条件、属性也可写**，却仍然漏。' +
          '决定性读数：显式传 \'en-US\' 时两者都回 en-US（de-DE 也回 de-DE），说明构造器尊重 locale、' +
          '只是**包装器没有把 _lang 填进去** —— 即它们在注入时刻没有被接管，而不是接管了没效果。' +
          '所以「supportedLocalesOf 换成 resolvedOptions」这条修法**解决不了 AC-16**：两个判据在这两个构造器上取值相同。' +
          '  ══ 真正的矛盾：同一文档里 Date.prototype.toLocaleString 渲染 ' +
          JSON.stringify(d.pairs.dateToLocaleString) +
          '（环境语言），而 Intl.v8BreakIterator 同时报 ' +
          JSON.stringify((ic.entries.find((e) => e.k === 'v8BreakIterator') || {}).locale) +
          '（宿主 ICU 默认）。检测方两行、无需参照值即可判定被插桩。' +
          '  下一步该查的是「枚举时刻 vs 使用时刻的 Intl 形状是否一致」：' +
          '在注入前后各打一次 Object.getOwnPropertyNames(Intl) 与各自的 typeof supportedLocalesOf，' +
          '差异就是根因。单次早快照的枚举方式在这种「惰性安装」的构造器上天然不可靠。'
        : '')
  )

  /* 17 —— RTC 全局接口一致性

     【语义已变，别按旧理解读这条】
     早先 webrtc=disabled 的做法是 delete 掉一批 RTC 全局。方向是错的：
     注入只作用于 frame，Worker 里接口原样都在，于是「主世界 undefined、Worker 里 function」——
     真实 Chromium 的 WebRTC 是整特性开关，永远同真同假，这个组合不可能出现，等于自证。
     现在 disabled 不再删任何接口，只把候选全部丢弃（网络层本来也设了 disable_non_proxied_udp）。

     所以断言跟着改成：**接口必须全部存在**。
     - 少于 23 个 → 有人又开始删了，回到「删一半」的老问题，判红；
     - 一个都没有 → 整体删除，Worker 侧会立刻暴露矛盾，也判红。
     这条从「要么全在要么全不在」收紧成「必须全在」，是因为「全不在」已经不是合法状态了。 */
  const RTC_EXPECTED = 23
  const hasPeer = d.rtcGlobals.includes('RTCPeerConnection')
  const rtcConsistent = hasPeer && d.rtcGlobals.length === RTC_EXPECTED
  add(
    'AC-17',
    `RTC 全局接口必须全部存在（${RTC_EXPECTED} 个）—— 不再走删除路径`,
    `期望 ${RTC_EXPECTED} 个且含 RTCPeerConnection`,
    { count: d.rtcGlobals.length, hasPeer, list: d.rtcGlobals },
    rtcConsistent,
    rtcConsistent
      ? '接口全部保留，与 Worker 侧一致；候选由网络层 + 注入双层丢弃，泄漏面见 AC-10'
      : `接口数量或成员不符：实得 ${d.rtcGlobals.length} 个，hasPeer=${hasPeer}，列表 ${d.rtcGlobals.join(', ')}。` +
        '若是新增 Chromium 版本带来的接口，改 RTC_EXPECTED 并说明；若是被删，改回去 —— ' +
        '删除只作用于主世界，Worker 会立刻把这个矛盾暴露出来。' +
        '  |  边界：本条只覆盖主世界。Worker 侧的候选泄漏仍归 P0-2（AC-14），AC-17 通过 ≠ Worker 安全。'
  )

  /* 18 —— 成对读数一致性
     同一事实的两个 API 必须给出同一个答案。这类断言不依赖「我事先知道有哪些 API」，
     所以能抓到未来新增的漏点 —— 比逐个查覆盖率更抗变化。

     已知最容易漏的一对：`Intl.NumberFormat` 被换成了包装器，但
     `Number.prototype.toLocaleString` 内部构造的是 %Intl.NumberFormat% **内在对象**，
     不读全局属性，所以它继续用宿主 locale —— 和 resolvedOptions 直接矛盾。 */
  const pr = d.pairs
  const pairProblems = []
  const pairNotes = []
  // 期望值在 Node 侧算：如果只拿页面自己的两个 API 互相比，
  // 宿主 locale 与 profile locale 恰好同格式时会「一致地错」——那是假通过。
  let expectedNumber = null
  try {
    expectedNumber = new Intl.NumberFormat(fp.locale).format(1234.56)
  } catch (e) {
    pairProblems.push('无法用 ' + fp.locale + ' 计算期望格式：' + e.message)
  }
  if (pr.intlNumberError) {
    pairProblems.push('Intl.NumberFormat 读数失败：' + pr.intlNumberError)
  } else {
    if (expectedNumber !== null && pr.numberToLocaleString !== expectedNumber) {
      pairProblems.push(
        `Number.prototype.toLocaleString()="${pr.numberToLocaleString}"，但 ${fp.locale} 应为 "${expectedNumber}"`
      )
    }
    if (pr.numberToLocaleString !== pr.intlNumberFormat) {
      pairProblems.push(
        `toLocaleString="${pr.numberToLocaleString}" 与 Intl.NumberFormat().format()="${pr.intlNumberFormat}" 不一致`
      )
    }
    // 施压强度提示：profile locale 与英文数字格式相同的话，这条区分不出宿主
    try {
      if (expectedNumber === new Intl.NumberFormat('en-US').format(1234.56)) {
        pairNotes.push(
          `注意：${fp.locale} 与 en-US 的数字格式相同（都是 ${expectedNumber}），` +
            '若宿主也是英文系，本条无法区分「用了 profile locale」和「用了宿主 locale」—— 需要一个 de-DE/fr-FR 类 profile 才真正施压'
        )
      }
    } catch (e) {}
  }
  /* 18b —— 转发型出口（数组）
     数组的 toLocaleString 会把 locales/options 转给元素，所以它能同时暴露两种反向错误：
       · 漏：默认 locale 没接管 → 数组与元素自己走的不一致
       · 过接：显式 locale/options 被默认值盖掉 → 显式 'en-US' 也变成 profile locale
     过接比漏接更常见：`_withLoc` / `_withTz` 这类包装天然容易写成「无条件覆盖」。
     期望值同样在 Node 侧算，不拿页面自己的两个 API 互相比。 */
  if (!pr.intlNumberError) {
    if (pr.arrayToLocaleString !== pr.numberToLocaleString) {
      pairProblems.push(
        `[1234.56].toLocaleString()="${pr.arrayToLocaleString}"，但 (1234.56).toLocaleString()="${pr.numberToLocaleString}" —— 数组与元素的默认 locale 不一致`
      )
    }
    let enUS = null
    try {
      enUS = new Intl.NumberFormat('en-US').format(1234.56)
    } catch (e) {}
    if (enUS !== null && pr.arrayToLocaleStringEn !== enUS) {
      pairProblems.push(
        `[1234.56].toLocaleString('en-US')="${pr.arrayToLocaleStringEn}"，应为 "${enUS}" —— 显式 locale 被默认值盖掉了（过接）`
      )
    }
  }
  /* 18c —— 数字格式里唯一有区分度的两个样式。
     上面 numberToLocaleString 那几条在 zh-CN 宿主上恒绿（两种语言都渲染成 1,234.56），
     属于「测了等于没测」。currency / unit 是同一份数字在不同语言下渲染不同的样式，
     才真正能把「用了 profile locale」和「用了宿主 locale」分开。
     期望值仍在 Node 侧算，不用字面量。 */
  for (const [field, opt, label] of [
    ['currencyDefaultLocale', { style: 'currency', currency: 'USD' }, 'currency(USD)'],
    ['unitDefaultLocale', { style: 'unit', unit: 'kilometer' }, 'unit(kilometer)']
  ]) {
    let want = null
    try {
      want = new Intl.NumberFormat(fp.locale, opt).format(1234.56)
    } catch (e) {}
    if (want === null) continue
    /* 失败消息里额外打印「未接管时应该读到什么」。
       红的时候只看「实得 vs 应为」分不清两种原因：
         ICU/CLDR 变了   → 宿主值也会跟着变
         接管没生效      → 宿主值不变，只有实得等于宿主值
       多打一个数就能一眼分开，且**不改判据**——避免把「不等于宿主值」写成
       判据（那会让任何 CLDR 变更都被掩盖成绿）。 */
    let hostDefault = null
    try {
      hostDefault = new Intl.NumberFormat(undefined, opt).format(1234.56)
    } catch (e) {}
    const got = pr[field]
    if (got !== want) {
      pairProblems.push(
        `${label} 默认 locale 渲染 "${got}"，但 ${fp.locale} 应为 "${want}" —— 数字的默认 locale 没被接管` +
          (hostDefault === null
            ? ''
            : `（本进程默认 locale 的读数是 "${hostDefault}"：` +
              (hostDefault === got
                ? '实得与它相同 → 接管没生效，不是 ICU 变了'
                : '实得与它不同 → 接管生效了但结果不对，可能是 CLDR 数据差异') +
              '。注意这是一个**近似参照**：这里的默认 locale 来自 Node 进程，' +
              '页面宿主是 Electron 的默认 locale，两者不保证同一份 ICU —— ' +
              '若两者分叉，本条提示会指向「接管没生效」而真实原因是「ICU 不同」' +
              '）')
      )
    }
  }

  /* 这一条专抓 _withTz 的无条件覆盖：显式传 timeZone 必须被尊重。
     Pacific/Midway 与 profile 时区差得很远（UTC-11 vs 本地），所以两者不可能碰巧相同。 */
  let midway = null
  try {
    midway = new Date(0).toLocaleString('en-US', { timeZone: 'Pacific/Midway' })
  } catch (e) {}
  if (midway !== null && pr.arrayDateExplicitTz !== midway) {
    pairProblems.push(
      `[new Date(0)].toLocaleString('en-US',{timeZone:'Pacific/Midway'})="${pr.arrayDateExplicitTz}"，应为 "${midway}" —— 显式 timeZone 被 profile 时区覆盖了（过接）`
    )
  }

  add(
    'AC-18',
    '成对读数一致（Number 的 toLocaleString 必须与 profile locale 一致）',
    expectedNumber === null ? '两个 API 给出同一答案' : `"${expectedNumber}"（${fp.locale}）`,
    pr,
    pairProblems.length === 0,
    [pairProblems.join('；'), pairNotes.join('；')].filter(Boolean).join('  |  ')
  )

  /* 14 —— Worker 上下文（Page.addScriptToEvaluateOnNewDocument 不覆盖 Worker）
   *
   * 【这条从 probe 改成 gate 的理由】
   * 原来 pass=null、gate=false，即「永远不判红」。于是它无论读到多离谱的矛盾，
   * 门禁都是绿的 —— 一个只在报告里存在的缺口。改成 gate 之后，
   * 「Worker 里读得到宿主真值」这件事会直接把 CI 打红，修复才有推进力。
   *
   * 【判据为什么是「20 项全等」而不是「几项关键字段相等」】
   * 见 pageProbe 里的说明：ua/platform 是会话级副作用，cores/languages/tz 是最容易
   * 顺手对齐的三项。只比这几项，改三行就能让检查变绿而缺口依旧。
   * 20 项里包含六个 Intl 构造器、五个 Date 读数和两条 GPU 串 ——
   * 这些只能靠「真的把注入送进 Worker」才可能全等，没有捷径。
   */
  const HOST_OS_J = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'

  // 字段名必须与 pageProbe 里的 workerPairs、以及 blob worker 里 o.* 三处逐字对应。
  // 三处对不上会静默变成「比 undefined 和 undefined」—— 恒等，假绿。
  //
  // 第三列是**修复难度分组**，不是分类学：修的人需要一眼看出「B 组还红 = 原型取错了」，
  // 而不是笼统的「还有 N 条红」。三组的修法根本不同：
  //   A 走全局构造器（Intl / Date）—— 注入一旦进了 Worker 就会一起好；
  //   B 走 navigator 实例 —— 注入硬编码的是 `Navigator.prototype`，而 Worker 里是
  //     `WorkerNavigator.prototype`（规范上 Navigator 是 [Exposed=Window]），
  //     所以这组需要 Worker 专用分支去动态取原型，是最难的一组；
  //   C 走 canvas —— 需要 canvas hook 在 Worker 里生效（OffscreenCanvas* 上下文）。
  const WORKER_CORE = [
    ['cores', 'navigator.hardwareConcurrency', 'B'],
    ['memory', 'navigator.deviceMemory', 'B'],
    ['languages', 'navigator.languages', 'B'],
    ['language', 'navigator.language', 'B'],
    ['intlDTF', 'Intl.DateTimeFormat().locale', 'A'],
    ['intlNF', 'Intl.NumberFormat().locale', 'A'],
    ['intlCollator', 'Intl.Collator().locale', 'A'],
    ['intlPluralRules', 'Intl.PluralRules().locale', 'A'],
    ['intlRTF', 'Intl.RelativeTimeFormat().locale', 'A'],
    ['intlListFormat', 'Intl.ListFormat().locale', 'A'],
    ['tz', 'Intl…timeZone', 'A'],
    ['tzNameLong', 'timeZoneName:long', 'A'],
    // Date 五项一律是**三个采样点**的数组：[epoch, 2024-01-15T12:00Z, 2024-07-15T12:00Z]。
    // 只取 epoch 会被历史时区污染（Europe/London 1968–71 全年 BST）。
    ['dateOffsets', 'Date(3 点).getTimezoneOffset()', 'A'],
    ['dateHours', 'Date(3 点).getHours()', 'A'],
    ['dateString', 'Date(3 点).toString()', 'A'],
    ['dateToLocaleString', 'Date(3 点).toLocaleString()', 'A'],
    ['dateTZShort', 'toLocaleTimeString(short,3 点)', 'A'],
    ['glVendor', 'OffscreenCanvas VENDOR', 'C'],
    ['glRenderer', 'OffscreenCanvas RENDERER', 'C'],
    ['uaData', 'navigator.userAgentData', 'B']
  ]
  const GROUP_LABEL = {
    A: 'A 组 全局构造器（Intl 六个 locale + DTF timeZone/longTzName + Date 五项）',
    B: 'B 组 navigator 实例（cores/deviceMemory/languages/language/userAgentData + ref platform）',
    C: 'C 组 canvas（OffscreenCanvas WebGL vendor/renderer）'
  }
  // 参考项：这两项**恒等不算证据**（会话级 setUserAgent 本来就同时作用于 Worker），
  // 但一旦不等就是更严重的错，所以照样比、照样算失败，只是不占 20 项的名额。
  const WORKER_REF = [
    ['ua', 'navigator.userAgent'],
    ['platform', 'navigator.platform']
  ]

  // 结构化比较：languages 是数组、uaData 是对象，直接 !== 恒不等；
  // 用 JSON.stringify 又会被键序影响。所以自己规范化。
  const canon = (v) => {
    if (v === undefined) return '<undefined>'
    if (v === null) return 'null'
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
    if (typeof v === 'object') {
      return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
    }
    return JSON.stringify(v)
  }
  // 「采不到」：两侧都是 null/undefined/THROW/NOEXT/ERR。这种字段**不能算一致** ——
  // 它是「没测到」，把没测到记成通过，就是本仓库反复出现的假绿类型。
  //
  // 必须递归：Date 那五项现在是**三个采样点的数组**，若某个点上抛了，
  // 整项仍是数组 —— 只判顶层类型会把「三点里两点抛了」记成「有读数」。
  // `NOEXT`（WebGL debug 扩展缺失）同理：两侧都是 NOEXT 时 `===` 成立，
  // 但那条「一致」证明的是「两边都没有扩展」，不是「两边都没有 GPU」。
  const unmeasurable = (v) => {
    if (v === null || v === undefined) return true
    if (typeof v === 'string') return v.startsWith('THROW') || v === 'NOEXT' || v.startsWith('ERR:')
    if (Array.isArray(v)) return v.length === 0 || v.every(unmeasurable)
    if (typeof v === 'object') {
      const vals = Object.keys(v).map((k) => v[k])
      return vals.length === 0 || vals.every(unmeasurable)
    }
    return false
  }

  // 一轮 = 一个 profile 的一次采集。判据对每一轮独立算，AC-14 要求**所有轮都通过**。
  const evalWorkerRound = (run) => {
    const dd = (run && run.data) || {}
    const wv = dd.worker
    const mp = dd.workerPairs || {}
    const fpOf = (run && run.profile && run.profile.fingerprint) || {}
    const res = {
      label: run && run.profile ? run.profile.name : '?',
      platform: run && run.profile ? run.profile.platform : '?',
      mismatch: 0,
      refMismatch: 0,
      unmeasured: [],
      fields: {},
      groups: { A: { total: 0, mismatch: 0 }, B: { total: 0, mismatch: 0 }, C: { total: 0, mismatch: 0 } },
      fatal: null,
      ref: { timezone: null, locale: null, cores: null },
      diag: null
    }
    if (!wv || wv.error || wv.timeout) {
      res.fatal = 'Worker 探针失败：' + JSON.stringify(wv)
      return res
    }
    for (const [k, label, g] of WORKER_CORE) {
      res.groups[g].total++
      const a = mp[k]
      const b = wv[k]
      if (unmeasurable(a) && unmeasurable(b)) {
        res.unmeasured.push(`${k}（${label}）两侧都采不到：主世界=${canon(a)} Worker=${canon(b)}`)
        res.fields[k] = { status: 'unmeasured', group: g, main: a, worker: b, label }
        continue
      }
      if (canon(a) !== canon(b)) {
        res.mismatch++
        res.groups[g].mismatch++
        res.fields[k] = { status: 'mismatch', group: g, main: a, worker: b, label }
      }
    }
    for (const [k, label] of WORKER_REF) {
      if (canon(mp[k]) !== canon(wv[k])) {
        res.refMismatch++
        res.fields[k] = { status: 'mismatch-ref', group: 'B', main: mp[k], worker: wv[k], label }
      }
    }

    /* ── 参考值子判据 ────────────────────────────────────────────────────
     *
     * 上面 20 项证明的是「主世界 == Worker」。两边一样有两种成因：
     *   1) 注入真的进了 Worker（好）；
     *   2) **两边都没生效**（坏）—— 这时 20 项依然全等，全是假绿。
     * 所以还必须和 **profile 配置**比一次，而且期望值必须**现算**：
     * 写死 `America/New_York` 之类会在 profile 换时区时给出假红，
     * 而「现算」不能复用渲染层那套算术（否则判据变成实现的复读机）——
     * 用 `tzOffsetByShortOffset()` 这条独立路径。
     */
    const instants =
      Array.isArray(dd.workerInstants) && dd.workerInstants.length
        ? dd.workerInstants
        : [0, Date.UTC(2024, 0, 15, 12, 0, 0), Date.UTC(2024, 6, 15, 12, 0, 0)]
    const tzCfg = typeof fpOf.timezone === 'string' && fpOf.timezone ? fpOf.timezone : null
    const tzRef = {
      cfg: tzCfg,
      points: [],
      power: false,
      powerWhy: '',
      mismatch: 0,
      unmeasured: 0,
      halfGuard: null,
      problems: []
    }
    for (let i = 0; i < instants.length; i++) {
      const t = instants[i]
      const d0 = new Date(t)
      const ref = tzCfg ? tzOffsetByShortOffset(tzCfg, d0) : { offset: null, raw: null }
      tzRef.points.push({
        at: d0.toISOString(),
        // 期望值：profile 配置 + 独立路径现算。**不是**字面量，也不是实现的算术。
        ref: ref.offset,
        refRaw: ref.raw,
        // 宿主侧同一点的真实偏移：用来判「这条判据有没有鉴别力」
        host: d0.getTimezoneOffset(),
        main: Array.isArray(mp.dateOffsets) ? mp.dateOffsets[i] : undefined,
        worker: Array.isArray(wv.dateOffsets) ? wv.dateOffsets[i] : undefined
      })
    }
    if (!tzCfg) {
      tzRef.unmeasured++
      tzRef.problems.push('profile 没有 timezone 配置，无法现算期望偏移 —— 标为「没测到」，不算通过')
    } else {
      const pwTz = powerCheck(
        'timezone',
        tzRef.points.map((p) => p.host),
        tzRef.points.map((p) => p.ref),
        (hosts, refs) => refs.filter((r, i) => r !== null && Math.abs(r - hosts[i]) >= 60).length >= 2,
        '三个采样点里不足两点与宿主偏移相差 ≥60 分钟'
      )
      tzRef.power = pwTz.power
      tzRef.powerWhy = pwTz.why
      if (!pwTz.power) {
        tzRef.unmeasured++
        tzRef.problems.push(pwTz.why)
      } else {
        for (const p of tzRef.points) {
          if (p.ref === null) {
            tzRef.unmeasured++
            tzRef.problems.push(`无法现算 ${tzCfg} 在 ${p.at} 的偏移（shortOffset=${JSON.stringify(p.refRaw)}）`)
            continue
          }
          if (p.main !== p.ref) {
            tzRef.mismatch++
            tzRef.problems.push(
              `${p.at}: 主世界 getTimezoneOffset=${JSON.stringify(p.main)}，` +
                `但 ${tzCfg} 应为 ${p.ref}（shortOffset=${p.refRaw}，宿主=${p.host}）`
            )
          }
        }
        /* 「半成功护栏」—— 名字就说清楚了它挡的是什么：
         * 注入只加了一个**固定位移**（把 epoch 的偏移硬套到所有时刻）时，
         * 单点比较会通过，但三个采样点上「偏移随季节变化」这件事复现不出来。
         * 只有 profile 时区在三个点上真有 ≥2 个不同偏移（即真有 DST）时这条才有鉴别力；
         * 没有 DST 的时区（Asia/Shanghai 等）上它无鉴别力 —— **标记并跳过，不算通过**。 */
        const refVals = tzRef.points.map((p) => p.ref).filter((v) => typeof v === 'number')
        const distinctRef = new Set(refVals).size
        const mainVals = tzRef.points.map((p) => p.main).filter((v) => typeof v === 'number')
        const distinctMain = new Set(mainVals).size
        if (distinctRef >= 2) {
          tzRef.halfGuard = {
            required: true,
            distinctRef,
            distinctMain,
            ok: distinctMain >= 2,
            why:
              distinctMain >= 2
                ? `profile 时区在三个采样点上有 ${distinctRef} 个不同偏移，主世界复现了 ${distinctMain} 个 —— 不是固定位移`
                : `profile 时区在三个采样点上有 ${distinctRef} 个不同偏移，但主世界只给出 ${distinctMain} 个 —— ` +
                  '注入像是「固定位移」而不是按真实规则换算（半成功）'
          }
        } else {
          tzRef.halfGuard = {
            required: false,
            distinctRef,
            distinctMain,
            ok: null,
            why: `profile 时区（${tzCfg}）在三个采样点上只有 ${distinctRef} 个偏移（无 DST）—— 这条护栏在本轮无鉴别力，标为跳过，不算通过`
          }
        }
      }
    }

    /* locale：`new Date(0).toLocaleDateString()` 的**输出语言**必须来自 profile。
     *
     * 为什么这条必须单列：`Intl.DateTimeFormat().resolvedOptions().locale` 是**自报**的，
     * 包装器可以原样返回配置值而实际格式化仍走宿主 ICU。日期串是**行为证据**。
     * 为什么必须做鉴别力断言：宿主 en-US + profile en-US 时，无论注入有没有生效，
     * 输出都是 "1/1/1970" —— 恒绿。这种时候必须标「没测到」而不是记通过。
     *
     * 【为什么期望值是「一组」而不是「一个」】
     * 实现里 `toLocale*` 会带上 profile 的 locale **和 timeZone**。于是同一个 epoch，
     * 渲染出的**日期**可能差一天（America/Los_Angeles 的 epoch 本地时间是 1969-12-31）。
     * 若只算一个期望值，这条会因为「差一天」判红 —— 而那与时区判据是两回事。
     * 所以接受两种解释（不指定 tz / 指定 profile tz），只要命中其中之一就说明
     * **语言**确实来自 profile。日期值本身由时区判据负责，不在这里重复判。
     */
    const cfgLang =
      Array.isArray(fpOf.languages) && fpOf.languages.length
        ? fpOf.languages[0]
        : typeof fpOf.locale === 'string' && fpOf.locale
          ? fpOf.locale
          : null
    const cfgTz = typeof fpOf.timezone === 'string' && fpOf.timezone ? fpOf.timezone : null
    const hostLang = (() => {
      try {
        return new Intl.DateTimeFormat().resolvedOptions().locale
      } catch (e) {
        return null
      }
    })()
    const dateFmt = (lang, tz, t) => {
      if (!lang) return null
      try {
        const o = { year: 'numeric', month: 'numeric', day: 'numeric' }
        if (tz) o.timeZone = tz
        return new Intl.DateTimeFormat(lang, o).format(new Date(t))
      } catch (e) {
        return null
      }
    }
    const locRef = { cfg: cfgLang, cfgTz, hostLang, points: [], power: false, ok: null, why: '' }
    if (!cfgLang) {
      locRef.why = 'profile 没有 languages/locale 配置 —— 标为「没测到」，不算通过'
    } else {
      for (let i = 0; i < instants.length; i++) {
        const t = instants[i]
        const want = [dateFmt(cfgLang, null, t), cfgTz ? dateFmt(cfgLang, cfgTz, t) : null].filter((v) => v !== null)
        const hostWant = [dateFmt(hostLang, null, t), cfgTz ? dateFmt(hostLang, cfgTz, t) : null].filter((v) => v !== null)
        const main = Array.isArray(mp.dateLocaleDate) ? mp.dateLocaleDate[i] : undefined
        // 鉴别力：期望值集合与「宿主语言会给出的集合」完全不相交，才说明这条能区分
        const power = want.length > 0 && hostWant.length > 0 && want.every((w) => !hostWant.includes(w))
        locRef.points.push({ at: new Date(t).toISOString(), want, hostWant, main, power, ok: power ? want.includes(main) : null })
      }
      const powered = locRef.points.filter((p) => p.power)
      locRef.power = powered.length > 0
      if (!locRef.power) {
        locRef.why =
          `宿主语言（${String(hostLang)}）与 profile 语言（${cfgLang}）渲染出的日期串完全相同` +
          `（都是 ${JSON.stringify(locRef.points[0] ? locRef.points[0].hostWant : null)}）—— ` +
          '这条在本次环境里无鉴别力，标为「没测到」，不算通过'
      } else {
        const bad = powered.filter((p) => p.ok !== true)
        locRef.ok = bad.length === 0
        locRef.why = locRef.ok
          ? ''
          : bad
              .map(
                (p) =>
                  `${p.at}: toLocaleDateString()=${JSON.stringify(p.main)}，` +
                  `但 ${cfgLang} 应为 ${JSON.stringify(p.want)}（宿主 ${String(hostLang)} 会给 ${JSON.stringify(p.hostWant)}）`
              )
              .join('；')
      }
    }
    res.ref.locale = locRef

    /* cores：宿主机核数必须与 profile 配置不同，否则「读到 12 核」不代表注入生效。
     * 这里**只判主世界**。Worker 侧是否等于配置由上面 20 项里的 cores 负责 ——
     * 两边都判会把同一条矛盾数两遍，而且会让「参考值」这一层失去独立含义：
     * 参考值回答的是「主世界到底有没有注入」，不是「Worker 有没有」。 */
    const hostCores = (cpus() || []).length
    const cfgCores = fpOf.hardware && typeof fpOf.hardware.cpuCores === 'number' ? fpOf.hardware.cpuCores : null
    const pwCores = powerCheck('cores', hostCores, cfgCores, (a, b) => a !== b, '宿主机核数与 profile 配置相同')
    res.ref.cores = {
      cfg: cfgCores,
      host: hostCores,
      main: mp.cores,
      worker: wv.cores,
      power: pwCores.power,
      ok: pwCores.power ? mp.cores === cfgCores : null,
      why: pwCores.power
        ? mp.cores === cfgCores
          ? ''
          : `主世界 hardwareConcurrency=${JSON.stringify(mp.cores)}，但 profile 配置 ${cfgCores}（宿主 ${hostCores}）`
        : pwCores.why
    }
    res.ref.timezone = tzRef

    /* 派生 diag —— 替代页面里的 `__SS_DIAG__`。
     *
     * 为什么不读全局：`fingerprint.ts` 明确写了「一个全局都不留」，理由是那个全局
     * 会原样进构建产物、等于自己给检测方留一个「哪些 Intl 被接管过」的标记；
     * `tests/structure.test.ts` 也断言 `out/main/index.js` 里不得出现 `__SS_DIAG__`。
     * 所以这里**由读数反推**同样的四元组。反推比自报更可信：自报的 diag 可以过期。
     *
     *   applied=全部、failed=[]      → 注入生效
     *   0<applied<declared           → **打了又回滚**（整体回滚会退回宿主值）
     *   applied=0                    → 根本没注入（或全量回滚）
     * 这三种红的修法完全不同，所以必须分开报。
     */
    const verifiable = [
      ['cores', cfgCores, hostCores],
      // deviceMemory 按规范被**钳到 8**：配置 16GB 时页面读到 8 是正确行为。
      // 不钳的话这里会把「正确」记成「failed: memory」，diag 就会误报 rolled-back ——
      // 一条派生指标自己算错，会把所有红的定性都带偏。
      [
        'memory',
        fpOf.hardware && typeof fpOf.hardware.memoryGB === 'number' ? Math.min(fpOf.hardware.memoryGB, 8) : null,
        null
      ],
      ['language', cfgLang, null],
      ['languages', Array.isArray(fpOf.languages) ? fpOf.languages : null, null],
      ['tz', tzCfg, null],
      ['dateOffsets', tzRef.points.every((p) => typeof p.ref === 'number') ? tzRef.points.map((p) => p.ref) : null, null]
    ].filter(([, want]) => want !== null && want !== undefined)
    const appliedList = []
    const failedList = []
    for (const [k, want] of verifiable) {
      const got = mp[k]
      if (canon(got) === canon(want)) appliedList.push(k)
      else failedList.push({ p: k, want, got })
    }
    res.diag = {
      source: 'derived（页面内不留全局，见 src/main/core/fingerprint.ts 注释 + tests/structure.test.ts 断言）',
      declared: verifiable.length,
      applied: appliedList.length,
      appliedList,
      failed: failedList,
      // rolledBack：有生效的、也有没生效的 —— 整体回滚的典型形态
      rolledBack: appliedList.length > 0 && failedList.length > 0,
      verdict:
        appliedList.length === 0
          ? 'not-injected（全部退回宿主值：注入没跑，或整体回滚）'
          : failedList.length === 0
            ? 'applied（全部与 profile 配置一致）'
            : 'partial/rolled-back（部分生效、部分退回宿主值）'
    }
    return res
  }

  const allRuns = Array.isArray(runs) && runs.length ? runs : [{ profile: { name: '?', platform: '?' }, data: d }]
  const evaluated = allRuns.map(evalWorkerRound)
  const primary = evaluated[0]
  /* 一轮的「参考值子判据」是否通过。
   * 三种结局必须分开：pass / mismatch / unmeasured（无鉴别力）。
   * `unmeasured` **不算通过** —— 这是本脚本里最容易写错的一行：
   * 写成 `!== false` 就等于把「没测」记成「没问题」。 */
  const refVerdict = (r) => {
    const tz = r.ref.timezone
    const loc = r.ref.locale
    const co = r.ref.cores
    const problems = []
    const unmeasured = []
    if (!tz) return { ok: false, problems: ['时区子判据缺失'], unmeasured: ['timezone'] }
    if (tz.unmeasured > 0) unmeasured.push('timezone')
    if (tz.mismatch > 0) problems.push('timezone')
    if (tz.halfGuard && tz.halfGuard.required && tz.halfGuard.ok === false) problems.push('timezone(half-guard)')
    if (loc.power === false || loc.ok === null) unmeasured.push('locale')
    else if (loc.ok === false) problems.push('locale')
    if (co.power === false || co.ok === null) unmeasured.push('cores')
    else if (co.ok === false) problems.push('cores')
    return { ok: problems.length === 0 && unmeasured.length === 0, problems, unmeasured }
  }
  const okAll = evaluated.every(
    (r) =>
      !r.fatal &&
      r.mismatch === 0 &&
      r.refMismatch === 0 &&
      r.unmeasured.length === 0 &&
      refVerdict(r).ok === true
  )
  /* 跨 OS 条件必须成立，否则这条等于没测。
   *
   * 宿主 Windows + Windows profile 时，`navigator.platform` 两侧都是 Win32 ——
   * 那个「一致」是宿主与 profile 同 OS 的巧合，不是注入生效。而 platform 恰好是
   * 最容易被当成「已经修好了」的字段。所以判据里必须有「至少有一轮 profile 与宿主不同 OS」。 */
  const crossOsOk = primary.platform !== '?' && primary.platform !== HOST_OS_J

  /* ── AC-14 的三态 ────────────────────────────────────────────────────
   *
   * 三态的边界（口径问题，不是排版问题）：
   *   PASS  = 测了，成立
   *   FAIL  = 测了，不成立
   *   SKIP  = **没测到**（不是「测了但不成立」，也不是「不适用」）
   *
   * 本条现在有两个半边，必须分开判：
   *   - **页面侧**：主世界读数 vs profile 配置（时区三点 / locale 输出语言 / cores）
   *     + 至少一轮跨 OS。这一侧有读数，所以 PASS/FAIL 都是真的。
   *   - **Worker 侧**：主世界 vs Worker 的 20 项。Worker 注入开关当前停用时，
   *     Worker 读到的是宿主值 —— 那不是「断言不成立」，是**这一侧根本没测到**：
   *     我们没有把注入送进去，所以不知道送进去之后会不会一致。
   *
   * 为什么不能判 FAIL：判 FAIL 会把「未测量」混进「不成立」，读的人会去查实现，
   * 而真正该做的是把开关打开。为什么不能判 PASS：那是拿页面侧的成功掩盖 Worker 侧的空白。
   * 为什么不从分母里去掉：`19/19 通过` 与 `19/20 通过` 在 CI 日志里长得一样，
   * 但前者把「少测一项」伪装成了「全测了、过了 19」。
   *
   * 开关值**从源码读**，不写死：写死的话开关一翻，这段 note 会开始说谎。
   * 开关翻成 true 之后本条自动回到硬门禁（PASS/FAIL），不需要再改这里。
   */
  const workerFlag = (() => {
    try {
      const src = readFileSync(join(ROOT, 'src/main/core/windows.ts'), 'utf8')
      const m = /WORKER_INJECTION_ENABLED\s*=\s*(true|false)/.exec(src)
      if (m) return m[1]
      return '（未找到）'
    } catch (e) {
      return '（读取失败：' + String((e && e.message) || e) + '）'
    }
  })()
  const workerDisabled = workerFlag === 'false'
  // 页面侧：只看「主世界 vs profile 配置」那三条参考值 + 跨 OS。
  // 20 项主世界/Worker 对比属于 Worker 侧，不参与这里。
  const pageOkAll = crossOsOk && evaluated.every((r) => refVerdict(r).ok === true)
  const pageSide = pageOkAll ? 'PASS' : 'FAIL'
  const workerSide = workerDisabled ? '未测量（停用）' : okAll ? 'PASS' : 'FAIL'

  let ac14Pass = null
  let ac14Unmeasured = false
  if (!pageOkAll) {
    // 页面侧就不成立 —— 这是真失败，与 Worker 开关无关，必须红
    ac14Pass = false
  } else if (workerDisabled) {
    ac14Pass = null
    ac14Unmeasured = true
  } else {
    ac14Pass = okAll
  }

  const workerNote = []
  const pv = refVerdict(primary)
  // 「没测到」和「测到了但矛盾」必须能分开读 —— 这两种红的修法完全不同。
  if (pv.unmeasured.length) {
    workerNote.push(
      '【本条没测到】参考值子判据里有 ' + pv.unmeasured.join('、') + ' 项**无鉴别力或采不到**：' +
        '它们在本环境里无论注入有没有生效都会给出同一个结果，所以不能算通过。' +
        'AC-14 因此记「没测到」，不是「通过」也不是「实现有 bug」。'
    )
  }
  if (ctx.localeRoundNote) workerNote.push('locale 轮次：' + ctx.localeRoundNote)
  if (primary.fatal) {
    workerNote.push('Worker 探针本身失败，这条判红而不是「只记录」。先修探针再谈注入：' + primary.fatal)
  } else if (!crossOsOk) {
    workerNote.push(
      '【本条没测到】所有轮次的 profile 都与宿主同 OS（' + HOST_OS_J + '），' +
        '`navigator.platform` 的「一致」可能只是宿主巧合 —— 这不能算通过。' +
        '需要至少一个跨 OS profile（例如宿主 Windows 时用 macOS profile）。'
    )
  } else {
    // 注入到没到位：先给结论，再给逐项 —— 反推的 diag 决定「这红该怎么修」
    if (primary.diag) {
      workerNote.push(
        `注入台账（由读数反推，非页面自报）：${primary.diag.verdict} —— ` +
          `applied ${primary.diag.applied}/${primary.diag.declared}` +
          (primary.diag.failed.length
            ? '，failed: ' + primary.diag.failed.map((f) => f.p).join(', ')
            : '') +
          (primary.diag.rolledBack
            ? '。**部分生效 = 打了又回滚**，与「完全没注入」是两种不同的红：前者的修法是查注入脚本在哪个属性上抛错，后者是查注入有没有送到这个上下文。'
            : '')
      )
    }
    workerNote.push(
      (workerDisabled ? '【Worker 侧未测量】' : '【测到了，确实矛盾】') +
        `跨 OS 轮「${primary.label}」（profile=${primary.platform}，宿主=${HOST_OS_J}）` +
        `有 ${primary.mismatch} 项与主世界不一致：` +
        (workerDisabled
          ? 'Worker 里读到的是**宿主真值**（因为注入没有投递进去，不是注入写错了）。'
          : '这些字段在 Worker 里报的是**宿主真值**，一段 `new Worker(blob)` 就能同时拿到两套并判定伪装。')
    )
    // 按修复难度分组 —— 这是给修的人看的，不是分类学
    for (const g of ['A', 'B', 'C']) {
      const s = primary.groups[g]
      workerNote.push(`${GROUP_LABEL[g]}：${s.mismatch}/${s.total} 矛盾`)
    }
    workerNote.push(
      'B 组还红 = 注入把原型写死成了 `Navigator.prototype`，而 Worker 里是 `WorkerNavigator.prototype`' +
        '（Navigator 是 [Exposed=Window]），需要 Worker 专用分支动态取原型；' +
        'A/C 组还红 = 全局构造器 / canvas hook 在 Worker 里没生效。'
    )
    for (const [k, v] of Object.entries(primary.fields)) {
      if (v.status === 'unmeasured') continue
      workerNote.push(`· [${v.group}] ${k}(${v.label}): 主世界 ${canon(v.main)} ≠ Worker ${canon(v.worker)}`)
    }
    if (primary.unmeasured.length) {
      workerNote.push(`另有 ${primary.unmeasured.length} 项两侧都采不到（不计入矛盾，但也不算一致）：`)
      for (const line of primary.unmeasured) workerNote.push('· ' + line)
    }

    /* 参考值子判据的逐条结论 —— 这一段回答的是「20 项全等是不是假绿」。
     * 没有这一段，20 项全等既可能是「注入进了 Worker」，也可能是「两边都没注入」。 */
    const tz = primary.ref.timezone
    if (tz) {
      workerNote.push(
        `时区参考值（profile=${String(tz.cfg)}，期望值用 shortOffset 独立现算，三点采样）：` +
          tz.points.map((p) => `${p.at} 应为 ${String(p.ref)}(${String(p.refRaw)}) 实得 ${String(p.main)}`).join('；') +
          (tz.power ? '（有鉴别力：≥2 点与宿主相差 ≥60 分钟）' : '（**无鉴别力**，见下）')
      )
      for (const p of tz.problems) workerNote.push('· ' + p)
      if (tz.halfGuard) workerNote.push('· 半成功护栏：' + tz.halfGuard.why)
    }
    const loc = primary.ref.locale
    if (loc) {
      workerNote.push(
        `locale 行为证据（toLocaleDateString 输出语言）：profile=${String(loc.cfg)}，宿主=${String(loc.hostLang)}` +
          (loc.power
            ? '（有鉴别力）'
            : ' —— **无鉴别力**：宿主与 profile 语言渲染完全相同，这条在本次环境里证明不了任何事')
      )
      for (const p of loc.points || []) {
        workerNote.push(
          `· ${p.at}: 实得 ${JSON.stringify(p.main)}，期望 ${JSON.stringify(p.want)}，宿主会给 ${JSON.stringify(p.hostWant)}` +
            (p.power ? '' : '（此点无鉴别力，跳过）')
        )
      }
      if (loc.why) workerNote.push('· ' + loc.why)
    }
    const co = primary.ref.cores
    if (co) {
      workerNote.push(
        `cores 参考值：profile=${String(co.cfg)}，宿主=${String(co.host)}，主世界=${String(co.main)}，Worker=${String(co.worker)}` +
          (co.power ? '' : ' —— **无鉴别力**：宿主核数与配置相同')
      )
      if (co.why) workerNote.push('· ' + co.why)
    }

    // 其余轮次：同 OS 轮里「一致」正是巧合的证据，单独列出来免得被误读成修好了。
    // 但**不能一律写成「与宿主同 OS」** —— 第三轮（locale 轮）通常也是跨 OS 的，
    // 把它的 platform 矛盾也说成「巧合」会直接误导修的人。
    for (const r of evaluated.slice(1)) {
      const sameOs = r.platform === HOST_OS_J
      const verdictOf = (k) =>
        r.fields[k]
          ? `矛盾（主世界 ${canon(r.fields[k].main)} / Worker ${canon(r.fields[k].worker)}）`
          : '一致'
      workerNote.push(
        `其余轮「${r.label}」（profile=${r.platform}，${sameOs ? '与宿主同 OS' : '跨 OS'}）：${r.mismatch} 项矛盾，其中 ` +
          `platform ${verdictOf('platform')}、ua ${verdictOf('ua')}、userAgentData ${verdictOf('uaData')}、` +
          `locale 参考值 ${r.ref.locale && r.ref.locale.power ? (r.ref.locale.ok ? '通过' : '矛盾') : '无鉴别力'}。` +
          (sameOs
            ? '这一轮里 platform / userAgentData 的「一致」是宿主与 profile 同 OS 的巧合，' +
              '**不构成注入生效的证据** —— 所以 AC-14 必须用跨 OS 轮判。'
            : '这一轮也是跨 OS 的，它的读数与主判轮互相印证，不是巧合。')
      )
    }
    workerNote.push(
      '修法：Target.setAutoAttach({autoAttach:true, waitForDebuggerOnStart:true}) 递归到 Worker 目标，' +
        '对每个 worker target 也下 Page.addScriptToEvaluateOnNewDocument（或 Runtime.evaluate 前置注入），' +
        '而不是只对页面目标下。'
    )
  }
  workerNote.push(
    '  |  边界：本条只覆盖「主世界 vs Worker」。WebRTC 候选过滤（_keep）同样只在 frame 里执行，' +
      'Worker 里照旧 —— 一次 new Worker(blob) 就能比出来。AC-10 / AC-17 覆盖的都只是主世界。'
  )
  /* ── AC-14 的三态判据已在上方算好 ──
   * workerDisabled 时 note 的措辞必须跟着改：说「测到了，确实矛盾」是错的 ——
   * 这一侧没有读数。把未测量写成矛盾，等于用一句更狠的话掩盖「没测」。 */
  const workerSideNote =
    '三态：**页面侧 ' + pageSide + '；Worker 侧 ' + workerSide + '**' +
    (workerDisabled
      ? '（worker 注入停用，见 src/main/core/windows.ts 的 WORKER_INJECTION_ENABLED=' + workerFlag + '）'
      : '')
  const workerFailReason = workerDisabled
    ? '原因：worker 注入开关当前为 ' + workerFlag + '；该分支被有意停用，' +
      '所以 Worker 读到的是宿主值，与主世界矛盾 —— 站点一次 new Worker(blob) 就能判定插桩。' +
      '但这一侧这次确实没有读数，所以记「未测量」而不是「不成立」。开关翻 true 后本条自动变回硬门禁。' +
      '（历史：曾因「暂停态 × 建 GL context」崩溃而停用，已由「不建 context、只装 prototype」修掉；' +
      '根因与对照实验见 src/main/core/windows.ts 的 WORKER_INJECTION_ENABLED 注释。）'
    : ''

  add(
    'AC-14',
    'Worker 上下文必须与主世界一致（20 项 + 3 项参考值，跨 OS profile）',
    '20 项主世界/Worker 全等，且时区三点参考值、locale 输出语言、cores 参考值都**有鉴别力并成立**；至少一轮跨 OS',
    {
      total: WORKER_CORE.length,
      ref: WORKER_REF.length,
      rounds: evaluated.map((r) => ({
        label: r.label,
        platform: r.platform,
        mismatch: r.mismatch,
        refMismatch: r.refMismatch,
        unmeasured: r.unmeasured.length,
        groups: r.groups,
        refVerdict: refVerdict(r),
        diag: r.diag
          ? { verdict: r.diag.verdict, applied: r.diag.applied, declared: r.diag.declared, rolledBack: r.diag.rolledBack, failed: r.diag.failed.map((f) => f.p) }
          : null
      })),
      crossOs: crossOsOk,
      hostOs: HOST_OS_J,
      mismatch: primary.mismatch,
      refMismatch: primary.refMismatch,
      unmeasured: primary.unmeasured.length,
      groups: primary.groups,
      // 参考值子判据：这三项是「20 项全等是不是假绿」的唯一防线
      refChecks: {
        timezone: primary.ref.timezone
          ? {
              cfg: primary.ref.timezone.cfg,
              power: primary.ref.timezone.power,
              powerWhy: primary.ref.timezone.powerWhy,
              mismatch: primary.ref.timezone.mismatch,
              unmeasured: primary.ref.timezone.unmeasured,
              halfGuard: primary.ref.timezone.halfGuard,
              points: primary.ref.timezone.points
            }
          : null,
        locale: primary.ref.locale,
        cores: primary.ref.cores
      },
      diag: primary.diag,
      fields: primary.fields,
      // 三态拆开落在 payload 里，别只写进 note —— 事后查 artifacts 的人
      // 也需要能直接读出「哪一侧没测」，而不是去 grep 一段中文
      threeState: {
        pageSide,
        workerSide,
        workerInjectionEnabled: workerDisabled ? false : workerFlag === 'true' ? true : null,
        workerFlagRaw: workerFlag
      }
    },
    ac14Pass,
    [workerSideNote, workerFailReason, workerNote.join('\n       ↳ ')].filter(Boolean).join('\n       ↳ '),
    { gate: true, group: 'P0 子目标注入', unmeasured: ac14Unmeasured }
  )

  /* 21 —— 跨站 iframe（OOPIF）的注入覆盖
   *
   * 这条是本脚本里唯一一个「站在子帧视角」的检查。其余 20 条都在主世界跑，
   * 所以它们全绿也说明不了「父页里嵌进来的第三方 iframe 看到的是伪装值」——
   * 而广告位、支付组件、验证码正是这么嵌进来的。
   *
   * 判据分三层，缺一层都会变成假绿：
   *   1) 子帧必须真的跨站（contentWindow 访问必须抛）—— 否则测的是同源 iframe，无效；
   *   2) 子帧读数必须真的采到（postMessage 回传）—— 采不到不算一致，算失败；
   *   3) 8 项读数必须与父页全等。
   */
  const oo = d.oopif || {}
  const ooFrames = d.oopifFrames || {}
  const OOPIF_FIELDS = [
    ['cores', 'navigator.hardwareConcurrency'],
    ['memory', 'navigator.deviceMemory'],
    ['languages', 'navigator.languages'],
    ['language', 'navigator.language'],
    ['dtfLocale', 'Intl.DateTimeFormat().locale'],
    ['tz', 'Intl…timeZone'],
    ['glVendor', 'UNMASKED_VENDOR_WEBGL'],
    ['glRenderer', 'UNMASKED_RENDERER_WEBGL']
  ]
  const ooProblems = []
  const ooFields = {}
  let ooMismatch = 0
  let ooUnmeasured = 0
  if (!oo || oo.error) {
    ooProblems.push('OOPIF 探针失败：' + (oo && oo.error ? oo.error : '无读数'))
  } else if (!oo.frame) {
    ooProblems.push('子帧读数缺失（mode=' + String(oo.mode) + '）—— 采不到不算一致')
  } else if (typeof oo.crossOrigin === 'string' && oo.crossOrigin.startsWith('readable:')) {
    // 前提没成立：这个 iframe 与父页同源，contentWindow 直接可读。
    // 此时「一致」是必然的，与本条要证明的事无关 —— 必须判红，不能当通过。
    ooProblems.push(
      '测试无效：iframe 与父页同源（contentWindow 可直读 ' + oo.crossOrigin + '），没有构成跨站。' +
        '检查两个 server 是否真的绑在不同 host（127.0.0.1 / 127.0.0.2）上。'
    )
  } else {
    for (const [k, label] of OOPIF_FIELDS) {
      const a = oo.main ? oo.main[k] : undefined
      const b = oo.frame[k]
      if (unmeasurable(a) && unmeasurable(b)) {
        ooUnmeasured++
        ooFields[k] = { status: 'unmeasured', main: a, worker: b, label }
        continue
      }
      if (canon(a) !== canon(b)) {
        ooMismatch++
        ooFields[k] = { status: 'mismatch', main: a, worker: b, label }
      }
    }
  }

  // 进程号：frames 里除了主帧之外的子帧
  const childFrames = (ooFrames.frames || []).filter((f) => f.url && f.url.indexOf(FRAME_URL) === 0)
  const isOopif = childFrames.some((f) => f.processId !== (ooFrames.main && ooFrames.main.processId))

  /* 「到底测没测到 OOPIF」必须进判据，不能只写进文案。
   *
   * 早先 `isOopif` 只出现在 note 和 actual 里，pass 完全不看它 —— 于是两种情况会假绿：
   *   1) 子帧跨站但同进程：page 级注入本来就覆盖同进程子 frame → 8 项全等 → 绿，
   *      而 OOPIF 那条路径一次都没走过；
   *   2) childFrames 因 URL 尾部/重定向没匹配上导致枚举为空 → isOopif=false → 同样绿。
   * 这和 AC-17 那种「恒真断言」是同一类错误：**没测到被记成了没问题**。 */
  const measured = childFrames.length > 0 && isOopif === true
  // 两种红要分得清：一个是「测到了、确实矛盾」，一个是「根本没测到」。
  const notMeasuredReason =
    childFrames.length === 0
      ? '没枚举到跨站子帧（childFrames=0）—— 本条没测到 OOPIF，不能算通过'
      : isOopif === false
        ? '子帧与父页同进程（processId 相同）—— OOPIF 路径未被覆盖，不能算通过'
        : null

  const ooNote = []
  if (ooProblems.length) {
    for (const p of ooProblems) ooNote.push(p)
  } else if (!measured) {
    ooNote.push(notMeasuredReason)
  } else if (ooMismatch === 0 && ooUnmeasured === 0) {
    ooNote.push('跨站 iframe 的 8 项读数与父页全等 —— 注入已覆盖子帧')
  } else {
    ooNote.push(
      `【测到了，确实矛盾】跨站 iframe 有 ${ooMismatch} 项与父页矛盾：子帧里读到的是**宿主真值**。` +
        '一段 `<iframe src=别的域>` 就能让第三方脚本自报指纹并回传给上游，' +
        '而父页自己的探针完全看不见。修法：Target.setAutoAttach({autoAttach:true, waitForDebuggerOnStart:true}) ' +
        '递归到 OOPIF 目标，对每个 frame target 也下 Page.addScriptToEvaluateOnNewDocument；' +
        '或改用 session.webRequest 注入不了的路径时，至少对 OOPIF 目标重复一次同一份注入。'
    )
    for (const [k, v] of Object.entries(ooFields)) {
      if (v.status === 'unmeasured') continue
      ooNote.push(`· ${k}(${v.label}): 父页 ${canon(v.main)} ≠ 子帧 ${canon(v.worker)}`)
    }
    if (ooUnmeasured) ooNote.push(`另有 ${ooUnmeasured} 项两侧都采不到（不计入矛盾，但也不算一致）`)
  }
  ooNote.push(
    '  |  子帧进程：' +
      (ooFrames.error
        ? '取不到（' + ooFrames.error + '）'
        : childFrames.length
          ? '父进程 ' + ooFrames.main.processId + ' / 子帧 ' + childFrames.map((f) => f.processId).join(',') +
            '（' + (isOopif ? '独立进程 = 真 OOPIF' : '同进程 = OOPIF 路径未被覆盖') + '）'
          : '没枚举到子帧') +
      '  |  边界：本条只比 8 项 navigator/Intl/GPU 读数，不含 screen/媒体查询/音频噪声。'
  )
  add(
    'AC-21',
    '跨站 iframe（OOPIF）必须与父页一致',
    '子帧 8 项读数与父页全等，且**确实测到了 OOPIF**（独立进程）',
    {
      total: OOPIF_FIELDS.length,
      mismatch: ooMismatch,
      unmeasured: ooUnmeasured,
      measured,
      notMeasuredReason,
      childFrames: childFrames.length,
      oopif: isOopif,
      crossOrigin: oo.crossOrigin,
      mode: oo.mode,
      frameUrl: FRAME_URL,
      fields: ooFields
    },
    !ooProblems.length && measured && ooMismatch === 0 && ooUnmeasured === 0,
    ooNote.join('\n       ↳ '),
    { gate: true, group: 'P0 子目标注入' }
  )

/* 22 —— hook 住在哪一层（实例自有属性）
   真实 Chrome 156 实测：`Object.getOwnPropertyNames(new RTCPeerConnection())` 是 `[]`。
   把 hook 直接挂到实例上（而不是原型）会多出 `addEventListener` / `onicecandidate` 之类，
   而 `_maskOne` 只修 name / length / toString —— **修不了「属性住在哪一层」**。
   这是当前默认模式（webrtc=proxy）下的活泄漏，不是潜在缺口，所以 gate:true。

   判据必须是 getOwnPropertyNames。**不能用 for..in**：WebIDL 原型方法本身 enumerable，
   真 Chrome 的 for..in 也会列出一堆，用它会得到「两边一样」的假绿 —— 比假红危险得多。 */
{
  const ri = d.rtcInstance
  const own = Array.isArray(ri.own) ? ri.own : []
  // 允许存在但不该出现的：这几个说明 hook 被挂到了实例上
  const HOOK_ON_INSTANCE = ['addEventListener', 'removeEventListener', 'dispatchEvent', 'onicecandidate', 'onnegotiationneeded', 'oniceconnectionstatechange']
  const leaked = own.filter((k) => HOOK_ON_INSTANCE.includes(k))
  const ok = ri.error === null && own.length === 0
  add(
    'AC-22',
    'RTCPeerConnection 实例不得有自有属性（hook 必须在原型上）',
    '[]',
    { own, leaked, error: ri.error },
    ok,
    ok
      ? ''
      : ri.error
        ? '构造失败（' + ri.error + '），本条未施压'
        : '实例上多出 ' + own.length + ' 个自有属性：' + own.join(', ') +
          '。真 Chrome 156 是 []。' +
          (leaked.length
            ? ' 其中 ' + leaked.join(', ') + ' 是 hook 直接挂在实例上的证据 —— ' +
              '修法：改挂 EventTarget.prototype / RTCPeerConnection.prototype，' +
              '并保留原型上原有的描述符形状（addEventListener 是 data{writable:true}，onicecandidate 是 accessor）。'
            : '')
  )
}
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

let exitCode = 0
let payload = null
try {
  const HOST_OS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'

  /* 临时 userData 里一开始没有任何 profile —— 这是隔离的代价，也是确定性的来源。
     门禁自己建两个：一个宿主 OS、一个跨 OS。不再依赖用户本地有什么环境。 */
  let list = await evalMain(async () => await window.ss.profiles.list())
  if (!Array.isArray(list)) list = []
  if (list.length === 0) {
    const created = await evalMain(async (hostOs) => {
      const cross = ['macos', 'linux', 'windows'].find((x) => x !== hostOs)
      const out = []
      try {
        out.push(await window.ss.profiles.create({ name: '反检测验证-' + hostOs, platform: hostOs }))
        if (cross) out.push(await window.ss.profiles.create({ name: '反检测验证-' + cross, platform: cross }))
      } catch (e) {
        return { error: String((e && e.message) || e), out }
      }
      return { out }
    }, HOST_OS)
    list = await evalMain(async () => await window.ss.profiles.list())
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(
        '没有任何 profile，且自动创建也失败了：' +
          JSON.stringify(created) +
          '\n临时 userData=' + TMP_USERDATA + '（保留现场，可手动检查）'
      )
    }
  }

  /* 环境选择：**必须包含一个与宿主不同 OS 的 profile**。
   *
   * 为什么：宿主是 Windows 时，用 Windows profile 跑，`navigator.platform` 两侧
   * 都是 `Win32` —— 那个「一致」是宿主与 profile 同 OS 的巧合，不是注入生效。
   * 而 platform / userAgentData 恰好是最容易被当成「已经修好了」的两项。
   * 换成 macOS profile：主世界报 `MacIntel`、Worker 报宿主 `Win32`，矛盾立刻现形。
   *
   * 所以两轮都跑：跨 OS 轮（主判据）+ 宿主同 OS 轮（对照，证明「一致」确实来自巧合）。
   * 两轮都必须是 0 矛盾，AC-14 才通过。 */
  const picked = []
  const cross = list.find((p) => p.platform !== HOST_OS)
  if (cross) picked.push(cross)
  // 跨 OS profile 不存在就建一个 —— 否则 AC-14 会在「同 OS 巧合」下空跑
  if (!cross) {
    const created = await evalMain(async (hostOs) => {
      const want = ['macos', 'linux', 'windows'].find((x) => x !== hostOs)
      if (!want) return null
      return await window.ss.profiles.create({ name: '反检测验证-' + want, platform: want })
    }, HOST_OS)
    if (created) picked.push(created)
  }
  const hostProfile = list.find((p) => p.platform === HOST_OS && !picked.some((x) => x.id === p.id))
  if (hostProfile) picked.push(hostProfile)

  /* 非 en-US 轮 —— locale 那条子判据的**前提条件**。
   *
   * `new Date(0).toLocaleDateString()` 的输出语言必须来自 profile。但宿主是 en-US 时，
   * en-US profile 上这条「无论注入有没有生效都是英文」—— 恒绿，等于没测。
   * 所以判据要成立，必须先有一轮「profile 语言 ≠ 宿主语言」。
   *
   * 策略是**只在需要时才付这次启动的代价**：默认指纹是 en-US，宿主是中文 Windows 时
   * 现有轮次天然就有鉴别力，不多跑一轮。只有当所有轮次的语言渲染结果都与宿主默认
   * 相同时，才复制一份指纹、只改 locale/languages，建一个专用 profile。
   *
   * 为什么复制 fingerprint 而不是 update 现有 profile：门禁不该修改别人的身份数据。
   */
  const dateStrOf = (lang) => {
    try {
      return new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(0))
    } catch (e) {
      return null
    }
  }
  const hostDateStr = (() => {
    try {
      return new Date(0).toLocaleDateString()
    } catch (e) {
      return null
    }
  })()
  const langOfProfile = (p) =>
    p && p.fingerprint && Array.isArray(p.fingerprint.languages) && p.fingerprint.languages.length
      ? p.fingerprint.languages[0]
      : p && p.fingerprint && p.fingerprint.locale
        ? p.fingerprint.locale
        : null
  const hasLocalePower = (p) => {
    const lang = langOfProfile(p)
    if (!lang || hostDateStr === null) return false
    const s = dateStrOf(lang)
    return s !== null && s !== hostDateStr
  }
  let localeRoundNote = '现有轮次里已有 profile 语言与宿主默认渲染不同 —— 复用，不额外启动'
  // `SS_FORCE_LOCALE_ROUND=1`：强制走「另建非 en-US profile」那条分支。
  // 为什么留这个开关：在 en-US 宿主上这条分支是常态，在中文/en-GD 宿主上它默认不走 ——
  // 于是「创建专用 profile」这段代码在大多数机器上一次都不会被执行到。
  // 一个从来不被执行的分支等于没有；留个开关才能在任意机器上验证它确实能跑通。
  const FORCE_LOCALE_ROUND = process.env.SS_FORCE_LOCALE_ROUND === '1'
  if (FORCE_LOCALE_ROUND || !picked.some(hasLocalePower)) {
    // 候选语言里挑第一个「渲染结果与宿主默认不同」的。全部用拉丁数字的语言：
    // ar-EG 这类会把数字本地化成阿拉伯-印度数字，与宿主 ICU 的差异会被误读成注入问题。
    const LOCALE_CANDIDATES = ['de-DE', 'ja-JP', 'ru-RU', 'fr-FR', 'zh-CN', 'pt-BR', 'ko-KR', 'en-GB']
    const cand = LOCALE_CANDIDATES.find((c) => {
      const s = dateStrOf(c)
      return s !== null && s !== hostDateStr
    })
    const base = (picked[0] && picked[0].fingerprint) || null
    if (cand && base) {
      const fp = { ...base, locale: cand, languages: [cand, String(cand).split('-')[0]] }
      const created = await evalMain(
        async (arg) => await window.ss.profiles.create({ name: arg.name, fingerprint: arg.fp }),
        { name: '反检测验证-非enUS-' + cand, fp }
      )
      if (created) {
        picked.push(created)
        localeRoundNote = FORCE_LOCALE_ROUND
          ? '（SS_FORCE_LOCALE_ROUND=1 强制）已另建 ' + cand + ' 专用 profile，用来验证「创建非 en-US 轮」这条分支本身能跑通'
          : '现有轮次全都没有 locale 鉴别力（宿主与 profile 语言渲染相同），已另建 ' + cand + ' 专用 profile'
      } else {
        localeRoundNote = '需要一轮非 en-US 才能验 locale，但创建 profile 失败 —— locale 子判据将记「没测到」'
      }
    } else {
      localeRoundNote = '需要一轮非 en-US 才能验 locale，但找不到与宿主渲染不同的候选语言 —— locale 子判据将记「没测到」'
    }
  }
  // nightly 需要两个不同平台，上面已经保证平台不同；不足两个时保持原逻辑
  if (NIGHTLY && picked.length < 2) {
    const created = await evalMain(async () => {
      const existing = await window.ss.profiles.list()
      const have = new Set(existing.map((p) => p.platform))
      const want = ['windows', 'macos', 'linux'].find((x) => !have.has(x))
      if (!want) return null
      return await window.ss.profiles.create({ name: '反检测验证-' + want, platform: want })
    })
    if (created) picked.push(created)
  }

  const runs = []
  for (const p of picked) {
    const fresh = await evalMain(async (id) => {
      const all = await window.ss.profiles.list()
      return all.find((x) => x.id === id) || null
    }, p.id)
    const profile = fresh || p
    const data = await collect(profile.id, profile.name)
    runs.push({ profile, data })
  }

  /* 前置断言：主世界读数必须与该 profile 的配置一致。
   *
   * 一张带着错读数的表比没有表更危险 —— 人会读它、会引用它、会基于它下结论。
   * 所以窗口/环境对不上时，一行表格都不打印，直接退出码 4。
   * 判据只用 platform：它是「这个窗口到底是不是这个 profile」最直接、且不依赖
   * 注入是否生效的指标（注入生效时它必然等于配置值）。 */
  for (const r of runs) {
    const expectPlatform = PLATFORM_JS[r.profile.platform]
    const observed = r.data && r.data.nav ? r.data.nav.platform : undefined
    if (expectPlatform && observed !== expectPlatform) {
      // 区分两种原因：读到宿主平台 = 注入根本没生效；读到别的平台的配置值 = 拿错了窗口。
      // 视图已经按 session partition 反查，拿错窗口的可能性很低 —— 所以前者更常见。
      const hostPlatform = PLATFORM_JS[HOST_OS]
      const why =
        observed === hostPlatform
          ? '读到的是**宿主平台**（' + hostPlatform + '），说明该视图的指纹注入没有生效（不是窗口选错）'
          : '读到的既不是配置值也不是宿主值，可能是窗口/环境错配，或 profile 数据损坏'
      const e = new Error(
        '读数无效：主世界 navigator.platform 与 profile 配置不符。\n' +
          '  profile「' + r.profile.name + '」platform=' + r.profile.platform +
          '（期望 ' + expectPlatform + '），实际读到 ' + String(observed) + '。\n' +
          '  ' + why + '。\n' +
          '  本次不产出表格：错读数的表比没有表更危险 —— 人会读它、引用它、基于它下结论。'
      )
      // 退出码由 catch 块统一决定：aborted → 3（未测量）。这里只标记原因。
      e.exitCode = 3
      e.aborted = 'profile-mismatch'
      throw e
    }
  }

  judge(runs[0].profile.fingerprint, runs[0].data, runs, { localeRoundNote, hostDateStr })

  /* 12 —— 跨环境一致性（nightly） */
  if (NIGHTLY && runs.length >= 2) {
    const [a, b] = runs
    const diff = []
    if (a.data.ua === b.data.ua) diff.push('两个环境 UA 相同')
    if (a.data.screen.width === b.data.screen.width && a.data.screen.height === b.data.screen.height) diff.push('两个环境屏幕相同')
    if (a.data.identity.tz === b.data.identity.tz) diff.push('两个环境时区相同')
    if (a.data.webgl.renderer === b.data.webgl.renderer) diff.push('两个环境 WebGL renderer 相同')

    add(
      'AC-12',
      '[nightly] 两个环境必须互不相同',
      'UA / 屏幕 / 时区 / GPU 各不相同',
      {
        envA: { label: a.profile.name, ua: a.data.ua, screen: a.data.screen.width + 'x' + a.data.screen.height, tz: a.data.identity.tz, gpu: a.data.webgl.renderer },
        envB: { label: b.profile.name, ua: b.data.ua, screen: b.data.screen.width + 'x' + b.data.screen.height, tz: b.data.identity.tz, gpu: b.data.webgl.renderer }
      },
      diff.length === 0,
      diff.join('；'),
      { gate: false }
    )
  } else {
    add('AC-12', '[nightly] 两个环境必须互不相同', '需要 --nightly', '未运行', null, '用 --nightly 跑，需要两次启动', { gate: false, skipped: true })
  }

  /* 配置侧读数 —— 单独采一份，用来给 payload 里的「被测配置」做脚注。
   *
   * `glVendorRaw` / `glRendererRaw` / `hasDebugRendererInfo` 来自主世界探针；
   * `hardwareAcceleration` 只有主进程知道（`app.commandLine` 的开关 + GPU 特性状态）。
   * 为什么值得单独记：GPU 两条串**不许设期望值**（换机器、换驱动就变，是假红），
   * 但「本次到底读到了什么」必须落盘 —— 否则一条红出来，事后无法判断是
   * 注入没生效，还是这台机器本来就没有 WEBGL_debug_renderer_info 扩展。
   */
  let gpuInfo = { hardwareAcceleration: null, featureStatus: null, error: null }
  try {
    gpuInfo = await app.evaluate(async ({ app }) => {
      const out = { hardwareAcceleration: null, featureStatus: null, error: null }
      const has = (s) => {
        try {
          return app.commandLine.hasSwitch(s)
        } catch (e) {
          return false
        }
      }
      try {
        // 「硬件加速开着」= 没有被显式关掉。这不是 GPU 能力的证明，
        // 只是一个环境脚注：同一条红在「关了硬件加速」和「开着」两种环境下含义不同。
        out.hardwareAcceleration = !(has('disable-gpu') || has('disable-gpu-compositing'))
      } catch (e) {
        out.error = String((e && e.message) || e)
      }
      try {
        out.featureStatus = app.getGPUFeatureStatus()
      } catch (e) {}
      return out
    })
  } catch (e) {
    gpuInfo.error = String((e && e.message) || e)
  }
  const w0 = (runs[0] && runs[0].data && runs[0].data.webgl) || {}

  payload = {
    sha,
    // 构建产物本身的 sha1 —— 和 git sha 并列。
    // 为什么两个都要：git sha 说「源码是什么」，out sha1 说「跑的是哪份产物」。
    // 只有 mtime 不够：mtime 可以被 touch 伪造，sha1 不行。
    outSha1: buildState.outSha1,
    build: buildState,
    at: new Date().toISOString(),
    nightly: NIGHTLY,
    config: {
      hardwareAcceleration: gpuInfo.hardwareAcceleration,
      gpuFeatureStatus: gpuInfo.featureStatus,
      gpuProbeError: gpuInfo.error,
      // GPU 串只记录、不设期望值 —— 见上面注释
      glVendorRaw: w0.vendorRaw === undefined ? null : w0.vendorRaw,
      glRendererRaw: w0.rendererRaw === undefined ? null : w0.rendererRaw,
      hasDebugRendererInfo: w0.hasDebugRendererInfo === undefined ? null : w0.hasDebugRendererInfo
    },
    rounds: runs.map((r) => ({
      label: r.profile.name,
      platform: r.profile.platform,
      locale: r.profile.fingerprint ? r.profile.fingerprint.locale : null,
      languages: r.profile.fingerprint ? r.profile.fingerprint.languages : null,
      timezone: r.profile.fingerprint ? r.profile.fingerprint.timezone : null
    })),
    localeRound: { note: localeRoundNote, hostDateString: hostDateStr },
    results,
    raw: runs.map((r) => ({ label: r.profile.name, platform: r.profile.platform, data: r.data }))
  }
  /* 排序：先按「有没有分组」把同一组的行聚到一起，再按 ID。
   *
   * 为什么不能只按 ID：AC-14 和 AC-21 属于同一个 P0 组，但 ID 顺序里隔着 AC-15~20。
   * 只按 ID 排，组标题会被拆成两段，读起来像两个不相干的检查 —— 而它们必须并排看：
   * 一个证明「Worker 里有没有注入」，一个证明「跨站 iframe 里有没有注入」，
   * 两个都红说明注入根本没出主世界，只有一个红才指向具体的目标类型。
   * 分组行统一排到末尾，避免打乱原有 17 条门禁的阅读顺序。 */
  const rankOf = (r) => (r.group ? '1' + r.group : '0')
  payload.results.sort((a, b) => {
    const ra = rankOf(a)
    const rb = rankOf(b)
    if (ra !== rb) return ra < rb ? -1 : 1
    return a.id.localeCompare(b.id)
  })

  /* 分母的构成必须写清楚：
   *   gated    = 真判了（PASS 或 FAIL）
   *   unmeasured = **该判但没测到**，留在分母里，单独一栏
   *   skipped  = 本模式不适用（AC-12 需要 --nightly），不计入分母
   * 把 unmeasured 当成 skipped 去掉，`19/20` 会退化成 `19/19` ——
   * 「少测一项」就变成了「全测了、过了 19」。 */
  const judged = results.filter((r) => r.gate && !r.skipped && !r.unmeasured)
  const unmeasuredList = results.filter((r) => r.gate && !r.skipped && r.unmeasured)
  const failed = judged.filter((r) => r.pass !== true)
  const gatedCount = judged.length + unmeasuredList.length
  // 一条门禁都没跑到时不能算通过。
  // 实测遇到过一次：进程正常退出、表格正常打印、汇总行是「门禁 0/0 通过」——
  // 在 CI 里这一行和「17/17 通过」长得一样，都只有「通过」两个字。
  // 零条检查等于什么都没验，必须比失败更响：它是「不知道」而不是「没问题」。
  exitCode = judged.length === 0 ? 3 : failed.length > 0 ? 1 : 0
  if (judged.length === 0) {
    console.error('\n没有执行到任何门禁检查（judged=0）。这不是通过 —— 是没验。')
    console.error('常见原因：Electron 启动后页面未就绪、探针页 evaluate 抛错、out/ 与 src/ 不匹配。')
  }
} catch (err) {
  const msg = String((err && err.message) || err)
  /* 目标窗口中途消失 —— 这是「读数不可信」里最隐蔽的一类。
   * 实测单实例锁除了让 launch 直接抛错，还有第三种表现：
   * launch 与 firstWindow 都「成功」，但连上的是另一个实例的窗口，
   * 第一次 evaluate 就 `Render frame was disposed`。
   * 这种时候如果只报「脚本自身出错」，看的人会去查脚本，而真正的原因在环境。 */
  const targetLost =
    /Render frame was disposed|Target page, context or browser has been closed|Target closed|has been closed|waiting for event "window"|firstWindow: Timeout/i.test(
      msg
    )
  const aborted = (err && err.aborted) || (targetLost ? 'target-lost' : null)
  console.error('')
  if (err && err.aborted === 'profile-mismatch') {
    // 前置断言触发：读数无效。**一行表格都不打印** —— 见断言处的说明。
    console.error(err.message)
  } else if (targetLost) {
    console.error('目标窗口在采集过程中消失，本次读数无效（不是「通过」，是「没测」）。')
    console.error('  原始错误：' + msg.split('\n')[0])
    console.error(lockHint)
  } else {
    console.error('验证脚本自身出错：', err && err.message ? err.message : err)
  }
  exitCode = aborted ? 3 : (err && err.exitCode) || 2
  /* 退出码统一成三档，和 `check-build-fresh` 对齐：
   *   0 = 通过
   *   1 = 断言失败（测到了，确实不达标）
   *   2 = 脚本自身崩了（探针/环境问题，不是被测对象的问题）
   *   3 = **未测量**（aborted：读数无效、目标丢失、零条门禁）
   *
   * 为什么把原来的 4/5 也并进 3：CI 只需要区分「过 / 不过 / 不知道」。
   * 把「不知道」拆成 4 和 5，下游还是得把两个都当「不知道」处理，
   * 却容易让人误以为其中一个是「不过」。具体原因看 artifacts 里的 `aborted` 字段。 */
  if (aborted) {
    console.error('')
    console.error('退出码 3 = 未测量（不是通过，也不是断言失败）。aborted=' + aborted)
  }
  // aborted 时仍然落一份 artifacts（便于事后查），但结果为空、且不打印表格：
  // 输出块靠 aborted 判断要不要渲染表格。
  payload = {
    sha,
    outSha1: buildState.outSha1,
    build: buildState,
    at: new Date().toISOString(),
    nightly: NIGHTLY,
    error: String((err && err.stack) || err),
    aborted: aborted || null,
    exitCode,
    results: aborted ? [] : results
  }
} finally {
  try {
    server.close()
  } catch {}
  try {
    frameServer.close()
  } catch {}
  try {
    await app.close()
  } catch {}
  // 临时 userData 用完即删：它是隔离手段，不是产物。
  // 需要现场时用 SS_KEEP_USERDATA=1 跑，路径会打印在末尾。
  try {
    if (CLEAN_USERDATA) rmSync(TMP_USERDATA, { recursive: true, force: true })
  } catch {}
}

/* ────────────────────────────── 输出 ────────────────────────────── */

if (payload) {
  mkdirSync(ARTIFACTS, { recursive: true })
  const out = resolve(ARTIFACTS, 'anticheat-' + sha + '.json')
  writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8')

  // 读数无效时只写 artifacts、不打印表格。
  // 一张带着错读数的表比没有表更危险：人会读它、引用它、基于它下结论。
  if (payload.aborted) {
    console.log('')
    console.log('本次没有产出表格（aborted=' + payload.aborted + '）。artifacts/anticheat-' + sha + '.json 里有错误详情。')
    process.exit(exitCode)
  }

  const pad = (s, n) => {
    const str = String(s)
    return str.length >= n ? str.slice(0, n - 1) + '…' : str + ' '.repeat(n - str.length)
  }
  console.log('')
  console.log('反检测运行时验证  commit ' + sha + (NIGHTLY ? '  [nightly]' : '  [gate]'))
  /* 这行是防「测错版本」的唯一提示。本脚本跑的是 out/（构建产物），sha 是源码的 HEAD，
   * 两者可以不一致 —— 不一致时必须当场喊出来，不能等有人拿读数去推结论。
   *
   * 两个标识都要打：
   *   git sha  —— 源码是哪一版（会被未提交改动骗到）
   *   out sha1 —— 实际跑的产物是哪一份（mtime 可以 touch 伪造，sha1 不行）
   * 所以「工作区脏」时这一行必须显式写「结论不可作为交付依据」，
   * 不能只说「有未提交改动」—— 那句话读起来像提示，实际是免责声明。 */
  console.log(
    '  被测产物 out/main/index.js sha1=' +
      String(buildState.outSha1) +
      '  mtime=' +
      String(buildState.outMtime) +
      '  工作区' +
      (buildState.dirty === null
        ? '状态未知（结论不可作为交付依据）'
        : buildState.dirty
          ? '脏 —— 工作树有未提交改动，结论不可作为交付依据'
          : '干净（读数代表 HEAD）')
  )
  console.log('─'.repeat(112))
  console.log(pad('ID', 7) + pad('结论', 7) + pad('检查项', 44) + '实际读数')
  console.log('─'.repeat(112))
  let lastGroup = null
  for (const r of payload.results) {
    /* 分组只影响呈现：同一 P0 组里的多条判据并排看，但**各自独立判**。
     * 合成一条会丢掉「主世界 vs Worker」和「父页 vs 子帧」的区分度 ——
     * 两者红的修法完全不同（前者 Worker 目标没挂注入，后者 OOPIF 目标没挂）。 */
    if (r.group && r.group !== lastGroup) {
      console.log('┌─ ' + r.group + ' ─'.padEnd(100, '─'))
      lastGroup = r.group
    } else if (!r.group && lastGroup) {
      console.log('└─'.padEnd(104, '─'))
      lastGroup = null
    }
    const verdict = r.skipped ? 'skip' : r.pass === null ? 'probe' : r.pass ? 'PASS' : r.gate ? 'FAIL' : 'probe!'
    console.log(
      pad(r.id, 7) +
        pad(verdict, 7) +
        pad(r.name.replace(/^\[.*?\]\s*/, ''), 44) +
        String(JSON.stringify(r.actual)).slice(0, 46)
    )
    if (r.note && (r.pass === false || r.pass === null)) console.log('       ↳ ' + r.note)
  }
  if (lastGroup) console.log('└─'.padEnd(104, '─'))
  console.log('─'.repeat(112))
  const gated = payload.results.filter((r) => r.gate && !r.skipped)
  const failed = gated.filter((r) => r.pass !== true)
  /* 零读数**绝不能**渲染成「通过」。
   * 早先的写法是「门禁 0/0 通过」—— 在 CI 日志里和「19/19 通过」长得一样，
   * 都只有「通过」两个字。零条检查不是「没问题」，是「不知道」，必须单独一种措辞。 */
  const headline =
    payload.results.length === 0 || gated.length === 0
      ? '未测量 —— 没有任何检查被执行（0 条），这不是通过，是「不知道」。' +
        '常见原因：Electron 未就绪 / 探针抛错 / out 与 src 不匹配'
      : '门禁 ' +
        (gated.length - failed.length) +
        '/' +
        gated.length +
        ' 通过' +
        (failed.length ? '，失败：' + failed.map((r) => r.id).join(', ') : '')
  console.log(headline + '    读数已写入 artifacts/anticheat-' + sha + '.json')
  // 分组汇总：一条组里有几条红，看一行就知道
  const groupNames = [...new Set(payload.results.filter((r) => r.group).map((r) => r.group))]
  for (const g of groupNames) {
    const rows = payload.results.filter((r) => r.group === g && r.gate && !r.skipped)
    const bad = rows.filter((r) => r.pass !== true)
    console.log(
      '  组「' + g + '」：' + (rows.length - bad.length) + '/' + rows.length + ' 通过' +
        (bad.length ? '（' + bad.map((r) => r.id).join(', ') + '）' : '')
    )
  }
  if (payload.localeRound && payload.localeRound.note) console.log('  locale 轮次：' + payload.localeRound.note)
  if (payload.config) {
    console.log(
      '  环境脚注：hardwareAcceleration=' + String(payload.config.hardwareAcceleration) +
        '  hasDebugRendererInfo=' + String(payload.config.hasDebugRendererInfo) +
        '  glVendorRaw=' + String(payload.config.glVendorRaw) +
        '  glRendererRaw=' + String(payload.config.glRendererRaw)
    )
  }
  if (payload.error) console.log('脚本自身异常：' + payload.error.split('\n')[0])
}

process.exit(exitCode)
