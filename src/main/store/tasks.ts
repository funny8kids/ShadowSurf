/**
 * 任务历史。
 *
 * 只做追加 + 覆盖，不做分页：这是「最近发生了什么」的视图，不是审计日志。
 * 上限 200 条，按 startedAt 淘汰最老的——再多的历史对用户没有价值，
 * 却会让每次读盘越来越慢。
 */

import type { TaskRecord } from '@shared/types'
import { JsonStore } from './db'

const MAX_TASKS = 200

function migrateTasks(raw: unknown): TaskRecord[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is TaskRecord => {
    if (item === null || typeof item !== 'object') return false
    const rec = item as Record<string, unknown>
    return typeof rec.id === 'string' && typeof rec.startedAt === 'number'
  })
}

export class TaskStore {
  private readonly store = new JsonStore<TaskRecord[]>('tasks.json', () => [], migrateTasks)

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
