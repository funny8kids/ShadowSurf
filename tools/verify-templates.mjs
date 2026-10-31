/** 只验证模板与迁移模块：截图 + 真实 IPC 往返 */
import { _electron as electron } from 'playwright-core'

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({
  executablePath: 'G:/Worker-Space/ShadowSurf/node_modules/electron/dist/electron.exe',
  args: ['.'], cwd: 'G:/Worker-Space/ShadowSurf', env, timeout: 30000
})
const main = await app.firstWindow({ timeout: 20000 })
await main.waitForTimeout(2400)

// 先跑功能往返，再截图（截图时列表里已有数据，更可信）
const res = await main.evaluate(async () => {
  const out = {}
  try {
    const before = await window.ss.templates.list()
    out.builtinBefore = before.length
    const profiles = await window.ss.profiles.list()
    const target = profiles[0]
    const tpl = await window.ss.templates.save(target.id, '验证模板', '自动化验收生成')
    out.saved = tpl.name
    const after = await window.ss.templates.list()
    out.total = after.length
    const applied = await window.ss.templates.apply(tpl.id, profiles[1].id)
    out.applied = applied.fingerprint.timezone
    out.targetTz = profiles[1].fingerprint.timezone
    const bundle = await window.ss.migration.export(profiles.map((p) => p.id))
    out.bundleBytes = bundle.length
    out.bundleHasKey = bundle.indexOf('apiKey') >= 0
    const parsed = JSON.parse(bundle)
    out.bundleProfiles = parsed.profiles.length
    const imported = await window.ss.migration.import(bundle)
    out.imported = imported
    await window.ss.templates.remove(tpl.id)
    out.afterRemove = (await window.ss.templates.list()).length
  } catch (e) {
    out.error = String(e && e.message ? e.message : e)
  }
  return out
})
console.log('模板/迁移往返：', JSON.stringify(res))

// 清掉可能的 toast 再点导航，避免浮层挡住按钮
await main.mouse.click(640, 400)
await main.waitForTimeout(300)
const nav = main.locator('aside.side button.nav-item').filter({ hasText: '模板' }).first()
await nav.click({ force: true })
await main.waitForTimeout(1800)
await main.screenshot({ path: 'G:/Worker-Space/ShadowSurf/docs/app-8-templates.png' })
console.log('已截图 app-8-templates.png')

await app.close()
