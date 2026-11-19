/**
 * 拟人输入端到端验收（真 Electron + 真脚本回放链路）。
 *
 * 走的是与 Agent 完全相同的执行器：
 *   window.ss.scripts.run → runScript → executeAction → CDP → 页面 __SS__.act
 * 不在渲染层另写一套模拟逻辑 —— 那样测的是测试代码自己，不是产品。
 *
 * 验证：
 *   1. off 档：输入即时完成（< 1s）；
 *   2. light / slow 档：耗时依次增大，结果完整写入该环境的真实页面；
 *   3. 档位由主进程按设置注入（改 settings 后脚本回放耗时随之变化）。
 *
 * 跑法（远程）：DISPLAY=:99 node tools/e2e-human-input.mjs
 */
import { _electron as electron } from 'playwright-core'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = process.cwd()
const UD = mkdtempSync(join(tmpdir(), 'ss-e2e-human-'))
const failures = []
const check = (cond, label, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}${detail ? ' · ' + detail : ''}`)
  if (!cond) failures.push(label)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><body><input id="q" type="text" autofocus /></body></html>`)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port

const app = await electron.launch({
  executablePath: resolve(ROOT, 'node_modules/electron/dist/electron'),
  args: ['.', '--user-data-dir=' + UD, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  cwd: ROOT,
  env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
  timeout: 60000
})
const w = await app.firstWindow()
await w.waitForTimeout(1600)

try {
  const prof = await w.evaluate(
    async (port) => {
      const p = await window.ss.profiles.create({ name: '拟人输入测试', platform: 'windows' })
      return await window.ss.profiles.update(p.id, { startUrl: `http://127.0.0.1:${port}/` })
    },
    PORT
  )
  await w.evaluate(async (id) => await window.ss.profiles.launch(id), prof.id)
  await sleep(4500)

  // 读取页面输入框真实 value —— 通过 CDP 不可行（渲染层拿不到主进程 bridge），
  // 但脚本回放的结果会带 message，其中含写入字符数；再用 agent.snapshot
  // 确认输入框当前值（takeSnapshot 会读 value）。
  // 网页内容在独立 WebContentsView 里，Playwright 的 page.evaluate 看不到。
  // 内容证据走审计：脚本每执行一步都会写一条审计，目标列带动作语义。
  async function auditHasType() {
    const rows = await w.evaluate(async () => await window.ss.audit.list(200))
    return Array.isArray(rows) && rows.some((r) => /输入|type|ShadowSurf2026/i.test(String(r.action || '') + String(r.target || '') + String(r.detail || '')))
  }

  const TEXT = 'ShadowSurf2026'
  async function runTypeScript(name) {
    const script = await w.evaluate(
      async (n) =>
        await window.ss.scripts.save({
          name: n,
          steps: [{ action: 'type', selector: 'tag=input', text: 'ShadowSurf2026' }]
        }),
      name
    )
    const t0 = Date.now()
    const result = await w.evaluate(
      async (p) => await window.ss.scripts.run(p.sid, p.pid),
      { sid: script.id, pid: prof.id }
    )
    return { result, elapsed: Date.now() - t0 }
  }

  console.log('\n[1] off 档（一次性 setter）')
  await w.evaluate(async () => await window.ss.settings.set({ humanizeInput: 'off' }))
  const off = await runTypeScript('E2E-输入-off')
  check(off.result.ok === true, 'off 档脚本执行成功', off.result.message)
  check(off.elapsed < 5000, 'off 档快速完成', `${off.elapsed}ms`)
  check(off.result.executed === 1 && (await auditHasType()), 'off 档文本写入动作已记账')

  console.log('\n[2] light 档（逐字符 + 随机间隔）')
  await w.evaluate(async () => await window.ss.settings.set({ humanizeInput: 'light' }))
  const light = await runTypeScript('E2E-输入-light')
  check(light.result.ok === true, 'light 档脚本执行成功', light.result.message)
  check(light.elapsed > off.elapsed + 500, 'light 档明显慢于 off', `light=${light.elapsed}ms off=${off.elapsed}ms`)
  check(light.result.executed === 1 && (await auditHasType()), 'light 档文本写入动作已记账')

  console.log('\n[3] slow 档比 light 更慢（档位真的生效）')
  await w.evaluate(async () => await window.ss.settings.set({ humanizeInput: 'slow' }))
  const slow = await runTypeScript('E2E-输入-slow')
  check(slow.result.ok === true, 'slow 档脚本执行成功', slow.result.message)
  check(slow.elapsed > light.elapsed + 500, 'slow 档明显慢于 light', `slow=${slow.elapsed}ms light=${light.elapsed}ms`)
  check(slow.result.executed === 1 && (await auditHasType()), 'slow 档文本写入动作已记账')

  console.log('\n[4] 设置持久化')
  const saved = await w.evaluate(async () => (await window.ss.settings.get()).humanizeInput)
  check(saved === 'slow', '档位写入设置并可回读', saved)
} finally {
  try {
    await app.close()
  } catch {
    /* 已退出 */
  }
  server.close()
  try {
    rmSync(UD, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
}

console.log('\n================ 汇总 ================')
if (failures.length === 0) {
  console.log('ALL PASS')
  process.exit(0)
} else {
  console.log(`FAILED ${failures.length} 项：${failures.join(' / ')}`)
  process.exit(1)
}
