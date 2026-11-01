/**
 * Store 装配入口。
 *
 * 单例而不是每次 new：JsonStore 内部有内存缓存，重复实例化会让缓存互相打架
 * （A 写了盘，B 的旧缓存还以为自己是最新的）。
 * 所有模块统一从这里拿，保证整个主进程只有一份状态。
 */

import { ProfileStore } from './profiles'
import { SettingsStore } from './settings'
import { TaskStore } from './tasks'
import { CollectionStore } from './collection'
import type { ProxyRecord, FingerprintTemplate, AutomationScript, AuditEntry, HistoryItem } from '@shared/types'

export interface Stores {
  profiles: ProfileStore
  tasks: TaskStore
  settings: SettingsStore
  proxies: CollectionStore<ProxyRecord>
  templates: CollectionStore<FingerprintTemplate>
  scripts: CollectionStore<AutomationScript>
  /** 审计日志只增不改，上限 5000 条，超出丢最旧的 —— 闸门记录除外，见 AUDIT_RETAIN */
  audit: CollectionStore<AuditEntry>
  history: CollectionStore<HistoryItem>
}

/**
 * 闸门类审计记录的 action 前缀。
 *
 * 放在 store 而不是 modules/audit.ts，是因为写入方和淘汰策略都要用它：
 * audit.ts 已经要从 store 拿 `Stores`，让 store 反过来 import audit 会成环。
 * 这个常量是那个环上唯一的共享点，所以下沉到这里。
 */
export const GATE_ACTION_PREFIX = '闸门·'

/**
 * 淘汰保护：闸门记录永不因容量被裁。
 *
 * 原先的行为是「超 5000 条丢最旧的」。问题在于闸门记录恰好是最该留的：
 * 一次高频 API 自动化跑几十万步，就能把自己之前所有「谁批准了这笔支付」
 * 挤出窗口 —— 而且完全无声，`verifyChain` 看到链头 prev 指向已裁掉的记录
 * 会当成正常裁剪放行。也就是说这个缺口不会让任何门禁变红，只会让事后
 * 追责的时候发现记录不见了。
 *
 * 只保护记录、不拆存储：独立 store 会把哈希链断成两条，`seq` 也不再连续，
 * 那比丢记录更糟 —— 它看起来还是完整的。
 */
const AUDIT_RETAIN = (e: AuditEntry): boolean => e.action.startsWith(GATE_ACTION_PREFIX)

let instance: Stores | null = null

export function getStores(): Stores {
  if (instance === null) {
    instance = {
      profiles: new ProfileStore(),
      tasks: new TaskStore(),
      settings: new SettingsStore(),
      proxies: new CollectionStore<ProxyRecord>('proxies'),
      templates: new CollectionStore<FingerprintTemplate>('templates'),
      scripts: new CollectionStore<AutomationScript>('scripts'),
      audit: new CollectionStore<AuditEntry>('audit', 5000, { retain: AUDIT_RETAIN }),
      history: new CollectionStore<HistoryItem>('history', 2000)
    }
  }
  return instance
}

export { ProfileStore } from './profiles'
export { TaskStore } from './tasks'
export { SettingsStore } from './settings'
export { CollectionStore } from './collection'
export { JsonStore, dataDir, filePath, SCHEMA_CURRENT, StoreCorruptError } from './db'
export type { CorruptInfo, StoreRead } from './db'
export { collectStoreHealth } from './health'
export type { HealthStoreRef } from './health'
export { sealLegacyBackups } from './legacy-backups'
export type { LegacySealResult } from './legacy-backups'
