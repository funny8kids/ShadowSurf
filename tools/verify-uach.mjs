/**
 * `navigator.userAgentData`（Client Hints）在**四种上下文**里各读到什么。
 *
 * ── 为什么单开一条 ──
 *
 * creepjs 的 Worker 段对一个 **macOS** 环境读到 `Windows 11 [19.0.0]`，
 * 而同一页主世界读到 `macOS 15.0.0`。这是「主世界与 worker 矛盾」——
 * 本轮 AC-14 声称 20 项全等、0 mismatch。两者不可能同时为真。
 *
 * 差别在**采了什么**：
 *   AC-14 的 worker 探针只采 `userAgentData.brands` 与 `userAgentData.platform`
 *   第三方读的是 `getHighEntropyValues(['platformVersion'])`，并且读的是
 *   **顶层**（脚本一执行就读），不是事件期。
 *
 * 所以这里把两个维度都摊开：
 *   上下文：主世界 / dedicated / shared / service worker
 *   时刻：  顶层（脚本刚执行）/ 事件期（message、install）
 *
 * 判据只落在「事件期必须等于主世界」—— 顶层那几格是**读数**，因为
 * service_worker 顶层结构性不可覆盖、shared_worker 顶层是竞态（见
 * `verify-shared-worker-inject.mjs` 的边界说明）。把它们判成 gate 会造出一条
 * 永远红的断言；但把它们**藏起来**，就等于用一个 20 项的绿去盖住一个真实矛盾。
 *
 * 跑法：npm run verify:uach（先 electron-vite build）
 * 退出码：0 = 该判的都成立；1 = 有 gate 不成立；2 = 脚本自身崩了；3 = 没测到
 */

import { _electron as electron } from 'playwright-core'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const ROOT = resolve(import.meta.dirname, '..')
const ART = resolve(ROOT, 'artifacts')

/* 每个上下文都用同一段取数逻辑，避免「四处手写、四处不一样」 */
const READ = `
var R = function () {
  var d = navigator.userAgentData;
  if (!d) return { missing: true };
  return {
    platform: d.platform,
    mobile: d.mobile,
    brands: (d.brands || []).map(function (b) { return b.brand + ' ' + b.version }).join('|'),
    ua: navigator.userAgent
  };
};
var HE = function (cb) {
  var d = navigator.userAgentData;
  if (!d || !d.getHighEntropyValues) { cb(null, 'no-getHighEntropyValues'); return }
  try {
    d.getHighEntropyValues(['platformVersion']).then(function (v) { cb(v.platformVersion || null, null) },
      function (e) { cb(null, String((e && e.name) || e)) });
  } catch (e) { cb(null, String((e && e.name) || e)) }
};
`

const DED_JS = READ + `
var TOP = R();
self.onmessage = function () {
  var now = R();
  HE(function (pv, err) {
    now.platformVersion = pv;
    if (err) now.heErr = err;
    self.postMessage({ top: TOP, now: now });
  });
};
`

const SHARED_JS = READ + `
var TOP = R();
self.onconnect = function (ev) {
  var port = ev.ports[0];
  port.onmessage = function () {
    var now = R();
    HE(function (pv, err) {
      now.platformVersion = pv;
      if (err) now.heErr = err;
      port.postMessage({ top: TOP, now: now });
    });
  };
  port.start();
};
`

const SWC_JS = READ + `
var TOP = R();
var INSTALL = null;
self.addEventListener('install', function () {
  INSTALL = R();
  HE(function (pv, err) { INSTALL.platformVersion = pv; if (err) INSTALL.heErr = err; self.skipWaiting(); });
});
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()) });
self.addEventListener('message', function (ev) {
  var now = R();
  HE(function (pv, err) {
    now.platformVersion = pv;
    if (err) now.heErr = err;
    if (ev.source && ev.source.postMessage) ev.source.postMessage({ top: TOP, install: INSTALL, now: now });
  });
});
`

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>uach</title></head>
<body>
<script>
window.__r = { main: null, ded: null, dedErr: null, shared: null, sharedErr: null, swc: null, swcErr: null };
${READ}
HE(function (pv, err) {
  var m = R();
  m.platformVersion = pv;
  if (err) m.heErr = err;
  window.__r.main = m;
});

/* 延迟 4s 再问：主进程要先「发现 → attach → 注入」，注入完才有伪装值。
   立刻问等于测顶层，而顶层能不能覆盖是另一回事 —— 顶层由 TOP 单独采。 */
try {
  var w = new Worker('/ded.js');
  w.onmessage = function (e) { window.__r.ded = e.data };
  w.onerror = function (e) { window.__r.dedErr = 'err:' + String((e && e.message) || e) };
  setTimeout(function () { try { w.postMessage('go') } catch (e) { window.__r.dedErr = 'post:' + String(e) } }, 4000);
} catch (e) { window.__r.dedErr = 'ctor:' + String(e) }

try {
  var sw = new SharedWorker('/shared.js');
  sw.port.onmessage = function (e) { window.__r.shared = e.data };
  sw.port.onerror = function (e) { window.__r.sharedErr = 'port:' + String((e && e.message) || e) };
  sw.port.start();
  setTimeout(function () { try { sw.port.postMessage('go') } catch (e) { window.__r.sharedErr = 'post:' + String(e) } }, 4000);
} catch (e) { window.__r.sharedErr = 'ctor:' + String(e) }

if (navigator.serviceWorker) {
  navigator.serviceWorker.onmessage = function (e) { window.__r.swc = e.data };
  navigator.serviceWorker.register('/swc.js').then(function () {
    return navigator.serviceWorker.ready;
  }).then(function (reg) {
    var a = reg.active;
    if (!a) { window.__r.swcErr = 'no active worker'; return }
    setTimeout(function () { try { a.postMessage('go') } catch (e) { window.__r.swcErr = 'post:' + String(e) } }, 4000);
  }).catch(function (e) { window.__r.swcErr = 'reg:' + String(e) });
}
</script>
</body></html>
`

const server = await new Promise((r) => {
  const s = createServer((req, res) => {
    const url = (req.url || '/').split('?')[0]
    const body =
      url === '/ded.js' ? DED_JS : url === '/shared.js' ? SHARED_JS : url === '/swc.js' ? SWC_JS : PAGE_HTML
    const type = url.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8'
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(body)
  })
  s.listen(0, '127.0.0.1', () => r(s))
})
const PAGE_URL = 'http://127.0.0.1:' + server.address().port + '/'

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE

const out = { at: null, profile: null, readings: {}, gates: [], notes: [] }
const finish = (code, msg) => {
  if (msg) console.log('\n' + msg)
  out.at = new Date().toISOString()
  mkdirSync(ART, { recursive: true })
  writeFileSync(resolve(ART, 'uach.json'), JSON.stringify(out, null, 2), 'utf8')
  try { server.close() } catch (e) {}
  console.log('\n完整读数：artifacts/uach.json')
  process.exit(code)
}

let app = null
try {
  app = await electron.launch({
    executablePath: resolve(ROOT, 'node_modules/electron/dist/electron.exe'),
    args: ['.', '--user-data-dir=' + resolve(ART, 'uach-ud')],
    cwd: ROOT,
    env,
    timeout: 40000
  })

  const main = await app.firstWindow({ timeout: 25000 })
  await main.waitForTimeout(1500)

  /* 用 macOS 环境：宿主是 Windows，所以「读到 Windows」= 露宿主，一眼可辨。
     先删同名环境，避免上一轮留下的记录干扰「这次真的新建了」的判断。 */
  const existing = await main.evaluate(async () => await window.ss.profiles.list())
  for (const p of Array.isArray(existing) ? existing : []) {
    if (String(p.name || '').startsWith('验收-uach')) {
      await main.evaluate(async (id) => await window.ss.profiles.remove(id), p.id)
    }
  }
  const prof = await main.evaluate(
    async () => await window.ss.profiles.create({ name: '验收-uach', platform: 'macos' })
  )
  if (!prof || !prof.id) finish(2, '建环境失败')
  out.profile = { id: prof.id, name: prof.name, platform: prof.platform }

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
      const read = async () => {
        const t = findWc()
        if (!t) return { ok: false, error: 'webContents 已消失' }
        try { return { ok: true, value: await t.executeJavaScript('JSON.stringify(window.__r)') } } catch (e) {
          return { ok: false, error: String((e && e.message) || e) }
        }
      }
      let last = null
      for (let i = 0; i < 40; i++) {
        await sleep(500)
        const r = await read()
        if (!r.ok) { last = r; continue }
        last = r
        const v = JSON.parse(r.value)
        const done = (v.main !== null) && (v.ded !== null || v.dedErr) && (v.shared !== null || v.sharedErr) && (v.swc !== null || v.swcErr)
        if (done) break
      }
      return last.ok ? { ok: true, value: JSON.parse(last.value) } : last
    },
    { url: PAGE_URL }
  )

  if (!measured.ok) {
    out.readings.error = measured.error
    try { await app.close() } catch (e) {}
    finish(3, '读数没取到：' + String(measured.error))
  }

  const v = measured.value
  out.readings = v
  const mainR = v.main || {}
  const ded = v.ded || {}
  const shared = v.shared || {}
  const swc = v.swc || {}

  const gate = (id, label, expected, actual, pass, note) =>
    out.gates.push({ id, label, expected, actual, pass, note })

  /* 主世界是基准：它必须等于 profile（macOS）。不成立的话后面所有「一致」都没意义 */
  gate('main', '主世界 userAgentData.platform = macOS（对照）', 'macOS', mainR.platform,
    mainR.platform === 'macOS',
    mainR.platform === 'macOS' ? '' : '主世界都没伪装住，后面的「一致」没有意义')

  const same = (x) => x && x.platform === mainR.platform
  const desc = (x) => (x ? x.platform + ' [' + String(x.platformVersion) + ']' : 'null')

  /* 事件期必须等于主世界 —— 这是本轮真正承诺的那一层 */
  gate('ded-msg', 'dedicated worker 事件期 platform = 主世界', desc(mainR), desc(ded.now), same(ded.now),
    same(ded.now) ? '' : '事件期都对不上，说明注入根本没落到 dedicated worker')
  gate('shared-msg', 'shared worker 事件期 platform = 主世界', desc(mainR), desc(shared.now), same(shared.now),
    same(shared.now) ? '' : 'shared_worker 靠 targetCreated + attachToTarget 注入，先看 [inject-issue]')
  gate('swc-msg', 'service worker 事件期 platform = 主世界', desc(mainR), desc(swc.now), same(swc.now),
    same(swc.now) ? '' : '事件期都没盖住 = 注入没落到 SW 上')

  /* platformVersion 单独一条：它是**高熵值**，走的是另一个返回路径，
     `platform` 对了不代表它也对。creepjs 读的就是这个。 */
  const pvSame = (x) => x && x.platformVersion === mainR.platformVersion
  gate('ded-pv', 'dedicated worker 事件期 platformVersion = 主世界', mainR.platformVersion,
    ded.now ? ded.now.platformVersion : null, pvSame(ded.now),
    pvSame(ded.now) ? '' : 'platform 对了但高熵值没对 —— 检测方读 getHighEntropyValues 就能看到矛盾')
  gate('shared-pv', 'shared worker 事件期 platformVersion = 主世界', mainR.platformVersion,
    shared.now ? shared.now.platformVersion : null, pvSame(shared.now),
    pvSame(shared.now) ? '' : 'platform 对了但高熵值没对')
  gate('swc-pv', 'service worker 事件期 platformVersion = 主世界', mainR.platformVersion,
    swc.now ? swc.now.platformVersion : null, pvSame(swc.now),
    pvSame(swc.now) ? '' : 'platform 对了但高熵值没对')

  /* ── 打印 ── */
  const row = (name, x) => {
    if (!x) return console.log('  ' + name.padEnd(26) + '（没回话）')
    const flag = x.platform === mainR.platform ? '' : '   ← 与主世界矛盾'
    console.log(
      '  ' + name.padEnd(26) + 'platform=' + String(x.platform).padEnd(8) +
      ' platformVersion=' + String(x.platformVersion).padEnd(8) + flag
    )
  }

  console.log('\n===== navigator.userAgentData 在四种上下文里读到什么 =====\n')
  console.log('宿主 = Windows，profile = ' + out.profile.platform + '（所以「读到 Windows」= 露宿主）\n')
  console.log('[主世界]')
  row('主世界', mainR)
  console.log('\n[dedicated worker]')
  row('顶层（脚本刚执行）', ded.top)
  row('事件期（message）', ded.now)
  console.log('\n[shared worker]')
  row('顶层（脚本刚执行）', shared.top)
  row('事件期（message）', shared.now)
  console.log('\n[service worker]')
  row('顶层（脚本刚执行）', swc.top)
  row('install', swc.install)
  row('事件期（message）', swc.now)

  console.log('\n[结论]')
  let bad = 0
  for (const g of out.gates) {
    const tag = g.pass ? '成立' : '不成立'
    if (!g.pass) bad += 1
    console.log('  ' + tag.padEnd(4) + ' ' + g.label + '  期望 ' + JSON.stringify(g.expected) + ' 实得 ' + JSON.stringify(g.actual))
    if (!g.pass && g.note) console.log('        ↳ ' + g.note)
  }
  for (const n of out.notes) console.log('  注意  ' + n)

  try { await app.close() } catch (e) {}
  finish(bad > 0 ? 1 : 0, bad > 0 ? `${out.gates.length - bad}/${out.gates.length} 成立，${bad} 条不成立` : `全部 ${out.gates.length} 条成立`)
} catch (err) {
  out.readings.error = String((err && err.message) || err)
  if (app) { try { await app.close() } catch (e) {} }
  finish(2, '脚本自身异常：' + out.readings.error)
}
