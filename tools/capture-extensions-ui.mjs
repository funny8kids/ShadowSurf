/** 扩展面板 + 抽屉扩展多选的视觉验收截图（远程 Xvfb） */
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = '/home/Developer/ShadowSurf'
const UD = mkdtempSync(join(tmpdir(), 'ss-uiext-'))
const EXT = join(UD, 'ext')
mkdirSync(EXT, { recursive: true })
writeFileSync(
  join(EXT, 'manifest.json'),
  JSON.stringify({ manifest_version: 3, name: 'Demo Helper', version: '1.0.0' })
)

execSync(`mkdir -p ${ROOT}/artifacts/ui-review`)

const app = await electron.launch({
  executablePath: resolve(ROOT, 'node_modules/electron/dist/electron'),
  args: ['.', '--user-data-dir=' + UD, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  cwd: ROOT,
  env: { ...process.env, DISPLAY: ':99' },
  timeout: 60000
})
const w = await app.firstWindow()
await w.setViewportSize({ width: 1600, height: 1000 })
await w.waitForTimeout(1800)

const ext = await w.evaluate(async (path) => await window.ss.extensions.create({ name: 'Demo Helper', path }), EXT)
const prof = await w.evaluate(async (extId) => {
  const p = await window.ss.profiles.create({ name: '演示环境', platform: 'windows' })
  return await window.ss.profiles.update(p.id, { extensionIds: [extId] })
}, ext.id)
await w.waitForTimeout(600)

const nav = async (label) => {
  const b = w.locator('aside.side button.nav-item', { hasText: label }).first()
  if (await b.count()) {
    await b.click()
    await w.waitForTimeout(500)
    return true
  }
  return false
}

console.log('nav extensions:', await nav('扩展'))
await w.screenshot({ path: resolve(ROOT, 'artifacts/ui-review/ext-panel.png') })
console.log('shot ext-panel')

console.log('nav workbench:', await nav('环境'))
const card = w.locator('article.env').first()
await card.hover()
await w.waitForTimeout(400)
const cfg = card.locator('button', { hasText: '配置' }).first()
if (await cfg.count()) {
  await cfg.click({ force: true })
  await w.waitForTimeout(700)
  const basic = w.locator('.drawer button.dtab', { hasText: '基础' }).first()
  if (await basic.count()) { await basic.click(); await w.waitForTimeout(400) }
  await w.screenshot({ path: resolve(ROOT, 'artifacts/ui-review/ext-drawer.png') })
  console.log('shot ext-drawer')
} else {
  console.log('configure button not found')
}

await app.close()
rmSync(UD, { recursive: true, force: true })
console.log('DONE')
