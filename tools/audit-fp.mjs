/**
 * 指纹审计：把「环境配置」和「页面真实读到」逐项对照。
 *
 * 三件事：
 * 1. JS 可枚举面（UA / 屏幕 / 时区 / WebGL / Canvas / 字体 ...）
 * 2. 网络层（真实发出的 User-Agent、Sec-CH-UA、Accept-Language）
 * 3. 一致性交叉校验（版本对不对得上、时区与经纬度是否矛盾、两个环境的指纹是否真的不同）
 */
import { _electron as electron } from 'playwright-core'
import { createServer } from 'node:http'

/* ── 本地探针服务：记录浏览器真实发出的请求头 ── */
const captured = {}
const server = createServer((req, res) => {
  if (req.url === '/probe') {
    captured.headers = req.headers
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><meta charset="utf-8"><title>fp probe</title><body style="font:14px system-ui">probe</body>')
})
await new Promise((r) => server.listen(9981, '127.0.0.1', r))

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: 'G:/Worker-Space/ShadowSurf/node_modules/electron/dist/electron.exe',
  args: ['.'], cwd: 'G:/Worker-Space/ShadowSurf', env, timeout: 30000
})
const main = await app.firstWindow({ timeout: 20000 })
await main.waitForTimeout(1600)

/** 在页面里跑一遍检测，返回原始读数 */
const PROBE = `(async () => {
  const gl = (() => {
    try {
      const c = document.createElement('canvas').getContext('webgl')
      const e = c.getExtension('WEBGL_debug_renderer_info')
      return {
        vendor: c.getParameter(e.UNMASKED_VENDOR_WEBGL),
        renderer: c.getParameter(e.UNMASKED_RENDERER_WEBGL)
      }
    } catch (e) { return { vendor: 'ERR', renderer: 'ERR' } }
  })()

  const canvas = (() => {
    const c = document.createElement('canvas')
    c.width = 200; c.height = 40
    const x = c.getContext('2d')
    x.textBaseline = 'top'; x.font = '14px Arial'
    x.fillStyle = '#f60'; x.fillRect(0, 0, 200, 40)
    x.fillStyle = '#069'; x.fillText('ShadowSurf 指纹审计', 2, 2)
    const d = c.toDataURL()
    let h = 0
    for (let i = 0; i < d.length; i++) { h = (h * 31 + d.charCodeAt(i)) | 0 }
    return (h >>> 0).toString(16)
  })()

  const audio = await (async () => {
    try {
      const ctx = new OfflineAudioContext(1, 44100, 44100)
      const osc = ctx.createOscillator()
      osc.type = 'triangle'; osc.frequency.value = 10000
      const comp = ctx.createDynamicsCompressor()
      osc.connect(comp); comp.connect(ctx.destination); osc.start(0)
      const buf = await ctx.startRendering()
      const d = buf.getChannelData(0)
      let sum = 0
      for (let i = 4500; i < 5000; i++) sum += Math.abs(d[i])
      return sum.toFixed(8)
    } catch (e) { return 'ERR' }
  })()

  const rects = (() => {
    const el = document.createElement('div')
    el.style.cssText = 'position:absolute;top:0;left:0;width:100.3px;height:20.7px'
    document.body.appendChild(el)
    const r = el.getBoundingClientRect()
    el.remove()
    return [r.width, r.height]
  })()

  const uaData = navigator.userAgentData || null

  // WebRTC：看是否泄漏内网 IP
  const rtc = await new Promise((resolve) => {
    try {
      const pc = new RTCPeerConnection({ iceServers: [] })
      const found = []
      const done = () => { try { pc.close() } catch (e) {} ; resolve(found) }
      pc.onicecandidate = (e) => {
        if (!e.candidate) return done()
        const m = /([0-9]{1,3}(\\.[0-9]{1,3}){3}|[a-f0-9]{4}:[a-f0-9:]+|\\.local)/i.exec(e.candidate.candidate)
        if (m) found.push(m[1])
      }
      pc.createDataChannel('x')
      pc.createOffer().then((o) => pc.setLocalDescription(o))
      setTimeout(done, 1200)
    } catch (e) { resolve(['ERR']) }
  })

  // 字体探测：用 canvas 度量差判断字体是否存在
  const fontProbe = (() => {
    const c = document.createElement('canvas').getContext('2d')
    const base = ['monospace', 'sans-serif', 'serif']
    const test = ['Arial', 'Segoe UI', 'Helvetica Neue', 'Menlo', 'DejaVu Sans', 'Consolas', 'Noto Sans']
    const out = {}
    for (const f of test) {
      let hit = false
      for (const b of base) {
        c.font = '16px ' + b
        const w1 = c.measureText('mmmmmmmmmmlli').width
        c.font = '16px "' + f + '", ' + b
        const w2 = c.measureText('mmmmmmmmmmlli').width
        if (Math.abs(w1 - w2) > 0.1) { hit = true; break }
      }
      out[f] = hit
    }
    return out
  })()

  await fetch('/probe')

  // 伪装痕迹：被改过的函数必须自称 native，页面上不能留下自己的全局标记
  const stealth = (() => {
    const src = (fn) => {
      try { return Function.prototype.toString.call(fn).replace(/\\s+/g, ' ').slice(0, 70) } catch (e) { return 'ERR' }
    }
    const getter = (obj, prop) => {
      try { return Object.getOwnPropertyDescriptor(obj, prop).get } catch (e) { return null }
    }
    return {
      uaGetter: src(getter(Navigator.prototype, 'userAgent')),
      langGetter: src(getter(Navigator.prototype, 'languages')),
      dprGetter: src(getter(window, 'devicePixelRatio')),
      toDataURL: src(HTMLCanvasElement.prototype.toDataURL),
      measureText: src(CanvasRenderingContext2D.prototype.measureText),
      getChannelData: src(AudioBuffer.prototype.getChannelData),
      dateToString: src(Date.prototype.toString),
      toStringSelf: src(Function.prototype.toString),
      // 页面自己的全局标记，一个都不该有
      markers: ['__SS_FP__', '__SS__', '__ss'].filter((k) => k in window)
    }
  })()

  // 高熵值：Cloudflare 一类风控主要看这个，比 navigator.platform 值钱得多
  const hi = await (async () => {
    try {
      if (!navigator.userAgentData || !navigator.userAgentData.getHighEntropyValues) return 'N/A'
      const v = await navigator.userAgentData.getHighEntropyValues(
        ['architecture', 'bitness', 'model', 'platformVersion', 'uaFullVersion']
      )
      return JSON.stringify(v)
    } catch (e) { return 'ERR ' + e.message }
  })()

  // 显式量三个字体，看伪造的宽度偏移是否生效
  const fw = (() => {
    const c = document.createElement('canvas').getContext('2d')
    c.font = '16px monospace'
    const base = c.measureText('mmmmmmmmmmlli').width
    c.font = '16px "Helvetica Neue", monospace'
    const hn = c.measureText('mmmmmmmmmmlli').width
    c.font = '16px "Consolas", monospace'
    const cs = c.measureText('mmmmmmmmmmlli').width
    return { base: +base.toFixed(3), helveticaNeue: +hn.toFixed(3), consolas: +cs.toFixed(3) }
  })()

  return {
    ua: navigator.userAgent,
    appVersion: navigator.appVersion,
    platform: navigator.platform,
    vendor: navigator.vendor,
    webdriver: navigator.webdriver,
    cores: navigator.hardwareConcurrency,
    memory: navigator.deviceMemory,
    maxTouch: navigator.maxTouchPoints,
    languages: navigator.languages,
    language: navigator.language,
    pdfViewer: navigator.pdfViewerEnabled,
    uaDataPlatform: uaData ? uaData.platform : 'N/A',
    uaDataMobile: uaData ? uaData.mobile : 'N/A',
    uaDataBrands: uaData ? uaData.brands.map((b) => b.brand + ' ' + b.version).join(' | ') : 'N/A',
    screen: [screen.width, screen.height],
    avail: [screen.availWidth, screen.availHeight],
    colorDepth: screen.colorDepth,
    dpr: devicePixelRatio,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offsetJan: new Date(2026, 0, 15).getTimezoneOffset(),
    offsetJul: new Date(2026, 6, 15).getTimezoneOffset(),
    tzAbbr: new Date(2026, 0, 15).toTimeString().slice(-9, -1),
    // 本地时间 getter 是否真的跟着目标时区走（只改 getTimezoneOffset 是不够的）
    janLocal: new Date(2026, 0, 15, 12, 0, 0).getHours(),
    janString: new Date(2026, 0, 15, 12, 0, 0).toString(),
    janTimeString: new Date(2026, 0, 15, 12, 0, 0).toTimeString(),
    janLocale: new Date(2026, 0, 15, 12, 0, 0).toLocaleString('en-US'),
    julString: new Date(2026, 6, 15, 12, 0, 0).toString(),
    utcString: new Date(Date.UTC(2026, 0, 15, 20, 0, 0)).toString(),
    webgl: gl,
    canvasHash: canvas,
    audioHash: audio,
    rects,
    rtcCandidates: rtc,
    fonts: fontProbe,
    fontWidths: fw,
    highEntropy: hi,
    stealth,
    // Intl 缺省 locale 是否跟着 navigator.languages 走
    intlLocale: Intl.DateTimeFormat().resolvedOptions().locale,
    intlNumber: new Intl.NumberFormat().resolvedOptions().locale,
    intlCollator: new Intl.Collator().resolvedOptions().locale,
    // CSS 媒体查询的 device-width 是否与 screen.width 一致
    mqMatch: matchMedia('(device-width: ' + screen.width + 'px)').matches,
    mqProbe: (() => {
      // 二分出媒体查询实际认为的设备宽度
      let lo = 200, hi = 4000
      for (let i = 0; i < 12; i++) {
        const mid = Math.round((lo + hi) / 2)
        if (matchMedia('(min-device-width: ' + mid + 'px)').matches) lo = mid
        else hi = mid
      }
      return lo
    })(),
    speechLang: (() => {
      try {
        const v = speechSynthesis.getVoices()
        return v.length ? v[0].lang + ' ×' + v.length : 'none'
      } catch (e) { return 'ERR' }
    })(),
    plugins: navigator.plugins.length
  }
})()`

async function auditProfile(profileId, label) {
  const w = await app.evaluate(async ({ BrowserWindow }, pid) => {
    // 通过 IPC 让主进程开窗口
    const win = BrowserWindow.getAllWindows()[0]
    await win.webContents.executeJavaScript(`window.ss.profiles.launch(${JSON.stringify(pid)})`)
    return true
  }, profileId)
  void w
  await main.waitForTimeout(6000)

  const bw = app.windows().find((x) => x.url().includes('role=browser') && x.url().includes(profileId))
  if (!bw) return { label, error: '窗口未打开' }

  // 导航到探针页。首屏（bing）可能还在加载，直接 loadURL 会被 ERR_ABORTED 打断，
  // 所以先 stop 再跳，并允许一次重试。
  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('role=browser'))
    const view = win.contentView.children[0]
    const wc = view.webContents
    try { wc.stop() } catch (e) {}
    await new Promise((r) => setTimeout(r, 400))
    for (let i = 0; i < 3; i++) {
      try { await wc.loadURL('http://127.0.0.1:9981/') } catch (e) {}
      if (wc.getURL().includes('9981')) break
      await new Promise((r) => setTimeout(r, 500))
    }
  })
  await main.waitForTimeout(1500)

  const data = await app.evaluate(async ({ BrowserWindow }, script) => {
    const win = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('role=browser'))
    const view = win.contentView.children[0]
    return view.webContents.executeJavaScript(script)
  }, PROBE)

  const headers = { ...captured.headers }

  // 关掉窗口，为下一个环境让路
  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('role=browser'))
    if (win) win.close()
  })
  await main.waitForTimeout(1200)

  return { label, data, headers }
}

// 造两个环境：Windows 与 macOS
const ids = await main.evaluate(async () => {
  const list = await window.ss.profiles.list()
  let win = list.find((p) => p.platform === 'windows')
  let mac = list.find((p) => p.platform === 'macos')
  if (!win) win = await window.ss.profiles.create({ name: '审计-Windows', platform: 'windows' })
  else win = await window.ss.profiles.regenerate(win.id)
  if (!mac) mac = await window.ss.profiles.create({ name: '审计-macOS', platform: 'macos' })
  else mac = await window.ss.profiles.regenerate(mac.id)
  return { win: win.id, mac: mac.id }
})

const results = []
results.push(await auditProfile(ids.win, 'Windows 11'))
results.push(await auditProfile(ids.mac, 'macOS 15'))

// 宿主机真实时区：用来证明页面读数确实被平移过，而不是「碰巧一致」
const host = await app.evaluate(() => ({
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  offset: new Date(2026, 0, 15).getTimezoneOffset(),
  hours: new Date(2026, 0, 15, 12, 0, 0).getHours()
}))
console.log(JSON.stringify({ host, results }, null, 1))
server.close()
await app.close()
