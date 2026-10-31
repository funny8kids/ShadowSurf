/** 清理验收过程中生成的重复环境与脚本，只保留最初的两个环境 */
import { _electron as electron } from 'playwright-core'
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({
  executablePath: 'G:/Worker-Space/ShadowSurf/node_modules/electron/dist/electron.exe',
  args: ['.'], cwd: 'G:/Worker-Space/ShadowSurf', env, timeout: 30000
})
const main = await app.firstWindow({ timeout: 20000 })
await main.waitForTimeout(2400)
const out = await main.evaluate(async () => {
  const list = await window.ss.profiles.list()
  const drop = list.filter((p) => p.name.includes('副本'))
  for (const p of drop) await window.ss.profiles.remove(p.id)
  const scripts = await window.ss.scripts.list()
  for (const s of scripts) await window.ss.scripts.remove(s.id)
  const tpls = await window.ss.templates.list()
  const keep = tpls.filter((t) => !t.builtin)
  for (const t of keep) await window.ss.templates.remove(t.id)
  const left = await window.ss.profiles.list()
  return { removed: drop.length, left: left.map((p) => p.name), scripts: (await window.ss.scripts.list()).length }
})
console.log(JSON.stringify(out))
await app.close()
