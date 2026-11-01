/**
 * `navigator.share` / `navigator.canShare` 的门禁：拿**同版本真 Chrome** 当基准，
 * 逐条比对「存在性 + 描述符 + toString + 行为」。
 *
 * ── 为什么这条门禁必须存在 ──
 *
 * 这两个 API 是全脚本唯一「凭空创建属性」的地方（见 fingerprint.ts 里那段注释）。
 * 别的伪装改的是**已有属性的值**，改错了顶多是值不对；这两个是从零造出来的，
 * 造错了就是「真浏览器没有、我们有」—— 那比漏掉更糟，因为它同时证明了
 * 有人在伪装。
 *
 * 所以判据不能是「我们觉得自己像」，必须是**外部基准**：
 * 本机 Chrome 156.0.8078.x 与 Electron 45.2.1 内置的 Chromium 156.0.8078.75
 * 同主版本，特性开关应当完全一致。拿它当基准 = 实测，不是印象。
 *
 * ── 比对哪几层 ──
 *
 *   形状：在不在、在原型还是实例、enumerable/configurable/writable、
 *         name/length、toString 是不是 [native code]、自有键集合
 *   行为：46 个调用各自的返回/抛错 —— 注意 canShare 的转换错误是**同步抛**、
 *         share 的是 **rejected promise**，同一个错误在两边语义不同
 *   边界：worker 里必须**没有**（Web Share 是 [Exposed=Window]，
 *         在 worker 里造一个就是新的 tell）
 *
 * ── 跑法 ──
 *
 *   node tools/verify-share.mjs                 两侧都测并比对（门禁）
 *   node tools/verify-share.mjs --chrome-only   只打真 Chrome 的基准读数
 * 退出码：0 = 全部一致；1 = 有差异；2 = 脚本自身崩了；3 = 有一侧没测到
 *
 * ── 已知边界（不是漏了，是做不到） ──
 *
 * 基准只有 **Windows** 这一份 —— 本机只装了 Windows 版 Chrome，macOS / Linux
 * 的 Chrome 拿不到。实现里三个平台统一创建 share / canShare，所以 macOS / Linux
 * 两条路径**未测量**。要消除这个风险，得在那两个平台上各跑一次本脚本。
 * 探针跑不起来时会 exit 3（未测量），不会当成通过。
 */

import { chromium, _electron as electron } from 'playwright-core'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'

const ROOT = resolve(import.meta.dirname, '..')
const ART = resolve(ROOT, 'artifacts')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const chromeOnly = process.argv.includes('--chrome-only')

const server = await new Promise((r) => {
  const s = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>share</title></head><body>x</body></html>')
  })
  s.listen(0, '127.0.0.1', () => r(s))
})
const PAGE_URL = 'http://127.0.0.1:' + server.address().port + '/'

/* 两侧跑**同一段**脚本。分开写两份必然漂移，而漂移的表现是「一边测了 A 一边测了 B」，
   比对结果全绿却什么都没验证。 */
const BEHAVE = `(async () => {
  var R = {};

  /* 每一项都记「同步抛 / 返回 promise 后 settle」—— 这两者在检测方眼里完全不同：
     try/catch 抓得到同步抛，抓不到 rejected promise。 */
  function call(fn, label) {
    return (async function () {
      var p;
      try { p = fn(); } catch (e) {
        return { label: label, mode: 'sync-throw', name: e && e.name, message: String(e && e.message) };
      }
      if (!p || typeof p.then !== 'function') {
        return { label: label, mode: 'returned', value: p, typeof: typeof p };
      }
      try {
        var v = await p;
        return { label: label, mode: 'resolved', value: (v === undefined ? 'undefined' : String(v)) };
      } catch (e) {
        return { label: label, mode: 'rejected', name: e && e.name, message: String(e && e.message) };
      }
    })();
  }

  var mkFile = function (name, type) { return new File(['abc'], name, { type: type }); };

  var cases = [
    /* 存在性与空值 */
    ['canShare()', function () { return navigator.canShare(); }],
    ['canShare({})', function () { return navigator.canShare({}); }],
    ['canShare(null)', function () { return navigator.canShare(null); }],
    ['canShare(undefined)', function () { return navigator.canShare(undefined); }],
    ['canShare("str")', function () { return navigator.canShare('str'); }],
    ['canShare(1)', function () { return navigator.canShare(1); }],
    ['canShare(true)', function () { return navigator.canShare(true); }],
    ['canShare({foo:1})', function () { return navigator.canShare({ foo: 1 }); }],

    /* title / text 的「存在性而非非空性」 */
    ['canShare({title})', function () { return navigator.canShare({ title: 'x' }); }],
    ['canShare({title:""})', function () { return navigator.canShare({ title: '' }); }],
    ['canShare({title:null})', function () { return navigator.canShare({ title: null }); }],
    ['canShare({text})', function () { return navigator.canShare({ text: 'x' }); }],

    /* url 的协议白名单 —— 只认 http/https，且判据是解析后的协议不是字面量 */
    ['canShare({url:same})', function () { return navigator.canShare({ url: location.href }); }],
    ['canShare({url:https})', function () { return navigator.canShare({ url: 'https://example.com/' }); }],
    ['canShare({url:relative})', function () { return navigator.canShare({ url: '/foo' }); }],
    ['canShare({url:protocol-rel})', function () { return navigator.canShare({ url: '//example.com/x' }); }],
    ['canShare({url:empty})', function () { return navigator.canShare({ url: '' }); }],
    ['canShare({url:userinfo})', function () { return navigator.canShare({ url: 'https://u:p@example.com/' }); }],
    ['canShare({url:javascript})', function () { return navigator.canShare({ url: 'javascript:alert(1)' }); }],
    ['canShare({url:data})', function () { return navigator.canShare({ url: 'data:text/html,x' }); }],
    ['canShare({url:file})', function () { return navigator.canShare({ url: 'file:///C:/x.txt' }); }],
    ['canShare({url:ftp})', function () { return navigator.canShare({ url: 'ftp://example.com/' }); }],
    ['canShare({url:mailto})', function () { return navigator.canShare({ url: 'mailto:a@b.c' }); }],
    ['canShare({url:tel})', function () { return navigator.canShare({ url: 'tel:+123' }); }],
    ['canShare({url:about:blank})', function () { return navigator.canShare({ url: 'about:blank' }); }],

    /* files：非空即 true（不按类型过滤），空数组 false，不可迭代 / 元素非 File 抛错 */
    ['canShare({files:txt})', function () { return navigator.canShare({ files: [mkFile('a.txt', 'text/plain')] }); }],
    ['canShare({files:unknown})', function () { return navigator.canShare({ files: [mkFile('a.zzz', 'application/x-zzz')] }); }],
    ['canShare({files:html})', function () { return navigator.canShare({ files: [mkFile('a.html', 'text/html')] }); }],
    ['canShare({files:two})', function () { return navigator.canShare({ files: [mkFile('a.txt', 'text/plain'), mkFile('b.txt', 'text/plain')] }); }],
    ['canShare({files:[]})', function () { return navigator.canShare({ files: [] }); }],
    ['canShare({files:notFile})', function () { return navigator.canShare({ files: ['str'] }); }],
    ['canShare({files:notArray})', function () { return navigator.canShare({ files: mkFile('a.txt', 'text/plain') }); }],
    ['canShare({title,files})', function () { return navigator.canShare({ title: 'x', files: [mkFile('a.txt', 'text/plain')] }); }],

    /* share：arity 敏感（无参 TypeError / 显式 undefined 走激活检查） */
    ['share()', function () { return navigator.share(); }],
    ['share(undefined)', function () { return navigator.share(undefined); }],
    ['share(null)', function () { return navigator.share(null); }],
    ['share({})', function () { return navigator.share({}); }],
    ['share("str")', function () { return navigator.share('str'); }],
    ['share(1)', function () { return navigator.share(1); }],
    ['share({title})', function () { return navigator.share({ title: 'x' }); }],
    ['share({url:https})', function () { return navigator.share({ url: 'https://example.com/' }); }],
    ['share({url:javascript})', function () { return navigator.share({ url: 'javascript:alert(1)' }); }],
    ['share({files:txt})', function () { return navigator.share({ files: [mkFile('a.txt', 'text/plain')] }); }],
    ['share({files:[]})', function () { return navigator.share({ files: [] }); }],
    ['share({foo:1})', function () { return navigator.share({ foo: 1 }); }],
    ['share({files:notFile})', function () { return navigator.share({ files: ['str'] }); }],
    ['share({files:notArray})', function () { return navigator.share({ files: mkFile('a.txt', 'text/plain') }); }]
  ];

  R.cases = [];
  for (var i = 0; i < cases.length; i++) {
    R.cases.push(await call(cases[i][1], cases[i][0]));
  }

  /* 函数身份 / 枚举：原型上的数据属性 vs 实例上的 own property，差一步就露 */
  R.identity = {
    shareStable: navigator.share === navigator.share,
    canShareStable: navigator.canShare === navigator.canShare,
    shareIsOwnOfNavigator: Object.prototype.hasOwnProperty.call(navigator, 'share'),
    canShareIsOwnOfNavigator: Object.prototype.hasOwnProperty.call(navigator, 'canShare'),
    shareInKeys: Object.keys(navigator).indexOf('share') >= 0,
    shareInForIn: (function () { for (var k in navigator) { if (k === 'share') return true; } return false; })()
  };

  /* 描述符的 writable 也要对 —— 检测方读一次 getOwnPropertyDescriptor 就能看出来 */
  var dS = Object.getOwnPropertyDescriptor(Navigator.prototype, 'share');
  var dC = Object.getOwnPropertyDescriptor(Navigator.prototype, 'canShare');
  R.descriptor = {
    share: dS ? { writable: dS.writable, enumerable: dS.enumerable, configurable: dS.configurable } : null,
    canShare: dC ? { writable: dC.writable, enumerable: dC.enumerable, configurable: dC.configurable } : null
  };
  R.fnMeta = {
    share: { name: navigator.share && navigator.share.name, length: navigator.share && navigator.share.length,
             src: navigator.share ? String(Function.prototype.toString.call(navigator.share)) : null },
    canShare: { name: navigator.canShare && navigator.canShare.name, length: navigator.canShare && navigator.canShare.length,
                src: navigator.canShare ? String(Function.prototype.toString.call(navigator.canShare)) : null }
  };

  /* worker 里必须**没有**：Web Share 是 [Exposed=Window]。
     在 worker 里也造一个，就是造一个真 Chrome 没有的属性 —— 新的 tell。 */
  R.worker = await new Promise(function (resolve) {
    try {
      var src = 'postMessage({ share: typeof navigator.share, canShare: typeof navigator.canShare, hasShare: ("share" in navigator) })';
      var w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = function (e) { resolve(e.data) };
      w.onerror = function (e) { resolve({ err: String((e && e.message) || e) }) };
      setTimeout(function () { resolve({ err: 'timeout' }) }, 3000);
    } catch (e) { resolve({ err: String(e) }) }
  });

  R.env = { ua: navigator.userAgent, platform: navigator.platform, secure: window.isSecureContext };
  R.activation = { isActive: !!(navigator.userActivation && navigator.userActivation.isActive) };
  return R;
})()`

/* ── 真 Chrome ── */
async function measureChrome() {
  if (!existsSync(CHROME)) return { error: '没装 Chrome：' + CHROME }
  let b = null
  try {
    /* 有头模式：headless 会关掉一批特性，拿 headless 当基准等于测了个不存在的浏览器 */
    b = await chromium.launch({ executablePath: CHROME, headless: false, args: ['--no-first-run', '--no-default-browser-check'] })
    const p = await b.newPage()
    await p.goto(PAGE_URL, { waitUntil: 'load' })
    await p.waitForTimeout(300)
    return await p.evaluate(BEHAVE)
  } catch (e) {
    return { error: String((e && e.message) || e) }
  } finally {
    if (b) { try { await b.close() } catch (e) {} }
  }
}

/* ── 我们注入后的窗口 ── */
async function measureApp() {
  const env = { ...process.env, NODE_ENV: 'production' }
  delete env.ELECTRON_RUN_AS_NODE
  let app = null
  try {
    app = await electron.launch({
      executablePath: resolve(ROOT, 'node_modules/electron/dist/electron.exe'),
      args: ['.', '--user-data-dir=' + resolve(ART, 'share-ud')],
      cwd: ROOT,
      env,
      timeout: 40000
    })
    const main = await app.firstWindow({ timeout: 25000 })
    await main.waitForTimeout(1500)

    const existing = await main.evaluate(async () => await window.ss.profiles.list())
    for (const p of Array.isArray(existing) ? existing : []) {
      if (String(p.name || '').startsWith('验收-share')) {
        await main.evaluate(async (id) => await window.ss.profiles.remove(id), p.id)
      }
    }
    /* Windows 环境：基准 Chrome 也跑在 Windows 上。平台必须对齐 ——
       Web Share 的暴露是 Blink runtime feature（平台无关），但行为基准只有 Windows 这份。 */
    const prof = await main.evaluate(
      async () => await window.ss.profiles.create({ name: '验收-share', platform: 'windows' })
    )
    if (!prof || !prof.id) return { error: '建环境失败' }

    await main.evaluate(async (id) => await window.ss.profiles.launch(id), prof.id)
    await main.waitForTimeout(6000)

    const measured = await app.evaluate(
      async ({ BrowserWindow }, args) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        const findWc = () => {
          const win = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('role=browser'))
          if (!win) return null
          const child = win.contentView.children[0]
          return child ? child.webContents : null
        }
        let wc = findWc()
        if (!wc) return { error: '找不到浏览器窗口' }
        for (let i = 0; i < 12; i++) {
          wc = findWc()
          if (!wc) return { error: '找不到 webContents' }
          if (wc.getURL().startsWith(args.url) && !wc.isLoading()) break
          try { wc.stop() } catch (e) {}
          try { await wc.loadURL(args.url) } catch (e) {}
          await sleep(500)
        }
        /* 注入是「发现 → attach → 注入」，要给它时间落地 */
        await sleep(2500)
        const t = findWc()
        if (!t) return { error: 'webContents 已消失' }
        try {
          return { ok: true, value: await t.executeJavaScript(args.probe) }
        } catch (e) {
          return { error: String((e && e.message) || e) }
        }
      },
      { url: PAGE_URL, probe: BEHAVE }
    )
    return measured.ok ? measured.value : { error: measured.error }
  } catch (e) {
    return { error: String((e && e.message) || e) }
  } finally {
    if (app) { try { await app.close() } catch (e) {} }
  }
}

const out = { at: new Date().toISOString(), url: PAGE_URL, chrome: null, app: null, gates: [], diffs: [] }
const finish = (code, msg) => {
  if (msg) console.log('\n' + msg)
  out.at = new Date().toISOString()
  mkdirSync(ART, { recursive: true })
  writeFileSync(resolve(ART, 'share.json'), JSON.stringify(out, null, 2), 'utf8')
  try { server.close() } catch (e) {}
  console.log('\n完整读数：artifacts/share.json')
  process.exit(code)
}

let C = null
try {
  C = await measureChrome()
} catch (e) {
  C = { error: String((e && e.message) || e) }
}
out.chrome = C

if (chromeOnly) {
  if (C.error) finish(3, 'Chrome 没测到：' + C.error)
  console.log('\n===== 真 Chrome · navigator.share / canShare 基准 =====\n')
  for (const c of C.cases) {
    const v =
      c.mode === 'sync-throw' ? '同步抛 ' + c.name + ': ' + c.message
        : c.mode === 'rejected' ? 'rejected ' + c.name + ': ' + c.message
          : c.mode === 'resolved' ? 'resolved ' + c.value
            : 'returned ' + c.value + ' (' + c.typeof + ')'
    console.log('  ' + c.label.padEnd(28) + v)
  }
  console.log('\n[描述符]     ' + JSON.stringify(C.descriptor))
  console.log('[函数元数据] ' + JSON.stringify(C.fnMeta))
  console.log('[身份/枚举]  ' + JSON.stringify(C.identity))
  console.log('[worker]     ' + JSON.stringify(C.worker))
  finish(0)
}

let A = null
try {
  A = await measureApp()
} catch (e) {
  A = { error: String((e && e.message) || e) }
}
out.app = A

if (C.error) finish(3, 'Chrome 侧没测到：' + C.error)
if (A.error) finish(3, '应用侧没测到：' + A.error)

const gate = (label, expected, actual, pass, note) =>
  out.gates.push({ label, expected, actual, pass, note: note || '' })

/* 1. 环境自证：两侧都在安全上下文、同平台，否则后面的比对没有意义 */
gate('两侧都是安全上下文（Web Share 是 [SecureContext]）', true, C.env.secure === true && A.env.secure === true,
  C.env.secure === true && A.env.secure === true, '')
gate('两侧 platform 一致', C.env.platform, A.env.platform, C.env.platform === A.env.platform,
  '基准 Chrome 与我们的环境必须在同一平台，否则「Chrome 没有 contacts」可能只是因为它不是 Android')

/* 2. 形状：描述符 / 函数元数据 / 身份枚举 */
gate('share 描述符一致（writable/enumerable/configurable）', C.descriptor.share, A.descriptor.share,
  JSON.stringify(C.descriptor.share) === JSON.stringify(A.descriptor.share), '')
gate('canShare 描述符一致', C.descriptor.canShare, A.descriptor.canShare,
  JSON.stringify(C.descriptor.canShare) === JSON.stringify(A.descriptor.canShare), '')
gate('share 函数元数据一致（name/length/toString 为 native）', C.fnMeta.share, A.fnMeta.share,
  JSON.stringify(C.fnMeta.share) === JSON.stringify(A.fnMeta.share),
  'toString 不是 [native code] 一行就能判定被 hook')
gate('canShare 函数元数据一致', C.fnMeta.canShare, A.fnMeta.canShare,
  JSON.stringify(C.fnMeta.canShare) === JSON.stringify(A.fnMeta.canShare), '')
gate('函数身份/枚举一致（原型数据属性、非 own、for-in 可见）', C.identity, A.identity,
  JSON.stringify(C.identity) === JSON.stringify(A.identity),
  'accessor 落在实例上、或 Object.keys 能扫到，都是额外的 tell')

/* 3. worker 里必须没有 —— 单独拉出来，因为它是「我们多造了东西」的反向护栏 */
gate('worker 里没有 share / canShare（[Exposed=Window]）', C.worker, A.worker,
  JSON.stringify(C.worker) === JSON.stringify(A.worker),
  'worker 里造一个真 Chrome 没有的属性，比漏掉更糟')

/* 4. 行为：逐个调用比对 mode + name + message + value */
const norm = (c) =>
  JSON.stringify({ mode: c.mode, name: c.name || null, message: c.message || null, value: c.value === undefined ? null : c.value })
let same = 0
for (let i = 0; i < C.cases.length; i++) {
  const c = C.cases[i]
  const a = A.cases[i]
  if (!a) {
    out.diffs.push({ label: c.label, chrome: norm(c), app: '（缺）' })
    continue
  }
  if (norm(c) === norm(a)) same += 1
  else out.diffs.push({ label: c.label, chrome: norm(c), app: norm(a) })
}
gate(`${C.cases.length} 个调用行为逐条一致`, `${C.cases.length}/${C.cases.length}`, `${same}/${C.cases.length}`,
  same === C.cases.length, '差异明细见下方 [行为差异]')

/* ── 打印 ── */
console.log('\n===== navigator.share / canShare 门禁（基准 = 真 Chrome 156）=====\n')
console.log('  宿主平台 ' + C.env.platform + '，两侧 secure=' + C.env.secure + '/' + A.env.secure)

console.log('\n[形状]')
for (const k of ['share', 'canShare']) {
  console.log('  ' + k.padEnd(9) + 'chrome ' + JSON.stringify(C.fnMeta[k]))
  console.log('  ' + ' '.repeat(9) + 'app    ' + JSON.stringify(A.fnMeta[k]))
}
console.log('  描述符    chrome ' + JSON.stringify(C.descriptor))
console.log('  ' + ' '.repeat(9) + 'app    ' + JSON.stringify(A.descriptor))
console.log('  身份/枚举 chrome ' + JSON.stringify(C.identity))
console.log('  ' + ' '.repeat(9) + 'app    ' + JSON.stringify(A.identity))
console.log('  worker    chrome ' + JSON.stringify(C.worker))
console.log('  ' + ' '.repeat(9) + 'app    ' + JSON.stringify(A.worker))

if (out.diffs.length) {
  console.log('\n[行为差异]')
  for (const d of out.diffs) {
    console.log('  ' + d.label)
    console.log('      chrome ' + d.chrome)
    console.log('      app    ' + d.app)
  }
} else {
  console.log('\n[行为差异] 无 —— ' + same + ' 个调用逐条一致')
}

console.log('\n[结论]')
let bad = 0
for (const g of out.gates) {
  if (!g.pass) bad += 1
  console.log('  ' + (g.pass ? '成立  ' : '不成立') + ' ' + g.label)
  if (!g.pass) {
    console.log('        期望 ' + JSON.stringify(g.expected))
    console.log('        实得 ' + JSON.stringify(g.actual))
    if (g.note) console.log('        ↳ ' + g.note)
  }
}

finish(bad > 0 ? 1 : 0, bad > 0 ? `${out.gates.length - bad}/${out.gates.length} 成立，${bad} 条不成立` : `全部 ${out.gates.length} 条成立`)
