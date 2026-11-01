/**
 * 单文件 JSON 持久化引擎 + 落盘格式契约。
 *
 * 为什么引擎和「信封 / 版本 / 形状校验」放在同一个文件里：这个模块必须**零相对依赖**，
 * 才能被 `tests/` 直接用 `node --experimental-strip-types` 加载 —— `db.ts` 静态
 * `import { app } from 'electron'`，在纯 Node 里连模块都求值不了（见 evict.ts 的同款说明）。
 * 一旦这里写成 `import { … } from './schema'`，测试就又跑不起来了。
 *
 * 三条不变量，按重要性排序：
 *
 * 1. **读绝不毁数据。** 解析 / 校验 / 版本任何一步失败，都不许把 fallback 写回磁盘。
 *    原文件原地不动（只额外复制一份 `.corrupt-*` 备份），然后进入「损坏」状态。
 *    历史教训：旧实现在这里 rename 掉坏文件 + 写入 `[]`，于是「格式改错」不是报错，
 *    而是静默清空全部环境 —— 用户下次打开只看到一个空列表，什么提示都没有。
 * 2. **写必须 fail-closed。** 只要 store 已被判定损坏，`write` / `update` 一律抛错，
 *    绝不覆盖。宁可让用户看到一条明确的错误，也不能让他以为「数据没了」。
 * 3. **版本只前进。** 读到比本版本更高的 schema 要报错，不能当空数据 ——
 *    那是「用旧版应用打开新版数据」，静默降级等于把新版数据整份覆盖掉。
 *
 * 为什么用信封（`{ schema, data }`）而不是旁挂的 `xxx.schema.json`：
 * 旁挂文件要求「两个文件同时更新」，而原子写只保证单次 rename 的原子性。
 * 断电落在两次 rename 之间，就会出现「版本号说 schema 1、内容还是 schema 0」
 * 这种自相矛盾的状态 —— 那时你只能选择相信其中一个，等于没解决问题。
 * 信封把版本号和内容放进同一次 rename，原子性由 tmp→rename 天然保证。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

// 只做类型标注，运行时会被完全擦除 —— 这是本文件保持零相对依赖的前提
import type { StoredProfile } from '@shared/types'

/* ────────────────────────────── 版本 ────────────────────────────── */

/** 旧格式：文件里是裸值（裸数组 / 裸对象），没有版本号 */
export const SCHEMA_LEGACY = 0

/** 当前格式：`{ schema, data }` 信封，profile.seed 仍是 32 位小写 hex 明文 */
export const SCHEMA_CURRENT = 1

/**
 * seed 变成密封 blob 之后的版本（见 seedForm / seed-seal.ts）。
 *
 * 只给 profiles 显式指定，**不要抬 SCHEMA_CURRENT**：那是所有 store 的默认 target，
 * 抬了会让 settings / tasks / proxies / audit / history 全部跟着白迁一轮，
 * 多出一堆 `.schema1-*` 备份。每个文件各自记自己的版本号，混版本完全正常。
 */
export const SCHEMA_SEALED = 2

export interface Envelope<T> {
  schema: number
  data: T
}

/**
 * 失败分类：决定日志里怎么说、以及调用方该怎么补救。
 *
 * `io` = 文件状态读不到（权限 / 被占用 / 句柄耗尽），和数据本身是否完好无关 ——
 * 区分开是为了让日志和 `corruption.kind` 不会把「杀软正扫着这个文件」说成
 * 「你的数据坏了」。
 *
 * `crypto` = 格式对、但解不开（换机器 / 换系统账户 / 密文被截断）。和数据完好与否
 * 也无关：文件一个字节都没坏，是**钥匙换了**。这一档必须和 `shape` 分开，否则
 * 日志会把「你拷了数据目录到另一台机器」说成「你的数据坏了」，而补救动作完全不同
 * （前者是回原机器/回原账户，后者是修文件）。
 */
export type CorruptKind = 'parse' | 'shape' | 'version' | 'io' | 'crypto'

/**
 * 数据文件不可用。
 *
 * 刻意做成 Error 子类而不是返回码：写路径必须让它一路冒到 IPC 层
 * （`handlers.ts` 的 `handle()` 会包成 `{ok:false,error}`，渲染层弹 toast），
 * 读路径则由 store 自己吞掉降级 —— 但降级这件事会记在 `corruption` 上。
 */
export class StoreCorruptError extends Error {
  readonly kind: CorruptKind
  readonly file: string
  readonly detail: string

  constructor(kind: CorruptKind, file: string, detail: string) {
    // 文案要区分三种「不可用」，因为补救动作完全不同：
    //   io     → 数据很可能完好，该去关掉占用文件的程序
    //   crypto → 文件没坏，是密钥对不上（换了机器/账户）
    //   其余   → 内容确实坏了
    // 说混了会把人引去做无效操作。这条 message 会原样穿过 AuditUnavailableError
    // 透给用户，所以措辞要准。
    const label =
      kind === 'io' ? '数据文件不可读' : kind === 'crypto' ? '数据文件解不开' : '数据文件损坏'
    super(`${label}（${kind}）：${file} —— ${detail}`)
    this.name = 'StoreCorruptError'
    this.kind = kind
    this.file = file
    this.detail = detail
  }
}

/* ────────────────────────────── 小工具 ────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `数组（${value.length} 项）`
  return typeof value
}

/**
 * 报错时只说形状，不打印值本身。
 *
 * seed 是「这台机器上某个身份」的派生根：写进日志就等于写进用户会贴到
 * issue 里的文本。长度 + 形态足够定位问题，值本身不需要。
 */
function describeShape(value: unknown): string {
  if (typeof value !== 'string') return `实际类型 ${describeType(value)}`
  return `实际长度 ${String(value.length)}`
}

/**
 * 只有 ENOENT 才算「文件不存在」。
 *
 * 单独抽成导出函数，是因为这条判断是「读不毁数据」那条不变量的**分界点**，
 * 而 EACCES / EBUSY / EMFILE 在 CI 和开发机上都没法可靠复现 —— 抽出来才能
 * 用纯函数把它们钉进测试（见 tests/store-schema.test.ts）。
 *
 * Windows 上尤其要注意：这个平台上 libuv 会把不少路径解析失败都归一成 ENOENT，
 * 所以「在本机能跑通」不能证明分类是对的。生产环境里真正会遇到的
 * EACCES/EBUSY 恰恰来自杀软扫描、Everything 之类的索引服务、备份软件持句柄。
 */
export function isMissingFileError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT'
}

/**
 * 只有「真的不存在」才返回 null。
 *
 * 这里踩过一次：原实现是 `catch { return null }`，于是 `EACCES` / `EBUSY` /
 * `EMFILE` 全都被当成「文件不存在」，然后走「首次运行」分支把 `[]` 写回磁盘 ——
 * 和「格式改错就静默清空」是同一类 bug，只是触发条件更窄，而且连
 * `.corrupt-*` 备份都不会留（根本没进 quarantine）。
 *
 * **读不到 ≠ 不存在。** 前者必须一路冒到 quarantine('io') / 拒绝写入。
 */
function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch (err) {
    if (isMissingFileError(err)) return null
    throw err
  }
}

/**
 * 拿不到状态也不该阻断隔离和收尾的版本。
 *
 * 只在两处用：`quarantine` 里取 mtime（拿不到就不做「文件有没有变过」的判据，
 * 但绝不能因为拿不到 mtime 就放弃隔离），以及 `persist` 收尾时取 mtime
 * （写入已经成功了，这时再抛会把一次成功的写报成失败）。
 */
function statQuietly(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

/** store 对外只给快照，调用方随便改都不会污染内存缓存 */
function clone<T>(value: T): T {
  return structuredClone(value)
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/* ──────────────────────────── 信封编解码 ──────────────────────────── */

export interface Decoded {
  schema: number
  data: unknown
}

/**
 * 把盘上读到的东西拆成「版本 + 内容」。
 *
 * 认不出信封一律按 schema 0（裸格式）处理 —— 旧版本的 profiles.json 就是裸数组，
 * settings.json 是裸对象，两者都必须能继续读出来。反过来，只要出现
 * `{ schema: <数字>, data: … }` 的形状就按信封解释。
 *
 * **维护约束（不是「现在不会发生」的断言）**：这条探测依赖「裸格式的数据里
 * 不会同时出现 `schema`(number) 和 `data` 两个字段」。目前每个 store 的数据都
 * 满足，但这是**当下的事实，不是永久的保证** —— 哪天某个 store 的裸格式要加
 * `schema`/`data` 字段，探测就会误判。所以规则是：
 *
 *   若某个 store 的裸格式可能含 `schema` + `data`，该 store 必须显式传入
 *   `JsonStoreOptions.envelope = false`，关掉信封探测，不要指望这里能猜对。
 *
 * 写成「将来必须做什么」而不是「将来不会发生什么」，是因为这一轮里已经有好几次
 * 把「某个时刻的注释」当成了「当前的事实」—— 注释会过期，约束不会。
 */
export function decodeEnvelope(raw: unknown): Decoded {
  if (isRecord(raw) && typeof raw['schema'] === 'number' && 'data' in raw) {
    const schema = raw['schema']
    if (!Number.isInteger(schema) || schema < 0) {
      throw new Error(`信封里的 schema 不是非负整数：${String(schema)}`)
    }
    return { schema, data: raw['data'] }
  }
  return { schema: SCHEMA_LEGACY, data: raw }
}

export function encodeEnvelope<T>(schema: number, data: T): Envelope<T> {
  return { schema, data }
}

/**
 * 拒绝「降级读」。
 *
 * 用户装了新版、写了几份 schema 2 的数据，又回退到旧版应用 —— 旧版如果不认
 * schema 2，就会把它当成损坏/空数据，然后下一次写入把新版数据覆盖掉。
 * 报错虽然难看，但数据还在；静默继续则一定丢。
 *
 * `hint` 由调用方给：同样是「文件版本比本版本高」，原因可能完全不同 ——
 * 「用旧版应用打开新版数据」（去升级应用）和「本机加密后端不可用所以只敢写
 * schema 1」（去修 keyring）补救动作相反。把后者说成前者，用户会去做一件没用的事。
 * 引擎不认识业务语义，所以只留一个注入口，不自己猜。
 */
export function assertSupportedSchema(
  found: number,
  target: number,
  file: string,
  hint?: string | null
): void {
  if (found > target) {
    throw new StoreCorruptError(
      'version',
      file,
      hint ??
        `文件 schema=${String(found)} 高于本版本支持的 ${String(target)}；` +
          '这是「用旧版应用打开新版数据」。拒绝读取而不是当作空数据：' +
          '一旦按空数据继续，下一次写入就会把新版数据整份覆盖掉。请升级到新版再打开。'
    )
  }
}

/* ────────────────────────── seed 形态（密封） ────────────────────────── */

/**
 * 密封形态前缀。**唯一来源**。
 *
 * 这个字符串同时出现在四个地方，必须完全一致：
 *   1. 这里（磁盘格式契约）
 *   2. `seed-seal.ts`（从这里 import，不自己写）
 *   3. `settings.ts` 的 `ENC_PREFIX`（apiKey 用同一个前缀）
 *   4. `tools/verify-seed-at-rest.mjs` 的 `SEALED_PREFIX`（`.mjs` 引不到 TS，只能重复）
 *
 * 放在这个零依赖文件里，是因为 `seed-seal.ts` 依赖 electron 而这里不依赖 ——
 * 方向只能是「有依赖的引用无依赖的」。
 */
export const SEALED_PREFIX = 'enc:'

/** deriveSeed() 的产物：HKDF 32 字节取前 32 个 hex 字符 */
const PLAIN_SEED_RE = /^[0-9a-f]{32}$/

/** schema 2 的 seed：`enc:` + base64（DPAPI 密文） */
const SEALED_SEED_RE = /^enc:[A-Za-z0-9+/]+={0,2}$/

// 前缀和正则必须同步。少了这条断言，改了 SEALED_PREFIX 而忘了改正则，
// 表现是「加密明明成功了，下次启动却全量判形状错 → 整个环境列表被隔离」。
if (!SEALED_SEED_RE.source.startsWith('^' + SEALED_PREFIX)) {
  throw new Error('SEALED_SEED_RE 与 SEALED_PREFIX 不一致：改前缀必须同时改正则')
}

export type SeedForm = 'plain-hex' | 'sealed-blob'

/**
 * seed 的落盘形态**由 schema 决定**，而不是靠「是不是字符串」猜。
 *
 * 为什么不能写成 `typeof seed === 'string'`：那样一段被写坏的值（空串、半截 hex、
 * 被截断的 base64、甚至一句错误提示）会**静默通过**校验，然后被拿去生成一套
 * 「看起来完全正常」的指纹 —— 用户不会收到任何提示，只会在某天发现自己在
 * 某个站点的身份悄悄变了，而且无法回溯是哪一步坏的。
 *
 * 按 schema 分形态之后，每个版本只有一种合法形态，写坏就是写坏，当场报错。
 * schema 2 起是密封形态，加解密在 `seed-seal.ts`（那边依赖 electron，这里不能依赖）。
 */
export function seedForm(schema: number): SeedForm {
  return schema >= SCHEMA_SEALED ? 'sealed-blob' : 'plain-hex'
}

export function isValidSeed(seed: unknown, schema: number): boolean {
  if (typeof seed !== 'string') return false
  return seedForm(schema) === 'plain-hex' ? PLAIN_SEED_RE.test(seed) : SEALED_SEED_RE.test(seed)
}

/* ──────────────────────────── 形状校验 ──────────────────────────── */

/**
 * profiles.json 的形状校验。
 *
 * **任何一条不合格就整体判定为损坏**，而不是 `filter` 掉坏的那条。
 * 为什么：filter 的语义是「悄悄丢掉」，而丢掉之后下一次写入就把丢掉的结果
 * 落盘了 —— 用户看到的是「我的某个环境不见了」，没有任何报错。
 * 宁可整体拒绝 + 保留原文件 + 明确报错，让用户去修那一条。
 *
 * 代价要说清楚：一条坏记录会让整个环境列表不可用。所以错误信息必须
 * 带上是第几条、哪个字段坏了 —— 否则用户只能看到一句「文件损坏」。
 */
export function validateProfiles(
  data: unknown,
  schema: number,
  file: string
): StoredProfile[] {
  if (!Array.isArray(data)) {
    throw new StoreCorruptError('shape', file, `期望数组，实际是 ${describeType(data)}`)
  }

  const form = seedForm(schema)
  const out: StoredProfile[] = []

  for (let i = 0; i < data.length; i += 1) {
    const item: unknown = data[i]
    const where = `第 ${String(i + 1)} 条`

    if (!isRecord(item)) {
      throw new StoreCorruptError('shape', file, `${where}不是对象（${describeType(item)}）`)
    }
    const id = item['id']
    if (typeof id !== 'string' || id.length === 0) {
      throw new StoreCorruptError('shape', file, `${where}缺 id（${describeShape(id)}）`)
    }
    if (!isValidSeed(item['seed'], schema)) {
      throw new StoreCorruptError(
        'shape',
        file,
        `${where}（id=${id}）的 seed 不符合 schema ${String(schema)} 要求的 ${form} 形态：` +
          describeShape(item['seed'])
      )
    }
    if (!isRecord(item['fingerprint'])) {
      throw new StoreCorruptError(
        'shape',
        file,
        `${where}（id=${id}）缺 fingerprint（${describeType(item['fingerprint'])}）`
      )
    }

    /* 老盘文件里没有 `allowUnmaskedL2`（这一版才加的字段）。
     *
     * 在这里补 `false` 而不是把它声明成可选：可选布尔会让每个读点都要自己
     * 回答「没这个字段算什么」，而漏问一次就是「默认豁免」—— 一个默认开着的
     * 安全开关比没有这个开关更坏。归一化只做一次，做在**唯一的读盘入口**上。
     *
     * 只认字面 `true`：`'false'` / `1` / `{}` 一律当 false。落盘文件是可手改的，
     * 而「真值判断」在这里必须比 TS 更严。 */
    out.push({
      ...(item as unknown as StoredProfile),
      allowUnmaskedL2: item['allowUnmaskedL2'] === true
    })
  }

  return out
}

/**
 * 通用数组校验：`CollectionStore` 没有逐条形状约定，但「文件里必须是数组」
 * 这条必须成立 —— 否则 `list()` 里那句 `.slice()` 会抛 TypeError，
 * 变成一条完全看不出根因的崩溃。
 */
export function validateArray<T>(data: unknown, file: string): T[] {
  if (!Array.isArray(data)) {
    throw new StoreCorruptError('shape', file, `期望数组，实际是 ${describeType(data)}`)
  }
  return data as T[]
}

/* ──────────────────────────── 读写引擎 ──────────────────────────── */

/**
 * 迁移函数。
 *
 * 签名里带 `schema` 是刻意为之：同一个 store 将来会有多种落盘形态，
 * 迁移必须能按来源版本分支（例如 schema 2 起 seed 是加密 blob，
 * 从 1 升 2 时要重新封一遍）。带 `file` 是为了让校验函数能抛出
 * 一个指明「哪个文件坏了」的错误。
 */
export type Migrate<T> = (data: unknown, schema: number, file: string) => T

export interface JsonStoreOptions<T = unknown> {
  /**
   * 本 store 期望写出的 schema 版本，默认 SCHEMA_CURRENT。
   *
   * 允许传函数是为了**延迟到真正用到的那一刻**再决定版本。典型场景：seed 密封依赖
   * `safeStorage`，而它在 Linux 上要等 app ready 之后才初始化 keyring —— 在模块
   * 加载期取一次值，会永久锁在「不可用」上，而且是静默的（功能整个不生效）。
   * 传函数则每次按当下能力算，能力变了下一次读写就跟上。
   */
  schema?: number | (() => number)
  /**
   * 是否使用 `{ schema, data }` 信封，默认 true。
   *
   * 关掉它的唯一理由是「这个 store 的裸格式可能含 schema + data 两个字段」，
   * 那时信封探测会误判（见 decodeEnvelope 的维护约束）。关掉之后既不探测也不
   * 包装、也不做版本迁移 —— 等于完全回到 schema 0 的裸格式。
   */
  envelope?: boolean
  /**
   * 内存形态 → 盘上形态。**在 persist 里、编码信封之前调用**。
   *
   * 存在的理由：内存里希望拿到可直接用的值（例如 seed 是明文 hex，能直接喂给
   * `dispatchScript`），而盘上希望是密封的。这个差异必须收敛在一个地方，
   * 否则「哪一层负责密封」会被每个调用方各答一次，答案迟早不一致。
   *
   * 缓存里存的始终是**内存形态**（`data`），不是这里的返回值。
   */
  serialize?: (data: T, schema: number) => T
  /**
   * 用**目标 schema** 校验即将写出的数据；不合格就抛，写不出去。
   *
   * 这不是「多一层保险」，而是「迁移不会自己把自己隔离掉」的唯一结构性保证：
   * 一次只换了信封、没换内容形态的迁移，写出去的是「版本号说 2、seed 还是明文」，
   * 下一次读会被 `seedForm(2)` 判成形状错 → quarantine → 界面空列表。
   * 有了这一步，同样的错误会在**写的时候**当场失败，文件停在旧版本，数据完好。
   */
  verify?: (data: T, schema: number, file: string) => void
  /**
   * 「文件版本比本版本高」时给一句贴合业务原因的说明，覆盖默认的「请升级应用」。
   *
   * 存在的唯一理由：同一个 `version` 分类可能有两种完全相反的成因。返回 `null`
   * 表示「没有额外信息」，用默认文案。
   */
  explainSchemaMismatch?: (found: number, target: number) => string | null
}

/** 一次损坏的完整快照，供日志 / 将来的 UI 横幅使用 */
export interface CorruptInfo {
  kind: CorruptKind
  file: string
  detail: string
  /** 检测到损坏时留下的字节级副本；备份失败为 null（原文件同样没被改动） */
  backupPath: string | null
  at: number
}

export interface StoreRead<T> {
  /** true = 读到的是盘上的真实内容；false = 降级值，且 `corruption` 非空 */
  ok: boolean
  value: T
  corruption: CorruptInfo | null
}

export class JsonStore<T> {
  private readonly file: string
  private readonly fallback: () => T
  private readonly migrate: Migrate<T> | undefined
  private readonly schemaOf: () => number
  private readonly envelope: boolean
  private readonly serialize: ((data: T, schema: number) => T) | undefined
  private readonly verify: ((data: T, schema: number, file: string) => void) | undefined
  private readonly explainSchemaMismatch:
    | ((found: number, target: number) => string | null)
    | undefined

  private cache: T | null = null
  private cachedMtime = 0
  private writes = 0

  private corrupt: CorruptInfo | null = null
  /** 检测到损坏那一刻的文件 mtime：文件被改动过就重新判断，实现「修好即恢复」 */
  private corruptMtime = 0

  constructor(file: string, fallback: () => T, migrate?: Migrate<T>, options: JsonStoreOptions<T> = {}) {
    this.file = file
    this.fallback = fallback
    this.migrate = migrate
    const target = options.schema ?? SCHEMA_CURRENT
    this.schemaOf = typeof target === 'function' ? target : (): number => target
    this.envelope = options.envelope ?? true
    this.serialize = options.serialize
    this.verify = options.verify
    this.explainSchemaMismatch = options.explainSchemaMismatch
  }

  /** 目标版本。**每次现算**：能力可能变（见 `JsonStoreOptions.schema`） */
  private get schema(): number {
    return this.schemaOf()
  }

  /**
   * 写次数计数。UI 可以据此判断「有没有变过」，比对比整个对象便宜。
   *
   * 注意这**不是** schema 版本 —— 版本是 `schemaVersion`。两者混用的后果是
   * 「写了一次就以为格式升级过了」，于是迁移被跳过，旧格式被当成新格式读。
   */
  get version(): number {
    return this.writes
  }

  /** 本 store 写出去的信封版本（关掉信封的 store 恒为 schema 0） */
  get schemaVersion(): number {
    return this.envelope ? this.schema : SCHEMA_LEGACY
  }

  /** 非 null 表示已判定损坏：读会降级、写会被拒绝 */
  get corruption(): CorruptInfo | null {
    return this.corrupt
  }

  /**
   * 落盘文件的绝对路径。
   *
   * 给健康状态和备份脚本用：数据目录里 `.json` 和无后缀的文件是混着的
   * （`profiles.json` / `audit`），这是历史包袱，**不改文件名**（改了会让已有
   * 用户的数据变成孤儿），所以唯一正确的做法是把真实路径报出去，让消费方
   * 去枚举，而不是让它们猜命名规则。
   */
  get filePath(): string {
    return this.file
  }

  read(): T {
    return this.readResult().value
  }

  /**
   * 带状态地读。
   *
   * `read()` 只是它丢掉状态的那一层 —— 保留 `readResult()` 是为了让将来
   * 想显式处理损坏的调用方（例如控制台的健康横幅）不必去猜。
   */
  readResult(): StoreRead<T> {
    // 目标版本只取一次：这次读里所有「要不要迁移 / 迁移成什么」的判断必须基于同一个值。
    //
    // 这句话原来是注释里的一句愿望 —— `persist()` 内部自己又取了一次 `this.schema`，
    // 而 `schema` 是可以传函数的（`targetSchema()` 走 `safeStorage.isEncryptionAvailable()`）。
    // 只要两次取值不同，就会出现：按 2 判断要迁移 → persist 按 1 写出去 →
    // `verifyMigrated` 拿 2 去比对刚写的 1 → 判「写回的文件 schema=1，期望 2」→
    // quarantine → `read()` 返回 fallback → **界面空列表**。实测复现过。
    //
    // 所以现在把 target 一路传下去（persist / reset 都收这个参数），
    // 一次公开操作 = 一个 target，不存在「判断用 A、写入用 B」。
    const target = this.schema
    let st: fs.Stats | null
    try {
      st = statOrNull(this.file)
    } catch (err) {
      // 读不到状态（权限 / 被占用 / 句柄耗尽）≠ 文件不存在。
      // 绝不能因此走「首次运行」把 fallback 写回去 —— 那正是这个文件要防的事。
      return this.quarantine('io', '无法读取文件状态：' + describe(err))
    }

    if (this.corrupt !== null) {
      // 文件没被动过 → 继续降级，不重复备份、不重复刷日志
      if (st !== null && st.mtimeMs === this.corruptMtime) return this.degraded()
      // 文件被删掉（用户想重来）或被改动过（可能已经修好）→ 清 latch 重新判断。
      // 少了这一条，「删掉坏文件」这个最直观的补救动作会被 latch 挡在外面。
      this.clearCorrupt()
    }

    // 命中缓存：文件 mtime 没动过就直接返回
    if (this.cache !== null && st !== null && st.mtimeMs === this.cachedMtime) {
      return { ok: true, value: this.cache, corruption: null }
    }

    // 文件不存在 = 首次运行，或用户主动删掉了。
    // 这是**唯一**允许把 fallback 写回磁盘的路径 —— 所以它前面那道 statOrNull
    // 必须只把 ENOENT 当成「不存在」，其余 errno 一律冒到上面的 quarantine('io')。
    if (st === null) {
      return { ok: true, value: this.reset(this.fallback(), target), corruption: null }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown
    } catch (err) {
      return this.quarantine('parse', 'JSON 解析失败：' + describe(err))
    }

    let decoded: Decoded
    try {
      decoded = this.envelope ? decodeEnvelope(parsed) : { schema: SCHEMA_LEGACY, data: parsed }
      // 关掉信封的 store 没有版本概念，不做降级读判断
      if (this.envelope) {
        assertSupportedSchema(
          decoded.schema,
          target,
          this.file,
          this.explainSchemaMismatch?.(decoded.schema, target) ?? null
        )
      }
    } catch (err) {
      const kind = err instanceof StoreCorruptError ? err.kind : 'version'
      return this.quarantine(kind, describe(err))
    }

    let value: T
    try {
      value =
        this.migrate === undefined
          ? (decoded.data as T)
          : this.migrate(decoded.data, decoded.schema, this.file)
    } catch (err) {
      // 迁移 / 校验自己炸了也按损坏处理 —— 但绝不写盘。
      // 分类要尊重错误自带的 kind：`crypto`（钥匙换了）和 `shape`（内容写坏了）
      // 的补救动作完全不同，塌成 shape 会让日志把人指向错误的修法。
      return this.quarantine(
        err instanceof StoreCorruptError ? err.kind : 'shape',
        describe(err)
      )
    }

    // 旧格式 → 新格式：先把原字节备份下来，再原子写回信封。
    // 备份失败就放弃迁移：没有退路的情况下不改写用户的文件。
    //
    // 这是**第一段**。若目标涉及密封（`target >= SCHEMA_SEALED`）且迁移成功、读回校验
    // 也通过，`verifyMigrated` 之后还会用主文件字节把这份备份重写一遍，把明文 seed 消掉
    // （见 resealBackup）。所以「备份里还有没有明文」取决于此刻走到哪一段，不能只看这里。
    if (this.envelope && decoded.schema < target) {
      let backupPath: string | null = null
      try {
        backupPath = this.backupBeforeMigrate(decoded.schema)
        // 传 target：persist 内部**不许**再取一次 `this.schema`。
        // 取两次就可能出现「按 2 决定迁移、按 1 写出去」，然后 verifyMigrated 判
        // 「写回的文件 schema=1，期望 2」→ quarantine → 空列表。实测复现过。
        this.persist(value, target)
      } catch (err) {
        // 迁移没成功。备份要不要留，看它是否**携带主文件没有的信息** ——
        // 不是凭「备份一律保留」或「备份一律删掉」的先验决定。
        // 判据见 dropRedundantBackup()：persist 是原子写，抛错时主文件要么没动
        // （此时备份是纯副本，留着只会在每次启动都多堆一份 —— 而「只读盘 / 磁盘满」
        // 恰恰是会反复失败、反复重试的那种情形），要么已经是新内容（此时备份是
        // 唯一的旧格式副本，必须留）。
        if (backupPath !== null) this.dropRedundantBackup(backupPath)
        // 写回失败（磁盘满 / 只读盘 / 权限）：文件仍然是旧格式，**内容完好**。
        // 这不属于「数据损坏」，所以不能 latch 成损坏态 —— 只在内存里用新值，
        // 下一次进程启动或下一次 write 会自然把迁移补完。
        console.warn('[store] 迁移写回失败，本次仅在内存中升级：' + describe(err))
        this.cache = value
        this.cachedMtime = st.mtimeMs
        return { ok: true, value, corruption: null }
      }

      // 写成功 ≠ 下次读得回来。在收工之前，按**目标版本**把刚写出去的文件真读一遍。
      // 这是「迁移不会自己把自己隔离掉」的实证：verify 保证的是「写出去的那一刻
      // 形状对」，这一步保证的是「从盘上读回来的那一刻仍然对」—— 两者之间还隔着
      // 序列化、serialize、DPAPI 往返。
      const round = this.verifyMigrated(value, target)
      if (!round.ok) {
        // 读不回来 = 下次启动必然 quarantine。现在就把退路保住并停下，
        // 而不是让用户明天开机看到一个空列表。备份**不删**。
        return this.quarantine('shape', '迁移后无法按目标 schema 读回：' + round.detail)
      }
      if (round.contentMismatch) {
        // 能读回来但内容对不上：数据没丢（原文件与备份都在），但这次迁移的结果不可信。
        // 只告警不隔离 —— 隔离会拦住用户的写入，而这里没有证据表明数据坏了。
        //
        // 这一档**不重写备份**：主文件此刻的形态本身就可疑，拿它去覆盖那份已知良好的
        // 字节副本，等于把唯一的干净退路换成一份没通过校验的东西。
        console.warn(
          '[store] 迁移后读回的内容与写入的不一致（字段可能被丢弃或改写）：' + this.file
        )
      } else if (backupPath !== null && target >= SCHEMA_SEALED) {
        // 第二段：迁移成功且读回验证通过之后，目标涉及密封就把备份按密封格式重写，
        // 把备份里的明文 seed 消掉。见 resealBackup()。
        this.resealBackup(backupPath)
      }
      return { ok: true, value: this.cache as T, corruption: null }
    }

    this.cache = value
    this.cachedMtime = st.mtimeMs
    return { ok: true, value, corruption: null }
  }

  write(data: T): void {
    this.ensureWritable()
    // 单次操作一个 target：见 readResult 里那段注释
    this.persist(data, this.schema)
  }

  /** 读 → 改 → 写。fn 拿到的是副本，可以随意原地改 */
  update(fn: (draft: T) => void): T {
    // 顺序很关键：先 read 一次，让「盘上的损坏」有机会被检测出来，再判可写。
    // 反过来写（先判可写再 read）的话，一个还没读过的损坏文件会被当成空数据，
    // 然后 fn 在空数组上改两下就被 persist 覆盖掉 —— 又回到静默清空。
    const draft = clone(this.read())
    this.ensureWritable()
    fn(draft)
    this.ensureWritable()
    // 同 write()：一次 update 只认一个 target。`read()` 内部已经按它自己的 target
    // 校验/迁移过了，这里再取一次就可能和它不一致（例如密封能力在两次调用之间变了）。
    this.persist(draft, this.schema)
    return draft
  }

  /* ───────────────────────── 内部实现 ───────────────────────── */

  private degraded(): StoreRead<T> {
    return { ok: false, value: this.fallback(), corruption: this.corrupt }
  }

  private clearCorrupt(): void {
    this.corrupt = null
    this.corruptMtime = 0
    this.cache = null
    this.cachedMtime = 0
  }

  /**
   * 判定损坏：留一份字节级备份，进入 latch 状态，**不写任何东西**。
   *
   * 和旧实现的关键差别：
   * - 旧：`renameSync(file, file + '.corrupt-…')` 之后 `persist(fallback())`。
   *   原文件被挪走 → 下一次读走「文件不存在」分支 → 又一次写 fallback。
   *   整个过程没有任何返回值或异常告诉调用方「你的数据没了」。
   * - 新：`copyFileSync` 只做副本，原文件留在原地 → 每次启动都能重新发现损坏，
   *   不会因为「已经自愈过一次」而彻底静默。
   */
  private quarantine(kind: CorruptKind, detail: string): StoreRead<T> {
    // 同一种失败重复发生（例如权限一直不对、杀软一直占着句柄）：
    // 不要每次都复制一份备份 + 刷一遍日志 —— 那会在几秒内把磁盘塞满、把控制台刷爆。
    if (this.corrupt !== null && this.corrupt.kind === kind && this.corrupt.detail === detail) {
      return this.degraded()
    }

    // 用不抛的版本：拿不到 mtime 只影响「文件有没有变过」的判据，
    // 不该因为拿不到 mtime 就放弃隔离（那会退回「读不到 = 不存在」的老坑）。
    const st = statQuietly(this.file)
    const mtime = st === null ? 0 : st.mtimeMs

    const backupPath = this.copyAside()
    this.corrupt = { kind, file: this.file, detail, backupPath, at: Date.now() }
    this.corruptMtime = mtime
    this.cache = null
    this.cachedMtime = 0

    // 这里必须够吵：读路径的调用方拿到的只是一个空列表，它没有能力把这件事
    // 告诉用户，所以唯一的出口就是这条日志。
    console.error(
      '[store] 数据文件不可用，已停止读写并保留原文件\n' +
        `  文件：${this.file}\n` +
        `  类型：${kind}${kind === 'io' ? '（文件状态读不到，数据本身未必有问题）' : ''}\n` +
        `  原因：${detail}\n` +
        `  备份：${backupPath ?? '未生成（原文件未被改动）'}\n` +
        '  已拒绝所有写入以免覆盖数据；修好原文件（或删掉它重来）后重启即可恢复。'
    )

    return this.degraded()
  }

  /** 字节级副本。**不移动原文件**：日志和用户都要能指着那个真实路径。 */
  private copyAside(): string | null {
    const dest = this.file + '.corrupt-' + stamp()
    try {
      fs.copyFileSync(this.file, dest)
      return dest
    } catch {
      return null
    }
  }

  /**
   * 迁移写回前的第一段：**字节复制**。
   *
   * 为什么必须是字节复制，而不是「按新格式重新序列化」：
   * 这份备份唯一的用途是「迁移代码本身有 bug 时能退回去」。而重新序列化意味着
   * **备份由同一份可能出 bug 的代码生成** —— 序列化写错了，主文件和备份一起错，
   * 退回去还是错的。一个由被测代码生成的备份不构成备份。
   *
   * 所以顺序是「先留独立工件，再冒险改主文件」。明文 seed 因此会在这份副本里多躺
   * 几十毫秒（到第二段为止），这是刻意的取舍：**先有退路，再谈擦除**。
   * 第二段见 `resealBackup()`。
   *
   * 命名用 `.preupgrade<from>-` 而不是 `.schema<from>-`：它记录的是**源** schema
   * （这份副本能退回哪个版本），而不是「一份 schema N 的正式数据」。旧名字会让人
   * 在手工恢复时把它当成本版本的数据直接拷回去。
   */
  private backupBeforeMigrate(from: number): string {
    const dest = this.file + '.preupgrade' + String(from) + '-' + stamp()
    fs.copyFileSync(this.file, dest)
    return dest
  }

  /**
   * 第二段：迁移成功且 `verifyMigrated` 通过之后，把备份按**密封格式**重写一遍。
   *
   * 为什么这时可以重写：新代码刚刚证明了自己能从盘上读回正确形状，用它已经产出的
   * 工件覆盖备份是安全的；而在此之前，「字节副本」和「没有明文落盘」这两个目标
   * 是互斥的 —— 先满足前者。
   *
   * 为什么复制主文件的字节而不是重新 `serialize` 一遍：
   *   1. 主文件此刻**已被 `verifyMigrated` 逐字段读回验证过**，复制它等于复制一份
   *      已知良好的工件；重新序列化会再跑一遍加密（DPAPI 每次密文都不同），得到
   *      一份没人验证过的新文件 —— 备份的价值就在「已知良好」，不能拿它赌一次
   *      没验证过的写入。
   *   2. 复用同一份字节，天然保证「备份能读回来」这件事和主文件是同一个结论。
   *
   * 先写 tmp 再 rename：`copyFileSync` 直接覆盖目标不是原子的，中途失败会留下一份
   * **截断的备份** —— 那等于用一次「擦除明文」的动作把唯一的退路毁掉。
   *
   * 失败时保持原样（明文）并告警，不重试、不回滚迁移：迁移本身已经成功，为了一份
   * 备份去破坏主文件的成功结果不值得。健康状态会把这份备份标红（`store/health.ts`
   * 扫明文 seed），所以它不是静默的。
   */
  private resealBackup(backupPath: string): void {
    const tmp = backupPath + '.tmp'
    try {
      fs.copyFileSync(this.file, tmp)
      fs.renameSync(tmp, backupPath)
    } catch (err) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* tmp 没建成，或删不掉 —— 两种都不影响主文件 */
      }
      console.warn(
        '[store] 迁移已成功，但备份无法按密封格式重写（该备份里可能仍有明文 seed，' +
          '健康状态会标红）：' +
          backupPath +
          ' —— ' +
          describe(err)
      )
    }
  }

  /**
   * 迁移失败时决定那份字节副本要不要留。
   *
   * **只允许在迁移失败路径调用。** 成功路径上备份与主文件**字节相同**（`resealBackup`
   * 就是把主文件复制过去的），拿这个函数去「清理重复文件」会把那份备份当成纯副本删掉
   * —— 而它恰恰是「主文件以后被写坏时唯一一份已知良好的副本」。
   * 从调用点挪到这里看起来像一次无害的重构，实际是删掉唯一的退路。
   *
   * 判据只有一条：**它是否携带主文件没有的信息。**
   * 逐字节比对而不是「按 persist 的原子性推断」—— `persist` 的最后一步 rename
   * 之后还有 `statQuietly` 与 `clone`，后者对不可克隆的值会抛；那种情况下主文件
   * 已经是新内容了，靠推断就会把唯一的旧格式副本删掉。
   *
   * 读不到就**不删**：宁可多留一份，不可少留一份。
   */
  private dropRedundantBackup(backupPath: string): void {
    try {
      const same = fs.readFileSync(backupPath).equals(fs.readFileSync(this.file))
      if (same) {
        fs.unlinkSync(backupPath)
        return
      }
    } catch {
      /* 落下去走「保留」分支 */
    }
    console.warn(
      '[store] 迁移写回失败，保留备份（主文件已被改动，这份是唯一的旧格式副本）：' + backupPath
    )
  }

  /**
   * 把刚写出去的文件按**目标版本**重读一遍。
   *
   * 三档结果，调用方处置不同：
   *   `ok=false`        → 下次启动一定 quarantine，必须现在停手（保留备份，不删）
   *   `contentMismatch` → 读得回来但内容对不上，只告警（数据没丢，没有隔离的理由）
   *   `ok=true` 且不 mismatch → 迁移完成
   *
   * 为什么不复用 `readResult()`：它会命中缓存（盘上 mtime 与 `cachedMtime` 一致），
   * 于是「读回来的其实是内存里那份」，等于什么都没验证。
   */
  private verifyMigrated(
    expected: T,
    target: number
  ): { ok: true; contentMismatch: boolean } | { ok: false; detail: string } {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch (err) {
      return { ok: false, detail: '写回后无法读回：' + describe(err) }
    }

    let decoded: Decoded
    try {
      const parsed: unknown = JSON.parse(raw)
      decoded = this.envelope ? decodeEnvelope(parsed) : { schema: SCHEMA_LEGACY, data: parsed }
    } catch (err) {
      return { ok: false, detail: '写回的文件无法解析：' + describe(err) }
    }
    if (this.envelope && decoded.schema !== target) {
      return {
        ok: false,
        detail: `写回的文件 schema=${String(decoded.schema)}，期望 ${String(target)}`
      }
    }

    let back: T
    try {
      back =
        this.migrate === undefined
          ? (decoded.data as T)
          : this.migrate(decoded.data, decoded.schema, this.file)
    } catch (err) {
      return { ok: false, detail: '按目标版本读回失败：' + describe(err) }
    }

    let mismatch: boolean
    try {
      mismatch = JSON.stringify(back) !== JSON.stringify(expected)
    } catch {
      // 循环引用之类：比不出来就当「不一致」，但这是「比不出来」不是「读不回来」
      mismatch = true
    }
    return { ok: true, contentMismatch: mismatch }
  }

  private toError(): StoreCorruptError {
    const info = this.corrupt
    const detail = info === null ? '未知原因' : info.detail
    const backup = info?.backupPath
    return new StoreCorruptError(
      info?.kind ?? 'shape',
      this.file,
      detail +
        (backup === null || backup === undefined ? '（原文件已保留）' : `（原文件已保留，备份：${backup}）`) +
        '；为避免覆盖数据，本次写入已被拒绝'
    )
  }

  /**
   * 写之前的守门。
   *
   * 不只看 latch，还要看「盘上现在是什么」：如果文件被外部改过（mtime 变了），
   * 缓存就不再可信，必须先重新判一次。少了这一步，一次外部写坏 + 一次
   * `write()` 就能把坏文件覆盖成空数据。
   */
  private ensureWritable(): void {
    if (this.corrupt !== null) throw this.toError()

    let st: fs.Stats | null
    try {
      st = statOrNull(this.file)
    } catch (err) {
      // 确认不了盘上状态就拒绝写。这正是「读不到 ≠ 不存在」要保护的东西：
      // 旧代码在这里会把 EACCES/EBUSY 当成「文件不存在」，然后直接覆盖。
      throw new StoreCorruptError(
        'io',
        this.file,
        '无法读取文件状态，已拒绝写入以免覆盖数据：' + describe(err)
      )
    }

    // 盘上什么都没有：不存在被覆盖的风险
    if (st === null) return
    // 缓存与盘上一致：已经确认可读
    if (this.cache !== null && st.mtimeMs === this.cachedMtime) return

    this.readResult()
    if (this.corrupt !== null) throw this.toError()
  }

  private reset(value: T, target: number): T {
    this.persist(value, target)
    return value
  }

  /**
   * 落盘。
   *
   * `target` **必须由调用方传**，不在这里取 `this.schema`。
   *
   * 原因：`schema` 可以是函数（`profiles.ts` 的 `targetSchema()` 每次现算
   * `safeStorage.isEncryptionAvailable()`）。如果 readResult 按 2 判定「要迁移」、
   * 而 persist 在这里重新取到 1，就会出现「按 2 决定、按 1 写出」——
   * 紧接着 `verifyMigrated` 拿 2 去比对刚写的 1，判「写回的文件 schema=1，期望 2」
   * → quarantine → `read()` 返回 fallback → **界面空列表**。
   * 这不是理论风险：用「第一次返回 2、第二次返回 1」的 schema 函数可以稳定复现，
   * 症状和这一轮要修的那个 bug（升级后环境列表空了）一模一样。
   *
   * 所以规则是：**一次公开操作（read / write / update）= 一个 target**，
   * 在入口取一次，一路传到底。取两次就有一致性问题，而它的表现形式是丢数据。
   */
  private persist(data: T, target: number): void {
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true })

    // 落盘形态在这里定稿。顺序不能反：先 serialize 换成盘上形态，再用**目标 schema**
    // 校验这份即将写出的数据。
    //
    // 少了 verify，一次「只换信封、没换内容形态」的迁移会把「版本号说 2、seed 还是
    // 明文」安静地写出去，而下一次读会被 seedForm(2) 判成形状错 → quarantine →
    // 界面空列表。**不校验的迁移会自己把自己的数据隔离掉**，而症状正好是我们这一轮
    // 在修的那个（用户看到环境列表空了）。
    const out = this.serialize === undefined ? data : this.serialize(data, target)
    if (this.verify !== undefined) this.verify(out, target, this.file)

    const tmp = this.file + '.tmp'
    const payload: unknown = this.envelope ? encodeEnvelope(target, out) : out
    const json = JSON.stringify(payload, null, 2)

    // 先写 tmp 并落盘，再原子替换；顺序不能颠倒
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, json, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, this.file)

    // 收尾取 mtime 用不抛的版本：写入已经成功了，这时再抛会把一次成功的写报成失败。
    // 拿不到就让 cachedMtime 停在 0，下一次读会重新读盘 —— 正确，只是多一次 IO。
    const st = statQuietly(this.file)
    this.cache = clone(data)
    this.cachedMtime = st === null ? 0 : st.mtimeMs
    this.writes += 1
  }
}
