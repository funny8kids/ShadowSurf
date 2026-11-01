/**
 * 任务历史。
 *
 * 只做追加 + 覆盖，不做分页：这是「最近发生了什么」的视图，不是审计日志。
 * 上限 200 条，按 startedAt 淘汰最老的——再多的历史对用户没有价值，
 * 却会让每次读盘越来越慢。
 */

import type { TaskRecord } from '@shared/types'
import { JsonStore } from './db'
import type { HealthStoreRef } from './health'
import { StoreCorruptError } from './json-file'

const MAX_TASKS = 200

/**
 * 任务历史：形状不对的条目丢掉。
 *
 * 和 profiles 的严格校验不同，这里**刻意宽容**：任务历史是「最近发生了什么」
 * 的视图，不是审计凭据。丢一条的代价只是少一行展示，而严格模式会让一条
 * 写坏的历史记录把整份文件判成损坏、连带拒绝所有写入 —— 对这份数据的价值
 * 来说不划算。真正需要「一条都不能少」的是 audit（有哈希链）和 profiles
 * （丢了就是丢身份），那两个走严格校验。
 *
 * 丢的时候至少要说一声：静默 filter 是这份代码里最容易被忽略的一类丢数据。
 */
function migrateTasks(data: unknown, _schema: number, file: string): TaskRecord[] {
  if (!Array.isArray(data)) {
    // 文件级形状错误不能宽容：`list()` 里那句 `.slice()` 会抛一个看不出根因的 TypeError
    throw new StoreCorruptError('shape', file, `期望数组，实际是 ${data === null ? 'null' : typeof data}`)
  }

  const kept = data.filter((item): item is TaskRecord => {
    if (item === null || typeof item !== 'object') return false
    const rec = item as Record<string, unknown>
    return typeof rec.id === 'string' && typeof rec.startedAt === 'number'
  })

  const dropped = data.length - kept.length
  if (dropped > 0) {
    console.warn(`[store] tasks.json 有 ${String(dropped)} 条记录形状不对，已跳过（文件：${file}）`)
  }
  return kept
}

export class TaskStore {
  private readonly store = new JsonStore<TaskRecord[]>('tasks.json', () => [], migrateTasks)

  /** 健康快照用：真实路径 / 版本 / 损坏状态 */
  get health(): HealthStoreRef {
    return {
      name: 'tasks',
      file: this.store.filePath,
      schemaVersion: this.store.schemaVersion,
      corruption: this.store.corruption
    }
  }

  list(): TaskRecord[] {
    const all = this.store.read().slice()
    all.sort((a, b) => b.startedAt - a.startedAt)
    return all.map((t) => structuredClone(t))
  }

  get(id: string): TaskRecord | null {
    const hit = this.store.read().find((t) => t.id === id)
    return hit === undefined ? null : structuredClone(hit)
  }

  add(task: TaskRecord): void {
    this.store.update((draft) => {
      draft.push(structuredClone(task))
      if (draft.length > MAX_TASKS) {
        draft.sort((a, b) => a.startedAt - b.startedAt)
        draft.splice(0, draft.length - MAX_TASKS)
      }
    })
  }

  update(id: string, patch: Partial<TaskRecord>): void {
    this.store.update((draft) => {
      const i = draft.findIndex((t) => t.id === id)
      if (i < 0) return
      // id 不允许被 patch 覆盖，否则历史记录会指向不存在的任务
      draft[i] = { ...draft[i], ...patch, id: draft[i].id }
    })
  }

  clear(): void {
    this.store.write([])
  }
}
