/**
 * README 配图：真实应用 + 一组可展示的环境数据。
 *
 * 和 tools/capture.mjs 的区别：
 * - 不依赖本机已有环境，自己建 3 个演示环境（含分组 / 颜色 / 收藏 / 启动页）
 * - 控制台按 1600×1000 截图，双轨窗口用 desktopCapturer 抓整屏（WebContentsView
 *   是主进程合成的，page.screenshot 拍不到网页内容）
 * - 输出到 docs/screenshots/，README 直接引用
 *
 * 跑法（远程 Xvfb）：DISPLAY=:99 node tools/capture-readme-shots.mjs
 */

import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = process.cwd()
const OUT = join(ROOT, 'docs/screenshots')
mkdirSync(OUT, { recursive: true })

const UD = mkdtempSync(join(tmpdir(), 'ss-readme-'))
const EXT = join(UD, 'demo-extension')
mkdirSync(EXT, { recursive: true })
writeFileSync(
  join(EXT, 'manifest.json'),
  JSON.stringify({ manifest_version: 3, name: 'Price Watcher', version: '1.0.0' })
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const app = await electron.launch({
  executablePath: resolve(ROOT, 'node_modules/electron/dist/electron'),
  args: ['.', '--user-data-dir=' + UD, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  cwd: ROOT,
  env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
  timeout: 60000
})

const w = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0]
  win.setBounds({ x: 0, y: 0, width: 1600, height: 1000 })
})
await w.waitForTimeout(1800)

/* 三个演示环境：名字、分组、颜色、收藏、启动页都填上，卡片才不是空壳 */
const demo = [
  { name: '主店 · 美国', group: '店铺', color: '#0F766E', favorite: true, startUrl: 'https://example.com' },
  { name: '广告投放 · 英国', group: '广告', color: '#0EA5E9', favorite: false, startUrl: 'https://example.com' },
  { name: '数据采集 · 日本', group: '采集', color: '#8B5CF6', favorite: false, startUrl: 'https://example.com' }
]
const created = []
for (const d of demo) {
  const p = await w.evaluate(async (input) => {
    const rec = await window.ss.profiles.create({ name: input.name, platform: 'windows' })
    return await window.ss.profiles.update(rec.id, {
      group: input.group,
      color: input.color,
      favorite: input.favorite,
      startUrl: input.startUrl,
      note: input.name.includes('广告') ? 'Meta / Google 双平台素材测试' : ''
    })
  }, d)
  created.push(p)
}
const ext = await w.evaluate(async (path) => await window.ss.extensions.create({ name: 'Price Watcher', path }), EXT)
await w.evaluate(async (p) => await window.ss.profiles.update(p.id, { extensionIds: [p.extId] }), {
  id: created[0].id,
  extId: ext.id
})
await w.waitForTimeout(800)

/* 1. 控制台 · 亮色 */
await w.screenshot({ path: join(OUT, 'console-light.png') })
console.log('console-light')

/* 2. 控制台 · 暗色 */
await w.evaluate(async () => await window.ss.settings.set({ theme: 'dark' }))
await w.waitForTimeout(900)
await w.screenshot({ path: join(OUT, 'console-dark.png') })
console.log('console-dark')
await w.evaluate(async () => await window.ss.settings.set({ theme: 'light' }))
await w.waitForTimeout(700)

/* 3. 扩展面板 */
const nav = async (label) => {
  const b = w.locator('aside.side button.nav-item', { hasText: label }).first()
  if (await b.count()) {
    await b.click()
    await w.waitForTimeout(600)
    return true
  }
  return false
}
await nav('扩展')
await w.screenshot({ path: join(OUT, 'extensions.png') })
console.log('extensions')

/* 4. 环境抽屉（基础页，含扩展绑定） */
await nav('环境')
const card = w.locator('article.env').first()
await card.hover()
await sleep(350)
const cfg = card.locator('button', { hasText: '配置' }).first()
if (await cfg.count()) {
  await cfg.click({ force: true })
  await w.waitForTimeout(700)
  const basic = w.locator('.drawer button.dtab', { hasText: '基础' }).first()
  if (await basic.count()) {
    await basic.click()
    await w.waitForTimeout(400)
  }
  await w.screenshot({ path: join(OUT, 'profile-drawer.png') })
  console.log('profile-drawer')
  await w.keyboard.press('Escape')
  await w.waitForTimeout(500)
}

/* 5. 双轨窗口整屏截图：page.screenshot 拍不到 WebContentsView，走 desktopCapturer */
await w.evaluate(async (id) => await window.ss.profiles.launch(id), created[0].id)
await sleep(2500)
await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('role=browser'))
  if (win) win.setBounds({ x: 0, y: 0, width: 1920, height: 1080 })
})
await sleep(8000)
// 只留浏览器窗口：控制台窗口叠在上面会把整屏截图搞脏
await app.evaluate(({ BrowserWindow }) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.getURL().includes('role=browser')) win.hide()
  }
})
await sleep(700)

const png = await app.evaluate(async ({ desktopCapturer }) => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1920, height: 1080 }
  })
  const screen = sources.find((s) => s.id.startsWith('screen')) ?? sources[0]
  return screen?.thumbnail.toPNG().toString('base64') ?? ''
})
if (png) {
  writeFileSync(join(OUT, 'browser-window.png'), Buffer.from(png, 'base64'))
  console.log('browser-window')
} else {
  // 退化：至少留一张双轨外壳
  const bw = app.windows().find((p) => p.url().includes('role=browser'))
  if (bw) {
    await bw.screenshot({ path: join(OUT, 'browser-window.png') })
    console.log('browser-window (shell only)')
  }
}

await app.close()
rmSync(UD, { recursive: true, force: true })
console.log('DONE')
