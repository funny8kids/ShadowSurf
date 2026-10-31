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

/** 存盘形状：除 apiKey 外与 Settings 一致，apiKey 变成带前缀的字符串 */
type StoredSettings = Omit<Settings, 'apiKey'> & { apiKey: string }

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

/** 缺字段自动补齐：用户手改过配置文件、或版本升级加了新字段时都能平滑过渡 */
function migrateSettings(raw: unknown): StoredSettings {
  const rec: Record<string, unknown> =
    raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}

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
    panelWidth: asNumber(rec.panelWidth, DEFAULT_SETTINGS.panelWidth)
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
    () => ({ ...DEFAULT_SETTINGS }),
    migrateSettings
  )

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
    const { apiKey: incomingKey, ...rest } = patch

    const next: StoredSettings = { ...current, ...rest }
    // 传了打码值 = 用户没动 Key，保持原密文不动（避免每存一次设置就重写一次密钥）
    if (incomingKey !== undefined && !isMasked(incomingKey)) {
      next.apiKey = encryptKey(incomingKey)
    }

    this.store.write(next)
    return this.get()
  }

  /** 给 UI 用：`sk-…a1b2`。宁可暴露首尾几位，也不把完整 Key 送进渲染进程 */
  maskedKey(): string {
    const key = this.get().apiKey
    if (key.length === 0) return ''
    if (key.length <= 8) return '…' + key.slice(-4)
    return key.slice(0, 3) + '…' + key.slice(-4)
  }
}
