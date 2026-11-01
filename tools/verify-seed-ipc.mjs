/**
 * seed 不跨 IPC 的**运行时**验收。
 *
 * 结构断言只能证明「源码里没有 StoredProfile」「Profile 没有 seed 字段」，
 * 证明不了「实际发过去的载荷里没有」。这一条必须跑真的应用：
 * 拿 `profiles.list()` 的返回值做 `JSON.stringify`，然后找 32 位 hex。
 *
 * 顺带验 `profiles.preview`：
 *   `preview(id, { platform: 当前平台 })` 必须与**落盘的那份指纹逐字段相等**。
 *   这条比「preview 不报错」强得多 —— 它同时钉住了
 *   「预览用的函数」与「保存用的函数」是同一个（都走 buildFingerprint）。
 *   此前渲染层用 `resolveFingerprint`，对 macos/linux 不叠 seed 扰动，
 *   于是预览到的分辨率和保存后的不是同一个值。
 *
 * 跑法：npm run verify:seed-ipc（先 npm run build）
 * 退出码：0 成立 / 1 不成立 / 2 脚本自身崩了
 */

import { _electron as electron } from 'playwright-core'
import { resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const ROOT = resolve(import.meta.dirname, '..')
const SEED_RE = /\b[0-9a-f]{32}\b/

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: resolve(ROOT, 'node_modules/electron/dist/electron.exe'),
  args: ['.', '--user-data-dir=' + resolve(ROOT, 'artifacts/seed-ipc-ud')],
  cwd: ROOT,
  env,
  timeout: 40000
})

const out = { steps: [], failures: [] }
const step = (id, label, data) => out.steps.push({ id, label, ...data })
const fail = (msg) => out.failures.push(msg)

try {
  const main = await app.firstWindow({ timeout: 25000 })
  await main.waitForTimeout(1500)

  // 空 store 就自己建一个 —— 探针用独立 user-data-dir，不会污染真实数据
  let list = await main.evaluate(async () => await window.ss.profiles.list())
  if (!Array.isArray(list) || list.length === 0) {
    await main.evaluate(
      async () =>
        await window.ss.profiles.create({ name: '验收-seed-ipc', platform: 'windows', fingerprint: null })
    )
    list = await main.evaluate(async () => await window.ss.profiles.list())
  }
  if (!Array.isArray(list) || list.length === 0) throw new Error('建不出环境，无法继续')

  const target = list[0]
  step('profile', '选中的环境', { id: target.id, name: target.name, platform: target.platform })

  /* ── 1. 列表载荷里不得出现 32 位 hex ──
   * 只看「有没有 seed 字段」是不够的：字段名可以换，值还是那个值。
   * 所以直接找形状 —— 32 位小写 hex 就是种子本身的形态。 */
  const payload = JSON.stringify(list)
  const hits = payload.match(new RegExp(SEED_RE.source, 'g')) ?? []
  step('list', 'profiles.list() 载荷', {
    bytes: payload.length,
    seedShaped: hits.length,
    keys: Object.keys(target).sort()
  })
  if (hits.length > 0) fail(`profiles.list() 载荷里有 ${String(hits.length)} 个 32 位 hex：${hits.join(', ')}`)
  if ('seed' in target) fail('profiles.list() 的返回对象仍然带 seed 字段')

  // seedHint 必须存在且是 8 位 hex —— 否则界面失去「同种子」的比对能力
  if (typeof target.seedHint !== 'string' || !/^[0-9a-f]{8}$/.test(target.seedHint)) {
    fail(`seedHint 形态不对：${String(target.seedHint)}`)
  }

  /* ── 2. preview 必须与落盘指纹逐字段相等 ── */
  const preview = await main.evaluate(
    async ([id, platform]) => await window.ss.profiles.preview(id, { platform }),
    [target.id, target.platform]
  )
  const same = JSON.stringify(preview) === JSON.stringify(target.fingerprint)
  step('preview', 'preview(当前平台) vs 落盘指纹', {
    same,
    previewScreen: preview && preview.screen,
    storedScreen: target.fingerprint && target.fingerprint.screen,
    previewCores: preview && preview.hardware && preview.hardware.cpuCores,
    storedCores: target.fingerprint && target.fingerprint.hardware && target.fingerprint.hardware.cpuCores
  })
  if (!same) fail('preview(当前平台) 与落盘指纹不一致 —— 预览和保存用的不是同一个函数')

  /* ── 3. 换平台预览必须真的变（否则第 2 条可能只是「原样返回入参」） ── */
  const other = target.platform === 'macos' ? 'linux' : 'macos'
  const cross = await main.evaluate(
    async ([id, platform]) => await window.ss.profiles.preview(id, { platform }),
    [target.id, other]
  )
  const changed = JSON.stringify(cross) !== JSON.stringify(target.fingerprint)
  step('preview-cross', `preview(${other}) 必须与当前平台不同`, {
    changed,
    screen: cross && cross.screen,
    os: cross && cross.os
  })
  if (!changed) fail(`preview(${other}) 与当前平台指纹相同 —— 平台参数没被用上`)

  /* ── 4. preview 不得改动任何东西（它是只读的） ── */
  const after = await main.evaluate(async () => await window.ss.profiles.list())
  const untouched = JSON.stringify(after.find((p) => p.id === target.id)) === JSON.stringify(target)
  step('readonly', 'preview 之后环境未被改动', { untouched })
  if (!untouched) fail('preview 修改了环境 —— 它必须是只读的')
} catch (err) {
  out.failures.push('脚本自身异常：' + String((err && err.message) || err))
} finally {
  try {
    await app.close()
  } catch (e) {}
}

mkdirSync(resolve(ROOT, 'artifacts'), { recursive: true })
writeFileSync(resolve(ROOT, 'artifacts/seed-ipc.json'), JSON.stringify(out, null, 2), 'utf8')

console.log('\n===== seed 不跨 IPC —— 运行时验收 =====\n')
for (const s of out.steps) {
  const { id, label, ...rest } = s
  console.log('[' + id + '] ' + label)
  for (const [k, v] of Object.entries(rest)) console.log('      ' + k + ' = ' + JSON.stringify(v))
  console.log('')
}

if (out.failures.length > 0) {
  console.log('不成立：')
  for (const f of out.failures) console.log('  ✗ ' + f)
  console.log('\n完整读数：artifacts/seed-ipc.json')
  process.exit(1)
}
console.log('成立：profiles.list() 载荷里没有种子，preview 与落盘指纹逐字段相等，且只读')
console.log('完整读数：artifacts/seed-ipc.json')
