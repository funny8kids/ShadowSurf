/**
 * 数据健康快照的回归测试。
 *
 * 钉的是三件事，都是「说了但没做」的高发区：
 *
 * 1. **只报告，不修改。** 扫描一遍之后目录里一个字节都不该变 —— 这条如果破了，
 *    「健康检查」就变成了「自动修复」，而损坏文件是证据、含明文 seed 的备份
 *    可能是唯一的已知良好快照。
 * 2. **明文 seed 必须被检出。** `copyAside` / 旧的 `backupBeforeMigrate` 都是
 *    原字节复制，所以备份里可能躺着身份派生根。检测靠真读文件内容，不是靠文件名猜。
 * 3. **报真实路径。** 数据目录里 `profiles.json` 和 `audit` 是混着的（历史包袱，
 *    不改名），所以消费方只能靠路径枚举，不能靠后缀规则。
 *
 * `health.ts` 零相对依赖（只 `node:fs` / `node:path` + type-only import），
 * 所以能直接在 Node 里跑真实文件系统。
 *
 * 跑法：node --experimental-strip-types --test tests/store-health.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { collectStoreHealth } from '../src/main/store/health.ts'
import type { HealthStoreRef } from '../src/main/store/health.ts'
import type { StoreCorruptionInfo } from '../src/shared/types.ts'

const SEED = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

function sandbox(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'shadowsurf-health-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 造一个「正常」的 store 引用 */
function okRef(name: string, file: string, schemaVersion = 1): HealthStoreRef {
  return { name, file, schemaVersion, corruption: null }
}

function corruptRef(
  name: string,
  file: string,
  kind: StoreCorruptionInfo['kind'],
  backupPath: string | null = null
): HealthStoreRef {
  return {
    name,
    file,
    schemaVersion: 1,
    corruption: { kind, file, detail: '测试用', backupPath, at: 0 }
  }
}

/* ────────────────────── 1. 正常状态不该占位 ────────────────────── */

test('一切正常：headline 为 null、degraded 为 false、notes 为空', () => {
  const box = sandbox()
  try {
    const profiles = join(box.dir, 'profiles.json')
    writeFileSync(profiles, '{"schema":1,"data":[]}', 'utf8')

    const health = collectStoreHealth(box.dir, [okRef('profiles', profiles)])

    assert.equal(health.headline, null, '正常状态不该有横幅文案')
    assert.equal(health.degraded, false)
    assert.deepEqual(health.notes, [])
    assert.deepEqual(health.backups, [])
    assert.equal(health.dataDir, box.dir)
  } finally {
    box.cleanup()
  }
})

test('文件不存在也算正常（首次运行），不报成损坏', () => {
  const box = sandbox()
  try {
    const health = collectStoreHealth(box.dir, [okRef('profiles', join(box.dir, 'profiles.json'))])

    assert.equal(health.stores[0].exists, false)
    assert.equal(health.stores[0].degraded, false)
    assert.equal(health.headline, null, '首次运行没有文件不是错误')
  } finally {
    box.cleanup()
  }
})

/* ────────────────── 2. 损坏：degraded + 文案按 kind 分支 ────────────────── */

test('文件损坏：degraded 为 true，文案带真实路径', () => {
  const box = sandbox()
  try {
    const file = join(box.dir, 'profiles.json')
    writeFileSync(file, 'broken', 'utf8')

    const health = collectStoreHealth(box.dir, [corruptRef('profiles', file, 'parse')])

    assert.equal(health.degraded, true)
    assert.notEqual(health.headline, null)
    assert.match(String(health.headline), /1 个数据文件不可用/)
    assert.equal(health.stores[0].degraded, true)

    const joined = health.notes.join('\n')
    assert.ok(joined.includes(file), '文案必须带绝对路径 —— 否则用户找不到那个文件')
    assert.match(joined, /内容已损坏/)
    assert.match(joined, /写入已被拒绝/, '必须告诉用户写被拒了，否则他会以为改回来了')
    assert.match(joined, /界面上看不到的数据仍在盘上/, '必须说清数据没丢，只是看不到')
  } finally {
    box.cleanup()
  }
})

test('io（读不到）和 parse（坏了）的文案必须不同 —— 补救动作完全不一样', () => {
  const box = sandbox()
  try {
    const f1 = join(box.dir, 'a.json')
    const f2 = join(box.dir, 'b.json')

    const io = collectStoreHealth(box.dir, [corruptRef('profiles', f1, 'io')])
    const parse = collectStoreHealth(box.dir, [corruptRef('profiles', f2, 'parse')])

    const ioText = io.notes.join('\n')
    const parseText = parse.notes.join('\n')

    assert.notEqual(ioText, parseText, '两种失败说了同一句话 —— 用户会去做无效操作')
    assert.match(ioText, /读不到/, 'io 要说「读不到」')
    assert.match(ioText, /关掉可能占用它的程序/, 'io 的补救动作是关掉占用者')
    assert.doesNotMatch(ioText, /内容已损坏/, 'io 时数据很可能完好，不能说成损坏')
    assert.match(parseText, /内容已损坏/)
  } finally {
    box.cleanup()
  }
})

test('crypto（密钥对不上）不能说成「文件损坏」', () => {
  const box = sandbox()
  try {
    const file = join(box.dir, 'profiles.json')
    const health = collectStoreHealth(box.dir, [corruptRef('profiles', file, 'crypto')])
    const text = health.notes.join('\n')

    assert.match(text, /解不开/)
    assert.match(text, /文件没有损坏/, 'crypto 时文件是好的，说成损坏会让人去恢复数据')
    assert.doesNotMatch(text, /内容已损坏/)
  } finally {
    box.cleanup()
  }
})

test('文案里不得出现「从备份恢复」—— 现在没有这个功能', () => {
  const box = sandbox()
  try {
    const file = join(box.dir, 'profiles.json')
    const health = collectStoreHealth(box.dir, [corruptRef('profiles', file, 'parse', '/x/y.corrupt-1')])

    assert.doesNotMatch(health.notes.join('\n'), /从备份恢复|恢复备份/)
  } finally {
    box.cleanup()
  }
})

/* ────────────────────── 3. 备份扫描 ────────────────────── */

test('三种备份来源都能认出来，并按时间倒序', () => {
  const box = sandbox()
  try {
    const corrupt = join(box.dir, 'profiles.json.corrupt-2026-01-01T00-00-00-000Z')
    const preup = join(box.dir, 'profiles.json.preupgrade0-2026-01-02T00-00-00-000Z')
    const schema = join(box.dir, 'profiles.json.schema0-2026-01-03T00-00-00-000Z')
    writeFileSync(corrupt, '[]', 'utf8')
    writeFileSync(preup, '[]', 'utf8')
    writeFileSync(schema, '[]', 'utf8')
    // 不是备份，不该被扫进来
    writeFileSync(join(box.dir, 'profiles.json'), '{"schema":1,"data":[]}', 'utf8')

    // **必须显式设定 mtime，不能靠「连续写三次」制造先后。**
    // 原来这三行写完就断言「按 mtime 倒序」，在 Windows 上实测会抖动：
    // NTFS 的时间戳粒度 + 三次写入可能落在同一 tick，排序结果取决于
    // 文件系统给的随机次序，而不是代码逻辑。同一天里这条测试红过也绿过 ——
    // 而抖动红比稳定红更有害：它训练人「重跑一次」而不是「去查为什么」。
    // 用 utimesSync 钉住三个明确时刻，这条断言才是在测排序，而不是在测运气。
    const t = (iso: string): Date => new Date(iso)
    utimesSync(corrupt, t('2026-01-01T00:00:00Z'), t('2026-01-01T00:00:00Z'))
    utimesSync(preup, t('2026-01-02T00:00:00Z'), t('2026-01-02T00:00:00Z'))
    utimesSync(schema, t('2026-01-03T00:00:00Z'), t('2026-01-03T00:00:00Z'))

    const health = collectStoreHealth(box.dir, [okRef('profiles', join(box.dir, 'profiles.json'))])
    const origins = health.backups.map((b) => b.origin)

    assert.deepEqual(origins, ['schema', 'preupgrade', 'corrupt'], '应当按 mtime 倒序，且三种来源都认得出')
    assert.equal(health.backups[0].bytes > 0, true)
    assert.ok(health.backups.every((b) => b.path.startsWith(box.dir)))
  } finally {
    box.cleanup()
  }
})

test('无后缀的数据文件（audit / proxies）也按真实路径报出来', () => {
  const box = sandbox()
  try {
    // 数据目录里 .json 和无后缀是混着的，这是历史包袱，不改名
    writeFileSync(join(box.dir, 'audit'), '[]', 'utf8')

    const health = collectStoreHealth(box.dir, [okRef('audit', join(box.dir, 'audit'))])

    assert.equal(health.stores[0].exists, true, '无后缀文件必须被认成存在')
    assert.equal(health.stores[0].file, join(box.dir, 'audit'))
    assert.equal(health.headline, null)
  } finally {
    box.cleanup()
  }
})

/* ────────────────── 4. 明文 seed 检出（这一条是安全轴） ────────────────── */

test('备份里有明文 seed 必须被检出并标出来', () => {
  const box = sandbox()
  try {
    const withSeeds = JSON.stringify([{ id: 'prf_a', seed: SEED }, { id: 'prf_b', seed: SEED }], null, 2)
    writeFileSync(join(box.dir, 'profiles.json.schema0-2026-01-03T00-00-00-000Z'), withSeeds, 'utf8')
    // 加密形态：同样的字段名，但不是 32 位 hex
    writeFileSync(
      join(box.dir, 'profiles.json.preupgrade1-2026-01-04T00-00-00-000Z'),
      JSON.stringify([{ id: 'prf_a', seed: 'enc:YWJjZGVmZ2g=' }], null, 2),
      'utf8'
    )

    const health = collectStoreHealth(box.dir, [okRef('profiles', join(box.dir, 'profiles.json'))])
    const byName = new Map(health.backups.map((b) => [b.name, b]))

    const legacy = byName.get('profiles.json.schema0-2026-01-03T00-00-00-000Z')
    const upgraded = byName.get('profiles.json.preupgrade1-2026-01-04T00-00-00-000Z')

    assert.equal(legacy?.plaintextSeeds, 2, '两条明文 seed 应当被数出来')
    assert.equal(upgraded?.plaintextSeeds, 0, '加密形态不该被误判成明文')

    assert.notEqual(health.headline, null, '检出明文 seed 就该有横幅')
    assert.match(String(health.headline), /明文 seed/)
    assert.equal(health.degraded, false, '明文 seed 不等于「文件不可用」，别把两件事混成一个状态')
    assert.match(health.notes.join('\n'), /身份派生根/)
  } finally {
    box.cleanup()
  }
})

test('没有 seed 字段的 32 位 hex 不该被误报（只认 seed 字段）', () => {
  const box = sandbox()
  try {
    // 审计记录的 hash 就是 64 位 hex，别把任何 hex 都当成 seed
    const entry = JSON.stringify({ id: 'aud_1', hash: 'a'.repeat(64), note: '0123456789abcdef0123456789abcdef' })
    writeFileSync(join(box.dir, 'audit.corrupt-2026-01-03T00-00-00-000Z'), entry, 'utf8')

    const health = collectStoreHealth(box.dir, [okRef('audit', join(box.dir, 'audit'))])

    assert.equal(health.backups[0].plaintextSeeds, 0, '不是 seed 字段的 hex 不该被算成明文 seed')
    assert.equal(health.headline, null)
  } finally {
    box.cleanup()
  }
})

test('旧命名 .schema<N>- 备份会单独提示（它们是明文 seed 的重灾区）', () => {
  const box = sandbox()
  try {
    writeFileSync(join(box.dir, 'profiles.json.schema0-2026-01-03T00-00-00-000Z'), '[]', 'utf8')

    const health = collectStoreHealth(box.dir, [okRef('profiles', join(box.dir, 'profiles.json'))])
    const text = health.notes.join('\n')

    assert.match(text, /旧命名迁移备份/)
    assert.match(text, /原字节复制/)
  } finally {
    box.cleanup()
  }
})

/* ────────────────── 5. 只报告，绝不修改任何文件 ────────────────── */

test('扫描之后目录里的文件内容一个字节都没变', () => {
  const box = sandbox()
  try {
    const files: Record<string, string> = {
      'profiles.json': 'broken json',
      'profiles.json.corrupt-2026-01-03T00-00-00-000Z': JSON.stringify([{ id: 'x', seed: SEED }]),
      'profiles.json.schema0-2026-01-04T00-00-00-000Z': '[]'
    }
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(box.dir, name), body, 'utf8')
    }

    const before = readdirSync(box.dir).sort()
    const bodiesBefore = before.map((n) => readFileSync(join(box.dir, n), 'utf8'))

    collectStoreHealth(box.dir, [
      corruptRef('profiles', join(box.dir, 'profiles.json'), 'parse')
    ])

    const after = readdirSync(box.dir).sort()
    const bodiesAfter = after.map((n) => readFileSync(join(box.dir, n), 'utf8'))

    assert.deepEqual(after, before, '健康检查不该增删任何文件')
    assert.deepEqual(bodiesAfter, bodiesBefore, '健康检查不该改写任何文件内容')
  } finally {
    box.cleanup()
  }
})

test('dataDir 不存在时不抛，返回空备份列表', () => {
  const box = sandbox()
  try {
    const ghost = join(box.dir, 'nope', 'deeper')
    const health = collectStoreHealth(ghost, [okRef('profiles', join(ghost, 'profiles.json'))])

    assert.deepEqual(health.backups, [])
    assert.equal(health.stores[0].exists, false)
    assert.equal(health.headline, null)
  } finally {
    box.cleanup()
  }
})
