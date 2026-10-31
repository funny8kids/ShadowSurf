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
 * gate=true   失败 → 退出码 1，接进 PR 门禁（AC-01~10、AC-13）
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
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
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
    return { name, src: srcOf(fn), native: isNative(fn), hasProto: hasProto(fn) }
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
  const widevine = await (async () => {
    try {
      if (!navigator.requestMediaKeySystemAccess) return 'no-api'
      await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [
        { initDataTypes: ['cenc'], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }] }
      ])
      return 'available'
    } catch (e) {
      return 'unavailable:' + (e && e.name ? e.name : 'err')
    }
  })()

  const electronSurface = {
    chrome: typeof window.chrome,
    // Object.keys 对 window.chrome 不可靠（属性不可枚举），必须用 `in`
    chromeIn: window.chrome ? ['loadTimes', 'csi', 'app', 'runtime'].filter((k) => k in window.chrome) : [],
    chromeLoadTimes: window.chrome ? typeof window.chrome.loadTimes : 'no-chrome',
    chromeCsi: window.chrome ? typeof window.chrome.csi : 'no-chrome',
    chromeRuntime: window.chrome ? typeof window.chrome.runtime : 'no-chrome',
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

  return {
    mask,
    markers,
    ua,
    uaData,
    nav,
    plugins,
    mimeTypes,
    screen: screenProbe,
    identity,
    webgl,
    rtcCandidates,
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
  const pluginOk = d.plugins.length > 0 && hasPdf && d.mimeTypes.length > 0
  const pluginReal = d.behavior.pluginArrayTag === '[object PluginArray]'
  add(
    'AC-06',
    'navigator.plugins 的值必须非空且含 PDF 条目',
    'length>0 且含 PDF 条目，mimeTypes 非空',
    { length: d.plugins.length, names: d.plugins, mimeCount: d.mimeTypes.length, tag: d.behavior.pluginArrayTag },
    pluginOk,
    pluginOk
      ? pluginReal
        ? '注意：这是**真 PluginArray**，说明 plugins 根本没被伪造 —— 本次通过靠的是 Electron 自带的 Chromium 默认列表恰好和 Chrome 一样，不是伪装生效。这条只能防「列表被清空」这类回归，不能证明「已伪造」。'
        : ''
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
    'window.chrome / process / Widevine 在 Electron 下大概率缺失。采一轮基线写进 JSON，下一轮再升条件断言。附 toString 异常栈形状：' + d.toStringStack,
    { gate: false }
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
    wProblems.length
      ? '已知缺口（P0）：Worker 里读到的是宿主真实值，主世界是伪装值 —— 一段 `new Worker(blob)` 就能同时拿到两套并判定伪装。修法：Target.setAutoAttach + waitForDebuggerOnStart，对 Worker 也注入。'
      : 'Worker 与主世界一致',
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

  payload = { sha, at: new Date().toISOString(), nightly: NIGHTLY, results, raw: runs.map((r) => ({ label: r.profile.name, platform: r.profile.platform, data: r.data })) }

  const failed = results.filter((r) => r.gate && !r.skipped && r.pass !== true)
  exitCode = failed.length > 0 ? 1 : 0
} catch (err) {
  console.error('\n验证脚本自身出错：', err && err.message ? err.message : err)
  exitCode = 2
  payload = { sha, at: new Date().toISOString(), nightly: NIGHTLY, error: String((err && err.stack) || err), results }
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
