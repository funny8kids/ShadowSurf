import { _electron as electron } from 'playwright-core'
import { spawn } from 'node:child_process'

// 1) 起 mock 模型服务
const mock = spawn('node', ['tools/mock-llm.mjs', '9980'], { cwd: 'G:/Worker-Space/ShadowSurf', stdio: ['ignore', 'pipe', 'pipe'] })
mock.stdout.on('data', (d) => process.stdout.write(`  ${d}`))
await new Promise((r) => setTimeout(r, 800))

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: 'G:/Worker-Space/ShadowSurf/node_modules/electron/dist/electron.exe',
  args: ['.'], cwd: 'G:/Worker-Space/ShadowSurf', env, timeout: 30000
})
const main = await app.firstWindow({ timeout: 20000 })
await main.waitForTimeout(1500)
await main.locator('article').first().locator('button:has-text("打开")').first().click()
await main.waitForTimeout(5000)

const bw = app.windows().find((w) => w.url().includes('role=browser'))
if (!bw) { console.log('无浏览器窗口'); mock.kill(); await app.close(); process.exit(1) }

const result = await bw.evaluate(async () => {
  const events = []
  const off = window.ss.agent.onEvent((e) => events.push(e))
  const profileId = new URLSearchParams(location.search).get('profileId')

  // 指向本地 mock，免 Key
  await window.ss.settings.set({
    provider: 'custom',
    baseUrl: 'http://127.0.0.1:9980/v1',
    model: 'mock-agent',
    apiKey: '',
    maxSteps: 6
  })

  try {
    const task = await window.ss.agent.run({ profileId, intent: '打开示例页并告诉我标题' })
    return { events, task }
  } catch (err) {
    return { events, error: String(err) }
  } finally {
    off()
  }
})

if (result.error) {
  console.log('运行失败:', result.error)
} else {
  const kinds = result.events.map((e) => e.type)
  console.log('\n事件序列:', kinds.join(' → '))
  const plan = result.events.find((e) => e.type === 'plan')
  if (plan) console.log('计划:', plan.plan.join(' / '))
  for (const e of result.events.filter((x) => x.type === 'step')) {
    const s = e.step
    console.log(`  第${s.index + 1}步 [${s.status}] ${s.label}${s.result ? ' → ' + s.result.slice(0, 50) : ''}`)
  }
  const done = result.events.find((e) => e.type === 'done')
  if (done) console.log('收尾:', done.summary)
  console.log('任务状态:', result.task.status, '| 步数:', result.task.steps.length, '| token:', result.task.tokens)
}

// 任务页截图
await bw.evaluate(() => window.close()).catch(() => {})
await main.waitForTimeout(800)
await main.locator('button.nav-item:has-text("任务")').first().click().catch((e) => console.log('导航失败', String(e).slice(0, 60)))
await main.waitForTimeout(1000)
await main.screenshot({ path: 'G:/Worker-Space/ShadowSurf/docs/assets/_run/05-tasks.png' })

mock.kill()
await app.close()
