/**
 * ShadowSurf 领域模型。
 *
 * 这里是 main / preload / renderer 三方共用的唯一事实来源。
 * 任何新增字段都必须同时更新本文件与 docs/architecture.html 的数据模型章节。
 */

import type { AgentStep, ActionType } from './protocol'

/* ────────────────────────────── 环境 Profile ────────────────────────────── */

export type ProfileStatus = 'idle' | 'starting' | 'running' | 'error'

export type OSKind = 'windows' | 'macos' | 'linux'

export interface ProxyConfig {
  type: 'http' | 'https' | 'socks5'
  host: string
  port: number
  username?: string
  password?: string
}

export interface GeoPoint {
  latitude: number
  longitude: number
}

/**
 * 指纹配置。
 *
 * 设计原则：**确定性而非随机化**。
 * 同一 profile 的 seed 恒定，因此这里存的是「已解析出的具体值」，
 * 不是「随机范围」。这样环境迁移、备份恢复后指纹完全一致。
 */
export interface FingerprintConfig {
  os: OSKind
  /** 例：Windows 11 · 23H2 */
  osLabel: string
  userAgent: string
  /** 浏览器大版本，例：141.0.7390.107 */
  uaVersion: string
  timezone: string
  locale: string
  languages: string[]
  geolocation: GeoPoint | null
  screen: {
    width: number
    height: number
    dpr: number
    colorDepth: number
  }
  hardware: {
    cpuCores: number
    memoryGB: number
  }
  webgl: {
    vendor: string
    renderer: string
  }
  canvas: 'noise' | 'off'
  audio: 'noise' | 'off'
  /** proxy=跟随代理出口 IP；disabled=直接屏蔽；real=暴露真实 */
  webrtc: 'proxy' | 'disabled' | 'real'
  /** 注入的字体白名单；空数组表示不干预 */
  fonts: string[]
  clientRectsNoise: boolean
  webgpu: boolean
}

/**
 * 伪装（指纹注入）状态。
 *
 * ── 为什么必须有 `'unknown'` ──
 *
 * `Page.addScriptToEvaluateOnNewDocument` 的返回只证明「脚本已排进队列」，
 * 不证明任何一条属性真的装上了。原先这条返回之后就置 `'ok'`，于是
 * **一个属性都没装上的页面，状态也是 ok** —— 门禁读到的是「从未测量过的成功」。
 * 这正是本轮反复出现的那类假绿：「没报错」和「没跑」在外部完全同形。
 *
 * 所以 `'unknown'` 的语义是**脚本已下发、结果未回读**，它既不等于成功也不等于失败，
 * 而门禁对它的处置是**拒绝 L2**（见 `actions.ts` 的判定表）。
 * 真正的 `'ok'` 只能由「页面台账回读 = 0 条失败」来置。
 */
export type MaskState = 'unknown' | 'ok' | 'rolled-back' | 'degraded'

/**
 * 失败来源。
 *
 * 页面决定「是否可信」，子目标决定「可信到什么程度」：
 * page 侧失败 → 拒绝 L2；worker / iframe 侧失败 → 界面告警 + 审计留痕，不拦 L2。
 * 理由：worker 注入当前是停用状态（`WORKER_INJECTION_ENABLED = false`），
 * 若它也算拦截条件，所有 L2 都会被拦 —— 闸门全阻断等于用户把闸门关掉，比漏判更糟。
 */
export type MaskSource = 'page' | 'worker' | 'iframe' | 'other'

export interface MaskFailure {
  /** 出问题的属性名，或造成降级的那个 target */
  attr: string
  reason: string
  source: MaskSource
}

export interface MaskStateRecord {
  /** 会话内有效：窗口销毁即失效，跨会话无意义 */
  webContentsId: number
  profileId: string
  state: MaskState
  failed: MaskFailure[]
  at: number
}

/**
 * 落盘的那一份（`Profile.maskLast`）。
 *
 * 去掉 `webContentsId`：它是本次进程里的编号，写进盘只会让下一个会话读到
 * 一个指向不存在窗口的数字，看起来像证据其实不是。
 *
 * **门禁不读这个字段。** 它是「这个环境上次会话有没有回滚过」的历史，
 * 给界面和审计看；门禁读的是进程内的实时状态（见 `setMaskStateLookup` 的注释）。
 */
export type MaskLastRecord = Omit<MaskStateRecord, 'webContentsId'>

export interface Profile {
  /** prf_ 前缀 + 12 位 base32 */
  id: string
  name: string
  group: string
  /** 卡片标识色，取自预设色板 */
  color: string
  status: ProfileStatus
  platform: OSKind
  browserVersion: string
  /**
   * 种子的**指纹**（`sha256(seed)` 前 8 位），不是种子本身。
   *
   * 用途只有一个：让人肉眼比对「这两个环境是不是同一个种子」——
   * 备份恢复、跨机迁移之后需要这个判断。8 位十六进制足够区分，且不可逆。
   *
   * 完整种子**不出主进程**。渲染层曾经拿它做两件事：显示、以及
   * `resolveFingerprint(platform, seed)` 预览。后者已改成
   * `profiles.preview(id, { platform })` 由主进程算 —— 于是这个字段
   * 变成唯一的对外形态，`seed` 从此没有跨进程的理由。
   */
  seedHint: string
  fingerprint: FingerprintConfig
  proxy: ProxyConfig | null
  tags: string[]
  note: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
  /** 最近一次启动失败的原因，status==='error' 时有值 */
  lastError?: string
  /**
   * 上一次会话结束时这个环境的伪装状态。
   *
   * 只用于界面与审计：重启后窗口重新测量，这条记录**必然**是旧的，
   * 所以展示时必须带上 `at` 并写明「上次会话」，不能让人当成当前状态。
   * 门禁不读它 —— 拿一个可能过期的值去拒绝合法操作，比漏判更难查。
   */
  maskLast?: MaskLastRecord | null
}

/**
 * 主进程内部的 Profile —— 多一个明文 `seed`。
 *
 * ── 为什么单独一个类型，而不是让 `Profile` 带一个可选 seed ──
 *
 * 可选字段挡不住泄漏：`seed?: string` 在类型上允许「有」，于是每个返回
 * Profile 的地方都「可能」带着它，而没人会去看。去掉这个字段之后，
 * 「Profile 有 seed」这句话在类型上就不成立，读 `profile.seed` 直接编译失败。
 *
 * ── 但类型系统只做到一半，必须说清 ──
 *
 * TS 的结构化类型对**多字段是宽容的**：把 `StoredProfile` 直接 return 给
 * 一个声明为 `Profile` 的位置，编译器不会报错（多余字段只在对象字面量上检查）。
 * 所以「seed 不出 IPC」真正的保证不是这个类型，而是两件事：
 *   1. `toPublicProfile()` 是**唯一**构造 `Profile` 的地方（出口收口）；
 *   2. `tests/structure.test.ts` 断言 `StoredProfile` 只出现在 `src/main/`。
 * 类型负责「读到不存在的东西会报错」，结构断言负责「没人绕过出口」。
 *
 * ── 使用规则 ──
 *
 * 只允许出现在 `src/main/` 内。**任何 IPC 签名、preload、渲染层都不得出现
 * 这个名字**。新增一个返回 Profile 的通道时，出口必须过 `toPublicProfile()`。
 */
export type StoredProfile = Omit<Profile, 'seedHint'> & { seed: string }

export interface CreateProfileInput {
  name?: string
  group?: string
  platform?: OSKind
  proxy?: ProxyConfig | null
  /** 传 null 表示按 platform 自动生成一套 */
  fingerprint?: FingerprintConfig | null
}

export interface CloneOptions {
  /** true=换一套全新指纹；false=完全一致（用于同一身份多开） */
  newFingerprint: boolean
  name?: string
}

/* ────────────────────────────── 窗口与标签页 ────────────────────────────── */

export type TrackKind = 'human' | 'shadow'

export interface BrowserTab {
  id: string
  profileId: string
  track: TrackKind
  url: string
  title: string
  favicon?: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** 该标签页是否被 Agent 绑定（影子轨默认绑定） */
  agentBound: boolean
}

export interface WindowState {
  id: string
  profileId: string
  profileName: string
  tabs: BrowserTab[]
  activeTabId: string | null
  bounds: { x: number; y: number; width: number; height: number }
  maximized: boolean
}

/* ────────────────────────────── 任务与步骤 ────────────────────────────── */

export type TaskStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'stopped'

export interface TaskRecord {
  id: string
  profileId: string
  intent: string
  status: TaskStatus
  plan: string[]
  steps: AgentStep[]
  summary: string
  startedAt: number
  finishedAt: number | null
  /** 累计消耗 token，用于成本估算 */
  tokens: number
}

/* ────────────────────────────── 设置 ────────────────────────────── */

export interface Settings {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxSteps: number
  /** true=安全动作自动执行，L2 动作仍要确认 */
  autoRun: boolean
  /** 面板宽度，渲染层用 */
  panelWidth: number
}

export interface TestResult {
  ok: boolean
  endpoint?: string
  latency?: number
  reply?: string
  error?: string
}

export interface SystemInfo {
  appVersion: string
  electron: string
  chrome: string
  node: string
  platform: string
}

/* ────────────────────────────── 代理池 ────────────────────────────── */

export type ProxyProtocol = 'http' | 'https' | 'socks5'

export interface ProxyCheck {
  ok: boolean
  /** 出口 IP */
  ip?: string
  country?: string
  /** 出口所在时区，用于和指纹时区做一致性校验 */
  timezone?: string
  latencyMs?: number
  error?: string
  at: number
}

export interface ProxyRecord {
  id: string
  name: string
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string
  password?: string
  /** 备注地区，仅用于列表筛选 */
  region?: string
  lastCheck: ProxyCheck | null
  createdAt: number
}

export interface ProxyInput {
  name: string
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string
  password?: string
  region?: string
}

/** 一行 `host:port:user:pass` 或 `protocol://user:pass@host:port` */
export interface ProxyImportResult {
  added: number
  skipped: number
  errors: string[]
}

/* ────────────────────────────── 指纹模板 ────────────────────────────── */

export interface FingerprintTemplate {
  id: string
  name: string
  description?: string
  os: OSKind
  fingerprint: FingerprintConfig
  builtin: boolean
  createdAt: number
}

/* ────────────────────────────── 迁移包 ────────────────────────────── */

/**
 * 单条密文。字段与 `core/portable-seed.ts` 的 `SealedBlob` 结构一致。
 *
 * 两处各写一份是有意的，不是漏了复用：`portable-seed.ts` 刻意对 `@shared`
 * 保持零依赖（它要能被 `node --test` 直接跑，加密逻辑如果只能靠「启动整个
 * Electron 再手工点一遍」验证，那它实际上不会被验证）。所以它不能反向
 * 引用这里的类型。漂移由编译器兜住 —— 导出时 `sealer.seal()` 的返回值要
 * 赋给 `sealed` 字段，形状对不上就是编译错误。
 */
export interface BundleSealedBlob {
  /** base64，12 字节 GCM nonce，**每条独立** */
  iv: string
  /** base64，16 字节 GCM tag */
  tag: string
  /** base64，密文 */
  ct: string
}

/** 整个包的 KDF 头。所有条目共用一次 scrypt，靠 HKDF 分离出每条自己的密钥 */
export interface BundleSealHeader {
  v: 2
  kdf: 'scrypt'
  n: number
  r: number
  p: number
  /** base64，16 字节随机盐 */
  salt: string
}

/**
 * v1：只有可见信息，**没有任何身份参数**。
 *
 * 保留这个类型不是为了让新版本还能导出 v1 —— 导出只会产出 v2。它是为了
 * 能**读懂**旧包并把它拦在门外：`version: 1` 的包导入后每个环境都会拿到一套
 * 全新身份，而界面上看不出区别。
 */
export interface MigrationBundleV1 {
  version: 1
  exportedAt: number
  app: string
  profiles: MigrationProfile[]
  proxies: MigrationProxy[]
}

/** v2 的一个环境：明文层只有 `name` / `platform`，身份在 `sealed` 里 */
export interface MigrationBundleEntry {
  name: string
  platform: OSKind
  sealed: BundleSealedBlob
}

/**
 * v2：口令封装的迁移包。
 *
 * 版本号是**必填字段而不是可选开关**。如果写成「有 `entries` 就按 v2 读、
 * 没有就按 v1 读」，那么旧版应用读到 v2 包时会走 v1 分支 —— 而旧版的
 * `parseBundle` 是白名单重建（只取它认识的字段），它会**静默丢掉**整个
 * `entries`，然后按「没有身份」的 v1 语义给用户建出一批新身份，还报成功。
 * 版本号存在，旧版就会明确拒绝；可选字段存在，旧版就会安静地做错事。
 */
export interface MigrationBundleV2 {
  version: 2
  exportedAt: number
  app: string
  header: BundleSealHeader
  entries: MigrationBundleEntry[]
  proxies: MigrationProxy[]
}

export type MigrationBundle = MigrationBundleV1 | MigrationBundleV2

/** 迁移包里的环境（v1 专用：v2 的等价物是 `MigrationBundleEntry`） */
export interface MigrationProfile {
  name: string
  platform: OSKind
  note?: string
  fingerprint: FingerprintConfig
  proxyKey?: string
}

export interface MigrationProxy {
  key: string
  name: string
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string
  /** 导出时留空，导入方自行补齐 */
  password?: string
}

/* ────────────────────────────── 自动化脚本 ────────────────────────────── */

export interface ScriptStep {
  action: ActionType
  url?: string
  /** 录制时的稳定选择器；回放前会重新解析成当次快照的编号 */
  selector?: string
  text?: string
  key?: string
  delayMs?: number
  note?: string
}

export interface AutomationScript {
  id: string
  name: string
  description?: string
  /** 录制来源环境，仅作参考 */
  profileId?: string
  steps: ScriptStep[]
  createdAt: number
  updatedAt: number
}

export interface ScriptRunResult {
  ok: boolean
  executed: number
  total: number
  failedAt?: number
  error?: string
  /**
   * 回放停在某一步等人工确认。
   *
   * 和普通失败的区别是「再跑一次就好」：带上 `startAt: failedAt` 重发，
   * 会从停下的那一步续跑，不重放已经执行过的步骤。
   *
   * 注意这里**没有「确认标记」可以传**：续跑时那一步会重新弹系统确认框，
   * 用户当场点了才跑。原先的 `confirmed: true` 是渲染层自称「用户已同意」，
   * 等于把授权交给可能已被攻破的那一层。
   */
  needsConfirm?: boolean
}

/* ────────────────────────────── 审计日志 ────────────────────────────── */

export interface AuditEntry {
  id: string
  seq: number
  at: number
  actor: string
  action: string
  target?: string
  detail?: string
  /** 上一条的 hash，首条为 64 个 0 */
  prev: string
  hash: string
}

/**
 * 审计链校验结论的分类。
 *
 * 前四种是**结论**：「链有问题，断在这里」。
 * 最后一种 `unreadable` 是**不知道**：文件读不到或已损坏，根本没读到内容 ——
 * 它必须和「断链」在界面上长得不一样。把「读不到」渲染成「链断了」是造一个
 * 假结论；反过来渲染成「正常」则是把一次可能的删除/破坏报成绿灯。
 */
export type AuditVerifyKind =
  | 'head-truncated'
  | 'seq-gap'
  | 'prev-mismatch'
  | 'content-mismatch'
  | 'unreadable'
  /**
   * 尾部被删 / 被替换 / 锚点落后。
   *
   * 和 `head-truncated` 必须分开：那一个是「最老的几条不见了」，链条本身还连着；
   * 这一个是「最新的几条不见了」，剩下的部分**完全自洽** —— 序号连续、prev 全对、
   * 每条 hash 都能重算对上。链内比对永远发现不了它，只有日志外面的锚点能。
   */
  | 'tail-truncated'
  /**
   * 锚点还没建立（升级上来的旧数据，或 settings.json 被删）。
   *
   * 不是「断链」，也不是「通过」：这一轮确实无法判断尾部有没有被删。
   * 界面上必须长得和两者都不一样，否则「删掉 settings.json」就成了一条绕过路径。
   */
  | 'unanchored'

export interface AuditVerifyResult {
  /**
   * 链路自洽吗。**刻意不叫 `ok`。**
   *
   * `preload/index.ts` 用「返回体里有没有 `ok` 字段」判断这是不是 `Result<T>` 包装：
   *
   *     if ('ok' in res) { if (res.ok) return res.data; throw … }
   *
   * 而正常路径主进程的 `handle()` 会把它包成 `{ ok: true, data: <本对象> }` —— 拆一层
   * 刚好。可只要任何一环少包或多包一层（新加通道、手写 handler、测试桩、将来某个
   * wrapper 改动），渲染层拿到的就是 `undefined`，面板里一次属性访问就抛，React 卸载
   * 整棵树 → **审计面板直接空白，用户连报错都看不到**。
   *
   * 改名的第二个理由更根本：一个本身要被 `Result<T>` 包着的对象自己再叫 `ok`，
   * 读代码的人分不清「传输成功」和「校验通过」—— 而断链时这两件事**正好相反**
   * （传输成功、校验失败）。叫 `consistent` 之后 `{ok:true, data:{consistent:false}}`
   * 是自解释的。
   *
   * 更严的做法是判别联合（`{consistent:true} | {consistent:false; kind}`），那样
   * 「`consistent:false` 却没有 `kind`」在类型上写不出来。没这么做的原因是
   * `ChainVerdict` 还要多带一个 `adoptHead`，拆成联合后 `audit.ts` 里
   * `const { adoptHead, ...result } = verdict` 这一句就没法直接满足联合类型，
   * 需要把内核的返回也一起拆成联合 —— 那是独立的一步，不该和这次改名混在一起。
   */
  consistent: boolean
  total: number
  /** 第一条断链的位置，从 1 开始 */
  brokenAt?: number
  /**
   * 断链 / 无法判断的原因。
   *
   * `unreadable` 时**不会**带 `brokenAt` —— 没有「断在第几条」这回事，压根没读到。
   */
  kind?: AuditVerifyKind
  message: string
}

/* ────────────────────────────── 数据健康 ────────────────────────────── */

/**
 * 一个数据文件不可用的完整快照。
 *
 * 和 `StoreCorruptError` 的字段对齐，但这里是**可序列化**的：它要穿过 IPC
 * 到渲染层，Error 实例过不去。
 */
export interface StoreCorruptionInfo {
  /**
   * io = 文件读不到（权限/被占用），数据本身未必有问题
   * crypto = 内容读得出来但解不开（换了机器 / 密钥丢了），文件也没坏
   * 其余 = 内容确实坏了
   */
  kind: 'parse' | 'shape' | 'version' | 'io' | 'crypto'
  file: string
  detail: string
  /** 检测到损坏时留下的字节副本；没留成就是 null（原文件同样没被改动） */
  backupPath: string | null
  at: number
}

export interface StoreFileHealth {
  name: string
  /** 真实绝对路径。数据目录里 `.json` 与无后缀混用，所以只能报路径不能报规则 */
  file: string
  exists: boolean
  /** 盘上实际的 schema 版本（0 = 旧裸格式） */
  schemaVersion: number
  corruption: StoreCorruptionInfo | null
  /** 读已降级成空值、写已全拒。盘上的数据没有被清掉，但界面看不到 */
  degraded: boolean
}

export interface StoreBackupHealth {
  path: string
  name: string
  bytes: number
  at: number
  /** corrupt = 损坏文件的字节副本；preupgrade = 迁移前快照；schema = 旧命名的迁移快照 */
  origin: 'corrupt' | 'preupgrade' | 'schema'
  /**
   * 备份文件里检出的明文 seed 条数。
   *
   * 大于 0 意味着**身份派生根以明文留在了盘上**，而主文件里它已经被加密或已废弃 ——
   * 这类备份是纯负债，但不要自动删（它可能仍是唯一的已知良好快照），只标红让人处理。
   */
  plaintextSeeds: number
}

export interface StoreHealth {
  dataDir: string
  stores: StoreFileHealth[]
  backups: StoreBackupHealth[]
  /** 任一 store 处于损坏 / 只读降级 */
  degraded: boolean
  /** 一句话结论，null = 一切正常 */
  headline: string | null
  /** 逐条给用户看的提示（含该做什么、不该做什么） */
  notes: string[]
}

/* ────────────────────────────── 一致性自检 ────────────────────────────── */

export type CheckSeverity = 'pass' | 'warn' | 'fail'

export interface ConsistencyItem {
  key: string
  label: string
  expected: string
  actual: string
  severity: CheckSeverity
  hint?: string
}

export interface ConsistencyReport {
  profileId: string
  profileName: string
  score: number
  checkedAt: number
  items: ConsistencyItem[]
}

/* ────────────────────────────── 浏览数据 ────────────────────────────── */

export interface CookieItem {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  session: boolean
  expires?: number
}

export type DownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted'

export interface DownloadItem {
  id: string
  profileId: string
  filename: string
  url: string
  savePath: string
  state: DownloadState
  received: number
  total: number
  startedAt: number
}

export interface HistoryItem {
  id: string
  profileId: string
  url: string
  title: string
  at: number
}

/* ────────────────────────────── 本地 API ────────────────────────────── */

export interface LocalApiState {
  running: boolean
  port: number
  /**
   * 这里**故意没有 `token`**。
   *
   * 这个结构会经 `ss:localApi:state` 与 `ss:push:local-api-state` 到达渲染层，
   * 而渲染层是最可能被页面内容攻破的一层。令牌放在这里等于把凭证交给它：
   * 服务还没启动（running:false）时也能读到，于是「启动 + 读令牌 + 带 confirm:true
   * 调 /act」可以全程零人工交互完成。令牌现在只存在主进程内存里，
   * 需要交到用户手上时由主进程写剪贴板。
   */
  startedAt: number | null
  /** 已处理的请求数 */
  requests: number
}

/* ────────────────────────────── 通用 ────────────────────────────── */

/** 所有 IPC 失败统一抛这个形状，renderer 直接展示 message */
export interface IpcError {
  code: string
  message: string
  detail?: string
  /**
   * 结构化补充信息。目前只有 `legacy-identity-loss` 用它列出「导入后会变的具体字段」。
   *
   * 不做成 `Record<string, unknown>` 是有意的：那个类型的每个读取点都要
   * 自己校验，而校验漏掉的表现是「界面上少了一栏」，不会报错。
   */
  lostFields?: string[]
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: IpcError }
