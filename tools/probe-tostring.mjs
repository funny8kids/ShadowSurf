/**
 * `Function.prototype.toString` 三种实现的痕迹矩阵（纯测量，不改产品代码）。
 *
 * ── 为什么要有这个探针 ──
 *
 * 交付报告里有一条 skip：「`Function.prototype.toString` 仍是赋值改写，没改成 Proxy」。
 * 评审里来回三次的说法是「改成 Proxy 更干净」—— 但**没有任何读数**支撑它。
 * 按本轮定下的规矩，没有 artifact 的结论不能当前提。所以这里把三种实现
 * （不打补丁 / 赋值改写 / Proxy 包装）放在同一组检测技术下各跑一遍，出矩阵。
 *
 * 注意：这不是「哪种更好」的意见，是「哪种在哪些检查下会露出什么」的读数。
 *
 * ── 三种实现 ──
 *
 *   baseline  不打补丁。作为对照：任何检测技术的「原生值」以它为准。
 *   assign    当前产品的做法：`Function.prototype.toString = _patched`，
 *             `_patched` 用 `{ f(){} }.f` 去掉 prototype，再 `_maskOne` 改
 *             name/length 并登记进 `_masked`；命中 `_masked` 时返回假源码。
 *   proxy     `new Proxy(origToString, { apply })`，命中时返回假源码。
 *
 * ── 六条检测技术（比方案里写的 5 条多一条，因为第 4 条才是决定性的）──
 *
 *   T1 self-proto       `'prototype' in Function.prototype.toString`
 *                       原生 false。裸函数包装器是 true —— 这是最省事的一行检测。
 *   T2 self-source      `Function.prototype.toString.toString()`
 *                       必须恰好是 `function toString() { [native code] }`。
 *   T3 self-name-length `[F.name, F.length]` 必须恰好是 `['toString', 0]`。
 *   T4 ref-orig-source  用**打补丁之前**捕获的原始 toString 去读当前的 F.toString。
 *                       这一条模拟「检测方手里有一份干净参照」的最坏情况
 *                       （例如某个注入没覆盖到的 realm 里留着的引用）。
 *   T5 user-fn-source   页面自己定义的函数，toString 必须返回**真实源码**。
 *                       返回 [native code] 本身就是异常：真实浏览器不会这样。
 *   T6 masked-source    被替换过的 getter（navigator.userAgent）toString 必须是
 *                       `function get userAgent() { [native code] }` —— 即「伪装是否生效」。
 *
 * ── 读法 ──
 *
 * 每一格给「实得值」和判定：`native` = 与 baseline 一致；`LEAK` = 与 baseline 不同，
 * 检测方一行就能看出来。T5/T6 的判定方向相反（T5 要「有源码」，T6 要「没源码」）。
 *
 * 跑法：node tools/run-electron.mjs tools/probe-tostring.mjs
 * 退出码：0 = 测量完成（**不代表哪种实现合格**）；2 = 脚本自身崩了
 */

import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const ART = resolve(ROOT, 'artifacts')

app.disableHardwareAcceleration()

/* ────────────────────────────── 三种实现 ────────────────────────────── */

/** 共享的前置：把 `_masked` / `_noProto` / `_fakeSrc` 准备好，并给出「被替换清单」 */
const PRELUDE = `
  var _masked = [];
  var _fakeSrc = function (nm) { return "function " + nm + "() { [native code] }"; };
  var _noProto = function (fn) {
    try { return { f() { return fn.apply(this, arguments); } }.f; } catch (e) { return fn; }
  };
  var _maskOne = function (fn, nm, len) {
    if (typeof fn !== "function") { return fn; }
    try { Object.defineProperty(fn, "name", { value: nm, configurable: true }); } catch (e) {}
    try { if (typeof len === "number") { Object.defineProperty(fn, "length", { value: len, configurable: true }); } } catch (e) {}
    _masked.push(fn);
    return fn;
  };
  var _targets = function () {
    // 目标 1：navigator.userAgent 的 getter（accessor，名字要带 "get "）
    var ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
    return {
      uaGet: _maskOne(_noProto(function () { return ua; }), "get userAgent", 0),
      gid: _maskOne(_noProto(function () { return _origGID.apply(this, arguments); }), "getImageData", 1)
    };
  };
`

const ASSIGN_SRC = `
(function () {
  ${PRELUDE}
  var _origGID = CanvasRenderingContext2D.prototype.getImageData;
  var t = _targets();
  Object.defineProperty(Navigator.prototype, "userAgent", {
    get: t.uaGet, configurable: true, enumerable: true
  });
  CanvasRenderingContext2D.prototype.getImageData = t.gid;

  // 收口：赋值改写
  var _fts = Function.prototype.toString;
  var _patched = _maskOne(_noProto(function () {
    for (var i = 0; i < _masked.length; i++) {
      if (_masked[i] === this) { return _fakeSrc(String(this.name || "")); }
    }
    return _fts.call(this);
  }), "toString");
  Function.prototype.toString = _patched;
})()
`

const PROXY_SRC = `
(function () {
  ${PRELUDE}
  var _origGID = CanvasRenderingContext2D.prototype.getImageData;
  var t = _targets();
  Object.defineProperty(Navigator.prototype, "userAgent", {
    get: t.uaGet, configurable: true, enumerable: true
  });
  CanvasRenderingContext2D.prototype.getImageData = t.gid;

  // 收口：Proxy 包装
  var _fts = Function.prototype.toString;
  Function.prototype.toString = new Proxy(_fts, {
    apply: function (target, thisArg, args) {
      for (var i = 0; i < _masked.length; i++) {
        if (_masked[i] === thisArg) { return _fakeSrc(String(thisArg.name || "")); }
      }
      return Reflect.apply(target, thisArg, args);
    }
  });
})()
`

const VARIANTS = [
  { id: 'baseline', label: '不打补丁（对照）', src: '' },
  { id: 'assign', label: '赋值改写（当前产品）', src: ASSIGN_SRC },
  { id: 'proxy', label: 'Proxy 包装', src: PROXY_SRC }
]

/* ────────────────────────────── 检测技术 ────────────────────────────── */

/** 在页面里一次性采全部读数，返回纯对象 */
const PROBE_SRC = `
(function () {
  var out = {};
  var F = Function.prototype.toString;

  // T1：裸函数包装器是构造器，原生 toString 不是
  try { out.t1 = { hasPrototype: ("prototype" in F) }; } catch (e) { out.t1 = { error: String(e) }; }

  // T2：它自己看起来像不像原生
  try { out.t2 = { source: F.toString() }; } catch (e) { out.t2 = { error: String(e) }; }

  // T3：name / length
  try { out.t3 = { name: String(F.name), length: F.length }; } catch (e) { out.t3 = { error: String(e) }; }

  // T4：用打补丁**之前**捕获的原始 toString 读当前的 F
  try {
    out.t4 = window.__pristineFTS === undefined
      ? { error: '没有捕获到原始 toString' }
      : { source: window.__pristineFTS.call(F) };
  } catch (e) { out.t4 = { error: String(e) }; }

  // T5：页面自己定义的函数必须能读出真实源码
  try {
    out.t5 = { source: (function probeUserFn(a, b) { return a + b }).toString() };
  } catch (e) { out.t5 = { error: String(e) }; }

  // T6：被替换过的 getter 的 toString（伪装生效性）
  try {
    var d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent');
    out.t6 = { source: d && d.get ? d.get.toString() : null, ua: navigator.userAgent.slice(0, 24) };
  } catch (e) { out.t6 = { error: String(e) }; }

  return out;
})()
`

/** 期望值（以 baseline 为准）与判定方向 */
const NATIVE_TO_STRING = 'function toString() { [native code] }'
const FAKE_UA_GETTER = 'function get userAgent() { [native code] }'

/**
 * 判定。`want` 说明这一格「原生/合格」长什么样。
 * `t5` 的方向是**反的**：它要求读出真实源码，读出 [native code] 才是异常。
 */
function verdicts(readings) {
  const r = readings
  const v = {}
  v.t1 = r.t1 && r.t1.hasPrototype === false ? 'native' : 'LEAK'
  v.t2 = r.t2 && r.t2.source === NATIVE_TO_STRING ? 'native' : 'LEAK'
  v.t3 = r.t3 && r.t3.name === 'toString' && r.t3.length === 0 ? 'native' : 'LEAK'
  v.t4 = r.t4 && r.t4.source === NATIVE_TO_STRING ? 'native' : 'LEAK'
  // T5：必须含真实源码片段
  v.t5 = r.t5 && /probeUserFn/.test(String(r.t5.source)) && /return a \+ b/.test(String(r.t5.source))
    ? 'native'
    : 'LEAK'
  // T6：伪装是否生效（不是「有没有痕迹」，是「有没有骗过」）
  v.t6 = r.t6 && r.t6.source === FAKE_UA_GETTER ? 'masked' : 'EXPOSED'
  return v
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

const out = { at: null, variants: [], failures: [] }

async function runVariant(win, variant) {
  // 每个变体都从干净页面开始：上一个变体的补丁不能残留
  await win.loadURL(PAGE_URL)
  await win.webContents.executeJavaScript(
    // T4 的「干净参照」必须在打补丁**之前**捕获
    'window.__pristineFTS = Function.prototype.toString; true'
  )
  if (variant.src !== '') {
    await win.webContents.executeJavaScript(variant.src + '; true')
  }
  const readings = await win.webContents.executeJavaScript(PROBE_SRC)
  return { id: variant.id, label: variant.label, readings, verdict: verdicts(readings) }
}

let PAGE_URL = ''
function writeProbePage() {
  mkdirSync(ART, { recursive: true })
  const file = resolve(ART, 'probe-tostring.html')
  writeFileSync(
    file,
    '<!doctype html><html><head><meta charset="utf-8"><title>tostring-probe</title></head>' +
      '<body><canvas id="c" width="8" height="8"></canvas></body></html>',
    'utf8'
  )
  return 'file:///' + file.replace(/\\/g, '/')
}

/**
 * ── 为什么不用 top-level await 等 `whenReady()` ──
 *
 * 实测：ESM 主进程里 `await app.whenReady()` 会**死锁** —— Electron 等入口模块
 * 求值完成才开始 app 生命周期，而模块在等 ready。现象是进程静默挂住、零输出。
 * 换成 `.then()` 之后正常。这个坑不写下来，下一个人还会踩一遍。
 */
app.whenReady().then(async () => {
  try {
    PAGE_URL = writeProbePage()
    const win = new BrowserWindow({ show: false, width: 800, height: 600 })
    for (const variant of VARIANTS) {
      try {
        out.variants.push(await runVariant(win, variant))
      } catch (err) {
        out.failures.push(`${variant.id}：${String((err && err.message) || err)}`)
      }
    }
    win.destroy()
  } catch (err) {
    out.failures.push('脚本自身异常：' + String((err && err.message) || err))
  } finally {
    out.at = new Date().toISOString()
    mkdirSync(ART, { recursive: true })
    writeFileSync(resolve(ART, 'probe-tostring.json'), JSON.stringify(out, null, 2), 'utf8')
  }
  printMatrix()
  process.exit(out.failures.length > 0 ? 2 : 0)
})

/* ────────────────────────────── 打印矩阵 ────────────────────────────── */

function printMatrix() {
  const TECH = [
    { key: 't1', name: 'T1 self-proto', want: "'prototype' in F === false" },
    { key: 't2', name: 'T2 self-source', want: NATIVE_TO_STRING },
    { key: 't3', name: 'T3 self-name-length', want: "name='toString' length=0" },
    { key: 't4', name: 'T4 ref-orig-source', want: NATIVE_TO_STRING },
    { key: 't5', name: 'T5 user-fn-source', want: '含真实源码' },
    { key: 't6', name: 'T6 masked-source', want: FAKE_UA_GETTER }
  ]

  const show = (x) => {
    if (x === null || x === undefined) return String(x)
    const s = typeof x === 'string' ? x : JSON.stringify(x)
    return s.length > 58 ? s.slice(0, 55) + '…' : s
  }

  console.log('\n===== Function.prototype.toString 痕迹矩阵 =====\n')
  console.log('每格：判定 + 实得值。native=与原生一致 / LEAK=一行就能看出被改过 / masked=伪装生效\n')

  for (const v of out.variants) {
    console.log('── ' + v.id + '  ' + v.label + ' ──')
    for (const t of TECH) {
      const raw = v.readings[t.key]
      const val =
        raw && raw.source !== undefined
          ? raw.source
          : raw && raw.hasPrototype !== undefined
            ? { hasPrototype: raw.hasPrototype }
            : raw && raw.name !== undefined
              ? { name: raw.name, length: raw.length }
              : raw
      console.log('  ' + t.name.padEnd(22) + String(v.verdict[t.key]).padEnd(9) + show(val))
    }
    console.log('')
  }

  console.log('判据（每格期望值）：')
  for (const t of TECH) console.log('  ' + t.name.padEnd(22) + t.want)

  if (out.failures.length > 0) {
    console.log('\n不成立（探针自身）：')
    for (const f of out.failures) console.log('  ✗ ' + f)
  }
  console.log('\n完整读数：artifacts/probe-tostring.json')
}
