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
import type { HealthStoreRef } from './health'
import type {
  ProxyRecord,
  ProxyGroup,
  WebhookRecord,
  FingerprintTemplate,
  AutomationScript,
  AuditEntry,
  HistoryItem,
  TeamMember,
  TeamActivity,
  TeamProfileShare,
  ExtensionRecord,
  ScheduleRecord
} from '@shared/types'

/**
 * 分享记录的存储形态：`CollectionStore` 要求每条有 `id`，
 * 而 `TeamProfileShare` 的天然主键是 (profileId, memberId) 组合。
 * 这里补一个稳定的复合 id，对外仍按 `TeamProfileShare` 暴露（去掉 id）。
 */
export type TeamShareRecord = TeamProfileShare & { id: string }

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
  /** 本地团队成员（LOCAL-ONLY，无登录/无云端） */
  members: CollectionStore<TeamMember>
  /** 本地团队活动日志，append-only，上限 2000 条 */
  activity: CollectionStore<TeamActivity>
  /** 环境对成员的本地授权，复合 id = `${profileId}::${memberId}` */
  shares: CollectionStore<TeamShareRecord>
  /** 本地扩展目录清单（只存路径与开关，不存扩展本体） */
  extensions: CollectionStore<ExtensionRecord>
  /** 定时任务（启动环境 / 跑脚本） */
  schedules: CollectionStore<ScheduleRecord>
  /** 代理组：一组出口，按策略轮换 / 故障转移 */
  proxyGroups: CollectionStore<ProxyGroup>
  /** Webhook：任务 / 定时结果回调 */
  webhooks: CollectionStore<WebhookRecord>
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
      history: new CollectionStore<HistoryItem>('history', 2000),
      members: new CollectionStore<TeamMember>('team-members'),
      activity: new CollectionStore<TeamActivity>('team-activity', 2000),
      shares: new CollectionStore<TeamShareRecord>('team-shares'),
      extensions: new CollectionStore<ExtensionRecord>('extensions'),
      schedules: new CollectionStore<ScheduleRecord>('schedules'),
      /** 代理组：一组出口，按策略轮换 / 故障转移 */
      proxyGroups: new CollectionStore<ProxyGroup>('proxy-groups'),
      /** Webhook：任务 / 定时结果回调 */
      webhooks: new CollectionStore<WebhookRecord>('webhooks')
    }
  }
  return instance
}

/**
 * 健康面板的 store 引用表。
 *
 * 为什么每个 ref 都带 `touch`：`HealthStoreRef.corruption` 是**上一次读盘**
 * 留下的判定，不是对文件当前内容的探测。应用刚启动、某个 store 还没被读过时
 * 它恒为 null —— 于是一个已经损坏（读出来是空列表）的数据文件会被报成
 * 「一切正常」。touch 让 collectStoreHealth 在取 corruption 之前先读一次盘，
 * 把「文件坏了」这个事实变成可见的。
 *
 * `corruption` 用 getter 而不是在构造时取快照：读盘发生在 touch 之后，
 * 快照会永远停在 null 上。
 */
function refWithTouch(health: () => HealthStoreRef, touch: () => void): HealthStoreRef {
  const base = health()
  return {
    name: base.name,
    file: base.file,
    schemaVersion: base.schemaVersion,
    get corruption() {
      return health().corruption
    },
    touch
  }
}

/**
 * 健康面板的 store 引用表。
 *
 * **必须覆盖全部 store，不能手写白名单。**
 *
 * 原先这里只列了 8 个，另外 7 个（members / activity / shares / extensions /
 * schedules / proxyGroups / webhooks）不在检查范围内。后果不是"少看几个文件"，
 * 而是：这些文件损坏时 `read()` 会走 quarantine 降级成 `[]`，
 * 调用方（webhooks / scheduler / 团队模块）又不查 corruption，
 * 于是界面显示「尚未配置 Webhook / 还没有定时任务」，
 * 健康横幅因为根本没检查这些文件而一直显示「一切正常」。
 *
 * 数据在盘上完好，用户却以为从没配过 —— 然后重新配一遍。
 *
 * 所以这里的清单跟着 `Stores` 走（`Object.entries`），而不是手写一遍：
 * 新增 store 的人只要加了字段，这里自动覆盖；手写白名单一定会漏。
 */
export function healthRefs(stores: Stores): HealthStoreRef[] {
  const refs: HealthStoreRef[] = []
  for (const value of Object.values(stores)) {
    const store = value as {
      health?: HealthStoreRef
      list?: () => unknown
      get?: () => unknown
    }
    // ProfileStore / TaskStore / SettingsStore 有自己的 health（字段更细），
    // CollectionStore 也有。理论上每个 store 都有 —— 但这里仍然做一次防御：
    // 少一个 store 引用不该让整个健康面板变成空白页。
    if (typeof store.health !== 'object' || store.health === null) continue
    const touch =
      typeof store.list === 'function'
        ? () => store.list!()
        : typeof store.get === 'function'
          ? () => store.get!()
          : () => undefined
    refs.push(refWithTouch(() => store.health!, touch))
  }
  return refs
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
