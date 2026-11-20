/**
 * 本轮修复的视觉验收：
 *   1. Ctrl+K 打开命令面板（不再是搜索框抢焦点）
 *   2. 按 / 聚焦搜索框（新入口）
 *   3. 任务页空态（应满宽）
 *   4. 同步执行页（应有三态）
 *   5. 1280×700 矮窗口下侧栏仍可滚到底（账户信息可达）
 */
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = process.cwd()
const OUT = join(ROOT, 'artifacts/audit-fix')
mkdirSync(OUT, { recursive: true })
const UD = mkdtempSync(join(tmpdir(), 'ss-auditfix-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const app = await electron.launch({
  executablePath: resolve(ROOT, 'node_modules/electron/dist/electron'),
  args: ['.', '--user-data-dir=' + UD, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  cwd: ROOT,
  env: { ...process.env, DISPLAY: ':99' },
  timeout: 60000
})
const w = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1600, height: 1000 }))
await w.waitForTimeout(1600)

const shot = async (n) => {
  await w.screenshot({ path: join(OUT, n + '.png') })
  console.log('shot', n)
}
const nav = async (label) => {
  const b = w.locator('aside.side button.nav-item', { hasText: label }).first()
  if (await b.count()) {
    await b.click()
    await w.waitForTimeout(600)
  }
}

for (const n of ['演示 A', '演示 B', '演示 C']) {
  await w.evaluate(async (name) => await window.ss.profiles.create({ name, platform: 'windows' }), n)
}
await w.waitForTimeout(700)

// 1) Ctrl+K → 命令面板（不是搜索框）
await w.keyboard.press('Control+k')
await w.waitForTimeout(700)
const paletteOpen = await w.locator('.cp-dialog').count()
console.log('palette after Ctrl+K:', paletteOpen)
await shot('01-palette-ctrlk')
await w.keyboard.press('Escape')
await w.waitForTimeout(400)

// 2) 按 / → 搜索框聚焦
await w.keyboard.press('/')
await w.waitForTimeout(400)
const focusInfo = await w.evaluate(() => {
  const el = document.activeElement
  return { tag: el?.tagName, cls: el?.className, isSearch: !!el?.closest?.('.search') }
})
console.log('focus after /:', JSON.stringify(focusInfo))
await shot('02-search-slash')
await w.keyboard.press('Escape')
await w.waitForTimeout(300)

// 3) 任务页空态
await nav('任务')
await shot('03-tasks-empty')
await nav('环境')

// 4) 同步执行页
await nav('同步执行')
await shot('04-sync-panel')
await nav('环境')

// 5) 1280×700 矮窗口：侧栏底部是否可达
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1280, height: 700 }))
await w.waitForTimeout(700)
await shot('05-sidebar-1280x700')
const scrollInfo = await w.evaluate(() => {
  const sc = document.querySelector('.nav-scroll')
  if (!sc) return null
  return {
    scrollHeight: sc.scrollHeight,
    clientHeight: sc.clientHeight,
    scrollable: sc.scrollHeight > sc.clientHeight,
    overflowY: getComputedStyle(sc).overflowY
  }
})
console.log('nav-scroll:', JSON.stringify(scrollInfo))

await app.close()
rmSync(UD, { recursive: true, force: true })
console.log('DONE')