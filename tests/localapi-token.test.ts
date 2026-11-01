/**
 * 「盘上的旧明文凭据 → 就地密封」的回归测试。
 *
 * 被测的是 `store/secret-at-rest.ts`，不是 `modules/localapi.ts`。
 * 原因：后者静态 import 了 electron，`node --test` 里连模块都求值不了；
 * 把逻辑留在那边就只能「读代码证明它对」，那不是验证。密封函数由调用方注入，
 * 所以这里不需要任何 electron 桩 —— 判据和动作都在零依赖模块里。
 *
 * ── 四条断言的重心 ──
 *
 * 这个函数最危险的失败模式**不是「没修好」，是「动手了但动错了」**：
 * 凭据被换掉 = 所有在用客户端集体 401，用户完全不知道发生了什么。
 * 所以下面四条里有两条（第 3、4 条）断言的是「**文件字节完全不变**」——
 * 它们才是主体，不是凑数。
 *
 *   1. 明文 → `enc:`，且解回来与原文逐字符相同（证明「只换形态，不改值」）
 *   2. 文件不存在 → **不创建**任何东西（不为没用过这项功能的人凭空造凭据）
 *   3. 形状不合法 → 字节不变（不在猜测路径上改坏文件）
 *   4. 密封不可用 → 字节不变且不抛（保持明文是正确降级，由门禁如实报红）
 *
 * 跑法：node --experimental-strip-types --test tests/localapi-token.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  migrateSecretAtRest,
  writeFileAtomic,
  type SecretAtRestSpec
} from '../src/main/store/secret-at-rest.ts'

/* ────────────────────────────── 夹具 ────────────────────────────── */

/** 与 `localapi.ts` 的 `TOKEN_PATTERN` 一致：32 字节随机 → 64 位小写 hex */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/
const PLAIN = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef'
const SEALED_PREFIX = 'enc:'

/**
 * 假密封：可逆、确定性、不依赖 electron。
 *
 * 刻意**不是**真加密 —— 这条用例测的是「形态与文件字节」，不是密码学强度
 * （强度由 `seed-seal.ts` / DPAPI 与 `tools/verify-seed-at-rest.mjs` 负责）。
 * 可逆的假密封正好够用：如果实现把凭据换掉了，第 1 条断言会红。
 */
const fakeSeal = (plain: string): string =>
  SEALED_PREFIX + Buffer.from('k:' + plain, 'utf8').toString('base64')
const fakeOpen = (blob: string): string => {
  if (!blob.startsWith(SEALED_PREFIX)) throw new Error('不是密封形态')
  const raw = Buffer.from(blob.slice(SEALED_PREFIX.length), 'base64').toString('utf8')
  if (!raw.startsWith('k:')) throw new Error('密文格式不对')
  return raw.slice(2)
}

interface Box {
  dir: string
  file: string
  read: () => string
  names: () => string[]
  cleanup: () => void
}

function sandbox(): Box {
  const dir = mkdtempSync(join(tmpdir(), 'ss-token-'))
  const file = join(dir, 'local-api-token.json')
  return {
    dir,
    file,
    read: () => readFileSync(file, 'utf8'),
    names: () => readdirSync(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

/** 与 `localapi.ts` 里那份 spec 同形，只有 `seal` 可替换 */
function spec(file: string, seal: (plain: string, where: string) => string = fakeSeal): SecretAtRestSpec {
  return {
    file,
    label: '本地 API 令牌',
    pick: (raw) =>
      raw !== null && typeof raw === 'object'
        ? ((raw as Record<string, unknown>).token as string | undefined)
        : undefined,
    isSealed: (v) => v.startsWith(SEALED_PREFIX),
    isWellFormed: (v) => TOKEN_PATTERN.test(v),
    seal,
    render: (sealed, previous) => JSON.stringify({ ...previous, token: sealed }, null, 2)
  }
}

/* ────────────────── 1. 明文 → enc:，且值不变 ────────────────── */

test('明文令牌就地密封：落盘是 enc: 前缀，解回来与原文逐字符相同', () => {
  const box = sandbox()
  try {
    const before = JSON.stringify({ token: PLAIN, createdAt: 1700000000000 }, null, 2)
    writeFileSync(box.file, before, 'utf8')

    const r = migrateSecretAtRest(spec(box.file))
    assert.equal(r.outcome, 'resealed', '没有密封：' + String(r.reason))

    const after = JSON.parse(box.read()) as { token: string; createdAt: number }
    assert.ok(after.token.startsWith(SEALED_PREFIX), '落盘形态不是 enc: 前缀')

    // 这一条是整套的核心：密封不能顺手把凭据换掉。
    // 换掉 = 所有在用客户端集体 401，而用户完全不知道发生了什么。
    assert.equal(fakeOpen(after.token), PLAIN, '密封后解回来的值与原值不同 —— 凭据被改掉了')

    // 迁移只该换凭据的形态，不该抹掉旁支字段
    assert.equal(after.createdAt, 1700000000000, 'createdAt 被迁移抹掉了')

    // 原子写的收尾：不许留 .tmp
    assert.deepEqual(
      box.names().filter((n) => n.endsWith('.tmp')),
      [],
      '原子写留下了 .tmp 残留'
    )
  } finally {
    box.cleanup()
  }
})

test('已经是密封形态：不再封一遍（双重密封会把凭据变成解不开的东西）', () => {
  const box = sandbox()
  try {
    const sealed = fakeSeal(PLAIN)
    const before = JSON.stringify({ token: sealed, createdAt: 1 }, null, 2)
    writeFileSync(box.file, before, 'utf8')

    const r = migrateSecretAtRest(spec(box.file))
    assert.equal(r.outcome, 'already-sealed')
    assert.equal(box.read(), before, '文件被改动了 —— 重复密封会让 openText 解不出来')
  } finally {
    box.cleanup()
  }
})

/* ────────────────── 2. 文件不存在 → 不创建 ────────────────── */

test('文件不存在时不创建任何东西', () => {
  const box = sandbox()
  try {
    assert.equal(existsSync(box.file), false, '前置条件不成立：文件本来就存在')

    const r = migrateSecretAtRest(spec(box.file))
    assert.equal(r.outcome, 'missing')
    assert.equal(existsSync(box.file), false, '凭空创建了凭据文件 —— 这是在扩大攻击面，不是缩小')
    assert.deepEqual(box.names(), [], '目录里多出了文件')
  } finally {
    box.cleanup()
  }
})

/* ────────────── 3. 形状不合法 → 字节完全不变（主体） ────────────── */

test('token 形状不合法：文件字节完全不变，也不重新生成', () => {
  const box = sandbox()
  try {
    // 不是 64 位 hex：可能是被别的程序写过、被截断过、或是用户手改过
    const before = JSON.stringify({ token: 'abc', createdAt: 7 }, null, 2)
    writeFileSync(box.file, before, 'utf8')

    const r = migrateSecretAtRest(spec(box.file))
    assert.equal(r.outcome, 'bad-shape')
    assert.equal(box.read(), before, '形状不合法时改动了文件 —— 在这里猜「它大概是什么」只会把坏文件改得更坏')
  } finally {
    box.cleanup()
  }
})

test('字段缺失 / 空串 / 不是 JSON：一律不动', () => {
  const box = sandbox()
  try {
    for (const [content, expect] of [
      [JSON.stringify({ createdAt: 1 }, null, 2), 'empty'],
      [JSON.stringify({ token: '', createdAt: 1 }, null, 2), 'empty'],
      [JSON.stringify({ token: 12345 }, null, 2), 'empty'],
      ['not json at all', 'not-json'],
      ['[]', 'empty']
    ] as const) {
      writeFileSync(box.file, content, 'utf8')
      const r = migrateSecretAtRest(spec(box.file))
      assert.equal(r.outcome, expect, `${content.slice(0, 20)} 的结局是 ${r.outcome}，期望 ${expect}`)
      assert.equal(box.read(), content, `${content.slice(0, 20)} 被改动了`)
    }
  } finally {
    box.cleanup()
  }
})

/* ────────── 4. 密封不可用 → 字节不变且不抛（主体） ────────── */

test('safeStorage 不可用：不抛、文件字节完全不变、返回可判别的失败值', () => {
  const box = sandbox()
  try {
    const before = JSON.stringify({ token: PLAIN, createdAt: 3 }, null, 2)
    writeFileSync(box.file, before, 'utf8')

    // 真实世界里 `sealText` 在 Linux 无 keyring 时就是抛
    const unavailable = (): string => {
      throw new Error('本机 safeStorage 不可用，拒绝以明文落盘')
    }

    let r: ReturnType<typeof migrateSecretAtRest> | undefined
    assert.doesNotThrow(() => {
      r = migrateSecretAtRest(spec(box.file, unavailable))
    }, '密封不可用时抛了 —— 启动路径不能因此中断')

    assert.equal(r?.outcome, 'failed', '结局不是可判别的失败值')
    assert.match(String(r?.reason), /safeStorage/, '失败原因没有透出来，上层无法记日志')
    assert.equal(box.read(), before, '密封失败却改了原文件 —— 那会把唯一可用的凭据毁掉')
  } finally {
    box.cleanup()
  }
})

test('写盘失败：原文件不变，也不留 .tmp', () => {
  const box = sandbox()
  try {
    const before = JSON.stringify({ token: PLAIN, createdAt: 3 }, null, 2)
    writeFileSync(box.file, before, 'utf8')
    // 让 tmp 的写入必然失败：把 `file + '.tmp'` 先建成目录（跨平台、确定）
    mkdirSync(box.file + '.tmp')

    const r = migrateSecretAtRest(spec(box.file))
    assert.equal(r.outcome, 'failed')
    assert.equal(box.read(), before, '写盘失败却动了原文件')
  } finally {
    box.cleanup()
  }
})

/* ────────────────── 5. 原子写本身 ────────────────── */

test('writeFileAtomic：成功后目标完整、无 .tmp 残留', () => {
  const box = sandbox()
  try {
    writeFileAtomic(box.file, 'first')
    assert.equal(box.read(), 'first')
    writeFileAtomic(box.file, 'second')
    assert.equal(box.read(), 'second')
    assert.deepEqual(box.names(), ['local-api-token.json'], '原子写留下了别的文件')
  } finally {
    box.cleanup()
  }
})
