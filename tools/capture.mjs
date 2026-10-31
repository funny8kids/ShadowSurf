/**
 * 产品截图：跑一遍真实应用，把五个关键界面拍下来。
 * 需要先构建（npm run build），且本地已有至少一个环境。
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const OUT = 'G:/Worker-Space/ShadowSurf/docs'
mkdirSync(OUT, { recursive: true })

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: 'G:/Worker-Space/ShadowSurf/node_modules/electron/dist/electron.exe',
  args: ['.'], cwd: 'G:/Worker-Space/ShadowSurf', env, timeout: 30000
})
const main = await app.firstWindow({ timeout: 20000 })
await main.waitForTimeout(2000)
await main.screenshot({ path: `${OUT}/app-1-console.png` })
console.log('1 控制台')

// 指纹抽屉
await main.locator('article').first().locator('button:has-text("配置")').first().click()
await main.waitForTimeout(1000)
await main.screenshot({ path: `${OUT}/app-2-fingerprint.png` })
console.log('2 指纹抽屉')
await main.keyboard.press('Escape')
await main.waitForTimeout(600)

// 双轨窗口
await main.locator('article').first().locator('button:has-text("打开")').first().click()
await main.waitForTimeout(6000)
const bw = app.windows().find((w) => w.url().includes('role=browser'))
await bw.waitForTimeout(800)
await bw.screenshot({ path: `${OUT}/app-3-dual-track.png` })
console.log('3 双轨窗口')

// 模型设置
await bw.locator('button[aria-label="模型设置"]').click()
await bw.waitForTimeout(900)
await bw.screenshot({ path: `${OUT}/app-4-settings.png` })
console.log('4 模型设置')
await bw.keyboard.press('Escape')
await bw.waitForTimeout(500)

// 任务页
await bw.evaluate(() => window.close()).catch(() => {})
await main.waitForTimeout(1000)
await main.locator('button.nav-item:has-text("任务")').first().click()
await main.waitForTimeout(1200)
await main.screenshot({ path: `${OUT}/app-5-tasks.png` })
console.log('5 任务回放')

await app.close()
