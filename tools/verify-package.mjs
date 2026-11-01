/**
 * 打包产物的冒烟验收：**跑起来**才算产物可用，文件存在不算。
 *
 * ── 为什么必须单独验一次 ──
 *
 * 开发态跑的是 `node_modules/electron/dist/electron.exe .`，读的是磁盘上的
 * `out/`；打包后变成 `ShadowSurf.exe` + `resources/app.asar`，`__dirname`
 * 指向 `app.asar/out/main`。两件事只有在打包后才会出问题：
 *   1. `loadFile(join(__dirname,'../renderer/index.html'))` —— 文件没打进 asar
 *   2. 注入脚本的注入时机 —— 主进程逻辑没变，但要证明它真的还在注入
 * 这两条都不会在开发态暴露，所以「打包成功」不能当验收。
 *
 * ── 验什么 ──
 *
 *   A 进程自证：isPackaged / arch=x64 / 版本号来自 package.json
 *   B 界面起来了：主窗口能拿到、能执行脚本、window.ss 桥在
 *   C 注入还在：建一个 windows 环境 → 开浏览器窗口 → 读页面读数
 *     （navigator.userAgent 必须是环境值而不是宿主，share 必须存在）
 *
 * 跑法：node tools/verify-package.mjs
 *       node tools/verify-package.mjs --exe release/win-unpacked/ShadowSurf.exe
 * 退出码：0 = 全部成立；1 = 有不成立；2 = 脚本自身崩了；3 = 没测到
 */

import { _electron as electron } from 'playwright-core'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs'

const ROOT = resolve(import.meta.dirname, '..')
const ART = resolve(ROOT, 'artifacts')

const argExe = (() => {
  const i = process.argv.indexOf('--exe')
  return i > 0 ? process.argv[i + 1] : null
})()
const EXE = resolve(ROOT, argExe || 'release/win-unpacked/ShadowSurf.exe')

const server = await new Promise((r) => {
  const s = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>pkg</title></head><body>pkg</body></html>')
  })
  s.listen(0, '127.0.0.1', () => r(s))
})
const PAGE_URL = 'http://127.0.0.1:' + server.address().port + '/'

const out = { at: new Date().toISOString(), exe: EXE, sizeMB: null, readings: {}, gates: [] }
const finish = (code, msg) => {
  if (msg) console.log('\n' + msg)
  out.at = new Date().toISOString()
  mkdirSync(ART, { recursive: true })
  writeFileSync(resolve(ART, 'package-smoke.json'), JSON.stringify(out, null, 2), 'utf8')
  try { server.close() } catch (e) {}
  console.log('\n完整读数：artifacts/package-smoke.json')
  process.exit(code)
}

if (!existsSync(EXE)) finish(3, '找不到可执行文件：' + EXE)
out.sizeMB = +(statSync(EXE).size / 1024 / 1024).toFixed(1)

const gate = (label, expected, actual, pass, note) =>
  out.gates.push({ label, expected, actual, pass, note: note || '' })

let app = null
try {
  /* 必须删掉 ELECTRON_RUN_AS_NODE。
     这个变量一旦为真，Electron 的 exe 会**以纯 Node 模式**启动：
     任何 Chromium 开关都报 `bad option: --xxx`，不带参数则立刻以 0 退出。
     表现和「打包产物起不来」一模一样，但跟产物毫无关系 —— 本轮就踩了这个坑，
     一度以为是 asar 路径或单实例锁的问题。
     开发态的探针都显式删了它（见 verify-share.mjs / run-electron.mjs），
     这里同样要删，否则测的是 Node 而不是应用。 */
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({
    executablePath: EXE,
    args: ['--user-data-dir=' + resolve(ART, 'package-ud')],
    env,
    timeout: 60000
  })

  /* A 进程自证 */
  const proc = await app.evaluate(async ({ app: a }) => ({
    isPackaged: a.isPackaged,
    name: a.getName(),
    version: a.getVersion(),
    appPath: a.getAppPath(),
    arch: process.arch,
    chrome: process.versions.chrome,
    electron: process.versions.electron
  }))
  out.readings.proc = proc

  gate('打包态（app.isPackaged = true）', true, proc.isPackaged, proc.isPackaged === true,
    'false 说明跑的不是打包产物，后面所有结论都不适用')
  gate('架构是 x64', 'x64', proc.arch, proc.arch === 'x64', '')
  gate('版本号来自 package.json', '0.1.0', proc.version, proc.version === '0.1.0', '')
  /* 必须以 resources/app.asar 结尾 —— 不能只测 /app\.asar/：
     开发态 Electron 的 appPath 是 resources\default_app.asar，也含 "app.asar"，
     用宽松正则会把它判成「从 asar 加载」而误绿。 */
  gate('主进程从 resources/app.asar 加载', true, proc.appPath, /resources[\\/]app\.asar$/.test(proc.appPath),
    'appPath=' + proc.appPath)

  /* B 界面起来了 */
  const main = await app.firstWindow({ timeout: 40000 })
  await main.waitForTimeout(2000)
  const ui = await main.evaluate(() => ({
    href: location.href,
    title: document.title,
    hasBridge: !!(window.ss && window.ss.profiles),
    bodyText: (document.body && document.body.innerText || '').slice(0, 80)
  }))
  out.readings.ui = ui
  gate('主窗口打开且 preload 桥在', true, ui.hasBridge, ui.hasBridge === true,
    'window.ss 不在说明 preload 没打进 asar 或路径不对')
  gate('渲染层是本地文件（file:// 而不是空白页）', 'file:', ui.href.split('//')[0], ui.href.startsWith('file:'),
    'href=' + ui.href)

  /* C 注入还在：建环境 → 开浏览器窗口 → 读页面
     桥不在就没法继续 —— 但那正是要报的失败，不能让它抛出去。
     抛出去的话前面已经成立的几条结论也一起丢了，只剩一行堆栈，
     看不出「到底哪一层坏了」。 */
  if (!ui.hasBridge) {
    gate('浏览器窗口可读', true, '未测（preload 桥不在，无法建环境）', false,
      'C 段整段跳过：桥不在时连 profiles 都拿不到，继续调只会抛异常')
  } else {
  const existing = await main.evaluate(async () => await window.ss.profiles.list())
  for (const p of Array.isArray(existing) ? existing : []) {
    if (String(p.name || '').startsWith('验收-package')) {
      await main.evaluate(async (id) => await window.ss.profiles.remove(id), p.id)
    }
  }
  const prof = await main.evaluate(
    async () => await window.ss.profiles.create({ name: '验收-package', platform: 'windows' })
  )
  if (!prof || !prof.id) finish(3, '建环境失败')
  await main.evaluate(async (id) => await window.ss.profiles.launch(id), prof.id)
  await main.waitForTimeout(7000)

  const page = await app.evaluate(
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
      await sleep(2500)
      const t = findWc()
      if (!t) return { error: 'webContents 已消失' }
      try {
        return {
          ok: true,
          value: JSON.parse(
            await t.executeJavaScript(
              'JSON.stringify({ ua: navigator.userAgent, platform: navigator.platform,' +
              ' share: typeof navigator.share, canShare: typeof navigator.canShare,' +
              ' webdriver: navigator.webdriver, secure: isSecureContext })'
            )
          )
        }
      } catch (e) {
        return { error: String((e && e.message) || e) }
      }
    },
    { url: PAGE_URL }
  )

  if (!page.ok) {
    out.readings.pageError = page.error
    gate('浏览器窗口可读', true, page.error, false, '')
  } else {
    const v = page.value
    out.readings.page = v
    gate('注入生效：页面 UA 是环境值（不是宿主 Electron）', '含 Chrome/ 且不含 Electron',
      v.ua.slice(-60), /Chrome\//.test(v.ua) && !/Electron/.test(v.ua), '')
    gate('注入生效：navigator.share 存在（本轮新补的）', 'function', v.share, v.share === 'function',
      '打包后注入没跑的话这里会是 undefined')
    gate('注入生效：canShare 存在', 'function', v.canShare, v.canShare === 'function', '')
    gate('webdriver = false', false, v.webdriver, v.webdriver === false, '')
    gate('页面是安全上下文', true, v.secure, v.secure === true, '')
  }
  }

  try { await app.close() } catch (e) {}
} catch (err) {
  out.readings.error = String((err && err.message) || err)
  if (app) { try { await app.close() } catch (e) {} }
  finish(3, '打包产物没跑起来：' + out.readings.error)
}

/* ── 打印 ── */
console.log('\n===== 打包产物冒烟验收 =====\n')
console.log('  可执行文件 ' + EXE)
console.log('  大小       ' + out.sizeMB + ' MB')
if (out.readings.proc) {
  const p = out.readings.proc
  console.log('  进程       isPackaged=' + p.isPackaged + '  arch=' + p.arch +
    '  version=' + p.version + '  electron=' + p.electron + '  chrome=' + p.chrome)
  console.log('  appPath    ' + p.appPath)
}
if (out.readings.ui) console.log('  主窗口     ' + out.readings.ui.href)
if (out.readings.page) {
  console.log('  页面       ua=' + out.readings.page.ua.slice(-70))
  console.log('  ' + ' '.repeat(11) + 'share=' + out.readings.page.share +
    '  canShare=' + out.readings.page.canShare + '  webdriver=' + out.readings.page.webdriver)
}

console.log('\n[结论]')
let bad = 0
for (const g of out.gates) {
  if (!g.pass) bad += 1
  console.log('  ' + (g.pass ? '成立  ' : '不成立') + ' ' + g.label)
  if (!g.pass) {
    console.log('        期望 ' + JSON.stringify(g.expected) + '  实得 ' + JSON.stringify(g.actual))
    if (g.note) console.log('        ↳ ' + g.note)
  }
}

finish(bad > 0 ? 1 : 0, bad > 0 ? `${out.gates.length - bad}/${out.gates.length} 成立，${bad} 条不成立` : `全部 ${out.gates.length} 条成立`)
