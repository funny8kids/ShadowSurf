/**
 * 同意票与目标漂移的回归护栏。
 *
 * 背景：元素编号是按快照位置给的（e1..eN），任何一次新快照都会重新分配。
 * 而 L2 的确认框最多等 120 秒 —— 这期间页面可以换按钮、并发调用也能触发重编号。
 * 风险等级与确认框文案都是用旧快照算的，不复核就会出现
 * **用户批准的是 A，系统点的是 B**。
 *
 * 这里钉两件事：
 * 1. 三条会弹确认框的路径（agent loop / 本地 API / 脚本回放）都必须接复核；
 * 2. 复核失败必须中止，不能"找不到同名元素就按旧编号执行"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const read = (f: string): string => readFileSync(join(ROOT, f), 'utf8')

test('三条审批路径都必须接目标复核', () => {
  for (const file of [
    'src/main/agent/loop.ts',
    'src/main/modules/localapi.ts',
    'src/main/modules/scripts.ts'
  ]) {
    const src = read(file)
    assert.ok(
      src.includes('retargetApprovedAction'),
      `${file} 会弹 L2 确认框，但没有在同意后复核目标`
    )
  }
})

test('复核模块本身：找不到同名元素就拒绝，不猜', () => {
  const src = read('src/main/agent/retarget.ts')
  assert.match(src, /candidates\.length === 0[\s\S]{0,300}ok: false/, '目标消失必须拒绝')
  assert.match(src, /candidates\.length > 1[\s\S]{0,300}ok: false/, '多个同名候选必须拒绝，不猜')
  assert.match(src, /sameIdentity[\s\S]{0,300}a\.name === b\.name/, '身份判定必须包含可读名')
})

test('本地 API 的目标变更有专门错误码，调用方能区分「重试」与「改请求」', () => {
  const src = read('src/main/modules/localapi.ts')
  assert.match(src, /E_TARGET_CHANGED/, '目标漂移要有独立错误码')
  assert.match(src, /409/, '目标漂移应是 409 冲突')
})
