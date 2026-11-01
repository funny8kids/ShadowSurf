/**
 * P0-2 真机验收：Worker 注入是否真的生效，与主世界对读。
 *
 * 验的是**构建产物**（out/main/index.js）里的 WindowManager.injectFingerprint，
 * 不是源码文本。所以必须 `npm run build` 之后再跑。
 *
 * 输出：
 *   1. 主世界（page）5 个字段
 *   2. Worker 内（dedicated worker，blob 脚本）同一组 5 个字段
 *   3. 对读：一致 = 注入打通；Worker 是宿主值 = 没打通
 *   4. 主进程 stderr 里的 `[inject-issue]` 结构化行 —— 「失败事实被带出去」的证据
 *
 * 跑法：npm run verify:worker（先 npm run build）
 */

import { _electron as electron } from 'playwright-core'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const ROOT = resolve(import.meta.dirname, '..')

const mkServer = (host, title) =>
  new Promise((r) => {
    const s = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><meta charset="utf-8"><title>' + title + '</title><body>' + title + '</body>')
    })
    s.listen(0, host, () => r(s))
  })
const server = await mkServer('127.0.0.1', 'wprobe')
const serverB = await mkServer('127.0.0.1', 'oopif')
const PAGE_URL = 'http://127.0.0.1:' + server.address().port + '/'
// 跨 site 才产生 OOPIF：localhost ≠ 127.0.0.1（site 忽略端口，见 feasibility-attach2）
const OOPIF_URL = 'http://localhost:' + serverB.address().port + '/'

const READ = `(function(){
  try {
    var out = {
      hardwareConcurrency: navigator.hardwareConcurrency,
      platform: navigator.platform,
      languages: Array.prototype.slice.call(navigator.languages || []),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      tzOffset: new Date(2024, 0, 15, 12, 0, 0).getTimezoneOffset(),
      glVendor: null,
      glRenderer: null,
      glCtx: false
    }
    // 主世界的 GL 读数：走 DOM canvas。取不到 context 时保持 null，
    // 不要写 "ERR" —— 那会变成「两边都是 ERR、看起来一致」的假绿。
    var c = document.createElement('canvas').getContext('webgl')
    if (c) {
      out.glCtx = true
      out.glVendor = c.getParameter(37445)
      out.glRenderer = c.getParameter(37446)
    }
    return out
  } catch (e) { return { err: String(e && e.message || e) } }
})()`

/* Worker 侧的关键一条：**由 worker 自己**建 OffscreenCanvas 的 GL 上下文。
   这一条才是「不建 context 也能伪装」的证据 ——
   注入脚本自己建 context 会在暂停态崩渲染进程，所以它只装 prototype；
   那么「装了 prototype 之后新建的 context 到底读什么」，只能这样问。 */
const WORKER_SRC =
  'self.onmessage=function(){' +
  'var o={};' +
  'try{' +
  'o.hardwareConcurrency=navigator.hardwareConcurrency;' +
  'o.platform=navigator.platform;' +
  'o.languages=Array.prototype.slice.call(navigator.languages||[]);' +
  'o.timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone;' +
  'o.tzOffset=new Date(2024,0,15,12,0,0).getTimezoneOffset();' +
  'o.glVendor=null;o.glRenderer=null;o.glCtx=false;' +
  'try{' +
  'var c=new OffscreenCanvas(1,1).getContext("webgl");' +
  'if(c){o.glCtx=true;o.glVendor=c.getParameter(37445);o.glRenderer=c.getParameter(37446);}' +
  '}catch(e){o.glErr=String(e&&e.message||e)}' +
  '}catch(e){o.err=String(e&&e.message||e)}' +
  'postMessage(o)}'

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: resolve(ROOT, 'node_modules/electron/dist/electron.exe'),
  args: ['.', '--user-data-dir=' + resolve(ROOT, 'artifacts/worker-inject-ud')],
  cwd: ROOT,
  env,
  timeout: 40000
})

/* 抓主进程 stderr：`[inject-issue]` 是失败事实的唯一外部可见形态 */
const stderrChunks = []
try {
  app.process().stderr.on('data', (b) => stderrChunks.push(String(b)))
} catch (e) {}

const main = await app.firstWindow({ timeout: 25000 })
await main.waitForTimeout(1500)

/* 崩溃监听必须**在任何导航之前**装上：崩溃发生在导航期间的 worker attach 上，
   事后补监听只能看到「页面白屏」，看不到 reason。 */
await app.evaluate(({ app: electronApp }) => {
  globalThis.__ssGone = []
  electronApp.on('render-process-gone', (_e, wc, details) => {
    try {
      globalThis.__ssGone.push({ id: wc && wc.id, reason: details && details.reason })
    } catch (e) {
      /* 监听器本身不许抛 */
    }
  })
})

const out = { steps: [], issues: [] }
const step = (id, label, data) => out.steps.push({ id, label, ...data })

/* 1. 起一个真 profile 的标签页。
   探针用独立 --user-data-dir（躲单实例锁），store 是空的，没有现成 profile
   就自己建一个 —— 不能回落到默认 userData，否则会和别人开着的实例抢锁。 */
let list = await main.evaluate(async () => await window.ss.profiles.list())
if (!Array.isArray(list) || list.length === 0) {
  await main.evaluate(async () => await window.ss.profiles.create({ name: '验收-Windows', platform: 'windows', fingerprint: null }))
  list = await main.evaluate(async () => await window.ss.profiles.list())
}
if (!Array.isArray(list) || list.length === 0) throw new Error('profile 创建后仍为空，无法继续')
const target = list.find((p) => p.platform === 'windows') || list[0]
step('profile', '选中的 profile', {
  id: target.id,
  name: target.name,
  cpuCores: target.fingerprint?.hardware?.cpuCores ?? null,
  languages: target.fingerprint?.languages ?? null,
  timezone: target.fingerprint?.timezone ?? null,
  os: target.fingerprint?.os ?? null,
  // 期望值的唯一来源：profile 里配的是什么，两边就该读到什么
  glVendorCfg: target.fingerprint?.webgl?.vendor ?? null,
  glRendererCfg: target.fingerprint?.webgl?.renderer ?? null
})

await main.evaluate(async (id) => await window.ss.profiles.launch(id), target.id)
await main.waitForTimeout(6000)

const opened = app.windows().find((w) => w.url().includes('role=browser') && w.url().includes(target.id))
step('window', '浏览器窗口是否打开', { opened: !!opened })

/* 2-4. 导航 + 等待稳定 + 主世界读数 + Worker 读数，一次 evaluate 内做完。
   跨进程分多次 evaluate 时，中间任何一次导航都会让
   "Render frame was disposed before the request completed"。 */
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
    const finalUrl = wc.getURL()

    const run = async (src, tries = 6) => {
      let last = null
      for (let i = 0; i < tries; i++) {
        const t = findWc()
        if (!t) return { ok: false, error: 'webContents 已消失' }
        try {
          return { ok: true, value: await t.executeJavaScript(src) }
        } catch (e) {
          last = String((e && e.message) || e)
          await sleep(600)
        }
      }
      return { ok: false, error: last }
    }

    const page = await run(args.readSrc)

    /* Worker 读数：不能用「返回 Promise 的 executeJavaScript」等它 8 秒 ——
       期间只要页面有一次导航/替换 frame，就会抛
       "Render frame was disposed before WebFrameMain could be accessed"，
       看起来像注入失败，其实只是探针自己挂在一个失效的 frame 上。
       改成：发出去就返回，然后轮询页面里的结果变量。 */
    const kick =
      'window.__wr=null;window.__werr=null;' +
      '(function(){' +
      'var code = ' + JSON.stringify(args.workerSrc) + ';' +
      'try{' +
      'var w = new Worker(URL.createObjectURL(new Blob([code],{type:"text/javascript"})));' +
      'w.onmessage=function(e){window.__wr=e.data};' +
      'w.onerror=function(e){window.__werr=String(e&&e.message||e)};' +
      'w.postMessage("go")' +
      '}catch(e){window.__werr=String(e&&e.message||e)}' +
      '})();"kicked"'
    const kickRes = await run(kick)
    let worker = { ok: false, error: '未取到 Worker 读数' }
    for (let i = 0; i < 30; i++) {
      await sleep(300)
      const poll = await run('JSON.stringify({r:window.__wr||null,e:window.__werr||null})')
      if (!poll.ok) {
        worker = poll
        break
      }
      let parsed = null
      try {
        parsed = JSON.parse(poll.value)
      } catch (e) {
        continue
      }
      if (parsed && parsed.e) {
        worker = { ok: true, value: { error: parsed.e } }
        break
      }
      if (parsed && parsed.r) {
        worker = { ok: true, value: parsed.r }
        break
      }
    }
    return { url: finalUrl, page, worker, kick: kickRes, iframe: await checkIframe() }

    /* OOPIF 存活检查：跨 site iframe 会触发 iframe 注入分支。
       父页面读不到跨域内容，所以这里只验「渲染进程没崩 + 页面还能执行脚本」，
       值级别的 iframe 伪装不在此断言（见报告里的未验项）。 */
    async function checkIframe() {
      const before = await run('JSON.stringify({frames: window.frames.length})')
      await run(
        'var f=document.createElement("iframe");f.src=' + JSON.stringify(args.urlB) + ';f.width=300;f.height=150;document.body.appendChild(f);"added"'
      )
      await sleep(3000)
      const after = await run('JSON.stringify({frames: window.frames.length, alive:true})')
      return { before, after }
    }
  },
  { url: PAGE_URL, urlB: OOPIF_URL, readSrc: READ, workerSrc: WORKER_SRC }
)

step('measure', '导航后的 URL 与两次读数', measured)
const pageRead = { url: measured.url, read: measured.page && measured.page.ok ? measured.page.value : null }
const workerRead = measured.worker && measured.worker.ok ? measured.worker.value : { error: measured.worker && measured.worker.error }
step('page', '主世界读数', pageRead)
step('worker', 'Worker 内读数', workerRead)

const keys = [
  'hardwareConcurrency',
  'platform',
  'languages',
  'timeZone',
  'tzOffset',
  'glVendor',
  'glRenderer'
]
const compare = keys.map((k) => ({
  field: k,
  page: pageRead.read?.[k] ?? null,
  worker: workerRead?.[k] ?? null,
  same: JSON.stringify(pageRead.read?.[k]) === JSON.stringify(workerRead?.[k])
}))
out.compare = compare
out.consistent = compare.every((c) => c.same)

/* GL 那两项还要单独和 profile 配置对一次：
   「两边一致」可能是一起错（都读到宿主值），只有对上配置才叫伪装住了。 */
const glCfg = {
  vendor: target.fingerprint?.webgl?.vendor ?? null,
  renderer: target.fingerprint?.webgl?.renderer ?? null
}
const glMatch = {
  pageVendor: pageRead.read?.glVendor === glCfg.vendor,
  pageRenderer: pageRead.read?.glRenderer === glCfg.renderer,
  workerVendor: workerRead?.glVendor === glCfg.vendor,
  workerRenderer: workerRead?.glRenderer === glCfg.renderer,
  // context 建不出来时以上四项全是 false —— 但要能区分「值不对」和「压根没 context」
  pageCtx: pageRead.read?.glCtx === true,
  workerCtx: workerRead?.glCtx === true
}
out.gl = { cfg: glCfg, match: glMatch }
step('gl', 'Worker 自建 OffscreenCanvas GL 上下文读数', { cfg: glCfg, match: glMatch })

const gone = await app.evaluate(() => globalThis.__ssGone || [])
out.crashes = gone
step('crash', '渲染进程崩溃记录（render-process-gone）', { count: gone.length, list: gone })
step('compare', '主世界 vs Worker', { consistent: out.consistent })

await main.waitForTimeout(800)

/* 5. 收失败事实 */
const stderr = stderrChunks.join('')
out.issues = stderr
  .split('\n')
  .filter((l) => l.includes('[inject-issue]'))
  .map((l) => l.slice(l.indexOf('[inject-issue]')).trim())
step('iframe', 'OOPIF 存活检查（跨 site iframe）', measured.iframe)
step('issues', '主进程 stderr 里的 [inject-issue]', { count: out.issues.length, lines: out.issues })

try { await app.close() } catch (e) {}
try { server.close() } catch (e) {}
try { serverB.close() } catch (e) {}

mkdirSync(resolve(ROOT, 'artifacts'), { recursive: true })
writeFileSync(resolve(ROOT, 'artifacts/worker-inject.json'), JSON.stringify(out, null, 2), 'utf8')

const J = (v) => JSON.stringify(v)
console.log('\n===== Worker 注入真机验收 =====\n')
for (const s of out.steps) {
  const { id, label, ...rest } = s
  console.log('[' + id + '] ' + label)
  for (const [k, v] of Object.entries(rest)) console.log('      ' + k + ' = ' + J(v))
  console.log('')
}
console.log('--- 主世界 vs Worker ---')
for (const c of compare) {
  console.log('  ' + c.field.padEnd(22) + 'page=' + J(c.page).padEnd(24) + 'worker=' + J(c.worker).padEnd(24) + (c.same ? '一致' : '**矛盾**'))
}

/* ── GL：P0-2 的核心断言 ──
 * 三档，不能合并：
 *   没 context      → 这条**没测到**（不是通过，也不是不成立）
 *   有 context 但值不对 → 不成立（伪装没生效）
 *   有 context 且对上配置 → 成立
 */
const glOk =
  glMatch.pageCtx && glMatch.workerCtx &&
  glMatch.pageVendor && glMatch.pageRenderer &&
  glMatch.workerVendor && glMatch.workerRenderer
const glMeasured = glMatch.pageCtx && glMatch.workerCtx

console.log('\n--- WebGL：worker 自建 OffscreenCanvas 上下文 ---')
console.log('  配置          vendor=' + J(glCfg.vendor) + ' renderer=' + J(glCfg.renderer))
console.log('  主世界        ctx=' + J(glMatch.pageCtx) + ' vendor=' + J(pageRead.read?.glVendor) + ' renderer=' + J(pageRead.read?.glRenderer))
console.log('  Worker        ctx=' + J(glMatch.workerCtx) + ' vendor=' + J(workerRead?.glVendor) + ' renderer=' + J(workerRead?.glRenderer))
console.log('  判定：' + (glMeasured ? (glOk ? '成立 —— 不建 context 也伪装住了' : '**不成立** —— 有 context 但值不对') : '未测到 —— 有一侧没建出 context'))

console.log('\n--- 崩溃 ---')
console.log('  render-process-gone：' + (gone.length === 0 ? '无' : J(gone)))

const pass = out.consistent && glOk && gone.length === 0
console.log('\n结论：' + (pass
  ? 'Worker 注入已生效：主世界与 Worker 全等，且 Worker 自建 GL 上下文读到 profile 配置，全程无崩溃'
  : '未通过 —— 见上方逐项'))
console.log('完整读数：artifacts/worker-inject.json')

// 三态退出码，与其它门禁对齐：0 成立 / 1 不成立 / 3 未测到
process.exitCode = pass ? 0 : glMeasured || !out.consistent ? 1 : 3
