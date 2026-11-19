/**
 * 代理组轮换规则测试（纯逻辑，node:test 直接跑）。
 *
 * 重点验证两件商业行为：
 * 1. 三种策略的候选顺序（轮询要让每次首选不同，粘性要永远同一条）；
 * 2. 入参清洗：重复 id、空白、脏类型不能悄悄进组。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  candidateOrder,
  isGroupUsable,
  isStrategy,
  nextCursor,
  normalizeProxyIds
} from '../src/main/modules/proxy-group-policy.ts'
import type { ProxyGroup, ProxyRecord } from '../src/shared/types.ts'

function proxy(id: string): ProxyRecord {
  return {
    id,
    name: id,
    protocol: 'http',
    host: `${id}.example`,
    port: 8080,
    lastCheck: null,
    createdAt: 1
  }
}

const A = proxy('a')
const B = proxy('b')
const C = proxy('c')
const all = [A, B, C]

test('round-robin：每次首选不同，且候选顺序覆盖全部出口', () => {
  const first = candidateOrder('round-robin', all, 0)
  assert.deepEqual(first.map((p) => p.id), ['a', 'b', 'c'])

  const second = candidateOrder('round-robin', all, nextCursor('round-robin', 0, 3))
  assert.deepEqual(second.map((p) => p.id), ['b', 'c', 'a'])

  const third = candidateOrder('round-robin', all, nextCursor('round-robin', 1, 3))
  assert.deepEqual(third.map((p) => p.id), ['c', 'a', 'b'])

  // 游标回绕
  assert.deepEqual(candidateOrder('round-robin', all, 3).map((p) => p.id), ['a', 'b', 'c'])
})

test('round-robin：出口被删后游标取模不越界', () => {
  const two = [A, B]
  assert.deepEqual(candidateOrder('round-robin', two, 5).map((p) => p.id), ['b', 'a'])
})

test('sticky：永远从第一条开始，故障转移仍按组内顺序', () => {
  assert.deepEqual(candidateOrder('sticky', all).map((p) => p.id), ['a', 'b', 'c'])
  assert.deepEqual(candidateOrder('sticky', all, 99).map((p) => p.id), ['a', 'b', 'c'])
  assert.equal(nextCursor('sticky', 0, 3), 0)
})

test('random：注入随机数可选中任意一条，且不重复', () => {
  assert.equal(candidateOrder('random', all, 0, 0)[0].id, 'a')
  assert.equal(candidateOrder('random', all, 0, 0.4)[0].id, 'b')
  assert.equal(candidateOrder('random', all, 0, 0.99)[0].id, 'c')
  for (const r of [0, 0.3, 0.7, 0.999]) {
    const order = candidateOrder('random', all, 0, r)
    assert.equal(new Set(order.map((p) => p.id)).size, 3)
  }
})

test('空池返回空候选', () => {
  for (const s of ['round-robin', 'random', 'sticky'] as const) {
    assert.deepEqual(candidateOrder(s, []), [])
  }
})

test('normalizeProxyIds：trim / 去空 / 去重 / 拒绝脏类型', () => {
  assert.deepEqual(normalizeProxyIds([' a ', 'b', 'a', '', '  ']), ['a', 'b'])
  assert.throws(() => normalizeProxyIds('a'), /数组/)
  assert.throws(() => normalizeProxyIds([1]), /字符串/)
})

test('isStrategy / isGroupUsable', () => {
  assert.equal(isStrategy('round-robin'), true)
  assert.equal(isStrategy('ROUND-ROBIN'), false)
  assert.equal(isStrategy('rotate'), false)
  const g = {
    id: 'pg_1',
    name: 'pool',
    proxyIds: ['a'],
    strategy: 'round-robin',
    failover: true,
    createdAt: 1
  } as ProxyGroup
  assert.equal(isGroupUsable(g), true)
  assert.equal(isGroupUsable({ ...g, proxyIds: [] }), false)
})
