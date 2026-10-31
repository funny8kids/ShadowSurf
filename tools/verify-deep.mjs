/**
 * 深链路验收：自检 / 脚本回放 / 审计链，三个必须真的跑起来才算接入。
 * 只跑真实 Electron，不 mock。
 */
import { _electron as electron } from 'playwright-core'

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({
  executablePath: 'G:/Worker-Space/ShadowSurf/node_modules/electron/dist/electron.exe',
  args: ['.'], cwd: 'G:/Worker-Space/ShadowSurf', env, timeout: 30000
})
const main = await app.firstWindow({ timeout: 20000 })
await main.waitForTimeout(2400)

// 1) 起一个环境
const boot = await main.evaluate(async () => {
  const list = await window.ss.profiles.list()
  const target = list.find((p) => p.platform === 'windows') || list[0]
  await window.ss.profiles.launch(target.id)
  return { id: target.id, name: target.name }
})
await main.waitForTimeout(7000)
console.log('环境已启动：', boot.name)

// 2) 一致性自检
const selfcheck = await main.evaluate(async (id) => {
  try {
    const r = await window.ss.selfcheck.run(id)
    const fail = r.items.filter((i) => i.severity === 'fail')
    const warn = r.items.filter((i) => i.severity === 'warn')
    return {
      ok: true,
      score: r.score,
      total: r.items.length,
      fail: fail.map((i) => `${i.label}: 期望 ${i.expected} 实际 ${i.actual}`),
      warn: warn.map((i) => `${i.label}: ${i.actual}`)
    }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  }
}, boot.id)
console.log('自检：', JSON.stringify(selfcheck, null, 1))

// 3) 脚本：新建一条 navigate 步骤并回放
const script = await main.evaluate(async (id) => {
  try {
    const s = await window.ss.scripts.save({
      name: '验收脚本',
      description: '自动化验收生成',
      steps: [{ action: 'navigate', url: 'https://example.com', delayMs: 300 }]
    })
    const run = await window.ss.scripts.run(s.id, id)
    return { ok: true, scriptId: s.id, run }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  }
}, boot.id)
console.log('脚本回放：', JSON.stringify(script))

// 4) 审计链
const audit = await main.evaluate(async () => {
  try {
    const list = await window.ss.audit.list(10)
    const v = await window.ss.audit.verify()
    return { ok: true, count: list.length, head: list.slice(0, 3).map((e) => e.action), verify: v }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  }
})
console.log('审计链：', JSON.stringify(audit))

// 5) 截自检结果页
await main.evaluate(() => window.close && undefined)
const bw = app.windows().find((w) => w.url().includes('role=browser'))
if (bw) await bw.evaluate(() => window.close()).catch(() => {})
await main.waitForTimeout(1200)
const nav = main.locator('aside.side button.nav-item').filter({ hasText: '审计' }).first()
await nav.click({ force: true })
await main.waitForTimeout(1200)
const sel = main.locator('select').first()
if (await sel.count()) {
  await sel.selectOption({ index: 0 }).catch(() => {})
  await main.waitForTimeout(300)
}
const btn = main.locator('button:has-text("开始自检")').first()
if (await btn.count()) {
  await btn.click({ force: true }).catch(() => {})
  await main.waitForTimeout(2500)
}
await main.screenshot({ path: 'G:/Worker-Space/ShadowSurf/docs/app-11-audit.png' })
console.log('已截图 app-11-audit.png')

await app.close()
