/**
 * 伪装闸门的判定表测试。
 *
 * 背景：`MaskState` 原先只有 `ok / rolled-back / degraded`，而 `'ok'` 是在
 * `Page.addScriptToEvaluateOnNewDocument` **返回之后**就置上的 —— 那个返回只证明
 * 「脚本排进了队列」，不证明任何一条属性真的装上了。于是「一个属性都没装上的页面」
 * 状态也是 ok，门禁读到的是一次**从未测量过的成功**。
 *
 * 修法是加 `'unknown'`（脚本已下发、结果未回读），并把判定收成一句话：
 * **只有 `'ok'` 放行，其余全部拒绝。**
 *
 * 这个文件钉三件事：
 *   1. 十格判定表逐格成立（五种输入 × 两个来源）；
 *   2. `degraded` 的拦截范围**只看 page** —— worker 侧失败不拦，
 *      否则 worker 注入停用期间所有 L2 都会被拦，闸门全阻断等于用户把闸门关掉；
 *   3. 「查不到」与「查到了但是 unknown」给出**不同**的 kind，
 *      因为两者的补救动作不同（前者是环境/接线问题，后者是等回读）。
 *
 * `mask-gate.ts` 零依赖（只 import type），能直接在 Node 里跑。
 *
 * 跑法：node --experimental-strip-types --test tests/mask-gate.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judgeMask, MASK_DECISION_TABLE } from '../src/main/core/mask-gate.ts'
import { MASK_TONE_LABEL, maskToneOf, pickWorstMaskRow } from '../src/shared/mask-ui.ts'
import type { MaskSource, MaskState, MaskStateRecord } from '../src/shared/types.ts'

function rec(
  state: MaskState,
  failed: Array<{ attr: string; reason: string; source: MaskSource }> = []
): MaskStateRecord {
  return { webContentsId: 7, profileId: 'prf_test', state, failed, at: 1761926400000 }
}

test('十格判定表逐格成立', () => {
  assert.equal(MASK_DECISION_TABLE.length, 10, '表必须正好十格，少一格就是没覆盖到')
  for (const row of MASK_DECISION_TABLE) {
    const record =
      row.input === 'missing'
        ? null
        : rec(
            row.input,
            // 「degraded × worker」这一格要的是「只有 worker 失败」，
            // 其余非 ok 状态给一条对应来源的失败项，让判定有东西可看
            row.input === 'degraded' ? [{ attr: 'canvas', reason: '注入失败', source: row.source as MaskSource }] : []
          )
    const v = judgeMask(record)
    const gotKind = v.allow ? '—' : v.kind
    assert.equal(
      v.allow,
      row.allow,
      `${row.input} × ${row.source} 期望 allow=${String(row.allow)}，实际 ${String(v.allow)}`
    )
    assert.equal(gotKind, row.kind, `${row.input} × ${row.source} 的 kind 对不上`)
  }
})

test('degraded 的拦截范围只看 page —— worker 侧失败不拦', () => {
  const workerOnly = judgeMask(rec('degraded', [{ attr: 'worker', reason: '注入已停用', source: 'worker' }]))
  assert.equal(workerOnly.allow, true, 'worker 侧失败不能拦 L2：停用期间会把所有 L2 拦死')

  const iframeOnly = judgeMask(rec('degraded', [{ attr: 'iframe', reason: '注入已停用', source: 'iframe' }]))
  assert.equal(iframeOnly.allow, true, 'iframe 侧失败同样不拦')

  const otherOnly = judgeMask(rec('degraded', [{ attr: 'service_worker', reason: '未覆盖', source: 'other' }]))
  assert.equal(otherOnly.allow, true, '未覆盖的 target 类型只告警不拦')

  const withPage = judgeMask(
    rec('degraded', [
      { attr: 'worker', reason: '注入已停用', source: 'worker' },
      { attr: 'canvas', reason: '注入失败', source: 'page' }
    ])
  )
  assert.equal(withPage.allow, false, '只要有一条 page 失败就必须拦，哪怕同时还有 worker 失败')
  assert.equal(withPage.allow === false ? withPage.kind : '', 'page-degraded')
})

test('ok 放行，即使失败清单里还留着历史条目', () => {
  // 失败清单是累积的：先 page 失败、后来重新注入成功。
  // 状态已经是 ok，历史条目只用于展示，不能反过来拦。
  const v = judgeMask(rec('ok', [{ attr: 'canvas', reason: '上一次会话的失败', source: 'page' }]))
  assert.equal(v.allow, true)
})

test('unknown 与 missing 的 kind 必须不同 —— 补救动作不同', () => {
  const unknown = judgeMask(rec('unknown'))
  const missing = judgeMask(null)
  assert.equal(unknown.allow, false)
  assert.equal(missing.allow, false)
  assert.equal(unknown.allow === false ? unknown.kind : '', 'unknown')
  assert.equal(missing.allow === false ? missing.kind : '', 'missing')
  assert.notEqual(
    unknown.allow === false ? unknown.reason : '',
    missing.allow === false ? missing.reason : '',
    '两种拒绝的文案不能相同：一个要等回读，一个是接线/环境问题'
  )
})

test('拒绝理由必须点出是哪一条 page 失败', () => {
  const v = judgeMask(rec('degraded', [{ attr: 'webgl', reason: 'Illegal invocation', source: 'page' }]))
  assert.equal(v.allow, false)
  const reason = v.allow === false ? v.reason : ''
  assert.match(reason, /webgl/, '理由里要带属性名，否则用户不知道该修什么')
  assert.match(reason, /Illegal invocation/, '理由里要带原因原文')
})

test('rolled-back 的理由带未生效属性清单', () => {
  const v = judgeMask(
    rec('rolled-back', [
      { attr: 'canvas', reason: 'x', source: 'page' },
      { attr: 'audio', reason: 'y', source: 'page' }
    ])
  )
  assert.equal(v.allow, false)
  const reason = v.allow === false ? v.reason : ''
  assert.match(reason, /canvas/)
  assert.match(reason, /audio/)
})

/* ─────────────────── 界面色调：必须与门禁同一张表 ─────────────────── */

/**
 * 为什么这条断言比「界面有没有那个点」重要得多：
 *
 * 界面画绿、门禁在拦 —— 用户会按界面去把整套机制关掉，因为它看起来在骗人。
 * 反过来「界面红、门禁放行」则会让人去关掉闸门。两种都比不显示更坏。
 *
 * 所以色调不另设阈值，只做 (allow, state) → 颜色的翻译，并在这里逐行核对。
 * 判定表加了行而 `mask-ui.ts` 没跟上，这条就红。
 */
test('判定表每一行过 judgeMask 后的色调，必须等于表里写死的 tone 列', () => {
  assert.equal(MASK_DECISION_TABLE.length, 10, '表必须正好十格，少一格就是没覆盖到')
  for (const row of MASK_DECISION_TABLE) {
    const record =
      row.input === 'missing'
        ? null
        : rec(
            row.input,
            row.input === 'degraded'
              ? [{ attr: 'canvas', reason: '注入失败', source: row.source as MaskSource }]
              : []
          )
    const verdict = judgeMask(record)
    const tone = maskToneOf(verdict, true)
    assert.equal(
      tone,
      row.tone,
      `${row.input} × ${row.source}：门禁 allow=${String(verdict.allow)} state=${verdict.state}，` +
        `界面却画成 ${tone}（表里写的是 ${row.tone}）`
    )
  }
})

test('每种色调都有标签 —— 否则界面上那个点没有可读的名字', () => {
  for (const tone of ['idle', 'ok', 'warn', 'block'] as const) {
    assert.ok(
      MASK_TONE_LABEL[tone].length > 0,
      `${tone} 没有标签：读屏软件会念出一个空字符串`
    )
  }
})

/**
 * `verdict === null` 有两种含义，画错哪一个都会误导：
 *   - 环境没跑 → 灰（idle）：没有窗口就没有可测的东西，不是「测了没问题」
 *   - 在跑但没读数 → 红（block）：门禁此刻就是拒绝的
 */
test('没有读数时：没在跑画灰，在跑画红', () => {
  assert.equal(maskToneOf(null, false), 'idle', '环境没启动不该画成告警')
  assert.equal(maskToneOf(null, true), 'block', '窗口开着却没有读数，门禁在拦，界面不能画灰')
})

/**
 * 一个环境可以有多个窗口。挑「最新」会藏掉另一个窗口的回滚 ——
 * 用户看到绿点就不会去点开那个窗口，而那个窗口恰恰不能用。
 */
test('同一环境多窗口时取最坏的一条', () => {
  const okRow = { profileId: 'prf_a', allow: true, state: 'ok' as const }
  const warnRow = { profileId: 'prf_a', allow: true, state: 'degraded' as const }
  const blockRow = { profileId: 'prf_a', allow: false, state: 'rolled-back' as const }

  assert.equal(pickWorstMaskRow([okRow, warnRow])?.state, 'degraded')
  assert.equal(pickWorstMaskRow([warnRow, blockRow, okRow])?.state, 'rolled-back')
  assert.equal(pickWorstMaskRow([okRow])?.state, 'ok')
  assert.equal(pickWorstMaskRow([]), null, '空数组必须返回 null，不能编一条出来')
})
