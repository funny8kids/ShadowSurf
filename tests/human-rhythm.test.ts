/**
 * 拟人输入节奏测试（纯逻辑）。
 *
 * 重点钉住三件事：
 * 1. off 时不注入任何参数（页面走一次性 setter，最快）；
 * 2. 档位递增时击键间隔变慢，且 min ≤ max；
 * 3. 节奏只注入 type 动作，不碰 click / navigate —— 否则会污染别的审计路径。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keyDelay, rhythmFor, withHumanRhythm } from '../src/main/agent/human-rhythm.ts'
import type { Action } from '../src/shared/protocol.ts'

test('off 不注入节奏', () => {
  assert.equal(rhythmFor('off'), undefined)
  const action: Action = { type: 'type', id: 'e1', text: 'hi' }
  assert.deepEqual(withHumanRhythm(action, 'off'), action)
})

test('三档节奏递增，且区间合法', () => {
  const levels = ['light', 'normal', 'slow'] as const
  const mins = levels.map((l) => rhythmFor(l)!.minMs)
  assert.deepEqual(mins, [...mins].sort((a, b) => a - b))
  for (const l of levels) {
    const r = rhythmFor(l)!
    assert.ok(r.minMs > 0 && r.maxMs >= r.minMs, `${l} 的区间非法`)
    assert.ok(r.jitterMs >= 0 && r.pauseBeforeFocusMs >= 0)
  }
})

test('keyDelay 在 [min,max] 内，端点与越界都收敛', () => {
  const r = rhythmFor('normal')!
  assert.equal(keyDelay(r, 0), r.minMs)
  assert.equal(keyDelay(r, 1), r.maxMs)
  assert.equal(keyDelay(r, 0.5), Math.round((r.minMs + r.maxMs) / 2))
  assert.equal(keyDelay(r, -1), r.minMs)
  assert.equal(keyDelay(r, 2), r.maxMs)
})

test('节奏只注入 type，不改其他动作；且不修改原对象', () => {
  const click: Action = { type: 'click', id: 'e1' }
  assert.deepEqual(withHumanRhythm(click, 'slow'), click)

  const type: Action = { type: 'type', id: 'e2', text: 'abc' }
  const result = withHumanRhythm(type, 'slow')
  assert.ok(result.human)
  assert.equal(result.human!.minMs, rhythmFor('slow')!.minMs)
  assert.equal(type.human, undefined, '原对象不能被修改（它还会进审计与重试）')

  const withText: Action = { type: 'type', id: 'e3', text: 'x', submit: true }
  const kept = withHumanRhythm(withText, 'light')
  assert.equal(kept.submit, true, '注入节奏不能丢掉 submit 等既有字段')
})

test('从有节奏切回 off 会清掉旧字段', () => {
  const withHuman: Action = {
    type: 'type',
    id: 'e1',
    text: 'x',
    human: { minMs: 1, maxMs: 2, jitterMs: 0, pauseBeforeFocusMs: 0 }
  }
  const cleared = withHumanRhythm(withHuman, 'off')
  assert.equal(cleared.human, undefined)
  assert.equal(cleared.text, 'x')
})
