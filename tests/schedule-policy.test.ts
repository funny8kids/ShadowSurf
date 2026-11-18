/**
 * 定时任务调度规则测试（纯逻辑）。
 *
 * 被测模块 `src/main/modules/schedule-policy.ts` 只有 type-only import，
 * 不碰 electron / store / 网络，所以能像 tests/team.test.ts 一样用 node:test
 * 直接在 Node 里跑：
 *   node --experimental-strip-types --test tests/schedule-policy.test.ts
 *
 * ── 为什么时间都用 `new Date(y, m, d, h, min)` 构造 ──
 * 被测实现把 "HH:MM" 解释为**本地时间**。直接写 UTC 时间戳字面量，在非 UTC
 * 的测试机上会整段错位（例如 CI 在东八区，09:30 的断言会变成 01:30）。
 * 用本地构造函数，测试与实现共享同一个时区前提。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isDue,
  nextRunAt,
  validateSchedule
} from '../src/main/modules/schedule-policy.ts'
import type { ScheduleRecord } from '../src/shared/types.ts'

/** 月份按人类习惯从 1 开始，内部转成 Date 的 0 基 */
function at(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

/** 固定基准：2026-01-10 08:00（本地时间，周六无关紧要，只为避开 DST 切换日） */
const CREATED = at(2026, 1, 10, 8, 0)

function record(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: 'sch_test',
    kind: 'launch',
    targetId: 'prf_test',
    everyMinutes: 15,
    enabled: true,
    lastRunAt: null,
    createdAt: CREATED,
    ...overrides
  }
}

/* ────────────────────────────── validateSchedule ────────────────────────────── */

test('validateSchedule：合法的间隔 / 每日配置通过', () => {
  assert.equal(
    validateSchedule({ kind: 'launch', targetId: 'prf_1', everyMinutes: 1 }),
    null
  )
  assert.equal(
    validateSchedule({ kind: 'script', targetId: 'scr_1', profileId: 'prf_1', everyMinutes: 1440 }),
    null
  )
  assert.equal(
    validateSchedule({ kind: 'launch', targetId: 'prf_1', dailyAt: '00:00' }),
    null
  )
  assert.equal(
    validateSchedule({ kind: 'script', targetId: 'scr_1', profileId: 'prf_1', dailyAt: '23:59' }),
    null
  )
})

test('validateSchedule：脚本定时必须指定运行环境', () => {
  // profileId 缺失 / 空白都要拒绝：AutomationScript.profileId 只是录制来源，
  // 拿它当运行环境会在触发时才发现跑不了
  assert.match(
    validateSchedule({ kind: 'script', targetId: 'scr_1', everyMinutes: 10 }) ?? '',
    /运行环境/
  )
  assert.match(
    validateSchedule({ kind: 'script', targetId: 'scr_1', profileId: '   ', everyMinutes: 10 }) ?? '',
    /运行环境/
  )
})

test('validateSchedule：间隔与每日时间必须二选一', () => {
  assert.match(
    validateSchedule({ kind: 'launch', targetId: 'prf_1' }) ?? '',
    /需要间隔或每日时间之一/
  )
  assert.match(
    validateSchedule({
      kind: 'launch',
      targetId: 'prf_1',
      everyMinutes: 10,
      dailyAt: '09:00'
    }) ?? '',
    /间隔与每日时间只能选一个/
  )
})

test('validateSchedule：间隔必须是 1–1440 的整数', () => {
  for (const everyMinutes of [0, 1441, 1.5, Number.NaN]) {
    assert.notEqual(
      validateSchedule({ kind: 'launch', targetId: 'prf_1', everyMinutes }),
      null,
      `everyMinutes=${everyMinutes} 应被拒绝`
    )
  }
})

test('validateSchedule：每日时间必须是严格的 HH:MM', () => {
  for (const dailyAt of ['24:00', '9:5', 'ab:cd', '', '9:05', '09:5', '09:60']) {
    assert.notEqual(
      validateSchedule({ kind: 'launch', targetId: 'prf_1', dailyAt }),
      null,
      `dailyAt=${JSON.stringify(dailyAt)} 应被拒绝`
    )
  }
})

test('validateSchedule：动作类型与目标不能为空', () => {
  assert.notEqual(
    validateSchedule({ kind: 'cron', targetId: 'prf_1', everyMinutes: 5 }),
    null
  )
  assert.notEqual(validateSchedule({ kind: 'launch', targetId: '', everyMinutes: 5 }), null)
  assert.notEqual(
    validateSchedule({ kind: 'launch', targetId: '   ', everyMinutes: 5 }),
    null
  )
})

/* ────────────────────────────── 间隔模式 ────────────────────────────── */

test('间隔模式：lastRunAt 为空时从 createdAt 起算', () => {
  const rec = record({ everyMinutes: 15, lastRunAt: null })
  assert.equal(nextRunAt(rec, CREATED), CREATED + 15 * 60_000)
  assert.equal(isDue(rec, CREATED + 15 * 60_000 - 1), false)
  assert.equal(isDue(rec, CREATED + 15 * 60_000), true)
})

test('间隔模式：从 lastRunAt 起算，到期前不触发', () => {
  const last = CREATED + 60 * 60_000
  const rec = record({ everyMinutes: 30, lastRunAt: last })
  assert.equal(nextRunAt(rec, last), last + 30 * 60_000)
  assert.equal(isDue(rec, last + 29 * 60_000), false)
  assert.equal(isDue(rec, last + 30 * 60_000), true)
})

test('间隔模式：应用关闭很久后第一轮扫描立即到期（中间次数不补跑）', () => {
  const rec = record({ everyMinutes: 10 })
  const muchLater = CREATED + 5 * 24 * 60 * 60_000
  assert.equal(isDue(rec, muchLater), true)
  // nextRunAt 仍是「理论上的上一次应触发点」，已经过去
  assert.ok((nextRunAt(rec, muchLater) ?? 0) < muchLater)
})

/* ────────────────────────────── 每日模式 ────────────────────────────── */

test('每日模式：今天该时刻已过且上次运行早于它 → 到期', () => {
  const rec = record({ everyMinutes: undefined, dailyAt: '09:30', lastRunAt: null })
  assert.equal(isDue(rec, at(2026, 1, 10, 9, 29)), false)
  assert.equal(isDue(rec, at(2026, 1, 10, 9, 30)), true)
  assert.equal(isDue(rec, at(2026, 1, 10, 9, 31)), true)
})

test('每日模式：今天已经跑过就不再触发', () => {
  const rec = record({
    everyMinutes: undefined,
    dailyAt: '09:30',
    lastRunAt: at(2026, 1, 10, 9, 30)
  })
  assert.equal(isDue(rec, at(2026, 1, 10, 9, 31)), false)
  assert.equal(isDue(rec, at(2026, 1, 10, 23, 59)), false)
})

test('每日模式跨天：昨天跑过，今天到点前不触发、到点触发', () => {
  const rec = record({
    everyMinutes: undefined,
    dailyAt: '09:30',
    lastRunAt: at(2026, 1, 9, 9, 30)
  })
  assert.equal(isDue(rec, at(2026, 1, 10, 8, 0)), false)
  assert.equal(isDue(rec, at(2026, 1, 10, 9, 29)), false)
  assert.equal(isDue(rec, at(2026, 1, 10, 9, 30)), true)
})

test('每日模式 nextRunAt：今天还没到点 → 今天；已过点 → 明天', () => {
  const rec = record({ everyMinutes: undefined, dailyAt: '09:30', lastRunAt: null })
  assert.equal(nextRunAt(rec, at(2026, 1, 10, 8, 0)), at(2026, 1, 10, 9, 30))
  assert.equal(nextRunAt(rec, at(2026, 1, 10, 10, 0)), at(2026, 1, 11, 9, 30))
  // 正好到点：今天这一次由 isDue 负责，下一次是明天
  assert.equal(nextRunAt(rec, at(2026, 1, 10, 9, 30)), at(2026, 1, 11, 9, 30))
})

test('每日模式 nextRunAt：必须晚于 lastRunAt', () => {
  const rec = record({
    everyMinutes: undefined,
    dailyAt: '09:30',
    lastRunAt: at(2026, 1, 10, 9, 30)
  })
  assert.equal(nextRunAt(rec, at(2026, 1, 10, 12, 0)), at(2026, 1, 11, 9, 30))
})

test('每日模式跨月 / 跨年：次日仍落在本地同一钟点', () => {
  const rec = record({ everyMinutes: undefined, dailyAt: '09:30', lastRunAt: null })
  assert.equal(nextRunAt(rec, at(2026, 1, 31, 10, 0)), at(2026, 2, 1, 9, 30))
  assert.equal(nextRunAt(rec, at(2026, 12, 31, 10, 0)), at(2027, 1, 1, 9, 30))
})

/* ────────────────────────────── disabled / 非法配置 ────────────────────────────── */

test('disabled：间隔与每日两种模式都不触发，nextRunAt 为 null', () => {
  const interval = record({ enabled: false, everyMinutes: 5 })
  assert.equal(nextRunAt(interval, CREATED + 24 * 60 * 60_000), null)
  assert.equal(isDue(interval, CREATED + 24 * 60 * 60_000), false)

  const daily = record({ enabled: false, everyMinutes: undefined, dailyAt: '09:30' })
  assert.equal(nextRunAt(daily, at(2026, 1, 10, 23, 0)), null)
  assert.equal(isDue(daily, at(2026, 1, 10, 23, 0)), false)
})

test('配置非法：nextRunAt 为 null，isDue 为 false', () => {
  const both = record({ everyMinutes: 30, dailyAt: '09:30' })
  assert.equal(nextRunAt(both, CREATED), null)
  assert.equal(isDue(both, CREATED + 24 * 60 * 60_000), false)

  const neither = record({ everyMinutes: undefined, dailyAt: undefined })
  assert.equal(nextRunAt(neither, CREATED), null)
  assert.equal(isDue(neither, CREATED + 24 * 60 * 60_000), false)

  const outOfRange = record({ everyMinutes: 0 })
  assert.equal(nextRunAt(outOfRange, CREATED), null)
  assert.equal(isDue(outOfRange, CREATED + 24 * 60 * 60_000), false)

  const badDaily = record({ everyMinutes: undefined, dailyAt: '24:00' })
  assert.equal(nextRunAt(badDaily, CREATED), null)
  assert.equal(isDue(badDaily, CREATED + 24 * 60 * 60_000), false)
})
