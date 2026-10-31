/**
 * 六个功能模块的界面验收截图。
 *
 * 编译通过不等于能用：面板挂载、IPC 通道注册、空状态渲染这几件事
 * 只有真跑起来才知道。每张图都顺手把控制台报错抓出来。
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

const errors = []
main.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text())
})
main.on('pageerror', (err) => errors.push('pageerror: ' + err.message))

await main.waitForTimeout(2200)

const shots = [
  ['代理', 'app-6-proxies.png'],
  ['自动化', 'app-7-scripts.png'],
  ['模板', 'app-8-templates.png'],
  ['数据', 'app-9-data.png'],
  ['本地 API', 'app-10-localapi.png'],
  ['审计', 'app-11-audit.png']
]

for (const [label, file] of shots) {
  await main.locator(`button.nav-item:has-text("${label}")`).first().click()
  await main.waitForTimeout(1400)
  await main.screenshot({ path: `${OUT}/${file}` })
  const heading = await main.locator('.tool-panel h2').first().innerText().catch(() => '(无标题)')
  console.log(`${label} → ${heading} → ${file}`)
}

// 顺手验证一个真实 IPC 往返：本地 API 启动
await main.locator('button.nav-item:has-text("本地 API")').first().click()
await main.waitForTimeout(800)
// 渲染层有 CSP（connect-src 'self'），不能在页面里 fetch 本地服务，
// 所以用测试脚本自己的 Node fetch 打过去，这才是外部客户端的真实路径。
const started = await main.evaluate(async () => {
  try {
    const s = await window.ss.localApi.start(7731)
    const state = await window.ss.localApi.state()
    return { ok: true, running: s.running, port: state.port, token: state.token }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  }
})
if (started.ok) {
  const noAuth = await fetch(`http://127.0.0.1:${started.port}/profiles`).then((r) => r.status)
  const health = await fetch(`http://127.0.0.1:${started.port}/health`).then((r) => r.json())
  const withAuth = await fetch(`http://127.0.0.1:${started.port}/profiles`, {
    headers: { authorization: `Bearer ${started.token}` }
  }).then((r) => r.json())
  started.health = health
  started.noAuthStatus = noAuth
  started.profileCount = Array.isArray(withAuth) ? withAuth.length : withAuth
  delete started.token
  await main.evaluate(() => window.ss.localApi.stop())
}
console.log('本地 API 往返：', JSON.stringify(started))

// 再验一个：审计链
const audit = await main.evaluate(async () => {
  try {
    const v = await window.ss.audit.verify()
    const list = await window.ss.audit.list(5)
    return { ok: true, verify: v, count: list.length }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  }
})
console.log('审计链：', JSON.stringify(audit))

if (errors.length) {
  console.log('--- 控制台报错 ---')
  for (const e of errors.slice(0, 12)) console.log('  ' + e)
} else {
  console.log('控制台无报错')
}

await app.close()
