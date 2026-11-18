/**
 * 标签分组 / 搜索纯函数测试。
 *
 * 被测模块不 import React / DOM / electron，所以可以像 share-platform.test.ts
 * 那样用 node:test 在 Node 里直接跑（--experimental-strip-types）。
 * 跑法：node --experimental-strip-types --test tests/tab-groups.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GROUP_COLORS,
  filterTabs,
  groupColor,
  groupTabs
} from '../src/renderer/lib/tab-groups.ts'
import type { GroupableTab, TabGroupMap } from '../src/renderer/lib/tab-groups.ts'

function tab(id: string, title: string, url: string, track: 'human' | 'shadow' = 'human'): GroupableTab {
  return { id, title, url, track }
}

/* ────────────────────────────── groupTabs ────────────────────────────── */

test('groupTabs：未分组标签排在最前，保持原始相对顺序', () => {
  const tabs = [tab('a', 'A', 'https://a.com'), tab('b', 'B', 'https://b.com')]
  const items = groupTabs(tabs, {})
  assert.deepEqual(
    items.map((i) => (i.kind === 'tab' ? i.tab.id : i.kind)),
    ['a', 'b']
  )
  assert.ok(items.every((i) => i.kind === 'tab' && i.group === null))
})

test('groupTabs：同组标签聚成一簇，簇前有一个 header，且顺序按首成员出现次序', () => {
  const tabs = [
    tab('a', 'A', 'https://a.com'),
    tab('b', 'B', 'https://b.com'),
    tab('c', 'C', 'https://c.com'),
    tab('d', 'D', 'https://d.com')
  ]
  const groups: TabGroupMap = { b: '工作', d: '购物', c: '工作' }
  const items = groupTabs(tabs, groups)

  // a 未分组 → 最前；接着首现的「工作」簇（b、c）；再是「购物」簇（d）
  assert.deepEqual(
    items.map((i) => (i.kind === 'header' ? `H:${i.label}` : i.tab.id)),
    ['a', 'H:工作', 'b', 'c', 'H:购物', 'd']
  )
  const workHeader = items.find((i) => i.kind === 'header' && i.label === '工作')
  assert.ok(workHeader && workHeader.kind === 'header')
  assert.equal(workHeader.count, 2)
})

test('groupTabs：header 带 token 色名与稳定 key，折叠可只按 group 字段过滤', () => {
  const items = groupTabs([tab('a', 'A', 'https://a.com')], { a: '研究' })
  const header = items.find((i) => i.kind === 'header')
  assert.ok(header && header.kind === 'header')
  assert.equal(header.key, 'group:研究')
  assert.ok((GROUP_COLORS as readonly string[]).includes(header.color))

  const first = items[0]
  assert.ok(first.kind === 'header')
  // 「折叠态」的测试：按 group 归属即可隐藏整簇，无需其它状态
  const collapsed = items.filter((i) => i.kind === 'header' || (i.kind === 'tab' && i.group === null))
  assert.equal(collapsed.length, 1)
  assert.equal(collapsed[0].kind, 'header')
})

test('groupTabs：空串组名视作未分组', () => {
  const items = groupTabs([tab('a', 'A', 'https://a.com')], { a: '   ' })
  assert.equal(items.length, 1)
  assert.ok(items[0].kind === 'tab' && items[0].group === null)
})

/* ────────────────────────────── groupColor ────────────────────────────── */

test('groupColor：同名同色，不同名可区分；返回值始终是调色板里的 token 名', () => {
  assert.equal(groupColor('工作'), groupColor('工作'))
  const seen = new Set<string>()
  for (const name of ['工作', '购物', '研究', '临时', '阅读']) {
    const color = groupColor(name)
    assert.ok((GROUP_COLORS as readonly string[]).includes(color))
    seen.add(color)
  }
  assert.ok(seen.size > 1, '不同组名应至少产生两种不同的颜色')
})

/* ────────────────────────────── filterTabs ────────────────────────────── */

const FILTER_TABS = [
  tab('a', 'GitHub 首页', 'https://github.com/dashboard'),
  tab('b', 'MDN Web Docs', 'https://developer.mozilla.org/zh-CN/'),
  tab('c', '购物车的秘密', 'https://shop.example.com/cart')
]

test('filterTabs：按标题匹配', () => {
  assert.deepEqual(filterTabs(FILTER_TABS, 'GitHub').map((t) => t.id), ['a'])
})

test('filterTabs：按 URL 匹配', () => {
  assert.deepEqual(filterTabs(FILTER_TABS, 'mozilla.org').map((t) => t.id), ['b'])
})

test('filterTabs：大小写不敏感', () => {
  assert.deepEqual(filterTabs(FILTER_TABS, 'github').map((t) => t.id), ['a'])
  assert.deepEqual(filterTabs(FILTER_TABS, 'MDN').map((t) => t.id), ['b'])
})

test('filterTabs：空查询（含纯空白）返回全部标签', () => {
  assert.equal(filterTabs(FILTER_TABS, '').length, FILTER_TABS.length)
  assert.equal(filterTabs(FILTER_TABS, '   ').length, FILTER_TABS.length)
})

test('filterTabs：无匹配返回空数组', () => {
  assert.deepEqual(filterTabs(FILTER_TABS, '不存在的关键词'), [])
})
