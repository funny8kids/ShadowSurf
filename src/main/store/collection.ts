/**
 * 通用集合存储。
 *
 * 代理池、模板、脚本、审计日志这些域的数据形状都是「一组带 id 的对象」，
 * 没必要每个都手写一遍读写。统一走这里，行为一致：
 * - 原子写（JsonStore 保证）
 * - 读出来的永远是副本，调用方乱改不会污染缓存
 * - 上限保护：审计日志这类会无限增长的数据必须传 maxItems
 */

import { JsonStore } from './db'
import type { CorruptInfo } from './json-file'
import { validateArray } from './json-file'
import type { HealthStoreRef } from './health'
import { evictInPlace } from './evict'

export interface Entity {
  id: string
}

export interface CollectionOptions<T> {
  /**
   * 淘汰保护：返回 true 的记录不会被容量裁剪掉。
   *
   * 为什么需要它：审计日志的上限是 5000 条，按时间从头丢最旧的。但闸门记录
   * （「谁批准了这笔支付」）恰恰是最不该丢的 —— 一次高频 API 自动化跑几十万步，
   * 就能把自己之前所有闸门记录挤出窗口，而且过程完全无声：`verifyChain` 看到
   * 链头 prev 指向已裁掉的记录，会当成「正常裁剪」放行。
   *
   * 注意这里**只保护记录，不拆存储**。把闸门事件放到独立 store 会让哈希链断成
   * 两条，`seq` 也不再连续 —— 那比丢记录更糟，因为它看起来还是完整的。
   */
  retain?: (item: T) => boolean
}

export class CollectionStore<T extends Entity> {
  private readonly store: JsonStore<T[]>
  private readonly maxItems: number
  private readonly retain: ((item: T) => boolean) | undefined
  private readonly name: string

  constructor(name: string, maxItems = 0, options: CollectionOptions<T> = {}) {
    // JsonStore 构造器自己会调 filePath()，这里只能传裸文件名，
    // 否则会拼成 <dataDir>\<dataDir>\xxx.json 这种双层路径
    //
    // 校验只做「必须是数组」这一层：集合里存什么形状由各模块自己负责，
    // 但文件级形状错（例如手改成 `{}`）必须在读的时候就判成损坏 ——
    // 否则 `list()` 里那句 `.slice()` 会抛一个完全看不出根因的 TypeError。
    this.store = new JsonStore<T[]>(name, () => [], (data, _schema, file) => validateArray<T>(data, file))
    this.maxItems = maxItems
    this.retain = options.retain
    this.name = name
  }

  /**
   * 非 null 表示这个集合的数据文件不可用（损坏 / 读不到）。
   *
   * 透出去是为了让上层能把它变成「可见」：`audit.list()` 在损坏时降级成 `[]`，
   * 而 `verifyAudit()` 看到空列表会返回 `ok: true`「链路为空」—— 也就是说
   * 「有人删了审计文件」在 UI 上显示为「链路完整」。消费方必须能问到这里。
   */
  get corruption(): CorruptInfo | null {
    return this.store.corruption
  }

  /** 健康快照用：真实路径 / 版本 / 损坏状态 */
  get health(): HealthStoreRef {
    return {
      name: this.name,
      file: this.store.filePath,
      schemaVersion: this.store.schemaVersion,
      corruption: this.store.corruption
    }
  }

  /**
   * 列表。**返回的是快照**：每个元素都克隆过。
   *
   * 为什么必须克隆：`read()` 命中缓存时返回的是 `this.cache` 本身，
   * 而 `list()` 原先只是 `.slice()` —— 数组是新的，**元素不是**。
   * 于是调用方写一句 `record.enabled = true`，缓存就被就地改掉了，
   * 盘上却没变：界面显示的值和盘上的值分叉，
   * 而下一次**任何**无关的 update()（内部是 `clone(this.read())`）
   * 会把这次偷偷的修改落盘。
   *
   * 这种 bug 的症状是"我明明没改这个字段，它怎么变了"——
   * 极难定位，所以从读边界就堵掉。
   */
  list(): T[] {
    return this.store.read().map((item) => structuredClone(item))
  }

  /**
   * 列表（**不克隆**）。只给内部只读路径用。
   *
   * 存在的理由：审计有 5000 条、每次落盘都要读全量，
   * 克隆 5000 条是要花钱的（几毫秒的同步阻塞）。
   * 而那些路径只读不改 —— 用完即弃。
   *
   * 约定：**调用方不得修改返回值，也不得把其中的元素存起来**。
   * 要留就用 `list()`（克隆版）。
   */
  listRaw(): T[] {
    return this.store.read().slice()
  }

  /** 按 id 取一条。**返回的是快照**（同 list() 的理由） */
  get(id: string): T | null {
    const hit = this.store.read().find((item) => item.id === id)
    return hit === undefined ? null : structuredClone(hit)
  }

  add(item: T): T {
    this.store.update((draft) => {
      draft.push(item)
      evictInPlace(draft, this.maxItems, this.retain)
    })
    return item
  }

  update(id: string, patch: Partial<T>): T {
    let result: T | null = null
    this.store.update((draft) => {
      const index = draft.findIndex((item) => item.id === id)
      if (index < 0) throw new Error(`记录不存在：${id}`)
      draft[index] = { ...draft[index], ...patch, id }
      result = draft[index]
    })
    if (result === null) throw new Error(`记录不存在：${id}`)
    return result
  }

  remove(id: string): void {
    this.store.update((draft) => {
      const index = draft.findIndex((item) => item.id === id)
      if (index >= 0) draft.splice(index, 1)
    })
  }

  replaceAll(items: T[]): void {
    this.store.write(items.slice())
  }

  clear(): void {
    this.store.write([])
  }

  /** 生成 `<prefix>_<12 位>` 形式的短 ID */
  static newId(prefix: string): string {
    const alphabet = '23456789abcdefghjkmnpqrstuvwxyz'
    let out = ''
    for (let i = 0; i < 12; i += 1) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)]
    }
    return `${prefix}_${out}`
  }
}
