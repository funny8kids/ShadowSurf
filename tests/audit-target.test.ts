/**
 * 审计「目标」列的可读性回归。
 *
 * 背景：审计记录原先把协议原文直接拼进 target ——
 *     [action.type, action.id ? `#${action.id}` : '', action.url ?? ''].join(' ')
 * 于是中文界面里出现 `navigate https://example.com`、`click #e7`：
 * 英文动作名混在中文界面里，`e7` 是当轮快照的元素编号，用户既看不懂，
 * 也拿它做不了任何事。这是设计评审在实机截图上抓到的，不是推测。
 *
 * 这里钉三件事：
 *   1. 每个 ActionType 都有中文标签（协议加动作而忘了加标签 → 界面显示英文）
 *   2. 标签里不许有英文（包括「顺手加个英文别名」这种）
 *   3. describeAction 的输出里不出现协议 token，元素编号只走 marker
 *
 * 为什么能直接在 Node 里跑：`@shared/protocol` 零 import，纯类型 + 两个纯函数。
 * `modules/audit.ts` 就不行 —— 它静态 import 了 electron。
 *
 * 跑法：node --experimental-strip-types --test tests/audit-target.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ACTION_LABEL, describeAction } from '../src/shared/protocol.ts'
import type { Action, ActionType } from '../src/shared/protocol.ts'

/**
 * 协议里全部动作。**硬编码**是刻意的：类型 union 在运行时不存在，
 * 想「自动取全量」只能去读源码文本，那种测法会在重命名后静默失效。
 * 代价是新增动作时要来这里补一条 —— 但漏补的后果是这条测试**仍然通过**，
 * 所以真正的守卫是 `Record<ActionType, string>` 让漏写标签编译失败。
 * 这条测试补的是另一半：标签写成了英文（编译能过，界面还是错的）。
 */
const ALL_ACTIONS: ActionType[] = ['click', 'type', 'press', 'scroll', 'navigate', 'extract', 'done']

test('每个动作都有中文标签，且标签里不出现英文', () => {
  for (const action of ALL_ACTIONS) {
    const label = ACTION_LABEL[action]
    assert.equal(typeof label, 'string', `动作 ${action} 没有标签`)
    assert.ok(label.length > 0, `动作 ${action} 的标签是空串`)
    assert.ok(
      !/[A-Za-z]/.test(label),
      `动作 ${action} 的标签里有英文字母（${label}）—— 中文界面里出现英文动作名，` +
        '正是这条用例要挡的那种回归'
    )
  }
})

test('describeAction：目标列说人话，不出现协议 token 和元素编号', () => {
  const nav: Action = { type: 'navigate', url: 'https://example.com' }
  const n = describeAction(nav)
  assert.equal(n.target, '导航 https://example.com')
  assert.ok(!n.target.includes('navigate'), '目标列里还有协议 token：' + n.target)
  assert.equal(n.marker, '', 'navigate 没有元素编号，不该产生 marker')

  // click 的 id 是当轮快照编号。目标列给「某个元素」，编号只走 marker。
  const click: Action = { type: 'click', id: 'e7' }
  const c = describeAction(click)
  assert.equal(c.target, '点击 某个元素')
  assert.ok(!c.target.includes('e7'), '目标列里还有元素编号：' + c.target)
  assert.equal(c.marker, '；元素=#e7', '元素编号必须留在可校验的 detail 里，不能整个丢掉')

  // 只有动作名、没有 id / url 的动作
  assert.deepEqual(describeAction({ type: 'scroll', amount: 3 }), { target: '滚动', marker: '' })
})

test('describeAction：任何动作都不会把协议 token 漏进目标列', () => {
  for (const type of ALL_ACTIONS) {
    const { target, marker } = describeAction({ type, id: 'e1', url: 'https://a.example' })
    // `type` 作为独立单词出现就算泄漏；子串匹配会误伤（例如 'type' 出现在别处）
    assert.ok(
      !new RegExp(`(^|\\s)${type}(\\s|$)`).test(target),
      `动作 ${type} 的协议 token 出现在目标列：${target}`
    )
    assert.ok(target.startsWith(ACTION_LABEL[type]), `目标列没有以中文标签开头：${target}`)
    assert.ok(!target.includes('e1'), `元素编号漏进目标列：${target}`)
    assert.equal(marker, '；元素=#e1')
  }
})
