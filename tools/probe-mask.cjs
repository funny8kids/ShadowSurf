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
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { resolve } = require('node:path')

const SRC_FILE = resolve(__dirname, '../artifacts/injection-windows.js')
const PAGE_FILE = resolve(__dirname, '../artifacts/probe-page.html')

/**
 * 探针页面必须跑在**安全上下文**里。
 *
 * 一开始用的是 `data:text/html,...`，结果 `Navigator.prototype.gpu` 查不到 ——
 * 因为 WebGPU 的 IDL 属性带 `[SecureContext]`，data: URL 不算安全上下文。
 * 换成 file://（被当作 potentially trustworthy）才和真实 https 页面的能力面对齐，
 * 否则台账自检会报一堆假阳性，把真的死条目淹掉。
 */
function writeProbePage() {
  mkdirSync(resolve(__dirname, '../artifacts'), { recursive: true })
  writeFileSync(
    PAGE_FILE,
    '<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head>' +
      '<body><div id="app">probe</div></body></html>',
    'utf8'
  )
  return 'file:///' + PAGE_FILE.replace(/\\/g, '/')
}

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
    // 原生构造器的 prototype 是 writable:false / configurable:false / enumerable:false。
    // 赋值语句 `F.prototype = X` 造出来的是 writable:true —— 一行就能查出来。
    // 这里扫全部 9 个被包装过的构造器，而不是只抽查两个：
    // 逐个点名验会漏掉「以后新增的包装忘了加锁定」。
    id: 'ctor-proto-descriptors',
    expect: [],
    expr: `(function () {
      var ctors = [Intl.DateTimeFormat, Intl.NumberFormat, Intl.Collator,
                   Intl.RelativeTimeFormat, Intl.PluralRules, Intl.ListFormat,
                   Intl.DisplayNames, Intl.Segmenter, RTCPeerConnection];
      var bad = [];
      for (var i = 0; i < ctors.length; i++) {
        var d = Object.getOwnPropertyDescriptor(ctors[i], "prototype");
        if (!d) { bad.push((ctors[i].name || i) + ":missing"); continue; }
        if (d.writable !== false || d.configurable !== false || d.enumerable !== false) {
          bad.push((ctors[i].name || i) + ":writable=" + d.writable);
        }
      }
      return bad;
    })()`
  },
  {
    // 曾经用 setPrototypeOf(_PC, RTC) 继承静态成员，代价是
    // Object.getPrototypeOf(RTCPeerConnection) 变成 RTC（原生是 Function.prototype）
    id: 'rtc-fn-proto',
    expect: true,
    expr: 'Object.getPrototypeOf(RTCPeerConnection) === Function.prototype'
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
  const pageUrl = writeProbePage()
  await wc.loadURL(pageUrl)

  wc.debugger.attach('1.3')
  await wc.debugger.sendCommand('Page.enable')

  const failures = []
  const rows = []

  try {
    // 注入前的基线：先记下原生值，用来证明「改之前不是这样」
    const byId = (id) => PROBES.find((p) => p.id === id)
    const before = await evaluate(wc, byId('getter-toString').expr)
    const beforeHooks = await evaluate(wc, byId('enumerable-hooks').expr)

    // 原生 arity 基线 —— 必须在注入前拍，之后再也拿不到
    const tableLit = extractMaskTable(src)
    const beforeArity = tableLit ? await evaluate(wc, arityExpr(tableLit)) : []

    await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: src })
    // 重新加载同一个页面，让新文档注入生效
    await wc.loadURL(pageUrl)

    for (const p of PROBES) {
      const actual = await evaluate(wc, p.expr)
      const pass = JSON.stringify(actual) === JSON.stringify(p.expect)
      rows.push({ id: p.id, expect: p.expect, actual, pass })
      if (!pass) failures.push(p.id)
    }

    // 台账自检 + arity 比对
    if (!tableLit) {
      rows.push({ id: 'mask-inventory', expect: [], actual: '<找不到 _MASK_TABLE>', pass: false })
      failures.push('mask-inventory')
    } else {
      const misses = await checkMaskInventory(wc, tableLit)
      rows.push({ id: 'mask-inventory', expect: [], actual: misses, pass: misses.length === 0 })
      if (misses.length > 0) failures.push('mask-inventory')

      const afterArity = await evaluate(wc, arityExpr(tableLit))
      const drift = []
      for (let i = 0; i < beforeArity.length; i++) {
        if (beforeArity[i] !== afterArity[i]) {
          drift.push(`${beforeArity[i]} → ${afterArity[i]}`)
        }
      }
      rows.push({ id: 'arity-preserved', expect: [], actual: drift, pass: drift.length === 0 })
      if (drift.length > 0) failures.push('arity-preserved')
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

/**
 * 从生成的注入脚本里抽出 _MASK_TABLE 的数组字面量。
 *
 * 不在探针里另抄一份表：两份必然漂移，而漂移的结果正是「某处静默没被检查」。
 */
function extractMaskTable(src) {
  const m = /_MASK_TABLE\s*=\s*(\[[\s\S]*?\n\s*\]);/.exec(src)
  return m ? m[1] : null
}

/**
 * 在页面里把 _MASK_TABLE 求值，输出「行号:属性名:length」的扁平列表。
 *
 * 用「patch 前的长度」做基线，patch 后对比 —— 这是唯一能证明
 * 包装函数没有把原生 arity 改掉的证据。收口时读 d.value.length 是假修：
 * 那一刻 d.value 已经是包装本身了。
 */
function arityExpr(lit) {
  return `(function () {
    var T = ${lit};
    var out = [];
    for (var i = 0; i < T.length; i++) {
      var obj = T[i][0], names = T[i][1];
      if (!obj) { continue; }
      for (var n = 0; n < names.length; n++) {
        var d = null;
        try { d = Object.getOwnPropertyDescriptor(obj, names[n]); } catch (e) {}
        if (!d || typeof d.value !== 'function') { continue; }
        out.push(i + ':' + names[n] + ':' + d.value.length);
      }
    }
    return out;
  })()`
}

/**
 * 台账自检：_MASK_TABLE 里每一条登记，必须真的是那个对象的 own property。
 *
 * 为什么需要：`_maskAt` 拿不到描述符就 `return`，而且整段套在 try/catch 里 ——
 * 登记一个不存在的属性**完全没有任何症状**：不报错、不影响功能、探针也绿，
 * 但那一处从来没被伪装过。用 getOwnPropertyDescriptor 而不是 `in`：
 * 后者沿原型链，能查到也算「登记了但不生效」。
 */
async function checkMaskInventory(wc, lit) {
  return evaluate(
    wc,
    `(function () {
      var T = ${lit};
      var miss = [];
      for (var i = 0; i < T.length; i++) {
        var obj = T[i][0], names = T[i][1];
        if (!obj) { miss.push(i + ':owner-missing'); continue; }
        for (var n = 0; n < names.length; n++) {
          var d = null;
          try { d = Object.getOwnPropertyDescriptor(obj, names[n]); } catch (e) {}
          if (!d) { miss.push(i + '.' + names[n] + ':prop-missing'); }
        }
      }
      return miss;
    })()`
  )
}
