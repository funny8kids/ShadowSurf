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

export interface Entity {
  id: string
}

export class CollectionStore<T extends Entity> {
  private readonly store: JsonStore<T[]>
  private readonly maxItems: number

  constructor(name: string, maxItems = 0) {
    // JsonStore 构造器自己会调 filePath()，这里只能传裸文件名，
    // 否则会拼成 <dataDir>\<dataDir>\xxx.json 这种双层路径
    this.store = new JsonStore<T[]>(name, () => [])
    this.maxItems = maxItems
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
      if (this.maxItems > 0 && draft.length > this.maxItems) {
        // 超出上限从头部丢弃：调用方按时间正序追加，头部就是最旧的
        draft.splice(0, draft.length - this.maxItems)
      }
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
