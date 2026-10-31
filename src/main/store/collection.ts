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

  constructor(name: string, maxItems = 0, options: CollectionOptions<T> = {}) {
    // JsonStore 构造器自己会调 filePath()，这里只能传裸文件名，
    // 否则会拼成 <dataDir>\<dataDir>\xxx.json 这种双层路径
    this.store = new JsonStore<T[]>(name, () => [])
    this.maxItems = maxItems
    this.retain = options.retain
  }

  list(): T[] {
    return this.store.read().slice()
  }

  get(id: string): T | null {
    return this.store.read().find((item) => item.id === id) ?? null
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
