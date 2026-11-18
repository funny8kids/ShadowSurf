/**
 * Web Share 平台决策的**纯逻辑**测试。
 *
 * 决策被抽成 presets.ts 里的 `webShareSupportedOn(os)`：真 Chrome 在 Windows
 * 上有 navigator.share / canShare，Linux 实测没有，macOS 未测量保守取“不造”。
 * 钉住这几个返回值，等于钉住「不在 Linux/macOS 凭空造属性」这条硬规则。
 *
 * presets.ts 是纯模块（只 import type，不碰 electron / 构建期别名），
 * 可以像 tests/fingerprint-surfaces.test.ts 那样直接在 Node 里 import。
 *
 * 跑法：node --experimental-strip-types --test tests/share-platform.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webShareSupportedOn } from '../src/shared/presets.ts'

test('Web Share 只在 Windows 上造：Windows 为真', () => {
  assert.equal(webShareSupportedOn('windows'), true)
})

test('Web Share 在 Linux 上不造（Chrome 157 headless+headful 实测无此属性）', () => {
  assert.equal(webShareSupportedOn('linux'), false)
})

test('Web Share 在 macOS 上不造（未测量，保守取“不造”，避免造出真 Chrome 没有的属性）', () => {
  assert.equal(webShareSupportedOn('macos'), false)
})
