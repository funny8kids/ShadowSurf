/**
 * 模板库「零预置」端到端验收：
 *   1. 首次启动模板库为空（不再播种三张内置模板）
 *   2. 从真实环境保存 → 应用 → 删除全链路
 *   3. 模拟老数据（builtin:true 的模板）→ 下次 list() 自动清理
 *
 * 跑法（远程）：DISPLAY=:99 node tools/e2e-templates.mjs
 */
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = process.cwd()
const UD = mkdtempSync(join(tmpdir(), 'ss-e2e-tpl-'))
const failures = []
const check = (cond, label, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}${detail ? ' · ' + detail : ''}`)
  if (!cond) failures.push(label)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const app = await electron.launch({
  executablePath: resolve(ROOT, 'node_modules/electron/dist/electron'),
  args: ['.', '--user-data-dir=' + UD, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  cwd: ROOT,
  env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
  timeout: 60000
})
const w = await app.firstWindow()
await w.waitForTimeout(1800)

try {
  /* ── 1. 首次启动：零预置 ── */
  console.log('\n[1] 模板库从空开始')
  const first = await w.evaluate(async () => await window.ss.templates.list())
  check(Array.isArray(first) && first.length === 0, '新数据目录模板库为空', `count=${first.length}`)

  // 反复读取也不该冒出模板
  await w.evaluate(async () => await window.ss.templates.list())
  const again = await w.evaluate(async () => await window.ss.templates.list())
  check(again.length === 0, '重复读取不会生成内置模板')

  /* ── 2. 保存 / 应用 / 删除 ── */
  console.log('\n[2] 用户自建模板全链路')
  const profile = await w.evaluate(async () => {
    const p = await window.ss.profiles.create({ name: '源环境' })
    return await window.ss.profiles.update(p.id, {
      group: '演示',
      note: '这是一份真实环境'
    })
  })
  const tpl = await w.evaluate(
    async (id) => await window.ss.templates.save(id, '我的 Windows 配置', '从真实环境保存'),
    profile.id
  )
  check(tpl.name === '我的 Windows 配置', '从环境保存模板成功', tpl.id)
  check(tpl.builtin === undefined, '新模板不带 builtin 标记')
  check(tpl.fingerprint && tpl.os, '模板含完整指纹快照')

  const list1 = await w.evaluate(async () => await window.ss.templates.list())
  check(list1.length === 1, '模板库只有用户保存的那一份', `count=${list1.length}`)

  const target = await w.evaluate(async () => await window.ss.profiles.create({ name: '目标环境' }))
  const applied = await w.evaluate(
    async (p) => await window.ss.templates.apply(p.tid, p.pid),
    { tid: tpl.id, pid: target.id }
  )
  check(applied.id === target.id, '模板可应用到另一个环境')

  // 删除后模板库再次为空
  await w.evaluate(async (id) => await window.ss.templates.remove(id), tpl.id)
  const list2 = await w.evaluate(async () => await window.ss.templates.list())
  check(list2.length === 0, '用户模板可删除')

  /* ── 3. 老数据清理 ── */
  console.log('\n[3] 旧内置模板自动清理')
  // 直接往 data/templates.json 写一份带 builtin:true 的老格式记录，
  // 然后触发一次 list()。注意 envelope 格式 {schema, data}。
  const dataFile = join(UD, 'data', 'templates.json')
  await app.close()
  // JsonStore 只在有写入时落盘；若文件不存在，造一份合法的 envelope
  const envelope = existsSync(dataFile)
    ? JSON.parse(readFileSync(dataFile, 'utf8'))
    : { schema: 1, data: [] }
  envelope.data.push({
    id: 'tpl_legacy_builtin',
    name: '内置 · Windows 11',
    description: '旧版本预置',
    os: 'windows',
    fingerprint: profile.fingerprint,
    builtin: true,
    createdAt: 1
  })
  writeFileSync(dataFile, JSON.stringify(envelope))

  const app2 = await electron.launch({
    executablePath: resolve(ROOT, 'node_modules/electron/dist/electron'),
    args: ['.', '--user-data-dir=' + UD, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    cwd: ROOT,
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
    timeout: 60000
  })
  const w2 = await app2.firstWindow()
  await w2.waitForTimeout(1800)
  const cleaned = await w2.evaluate(async () => await window.ss.templates.list())
  check(
    cleaned.length === 0 && !cleaned.some((t) => t.builtin),
    '旧 builtin 模板被自动清理',
    `count=${cleaned.length}`
  )
  await app2.close()
} finally {
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
