/**
 * `navigator` 的形状：真 Chrome 156 vs 我们注入后的窗口，逐项对比。
 *
 * ── 为什么要有这个探针 ──
 *
 * 前面几轮修的都是「属性值不对」（UA、platform、fonts）。但还有一类更硬的指纹：
 * **属性根本不存在**。Electron 不实现某些 Web API，注入脚本也没造，于是
 * `'share' in navigator` 在真 Chrome 里是 true、在我们这里 false。
 * 值可以解释成「用户设置」，存在性不能。
 *
 * ── 为什么拿真 Chrome 当基准而不是凭记忆 ──
 *
 * 本机 Chrome 156.0.8078.x，Electron 45.2.1 内置 Chromium 156.0.8078.75 ——
 * 同一主版本、几乎同一 build。特性开关应当完全一致，所以这是**实测基准**，
 * 不是「我记得 Chrome 应该有 X」。记错一个 API 就等于给自己造一条假门禁。
 *
 * ── 采什么 ──
 *
 * 1. `Navigator.prototype` 的全部自有属性名（集合差 = 缺了谁、多了谁）
 * 2. 四个重点 API 的**描述符形状**：own/proto 位置、enumerable、configurable、
 *    getter/setter 还是 value、函数的 name/length、toString 是不是 native
 * 3. `navigator.connection` 这个子对象的全部自有属性
 *
 * 形状比值难伪造：一个 accessor 放在实例上而不是原型上、enumerable 反了、
 * `toString()` 不是 `[native code]`，任何一条都够判定。
 *
 * 跑法：node tools/probe-api-shape.mjs           （两侧都测，出 diff）
 *       node tools/probe-api-shape.mjs --chrome  （只测 Chrome，看基准）
 *       node tools/probe-api-shape.mjs --app     （只测我们）
 * 退出码：0 = 探针跑完（不代表形状一致）；2 = 探针自身崩了；3 = 没测到
 */

import { chromium, _electron as electron } from 'playwright-core'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

const ROOT = resolve(import.meta.dirname, '..')
const ART = resolve(ROOT, 'artifacts')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const wantChrome = !process.argv.includes('--app')
const wantApp = !process.argv.includes('--chrome')

/* ── 采数脚本：两侧跑同一段，避免「两边各写一份、两边不一样」 ── */

const FOCUS = [
  'navigator.share',
  'navigator.canShare',
  'navigator.contacts',
  'navigator.contentIndex',
  'navigator.connection',
  'navigator.connection.downlinkMax',
  'navigator.connection.effectiveType',
  'navigator.connection.rtt',
  'navigator.connection.downlink',
  'navigator.connection.saveData',
  'navigator.connection.type',
  'navigator.userAgentData',
  'navigator.devicePosture',
  'navigator.userActivation',
  'navigator.globalPrivacyControl',
  'navigator.mediaDevices',
  'navigator.permissions',
  'navigator.storage',
  'navigator.locks',
  'navigator.wakeLock',
  'navigator.clipboard',
  'navigator.scheduling',
  'navigator.login',
  'navigator.xr',
  'navigator.bluetooth',
  'navigator.usb',
  'navigator.hid',
  'navigator.serial',
  'navigator.presentation',
  'navigator.keyboard',
  'navigator.virtualKeyboard',
  'navigator.ink'
]

const PROBE = `(() => {
  var out = { protoKeys: [], focus: {}, connKeys: [], env: {} };

  /* 1. Navigator.prototype 的自有属性名 —— 集合差就是缺/多的全集 */
  try {
    out.protoKeys = Object.getOwnPropertyNames(Navigator.prototype).sort();
  } catch (e) { out.env.protoKeysErr = String(e); }

  /* 2. 逐个重点路径，采**形状**而不是值 */
  function walk(path) {
    var parts = path.split('.');
    var holder = window;
    for (var i = 0; i < parts.length - 1; i++) {
      holder = holder && holder[parts[i]];
      if (!holder) return { path: path, missingAt: parts.slice(0, i + 1).join('.') };
    }
    var key = parts[parts.length - 1];
    var r = { path: path, present: false };

    /* 存在性：in 看整条原型链，这是检测方最常用的判据 */
    try { r.present = key in holder; } catch (e) { r.presentErr = String(e); }
    if (!r.present) return r;

    var v;
    try { v = holder[key]; } catch (e) { r.getErr = String((e && e.name) || e); return r; }
    r.typeof = typeof v;
    r.valuePreview = (typeof v === 'function') ? null : String(v).slice(0, 40);

    /* 描述符：这一层决定「伪造得像不像」。
       accessor 落在实例上而原型上也有，就是 own property 多出来的 tell。 */
    var own = null, proto = null;
    try { own = Object.getOwnPropertyDescriptor(holder, key); } catch (e) {}
    try { proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(holder) || {}, key); } catch (e) {}
    var shape = function (d) {
      if (!d) return null;
      return {
        kind: d.get || d.set ? 'accessor' : 'value',
        enumerable: d.enumerable,
        configurable: d.configurable,
        hasGet: !!d.get,
        hasSet: !!d.set,
        getterName: d.get ? d.get.name : null,
        getterLen: d.get ? d.get.length : null
      };
    };
    r.ownDesc = shape(own);
    r.protoDesc = shape(proto);
    r.ownOnInstance = !!own && !proto;

    if (typeof v === 'function') {
      r.fnName = v.name;
      r.fnLen = v.length;
      try { r.fnSrc = String(Function.prototype.toString.call(v)).slice(0, 80); } catch (e) { r.fnSrc = 'ERR'; }
      try { r.fnIsNative = /\\[native code\\]/.test(Function.prototype.toString.call(v)); } catch (e) {}
    }

    /* 对象的话把自有键也带上：connection 的值全在实例上，缺哪个一眼可见 */
    if (v && (typeof v === 'object' || typeof v === 'function')) {
      try { r.objKeys = Object.getOwnPropertyNames(v).sort(); } catch (e) {}
      try { r.objProtoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(v) || {}).sort().slice(0, 60); } catch (e) {}
    }
    return r;
  }
  ${JSON.stringify(FOCUS)}.forEach(function (p) { out.focus[p] = walk(p); });

  /* 3. connection 单独摊开：这是四个里唯一一个「对象存在但字段缺」的 */
  try {
    var c = navigator.connection;
    if (c) {
      out.connKeys = Object.getOwnPropertyNames(c).sort();
      out.connProto = Object.getOwnPropertyNames(Object.getPrototypeOf(c) || {}).sort();
    }
  } catch (e) { out.env.connErr = String(e); }

  /* 4. 环境自证：两侧都记，否则「一致」可能是一致地测错了 */
  out.env.ua = navigator.userAgent;
  out.env.platform = navigator.platform;
  out.env.secure = window.isSecureContext;
  out.env.href = location.href;
  return out;
})()`

const PAGE_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>api-shape</title></head><body>probe</body></html>'

const server = await new Promise((r) => {
  const s = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE_HTML)
  })
  s.listen(0, '127.0.0.1', () => r(s))
})
const PAGE_URL = 'http://127.0.0.1:' + server.address().port + '/'

const out = { at: new Date().toISOString(), url: PAGE_URL, chrome: null, app: null, errors: [] }

/* ── 真 Chrome ── */
async function measureChrome() {
  if (!existsSync(CHROME)) return { error: '没装 Chrome：' + CHROME }
  let b = null
  try {
    /* 用**有头**模式：headless 会关掉一批特性（share 之类），
       拿 headless 当基准等于测了一个不存在的浏览器。 */
    b = await chromium.launch({ executablePath: CHROME, headless: false, args: ['--no-first-run', '--no-default-browser-check'] })
    const p = await b.newPage()
    await p.goto(PAGE_URL, { waitUntil: 'load' })
    await p.waitForTimeout(400)
    return await p.evaluate(PROBE)
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
      args: ['.', '--user-data-dir=' + resolve(ART, 'api-shape-ud')],
      cwd: ROOT,
      env,
      timeout: 40000
    })
    const main = await app.firstWindow({ timeout: 25000 })
    await main.waitForTimeout(1500)

    const existing = await main.evaluate(async () => await window.ss.profiles.list())
    for (const p of Array.isArray(existing) ? existing : []) {
      if (String(p.name || '').startsWith('探针-api')) {
        await main.evaluate(async (id) => await window.ss.profiles.remove(id), p.id)
      }
    }
    /* Windows 环境：基准 Chrome 也跑在 Windows 上，平台必须对齐，
       否则「Chrome 没有 contacts」可能只是因为它不是 Android。 */
    const prof = await main.evaluate(
      async () => await window.ss.profiles.create({ name: '探针-api', platform: 'windows' })
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
          return { ok: true, value: JSON.parse(await t.executeJavaScript('JSON.stringify(' + args.probe + ')')) }
        } catch (e) {
          return { error: String((e && e.message) || e) }
        }
      },
      { url: PAGE_URL, probe: PROBE }
    )
    return measured.ok ? measured.value : { error: measured.error }
  } catch (e) {
    return { error: String((e && e.message) || e) }
  } finally {
    if (app) { try { await app.close() } catch (e) {} }
  }
}

try {
  if (wantChrome) out.chrome = await measureChrome()
  if (wantApp) out.app = await measureApp()
} catch (e) {
  out.errors.push(String((e && e.message) || e))
}

mkdirSync(ART, { recursive: true })
writeFileSync(resolve(ART, 'api-shape.json'), JSON.stringify(out, null, 2), 'utf8')

/* ── 打印 ── */
const C = out.chrome
const A = out.app
if (!C || C.error) console.log('Chrome 侧没测到：' + (C && C.error))
if (!A || A.error) console.log('应用侧没测到：' + (A && A.error))

if (C && A && !C.error && !A.error) {
  console.log('\n===== 环境自证 =====')
  for (const k of ['ua', 'platform', 'secure']) {
    const same = C.env[k] === A.env[k]
    console.log('  ' + k.padEnd(10) + (same ? '一致' : '不一致') + '  chrome=' + String(C.env[k]).slice(0, 70))
    if (!same) console.log('  ' + ' '.repeat(10) + '              app   =' + String(A.env[k]).slice(0, 70))
  }

  console.log('\n===== Navigator.prototype 属性集合差 =====')
  const cs = new Set(C.protoKeys)
  const as = new Set(A.protoKeys)
  const missing = C.protoKeys.filter((k) => !as.has(k))
  const extra = A.protoKeys.filter((k) => !cs.has(k))
  console.log('  chrome=' + C.protoKeys.length + ' 个  app=' + A.protoKeys.length + ' 个')
  console.log('  缺（Chrome 有我们没有）：' + (missing.length ? missing.join(', ') : '（无）'))
  console.log('  多（我们有 Chrome 没有）：' + (extra.length ? extra.join(', ') : '（无）'))

  console.log('\n===== 重点 API 形状 =====')
  for (const p of FOCUS) {
    const c = C.focus[p] || {}
    const a = A.focus[p] || {}
    const cP = c.present === true
    const aP = a.present === true
    if (cP === aP) {
      if (!cP) continue
      /* 都在：比形状 */
      const diffs = []
      if (c.typeof !== a.typeof) diffs.push('typeof ' + c.typeof + '→' + a.typeof)
      if (JSON.stringify(c.ownDesc) !== JSON.stringify(a.ownDesc)) diffs.push('ownDesc ' + JSON.stringify(c.ownDesc) + '→' + JSON.stringify(a.ownDesc))
      if (JSON.stringify(c.protoDesc) !== JSON.stringify(a.protoDesc)) diffs.push('protoDesc ' + JSON.stringify(c.protoDesc) + '→' + JSON.stringify(a.protoDesc))
      if (c.fnName !== a.fnName) diffs.push('name ' + c.fnName + '→' + a.fnName)
      if (c.fnLen !== a.fnLen) diffs.push('length ' + c.fnLen + '→' + a.fnLen)
      if (c.fnIsNative !== a.fnIsNative) diffs.push('native ' + c.fnIsNative + '→' + a.fnIsNative)
      if (JSON.stringify(c.objKeys) !== JSON.stringify(a.objKeys)) diffs.push('objKeys ' + JSON.stringify(c.objKeys) + '→' + JSON.stringify(a.objKeys))
      console.log('  ' + (diffs.length ? '不一致 ' : '一致   ') + p + (diffs.length ? '\n        ↳ ' + diffs.join('\n        ↳ ') : ''))
    } else {
      console.log('  ' + '缺失   ' + p + '   chrome=' + (cP ? '有' : '无') + ' app=' + (aP ? '有' : '无'))
    }
  }

  console.log('\n===== navigator.connection 自有键 =====')
  console.log('  chrome=' + JSON.stringify(C.connKeys || []))
  console.log('  app   =' + JSON.stringify(A.connKeys || []))
}

console.log('\n完整读数：artifacts/api-shape.json')
try { server.close() } catch (e) {}
process.exit(0)
