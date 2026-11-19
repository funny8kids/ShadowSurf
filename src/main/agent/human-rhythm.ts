/**
 * 拟人输入的节奏参数（纯逻辑）。
 *
 * 只回答「档位 → 击键间隔区间」，不碰 DOM / IPC / 页面脚本，
 * 所以能被 node:test 直接覆盖。
 *
 * ── 为什么参数由主进程生成 ──
 * 节奏若由页面侧自己决定，任何页面脚本（包括被 XSS 注入的）都能把它改成
 * 「0ms 瞬间填完」或「固定 100ms 等间隔」—— 后者反而是一种更明显的机器特征。
 * 参数必须由可信的主进程按用户设置注入，页面只负责照着执行。
 *
 * ── 档位取舍 ──
 * - off：一次性 setter，最快。用于「我就是要快」的场景，明确不伪装。
 * - light：60–140ms/字符，约 12 字/秒，接近熟练打字；每 10 字停一次 180ms。
 * - normal：90–220ms/字符，约 7 字/秒；每 10 字停 420ms（模拟看屏幕）。
 * - slow：140–320ms/字符，约 4 字/秒；每 10 字停 700ms（模拟边想边打）。
 *
 * 刻意用**区间随机**而不是固定值：固定间隔本身就是可被检测的周期性信号，
 * 随机区间才接近真人的击键分布。
 */

import type { Action } from '@shared/protocol'
import type { Settings } from '@shared/types'

type Level = Settings['humanizeInput']
type Rhythm = NonNullable<Action['human']>

const RHYTHM: Record<Exclude<Level, 'off'>, Rhythm> = {
  light: { minMs: 60, maxMs: 140, jitterMs: 180, pauseBeforeFocusMs: 90 },
  normal: { minMs: 90, maxMs: 220, jitterMs: 420, pauseBeforeFocusMs: 160 },
  slow: { minMs: 140, maxMs: 320, jitterMs: 700, pauseBeforeFocusMs: 260 }
}

/** 把档位解析成动作上要注入的节奏；off 时返回 undefined（页面走一次性 setter） */
export function rhythmFor(level: Level): Action['human'] | undefined {
  if (level === 'off') return undefined
  return { ...RHYTHM[level] }
}

/**
 * 在动作上注入节奏参数。
 *
 * 只给 type 动作加；其他动作不写字形节奏，避免污染审计与快照。
 * 不修改传入对象：动作会被多处复用（审计 / 重试 / 序列化），原地改会串味。
 */
export function withHumanRhythm(action: Action, level: Level): Action {
  if (action.type !== 'type') return action
  const human = rhythmFor(level)
  if (!human) {
    // 显式关掉时要清掉可能残留的旧字段
    if (action.human === undefined) return action
    const { human: _drop, ...rest } = action
    return rest
  }
  return { ...action, human }
}

/** 一次击键延迟：区间内均匀随机 */
export function keyDelay(human: NonNullable<Action['human']>, randomAt: number): number {
  const span = Math.max(0, human.maxMs - human.minMs)
  return Math.round(human.minMs + Math.min(1, Math.max(0, randomAt)) * span)
}
