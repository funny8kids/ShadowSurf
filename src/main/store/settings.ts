/**
 * 应用设置。
 *
 * API Key 是这份文件里唯一敏感的东西，所以落盘前用 Electron 的 safeStorage 加密
 * （Windows 走 DPAPI、macOS 走 Keychain、Linux 走 libsecret/kwallet）。
 * 加密不可用（例如 Linux 无 keyring、或用户用 --password-store=basic 启动）时
 * 降级为明文存盘——这里刻意不抛异常：宁可让用户能用，也不能让应用起不来。
 * 落盘格式用 'enc:' / 'raw:' 前缀区分，读到旧版本裸字符串时按明文兼容。
 */

import { safeStorage } from 'electron'
import { DEFAULT_SETTINGS } from '@shared/presets'
import type { Settings } from '@shared/types'
import { JsonStore } from './db'
import type { HealthStoreRef } from './health'

/**
 * 审计链的尾部锚点：最后一条记录的序号与哈希。
 *
 * 存在 settings.json 里（和 audit.json 分开），因为「日志的最后一条是什么」这件事
 * 必须记在日志**外面**才有用 —— 记在日志里等于没记：把整份文件删掉，剩下的部分
 * 照样自洽。原先 `verifyAudit()` 在链为空时返回 `ok: true`，于是最省事的销毁痕迹
 * 不是改记录，而是 `rm audit.json`，删完系统还说「完整性正常」。
 *
 * 它挡两类删除，两者原先都静默通过：
 *   1. 整份 audit.json 被删 → 读成「首次运行」，链为空 → ok:true
 *   2. 尾部若干条被删 → 剩下的 1..n-k 序号连续、prev 自洽 → ok:true
 *
 * 挡不住的：能同时改 audit.json 和 settings.json 的攻击者（两边一起对齐即可），
 * 以及能重算整条链的人（摘要是无密钥 sha256）。这两条是已知限制，写在校验结论里，
 * 不再用「删改任何一条都会被校验发现」这种全称承诺。
 */
export interface AuditHead {
  seq: number
  hash: string
}

/** 存盘形状：除 apiKey 外与 Settings 一致，apiKey 变成带前缀的字符串 */
type StoredSettings = Omit<Settings, 'apiKey'> & {
  apiKey: string
  /** 尾部锚点。null = 从未建立过（首次运行，或升级上来的旧数据） */
  auditHead: AuditHead | null
}

const ENC_PREFIX = 'enc:'
const RAW_PREFIX = 'raw:'

function asString(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function asBoolean(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

/**
 * 锚点的形状校验。
 *
 * 不合法一律当 null —— 但 null 在校验时**不是通过**：日志非空而锚点为空会被判成
 * 「未锚定」，要求重新建立并明说「此前的尾部无法验证」。这比「猜一个值继续」重要：
 * 猜错会让一次真实的尾部删除被读成「锚点本来就这样」。
 *
 * 为什么必须显式校验而不是 `as AuditHead`：`migrateSettings` 是**白名单**式的，
 * 少写一个字段不会报错，只会让这个字段每次读都被丢掉 —— 表现是「锚点永远为 null」，
 * 于是整条防线静默失效，而校验页面看起来一切正常。
 */
function asAuditHead(value: unknown): AuditHead | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const rec = value as Record<string, unknown>
  const seq = rec.seq
  const hash = rec.hash
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return null
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null
  return { seq, hash }
}

/**
 * 缺字段自动补齐：用户手改过配置文件、或版本升级加了新字段时都能平滑过渡。
 *
 * 这里刻意**不抛异常**，和 profiles 的严格校验不同：settings 里除了
 * `auditHead` 之外没有任何不可再生的东西（apiKey 丢了要用户重填，其余全是默认值
 * 可覆盖），而它又是应用启动后第一批被读的数据 —— 让一个打错的字段把整个界面卡住
 * 不划算。真正会丢数据的那类 store（profiles / audit）才必须严格。
 *
 * `auditHead` 是这条规则的一个例外，而且代价是单向的：把它判成 null 之后，
 * 校验会报「未锚定」而不是「通过」—— 也就是说这条规则的方向是 fail-closed，
 * 丢掉锚点只会让校验变严，不会让它变松。
 */
function migrateSettings(data: unknown): StoredSettings {
  const rec: Record<string, unknown> =
    data !== null && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {}

  const storedKey = rec.apiKey
  let apiKey: string
  if (typeof storedKey !== 'string' || storedKey.length === 0) {
    apiKey = ''
  } else if (storedKey.startsWith(ENC_PREFIX) || storedKey.startsWith(RAW_PREFIX)) {
    apiKey = storedKey
  } else {
    // 旧版本是明文存的，包上前缀，下次 set 时会自动加密
    apiKey = RAW_PREFIX + storedKey
  }

  return {
    provider: asString(rec.provider, DEFAULT_SETTINGS.provider),
    baseUrl: asString(rec.baseUrl, DEFAULT_SETTINGS.baseUrl),
    apiKey,
    model: asString(rec.model, DEFAULT_SETTINGS.model),
    temperature: asNumber(rec.temperature, DEFAULT_SETTINGS.temperature),
    maxSteps: asNumber(rec.maxSteps, DEFAULT_SETTINGS.maxSteps),
    autoRun: asBoolean(rec.autoRun, DEFAULT_SETTINGS.autoRun),
    panelWidth: asNumber(rec.panelWidth, DEFAULT_SETTINGS.panelWidth),
    // 注意：这一项是**白名单里唯一不可再生的东西**（见上面 auditHead 的注释）。
    // 丢掉它不会报错，只会让尾部删除检测静默失效 —— 所以这里宁可判成 null 并让
    // 校验报「未锚定」，也不要猜一个值出来。
    auditHead: asAuditHead(rec.auditHead)
  }
}

function encryptKey(plain: string): string {
  if (plain.length === 0) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
    }
  } catch {
    /* 加密后端异常，走明文降级 */
  }
  return RAW_PREFIX + plain
}

function decryptKey(stored: string): string {
  if (stored.length === 0) return ''
  if (stored.startsWith(RAW_PREFIX)) return stored.slice(RAW_PREFIX.length)
  if (!stored.startsWith(ENC_PREFIX)) return stored
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
  } catch {
    // 换了机器 / 换了系统账户就解不开了，当作没配 Key，让用户重填
    return ''
  }
}

/** UI 回传的打码值不能被当成真 Key 写回去 */
function isMasked(value: string): boolean {
  return value.includes('…') || value.includes('***') || value.includes('•')
}

export class SettingsStore {
  private readonly store = new JsonStore<StoredSettings>(
    'settings.json',
    // auditHead 必须显式给：DEFAULT_SETTINGS 是 Settings 类型，不含锚点。
    // 漏了它类型检查会拦下（比运行时才发现好）。
    () => ({ ...DEFAULT_SETTINGS, auditHead: null }),
    migrateSettings
  )

  /** 健康快照用：真实路径 / 版本 / 损坏状态 */
  get health(): HealthStoreRef {
    return {
      name: 'settings',
      file: this.store.filePath,
      schemaVersion: this.store.schemaVersion,
      corruption: this.store.corruption
    }
  }

  get(): Settings {
    const stored = this.store.read()
    return {
      provider: stored.provider,
      baseUrl: stored.baseUrl,
      model: stored.model,
      temperature: stored.temperature,
      maxSteps: stored.maxSteps,
      autoRun: stored.autoRun,
      panelWidth: stored.panelWidth,
      apiKey: decryptKey(stored.apiKey)
    }
  }

  set(patch: Partial<Settings>): Settings {
    const current = this.store.read()
    const { apiKey: incomingKey } = patch

    // 逐字段取，不用 `{ ...current, ...patch }`。
    //
    // 理由不是风格：`auditHead` 不在 `Settings` 里，但渲染层只要塞一个
    // `auditHead` 进来，spread 就会把它原样写盘 —— 那等于让「清掉链头锚点」
    // 变成一次普通的设置保存，而清掉锚点正是让尾部删除检测失效的那一步。
    // 白名单取字段之后，这个字段只有 `setAuditHead()` 一条写入路径。
    const next: StoredSettings = {
      provider: patch.provider ?? current.provider,
      baseUrl: patch.baseUrl ?? current.baseUrl,
      apiKey: current.apiKey,
      model: patch.model ?? current.model,
      temperature: patch.temperature ?? current.temperature,
      maxSteps: patch.maxSteps ?? current.maxSteps,
      autoRun: patch.autoRun ?? current.autoRun,
      panelWidth: patch.panelWidth ?? current.panelWidth,
      auditHead: current.auditHead
    }
    // 传了打码值 = 用户没动 Key，保持原密文不动（避免每存一次设置就重写一次密钥）
    if (incomingKey !== undefined && !isMasked(incomingKey)) {
      next.apiKey = encryptKey(incomingKey)
    }

    this.store.write(next)
    return this.get()
  }

  /** 审计链的尾部锚点。null = 从未建立过。刻意不放进 `Settings`：渲染层无从编辑它 */
  getAuditHead(): AuditHead | null {
    return this.store.read().auditHead
  }

  /**
   * 更新锚点。**刻意不抛异常。**
   *
   * 调用方是 `appendAudit()`：审计记录已经追加成功了，这时如果因为 settings.json
   * 不可写而抛错，会把一次成功的记录说成失败 —— 更糟的是 L2 闸门把「审计不可用」
   * 当成拒绝执行的理由，于是记录写不进去就变成了动作不能执行。
   *
   * 代价说清楚：锚点会落后于日志，下次校验报「锚点落后」而不是「通过」——
   * 那是可见的、可自愈的（下一次追加会自动对齐），比让审计写入变成会失败的操作好。
   */
  setAuditHead(head: AuditHead): void {
    const current = this.store.read()
    const prev = current.auditHead
    if (prev !== null && prev.seq === head.seq && prev.hash === head.hash) return
    try {
      this.store.write({ ...current, auditHead: head })
    } catch (err) {
      console.error(
        '[settings] 审计链头锚点没能落盘，下次校验会报「锚点落后」：' +
          (err instanceof Error ? err.message : String(err))
      )
    }
  }

  /** 给 UI 用：`sk-…a1b2`。宁可暴露首尾几位，也不把完整 Key 送进渲染进程 */
  maskedKey(): string {
    const key = this.get().apiKey
    if (key.length === 0) return ''
    if (key.length <= 8) return '…' + key.slice(-4)
    return key.slice(0, 3) + '…' + key.slice(-4)
  }
}
