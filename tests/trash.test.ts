/**
 * 环境回收站（软删除 / 恢复 / 彻底删除）的回归测试。
 *
 * ── 为什么 store 的行为测试需要一层桩 ──
 * `ProfileStore` 的依赖链里 `db.ts` / `seed-seal.ts` / `fingerprint.ts` 都静态
 * import 了 `electron`，纯 Node 里连模块都求值不了。这里用 Node 的
 * `module.registerHooks` 在**当前线程**把 `electron` 换成一个最小桩，
 * 并把 `@main/*` / `@shared/*` 别名映射回源码 —— 于是被测的是真实的
 * `profiles.ts` + 真实的 JsonStore 落盘，而不是另写一份内存模型。
 *
 * 桩里的 safeStorage 刻意报告「不可用」：这样 store 走 schema 1（明文 seed），
 * 不会触碰任何加密 API。主密钥仍然会被真实地写进临时目录，由 `after` 清理。
 *
 * 这个能力需要 Node >= 22.15。更老的 Node 上行为测试会 skip（原因写在 skip
 * 描述里），而不是让整个测试文件加载失败；源码约束与文案完整性检查仍然执行。
 *
 * 跑法：node --experimental-strip-types --test tests/trash.test.ts
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as nodeModule from 'node:module'

import { en, zh } from '../src/renderer/lib/i18n/catalog/profiles.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const USER_DATA = mkdtempSync(join(tmpdir(), 'ss-trash-'))

const registerHooks = (
  nodeModule as unknown as { registerHooks?: (hooks: unknown) => void }
).registerHooks

/** 回收站相关的全部 i18n 键（任务清单里的那十个） */
const TRASH_KEYS = [
  'profiles.trash.toggle',
  'profiles.trash.title',
  'profiles.trash.empty',
  'profiles.trash.deletedAt',
  'profiles.trash.restore',
  'profiles.trash.purge',
  'profiles.trash.purgeConfirmTitle',
  'profiles.trash.purgeConfirmNote',
  'profiles.trash.restored',
  'profiles.trash.purged'
]

/**
 * 候选路径：原样 / +.ts / +.tsx / 目录下的 index.*
 *
 * 源码里全是 bundler 风格的**无扩展名**相对导入（`./db`、`@main/core/session`），
 * Node 的 ESM 解析不接受这种写法。测试的加载器要补上扩展名，否则连
 * `profiles.ts` 的第一行依赖都 import 不进来。
 */
function resolveFile(base: string): string | null {
  const candidates = [
    base,
    base + '.ts',
    base + '.tsx',
    join(base, 'index.ts'),
    join(base, 'index.tsx')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

const hooksReady = typeof registerHooks === 'function'

if (hooksReady) {
  // 注意：getPath 返回临时目录，JsonStore 会真的把 profiles.json 写进去。
  // 不用 process.cwd() —— 测试绝不能碰工作区里的真实数据目录。
  const stub = `
export const app = { getPath: () => ${JSON.stringify(USER_DATA)} }
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error('测试桩：safeStorage 不可用') },
  decryptString: () => { throw new Error('测试桩：safeStorage 不可用') }
}
export default { app, safeStorage }
`
  const electronUrl =
    'data:text/javascript;base64,' + Buffer.from(stub, 'utf8').toString('base64')

  registerHooks({
    resolve(specifier: string, context: { parentURL?: string }, nextResolve: Function) {
      if (specifier === 'electron') {
        return { url: electronUrl, shortCircuit: true }
      }

      let base: string | null = null
      if (specifier.startsWith('@shared/')) {
        base = join(ROOT, 'src/shared', specifier.slice('@shared/'.length))
      } else if (specifier.startsWith('@main/')) {
        base = join(ROOT, 'src/main', specifier.slice('@main/'.length))
      } else if (
        (specifier.startsWith('./') || specifier.startsWith('../')) &&
        context.parentURL?.startsWith('file:')
      ) {
        base = fileURLToPath(new URL(specifier, context.parentURL))
      }

      if (base !== null) {
        const file = resolveFile(base)
        if (file !== null) return { url: pathToFileURL(file).href, shortCircuit: true }
      }

      return nextResolve(specifier, context)
    }
  })
}

after(() => {
  try {
    rmSync(USER_DATA, { recursive: true, force: true })
  } catch {
    /* 临时目录清不掉不影响断言结果 */
  }
})

/* ────────────────────────── 1. 真实 store 行为 ────────────────────────── */

test(
  'ProfileStore：list 排除已删除、listTrash 按删除时间倒序、恢复/彻底删除语义正确',
  { skip: hooksReady ? false : '需要 Node >= 22.15 的 module.registerHooks' },
  async () => {
    const mod = await import(
      pathToFileURL(join(ROOT, 'src/main/store/profiles.ts')).href
    )
    const store = new mod.ProfileStore()

    const a = store.create({ name: '恢复用的环境' })
    const b = store.create({ name: '彻底删除的环境' })
    assert.equal(store.list().length, 2, '新建的两个环境都应在正常列表里')

    /* 固定时钟，让「按删除时间倒序」可判定。真实实现用的是 Date.now()。 */
    const realNow = Date.now
    const first = 1_700_000_000_000
    const second = first + 60_000
    try {
      Date.now = () => first
      const removedA = store.softRemove(a.id)
      assert.equal(removedA.deletedAt, first, 'softRemove 必须写入删除时间')
      assert.equal(removedA.name, a.name, 'softRemove 不能改动其余字段')

      Date.now = () => second
      store.softRemove(b.id)
    } finally {
      Date.now = realNow
    }

    /* 软删除不是删除记录：正常列表看不到，但 get / getStored 仍读得到。 */
    assert.deepEqual(
      store.list().map((p: { id: string }) => p.id),
      [],
      'list() 必须排除 deletedAt 非空的环境'
    )
    assert.equal(store.get(a.id)?.deletedAt, first, 'get() 仍应返回回收站里的环境')
    assert.ok(store.getStored(a.id) !== null, 'getStored() 仍应返回回收站里的环境')

    const trash = store.listTrash()
    assert.deepEqual(
      trash.map((p: { id: string }) => p.id),
      [b.id, a.id],
      'listTrash() 必须按 deletedAt 降序'
    )
    assert.ok(
      trash.every((p: { deletedAt?: number | null }) => typeof p.deletedAt === 'number'),
      '回收站里的每条记录都必须带删除时间'
    )
    assert.equal(
      Object.prototype.hasOwnProperty.call(trash[0], 'seed'),
      false,
      'listTrash() 不能把 seed 带出主进程'
    )
    assert.equal(typeof trash[0].seedHint, 'string', 'public 形态仍应带 seedHint')

    /* update / updateMany 不能把 deletedAt 当可写字段：未知字段必须抛错。 */
    assert.throws(
      () => store.update(a.id, { deletedAt: 123 } as never),
      /不支持的字段/,
      'update 不得接受 deletedAt（否则可绕过回收站）'
    )
    assert.throws(
      () => store.updateMany([a.id, b.id], { deletedAt: null } as never),
      /不支持的字段/,
      'updateMany 不得接受 deletedAt'
    )
    assert.equal(store.get(a.id)?.deletedAt, first, '被拒绝的 update 不能改动删除状态')

    /* 恢复：只清 deletedAt，环境回到正常列表。 */
    const restored = store.restore(a.id)
    assert.equal(restored.deletedAt, null, 'restore 必须把 deletedAt 清成 null')
    assert.deepEqual(
      store.list().map((p: { id: string }) => p.id),
      [a.id],
      '恢复后的环境必须回到正常列表'
    )
    assert.deepEqual(
      store.listTrash().map((p: { id: string }) => p.id),
      [b.id],
      '恢复不能把别的回收站记录一起放出来'
    )

    /* 彻底删除：记录真的从数组里消失。 */
    store.purge(b.id)
    assert.equal(store.get(b.id), null, 'purge 之后 get 必须查不到')
    assert.equal(store.getStored(b.id), null, 'purge 之后 getStored 必须查不到')
    assert.deepEqual(store.listTrash(), [], 'purge 之后回收站里不应再有它')

    /* 不存在的 id：三个写入口都要给明确错误，而不是静默成功。 */
    assert.throws(() => store.softRemove('prf_missing'), /环境不存在/)
    assert.throws(() => store.restore('prf_missing'), /环境不存在/)
    assert.throws(() => store.purge('prf_missing'), /环境不存在/)
  }
)

/* ────────────────────────── 2. 源码约束（不依赖 Electron） ────────────────────────── */

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/** 去掉注释再匹配：解释「为什么 deletedAt 不可写」的注释不该被判成违规 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function methodBody(source: string, signature: string): string {
  const at = source.indexOf(signature)
  assert.ok(at >= 0, `找不到方法签名：${signature}`)
  const end = source.indexOf('\n  }', at)
  assert.ok(end > at, `方法 ${signature} 的右花括号定位失败`)
  return source.slice(at, end)
}

test('ProfileStore：WRITABLE 不含 deletedAt，list/listTrash/softRemove/restore 结构符合约定', () => {
  const src = stripComments(read('src/main/store/profiles.ts'))

  const writable = /const WRITABLE[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src)
  assert.ok(writable, '找不到 WRITABLE 白名单')
  assert.doesNotMatch(
    writable[1],
    /['"]deletedAt['"]/,
    'deletedAt 不得进入 WRITABLE：那会让 update() 绕过回收站'
  )

  assert.match(methodBody(src, 'list(): Profile[] {'), /!isTrashed/)
  assert.match(methodBody(src, 'listTrash(): Profile[] {'), /isTrashed/)
  assert.match(
    methodBody(src, 'listTrash(): Profile[] {'),
    /Number\(b\.deletedAt\)\s*-\s*Number\(a\.deletedAt\)/,
    'listTrash 必须按 deletedAt 降序'
  )

  const soft = methodBody(src, 'softRemove(id: string): Profile {')
  assert.match(soft, /deletedAt:\s*now/, 'softRemove 必须写入 deletedAt')
  assert.doesNotMatch(soft, /splice/, 'softRemove 不得移除记录')

  assert.match(
    methodBody(src, 'restore(id: string): Profile {'),
    /deletedAt:\s*null/,
    'restore 必须清空 deletedAt'
  )

  assert.match(
    methodBody(src, 'purge(id: string): void {'),
    /this\.remove\(id\)/,
    'purge 应复用 remove 的记录移除逻辑'
  )
  assert.doesNotMatch(
    src,
    /clearProfileData/,
    'ProfileStore 不负责清分区（由 modules/trash.ts 调用 clearProfileData）'
  )
})

test('trash 模块：注册三个通道，purge 先清分区再删记录，失败不阻断', () => {
  const src = stripComments(read('src/main/modules/trash.ts'))

  assert.match(src, /CH\.profiles\.trash/, '必须注册 trash 通道')
  assert.match(src, /CH\.profiles\.restore/, '必须注册 restore 通道')
  assert.match(src, /CH\.profiles\.purge/, '必须注册 purge 通道')

  const purgeAt = src.indexOf('CH.profiles.purge')
  assert.ok(purgeAt >= 0)
  const clearAt = src.indexOf('clearProfileData(id)', purgeAt)
  const removeAt = src.indexOf('profiles.purge(id)', purgeAt)
  assert.ok(clearAt > purgeAt, 'purge handler 必须先清分区')
  assert.ok(removeAt > clearAt, '清分区必须在删除记录之前')

  assert.match(src, /console\.warn/, '分区清理失败必须留告警，不能静默')
  assert.match(src, /'环境·恢复'/, '恢复必须写审计')
  assert.match(src, /'环境·彻底删除'/, '彻底删除必须写审计')
  assert.match(src, /CH\.push\.profileState/, '恢复/彻底删除后必须广播环境状态')
})

test('ProfileGrid：回收站数据来自 IPC，恢复/彻底删除后刷新两侧列表', () => {
  const src = stripComments(read('src/renderer/components/ProfileGrid.tsx'))

  assert.match(src, /bridge\(\)\.profiles\.trash\(\)/, '回收站列表必须走 profiles.trash()')
  assert.match(src, /bridge\(\)\.profiles\.restore\(/, '恢复必须走 profiles.restore()')
  assert.match(src, /bridge\(\)\.profiles\.purge\(/, '彻底删除必须走 profiles.purge()')
  assert.match(src, /purgeConfirmNote/, '彻底删除必须有二次确认说明')
  assert.match(src, /onRetry\(\)/, '恢复/彻底删除后必须触发正常列表刷新')
})

/* ────────────────────────── 3. 文案完整性 ────────────────────────── */

test('回收站文案：zh/en 键一致、非空，确认文案说明不可恢复与数据面', () => {
  for (const key of TRASH_KEYS) {
    assert.equal(typeof zh[key], 'string', `中文缺键：${key}`)
    assert.equal(typeof en[key], 'string', `英文缺键：${key}`)
    assert.ok(zh[key].length > 0, `中文文案为空：${key}`)
    assert.ok(en[key].length > 0, `英文文案为空：${key}`)
  }

  // 反向检查：中文里新增的回收站键必须在英文里也有（防止只补一边）
  for (const key of Object.keys(zh)) {
    if (!key.startsWith('profiles.trash.')) continue
    assert.equal(typeof en[key], 'string', `英文缺回收站键：${key}`)
  }

  const confirmed = zh['profiles.trash.purgeConfirmNote']
  assert.match(confirmed, /不可恢复/, '中文确认文案必须点明不可恢复')
  assert.match(confirmed, /Cookie/i)
  assert.match(confirmed, /localStorage/i)
  assert.match(confirmed, /IndexedDB/i)

  const confirmedEn = en['profiles.trash.purgeConfirmNote']
  assert.match(confirmedEn, /cannot be undone/i)
  assert.match(confirmedEn, /cookie/i)
  assert.match(confirmedEn, /localStorage/i)
  assert.match(confirmedEn, /IndexedDB/i)
})
