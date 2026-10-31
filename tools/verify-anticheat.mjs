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
 * gate=true   失败 → 退出码 1，接进 PR 门禁（AC-01~10、AC-13、AC-15）
 * gate=false  只记录读数，永远不判红（AC-11 Electron 探测面、AC-12 跨环境、AC-14 Worker）
 * 基线没拿到就断死，只会让门禁一上来就红，然后就没人看了 —— 所以先采数。
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
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
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

  /* 9：WebGL */
  const webgl = (() => {
    try {
      const c = document.createElement('canvas').getContext('webgl')
      const e = c.getExtension('WEBGL_debug_renderer_info')
      return { vendor: c.getParameter(e.UNMASKED_VENDOR_WEBGL), renderer: c.getParameter(e.UNMASKED_RENDERER_WEBGL) }
    } catch (e) {
      return { vendor: 'ERR:' + e.message, renderer: 'ERR:' + e.message }
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

  /* 12：Worker 上下文（nightly 用） */
  const worker = await new Promise((done) => {
    try {
      const code =
        'self.onmessage=function(){var o={};' +
        'o.ua=navigator.userAgent;' +
        'o.platform=navigator.platform;' +
        'o.cores=navigator.hardwareConcurrency;' +
        'o.languages=navigator.languages?Array.prototype.slice.call(navigator.languages):null;' +
        "o.tz=(function(){try{return Intl.DateTimeFormat().resolvedOptions().timeZone}catch(e){return 'THROW'}})();" +
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
    return out
  })()

  /* 17：RTC 全局接口 —— 要么全在，要么全不在。删一半比不删更可疑 */
  const rtcGlobals = Object.getOwnPropertyNames(window)
    .filter((k) => /^RTC/.test(k))
    .sort()

  /* 21：hook 住在哪一层 —— 实例上多出来的自有属性是最硬的一种 tell。
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

  return {
    mask,
    markers,
    ua,
    uaData,
    nav,
    plugins,
    mimeTypes,
    pluginBehavior,
    screen: screenProbe,
    identity,
    webgl,
    rtcCandidates,
    rtcGlobals,
    intlConsistency,
    pairs,
    electronSurface,
    behavior,
    worker,
    toStringStack
  }
}

const PROBE_SRC = '(' + pageProbe.toString() + ')()'

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

const app = await electron.launch({
  executablePath: electronBinary(),
  args: ['.'],
  cwd: ROOT,
  env,
  timeout: 40000
})
const main = await app.firstWindow({ timeout: 25000 })
await main.waitForTimeout(1500)

/* ────────────────────────────── 采集一个环境 ────────────────────────────── */

async function collect(profileId, label) {
  await main.evaluate(async (id) => {
    await window.ss.profiles.launch(id)
  }, profileId)
  await main.waitForTimeout(6000)

  const opened = app
    .windows()
    .find((w) => w.url().includes('role=browser') && w.url().includes(profileId))
  if (!opened) throw new Error('浏览器窗口未打开：' + label)

  // 首屏（默认主页）可能还在加载，直接 loadURL 会被 ERR_ABORTED 打断，
  // 所以先 stop 再跳，并允许重试。
  await app.evaluate(async ({ BrowserWindow }, url) => {
    const win = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('role=browser'))
    const view = win.contentView.children[0]
    const wc = view.webContents
    try {
      wc.stop()
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 400))
    for (let i = 0; i < 3; i++) {
      try {
        await wc.loadURL(url)
      } catch (e) {}
      if (wc.getURL().includes('127.0.0.1')) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }, PAGE_URL)
  await main.waitForTimeout(1500)

  const data = await app.evaluate(async ({ BrowserWindow }, script) => {
    const win = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('role=browser'))
    const view = win.contentView.children[0]
    return view.webContents.executeJavaScript(script)
  }, PROBE_SRC)

  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('role=browser'))
    if (win) win.close()
  })
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
    skipped: !!opts.skipped,
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

function judge(fp, d) {
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
    'window.chrome 存在但 loadTimes/csi/app/runtime 全无（真实 Chrome 156 的 getOwnPropertyNames(window.chrome) = app/csi/loadTimes 共 3 个，本处 0 个）；' +
      'process/require/module 全 undefined；' +
      'toString 栈形状 = ' +
      d.toStringStack +
      '：这是**已接受的代价**（触发需检测方主动踩异常路径），不是待修项 —— ' +
      'Proxy 方案会把这条换成「fn.name 与 toString 名字矛盾」，那个被检查得更频繁，AC-15 已钉住。' +
      '注意：chrome.runtime 真实 Chrome 也没有，别顺手 stub 它，那会造出新的假红。' +
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
     「注入完全没跑」时同样全绿 —— 那是空断言。这里证明函数确实被换掉了。 */
  const b = d.behavior
  const evProblems = []
  const evNotes = []

  const expectedOffset = tzOffset(fp.timezone, new Date(Date.UTC(2026, 0, 15, 20, 0, 0)))
  if (expectedOffset === null) {
    evProblems.push('无法解析时区 ' + fp.timezone)
  } else {
    if (b.date.offset !== expectedOffset) {
      evProblems.push('getTimezoneOffset=' + b.date.offset + '，但 ' + fp.timezone + ' 应为 ' + expectedOffset)
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
    { date: b.date, expectedOffset, canvas: b.canvas, audio: b.audio, rect: b.rect },
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
     「删掉 RTCPeerConnection」这个方向比抛错更原生，但清单靠字面量维护就会漏：
     漏掉的后果是「RTCPeerConnection 不存在、RTCRtpSender 存在」——
     真实 Chromium 里不存在这个组合，是比不删更强的信号。

     所以断言的不是「全删」，而是**矛盾**：要么一个都没删，要么一个都不剩。
     只删一半正是要拦的那种。 */
  const hasPeer = d.rtcGlobals.includes('RTCPeerConnection')
  const rtcConsistent = hasPeer || d.rtcGlobals.length === 0
  add(
    'AC-17',
    'RTC 全局接口要么全在、要么全不在（不许删一半）',
    hasPeer ? '未启用删除，全部存在' : '已启用删除，必须一个不剩',
    { count: d.rtcGlobals.length, hasPeer, list: d.rtcGlobals },
    rtcConsistent,
    rtcConsistent
      ? hasPeer
        ? '当前 profile 未走删除路径（webrtc≠disabled），此断言只验证「没有部分删除」'
        : ''
      : `RTCPeerConnection 已删除，但仍有 ${d.rtcGlobals.length} 个 RTC 接口存在：${d.rtcGlobals.join(', ')}。修法应用运行时枚举（/^RTC/）而不是字面量数组` +
        '  |  重要边界：本条只覆盖主世界。Object.getOwnPropertyNames(window) 在 Worker 里是另一套全局，' +
        '所以 webrtc=disabled 时可能出现「主世界 23 个全删、Worker 里 23 个全在」—— ' +
        '本条会绿，但矛盾比不删更大（一次 new Worker(blob) 就能比出来）。AC-17 通过 ≠ disabled 模式安全。'
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
  add(
    'AC-18',
    '成对读数一致（Number 的 toLocaleString 必须与 profile locale 一致）',
    expectedNumber === null ? '两个 API 给出同一答案' : `"${expectedNumber}"（${fp.locale}）`,
    pr,
    pairProblems.length === 0,
    [pairProblems.join('；'), pairNotes.join('；')].filter(Boolean).join('  |  ')
  )

  /* 14 —— Worker 上下文（Page.addScriptToEvaluateOnNewDocument 不覆盖 Worker） */
  const w = d.worker
  const wProblems = []
  if (!w || w.error || w.timeout) {
    wProblems.push('Worker 读数失败：' + JSON.stringify(w))
  } else {
    if (w.ua !== d.ua) wProblems.push('UA 不一致')
    if (w.platform !== d.nav.platform) wProblems.push('platform=' + w.platform + ' ≠ ' + d.nav.platform)
    if (w.cores !== d.nav.cores) wProblems.push('cores=' + w.cores + ' ≠ ' + d.nav.cores)
    if (JSON.stringify(w.languages) !== JSON.stringify(d.nav.languages)) wProblems.push('languages 不一致')
    if (w.tz !== d.identity.tz) wProblems.push('timeZone=' + w.tz + ' ≠ ' + d.identity.tz)
  }
  add(
    'AC-14',
    '[探针] Worker 上下文必须与主世界一致',
    'UA/platform/cores/languages/timeZone 全部一致',
    w,
    null,
    (wProblems.length
      ? '已知缺口（P0）：Worker 里读到的是宿主真实值，主世界是伪装值 —— 一段 `new Worker(blob)` 就能同时拿到两套并判定伪装。修法：Target.setAutoAttach + waitForDebuggerOnStart，对 Worker 也注入。'
      : 'Worker 与主世界一致') +
      '  |  同一条缺口也吃 AC-17：RTC 删除只作用于主世界，webrtc=disabled 时可能「主世界全删、Worker 全在」，AC-17 仍会绿 —— 通过 ≠ disabled 模式安全。',
    { gate: false }
  )
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

let exitCode = 0
let payload = null
try {
  const list = await main.evaluate(async () => await window.ss.profiles.list())
  if (!Array.isArray(list) || list.length === 0) throw new Error('没有任何 profile，先在 UI 里建一个')

  // 门禁模式只跑一个环境；nightly 跑两个不同平台，用来验证「两个环境确实不同」
  const picked = []
  for (const p of list) {
    if (picked.length >= (NIGHTLY ? 2 : 1)) break
    if (NIGHTLY && picked.some((x) => x.platform === p.platform)) continue
    picked.push(p)
  }
  if (NIGHTLY && picked.length < 2) {
    const created = await main.evaluate(async () => {
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
    const fresh = await main.evaluate(async (id) => {
      const all = await window.ss.profiles.list()
      return all.find((x) => x.id === id) || null
    }, p.id)
    const profile = fresh || p
    const data = await collect(profile.id, profile.name)
    runs.push({ profile, data })
  }

  judge(runs[0].profile.fingerprint, runs[0].data)

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

  payload = { sha, build: buildState, at: new Date().toISOString(), nightly: NIGHTLY, results, raw: runs.map((r) => ({ label: r.profile.name, platform: r.profile.platform, data: r.data })) }
  // 按 ID 排序：判定顺序服务于可读性（相邻的检查放在一起写），输出顺序服务于查找
  payload.results.sort((a, b) => a.id.localeCompare(b.id))

  const failed = results.filter((r) => r.gate && !r.skipped && r.pass !== true)
  exitCode = failed.length > 0 ? 1 : 0
} catch (err) {
  console.error('\n验证脚本自身出错：', err && err.message ? err.message : err)
  exitCode = 2
  payload = { sha, build: buildState, at: new Date().toISOString(), nightly: NIGHTLY, error: String((err && err.stack) || err), results }
} finally {
  try {
    server.close()
  } catch {}
  try {
    await app.close()
  } catch {}
}

/* ────────────────────────────── 输出 ────────────────────────────── */

if (payload) {
  mkdirSync(ARTIFACTS, { recursive: true })
  const out = resolve(ARTIFACTS, 'anticheat-' + sha + '.json')
  writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8')

  const pad = (s, n) => {
    const str = String(s)
    return str.length >= n ? str.slice(0, n - 1) + '…' : str + ' '.repeat(n - str.length)
  }
  console.log('')
  console.log('反检测运行时验证  commit ' + sha + (NIGHTLY ? '  [nightly]' : '  [gate]'))
  // 这行是防「测错版本」的唯一提示。本脚本跑的是 out/（构建产物），sha 是源码的 HEAD，
  // 两者可以不一致 —— 不一致时必须当场喊出来，不能等有人拿读数去推结论。
  console.log(
    '  被测产物 out/main/index.js sha1=' +
      String(buildState.outSha1) +
      '  mtime=' +
      String(buildState.outMtime) +
      '  工作区' +
      (buildState.dirty === null ? '状态未知' : buildState.dirty ? '有未提交改动（读数不代表 HEAD）' : '干净（读数代表 HEAD）')
  )
  console.log('─'.repeat(112))
  console.log(pad('ID', 7) + pad('结论', 7) + pad('检查项', 44) + '实际读数')
  console.log('─'.repeat(112))
  for (const r of payload.results) {
    const verdict = r.skipped ? 'skip' : r.pass === null ? 'probe' : r.pass ? 'PASS' : r.gate ? 'FAIL' : 'probe!'
    console.log(
      pad(r.id, 7) +
        pad(verdict, 7) +
        pad(r.name.replace(/^\[.*?\]\s*/, ''), 44) +
        String(JSON.stringify(r.actual)).slice(0, 46)
    )
    if (r.note && (r.pass === false || r.pass === null)) console.log('       ↳ ' + r.note)
  }
  console.log('─'.repeat(112))
  const gated = payload.results.filter((r) => r.gate && !r.skipped)
  const failed = gated.filter((r) => r.pass !== true)
  console.log(
    '门禁 ' +
      (gated.length - failed.length) +
      '/' +
      gated.length +
      ' 通过' +
      (failed.length ? '，失败：' + failed.map((r) => r.id).join(', ') : '') +
      '    读数已写入 artifacts/anticheat-' + sha + '.json'
  )
  if (payload.error) console.log('脚本自身异常：' + payload.error.split('\n')[0])
}

process.exit(exitCode)
