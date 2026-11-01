/**
 * 伪装状态 → 「能不能执行不可逆动作」的判定。
 *
 * 单独成模块（零依赖，只 import type）有两个理由：
 *   1. 判定必须能被单测逐格核对。放在 `actions.ts` 里的话，它和 electron 绑死，
 *      只能靠读代码「证明」——而这一轮我们已经吃够了「读代码当验证」的亏。
 *   2. 它是唯一允许说「拒绝」的地方。散在几个调用点上，就会各写一份阈值，
 *      然后有一天两份不一致，而两边看起来都对。
 *
 * ── 判定原则：只有 `'ok'` 放行，其余全部拒绝 ──
 *
 * 这条原则不是保守，是这一轮所有缺陷的共同根因总结：
 * **「没报错」和「没跑」在外部长得一模一样。**
 *   - `unknown`：脚本下发了，但没有任何回读证明属性装上了 → 等于「没跑」
 *   - `degraded`：跑了一部分，page 侧漏了 → 页面读到的仍是宿主值
 *   - `rolled-back`：脚本自己判定失败并回滚 → 页面变回普通浏览器
 *   - 记录缺失：窗口已销毁 / 编号不对 / 这条路径根本没有 sender
 * 四种都不是「成功」，所以都不能放行不可逆动作。
 */

import type { MaskBlockKind, MaskRow, MaskSource, MaskStateRecord } from '@shared/types'

/**
 * 拒绝原因判别字段。
 *
 * 类型本体在 `shared/types.ts` —— 渲染层要按它选文案，而两份字符串联合
 * 迟早会不一致。这里只 re-export，让既有 import 路径不变。
 */
export type { MaskBlockKind }

export type MaskVerdict =
  | { allow: true; state: MaskStateRecord['state'] }
  | { allow: false; state: MaskStateRecord['state'] | 'missing'; kind: MaskBlockKind; reason: string }

/** 哪些来源的失败会拦 L2。page 决定「是否可信」，子目标决定「可信到什么程度」 */
const BLOCKING_SOURCES: readonly MaskSource[] = ['page']

/**
 * 判定一个窗口此刻能不能执行不可逆动作。
 *
 * `record` 必须来自**进程内**的实时状态（`WindowManager.maskStateOf`），
 * 不能来自落盘的 `Profile.maskLast` —— 后者在重启后必然是上一次会话的结论，
 * 拿它去拒绝合法操作，比漏判更难查（用户只会看到「支付按钮永远点不动」）。
 */
export function judgeMask(record: MaskStateRecord | null): MaskVerdict {
  if (record === null) {
    return {
      allow: false,
      state: 'missing',
      kind: 'missing',
      reason:
        '查不到这个窗口的伪装状态（窗口可能已关闭，或这条路径没有发起窗口）。' +
        '没有测量结果就不执行不可逆动作 —— 「没报错」不等于「伪装生效了」'
    }
  }

  if (record.state === 'ok') return { allow: true, state: 'ok' }

  if (record.state === 'unknown') {
    return {
      allow: false,
      state: 'unknown',
      kind: 'unknown',
      reason:
        '伪装脚本已下发，但还没有任何回读证明它真的装上了（当前状态：未测量）。' +
        '在拿到页面侧的失败清单之前，不可逆动作不执行'
    }
  }

  if (record.state === 'rolled-back') {
    const attrs = record.failed.map((f) => f.attr).join('、')
    return {
      allow: false,
      state: 'rolled-back',
      kind: 'rolled-back',
      reason:
        '伪装脚本判定失败并整体回滚，页面此刻是一个普通浏览器' +
        (attrs.length > 0 ? `（未生效：${attrs}）` : '') +
        '。不可逆动作不执行'
    }
  }

  // degraded：只有 page 侧的失败才拦。worker / iframe / other 只告警不拦 ——
  // worker 注入当前是停用状态，若它也拦，所有 L2 都会被拦，
  // 而闸门全阻断等于用户去把闸门关掉，比漏判更糟。
  const blocking = record.failed.filter((f) => BLOCKING_SOURCES.includes(f.source))
  if (blocking.length > 0) {
    const detail = blocking.map((f) => `${f.attr}（${f.reason}）`).join('；')
    return {
      allow: false,
      state: 'degraded',
      kind: 'page-degraded',
      reason: `页面侧伪装不完整，页面读到的仍是宿主值：${detail}。不可逆动作不执行`
    }
  }

  return { allow: true, state: 'degraded' }
}

/**
 * 判定表：五种输入 × 两个来源，逐格写出来。
 *
 * 这张表的存在意义是**可核对**：单测按它逐格断言，报告里也按它逐格引用。
 * 写成散落的 `if` 之后，谁都说不清「worker 失败到底拦不拦」——
 * 而这类问题在评审里已经来回三次了。
 */
export const MASK_DECISION_TABLE: ReadonlyArray<{
  input: MaskStateRecord['state'] | 'missing'
  source: MaskSource | '—'
  allow: boolean
  kind: MaskBlockKind | '—'
  /**
   * 界面上这个格子该是什么颜色。
   *
   * 这一列存在的理由：判定表原来只描述「拦不拦」，而界面还要表达
   * 「拦了 / 降级但放行 / 一切正常」三档。三档如果各写各的，就会出现
   * 「界面绿、门禁红」。写成同一张表的一列之后，加一行就必须同时回答
   * 「拦不拦」和「显示什么」，`tests/mask-gate.test.ts` 逐行核对这两列。
   */
  tone: 'ok' | 'warn' | 'block'
}> = [
  { input: 'ok', source: 'page', allow: true, kind: '—', tone: 'ok' },
  { input: 'ok', source: 'worker', allow: true, kind: '—', tone: 'ok' },
  { input: 'unknown', source: 'page', allow: false, kind: 'unknown', tone: 'block' },
  { input: 'unknown', source: 'worker', allow: false, kind: 'unknown', tone: 'block' },
  { input: 'degraded', source: 'page', allow: false, kind: 'page-degraded', tone: 'block' },
  { input: 'degraded', source: 'worker', allow: true, kind: '—', tone: 'warn' },
  { input: 'rolled-back', source: 'page', allow: false, kind: 'rolled-back', tone: 'block' },
  { input: 'rolled-back', source: 'worker', allow: false, kind: 'rolled-back', tone: 'block' },
  { input: 'missing', source: 'page', allow: false, kind: 'missing', tone: 'block' },
  { input: 'missing', source: 'worker', allow: false, kind: 'missing', tone: 'block' }
]

/**
 * 把一条实时状态压成界面要的行。
 *
 * 存在的意义是**别让渲染层自己判**：`allow` / `kind` / `reason` 三个字段
 * 全部由 `judgeMask` 产出，与拦 L2 走的是同一个函数、同一张表。渲染层只
 * 剩下「按色调选颜色」这一件纯展示的事。
 *
 * `failed` 里的字符串来自注入脚本的失败项，可能带上页面里的属性名。
 * 这里截断，和审计 detail 的收口规则一致 —— 界面的 tooltip 不是越详细越好，
 * 一个 4KB 的属性名会把整行撑爆。
 */
export function maskRowOf(record: MaskStateRecord): MaskRow {
  const verdict = judgeMask(record)
  return {
    profileId: record.profileId,
    state: record.state,
    at: record.at,
    failed: record.failed.map((f) => ({
      attr: f.attr.slice(0, 40),
      reason: f.reason.slice(0, 120),
      source: f.source
    })),
    allow: verdict.allow,
    kind: verdict.allow ? null : verdict.kind,
    reason: verdict.allow ? '' : verdict.reason
  }
}

