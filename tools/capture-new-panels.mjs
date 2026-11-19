/** 给三个新面板截图（代理组 / 同步执行 / Webhook） */
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = process.cwd()
const OUT = join(ROOT, 'artifacts/new-panels')
mkdirSync(OUT, { recursive: true })
const UD = mkdtempSync(join(tmpdir(), 'ss-np-'))

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

for (let i = 0; i < 3; i++) {
  await w.evaluate(async (n) => {
    const p = await window.ss.profiles.create({ name: '演示环境 ' + (n + 1) })
    await window.ss.profiles.update(p.id, { group: '演示' })
  }, i)
}
const proxies = []
let pi = 0
for (const name of ['US-住宅-01', 'US-住宅-02', 'UK-机房-01']) {
  pi += 1
  proxies.push(await w.evaluate(async (p) =>
    await window.ss.proxies.create({ name: p.name, protocol: 'socks5', host: p.host, port: 1080 }), { name, host: '10.0.0.' + pi }))
}
await w.evaluate(async (ids) => await window.ss.proxyGroups.create({
  name: '美国住宅轮换池', proxyIds: ids, strategy: 'round-robin', failover: true
}), proxies.map(p => p.id))
await w.evaluate(async () => await window.ss.webhooks.create({
  url: 'https://example.com/hooks/shadowsurf', events: ['task.done', 'task.failed']
}))
await w.evaluate(async () => await window.ss.scripts.save({
  name: '登录并取数', steps: [{ action: 'navigate', url: 'https://example.com' }]
}))
await w.waitForTimeout(600)

const nav = async (label) => {
  const b = w.locator('aside.side button.nav-item', { hasText: label }).first()
  if (await b.count()) {
    await b.click()
    await w.waitForTimeout(700)
  }
}
for (const [label, name] of [['代理组', 'proxy-groups'], ['同步执行', 'sync'], ['Webhook', 'webhooks']]) {
  await nav(label)
  await w.screenshot({ path: join(OUT, name + '.png') })
  console.log('shot', name)
}
await app.close()
rmSync(UD, { recursive: true, force: true })
console.log('DONE')
