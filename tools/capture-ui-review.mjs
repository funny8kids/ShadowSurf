/**
 * Remote UI review: create a profile, open the dual-track browser window,
 * then screenshot horizontal tabs, vertical tabs, and compact console.
 */
import { _electron as electron } from 'playwright-core'
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

const ROOT = resolve(process.cwd())
const SHOTS = resolve(ROOT, 'artifacts/ui-review')
mkdirSync(SHOTS, { recursive: true })

const app = await electron.launch({
  executablePath: resolve(ROOT, 'node_modules/electron/dist/electron'),
  args: ['.', '--user-data-dir=' + resolve(ROOT, 'artifacts/ui-review-ud2'),
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  cwd: ROOT,
  env: { ...process.env, DISPLAY: ':99' },
  timeout: 40000
})
const win = await app.firstWindow()
await win.setViewportSize({ width: 1600, height: 1000 })
await win.waitForTimeout(1800)

// Create a profile via the app's bridge
const prof = await win.evaluate(async () => {
  const list = await window.ss.profiles.list()
  for (const p of Array.isArray(list) ? list : []) {
    if (String(p.name || '').startsWith('验收-UI')) await window.ss.profiles.remove(p.id)
  }
  return await window.ss.profiles.create({ name: '验收-UI', platform: 'windows' })
})
console.log('profile', prof && prof.id)
if (!prof || !prof.id) { console.log('NO_PROFILE'); await app.close(); process.exit(2) }

// Toggle compact density in console, screenshot
try {
  const compact = win.locator('button[title*="紧凑"]').first()
  if (await compact.count()) { await compact.click(); await win.waitForTimeout(400) }
} catch {}
await win.screenshot({ path: resolve(SHOTS, 'v3-console-compact.png') })
console.log('shot console-compact')

// Open the dual-track window
await win.evaluate(async (id) => await window.ss.profiles.launch(id), prof.id)
await win.waitForTimeout(3000)

const browserWin = await app.waitForEvent('window', { timeout: 20000 }).catch(() => null)
const bw = browserWin || (await app.windows()).find((w) => w !== win)
if (!bw) { console.log('NO_BROWSER_WINDOW'); await app.close(); process.exit(3) }
await bw.setViewportSize({ width: 1600, height: 1000 })
await bw.waitForTimeout(1200)
await bw.screenshot({ path: resolve(SHOTS, 'v3-browser-horizontal.png') })
console.log('shot browser-horizontal')

// Toggle vertical tabs
try {
  const vt = bw.locator('button[aria-label="切换垂直标签"]').first()
  if (await vt.count()) { await vt.click(); await bw.waitForTimeout(600) }
} catch {}
await bw.screenshot({ path: resolve(SHOTS, 'v3-browser-vertical.png') })
console.log('shot browser-vertical')

await app.close()
console.log('DONE')
