/**
 * 存储层的数据安全回归测试。
 *
 * 背景（这一轮要钉死的那条）：
 *
 *   旧实现里，`profiles.json` 只要 JSON 解析失败或形状校验不过，控制流就是
 *     db.ts read() → recover() → renameSync 掉坏文件 → reset(fallback) → persist([])
 *   也就是说「格式改错」的表现不是报错，而是**静默清空全部环境**：
 *   用户下次打开只看到一个空列表，没有任何提示，原文件被挪成一个没人会看的
 *   `.corrupt-<ts>`。而 `profiles.ts` 的 `filter` 还提供了第二条同类路径 ——
 *   形状不对的条目被悄悄丢掉，下一次写入就把丢掉的结果落盘。
 *
 * 这里钉的是三条不变量：
 *   1. 损坏 → 原文件字节不变、不写盘、写入被拒绝（不是「当作空数据」）
 *   2. 旧格式（裸数组 = schema 0）自动迁移到信封（schema 1），且**幂等**
 *   3. 迁移只包信封，不动内容 —— seed 逐字节不变
 *
 * 为什么能直接在 Node 里跑：引擎在 `json-file.ts`，零相对依赖。
 * `db.ts` 静态 import 了 `electron`，在纯 Node 里连模块都求值不了 ——
 * 所以凡是需要被单测的逻辑都不许放在 db.ts（和 evict.ts 是同一个理由）。
 *
 * 跑法：node --experimental-strip-types --test tests/store-schema.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  JsonStore,
  SCHEMA_CURRENT,
  SCHEMA_LEGACY,
  SCHEMA_SEALED,
  StoreCorruptError,
  decodeEnvelope,
  encodeEnvelope,
  isMissingFileError,
  isValidSeed,
  seedForm,
  validateArray,
  validateProfiles
} from '../src/main/store/json-file.ts'

/* ────────────────────────────── 夹具 ────────────────────────────── */

interface FakeProfile {
  id: string
  seed: string
  fingerprint: Record<string, unknown>
}

/** deriveSeed() 的真实产物形态：HKDF 取前 32 个 hex 字符 */
const SEED_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const SEED_B = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'

function makeProfiles(): FakeProfile[] {
  return [
    { id: 'prf_aaa', seed: SEED_A, fingerprint: { os: 'windows' } },
    { id: 'prf_bbb', seed: SEED_B, fingerprint: { os: 'mac' } }
  ]
}

interface Sandbox {
  dir: string
  file: string
  read: () => string
  /** 目录里所有文件名 */
  names: () => string[]
  cleanup: () => void
}

function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'shadowsurf-store-'))
  const file = join(dir, 'profiles.json')
  return {
    dir,
    file,
    read: () => readFileSync(file, 'utf8'),
    names: () => readdirSync(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

/** 按 profiles 的真实配置造一个 store（fallback = 空列表 + 严格校验） */
function profilesStore(file: string): JsonStore<FakeProfile[]> {
  return new JsonStore<FakeProfile[]>(
    file,
    () => [],
    (data, schema, path) => validateProfiles(data, schema, path) as unknown as FakeProfile[]
  )
}

/** 断言「文件字节一个都没变」 */
function assertBytesUnchanged(box: Sandbox, before: string, why: string): void {
  assert.equal(box.read(), before, `${why}：原文件内容被改动了`)
}

/* ────────────── 1. 损坏数据绝不清空（本轮的核心） ────────────── */

test('JSON 解析失败：原文件字节不变，不写回空数组', () => {
  const box = sandbox()
  try {
    // 少一个右括号 —— 这是「手改配置文件改错」最典型的样子
    const broken = '[{"id":"prf_aaa","seed":"' + SEED_A + '","fingerprint":{}}'
    writeFileSync(box.file, broken, 'utf8')

    const store = profilesStore(box.file)
    const result = store.readResult()

    assert.equal(result.ok, false, '损坏文件被当成了正常数据')
    assert.notEqual(store.corruption, null, '损坏没有被记录下来')
    assert.deepEqual(result.value, [], '降级值应当是空列表（应用还得能起来）')

    // 核心断言：旧实现在这里会 persist([])，把文件清成 `[]`
    assertBytesUnchanged(box, broken, '解析失败后')

    // 备份是副本，不是「把原文件挪走」—— 原文件必须留在原路径
    const backups = box.names().filter((n) => n.includes('.corrupt-'))
    assert.equal(backups.length, 1, `期望 1 份 .corrupt 备份，实际 ${String(backups.length)} 份`)
    assert.equal(readFileSync(join(box.dir, backups[0]), 'utf8'), broken, '备份内容必须与原文件逐字节一致')
  } finally {
    box.cleanup()
  }
})

test('形状校验失败（seed 不是 32 位 hex）：整体判损坏，不静默丢条目', () => {
  const box = sandbox()
  try {
    // 两条里有一条坏了。旧实现会 filter 掉坏的、保留好的，
    // 下一次写入就把「只剩一条」落盘 —— 用户看到的是「环境少了」。
    const broken = JSON.stringify([
      { id: 'prf_aaa', seed: SEED_A, fingerprint: {} },
      { id: 'prf_bbb', seed: 'not-a-seed', fingerprint: {} }
    ])
    writeFileSync(box.file, broken, 'utf8')

    const store = profilesStore(box.file)
    const result = store.readResult()

    assert.equal(result.ok, false)
    assert.deepEqual(result.value, [], '不能返回「过滤后的好条目」，那等于替调用方决定丢数据')
    assert.match(String(store.corruption?.detail), /第 2 条/, '错误信息必须指出是第几条坏了')
    assertBytesUnchanged(box, broken, '校验失败后')
  } finally {
    box.cleanup()
  }
})

test('损坏状态下的写入被拒绝，且文件仍然不变', () => {
  const box = sandbox()
  try {
    const broken = 'not json at all'
    writeFileSync(box.file, broken, 'utf8')

    const store = profilesStore(box.file)
    store.read() // 先触发一次检测

    assert.throws(
      () => store.write(makeProfiles()),
      (err: unknown) => err instanceof StoreCorruptError,
      'write() 必须 fail-closed，否则一次自动保存就把用户数据覆盖成空'
    )
    assert.throws(
      () => store.update((draft) => draft.push(makeProfiles()[0])),
      (err: unknown) => err instanceof StoreCorruptError,
      'update() 必须 fail-closed'
    )

    assertBytesUnchanged(box, broken, '拒绝写入之后')
  } finally {
    box.cleanup()
  }
})

test('没读过就写：也先检测一次，不允许覆盖盘上的坏文件', () => {
  const box = sandbox()
  try {
    // 这条挡的是「先 write 后 read」的顺序：任务历史那种一上来就 clear() 的路径
    const broken = '{"schema":1,"data":'
    writeFileSync(box.file, broken, 'utf8')

    const store = profilesStore(box.file)
    assert.throws(
      () => store.write([]),
      (err: unknown) => err instanceof StoreCorruptError,
      'write() 之前没有 read()，但盘上已经是坏文件 —— 仍然必须拒绝'
    )
    assertBytesUnchanged(box, broken, '首次写入被拒绝之后')
  } finally {
    box.cleanup()
  }
})

test('用户把文件修好后，同一个 store 能自愈（不用重启）', () => {
  const box = sandbox()
  try {
    writeFileSync(box.file, 'oops', 'utf8')
    const store = profilesStore(box.file)
    assert.equal(store.readResult().ok, false)
    assert.notEqual(store.corruption, null)

    // 手改回一个合法文件（mtime 一定会变）
    writeFileSync(box.file, JSON.stringify(encodeEnvelope(SCHEMA_CURRENT, makeProfiles())), 'utf8')

    const healed = store.readResult()
    assert.equal(healed.ok, true, '文件被修好后应当恢复读取，而不是一直卡在降级状态')
    assert.equal(store.corruption, null)
    assert.equal(healed.value.length, 2)
  } finally {
    box.cleanup()
  }
})

test('schema 高于本版本：拒绝读取，不当空数据', () => {
  const box = sandbox()
  try {
    // 模拟「用旧版应用打开新版数据」
    const future = JSON.stringify(encodeEnvelope(SCHEMA_CURRENT + 5, makeProfiles()))
    writeFileSync(box.file, future, 'utf8')

    const store = profilesStore(box.file)
    const result = store.readResult()

    assert.equal(result.ok, false, '降级读会把新版数据整份覆盖掉，必须拒绝')
    assert.equal(store.corruption?.kind, 'version')
    assertBytesUnchanged(box, future, '版本过高被拒后')
  } finally {
    box.cleanup()
  }
})

/* ────────────── 2. 旧格式迁移：幂等 ────────────── */

test('裸数组（schema 0）自动迁移到信封（schema 1），且第二次读不再改写', () => {
  const box = sandbox()
  try {
    // 旧版本落盘的就是裸数组
    const legacy = JSON.stringify(makeProfiles(), null, 2)
    writeFileSync(box.file, legacy, 'utf8')

    const store = profilesStore(box.file)
    const first = store.readResult()

    assert.equal(first.ok, true, '旧格式必须能读出来，不能判成损坏')
    assert.equal(store.schemaVersion, SCHEMA_CURRENT)
    assert.equal(first.value.length, 2, '迁移不能丢条目')

    const migrated = box.read()
    const envelope = JSON.parse(migrated) as { schema: number; data: FakeProfile[] }
    assert.equal(envelope.schema, SCHEMA_CURRENT, '迁移后必须带信封')
    assert.equal(envelope.data.length, 2)

    // 迁移前先备份原字节：新版迁坏了还能退回去
    /* ── 备份策略按「迁移目标是否密封」分成两种，判据相反，不能合成一条 ──
       裁决（team-lead，2026-11-01）：
         目标不涉及密封（schema 0 → 1，只是套信封）→ 备份内容 = **原字节复制**。
           唯一用途是「新版把数据迁坏了，退回旧版还能读」，而退回旧版要求
           备份仍是 schema 0 的裸数组；重新序列化成信封就退不回去了。
         目标是 SCHEMA_SEALED → 迁移成功且读回校验通过后**按密封格式重写**，
           备份里不得留明文 seed。见下一条用例。

       断言绑**两样东西**，都带语义：
         内容 —— 逐字节等于迁移前的原文件（退不回旧版就是没有回退能力）
         文件名 —— 含 `.preupgrade<源版本>-`。这不是外观检查：这个名字记录的是
           「这份副本能退回哪个版本」，用目标版本命名会让人在手工恢复时把它当成
           本版本的数据直接拷回去。所以绑的是「名字里的版本号是源版本」这条语义，
           不是某一种具体拼法（时间戳格式、扩展名都不管）。 */
    const backups = box.names().filter((n) => n !== 'profiles.json')
    assert.equal(
      backups.length,
      1,
      `迁移前必须留一份备份，实际目录内容：${box.names().join(', ') || '（空）'}`
    )
    // 命名不是外观问题：`.preupgrade<from>-` 记录的是**源** schema（这份副本能退回
    // 哪个版本）。用目标版本命名会让人在手工恢复时把它当成本版本的数据直接拷回去。
    assert.ok(
      backups[0].includes('.preupgrade' + String(SCHEMA_LEGACY) + '-'),
      `备份文件名必须记录源 schema（期望含 .preupgrade0-），实际：${backups[0]}`
    )
    assert.equal(
      readFileSync(join(box.dir, backups[0]), 'utf8'),
      legacy,
      `schema0 备份必须与原文件逐字节一致（实际备份：${backups[0]}）—— ` +
        '逐字节不同说明它被重新序列化过，那种备份退不回旧版，等于没有回退能力。' +
        '注意：迁移目标 >= SCHEMA_SEALED 时判据相反，见下一条用例'
    )

    // 幂等：再读一次，文件字节和写次数都不该再动
    const writesAfterMigrate = store.version
    const bytesAfterMigrate = migrated
    const second = store.readResult()

    assert.equal(second.ok, true)
    assert.equal(box.read(), bytesAfterMigrate, '第二次读又改了文件 —— 迁移不幂等')
    assert.equal(store.version, writesAfterMigrate, '第二次读触发了写入 —— 迁移不幂等')

    // 换一个全新 store 再读（模拟重启），同样不该再迁移
    const fresh = profilesStore(box.file)
    assert.equal(fresh.readResult().ok, true)
    assert.equal(box.read(), bytesAfterMigrate, '重启后又改了文件 —— 迁移不幂等')
    assert.equal(
      box.names().filter((n) => n !== 'profiles.json').length,
      1,
      '重复迁移会不断堆备份文件 —— 这里数的是「除主文件外的一切」，' +
        '不绑文件名，所以换成别的命名约定也照样能判'
    )
  } finally {
    box.cleanup()
  }
})

test('迁移到 SCHEMA_SEALED：备份里不得留下明文 seed', () => {
  const box = sandbox()
  try {
    const plain = makeProfiles()
    writeFileSync(box.file, JSON.stringify(plain, null, 2), 'utf8')

    /* ── 这条测什么、不测什么 ──
       测：store 在「目标版本要求密封」时，会不会把迁移前的明文抄进备份文件。
       不测：密封算法强度。这里的 `fakeSeal` 是**可逆的**假密封，只负责把形态
             做成 schema 2 的合法 blob。强度由 `seed-seal.ts`（safeStorage/DPAPI）
             与 `tools/verify-seed-at-rest.mjs` 负责。
       可逆的假密封正好够用：如果 store 走原字节复制，备份里就会出现明文 hex，
       这条必红 —— 判据有区分度，不依赖真加密。

       为什么单独一条而不是并进上一条：两条的判据方向**相反**。
       上一条要求「逐字节相同」，这条要求「逐字节相同就是缺陷」。 */
    const fakeSeal = (hex: string): string =>
      'enc:' + Buffer.from('fake:' + hex, 'utf8').toString('base64')

    /* ── migrate 会被调用**两次**，所以它必须幂等 ──
       写之前一次（from = 0 → 密封），`verifyMigrated()` 读回校验又一次
       （此时盘上已是 schema 2，from = 2）。第二次如果又密封一遍，就是双重密封：
       读回来的是 `enc:enc:...`，`isValidSeed(_, 2)` 仍成立，但 `openSeed` 会炸。
       任何「加密」型迁移天然不幂等，必须按 `from` 分支 —— 这是 json-file.ts 的
       隐含契约，之前没有任何用例钉过它。 */
    const sealOnMigrate = (data: unknown, from: number, path: string): FakeProfile[] => {
      const profiles = validateProfiles(data, from, path)
      if (from >= SCHEMA_SEALED) return profiles
      return profiles.map((p) => ({ ...p, seed: fakeSeal(p.seed) }))
    }

    const store = new JsonStore<FakeProfile[]>(box.file, () => [], sealOnMigrate, {
      schema: SCHEMA_SEALED
    })

    const read = store.readResult()
    assert.equal(
      read.ok,
      true,
      '迁移到 SEALED 失败：' + String(read.corruption?.detail ?? read.corruption?.kind ?? '')
    )
    assert.equal(store.schemaVersion, SCHEMA_SEALED, '迁移后版本号不是目标版本')

    // 空集恒真：没有备份文件时「备份里没有明文」永远成立。所以先断存在。
    const backups = box.names().filter((n) => n !== 'profiles.json')
    assert.equal(
      backups.length,
      1,
      `迁移必须留恰好一份备份，实际目录内容：${box.names().join(', ') || '（空）'}`
    )

    const backupBytes = readFileSync(join(box.dir, backups[0]), 'utf8')
    for (const p of plain) {
      assert.ok(
        !backupBytes.includes(p.seed),
        `备份文件里出现了明文 seed（profile=${p.id}）—— 迁移把明文抄到了 ` +
          `${backups[0]} 旁边，「加密成功」的表象下明文还躺在同一个目录里`
      )
    }

    /* ── P0-3 验收判据：与 tools/verify-seed-at-rest.mjs 同一口径 ──
       那个工具扫的是 `"seed": "<16+ hex>"` 这种**JSON 字段形态**，而不是
       「某个已知的 seed 值」。两种判据缺一不可：
         · 逐值比对（上面那条）证明「这三个已知明文没漏」
         · 形态扫描（下面这条）证明「没有任何未知明文漏」—— 覆盖未来新增的
           profile、以及「把 seed 复制到别的字段里」这种形态
       范围是**目录里所有文件**，不只备份：主文件写错了同样算失败。 */
    const PLAINTEXT_SEED_FIELD = /"seed"\s*:\s*"[0-9a-fA-F]{16,}"/g
    for (const name of box.names()) {
      const bytes = readFileSync(join(box.dir, name), 'utf8')
      const hits = bytes.match(PLAINTEXT_SEED_FIELD) ?? []
      assert.equal(
        hits.length,
        0,
        `${name} 里有 ${String(hits.length)} 处明文 seed 字段（形态 "seed":"<hex>"）—— ` +
          '迁移后整个数据目录都不该再有这种形态，包括备份'
      )
    }

    // 判据与 tools/verify-seed-at-rest.mjs 对齐：备份里的 seed 必须能过
    // isValidSeed(_, SCHEMA_SEALED)。上面那条查「明文没出现」，这条查
    // 「出现的形态确实合法」—— 只查前者的话，把 seed 整个丢掉也能过。
    const parsed: unknown = JSON.parse(backupBytes)
    const items = (
      Array.isArray(parsed) ? parsed : (parsed as { data?: unknown }).data
    ) as FakeProfile[]
    assert.equal(items.length, plain.length, '备份里的条目数与迁移前不一致 —— 备份不可用于恢复')
    for (const item of items) {
      assert.ok(
        isValidSeed(item.seed, SCHEMA_SEALED),
        `备份里 profile=${item.id} 的 seed 不是密封形态 —— ` +
          '要么没重新序列化，要么序列化时用错了目标版本'
      )
    }
  } finally {
    box.cleanup()
  }
})

test('decodeEnvelope 幂等：encode 之后再 decode 得到同一份内容', () => {
  const data = makeProfiles()
  const once = decodeEnvelope(JSON.parse(JSON.stringify(encodeEnvelope(SCHEMA_CURRENT, data))))
  assert.equal(once.schema, SCHEMA_CURRENT)
  assert.deepEqual(once.data, data)

  // 再包一层不会发生（信封里不会再套信封），但重复 decode 结果必须稳定
  const twice = decodeEnvelope(JSON.parse(JSON.stringify(encodeEnvelope(once.schema, once.data))))
  assert.deepEqual(twice, once)
})

test('裸值一律按 schema 0 解释（旧 settings.json 是裸对象，不是裸数组）', () => {
  assert.deepEqual(decodeEnvelope([{ id: 'x' }]), { schema: SCHEMA_LEGACY, data: [{ id: 'x' }] })
  assert.deepEqual(decodeEnvelope({ provider: 'openai' }), {
    schema: SCHEMA_LEGACY,
    data: { provider: 'openai' }
  })
  // 信封形状才认版本号
  assert.deepEqual(decodeEnvelope({ schema: 1, data: [] }), { schema: 1, data: [] })
})

/* ────────────── 2b. 备份的三条去向：删、留、不重写 ────────────── */

/**
 * 备份在三种结局下的处置**各不相同**，而且判据互相矛盾，所以必须三条分开写。
 * 合并成一条「备份策略」会得到一条永远说不清哪里错的断言。
 *
 *   A 写回失败 + 主文件没动   → 备份是纯副本，删掉（否则每次启动多堆一份）
 *   B 写回成功 + 读不回       → 备份是唯一退路，保留且**保持明文**
 *   C 写回成功 + 读回但内容对不上 → 备份**不重写**（主文件此刻可疑）
 */
test('迁移写回失败且主文件未动：纯副本备份必须被清掉', () => {
  const box = sandbox()
  try {
    const legacy = JSON.stringify(makeProfiles(), null, 2)
    writeFileSync(box.file, legacy, 'utf8')
    /* 跨平台、确定的失败注入：persist 会 openSync(file + '.tmp', 'w')，
       把那个路径先建成目录，open 就抛 EISDIR。
       不用 chmod（Windows 上无效）、不用只读盘（CI 上不可靠）。 */
    mkdirSync(box.file + '.tmp')

    const store = profilesStore(box.file)
    const r = store.readResult()

    assert.equal(r.ok, true, '写回失败不该判成数据损坏 —— 文件还是旧格式，内容完好')
    assert.equal(r.value.length, 2, '内存里应当用新值继续，应用不能因此崩')
    assert.equal(box.read(), legacy, '主文件必须一个字节都没动')

    const preupgrades = box.names().filter((n) => n.includes('.preupgrade'))
    assert.deepEqual(
      preupgrades,
      [],
      '主文件没动时备份是纯副本，必须删掉 —— 「只读盘 / 磁盘满 / 权限不对」恰恰会' +
        '反复失败反复重试，一年就是几百份 profiles.json 副本'
    )
  } finally {
    box.cleanup()
  }
})

test('迁移写回成功但读不回：备份必须保留，且保持明文', () => {
  const box = sandbox()
  try {
    writeFileSync(box.file, JSON.stringify(makeProfiles(), null, 2), 'utf8')

    /* from=0 正常迁移；verifyMigrated() 会以 from=1 再调一次，在那里故意炸。
       这条走的是「写成功 ≠ 下次读得回来」那一档，和 A 的判据完全相反。 */
    const migrate = (data: unknown, from: number, path: string): FakeProfile[] => {
      if (from >= SCHEMA_CURRENT) throw new Error('读回校验故意失败')
      return validateProfiles(data, from, path)
    }
    const store = new JsonStore<FakeProfile[]>(box.file, () => [], migrate)
    const r = store.readResult()

    assert.equal(r.ok, false, '读不回必须降级，不能假装成功 —— 否则下次启动才炸')
    assert.equal(store.corruption?.kind, 'shape')

    const preupgrades = box.names().filter((n) => n.includes('.preupgrade'))
    assert.equal(preupgrades.length, 1, '迁移前那份备份必须保留，这是唯一的退路')

    const backup = readFileSync(join(box.dir, preupgrades[0]), 'utf8')
    assert.ok(
      backup.includes(SEED_A),
      '失败时备份必须保持明文 —— 它的用途是「用户直接打开就能读」，' +
        '在这个时点做任何重写都是拿没通过校验的东西换掉已知良好的东西'
    )
  } finally {
    box.cleanup()
  }
})

test('迁移读回内容对不上时不重写备份', () => {
  const box = sandbox()
  try {
    writeFileSync(box.file, JSON.stringify(makeProfiles(), null, 2), 'utf8')
    const fakeSeal = (hex: string): string =>
      'enc:' + Buffer.from('fake:' + hex, 'utf8').toString('base64')

    /* 构造 contentMismatch（读得回来，但内容和写入的不一致）：
       每次调用都往 fingerprint 里 +1。于是 verifyMigrated 拿「读回来再 migrate
       一次」的结果去比 expected，一定对不上。形状仍然合法（fingerprint 是任意
       record），所以走的是「只告警」那一档，不是 ok:false。 */
    const migrate = (data: unknown, from: number, path: string): FakeProfile[] => {
      const list = validateProfiles(data, from, path)
      return list.map((p) => {
        const fp = p.fingerprint as Record<string, unknown>
        return {
          ...p,
          seed: from >= SCHEMA_SEALED ? p.seed : fakeSeal(p.seed),
          fingerprint: { ...p.fingerprint, touched: Number(fp['touched'] ?? 0) + 1 }
        }
      })
    }
    const store = new JsonStore<FakeProfile[]>(box.file, () => [], migrate, { schema: SCHEMA_SEALED })
    const r = store.readResult()

    assert.equal(r.ok, true, '内容对不上不该隔离 —— 数据没丢，没有拦用户写入的理由')
    assert.equal(store.corruption, null)

    const backups = box.names().filter((n) => n !== 'profiles.json')
    assert.equal(backups.length, 1, `备份数不对，目录内容：${box.names().join(', ')}`)
    const backup = readFileSync(join(box.dir, backups[0]), 'utf8')
    assert.ok(
      backup.includes(SEED_A),
      'contentMismatch 时备份被重写了。主文件此刻的形态本身就可疑，' +
        '拿它覆盖那份已知良好的字节副本，等于把唯一的干净退路换成一份没通过校验的东西'
    )
  } finally {
    box.cleanup()
  }
})



/* ────────────── 3. 迁移只包信封，seed 逐字节不变 ────────────── */

test('迁移后 seed 完全不变（迁移只加信封，不碰内容）', () => {
  const box = sandbox()
  try {
    const before = makeProfiles()
    writeFileSync(box.file, JSON.stringify(before, null, 2), 'utf8')

    const store = profilesStore(box.file)
    const after = store.read()

    assert.deepEqual(
      after.map((p) => p.seed),
      before.map((p) => p.seed),
      '迁移改动了 seed —— 那等于给用户换了一套身份'
    )
    assert.deepEqual(
      after.map((p) => p.id),
      before.map((p) => p.id),
      '迁移改动了 id —— 那等于所有环境指向了不存在的历史'
    )
    // 字段级也核一遍，避免「数组看着对但对象被重建成新对象」。
    //
    // 唯一的例外是 `allowUnmaskedL2`：它是后加的字段，老盘文件里没有，
    // 读盘入口统一补 `false`（见 `validateProfiles`）。**除了它，任何字段都不许变** ——
    // 所以这里把它显式写进期望值，而不是把比较放宽成「只比 id 和 seed」。
    // 放宽之后，下一次「迁移顺手改了某个字段」就没人拦得住了。
    assert.deepEqual(
      after,
      before.map((p) => ({ ...p, allowUnmaskedL2: false }))
    )
  } finally {
    box.cleanup()
  }
})

/* ────────────── 4. seed 形态判断点（为加密预留） ────────────── */

test('seed 形态由 schema 决定，不是「是字符串就行」', () => {
  assert.equal(seedForm(SCHEMA_LEGACY), 'plain-hex')
  assert.equal(seedForm(SCHEMA_CURRENT), 'plain-hex')
  assert.equal(seedForm(SCHEMA_SEALED), 'sealed-blob')

  // 明文 hex：只有 32 位小写 hex 合法
  assert.equal(isValidSeed(SEED_A, SCHEMA_CURRENT), true)
  assert.equal(isValidSeed('', SCHEMA_CURRENT), false, '空串必须被判非法，否则会生成一套假指纹')
  assert.equal(isValidSeed('not-a-seed', SCHEMA_CURRENT), false)
  assert.equal(isValidSeed(SEED_A.slice(0, 16), SCHEMA_CURRENT), false, '半截 hex 必须被判非法')
  assert.equal(isValidSeed(SEED_A.toUpperCase(), SCHEMA_CURRENT), false, '大小写不是随手放宽的理由')
  assert.equal(isValidSeed(12345, SCHEMA_CURRENT), false, '非字符串必须被判非法')

  // 加密形态：`enc:` + base64，且明文 hex 不能再通过（否则加密就成了可绕过的）
  assert.equal(isValidSeed('enc:YWJjZGVmZ2g=', SCHEMA_SEALED), true)
  assert.equal(isValidSeed(SEED_A, SCHEMA_SEALED), false, 'schema 2 之后明文 hex 必须被判非法')
  assert.equal(isValidSeed('enc:', SCHEMA_SEALED), false)
})

test('schema 1 的文件里出现加密 blob 也算形状错（形态与版本必须一致）', () => {
  assert.throws(
    () => validateProfiles([{ id: 'prf_x', seed: 'enc:YWJj', fingerprint: {} }], SCHEMA_CURRENT, 'f.json'),
    (err: unknown) => err instanceof StoreCorruptError && /seed/.test((err as Error).message)
  )
})

/* ────────────── 5. 集合类 store 的文件级形状 ────────────── */

test('集合文件不是数组时判损坏，而不是抛一个看不出根因的 TypeError', () => {
  const box = sandbox()
  try {
    const broken = '{"schema":1,"data":{"oops":true}}'
    writeFileSync(box.file, broken, 'utf8')

    const store = new JsonStore<unknown[]>(box.file, () => [], (data, _s, file) =>
      validateArray<unknown>(data, file)
    )

    const result = store.readResult()
    assert.equal(result.ok, false)
    assert.equal(store.corruption?.kind, 'shape')
    assert.deepEqual(result.value, [])
    assertBytesUnchanged(box, broken, '集合形状错被拒后')
  } finally {
    box.cleanup()
  }
})

/* ────────────── 6. 首次运行：唯一允许写 fallback 的路径 ────────────── */

test('文件不存在时才初始化，且初始化出去的就是信封格式', () => {
  const box = sandbox()
  try {
    const store = profilesStore(box.file)
    const result = store.readResult()

    assert.equal(result.ok, true)
    assert.deepEqual(result.value, [])
    assert.equal(store.corruption, null)

    const written = JSON.parse(box.read()) as { schema: number; data: unknown[] }
    assert.equal(written.schema, SCHEMA_CURRENT, '首次落盘就应该是信封，而不是裸数组')
    assert.deepEqual(written.data, [])
  } finally {
    box.cleanup()
  }
})

test('文件被用户删掉后视为重置，不再卡在损坏状态', () => {
  const box = sandbox()
  try {
    writeFileSync(box.file, 'broken', 'utf8')
    const store = profilesStore(box.file)
    assert.equal(store.readResult().ok, false)

    rmSync(box.file)
    const result = store.readResult()
    assert.equal(result.ok, true, '用户主动删文件 = 想要重来，应当恢复而不是一直报错')
    assert.equal(store.corruption, null)
  } finally {
    box.cleanup()
  }
})

/* ────────────── 7. 原子写没被改坏 ────────────── */

test('落盘后不留 .tmp 残留，且 mtime 缓存能命中', () => {
  const box = sandbox()
  try {
    const store = profilesStore(box.file)
    store.write(makeProfiles())

    assert.equal(
      box.names().filter((n) => n.endsWith('.tmp')).length,
      0,
      '原子写应当把 tmp rename 掉，不该留下残留'
    )

    const mtime = statSync(box.file).mtimeMs
    const writes = store.version
    store.read()
    store.read()
    assert.equal(statSync(box.file).mtimeMs, mtime)
    assert.equal(store.version, writes, '读不应触发写入')
  } finally {
    box.cleanup()
  }
})

/* ────────── 8. 「读不到」不能被当成「不存在」（同一条不变量的另一个入口） ────────── */

/**
 * 这是同一条「读不毁数据」不变量上的第二个入口，比「格式改错」更隐蔽：
 *
 *   statOrNull 原来是 `catch { return null }`，于是 EACCES / EBUSY / EMFILE
 *   （杀软扫描、Everything 之类索引服务、备份软件持句柄时很常见）全都被当成
 *   「文件不存在」→ 走「首次运行」分支 → 把 `[]` 写回磁盘。
 *   连 `.corrupt-*` 备份都不会留，因为根本没进 quarantine。
 *
 * 分两层测：
 *   a) 纯函数层：ENOENT 才是「不存在」，其余 errno 一律不是（EACCES/EBUSY/EMFILE
 *      在 Windows 开发机上没法可靠复现，只能这样钉）；
 *   b) 接线层：让 statSync 真的抛一个非 ENOENT 的错误，验证它一路走到
 *      quarantine('io') 且没写盘。
 */
test('isMissingFileError：只有 ENOENT 才算「文件不存在」', () => {
  assert.equal(isMissingFileError({ code: 'ENOENT' }), true)

  // 这几个才是真实世界里「读不到」的样子，一个都不能被当成「不存在」
  for (const code of ['EACCES', 'EPERM', 'EBUSY', 'EMFILE', 'ENFILE', 'EIO', 'ENOTDIR', 'EISDIR']) {
    assert.equal(
      isMissingFileError({ code }),
      false,
      `${code} 被当成了「文件不存在」—— 那条路径会直接把 [] 写回磁盘`
    )
  }

  // 拿不到 code 的错误也不能算「不存在」：宁可报错，不可静默清空
  assert.equal(isMissingFileError(new Error('boom')), false)
  assert.equal(isMissingFileError(null), false)
  assert.equal(isMissingFileError(undefined), false)
  assert.equal(isMissingFileError('ENOENT'), false, '字符串不是 errno 对象')
})

test('stat 抛非 ENOENT 错误：判 io 损坏，绝不当成首次运行写空数组', () => {
  const box = sandbox()
  try {
    // 含 NUL 的路径让 statSync 抛 ERR_INVALID_ARG_VALUE（非 ENOENT），
    // 跨平台且确定 —— 用它代表「读不到但不是不存在」这一整类。
    const unreachable = join(box.dir, 'pro\u0000files.json')

    const store = profilesStore(unreachable)
    const result = store.readResult()

    assert.equal(result.ok, false, '读不到状态却当成「首次运行」—— 那会写回空数组')
    assert.equal(store.corruption?.kind, 'io', '应当归到 io，而不是 parse/shape')
    assert.match(String(store.corruption?.detail), /无法读取文件状态/)

    // 关键：磁盘上什么都没多出来（既没写文件，也没留下半截 tmp）
    assert.deepEqual(box.names(), [], '读不到状态时不该产生任何文件')

    // 写路径同样 fail-closed
    assert.throws(
      () => store.write([]),
      (err: unknown) => err instanceof StoreCorruptError && (err as StoreCorruptError).kind === 'io',
      '状态读不到时必须拒绝写入'
    )
    assert.deepEqual(box.names(), [], '拒绝写入之后仍然不该产生任何文件')

    // 重复读不刷屏（同一种失败只备份 + 记一次日志）
    assert.equal(store.readResult().ok, false)
    assert.equal(store.corruption?.kind, 'io')
  } finally {
    box.cleanup()
  }
})

test('ENOENT 仍然当作首次运行（这条不能被上面的严格化误伤）', () => {
  const box = sandbox()
  try {
    const missing = join(box.dir, 'sub', 'profiles.json')
    const store = profilesStore(missing)
    const result = store.readResult()

    assert.equal(result.ok, true, 'ENOENT = 真的不存在，应当初始化')
    assert.equal(store.corruption, null)
    assert.deepEqual(result.value, [])
    assert.ok(box.names().includes('sub'), '应当建出目录并写入初始文件')
  } finally {
    box.cleanup()
  }
})

/* ────────── 9. 关掉信封的逃生舱（decodeEnvelope 维护约束的落地） ────────── */

test('envelope=false：不探测、不包装、不迁移，完全回到裸格式', () => {
  const box = sandbox()
  try {
    // 一个「裸格式里正好含 schema + data」的数据 —— 开着探测就会被误判成信封
    const raw = { schema: 'not-a-version', data: 'just a field', provider: 'openai' }
    writeFileSync(box.file, JSON.stringify(raw), 'utf8')

    const store = new JsonStore<Record<string, unknown>>(
      box.file,
      () => ({}),
      (data) => data as Record<string, unknown>,
      { envelope: false }
    )

    const result = store.readResult()
    assert.equal(result.ok, true, '关掉信封后不该把这份数据判成信封/损坏')
    assert.deepEqual(result.value, raw)
    assert.equal(store.schemaVersion, SCHEMA_LEGACY, '关掉信封的 store 没有版本概念')
    assert.equal(box.read(), JSON.stringify(raw), '没有触发迁移写回')

    // 写出去也还是裸格式
    store.write({ provider: 'anthropic' })
    assert.deepEqual(JSON.parse(box.read()), { provider: 'anthropic' })
  } finally {
    box.cleanup()
  }
})

/* ────────── 10. 单次操作只认一个 target（P0：升级后环境列表变空） ────────── */

/**
 * 这一组钉的是「升级后用户发现所有环境都没了」那条链路。
 *
 * 触发条件：`schema` 选项可以传**函数**（`profiles.ts` 的 `targetSchema()` 每次现算
 * `safeStorage.isEncryptionAvailable()`）。只要同一次 read 里取到两个不同的值，
 * 就会出现「按 2 决定要迁移 → persist 按 1 写出去 → `verifyMigrated` 拿 2 比对刚写的 1
 * → 判 schema 对不上 → quarantine → `read()` 返回 fallback → 界面空列表」。
 *
 * 旧实现里 `readResult()` 取一次 `this.schema`、`persist()` 内部**又取一次**，
 * 所以这条链路是真实存在的：用「第一次返回 2、之后返回 1」的 schema 函数可以稳定复现，
 * 返回 0 条 + `corruption.kind === 'shape'`，症状和这一轮要修的 bug 一模一样。
 *
 * 修复方式不是「把第二次取值删掉」，而是**让 target 成为参数一路传下去**：
 * 一次公开操作（read / write / update）= 一个 target。这样「判断用 A、写入用 B」
 * 在结构上就写不出来。
 */
test('schema 函数在单次读里只被取一次（取两次会把迁移写成 quarantine）', () => {
  const box = sandbox()
  try {
    writeFileSync(box.file, JSON.stringify({ schema: SCHEMA_CURRENT, data: makeProfiles() }, null, 2), 'utf8')

    let calls = 0
    const flaky = (): number => {
      calls += 1
      return calls === 1 ? SCHEMA_SEALED : SCHEMA_CURRENT
    }

    const store = new JsonStore<FakeProfile[]>(box.file, () => [], (d, s, f) =>
      validateProfiles(d, s, f) as unknown as FakeProfile[],
      {
        schema: flaky,
        serialize: (list, s) =>
          s >= SCHEMA_SEALED
            ? list.map((p) => ({ ...p, seed: 'enc:' + Buffer.from(p.seed, 'utf8').toString('base64') }))
            : list,
        verify: (list, s, f) => validateProfiles(list, s, f)
      }
    )

    const r = store.readResult()
    assert.equal(calls, 1, `schema 函数被取了 ${String(calls)} 次 —— 取两次就可能「按 A 判断、按 B 写」`)
    assert.equal(r.ok, true, '迁移失败被当成损坏了：' + String(store.corruption?.detail ?? ''))
    assert.equal(r.value.length, 2, '返回的是降级空列表 —— 这就是「升级后环境全没了」')
    assert.equal(store.corruption, null)
  } finally {
    box.cleanup()
  }
})

test('migrate 在一次读里跑两遍也必须幂等（第二遍 from = 目标版本）', () => {
  const box = sandbox()
  try {
    writeFileSync(box.file, JSON.stringify(makeProfiles(), null, 2), 'utf8')

    // 记录每次 migrate 收到的来源版本
    const froms: number[] = []
    const store = new JsonStore<FakeProfile[]>(box.file, () => [], (d, s, f) => {
      froms.push(s)
      return validateProfiles(d, s, f) as unknown as FakeProfile[]
    })

    const r = store.readResult()
    assert.equal(r.ok, true)
    assert.equal(r.value.length, 2)
    // 第一遍来自盘上的旧格式（0），第二遍来自 verifyMigrated 读回的新文件（目标版本）
    assert.deepEqual(
      froms,
      [SCHEMA_LEGACY, SCHEMA_CURRENT],
      `migrate 的调用序列变了：${froms.join(' → ')}。` +
        '第二遍的 from 必须是目标版本，否则「加密型迁移」会被密封两次（enc:enc:…）'
    )
    // 幂等：同一个 store 再读一次，不该再迁移、也不该再写
    const writes = store.version
    froms.length = 0
    store.readResult()
    assert.equal(store.version, writes, '第二次读触发了写入 —— 迁移不幂等')
    assert.deepEqual(froms, [], '第二次读又调了 migrate —— 缓存没命中')
  } finally {
    box.cleanup()
  }
})

test('读路径绝不移除文件（用户只是想看一眼，数据不能没了）', () => {
  const box = sandbox()
  try {
    // 损坏文件 + 连续多次读：quarantine 只做 copy-aside，原文件必须一直留在原路径。
    // 旧实现是 `renameSync` 把坏文件挪走 —— 挪走之后下一次读走「文件不存在」分支，
    // 又把 fallback 写回去，于是「看一眼」这个动作把数据彻底变成了空列表。
    const broken = '[{"id":"prf_aaa","seed":"' + SEED_A + '"'
    writeFileSync(box.file, broken, 'utf8')

    const store = profilesStore(box.file)
    for (let i = 0; i < 3; i += 1) {
      assert.equal(store.readResult().ok, false, `第 ${String(i + 1)} 次读没判成损坏`)
      assert.ok(box.names().includes('profiles.json'), `第 ${String(i + 1)} 次读之后原文件不见了`)
      assert.equal(box.read(), broken, `第 ${String(i + 1)} 次读之后原文件被改动了`)
    }

    // 重复读不该重复堆备份：同一种失败只留一份
    assert.equal(
      box.names().filter((n) => n.includes('.corrupt-')).length,
      1,
      '重复读堆出了多份 .corrupt 备份：' + box.names().join(', ')
    )
  } finally {
    box.cleanup()
  }
})
