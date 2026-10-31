/**
 * 容量裁剪的回归测试。
 *
 * 背景：审计日志上限 5000 条，超出丢最旧的。但闸门记录（「谁批准了这笔支付」）
 * 混在同一条链里，一次高频 API 自动化跑几十万步就能把它挤出窗口 —— 而且无声：
 * `verifyChain` 看到链头 prev 指向已裁掉的记录，会判定为正常裁剪放行。
 * 也就是说这个缺口不会让任何门禁变红，只会让事后追责时发现记录不见了。
 *
 * 这里钉的是「丢谁」这件事本身。`evict.ts` 零依赖，所以能直接在 Node 里跑，
 * 不需要 Electron。
 *
 * 跑法：node --experimental-strip-types --test tests/evict.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { evictInPlace } from '../src/main/store/evict.ts'

interface Rec {
  id: string
  gate: boolean
}

/** 生成 n 条记录，`gateAt` 里的下标标成闸门记录 */
function make(n: number, gateAt: number[] = []): Rec[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    gate: gateAt.includes(i)
  }))
}

const isGate = (r: Rec): boolean => r.gate
const ids = (list: Rec[]): string[] => list.map((r) => r.id)

test('未超上限时不动', () => {
  const draft = make(3)
  evictInPlace(draft, 5)
  assert.deepEqual(ids(draft), ['r0', 'r1', 'r2'])
})

test('无 retain 时丢最旧的', () => {
  const draft = make(6)
  evictInPlace(draft, 4)
  assert.deepEqual(ids(draft), ['r2', 'r3', 'r4', 'r5'])
})

test('头部是闸门记录时必须留住，改丢下一条', () => {
  // 这就是 B21 的全部内容：一把 splice(0, 1) 会把唯一的授权证据切掉
  const draft = make(5, [0])
  evictInPlace(draft, 4, isGate)
  assert.deepEqual(ids(draft), ['r0', 'r2', 'r3', 'r4'], '闸门记录 r0 应存活，被丢的是 r1')
})

test('分散的闸门记录全部保住，只丢等量的普通记录', () => {
  const draft = make(10, [0, 2, 4, 6, 8])
  evictInPlace(draft, 5, isGate)
  assert.deepEqual(ids(draft), ['r0', 'r2', 'r4', 'r6', 'r8'])
})

test('闸门记录在尾部时行为不变', () => {
  const draft = make(6, [5])
  evictInPlace(draft, 4, isGate)
  assert.deepEqual(ids(draft), ['r2', 'r3', 'r4', 'r5'])
})

test('整段都是闸门记录时仍服从上限（退化成丢最旧的）', () => {
  // 兜底路径：宁可丢一条闸门记录，也不能让文件无限长 ——
  // 磁盘写满会让应用先挂掉，那时候连丢了什么都查不出来
  const draft = make(5, [0, 1, 2, 3, 4])
  evictInPlace(draft, 4, isGate)
  assert.equal(draft.length, 4)
  assert.deepEqual(ids(draft), ['r1', 'r2', 'r3', 'r4'])
})

test('maxItems = 0 表示不限，不裁', () => {
  const draft = make(1000)
  evictInPlace(draft, 0, isGate)
  assert.equal(draft.length, 1000)
})

test('一次超出多条时，被保护的记录不占用淘汰名额', () => {
  const draft = make(8, [1, 3])
  evictInPlace(draft, 3, isGate)
  assert.deepEqual(ids(draft), ['r1', 'r3', 'r7'])
})

test('恰好等于上限时不裁', () => {
  const draft = make(4)
  evictInPlace(draft, 4)
  assert.deepEqual(ids(draft), ['r0', 'r1', 'r2', 'r3'])
})
