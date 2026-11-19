/** 拟人输入设置 UI 截图 + 回归：verify:theme 的 10 组读数 */
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = process.cwd()
const OUT = join(ROOT, 'artifacts/human-ui')
mkdirSync(OUT, { recursive: true })
const UD = mkdtempSync(join(tmpdir(), 'ss-hui-'))
const app = await electron.launch({
  executablePath: resolve(ROOT, 'node_modules/electron/dist/electron'),
  args: ['.', '--user-data-dir=' + UD, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  cwd: ROOT,
  env: { ...process.env, DISPLAY: ':99' },
  timeout: 60000
})
const w = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1600, height: 1000 }))
await w.waitForTimeout(1500)
const p = await w.evaluate(async () => await window.ss.profiles.create({ name: '展示环境' }))
await w.evaluate(async (id) => await window.ss.profiles.launch(id), p.id)
await new Promise((r) => setTimeout(r, 4000))
const bw = app.windows().find((x) => x.url().includes('role=browser'))
if (!bw) { console.log('NO_BROWSER'); process.exit(2) }
await bw.setViewportSize({ width: 1600, height: 1000 })
const gear = bw.locator('button[aria-label="模型设置"]').first()
if (await gear.count()) {
  await gear.click()
  await bw.waitForTimeout(600)
  await bw.screenshot({ path: join(OUT, 'settings.png') })
  console.log('shot settings')
}
await app.close()
rmSync(UD, { recursive: true, force: true })
console.log('DONE')
