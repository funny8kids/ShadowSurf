/**
 * 四项新功能的端到端验收（真应用 + 真 Electron，不是内存模型）。
 *
 * 覆盖：
 *   1. 扩展：登记 → 绑到环境 → 启动时真的装进该环境的 session（用内容脚本写 cookie 证明）
 *   2. 预热：对本地 HTTP 服务串行访问两页，报告全成功
 *   3. 定时：runNow 启动环境；缺运行环境的脚本定时被拒
 *   4. 回收站：软删除 / 恢复 / 彻底删除在真 IPC 上的语义
 *
 * 跑法（远程，Xvfb）：
 *   DISPLAY=:99 node tools/e2e-new-features.mjs
 *
 * 依赖：playwright-core + 已构建的 out/（npm run build）。
 */

import { _electron as electron } from 'playwright-core'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = process.cwd()
const UD = mkdtempSync(join(tmpdir(), 'ss-e2e-new-'))
const EXT_DIR = join(UD, 'ext-src') // 放在 user-data 里，一次清理
const failures = []

function check(cond, label, detail) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}${detail ? ' · ' + detail : ''}`)
  if (!cond) failures.push(label + (detail ? ' · ' + detail : ''))
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/* 本地站点：预热与启动页都指向它，避开公网不确定性 */
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><meta charset="utf-8"><title>SS E2E</title><h1>ok</h1>')
})
await new Promise((resolve_) => server.listen(0, '127.0.0.1', resolve_))
const PORT = server.address().port
const BASE = `http://127.0.0.1:${PORT}`

/* 最小 MV3 扩展：内容脚本在 document_start 写一个 cookie。
   cookie 落在环境自己的分区里，主进程能读到 —— 这就是「扩展真的装上了」的证据。 */
mkdirSync(EXT_DIR, { recursive: true })
writeFileSync(
  join(EXT_DIR, 'manifest.json'),
  JSON.stringify(
    {
      manifest_version: 3,
      name: 'SS E2E Marker',
      version: '1.0.0',
      content_scripts: [
        {
          matches: ['http://127.0.0.1/*', 'http://localhost/*'],
          js: ['cs.js'],
          run_at: 'document_start'
        }
      ]
    },
    null,
    2
  )
)
writeFileSync(join(EXT_DIR, 'cs.js'), "document.cookie = 'ss_ext_mark=1; path=/'\n")

const app = await electron.launch({
  executablePath: resolve(ROOT, 'node_modules/electron/dist/electron'),
  args: [
    '.',
    '--user-data-dir=' + UD,
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader'
  ],
  cwd: ROOT,
  env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
  timeout: 60000
})

const w = await app.firstWindow()
await w.waitForTimeout(1800)

/* 主进程的扩展日志：装载失败时唯一能说明原因的地方 */
const proc = app.process()
const watch = (stream, tag) => {
  stream?.on('data', (chunk) => {
    const text = String(chunk)
    for (const line of text.split('\n')) {
      if (/扩展|loadExtension/i.test(line)) console.log(`[main:${tag}] ${line.trim()}`)
    }
  })
}
watch(proc.stdout, 'out')
watch(proc.stderr, 'err')

try {
  /* ───────────── 1. 扩展 ───────────── */
  console.log('\n[1] 扩展：登记 → 绑定 → 启动装载')
  const ext = await w.evaluate(async (p) => await window.ss.extensions.create({ name: p.name, path: p.path }), {
    name: 'E2E 标记扩展',
    path: EXT_DIR
  })
  check(typeof ext.id === 'string' && ext.id.startsWith('ext_'), '扩展登记成功', ext.id)

  const created = await w.evaluate(async (p) => {
    const rec = await window.ss.profiles.create({ name: 'E2E-扩展环境', platform: 'windows' })
    // startUrl 不在 CreateProfileInput 里（创建接口只收身份字段），必须走 update
    return await window.ss.profiles.update(rec.id, {
      startUrl: p.url,
      extensionIds: [p.extId]
    })
  }, { url: BASE + '/', extId: ext.id })
  check(
    Array.isArray(created.extensionIds) && created.extensionIds.includes(ext.id),
    '扩展 id 已写入环境'
  )

  await w.evaluate(async (id) => await window.ss.profiles.launch(id), created.id)
  await sleep(6000)

  const cookies = await w.evaluate(async (id) => await window.ss.data.cookies(id), created.id)
  const marked = Array.isArray(cookies) && cookies.some((c) => c.name === 'ss_ext_mark' && c.value === '1')
  check(marked, '内容脚本在该环境的 session 里执行（cookie 证据）', `cookies=${Array.isArray(cookies) ? cookies.length : 'n/a'}`)

  await w.evaluate(async (id) => await window.ss.profiles.stop(id), created.id)
  await sleep(1000)

  /* ───────────── 2. 预热 ───────────── */
  console.log('\n[2] Cookie 预热')
  const warmProfile = await w.evaluate(async (p) => await window.ss.profiles.create({ name: 'E2E-预热环境', platform: 'windows' }), {})
  const report = await w.evaluate(
    async (p) => await window.ss.warmup.run(p.id, [p.base + '/a', p.base + '/b']),
    { id: warmProfile.id, base: BASE }
  )
  check(report.total === 2, '预热报告总页数正确', `total=${report.total}`)
  check(report.okCount === 2, '两页都访问成功', `ok=${report.okCount}/${report.total}`)
  check(Array.isArray(report.steps) && report.steps.length === 2, '每页都有步骤记录')
  check(
    report.steps.every((s) => typeof s.dwellMs === 'number' && s.dwellMs >= 0),
    '步骤记录了实际停留时长'
  )

  /* ───────────── 3. 定时任务 ───────────── */
  console.log('\n[3] 定时任务')
  const sched = await w.evaluate(
    async (p) => await window.ss.schedules.create({ kind: 'launch', targetId: p.id, everyMinutes: 1, enabled: true }),
    warmProfile
  )
  check(sched.kind === 'launch' && sched.everyMinutes === 1, '定时任务创建成功', sched.id)

  const runRes = await w.evaluate(async (id) => await window.ss.schedules.runNow(id), sched.id)
  check(runRes.ok === true, 'runNow 执行成功', runRes.message)
  // 环境是否「在跑」在界面上由任务状态推导，不看 profile.status（启动本身不写它）。
  // 这里直接读回定时记录的 lastResult：它就是 runNow 落库的执行结论。
  const schedRows = await w.evaluate(async () => await window.ss.schedules.list(), {})
  const schedAfter = schedRows.find((r) => r.id === sched.id)
  check(
    Boolean(schedAfter && /已启动/.test(String(schedAfter.lastResult))),
    '定时执行结果已落库',
    schedAfter?.lastResult
  )
  await w.evaluate(async (id) => await window.ss.profiles.stop(id), warmProfile.id)
  await sleep(800)

  let missingProfileRejected = false
  try {
    await w.evaluate(
      async (targetId) =>
        await window.ss.schedules.create({ kind: 'script', targetId, everyMinutes: 5, enabled: true }),
      'scr_fake'
    )
  } catch (err) {
    missingProfileRejected = /运行环境/.test(String(err))
  }
  check(missingProfileRejected, '脚本定时缺少运行环境时被拒绝')

  await w.evaluate(async (id) => await window.ss.schedules.remove(id), sched.id)

  /* ───────────── 4. 回收站 ───────────── */
  console.log('\n[4] 环境回收站')
  const trashProfile = await w.evaluate(async () => await window.ss.profiles.create({ name: 'E2E-回收站', platform: 'windows' }), {})
  await w.evaluate(async (id) => await window.ss.profiles.remove(id), trashProfile.id)
  await sleep(500)

  const [live, trash] = await w.evaluate(async () => [await window.ss.profiles.list(), await window.ss.profiles.trash()], {})
  check(!live.some((p) => p.id === trashProfile.id), '删除后不在正常列表')
  check(trash.some((p) => p.id === trashProfile.id), '删除后出现在回收站')

  const restored = await w.evaluate(async (id) => await window.ss.profiles.restore(id), trashProfile.id)
  check(restored.deletedAt === null || restored.deletedAt === undefined, '恢复后 deletedAt 已清空')
  const live2 = await w.evaluate(async () => await window.ss.profiles.list(), {})
  check(live2.some((p) => p.id === trashProfile.id), '恢复后回到正常列表')

  await w.evaluate(async (id) => await window.ss.profiles.remove(id), trashProfile.id)
  const purged = await w.evaluate(async (id) => {
    await window.ss.profiles.purge(id)
    const rows = await window.ss.profiles.trash()
    return rows.some((p) => p.id === id)
  }, trashProfile.id)
  check(purged === false, '彻底删除后不再出现在回收站')
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
  console.log(`FAILED ${failures.length} 项：`)
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
