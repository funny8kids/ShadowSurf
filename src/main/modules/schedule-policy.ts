/**
 * 定时任务的纯调度规则。
 *
 * 这里只回答「什么时候该跑」，不碰 Electron / 存储 / IPC —— 调度器
 * （scheduler.ts）只负责按结论执行，规则本身可以被 node:test 直接覆盖。
 *
 * ── 时区 ──
 * 用户填的 "09:00" 指的是**他自己时钟上的 09:00**，所以每日模式一律用
 * `new Date()` 的本地年月日时分来构造，不换算成 UTC。用 UTC 的话，
 * 东八区用户填的 09:00 会在 17:00 触发。
 */

import type { ScheduleRecord } from '@shared/types'

/** HH:MM，24 小时制。小时必须两位（00–23），分钟必须两位（00–59） */
const DAILY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

const MIN_INTERVAL = 1
const MAX_INTERVAL = 1440
const MINUTE_MS = 60_000

type ParsedMode =
  | { kind: 'interval'; minutes: number }
  | { kind: 'daily'; hour: number; minute: number }

/** 合法间隔 = 1–1440 的整数分钟；其余（含小数、字符串、NaN）一律 null */
function intervalMinutes(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (value < MIN_INTERVAL || value > MAX_INTERVAL) return null
  return value
}

function parseDailyAt(value: unknown): { hour: number; minute: number } | null {
  if (typeof value !== 'string') return null
  const match = DAILY_RE.exec(value.trim())
  if (!match) return null
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

/**
 * 解析一条记录用的是哪种模式。
 *
 * 两种模式必须**二选一**：
 * - 都为空 → 配置非法，永不触发；
 * - 都填了 → 配置非法，永不触发（不替用户猜哪一个优先）。
 *
 * 空字符串按「没填」处理：表单清空后常见 `dailyAt: ''`，把它当成非法配置
 * 会让一条本来正确的间隔任务突然停摆。
 */
function modeOf(rec: ScheduleRecord): ParsedMode | null {
  const hasInterval = rec.everyMinutes !== undefined && rec.everyMinutes !== null
  const hasDaily = typeof rec.dailyAt === 'string' && rec.dailyAt.trim() !== ''
  if (hasInterval === hasDaily) return null

  if (hasInterval) {
    const minutes = intervalMinutes(rec.everyMinutes)
    return minutes === null ? null : { kind: 'interval', minutes }
  }

  const daily = parseDailyAt(rec.dailyAt)
  return daily === null ? null : { kind: 'daily', ...daily }
}

/** 按本地日历构造某一天的某个钟点（月份是 0 基，这里由调用方传 Date） */
function atLocalTime(day: Date, hour: number, minute: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0)
}

/**
 * 下一次应触发的时间；null = 永不（配置非法或 disabled）。
 *
 * 间隔模式返回的是「按上次运行推算的理论时点」，可能已经过去 ——
 * 应用关闭期间错过的触发不会补跑，但下一轮扫描会立刻判定为到期。
 */
export function nextRunAt(rec: ScheduleRecord, now: number): number | null {
  if (!rec.enabled) return null
  const mode = modeOf(rec)
  if (mode === null) return null

  if (mode.kind === 'interval') {
    const base = rec.lastRunAt ?? rec.createdAt
    if (!Number.isFinite(base) || !Number.isFinite(now)) return null
    return base + mode.minutes * MINUTE_MS
  }

  // 每日模式：基准取 now 与 lastRunAt 中较晚的那个，保证返回的时间
  // 同时晚于「现在」和「上一次触发」。正常情况下基准是 now，
  // 结果只会落在今天或明天的该钟点。
  //
  // 用本地 Date 的年月日构造，而不是 `now + 24h`：后者在夏令时切换日
  // 会把 09:00 变成 08:00 / 10:00；`setDate(+1)` 走本地日历，
  // 跨 DST 仍然是同一个钟点。
  const base = Math.max(now, rec.lastRunAt ?? 0)
  if (!Number.isFinite(base)) return null
  const candidate = atLocalTime(new Date(base), mode.hour, mode.minute)
  if (candidate.getTime() <= base) candidate.setDate(candidate.getDate() + 1)
  return candidate.getTime()
}

/**
 * 现在是否到期（lastRunAt 之后已跨过一个周期）。
 *
 * 间隔模式是「理论时点已到」；每日模式是「今天这个钟点已到，且上一次触发
 * 发生在它之前」。后者不能复用 nextRunAt 的 `>` 语义：正好 09:00:00.000
 * 这一瞬间也应该算到期，否则一次扫描错过这一毫秒就要再等一天。
 */
export function isDue(rec: ScheduleRecord, now: number): boolean {
  if (!rec.enabled) return false
  const mode = modeOf(rec)
  if (mode === null) return false

  if (mode.kind === 'interval') {
    const next = nextRunAt(rec, now)
    return next !== null && now >= next
  }

  // 从未跑过时 (lastRunAt ?? 0) 必然早于今天任何时刻，所以「今天到点」即触发。
  // 应用整夜没开也不会漏判：今天 09:00 已过、lastRunAt 停在昨天 → 到期；
  // 但中间错过的每一次不会补跑，跑完这一次 lastRunAt 就推进到今天。
  const todayAt = atLocalTime(new Date(now), mode.hour, mode.minute).getTime()
  return now >= todayAt && (rec.lastRunAt ?? 0) < todayAt
}

/**
 * 校验配置；返回错误字符串或 null。
 *
 * `targetId` 只查非空，不查「目标是否真的存在」：那是执行时的事实，
 * 目标可能刚被删。保存时去查另一个列表，会让一次列表读取失败
 * 把一条合法配置挡在门外。
 */
export function validateSchedule(input: {
  kind: string
  targetId: string
  /** script 模式必填：在哪个环境里跑 */
  profileId?: string
  everyMinutes?: number
  dailyAt?: string
}): string | null {
  if (input.kind !== 'launch' && input.kind !== 'script') {
    return '动作类型必须是 launch 或 script'
  }
  if (typeof input.targetId !== 'string' || input.targetId.trim() === '') {
    return '目标不能为空'
  }
  // script 必须在某个环境里跑：AutomationScript.profileId 只是录制来源，
  // 不能当运行环境。缺了就明确拒绝，而不是运行时才发现跑不了。
  if (input.kind === 'script') {
    if (typeof input.profileId !== 'string' || input.profileId.trim() === '') {
      return '运行脚本需要指定运行环境'
    }
  }

  const hasInterval = input.everyMinutes !== undefined && input.everyMinutes !== null
  const hasDaily = typeof input.dailyAt === 'string' && input.dailyAt.trim() !== ''
  if (!hasInterval && !hasDaily) return '需要间隔或每日时间之一'
  if (hasInterval && hasDaily) return '间隔与每日时间只能选一个'

  if (hasInterval) {
    if (intervalMinutes(input.everyMinutes) === null) {
      return `间隔必须是 ${MIN_INTERVAL}–${MAX_INTERVAL} 的整数分钟`
    }
    return null
  }

  if (parseDailyAt(input.dailyAt) === null) {
    return '每日时间必须是 HH:MM（24 小时制）'
  }
  return null
}
