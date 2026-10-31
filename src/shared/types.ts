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
  /** 指纹种子（hex）。由 masterKey + id 经 HKDF 派生，不可手工编辑 */
  seed: string
  fingerprint: FingerprintConfig
  proxy: ProxyConfig | null
  tags: string[]
  note: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
  /** 最近一次启动失败的原因，status==='error' 时有值 */
  lastError?: string
}

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

export interface MigrationBundle {
  version: 1
  exportedAt: number
  app: string
  profiles: MigrationProfile[]
  proxies: MigrationProxy[]
}

/** 迁移包里的环境：不含 apiKey、不含明文代理密码（用 key 占位） */
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
   * 和普通失败的区别是「再跑一次就好」：带上 `confirmed: true` 和
   * `startAt: failedAt` 重发，会从停下的那一步续跑，不重放已经执行过的步骤。
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

export interface AuditVerifyResult {
  ok: boolean
  total: number
  /** 第一条断链的位置，从 1 开始 */
  brokenAt?: number
  message: string
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
  /** 访问令牌，客户端放 Authorization: Bearer <token> */
  token: string
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
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: IpcError }
