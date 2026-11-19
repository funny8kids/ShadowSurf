/**
 * 环境（Profile）仓库。
 *
 * 一个 Profile = 一个独立的浏览器身份：独立存储分区、独立代理、独立指纹。
 * 这里只管「身份是什么」，不管「怎么把它跑起来」——启动逻辑在 browser 层。
 *
 * 存储实现藏在 JsonStore 后面，将来换 SQLite 时这个类的方法签名不变。
 */

import { createHash, randomInt } from 'node:crypto'
import { PROFILE_COLORS } from '@shared/presets'
import type {
  CloneOptions,
  CreateProfileInput,
  FingerprintConfig,
  MaskLastRecord,
  OSKind,
  Profile,
  StoredProfile
} from '@shared/types'
import { buildFingerprint, deriveSeed } from '@main/core/fingerprint'
import { JsonStore } from './db'
import type { HealthStoreRef } from './health'
import type { CorruptInfo } from './json-file'
import { SCHEMA_CURRENT, SCHEMA_SEALED, seedForm, validateProfiles } from './json-file'

import { openSeed, sealAvailable, sealSeed } from './seed-seal'

/** 去掉了 0/1/i/l/o —— 手抄、念读、日志里肉眼对齐时都不会认错 */
const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'
const ID_LENGTH = 12
const DEFAULT_GROUP = '默认'

/**
 * seedHint 计算缓存。**只存在主进程内存里，不落盘、不出 IPC、不导出。**
 *
 * ── 为什么需要 ──
 * sha256 是一次同步 CPU 计算，而 `list()` 是高频路径（环境页刷新、状态广播、
 * 健康检查、各模块的列表调用），每次都把**所有**环境的 seedHint 重算一遍：
 * 100 个环境约 2.4ms，1000 个约 24ms —— 主进程会被这种「只是刷新一下列表」
 * 的操作反复占住。seed → seedHint 是纯函数（同一个 seed 永远得到同一个值），
 * 缓存不会引入一致性风险；环境被删除/重掷种子后旧 key 只是留在表里，
 * 不会让任何新环境读到错误的值。
 *
 * ── 为什么 key 用种子明文 ──
 * 种子本来就已经以明文形态常驻主进程内存（`StoredProfile` 和 profiles.json
 * 解密后的数组），这张表只是多持有一份字符串引用，没有扩大暴露面。
 * 它不落盘、不经过 IPC、不是导出路径的一部分；渲染层拿到的仍然只有
 * `Profile.seedHint`（8 位哈希），完整种子依旧不出主进程。
 *
 * ── 为什么有上限 ──
 * 长期运行的实例里，regenerate / clone 会不断产生新种子；没有上限的 Map
 * 就是一条缓慢的内存泄漏。Map 的迭代顺序是插入顺序，超限就删最旧的一条
 * （FIFO 足够：这里没有「热点种子」的假设，也不值得为此维护 LRU 链表）。
 */
const SEED_HINT_CACHE_LIMIT = 2048
const seedHintCache = new Map<string, string>()

/**
 * 种子指纹：`sha256(seed)` 前 8 位。
 *
 * 为什么不是「前 8 位种子」：种子是 32 位 hex，前 8 位直接暴露了 1/4 的熵，
 * 而且拿到它的人可以对着字典验证猜测。哈希之后只剩「能不能比对」，不能反推。
 *
 * 为什么需要它：用户要判断「备份恢复后是不是同一个身份」，靠的就是这个值。
 * 完整种子不出主进程（见 `StoredProfile` 的注释），所以这个可比较的短串是必须的。
 */
export function seedHintOf(seed: string): string {
  const cached = seedHintCache.get(seed)
  if (cached !== undefined) return cached

  const hint = createHash('sha256').update(seed).digest('hex').slice(0, 8)
  if (seedHintCache.size >= SEED_HINT_CACHE_LIMIT) {
    // keys().next() 拿到的是最早插入的一条（Map 保持插入顺序）
    const oldest = seedHintCache.keys().next()
    if (!oldest.done) seedHintCache.delete(oldest.value)
  }
  seedHintCache.set(seed, hint)
  return hint
}

/**
 * 落盘形态 → 对外形态。**这是唯一的出口。**
 *
 * 新增任何返回环境数据的通道时，返回值都必须过这里。类型系统只保证
 * 「读 `profile.seed` 会编译失败」，不保证「没人把 StoredProfile 直接 return」
 * （结构化类型对多字段宽容），所以收口靠这个函数 + 结构断言。
 */
export function toPublicProfile(p: StoredProfile): Profile {
  const { seed, ...rest } = p
  return { ...rest, seedHint: seedHintOf(seed) }
}

function deepCopy(p: StoredProfile): StoredProfile {
  return structuredClone(p)
}

/**
 * 是否在回收站里。
 *
 * 只把 `null` / `undefined` 当「未删除」：`deletedAt` 是毫秒时间戳，正常值恒为正，
 * 但盘上的 JSON 可被手改，`0` 也是一个合法时间戳。用真值判断会让一条
 * `deletedAt: 0` 的记录悄悄回到正常列表 —— 回收站里少一条，用户没有任何提示。
 */
function isTrashed(p: StoredProfile): boolean {
  return p.deletedAt !== undefined && p.deletedAt !== null
}

function newId(taken: StoredProfile[]): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    let body = ''
    for (let i = 0; i < ID_LENGTH; i += 1) {
      body += ID_ALPHABET.charAt(randomInt(0, ID_ALPHABET.length))
    }
    const id = 'prf_' + body
    if (!taken.some((p) => p.id === id)) return id
  }
  // 16 次全撞上说明随机源坏了，宁可抛也不能生成重复身份
  throw new Error('无法生成唯一的 Profile ID')
}

/**
 * 目标 schema：本机能密封就写 2，不能就留在 1。
 *
 * 为什么是函数而不是常量：`safeStorage.isEncryptionAvailable()` 在 Linux 上要等
 * app ready 之后才有意义（keyring 后端在那时才初始化）。在模块加载期取一次值会
 * 永久锁死在「不可用」上，而且**完全静默** —— 功能整个不生效，没有任何信号。
 *
 * 为什么「不可用就留在 1」而不是「降级成明文写进 schema 2」：后者会让 schema 2
 * 的文件里出现明文 seed，而 `validateProfiles(…, 2)` 只接受 `enc:` 形态 →
 * 下一次读把自己判成形状错 → quarantine → 界面空列表。**降级路径会直接毁数据。**
 * 留在 1 则是今天的行为：能正常读写，只是 `verify-seed-at-rest.mjs` 会如实报出
 * 「明文 seed 在盘」—— 那是如实的不达标，比假的达标好。
 */
function targetSchema(): number {
  return sealAvailable() ? SCHEMA_SEALED : SCHEMA_CURRENT
}

/**
 * 旧版本数据兜底 → 校验 → 把 seed 统一换成**明文**（内存形态）。
 *
 * 这里原来是 `raw.filter(...)`：形状不对的条目被**悄悄丢掉**，而丢完之后
 * 下一次写入就把丢掉的结果落盘了。加上 `db.ts` 的损坏自愈会写回 `[]`，
 * 于是「格式改错」的表现是「环境列表空了」而不是任何一条错误 —— 全部数据
 * 在用户毫无感知的情况下消失。
 *
 * 现在改成「任何一条不合格就整体判损坏」：原文件原地保留 + 留一份备份 +
 * 明确报错。代价是一条坏记录会让列表暂时不可用，但那是有提示的、可修的。
 *
 * ── seed 形态：按**来源** schema 校验，出参一律明文 ──
 *
 * `Migrate<T>` 的返回值**就是会被持久化的那份数据**，这一点是这个函数最容易
 * 写错的地方。如果只 `return validateProfiles(...)`，schema 1 → 2 写出去的会是
 * 「版本号说 2、内容还是明文」，而下一次读会被 `seedForm(2)` 判成形状错 →
 * quarantine → 写全拒 → 界面空列表。**迁移自己把自己的数据隔离掉。**
 *
 * 所以两件事必须同时做：校验按来源版本（1 就该是明文），出参统一换成明文
 * （落盘时的密封交给 `sealProfiles`，那是唯一的密封点）。
 */
function migrateProfiles(data: unknown, schema: number, file: string): StoredProfile[] {
  const list = validateProfiles(data, schema, file)
  if (seedForm(schema) === 'plain-hex') return list
  return list.map((p, i) => ({
    ...p,
    seed: openSeed(p.seed, file, `第 ${String(i + 1)} 条（id=${p.id}）`)
  }))
}

/**
 * 写路径：内存里的明文 seed → 盘上的 `enc:` blob。
 *
 * 为什么密封放在这里而不是散在各个写入方法里：`create` / `clone` / `regenerate` /
 * `update` 全都经 `persist` 落盘，密封点只有一个才不会漏。反过来，如果每个写入
 * 方法各自封一次，漏掉任何一个就是「明文 seed 混进 schema 2 文件」——
 * 而那正是下次启动 quarantine 的触发条件。
 */
function sealProfiles(list: StoredProfile[], schema: number): StoredProfile[] {
  if (schema < SCHEMA_SEALED) return list
  return list.map((p, i) => ({
    ...p,
    seed: sealSeed(p.seed, `第 ${String(i + 1)} 条（id=${p.id}）`)
  }))
}

/** `adopt` 的逐字段比对结果。`from` 来自环境包，`to` 来自从盘上读回来的那份 */
export interface AdoptCompare {
  field: string
  from: string
  to: string
}

export interface AdoptResult {
  ok: boolean
  /** 成功时是从盘上读回来的那份，不是内存里构造的那份 */
  profile: Profile | null
  /**
   * **诊断输出，不是判据。**
   *
   * `ok` 由整份 `fingerprint` 的深比较决定；这个列表是给人看「差在哪」的。
   * 两者分工不能混：拿「我能想到的五个字段」当判据，等于用「我记得的」
   * 代替「全部」，而错位恰恰最可能发生在没被想到的那个字段上。
   */
  compared: AdoptCompare[]
}

/**
 * 挑出「导入后能被人看见」的几个字段。
 *
 * 选这五个不是为了判定相等（那件事交给 `fingerprintEqual`），而是为了
 * **回答用户会问的那个问题**：搬到新机器之后，站点看到的还是不是同一个人？
 * UA / 屏幕 / 时区 / 语言是站点最常拿来识别的一组，也是用户自己能核对的一组。
 *
 * `languages` 单列而不是并进 `language`：`locale` 相同而 `languages` 数组不同
 * 是完全可能的（`en-US` 配 `['en-US','en']` vs 只有 `['en-US']`），并在一起会把
 * 这个差异藏掉。
 */
const COMPARE_FIELDS: Array<{ label: string; key: string; of: (fp: FingerprintConfig) => string }> = [
  { label: 'userAgent', key: 'userAgent', of: (fp) => fp.userAgent },
  {
    label: 'screen',
    key: 'screen',
    of: (fp) => `${fp.screen.width}x${fp.screen.height}@${fp.screen.dpr}`
  },
  { label: 'timeZone', key: 'timezone', of: (fp) => fp.timezone },
  { label: 'language', key: 'locale', of: (fp) => fp.locale },
  {
    label: 'languages',
    key: 'languages',
    of: (fp) => (Array.isArray(fp.languages) ? fp.languages.join(',') : '')
  }
]

/** 诊断列表的上限：差异可能有几十条，全贴出来反而看不出主要矛盾 */
const DIFF_ROW_LIMIT = 12

/**
 * 键名排序后再序列化，用来做「整份对象相等」的判据。
 *
 * 直接 `JSON.stringify` 不行：两边字段顺序不同就会假报差异，而字段顺序
 * 恰恰是最容易因为序列化路径不同而变化的东西。
 */
function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return '[' + value.map(stableKey).join(',') + ']'
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableKey(record[k])).join(',') + '}'
}

/**
 * 判据本体：整份 `fingerprint` 深比较。
 *
 * 为什么不只比那五个显眼字段：`buildFingerprint` 的池子里还有
 * `glRenderer` / `glVendor` / `hardware.cores` / `hardware.memory` / `fonts` /
 * `canvasNoise` 等等。这些字段错位时五项**全对**，而身份已经变了 ——
 * 恰好是最显眼的五个最不可能出问题，因为它们在读取路径上最受关注。
 */
function fingerprintEqual(a: unknown, b: unknown): boolean {
  return stableKey(a) === stableKey(b)
}

/** 收集深比较的差异路径。只用于诊断展示 */
function diffPaths(a: unknown, b: unknown, path: string, out: Array<[string, string, string]>): void {
  if (out.length >= DIFF_ROW_LIMIT * 4) return
  const aObj = a !== null && typeof a === 'object'
  const bObj = b !== null && typeof b === 'object'
  if (!aObj || !bObj || Array.isArray(a) !== Array.isArray(b)) {
    if (stableKey(a) !== stableKey(b)) out.push([path, brief(a), brief(b)])
    return
  }
  const aKeys = new Set(Object.keys(a as Record<string, unknown>))
  const bKeys = new Set(Object.keys(b as Record<string, unknown>))
  for (const key of new Set([...aKeys, ...bKeys])) {
    const child = path === '' ? key : path + '.' + key
    diffPaths(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
      child,
      out
    )
  }
}

/** 值太长会撑爆界面；差异定位只需要一个前缀 */
function brief(value: unknown): string {
  const text = value === undefined ? '(缺字段)' : (JSON.stringify(value) ?? String(value))
  return text.length > 48 ? text.slice(0, 45) + '...' : text
}

function compareFingerprint(
  source: FingerprintConfig,
  stored: FingerprintConfig | null
): AdoptCompare[] {
  if (stored === null) {
    return [{ field: '(读回)', from: '存在', to: '读不回来' }]
  }
  const rows: AdoptCompare[] = COMPARE_FIELDS.map(({ label, of }) => ({
    field: label,
    from: safeOf(of, source),
    to: safeOf(of, stored)
  }))

  // 五项之外的差异追加在后面。判据不看它，但没有它的话，
  // 「五项全对但 ok:false」会变成一条无法排查的失败 —— 用户看到五个相同的
  // 值配一个失败结论，只能怀疑导入功能坏了。
  const covered = new Set(COMPARE_FIELDS.map((f) => f.key))
  const diff: Array<[string, string, string]> = []
  diffPaths(source, stored, '', diff)
  const extra = diff.filter(([path]) => !covered.has(path.split('.')[0] ?? path))
  for (const [path, from, to] of extra.slice(0, DIFF_ROW_LIMIT)) {
    rows.push({ field: path, from, to })
  }
  if (extra.length > DIFF_ROW_LIMIT) {
    rows.push({
      field: '(其余差异)',
      from: String(extra.length - DIFF_ROW_LIMIT) + ' 项',
      to: '已省略'
    })
  }
  return rows
}

/** 读回来的对象可能缺字段（外部改坏过），这里要给出可读的值而不是抛 */
function safeOf(of: (fp: FingerprintConfig) => string, fp: FingerprintConfig): string {
  try {
    const value = of(fp)
    return typeof value === 'string' ? value : String(value)
  } catch {
    return '(缺失)'
  }
}

/**
 * `update()` 允许写入的字段白名单。
 *
 * 与 `update()` 里那个显式字段表一一对应：白名单不是「认识的字段」，
 * 而是「真的会写进 `next` 的字段」。两处必须同步 —— 只加白名单不加字段表，
 * 就变成「接受了但没生效」，正是这次要修的那个问题。
 *
 * **`deletedAt` 故意不在这里。** 回收站状态的唯一写入口是 `softRemove` /
 * `restore`：加进白名单等于给渲染层开了一条
 * `update(id, { deletedAt: ... })` 的路，可以不经过审计把环境藏进回收站，
 * 或把已删除的环境悄悄放回正常列表。未知字段会抛错（见 `update`），
 * 所以这里不加就真的写不进去，而不是「接受了但没生效」。
 */
/**
 * 代理 / 代理组互斥解析。
 *
 * 两者同时挂着会有一句都说不清的真话：「这个环境到底从哪个出口出去」——
 * 界面可能显示组名，session 却用了单条代理。所以在唯一写入口强制互斥：
 * 后写的那个把前一个清掉。
 *
 * 语义关键点：`proxy: null` 是「用户明确清空代理」，必须同时也清掉 proxyGroupId；
 * 而 `proxy: undefined` 是「这次不改」，不能顺手清掉组。区分靠 !== undefined。
 */
function resolveProxyFields(
  patch: Partial<Profile>,
  existing: StoredProfile
): Pick<StoredProfile, 'proxy' | 'proxyGroupId'> {
  const proxyTouched = patch.proxy !== undefined
  const groupTouched = patch.proxyGroupId !== undefined

  if (proxyTouched && groupTouched) {
    // 两个都传：以组为准（组的策略更具体），单条代理被丢弃。
    return {
      proxy: existing.proxy,
      proxyGroupId: cleanGroupId(patch.proxyGroupId)
    }
  }
  if (groupTouched) {
    return {
      // 挂组时保留单条代理字段作为「组不可用时的显示回退」没有意义：
      // 组全挂时我们直接失败，不会退回单条。所以清掉，避免两处事实打架。
      proxy: null,
      proxyGroupId: cleanGroupId(patch.proxyGroupId)
    }
  }
  if (proxyTouched) {
    return {
      // proxyTouched 已保证 !== undefined，这里只是把 narrowing 交给 TS
      proxy: patch.proxy ?? null,
      // 显式挂单条代理 / 显式清空代理，都退出组
      proxyGroupId: null
    }
  }
  return { proxy: existing.proxy, proxyGroupId: existing.proxyGroupId ?? null }
}

function cleanGroupId(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw new Error('proxyGroupId 必须是字符串或 null')
  return value.trim() || null
}

const WRITABLE: ReadonlySet<string> = new Set([
  'name',
  'group',
  'color',
  'note',
  'tags',
  'proxy',
  'proxyGroupId',
  'status',
  'lastUsedAt',
  'lastError',
  'favorite',
  'startUrl',
  'extensionIds',
  'fingerprint'
])

/**
 * 扩展 id 列表的清洗。
 *
 * 只接受字符串数组：渲染层把表单状态直接丢过来时，常见的是 `['']` / 重复项 /
 * 带空格。这里统一 trim + 去空 + 去重，并限长 —— 上限不是业务限制，而是
 * 防止一个坏掉的调用方把整张扩展表塞进每个环境。
 *
 * 非数组一律抛错而不是静默当作空：`extensionIds: 'ext_1'` 这种拼错的形状
 * 如果被当成「清空」，用户会以为扩展被删了。
 */
const EXTENSION_IDS_MAX = 50

function cleanExtensionIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('extensionIds 必须是字符串数组')
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('extensionIds 必须是字符串数组')
    const id = item.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= EXTENSION_IDS_MAX) break
  }
  return out
}

/**
 * `fingerprint` 的投影字段：`platform` / `browserVersion` 是它的冗余副本。
 *
 * 它们**不是**可写字段（见 `update()` 里的说明），但模板应用
 * （`modules/templates.ts` 的 `applyTemplate`）会连着 `fingerprint` 一起传，
 * 所以不能当未知字段一刀切拒绝 —— 而是收下来后校验「必须与指纹一致」。
 * 值不一致才说明调用方真的想单独改平台，那是被禁止的。
 */
const PROJECTION_KEYS: readonly string[] = ['platform', 'browserVersion']

export class ProfileStore {
  private readonly store = new JsonStore<StoredProfile[]>('profiles.json', () => [], migrateProfiles, {
    schema: targetSchema,
    serialize: sealProfiles,
    // 用目标 schema 校验即将写出的数据。少了它，「版本号说 2、seed 还是明文」
    // 会被安静地写出去，症状要等到下一次启动才出现（空列表）。
    verify: validateProfiles,
    /**
     * 「文件是 schema 2、本版本却只敢写 1」有两种成因，补救动作相反。
     *
     * 默认文案说的是「用旧版应用打开新版数据 → 去升级」。但还有另一种：
     * 本机 `safeStorage` 不可用（Linux 无 keyring / 用 --password-store=basic 启动），
     * 于是 `targetSchema()` 主动留在 1 —— 这时让用户去升级应用是**完全无效**的建议，
     * 他需要的是把系统密钥环修好。
     */
    explainSchemaMismatch: (found, target) =>
      found >= SCHEMA_SEALED && target < SCHEMA_SEALED
        ? `文件 schema=${String(found)} 用 safeStorage 密封了 seed，而本机的加密后端当前不可用，` +
          '所以本版本只敢按 schema 1 读写。这不是「旧版应用打开新版数据」，升级应用没有用。' +
          '要恢复读取：Windows/macOS 上确认以原系统账户运行；' +
          'Linux 上确认已安装并解锁 gnome-keyring 或 kwallet，且没有用 --password-store=basic 启动。'
        : null
  })

  /**
   * 非 null 表示 profiles.json 已判定损坏。
   *
   * 读路径（`list` / `get` / `count`）会降级成空列表以便应用还能起来，
   * 写路径一律抛错 —— 但「降级」这件事本身必须能被上层看见，
   * 所以把状态透出去，给将来的健康横幅用。
   */
  get corruption(): CorruptInfo | null {
    return this.store.corruption
  }

  /** 健康快照用：真实路径 / 版本 / 损坏状态 */
  get health(): HealthStoreRef {
    return {
      name: 'profiles',
      file: this.store.filePath,
      schemaVersion: this.store.schemaVersion,
      corruption: this.store.corruption
    }
  }

  /**
   * 对外列表。**返回值里没有 seed**（见 `toPublicProfile`）。
   *
   * 回收站里的环境（`deletedAt` 非空）不在这里返回。过滤必须放在这里而不是
   * 各个调用方：环境页、localapi、MCP、团队面板全都消费 `list()`，
   * 让每个消费者自己记得排除已删除项，漏一处就是「已删除的环境仍在正常接口里」。
   *
   * 需要 seed 的内部调用方用 `getStored()` —— 那个名字本身就说明了「这是内部形态」。
   */
  list(): Profile[] {
    const all = this.store.read().filter((p) => !isTrashed(p))
    all.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    return all.map((p) => toPublicProfile(deepCopy(p)))
  }

  /**
   * 回收站列表：只含 `deletedAt` 非空的环境，按删除时间**降序**（最近删的在最前）。
   *
   * 返回 public 形态，和 `list()` 一样不含 seed —— 渲染层拿到 `deletedAt`
   * 只是为了显示「删除时间」，不需要种子的任何投影之外的东西。
   *
   * 时间戳相同（同一毫秒内删了多个）时按 id 倒序兜底，保证顺序稳定：
   * 否则每次刷新都可能换一个顺序，用户点「恢复」时容易点错行。
   */
  listTrash(): Profile[] {
    const all = this.store.read().filter((p) => isTrashed(p))
    all.sort(
      (a, b) => Number(b.deletedAt) - Number(a.deletedAt) || b.id.localeCompare(a.id)
    )
    return all.map((p) => toPublicProfile(deepCopy(p)))
  }

  /**
   * 按 id 取环境。**回收站里的环境也会返回。**
   *
   * 恢复流程必须先读到已删除的记录才能把它捞回来；这里过滤掉的话，
   * `restore()` 只能自己绕过 get 去读盘，同一套查找逻辑就有两份实现。
   * 状态由调用方自查 `deletedAt` —— 只有「不允许操作已删除环境」的入口才需要判。
   */
  get(id: string): Profile | null {
    const hit = this.getStored(id)
    return hit === null ? null : toPublicProfile(hit)
  }

  /**
   * 内部形态（含明文 seed）。**只给主进程用**：注入脚本、迁移导出、令牌派生。
   *
   * 与 `get()` 一样**不过滤回收站**：恢复/彻底删除都要先拿到记录本身。
   *
   * 单独一个方法而不是给 `get()` 加参数：加参数的话调用点写的是
   * `get(id, true)`，读代码的人得去数第二个参数是什么；而 `getStored(id)`
   * 在 grep 里就是一份「谁在用明文 seed」的完整清单。
   */
  getStored(id: string): StoredProfile | null {
    const hit = this.store.read().find((p) => p.id === id)
    return hit === undefined ? null : deepCopy(hit)
  }

  count(): number {
    return this.store.read().length
  }

  create(input: CreateProfileInput): Profile {
    const all = this.store.read()
    const platform: OSKind = input.platform ?? input.fingerprint?.os ?? 'windows'
    const id = newId(all)
    const seed = deriveSeed(id)
    // 传了指纹就用传的（用户可能从别处导入），否则按平台现算一套
    const fingerprint = input.fingerprint ?? buildFingerprint(platform, seed)
    const now = Date.now()

    const profile: StoredProfile = {
      id,
      name: (input.name ?? '').trim() || '环境 ' + String(all.length + 1),
      group: (input.group ?? '').trim() || DEFAULT_GROUP,
      color: PROFILE_COLORS[all.length % PROFILE_COLORS.length],
      status: 'idle',
      platform: fingerprint.os,
      browserVersion: fingerprint.uaVersion,
      seed,
      fingerprint,
      proxy: input.proxy ?? null,
      tags: [],
      note: '',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      // 新建一律 false。这个开关的开启是一条**独立**路径（setExemption），
      // 不走 create / update —— 否则一句 create({allowUnmaskedL2:true}) 就绕过了
      // 「手打环境名确认」那道闸，而它正是这个开关唯一的人为约束。
      allowUnmaskedL2: false
    }

    this.store.update((draft) => {
      draft.push(profile)
    })
    return toPublicProfile(deepCopy(profile))
  }

  /**
   * 局部更新。
   *
   * **不做 `{ ...existing, ...patch }`。** 那个写法把「调用方能改什么」交给了调用方：
   * 渲染层一句 `update(id, { seed: '…' })` 就能把环境改成一套完全已知的指纹
   * （实测这条路已经被用过一次，见 store 目录里那条 seed 对不上任何生成路径的环境），
   * 而 `{ fingerprint: null }` 更狠 —— 下一次读盘时 `validateProfiles` 判形状损坏，
   * 整个环境列表进 quarantine，界面全空。
   *
   * 所以改成显式字段表：能改的一个个列出来，其余一律不接受。
   * 拒绝而不是静默忽略 —— 静默忽略会让「我改了但没生效」变成一个更难查的问题。
   */
  update(id: string, patch: Partial<Profile>): Profile {
    const existing = this.getStored(id)
    if (existing === null) throw new Error('环境不存在：' + id)

    const raw = patch as Record<string, unknown>

    // seed 永远不可经 update 修改：换身份的唯一入口是 regenerate（它重掷种子并重建指纹）。
    //
    // 类型层已经挡了一道（`Partial<Profile>` 里没有 seed），但**类型不是运行时**：
    // 渲染层被 XSS 之后发过来的是裸 JSON，TS 编译不过的代码它照样能发。
    // 所以这里再判一次 —— 而且必须判在「未知字段」之前：seed 的错误信息要指出
    // 唯一正确的入口，泛泛的「不支持的字段：seed」会把人引到错误的修法上。
    if (raw['seed'] !== undefined) {
      throw new Error('seed 不可直接修改：要换一套指纹请用「重掷种子」（regenerate）')
    }

    // 未知字段必须报错，不能静默忽略。
    //
    // 原来的实现只挑白名单字段写进 `next`，patch 里多出来的键既不报错也不生效：
    // 拼错 `noet`、或者把 `platform` 当成可写项传进来，调用方拿到的都是一次
    // 「成功」—— 而界面显示的还是旧值。这类失败的排查成本远高于一句报错。
    const unknown = Object.keys(raw).filter(
      (k) => !WRITABLE.has(k) && !PROJECTION_KEYS.includes(k)
    )
    if (unknown.length > 0) {
      throw new Error('不支持的字段：' + unknown.join(', '))
    }

    // id / createdAt 是身份的锚点；platform / browserVersion 是 fingerprint 的投影，
    // 只能由下面的 fingerprint 分支推导，不接受调用方直接指定。
    const next: StoredProfile = {
      ...existing,
      name: patch.name ?? existing.name,
      group: patch.group ?? existing.group,
      color: patch.color ?? existing.color,
      note: patch.note ?? existing.note,
      tags: Array.isArray(patch.tags) ? patch.tags.slice() : existing.tags,
      ...resolveProxyFields(patch, existing),
      status: patch.status ?? existing.status,
      lastUsedAt: patch.lastUsedAt !== undefined ? patch.lastUsedAt : existing.lastUsedAt,
      lastError: patch.lastError !== undefined ? patch.lastError : existing.lastError,
      favorite: patch.favorite ?? existing.favorite,
      startUrl: patch.startUrl !== undefined ? patch.startUrl : existing.startUrl,
      extensionIds:
        patch.extensionIds !== undefined
          ? cleanExtensionIds(patch.extensionIds)
          : existing.extensionIds,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Date.now()
    }

    // fingerprint 是合法可编辑字段（指纹抽屉要改它），但必须形状完整：
    // 少了 os / uaVersion 会让 platform 投影落空，而 `null` 会直接触发上面的 quarantine 路径。
    if (patch.fingerprint !== undefined) {
      const fp = patch.fingerprint
      if (fp === null || typeof fp !== 'object') {
        throw new Error('fingerprint 必须是对象')
      }
      if (typeof fp.os !== 'string' || fp.os.length === 0) {
        throw new Error('fingerprint 缺少 os')
      }
      if (typeof fp.uaVersion !== 'string' || fp.uaVersion.length === 0) {
        throw new Error('fingerprint 缺少 uaVersion')
      }
      next.fingerprint = structuredClone(fp)
      next.platform = fp.os
      next.browserVersion = fp.uaVersion
    }

    // 投影字段：允许出现在 patch 里（模板应用会带），但值必须与最终指纹一致。
    // 不一致 = 调用方想绕过指纹单独改平台，那是被禁止的 —— 改了 UA 不改平台
    // 就是一份自相矛盾的指纹。
    if (raw['platform'] !== undefined && raw['platform'] !== next.platform) {
      throw new Error('platform 由 fingerprint 决定，不能与指纹不一致')
    }
    if (raw['browserVersion'] !== undefined && raw['browserVersion'] !== next.browserVersion) {
      throw new Error('browserVersion 由 fingerprint 决定，不能与指纹不一致')
    }

    this.store.update((draft) => {
      const i = draft.findIndex((p) => p.id === id)
      if (i >= 0) draft[i] = next
    })
    return toPublicProfile(deepCopy(next))
  }

  /**
   * 批量局部更新：同一个 patch 应用到多个 id，**只写一次盘**。
   *
   * 为什么需要：`proxy.remove` 要清掉所有挂载该代理的环境的 `proxy` 字段。
   * 逐条 `update()` 是 N 次整份 `profiles.json` 的 read-modify-atomic-rename
   * （10 个环境 = 10 次全量写）。这里收成一次 `store.update`。
   *
   * 语义（与逐条 `update` 的差异必须说清楚）：
   * - **校验与 `update` 同源**：`seed` 拒绝、未知字段拒绝、`fingerprint` 形状、
   *   投影字段一致性，全部照旧 —— 批量不是绕过闸门的理由。
   * - **不存在的 id 忽略**（不抛）：调用方拿的是同一份 `list()` 快照，
   *   快照与写入之间环境被别处删掉是正常竞态，抛错会让整批失败。
   * - **0 条命中不落盘**：返回 0，避免一次无意义的整份重写。
   * - `updatedAt` 统一刷新为本次时间。
   */
  updateMany(ids: string[], patch: Partial<Profile>): number {
    if (ids.length === 0) return 0
    const raw = patch as Record<string, unknown>
    if (raw['seed'] !== undefined) {
      throw new Error('seed 不可直接修改：要换一套指纹请用「重掷种子」（regenerate）')
    }
    const unknown = Object.keys(raw).filter(
      (k) => !WRITABLE.has(k) && !PROJECTION_KEYS.includes(k)
    )
    if (unknown.length > 0) {
      throw new Error('不支持的字段：' + unknown.join(', '))
    }
    // fingerprint 若在 patch 里，先校验一次形状（与 update 同一套规则）。
    const fpPatch = patch.fingerprint
    if (fpPatch !== undefined) {
      if (fpPatch === null || typeof fpPatch !== 'object') {
        throw new Error('fingerprint 必须是对象')
      }
      if (typeof fpPatch.os !== 'string' || fpPatch.os.length === 0) {
        throw new Error('fingerprint 缺少 os')
      }
      if (typeof fpPatch.uaVersion !== 'string' || fpPatch.uaVersion.length === 0) {
        throw new Error('fingerprint 缺少 uaVersion')
      }
    }

    const idSet = new Set(ids)
    let changed = 0
    this.store.update((draft) => {
      const now = Date.now()
      for (let i = 0; i < draft.length; i++) {
        const existing = draft[i]
        if (!idSet.has(existing.id)) continue
        const next: StoredProfile = {
          ...existing,
          name: patch.name ?? existing.name,
          group: patch.group ?? existing.group,
          color: patch.color ?? existing.color,
          note: patch.note ?? existing.note,
          tags: Array.isArray(patch.tags) ? patch.tags.slice() : existing.tags,
          ...resolveProxyFields(patch, existing),
          status: patch.status ?? existing.status,
          lastUsedAt: patch.lastUsedAt !== undefined ? patch.lastUsedAt : existing.lastUsedAt,
          lastError: patch.lastError !== undefined ? patch.lastError : existing.lastError,
          favorite: patch.favorite ?? existing.favorite,
          startUrl: patch.startUrl !== undefined ? patch.startUrl : existing.startUrl,
          extensionIds:
            patch.extensionIds !== undefined
              ? cleanExtensionIds(patch.extensionIds)
              : existing.extensionIds,
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: now
        }
        if (fpPatch !== undefined) {
          next.fingerprint = structuredClone(fpPatch)
          next.platform = fpPatch.os
          next.browserVersion = fpPatch.uaVersion
        }
        draft[i] = next
        changed += 1
      }
    })
    return changed
  }

  /**
   * 开关「伪装闸门豁免」。**这是唯一能改这个字段的入口。**
   *
   * ── 为什么单独一条路径，不放进 `update()` 的字段表 ──
   * `update()` 的入参是 `Partial<Profile>`，渲染层被 XSS 之后发过来的是裸 JSON。
   * 把 `allowUnmaskedL2` 加进那张表，等于让一句
   * `update(id, { allowUnmaskedL2: true })` 就能关掉闸门 —— 而「手打环境名」
   * 正是这个开关唯一的人为约束。约束放在 UI 上不算约束，UI 是可以被绕过的。
   *
   * ── 为什么关闭不需要确认 ──
   * 收紧永远是安全方向。要求确认只会让人不愿意关。
   *
   * ── 为什么用环境名而不是密码 / 二次弹窗 ──
   * 目标不是防住有权限的人，是让这件事**不能顺手做**：打字要花几秒，
   * 这几秒里人会想「我为什么在开这个」。弹窗点「确定」不需要想。
   */
  setExemption(id: string, enabled: boolean, confirmName: string): Profile {
    const existing = this.getStored(id)
    if (existing === null) throw new Error('环境不存在：' + id)

    if (enabled) {
      // 严格相等，不做大小写折叠、不忽略空格差异 —— 「差不多对」正是
      // 这类确认要被设计成不能「差不多」的原因。
      if (String(confirmName ?? '').trim() !== existing.name) {
        throw new Error(
          '开启伪装闸门豁免需要输入环境名「' + existing.name + '」确认，输入的不一致，已拒绝'
        )
      }
    }

    const next: StoredProfile = {
      ...existing,
      allowUnmaskedL2: enabled === true,
      updatedAt: Date.now()
    }
    this.store.update((draft) => {
      const i = draft.findIndex((p) => p.id === id)
      if (i >= 0) draft[i] = next
    })
    return toPublicProfile(deepCopy(next))
  }

  /**
   * 伪装修好时自动收回豁免。
   *
   * 返回是否真的收回了一条 —— 调用方要据此写审计，所以不能返回 void：
   * 「收回了」和「本来就没开」在审计里是两件不同的事。
   */
  revokeExemption(id: string): boolean {
    const existing = this.getStored(id)
    if (existing === null || existing.allowUnmaskedL2 !== true) return false
    const next: StoredProfile = { ...existing, allowUnmaskedL2: false, updatedAt: Date.now() }
    this.store.update((draft) => {
      const i = draft.findIndex((p) => p.id === id)
      if (i >= 0) draft[i] = next
    })
    return true
  }

  /**
   * 用**指定的 seed 与指定的指纹**建一个环境。**只给迁移包导入用，不挂任何 IPC 通道。**
   *
   * ── 为什么不把 `seed` 加进 `CreateProfileInput` ──
   *
   * 那个类型是 IPC 直达的（`ss:profiles:create`）。加一个字段进去，等于把
   * `update({ seed })` 那个洞从另一扇门重新打开 —— 被 XSS 的渲染层可以直接造一个
   * 「身份完全已知」的环境。
   *
   * ── 为什么必须要求 `input.fingerprint` 非空，而不是用 seed 重算 ──
   *
   * `buildFingerprint(os, seed)` 的取模分母是**池子长度**：
   * `SCREEN_POOL[os][h % pool.length]`、`cores[(h >>> 3) % cores.length]`。
   * 于是「往池子里加一个分辨率」这种看起来无害的提交，会让**所有**环境重映射 ——
   * 而且用户手动改过的 overrides 从 seed 根本推不出来。
   *
   * 后果不是「报错」，是「应用能打开，但它是另一个身份，界面上没有任何提示」。
   * 所以导入路径**禁止**走「用 seed 重算」那一支：包里存的是什么，写回去就是什么。
   *
   * ── 返回值为什么要带 `compared` ──
   *
   * 写进去不等于写对了。`compared` 是拿**从盘上读回来的** fingerprint 与包里的
   * 逐项比对，任何一项不同就回滚并返回 `ok: false`。这是 `legacy-backups.ts` 的
   * `verifyRoundTrip` 在身份层的对应物：验的必须是落盘/读回的那一份，不是内存里的值。
   */
  adopt(input: CreateProfileInput, seed: string): AdoptResult {
    if (!/^[0-9a-f]{32}$/.test(seed)) {
      throw new Error('adopt 的 seed 必须是 32 位小写 hex（长度 ' + String(seed.length) + '）')
    }
    const source = input.fingerprint
    if (source === null || source === undefined) {
      throw new Error(
        'adopt 必须带上环境包里存的 fingerprint：用 seed 重算会得到一个不同的身份，' +
          '而界面上看不出任何区别'
      )
    }

    const all = this.store.read()
    const id = newId(all)
    const now = Date.now()

    const profile: StoredProfile = {
      id,
      name: (input.name ?? '').trim() || '导入的环境 ' + String(all.length + 1),
      group: (input.group ?? '').trim() || DEFAULT_GROUP,
      color: PROFILE_COLORS[all.length % PROFILE_COLORS.length],
      status: 'idle',
      platform: source.os,
      browserVersion: source.uaVersion,
      seed,
      // 原样写回，**不重算**
      fingerprint: structuredClone(source),
      proxy: input.proxy ?? null,
      tags: [],
      note: '',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      // 导入也不继承豁免：迁移包里带着一个「已关掉闸门」的环境，
      // 对收下它的人来说是看不见的风险 —— 他不知道自己在跑一个豁免环境。
      allowUnmaskedL2: false
    }

    this.store.update((draft) => {
      draft.push(profile)
    })

    // 读回来比，不是拿内存里的比
    const stored = this.getStored(id)
    const compared = compareFingerprint(source, stored === null ? null : stored.fingerprint)
    // 判据是整份 fingerprint 深比较；compared 只是诊断输出
    const identical = stored !== null && fingerprintEqual(source, stored.fingerprint)

    if (!identical) {
      // 回滚：留下一个「名字对、身份不对」的环境，比导入失败更糟 ——
      // 用户会以为搬成功了，直到某天发现站点认不出他。
      this.remove(id)
      return { ok: false, profile: null, compared }
    }

    return { ok: true, profile: stored === null ? null : toPublicProfile(stored), compared }
  }

  /**
   * 只写 `maskLast` 这一个字段。
   *
   * **不走 `update()`**：那个方法是白名单式的，加字段要动它的字段表；
   * 而且 `maskLast` 由主进程写、渲染层只读，把它塞进 `update` 的可改字段里，
   * 等于给渲染层开了一条「把上次会话状态改成 ok」的路 —— 界面上的红点会因此消失，
   * 而真实状态没变。伪装状态的唯一写入者是 `WindowManager`。
   *
   * 失败时抛错，由调用方（`index.ts`）决定是否吞掉：状态已经在内存里，
   * 门禁照样拦得住，所以落盘失败不该让注入流程失败；但界面上的「上次会话」
   * 会停更，必须留日志。
   */
  setMaskLast(id: string, record: MaskLastRecord): void {
    this.store.update((draft) => {
      const i = draft.findIndex((p) => p.id === id)
      if (i < 0) throw new Error('环境不存在：' + id)
      draft[i] = { ...draft[i], maskLast: record }
    })
  }

  /**
   * 软删除：只打 `deletedAt` 时间戳，**不删记录、不碰分区**。
   *
   * 分区里存着 Cookie / localStorage / IndexedDB。软删除的整个意义就是
   * 「先别动它们」—— 恢复之后环境必须还是原来那个登录态；如果这里顺手清了，
   * 回收站就只剩一个空壳，恢复按钮等于「重新建一个同名环境」。
   * 真正的清理在 `purge` 之前由调用方负责（见 `modules/trash.ts`）。
   */
  softRemove(id: string): Profile {
    const existing = this.getStored(id)
    if (existing === null) throw new Error('环境不存在：' + id)

    const now = Date.now()
    const next: StoredProfile = { ...existing, deletedAt: now, updatedAt: now }
    this.store.update((draft) => {
      const i = draft.findIndex((p) => p.id === id)
      if (i >= 0) draft[i] = next
    })
    return toPublicProfile(deepCopy(next))
  }

  /**
   * 从回收站恢复：清空 `deletedAt`，其余字段与记录原样保留。
   *
   * 这里**不重新读分区、不重建指纹**：软删除期间记录和分区都没动过，
   * 恢复要做的只是把「可见性」还回去。重建任何东西都会破坏「同一环境同一身份」。
   */
  restore(id: string): Profile {
    const existing = this.getStored(id)
    if (existing === null) throw new Error('环境不存在：' + id)

    const next: StoredProfile = { ...existing, deletedAt: null, updatedAt: Date.now() }
    this.store.update((draft) => {
      const i = draft.findIndex((p) => p.id === id)
      if (i >= 0) draft[i] = next
    })
    return toPublicProfile(deepCopy(next))
  }

  /**
   * 彻底删除：把记录从数组里真正移除。
   *
   * **只负责记录**，不清理 `persist:ss_<id>` 分区。职责分离的理由：
   * 分区清理要 `electron.session` + 跨平台文件删除，属于主进程运行时能力；
   * store 要能在没有 Electron 的环境里被单测。调用方（`modules/trash.ts`）
   * 必须在调用本方法**之前**尽力执行 `clearProfileData`，否则记录没了、
   * 分区还留在盘上，之后也没有任何 id 能再认领它。
   */
  purge(id: string): void {
    // 复用 remove 的「不存在就抛」与数组移除逻辑，避免两份删除实现漂移。
    this.remove(id)
  }

  /** 删除后不留占位：列表就是纯数组，天然没有空洞 */
  remove(id: string): void {
    if (this.get(id) === null) throw new Error('环境不存在：' + id)
    this.store.update((draft) => {
      const i = draft.findIndex((p) => p.id === id)
      if (i >= 0) draft.splice(i, 1)
    })
  }

  clone(id: string, opts: CloneOptions): Profile {
    const src = this.getStored(id)
    if (src === null) throw new Error('环境不存在：' + id)

    const all = this.store.read()
    const newProfileId = newId(all)
    // newFingerprint=false 时连 seed 一起复制：同一身份多开，服务端看到的是同一个人
    const seed = opts.newFingerprint ? deriveSeed(newProfileId) : src.seed
    const fingerprint = opts.newFingerprint ? buildFingerprint(src.platform, seed) : structuredClone(src.fingerprint)
    const now = Date.now()

    const copy: StoredProfile = {
      ...src,
      id: newProfileId,
      name: (opts.name ?? '').trim() || src.name + ' 副本',
      seed,
      fingerprint,
      status: 'idle',
      lastError: undefined,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      // `...src` 会把 deletedAt 一起复制过来。副本是一个**新**环境：
      // 源环境即使还在回收站，复制出来的也必须是正常可见的，否则用户点了
      // 「克隆」却什么也没看到（副本直接进了回收站）。
      deletedAt: null,
      tags: src.tags.slice(),
      // `...src` 会把豁免一起复制过来，所以必须显式覆盖。
      // 复制一个「已关掉闸门」的环境，等于让用户在没有对副本做过任何确认的情况下
      // 多了一个豁免环境 —— 而那个开关的全部意义就是「每次开启都要人确认」。
      allowUnmaskedL2: false
    }

    this.store.update((draft) => {
      draft.push(copy)
    })
    return toPublicProfile(deepCopy(copy))
  }

  /**
   * 重掷种子 + 重新生成整套指纹。
   *
   * deriveSeed 只接受 profileId，直接再算一次会得到同一个 seed，
   * 所以在 info 后面拼一次性 nonce：仍然由 masterKey 派生（不可预测、不可反推），
   * 但结果与旧值无关，等于换了一个身份。
   */
  regenerate(id: string): Profile {
    const existing = this.getStored(id)
    if (existing === null) throw new Error('环境不存在：' + id)

    const seed = deriveSeed(existing.id + '#' + Date.now().toString(36))
    const fingerprint = buildFingerprint(existing.platform, seed)
    const next: StoredProfile = {
      ...existing,
      seed,
      fingerprint,
      browserVersion: fingerprint.uaVersion,
      updatedAt: Date.now()
    }

    this.store.update((draft) => {
      const i = draft.findIndex((p) => p.id === id)
      if (i >= 0) draft[i] = next
    })
    return toPublicProfile(deepCopy(next))
  }
}
