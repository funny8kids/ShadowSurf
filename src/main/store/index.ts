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
  /** 审计日志只增不改，上限 5000 条，超出丢最旧的 */
  audit: CollectionStore<AuditEntry>
  history: CollectionStore<HistoryItem>
}

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
      audit: new CollectionStore<AuditEntry>('audit', 5000),
      history: new CollectionStore<HistoryItem>('history', 2000)
    }
  }
  return instance
}

export { ProfileStore } from './profiles'
export { TaskStore } from './tasks'
export { SettingsStore } from './settings'
export { CollectionStore } from './collection'
export { JsonStore, dataDir, filePath } from './db'
