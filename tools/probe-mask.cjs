/**
 * 反检测运行时探针（真 Chromium，不是 mock）。
 *
 * 背景：`tools/check-injection.mjs` 只能证明注入脚本**能解析**。语法对但运行时抛错
 * 一样致命 —— 整段脚本外面套着 try/catch，一处抛错就静默全失效，界面看不出来。
 *
 * 这个探针把 artifacts/injection-windows.js 注入真实页面，然后逐条断言
 * 「包装函数有没有留下能被一行 JS 枚举的痕迹」。
 *
 * 用法：
 *   node tools/check-injection.mjs        # 先产出 artifacts/injection-windows.js
 *   npx electron tools/probe-mask.cjs     # 再真跑一遍
 *
 * 退出码非 0 表示有断言不成立。
 */

const { app, BrowserWindow } = require('electron')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const SRC_FILE = resolve(__dirname, '../artifacts/injection-windows.js')

/** 每条探针都是「读一个值」，避免写成「看起来对」 */
const PROBES = [
  {
    id: 'getter-toString',
    expect: 'function get userAgent() { [native code] }',
    expr: 'Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent").get.toString()'
  },
  {
    id: 'getter-no-prototype',
    expect: false,
    expr: '"prototype" in Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent").get'
  },
  {
    id: 'fts-no-prototype',
    expect: false,
    expr: '"prototype" in Function.prototype.toString'
  },
  {
    id: 'fts-self-toString',
    expect: 'function toString() { [native code] }',
    expr: 'Function.prototype.toString.toString()'
  },
  {
    id: 'dtf-name',
    expect: 'DateTimeFormat',
    expr: 'Intl.DateTimeFormat.name'
  },
  {
    id: 'dtf-ctor-identity',
    expect: true,
    expr: 'Intl.DateTimeFormat.prototype.constructor === Intl.DateTimeFormat'
  },
  {
    id: 'dtf-no-leak-name',
    expect: false,
    expr: 'Intl.DateTimeFormat.name.indexOf("_") === 0'
  },
  {
    id: 'rtc-name',
    expect: 'RTCPeerConnection',
    expr: 'RTCPeerConnection.name'
  },
  {
    id: 'rtc-ctor-identity',
    expect: true,
    expr: 'RTCPeerConnection.prototype.constructor === RTCPeerConnection'
  },
  {
    id: 'geo-toString',
    expect: 'function getCurrentPosition() { [native code] }',
    expr: 'Geolocation.prototype.getCurrentPosition.toString()'
  },
  {
    id: 'analyser-toString',
    expect: 'function getFloatFrequencyData() { [native code] }',
    expr: 'AnalyserNode.prototype.getFloatFrequencyData.toString()'
  },
  {
    id: 'no-fp-marker',
    expect: 'undefined',
    expr: 'typeof window.__SS_FP__'
  },
  {
    // 这是 QA 那条「一行枚举全部 hook」的探针：
    // 原生方法/getter 都没有 prototype，我们所有包装函数都必须也没有
    id: 'enumerable-hooks',
    expect: 0,
    expr: `(function () {
      var hits = 0;
      var owners = [Navigator.prototype, Screen.prototype, Date.prototype, Element.prototype];
      var names = ["userAgent", "platform", "vendor", "languages", "webdriver", "width",
                   "height", "getTimezoneOffset", "getHours", "getBoundingClientRect"];
      for (var o = 0; o < owners.length; o++) {
        for (var n = 0; n < names.length; n++) {
          var d = Object.getOwnPropertyDescriptor(owners[o], names[n]);
          if (!d) { continue; }
          if (typeof d.get === "function" && "prototype" in d.get) { hits++; }
          if (typeof d.value === "function" && "prototype" in d.value) { hits++; }
        }
      }
      return hits;
    })()`
  }
]

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  let src
  try {
    src = readFileSync(SRC_FILE, 'utf8')
  } catch {
    console.error(`读不到 ${SRC_FILE}\n先跑：node tools/check-injection.mjs`)
    app.exit(2)
    return
  }

  const win = new BrowserWindow({ show: false, width: 800, height: 600 })
  const wc = win.webContents
  await wc.loadURL('data:text/html,<!doctype html><title>probe</title><body>probe</body>')

  wc.debugger.attach('1.3')
  await wc.debugger.sendCommand('Page.enable')

  const failures = []
  const rows = []

  try {
    // 注入前的基线：先记下原生值，用来证明「改之前不是这样」
    const before = await evaluate(wc, PROBES[0].expr)
    const beforeHooks = await evaluate(wc, PROBES[12].expr)

    await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: src })
    await wc.loadURL('data:text/html,<!doctype html><title>probe</title><body>probe</body>')

    for (const p of PROBES) {
      const actual = await evaluate(wc, p.expr)
      const pass = JSON.stringify(actual) === JSON.stringify(p.expect)
      rows.push({ id: p.id, expect: p.expect, actual, pass })
      if (!pass) failures.push(p.id)
    }

    console.log('\n注入前基线：')
    console.log(`  getter.toString()      = ${before}`)
    console.log(`  带 prototype 的 hook 数 = ${beforeHooks}`)
    console.log('\n注入后：')
    for (const r of rows) {
      const mark = r.pass ? 'ok  ' : 'FAIL'
      console.log(`  ${mark} ${r.id.padEnd(22)} ${JSON.stringify(r.actual)}`)
    }
  } finally {
    try { wc.debugger.detach() } catch { /* 忽略 */ }
    win.destroy()
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} 条不成立：${failures.join(', ')}`)
    app.exit(1)
    return
  }
  console.log(`\n${rows.length} 条全部成立`)
  app.exit(0)
})

/** 在页面主世界求值，并把异常原样带回主进程 */
async function evaluate(wc, expression) {
  const res = await wc.debugger.sendCommand('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false
  })
  if (res.exceptionDetails) {
    const text = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text
    return `<throw> ${text}`
  }
  return res.result.value
}
