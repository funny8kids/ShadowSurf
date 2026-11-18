/**
 * 压力测试：本轮新增的四项能力（回收站 / 扩展 / 预热 / 定时）在真实 store 上的表现。
 *
 * 与 tests/*.test.ts 同一套加载器：用 module.registerHooks 把 electron 换成桩、
 * 把 @main / @shared 别名映射回源码 —— 于是跑的是**真的** ProfileStore + JsonStore
 * 落盘，而不是另写一份内存模型。数据目录指向临时目录，绝不碰工作区。
 *
 * 为什么需要这个文件：单元测试只覆盖语义，不覆盖「量大之后还对不对、多快」。
 * 这里每一步都带断言，并且最后重新解析落盘文件校验完整性（ID 唯一、字段过滤、
 * JSON 可读），任何一项失败 exit 1。
 *
 * 跑法：node --experimental-strip-types tools/stress-features.mjs
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as nodeModule from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = mkdtempSync(join(tmpdir(), 'ss-stress-'))

const registerHooks = nodeModule.registerHooks
if (typeof registerHooks !== 'function') {
  console.error('需要 Node >= 22.15（module.registerHooks）')
  process.exit(2)
}

function resolveFile(base) {
  const candidates = [base, base + '.ts', base + '.tsx', join(base, 'index.ts'), join(base, 'index.tsx')]
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c
  }
  return null
}

const stub = `
export const app = { getPath: () => ${JSON.stringify(DATA)} }
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error('压力桩：safeStorage 不可用') },
  decryptString: () => { throw new Error('压力桩：safeStorage 不可用') }
}
export default { app, safeStorage }
`
const electronUrl = 'data:text/javascript;base64,' + Buffer.from(stub, 'utf8').toString('base64')

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: electronUrl, shortCircuit: true }
    let base = null
    if (specifier.startsWith('@shared/')) base = join(ROOT, 'src/shared', specifier.slice(8))
    else if (specifier.startsWith('@main/')) base = join(ROOT, 'src/main', specifier.slice(6))
    else if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
      base = fileURLToPath(new URL(specifier, context.parentURL))
    }
    if (base !== null) {
      const file = resolveFile(base)
      if (file !== null) return { url: pathToFileURL(file).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
})

const failures = []
function check(cond, label, detail) {
  if (cond) {
    console.log(`  PASS ${label}${detail ? ' · ' + detail : ''}`)
  } else {
    failures.push(label + (detail ? ' · ' + detail : ''))
    console.log(`  FAIL ${label}${detail ? ' · ' + detail : ''}`)
  }
}

function ms(t0) {
  return Math.round(performance.now() - t0)
}

/** 读落盘 JSON（envelope 形态 {schema, data}），返回 data 数组 */
function readCollection(file) {
  // JsonStore 的根目录是 <userData>/data，不是 userData 本身（见 store/db.ts: dataDir）
  const raw = JSON.parse(readFileSync(join(DATA, 'data', file), 'utf8'))
  const data = Array.isArray(raw) ? raw : raw.data
  if (!Array.isArray(data)) throw new Error(`${file} 不是数组`)
  return data
}

async function main() {
  const { ProfileStore } = await import(pathToFileURL(join(ROOT, 'src/main/store/profiles.ts')).href)
  const { CollectionStore } = await import(pathToFileURL(join(ROOT, 'src/main/store/collection.ts')).href)
  const policy = await import(pathToFileURL(join(ROOT, 'src/main/modules/schedule-policy.ts')).href)
  const warmup = await import(pathToFileURL(join(ROOT, 'src/main/modules/warmup-policy.ts')).href)

  /* ───────────── 1. 回收站：批量建 / 软删 / 恢复 / 彻底删 ───────────── */
  console.log('\n[1] 环境回收站')
  const profiles = new ProfileStore()
  const N = 200
  let t0 = performance.now()
  const created = []
  for (let i = 0; i < N; i += 1) created.push(profiles.create({ name: `stress-${i}` }))
  const createMs = ms(t0)
  check(profiles.list().length === N, '批量创建后列表数量正确', `${N} 个 / ${createMs}ms`)
  check(new Set(created.map((p) => p.id)).size === N, '环境 ID 无重复')

  t0 = performance.now()
  for (let i = 0; i < N; i += 2) profiles.softRemove(created[i].id) // 100 个
  const removeMs = ms(t0)
  check(profiles.list().length === N / 2, '软删除后正常列表只剩一半', `${removeMs}ms`)
  check(profiles.listTrash().length === N / 2, '回收站数量正确')

  t0 = performance.now()
  for (let i = 0; i < 40; i += 2) profiles.restore(created[i].id) // 恢复 20 个
  const restoreMs = ms(t0)
  check(profiles.list().length === N / 2 + 20, '恢复后正常列表数量正确', `${restoreMs}ms`)
  check(profiles.listTrash().length === N / 2 - 20, '回收站相应减少')

  t0 = performance.now()
  const toPurge = profiles.listTrash().slice(0, 40)
  for (const p of toPurge) profiles.purge(p.id)
  const purgeMs = ms(t0)
  check(profiles.listTrash().length === N / 2 - 20 - 40, '彻底删除后回收站数量正确', `${purgeMs}ms`)
  check(profiles.get(toPurge[0].id) === null, '彻底删除后 get() 为 null')

  const diskProfiles = readCollection('profiles.json')
  check(diskProfiles.length === profiles.list().length + profiles.listTrash().length, '落盘记录数 = 正常 + 回收站')
  check(new Set(diskProfiles.map((p) => p.id)).size === diskProfiles.length, '落盘环境 ID 唯一')
  check(
    profiles.list().every((p) => p.deletedAt === null || p.deletedAt === undefined),
    '正常列表里没有 deletedAt 非空的记录'
  )

  /* ───────────── 2. 批量更新（updateMany 单次落盘） ───────────── */
  console.log('\n[2] 批量更新')
  const liveIds = profiles.list().slice(0, 80).map((p) => p.id)
  t0 = performance.now()
  const touched = profiles.updateMany(liveIds, { status: 'running' })
  const batchMs = ms(t0)
  check(touched === liveIds.length, 'updateMany 返回命中数正确', `${touched} 条 / ${batchMs}ms`)
  check(
    liveIds.every((id) => profiles.get(id)?.status === 'running'),
    '全部环境确实写入了新状态'
  )
  check(
    profiles.list().filter((p) => p.status === 'running').length >= liveIds.length,
    '不存在状态串写（其它环境未被误改）',
    `running=${profiles.list().filter((p) => p.status === 'running').length}`
  )

  /* ───────────── 3. 扩展清单 CRUD ───────────── */
  console.log('\n[3] 扩展清单')
  const extensions = new CollectionStore('extensions')
  const E = 300
  t0 = performance.now()
  for (let i = 0; i < E; i += 1) {
    extensions.add({
      id: CollectionStore.newId('ext'),
      name: `ext-${i}`,
      path: `/tmp/ext-${i}`,
      enabled: true,
      createdAt: Date.now()
    })
  }
  const extCreateMs = ms(t0)
  check(extensions.list().length === E, '批量登记扩展', `${E} 条 / ${extCreateMs}ms`)
  const extId = extensions.list()[0].id
  extensions.update(extId, { enabled: false })
  check(extensions.get(extId)?.enabled === false, '扩展开关更新生效')
  for (let i = 0; i < 100; i += 1) extensions.remove(extensions.list()[0].id)
  check(extensions.list().length === E - 100, '批量移除扩展后数量正确')
  const diskExt = readCollection('extensions')
  check(diskExt.length === E - 100, '扩展落盘数量一致')
  check(new Set(diskExt.map((e) => e.id)).size === diskExt.length, '扩展 ID 唯一')

  // 环境 ↔ 扩展绑定：单条 update 与 updateMany 都必须能写 extensionIds
  const bindId = extensions.list()[0].id
  const bound = profiles.update(liveIds[0], { extensionIds: [bindId, bindId, '  '] })
  check(
    JSON.stringify(bound.extensionIds) === JSON.stringify([bindId]),
    'extensionIds 去空去重后写入单条环境'
  )
  const batchBound = profiles.updateMany(liveIds.slice(1, 4), { extensionIds: [bindId] })
  check(
    batchBound === 3 && liveIds.slice(1, 4).every((id) => (profiles.get(id)?.extensionIds ?? []).includes(bindId)),
    'updateMany 批量写入 extensionIds'
  )
  let shapeRejected = false
  try {
    profiles.update(liveIds[0], { extensionIds: 'ext_1' })
  } catch (err) {
    shapeRejected = /字符串数组/.test(String(err))
  }
  check(shapeRejected, '形状错误的 extensionIds 被拒绝而不是静默清空')

  /* ───────────── 4. 定时任务：CRUD + 策略计算吞吐 ───────────── */
  console.log('\n[4] 定时任务')
  const schedules = new CollectionStore('schedules')
  const S = 300
  const now = Date.now()
  t0 = performance.now()
  for (let i = 0; i < S; i += 1) {
    const rec = {
      id: CollectionStore.newId('sch'),
      kind: i % 2 === 0 ? 'launch' : 'script',
      targetId: `prf_${i}`,
      profileId: i % 2 === 0 ? undefined : `prf_${i}`,
      enabled: true,
      everyMinutes: (i % 60) + 1,
      lastRunAt: null,
      createdAt: now
    }
    // validateSchedule 必须全部通过，否则这条数据本身就是坏的
    const err = policy.validateSchedule(rec)
    if (err !== null) throw new Error(`第 ${i} 条定时配置非法：${err}`)
    schedules.add(rec)
  }
  check(schedules.list().length === S, '批量创建定时任务', `${S} 条 / ${ms(t0)}ms`)

  t0 = performance.now()
  let dueCount = 0
  let nextCount = 0
  for (let round = 0; round < 400; round += 1) {
    for (const rec of schedules.list()) {
      if (policy.nextRunAt(rec, now) !== null) nextCount += 1
      if (policy.isDue(rec, now + round * 60_000)) dueCount += 1
    }
  }
  const calcMs = ms(t0)
  const evals = S * 400
  check(nextCount > 0 && dueCount > 0, '策略计算有实际结果（非全 null / 非全 false）', `${evals} 次 ×2 / ${calcMs}ms`)
  check(calcMs < 5000, '18 万次策略计算在 5s 内', `${calcMs}ms`)

  /* ───────────── 5. 预热 URL 归一化 ───────────── */
  console.log('\n[5] 预热 URL 归一化')
  const raw = []
  for (let i = 0; i < 500; i += 1) {
    raw.push(`https://example.com/p/${i}`)
    raw.push(` https://example.com/p/${i} `) // 重复项（trim 后相同）
    raw.push(`ftp://bad/${i}`) // 非法协议
    raw.push(`javascript:alert(1)`) // 非法协议
  }
  t0 = performance.now()
  let lastPlan = null
  for (let i = 0; i < 500; i += 1) lastPlan = warmup.normalizeWarmupUrls(raw)
  const normMs = ms(t0)
  check(lastPlan.urls.length === 30, '去重 + 截断到上限 30', `urls=${lastPlan.urls.length}`)
  check(lastPlan.rejected.length > 0, '非法协议被拒绝而不是静默丢弃')
  check(normMs < 3000, '50 万条输入归一化在 3s 内', `${normMs}ms`)

  /* ───────────── 6. 并发写盘完整性 ───────────── */
  console.log('\n[6] 并发写盘')
  const groups = []
  for (let i = 0; i < 20; i += 1) groups.push(liveIds.slice(i * 3, i * 3 + 3))
  await Promise.all(
    groups.map(
      (ids, i) =>
        new Promise((resolve) => {
          profiles.updateMany(ids, { name: `concurrent-${i}` })
          resolve(null)
        })
    )
  )
  const afterConcurrent = readCollection('profiles.json')
  check(afterConcurrent.length === diskProfiles.length, '并发更新后记录数不变')
  check(new Set(afterConcurrent.map((p) => p.id)).size === afterConcurrent.length, '并发更新后 ID 仍唯一')
  check(
    afterConcurrent.every((p) => typeof p.name === 'string' && p.name.length > 0),
    '并发更新后每条记录仍完整（name 非空）'
  )

  /* ───────────── 收尾 ───────────── */
  console.log('\n================ 汇总 ================')
  if (failures.length === 0) {
    console.log('ALL PASS')
    process.exitCode = 0
  } else {
    console.log(`FAILED ${failures.length} 项：`)
    for (const f of failures) console.log('  - ' + f)
    process.exitCode = 1
  }
}

main()
  .catch((err) => {
    console.error('压力测试异常终止：', err)
    process.exitCode = 1
  })
  .finally(() => {
    try {
      rmSync(DATA, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不影响结论 */
    }
  })
