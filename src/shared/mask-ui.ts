/**
 * 伪装状态点：把门禁结论翻成「颜色 + 一句话」。
 *
 * ── 这个文件存在的唯一理由 ──
 *
 * 「界面显示绿、门禁在拦」比「界面上什么都不显示」更坏：用户会按界面去
 * 把整套机制关掉。所以这里**不做判断**，只做翻译：
 *
 *   `judgeMask()` 决定 allow/kind  →  这里把 (allow, state) 映射成色调
 *
 * 色调函数只吃 `allow` 与 `state` 两个字段，没有第二个阈值，也没有
 * 「degraded 但只有 worker 失败所以算绿」这类条件 —— 那种条件一旦写在这里，
 * 就与 `MASK_DECISION_TABLE` 分家了。`tests/mask-gate.test.ts` 里有一条
 * 表驱动断言：判定表每一行过 `judgeMask` 再过 `maskToneOf`，必须等于
 * 表里写死的 `tone` 列。改门禁不改这里，那条断言就红。
 *
 * 零依赖（只 import type），渲染层与 Node 单测都能直接加载。
 */

import type { MaskState } from './types'

/** 状态点的色调。`idle` 表示「没有可测的东西」，不是「通过」 */
export type MaskTone = 'idle' | 'ok' | 'warn' | 'block'

/**
 * 门禁结论的形状。
 *
 * 故意写成结构类型而不是 import `MaskVerdict`：那个类型在 `main/core/` 里，
 * 渲染层 import 主进程模块会被结构测试拦下（也不该有这条依赖）。而结构类型
 * 还有一个好处 —— `judgeMask` 的返回值与 `MaskRow` 都天然满足它，不需要转换。
 */
export interface MaskVerdictLike {
  allow: boolean
  state: MaskState | 'missing'
  /** `judgeMask` 给用户看的理由。放行时为空串或省略 */
  reason?: string
}

/** `pickWorstMaskRow` 需要的最小形状，方便单测直接构造 */
export interface MaskRowLike extends MaskVerdictLike {
  profileId: string
}

/**
 * 色调映射。
 *
 * `verdict === null` 有两种含义，必须分开：
 *   - 环境没在跑（`running === false`）：没有窗口就没有读数，
 *     这是「没东西可测」，不是「测了没问题」→ `idle`（灰、不显示点）
 *   - 环境在跑但没有读数：窗口开了、注入还没回读。门禁此刻是**拒绝**的
 *     （`judgeMask(null)` → `missing`），所以这里也必须是 `block`。
 *     画成灰的就会出现「界面看着没事、支付按钮点不动」。
 *
 * `allow === true` 但 `state !== 'ok'` 只有一种情况：degraded 且失败全在
 * 子目标侧（worker / iframe / other）。门禁放行，但确实降级了 → `warn`。
 * 画成绿的等于把「worker 注入停用」这件事从界面上抹掉。
 */
export function maskToneOf(verdict: MaskVerdictLike | null, running: boolean): MaskTone {
  if (verdict === null) return running ? 'block' : 'idle'
  if (!verdict.allow) return 'block'
  return verdict.state === 'ok' ? 'ok' : 'warn'
}

/** 完整标签，用于 `aria-label` 与详情 */
export const MASK_TONE_LABEL: Readonly<Record<MaskTone, string>> = {
  idle: '未启动',
  ok: '已伪装',
  warn: '子目标降级',
  block: '不可逆动作被拦'
}

/**
 * 卡片上只写两个字的版本。
 *
 * `ok` 是空串：绝大多数环境都正常，每张卡片都写「已伪装」只是噪音，
 * 而噪音会让人不再看这个位置 —— 等到真出问题时那个位置也一样被忽略。
 * 异常时才写字，正常时只有一个点。
 */
export const MASK_TONE_SHORT: Readonly<Record<MaskTone, string>> = {
  idle: '',
  ok: '',
  warn: '降级',
  block: '已拦'
}

/**
 * 没有门禁结论时（`verdict === null`）的说明文案。
 *
 * 有结论时一律用 `judgeMask` 产出的 `reason` —— 那句话是给用户看「该修什么」
 * 的唯一来源，界面上再写一份就会出现两个版本。
 */
export function maskFallbackHint(running: boolean): string {
  return running
    ? '窗口已打开，但还没有伪装读数。此刻不可逆动作不可用 —— 与门禁一致：查不到就拒绝'
    : '环境未启动：没有窗口就没有伪装读数。这不是「没问题」，只是没有东西可测'
}

/**
 * tooltip 文案。
 *
 * 优先级：门禁的 `reason` → 按状态给的固定说明。
 * 前者说明「该修什么」，后者只是解释「为什么没拦」。
 */
export function maskHintOf(row: MaskVerdictLike | null, running: boolean): string {
  if (row === null) return maskFallbackHint(running)
  if (typeof row.reason === 'string' && row.reason !== '') return row.reason
  return row.state === 'degraded'
    ? '子目标（worker / iframe / 其他）侧有降级，页面侧完好。不可逆动作仍放行 —— 这条只告警不拦'
    : '页面侧伪装完整：所有属性都已回读确认。不可逆动作放行'
}

/**
 * 同一个环境开了多个窗口时，挑出最坏的那一条来显示。
 *
 * 为什么是「最坏」而不是「最新」：一个环境两个窗口，一个伪装完好、一个回滚了，
 * 卡片上画绿点等于把回滚藏起来。用户看到绿点就不会去点开那个窗口，
 * 而那个窗口恰恰是不能用的那个。
 *
 * 排序用的是 `maskToneOf` 的结果，不另设严重度 —— 否则这里就成了第三份阈值。
 */
const TONE_RANK: Readonly<Record<MaskTone, number>> = { idle: 0, ok: 1, warn: 2, block: 3 }

export function pickWorstMaskRow<T extends MaskRowLike>(rows: readonly T[]): T | null {
  let worst: T | null = null
  let worstRank = -1
  for (const row of rows) {
    const rank = TONE_RANK[maskToneOf(row, true)]
    if (rank > worstRank) {
      worst = row
      worstRank = rank
    }
  }
  return worst
}
