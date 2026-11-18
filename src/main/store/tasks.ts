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
 * 摘要视图每条最多保留的步数：前 5 步 + 后 5 步。
 *
 * 为什么只留头尾：列表页真正要回答的是「这条任务是什么、跑成什么样、花了多久」，
 * 中间的步骤对这三个问题没有贡献；而完整 steps 是这份数据里最占体积的部分
 * （每步带 label / thought / result）。200 条任务 × 25 步 ≈ 3.77MB，
 * 每次读列表都要 structuredClone 一遍再走一次 IPC 序列化。
 *
 * 详情必须能拿到全量 —— 走 `get(id)`，那里从不裁剪。
 */
const LIST_STEPS_HEAD = 5
const LIST_STEPS_TAIL = 5

/**
 * 把一条任务裁成摘要：只保留头 `LIST_STEPS_HEAD` 步 + 尾 `LIST_STEPS_TAIL` 步。
 *
 * 加 `truncated` 标记不是为了好看：静默少给数据是这份代码里最容易被忽略的一类错误，
 * 消费方（列表 / 导出）看到标记才知道「这不是全部，要全量去 get」。
 * 步数不足时原样返回，不做无意义的标记。
 */
function truncateSteps(task: TaskRecord): TaskRecord {
  const { steps, ...rest } = task
  if (steps.length <= LIST_STEPS_HEAD + LIST_STEPS_TAIL) return structuredClone(task)
  // 只克隆留下来的步骤：整份 structuredClone 再丢掉 2/3 是白花开销
  const kept = [...steps.slice(0, LIST_STEPS_HEAD), ...steps.slice(-LIST_STEPS_TAIL)].map((s) =>
    structuredClone(s)
  )
  // 用 Object.assign 而不是对象字面量：`truncated` 不在 TaskRecord 里，
  // 直接写进字面量会被 TS 的多余属性检查拦下（类型文件本次不改）。
  return Object.assign({ ...structuredClone(rest), steps: kept }, { truncated: true })
}

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

  /**
   * 列表读取。
   *
   * `includeSteps = false` 时每条只保留前 5 + 后 5 步并打上 `truncated` 标记
   * （见 `truncateSteps`），用于「只要列表、不要时间线」的场景。
   *
   * 默认仍然是全量：TaskList 的回放时间线和 ScriptPanel 的「从任务导入」都直接
   * 读 `list()` 里的 steps，静默截断会让这两处少掉步骤 —— 那属于改功能语义。
   * 所以摘要是一条**显式**通道（`listSummary()`），等渲染层改成「列表读摘要、
   * 点开再 `get(id)`」之后再把调用点切过去，而不是在这里替所有调用方做决定。
   */
  list(includeSteps: boolean = true): TaskRecord[] {
    const all = this.store.read().slice()
    all.sort((a, b) => b.startedAt - a.startedAt)
    return all.map((t) => (includeSteps ? structuredClone(t) : truncateSteps(t)))
  }

  /** 列表摘要：等价于 `list(false)`，给「只看列表」的调用方用 */
  listSummary(): TaskRecord[] {
    return this.list(false)
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
