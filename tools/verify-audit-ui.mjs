/** 走 UI 路径跑一次自检并截图。导航点击加断言与重试，避免偶发错位。 */
import { _electron as electron } from 'playwright-core'

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({
  executablePath: 'G:/Worker-Space/ShadowSurf/node_modules/electron/dist/electron.exe',
  args: ['.'], cwd: 'G:/Worker-Space/ShadowSurf', env, timeout: 30000
})
const main = await app.firstWindow({ timeout: 20000 })
await main.waitForTimeout(2500)

async function goto(label) {
  for (let i = 0; i < 5; i += 1) {
    await main.locator('aside.side button.nav-item', { hasText: label }).first().click()
    await main.waitForTimeout(700)
    const on = await main.locator('aside.side button.nav-item.on').allTextContents()
    if (on.some((t) => t.includes(label))) return true
  }
  return false
}

if (!(await goto('审计'))) throw new Error('切不到审计页')
console.log('已进入审计页')

const target = await main.evaluate(async () => {
  const list = await window.ss.profiles.list()
  const t = list.find((p) => p.platform === 'windows') || list[0]
  await window.ss.profiles.launch(t.id)
  return { id: t.id, name: t.name }
})
await main.waitForTimeout(8000)
console.log('环境已启动：', target.name)

const sel = main.locator('select').first()
const opts = await sel.locator('option').allTextContents()
const idx = opts.findIndex((t) => t.includes(target.name))
await sel.selectOption({ index: idx >= 0 ? idx : 0 })
await main.waitForTimeout(400)

await main.locator('button', { hasText: '开始自检' }).first().click()
await main.waitForTimeout(8000)

const text = await main.locator('main, .main').first().innerText().catch(() => '')
const flat = text.replace(/\n+/g, ' | ')
console.log('--- 自检页文本 ---')
console.log(flat.slice(0, 1100))

// Playwright 的截图要等合成器出帧，浏览器窗口在的时候会一直等不到。
// 用 Electron 自己的 capturePage 直接抓窗口位图，绕开这条链路。
const png = await app.evaluate(async ({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('role=browser'))
  if (!win) return null
  const img = await win.webContents.capturePage()
  return img.toPNG().toString('base64')
})
if (png) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync('G:/Worker-Space/ShadowSurf/docs/app-11-audit.png', Buffer.from(png, 'base64'))
  console.log('已截图 app-11-audit.png')
} else {
  console.log('未找到控制台窗口')
}
await app.close()
