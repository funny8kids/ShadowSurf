import { _electron as electron } from 'playwright-core'
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({
  executablePath: 'G:/Worker-Space/ShadowSurf/node_modules/electron/dist/electron.exe',
  args: ['.'], cwd: 'G:/Worker-Space/ShadowSurf', env, timeout: 30000
})
const main = await app.firstWindow({ timeout: 20000 })
await main.waitForTimeout(2500)

const all = await main.locator('aside.side button.nav-item').allTextContents()
console.log('导航项：', JSON.stringify(all))

for (const label of ['审计', '数据', '模板']) {
  const loc = main.locator('aside.side button.nav-item', { hasText: label })
  console.log(`匹配 "${label}" 的数量：`, await loc.count())
}

await main.locator('aside.side button.nav-item', { hasText: '审计' }).first().click()
await main.waitForTimeout(1200)
const titles = await main.locator('.tool-panel h2').allTextContents()
console.log('点审计后 .tool-panel h2 全部：', JSON.stringify(titles))
const navActive = await main.locator('aside.side button.nav-item.on').allTextContents()
console.log('高亮项：', JSON.stringify(navActive))
await app.close()
