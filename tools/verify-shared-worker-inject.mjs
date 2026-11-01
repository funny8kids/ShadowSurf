/**
 * shared_worker / service_worker 的注入到底覆盖到哪一层 —— 验**构建产物**，不是源码。
 *
 * ── 为什么单开一条 ──
 *
 * `Target.setAutoAttach` 不覆盖 shared_worker（读数见 artifacts/probe-shared-worker.json），
 * 所以它一直走「记一条未覆盖就放行」的分支。B2 测出来手动 `attachToTarget` 拿到的
 * session 是**可用**的，于是这条路从「不可达」变成「可事后注入」。
 * service_worker 则是另一种情况：暂停态下任何命令都不返回，只能「先放行、再抢时间」。
 *
 * 两条路都**只能覆盖一部分**，而「覆盖了一部分」最容易被写成「已覆盖」。所以这里
 * 把三个时刻分开测，各自单独判：
 *
 *   worker 脚本顶层读         → 见下
 *   事件处理器里读（延迟触发） → 应该读到伪装值（这是真正能承诺的那一层）
 *
 * 实测（2026-11-01，连跑 3 次稳定）：
 *   service_worker  顶层 = **宿主值**。结构性不可覆盖：暂停态下任何命令都不返回，
 *                   resume 的那一刻顶层就执行完了。install = 伪装值（注入 2–5ms 完成，
 *                   稳定抢在 install 之前）。
 *   shared_worker   顶层 = **伪装值**。它没被暂停，但 target 在脚本 fetch 之前就建出来了，
 *                   所以 attach + 注入通常赶在脚本执行之前 —— 这是**竞态赢了**，
 *                   不是保证，所以顶层只作 reading 不作 gate。
 *
 * 三个 gate：
 *   main    页面主世界 = profile（对照，证明这轮注入本身是好的）
 *   shared  shared_worker 里**延迟消息**读到的 = profile
 *   swc     service_worker 里**message 事件**读到的 = profile
 *   ledger  两条路径都必须留下覆盖边界记录（[inject-issue]）
 *
 * 三个 reading（不判红，但必须写进读数）：
 *   shared.top / swc.top / swc.install —— 顶层与 install 时刻读到的值。
 *   写出来是为了让「覆盖到哪一层」这件事有据可查，而不是靠报告里一句形容词。
 *
 * 跑法：npm run verify:shared-worker（先 electron-vite build）
 * 退出码：0 = 全部成立；1 = 有 gate 不成立；2 = 脚本自身崩了；3 = 读数没取到（未测量）
 */

import { _electron as electron } from 'playwright-core'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'

const ROOT = resolve(import.meta.dirname, '..')
const ART = resolve(ROOT, 'artifacts')
/** 宿主真实核数 —— 「读到宿主值」和「读到 profile 值」靠它区分 */
const HOST_CORES = os.cpus().length

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>sw-inject</title></head>
<body>
<script>
window.__r = { main: null, shared: null, sharedErr: null, swc: null, swcErr: null, notes: [] };
window.__r.main = { cores: navigator.hardwareConcurrency, tz: Intl.DateTimeFormat().resolvedOptions().timeZone };

/* shared worker：延迟 4s 再发问。
   这个延迟是刻意的 —— 主进程要先「发现 → attach → 注入」，注入完才有伪装值。
   立刻发问等于测「顶层覆盖」，而顶层本来就不可能覆盖（那是 reading，不是 gate）。 */
try {
  var sw = new SharedWorker('/sw.js');
  sw.port.onmessage = function (e) { window.__r.shared = e.data };
  sw.port.onerror = function (e) { window.__r.sharedErr = 'port:' + String((e && e.message) || e) };
  sw.port.start();
  setTimeout(function () {
    try { sw.port.postMessage('late') } catch (e) { window.__r.sharedErr = 'post:' + String(e) }
  }, 4000);
} catch (e) { window.__r.sharedErr = 'ctor:' + String(e) }

/* service worker：register → ready → active.postMessage('read')。
   同样延迟 4s。install 时刻的读数由 SW 自己存下来一并回传（那是竞态读数）。 */
if (navigator.serviceWorker) {
  navigator.serviceWorker.onmessage = function (e) { window.__r.swc = e.data };
  navigator.serviceWorker.register('/swc.js').then(function () {
    return navigator.serviceWorker.ready;
  }).then(function (reg) {
    var w = reg.active;
    if (!w) { window.__r.swcErr = 'no active worker'; return }
    setTimeout(function () {
      try { w.postMessage('read') } catch (e) { window.__r.swcErr = 'post:' + String(e) }
    }, 4000);
  }).catch(function (e) { window.__r.swcErr = 'register:' + String((e && e.message) || e) });
} else {
  window.__r.swcErr = 'navigator.serviceWorker 不存在';
}
</script>
</body></html>`

/* 共享 worker：顶层先读一次（TOP），收到消息时再读一次（late）。
   两次读的差就是「事后注入」这件事本身。 */
const SW_JS = `
var TOP = navigator.hardwareConcurrency;
var TOP_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
self.onconnect = function (ev) {
  var port = ev.ports[0];
  port.onmessage = function () {
    port.postMessage({
      top: TOP,
      topTz: TOP_TZ,
      late: navigator.hardwareConcurrency,
      lateTz: Intl.DateTimeFormat().resolvedOptions().timeZone
    });
  };
};
`

/* service worker：顶层（TOP）、install（INSTALL）、message（msg）三个时刻各读一次。
   install 是**竞态读数**：注入能不能赶在 install 之前，决定了这一格是伪装值还是宿主值。 */
const SWC_JS = `
var TOP = navigator.hardwareConcurrency;
var TOP_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
var INSTALL = null;
var INSTALL_TZ = null;
self.addEventListener('install', function () {
  INSTALL = navigator.hardwareConcurrency;
  INSTALL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
  self.skipWaiting();
});
self.addEventListener('activate', function (ev) { ev.waitUntil(self.clients.claim()); });
self.addEventListener('message', function (ev) {
  var payload = {
    top: TOP,
    topTz: TOP_TZ,
    install: INSTALL,
    installTz: INSTALL_TZ,
    msg: navigator.hardwareConcurrency,
    msgTz: Intl.DateTimeFormat().resolvedOptions().timeZone
  };
  if (ev.source && ev.source.postMessage) ev.source.postMessage(payload);
});
`

/* ── 服务：一个 origin 同时供页面 / 共享 worker / service worker ── */
const server = await new Promise((r) => {
  const s = createServer((req, res) => {
    const url = (req.url || '/').split('?')[0]
    const body = url === '/sw.js' ? SW_JS : url === '/swc.js' ? SWC_JS : PAGE_HTML
    const type = url.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8'
    // service worker 脚本必须 no-store，否则改了脚本还会用缓存里的旧版本
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(body)
  })
  s.listen(0, '127.0.0.1', () => r(s))
})
const PAGE_URL = 'http://127.0.0.1:' + server.address().port + '/'

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE

const out = { at: null, hostCores: HOST_CORES, profile: null, readings: {}, gates: [], issues: [], notes: [] }
const finish = (code, msg) => {
  if (msg) console.log('\n' + msg)
  out.at = new Date().toISOString()
  mkdirSync(ART, { recursive: true })
  writeFileSync(resolve(ART, 'shared-worker-inject.json'), JSON.stringify(out, null, 2), 'utf8')
  try { server.close() } catch (e) {}
  console.log('\n完整读数：artifacts/shared-worker-inject.json')
  process.exit(code)
}

let app = null
try {
  app = await electron.launch({
    executablePath: resolve(ROOT, 'node_modules/electron/dist/electron.exe'),
    args: ['.', '--user-data-dir=' + resolve(ART, 'shared-worker-inject-ud')],
    cwd: ROOT,
    env,
    timeout: 40000
  })

  /* 主进程 stderr 里的 `[inject-issue]` 是「注入过程报过什么」的唯一外部形态。
     本脚本用它证明「顶层未覆盖」这件事**被记了账**，而不只是写在注释里。 */
  const stderrChunks = []
  try { app.process().stderr.on('data', (b) => stderrChunks.push(String(b))) } catch (e) {}

  const main = await app.firstWindow({ timeout: 25000 })
  await main.waitForTimeout(1500)

  let list = await main.evaluate(async () => await window.ss.profiles.list())
  if (!Array.isArray(list) || list.length === 0) {
    await main.evaluate(async () => await window.ss.profiles.create({ name: '验收-shared-worker', platform: 'windows' }))
    list = await main.evaluate(async () => await window.ss.profiles.list())
  }
  if (!Array.isArray(list) || list.length === 0) throw new Error('profile 创建后仍为空')

  let target = list.find((p) => p.platform === 'windows') || list[0]

  /* 判别力前提：profile 的核数必须和宿主不同。
     相同的话「读到宿主值」和「读到伪装值」是同一个数，这条检查就是恒绿 ——
     本仓库反复出现的假绿形态，宁可在这里改一次 profile 也不要把恒真当通过。 */
  const wantCores = HOST_CORES === 12 ? 6 : 12
  if (target.fingerprint?.hardware?.cpuCores === HOST_CORES) {
    const fp = JSON.parse(JSON.stringify(target.fingerprint))
    fp.hardware.cpuCores = wantCores
    target = await main.evaluate(
      async (a) => await window.ss.profiles.update(a.id, { fingerprint: a.fp }),
      { id: target.id, fp }
    )
    out.notes.push(
      `profile 的核数与宿主相同（都是 ${HOST_CORES}），已改成 ${wantCores} —— 否则这条检查没有判别力`
    )
  }
  const want = target.fingerprint?.hardware?.cpuCores ?? null
  const wantTz = target.fingerprint?.timezone ?? null
  out.profile = { id: target.id, name: target.name, cpuCores: want, timezone: wantTz }
  if (want === null) throw new Error('profile 没有 hardware.cpuCores，无法判定')

  await main.evaluate(async (id) => await window.ss.profiles.launch(id), target.id)
  await main.waitForTimeout(6000)

  /* 一次 evaluate 内完成：导航 + 等读数。
     分多次 evaluate 时中间任何一次导航都会让 executeJavaScript 抛
     "Render frame was disposed"，看起来像注入失败，其实只是探针挂在了旧 frame 上。 */
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
      /* 轮询而不是等一个 Promise：页面里有 4s 延迟的两条消息，
         用「返回 Promise 的 executeJavaScript」等 8s，期间任何一次导航都会抛。 */
      let last = null
      for (let i = 0; i < 40; i++) {
        await sleep(500)
        const r = await read()
        if (!r.ok) { last = r; continue }
        last = r
        const v = JSON.parse(r.value)
        // 两个 worker 都回话了就提前收工；任一报错也收工（把错误读出来比干等有用）
        if ((v.shared !== null || v.sharedErr) && (v.swc !== null || v.swcErr)) break
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
  const page = v.main || {}
  const shared = v.shared || {}
  const swc = v.swc || {}

  /* ── 记账：主进程有没有把「顶层未覆盖」这件事写下来 ── */
  await main.waitForTimeout(800)
  const log = stderrChunks.join('')
  const issueLines = log
    .split(/\r?\n/)
    .filter((l) => l.includes('[inject-issue]'))
    .map((l) => l.slice(l.indexOf('[inject-issue]')))
  out.issues = issueLines
  const hasSharedNote = issueLines.some((l) => l.includes('shared_worker'))
  const hasSwcNote = issueLines.some((l) => l.includes('service_worker'))

  const gate = (id, label, expected, actual, pass, note) => {
    out.gates.push({ id, label, expected, actual, pass, note })
  }

  gate('main', '页面主世界读到 profile 的核数（对照）', want, page.cores, page.cores === want,
    page.cores === want ? '' : '连主世界都没伪装住，后面两条不成立 —— 先查页面级注入')

  gate(
    'shared',
    'shared_worker 里**延迟消息**读到的核数 = profile（事后注入生效）',
    want,
    shared.late === undefined ? null : shared.late,
    shared.late === want,
    shared.late === want
      ? ''
      : v.sharedErr
        ? 'shared worker 没回话：' + String(v.sharedErr)
        : `读到 ${String(shared.late)}（宿主 ${HOST_CORES}）。等于宿主值 = 注入没进去；` +
          'shared_worker 靠 targetCreated 发现 + attachToTarget，先看 [inject-issue] 里有没有附着失败'
  )

  gate(
    'swc',
    'service_worker 里 **message 事件**读到的核数 = profile（事件期注入生效）',
    want,
    swc.msg === undefined ? null : swc.msg,
    swc.msg === want,
    swc.msg === want
      ? ''
      : v.swcErr
        ? 'service worker 没回话：' + String(v.swcErr)
        : `读到 ${String(swc.msg)}（宿主 ${HOST_CORES}）。事件期都没盖住 = 注入根本没落到 SW 上`
  )

  /* 记账本身也算一条 gate：注入成功了却什么都没记，等于「顶层覆盖了」这句话没人拦得住 */
  gate(
    'ledger',
    'shared_worker 与 service_worker 都必须留下覆盖边界记录（[inject-issue]）',
    '两条都在',
    { shared: hasSharedNote, service: hasSwcNote },
    hasSharedNote && hasSwcNote,
    hasSharedNote && hasSwcNote
      ? ''
      : '注入过程没有记账 —— 「顶层未覆盖」会变成一句没人能核对的话'
  )

  /* ── 打印 ── */
  console.log('\n===== shared_worker / service_worker 覆盖边界 =====\n')
  console.log('宿主核数 = ' + HOST_CORES + '，profile 核数 = ' + String(want) + '（时区 ' + String(wantTz) + '）')
  console.log('\n[页面] cores=' + String(page.cores) + '  tz=' + String(page.tz))
  console.log('\n[shared_worker]')
  console.log('  顶层读（拿到 session 之前）  cores=' + String(shared.top) + '  tz=' + String(shared.topTz))
  console.log('  延迟消息读（注入之后）        cores=' + String(shared.late) + '  tz=' + String(shared.lateTz))
  console.log('\n[service_worker]')
  console.log('  顶层读                        cores=' + String(swc.top) + '  tz=' + String(swc.topTz))
  console.log('  install 时刻（竞态读数）      cores=' + String(swc.install) + '  tz=' + String(swc.installTz))
  console.log('  message 事件读                cores=' + String(swc.msg) + '  tz=' + String(swc.msgTz))

  const hostEq = (x) => x === HOST_CORES
  console.log('\n[边界] 以下不是 gate，是这条路径的边界，写出来备查：')
  console.log(
    '  shared_worker 顶层  ' +
      (shared.top === want
        ? '读到伪装值 —— 注入赶在了脚本 fetch 之前（竞态赢了；不保证每次都赢）'
        : hostEq(shared.top)
          ? '读到宿主值 —— 脚本先跑完了（竞态输了；这也不违反任何承诺，因为没被暂停）'
          : '读到 ' + String(shared.top))
  )
  console.log(
    '  service_worker 顶层 ' +
      (hostEq(swc.top)
        ? '读到宿主值（结构性不可覆盖：resume 时顶层已执行完）'
        : swc.top === want
          ? '读到伪装值（本次赶上了，但这条路径**没有暂停保护**，不能据此承诺顶层覆盖）'
          : '读到 ' + String(swc.top))
  )
  console.log(
    '  service_worker install ' +
      (swc.install === want
        ? '读到伪装值 —— 注入抢在了 install 之前'
        : hostEq(swc.install)
          ? '读到宿主值 —— 注入没赶在 install 之前（竞态输了，不是失败）'
          : '读到 ' + String(swc.install))
  )

  console.log('\n[记账] 主进程 [inject-issue] 里与本条相关的行：')
  const rel = issueLines.filter((l) => l.includes('shared_worker') || l.includes('service_worker'))
  if (rel.length === 0) console.log('  （没有 —— 这就是一条问题：覆盖边界没被记下来）')
  for (const l of rel.slice(0, 8)) console.log('  ' + l.slice(0, 220))

  console.log('\n[结论]')
  let bad = 0
  for (const g of out.gates) {
    const tag = g.pass ? '成立' : '不成立'
    if (!g.pass) bad += 1
    console.log('  ' + tag.padEnd(4) + ' ' + g.label + '  期望 ' + JSON.stringify(g.expected) + ' 实得 ' + JSON.stringify(g.actual))
    if (!g.pass && g.note) console.log('        ↳ ' + g.note)
  }
  for (const n of out.notes) console.log('  注意  ' + n)

  // 先关应用再收工：不关的话 Electron 子进程会跟着探针一起挂到超时
  try { await app.close() } catch (e) {}
  finish(
    bad > 0 ? 1 : 0,
    bad > 0
      ? `${out.gates.length - bad}/${out.gates.length} 成立，${bad} 条不成立`
      : `全部 ${out.gates.length} 条成立`
  )
} catch (err) {
  out.readings.error = String((err && err.message) || err)
  if (app) { try { await app.close() } catch (e) {} }
  finish(2, '脚本自身异常：' + out.readings.error)
}
