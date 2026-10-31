/**
 * 第三方交叉验证：用 creepjs 跑一遍。
 *
 * 自建探针只能证明「我们改的地方确实改了」，证明不了「改得像不像」。
 * creepjs 会主动找矛盾（UA 说 macOS 却装 Windows 字体、时区与语言对不上、
 * 引擎版本与 UA 不符……），并把它们标成 lie / unlike。它给的 trust score
 * 才是外部视角的评分。
 */
import { _electron as electron } from 'playwright-core'

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: 'G:/Worker-Space/ShadowSurf/node_modules/electron/dist/electron.exe',
  args: ['.'], cwd: 'G:/Worker-Space/ShadowSurf', env, timeout: 30000
})
const main = await app.firstWindow({ timeout: 20000 })
await main.waitForTimeout(1600)

const DUMP = `(() => {
  const txt = (s) => { const e = document.querySelector(s); return e ? e.innerText.replace(/\\s+/g, ' ').trim() : null }
  const collect = (needle) => {
    const out = []
    const all = document.querySelectorAll('div,span,li,td,p')
    for (const e of all) {
      const c = String(e.className || '')
      if (c.indexOf(needle) < 0) continue
      const t = e.innerText.replace(/\\s+/g, ' ').trim()
      if (t && t.length < 300) out.push(c + ' :: ' + t)
      if (out.length > 30) break
    }
    return out
  }
  return {
    trust: txt('.fingerprint-trust') || txt('[class*="trust"]'),
    lies: collect('lie'),
    unlikes: collect('unlike'),
    body: document.body.innerText.replace(/\\n{2,}/g, '\\n').slice(0, 5000)
  }
})()`

async function run(profileId, label) {
  await app.evaluate(async ({ BrowserWindow }, pid) => {
    const win = BrowserWindow.getAllWindows()[0]
    await win.webContents.executeJavaScript(`window.ss.profiles.launch(${JSON.stringify(pid)})`)
  }, profileId)
  await main.waitForTimeout(5000)

  const bw = app.windows().find((x) => x.url().includes('role=browser') && x.url().includes(profileId))
  if (!bw) return { label, error: '窗口未打开' }

  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('role=browser'))
    const wc = win.contentView.children[0].webContents
    try { wc.stop() } catch (e) {}
    await new Promise((r) => setTimeout(r, 400))
    for (let i = 0; i < 3; i++) {
      try { await wc.loadURL('https://abrahamjuliot.github.io/creepjs/') } catch (e) {}
      if (wc.getURL().includes('creepjs')) break
      await new Promise((r) => setTimeout(r, 600))
    }
  })
  // creepjs 要跑一轮 worker + 指纹采集，给足时间
  await main.waitForTimeout(14000)

  const data = await app.evaluate(async ({ BrowserWindow }, script) => {
    const win = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('role=browser'))
    return win.contentView.children[0].webContents.executeJavaScript(script)
  }, DUMP)

  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('role=browser'))
    if (win) win.close()
  })
  await main.waitForTimeout(1200)

  return { label, data }
}

const ids = await main.evaluate(async () => {
  const list = await window.ss.profiles.list()
  let win = list.find((p) => p.platform === 'windows' && p.name.indexOf('审计') === 0)
  let mac = list.find((p) => p.platform === 'macos' && p.name.indexOf('审计') === 0)
  return { win: win && win.id, mac: mac && mac.id }
})

const out = []
if (ids.win) out.push(await run(ids.win, 'Windows 11'))
if (ids.mac) out.push(await run(ids.mac, 'macOS 15'))

console.log(JSON.stringify(out, null, 1))
await app.close()
