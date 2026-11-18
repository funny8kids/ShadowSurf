/**
 * Cookie 预热纯策略的回归测试。
 *
 * 被测模块 `src/main/modules/warmup-policy.ts` 不 import electron / store /
 * 网络，所以能像 tests/geo-match.test.ts 一样用 node:test 直接跑：
 *   node --experimental-strip-types --test tests/warmup.test.ts
 *
 * 守的是四件事：
 *   1. IPC 边界上的裸 JSON（非数组 / 数字 / null）不能让整理逻辑抛错；
 *   2. 只允许 http/https —— file:/data:/javascript: 必须进失败明细，不能静默丢；
 *   3. trim、去重保留首次出现、空白项忽略；
 *   4. 超过 30 条截断，且 truncated 只数「合法去重后」的条数。
 *
 * 另外顺手守住 10 条预热文案的 zh/en 键齐全：缺英文会回落到中文，
 * 界面上不容易发现，所以让测试替我们发现。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { WARMUP_MAX_URLS, normalizeWarmupUrls } from '../src/main/modules/warmup-policy.ts'
import { en, zh } from '../src/renderer/lib/i18n/catalog/tools2.ts'

/* ────────────────────────────── 入参形状 ────────────────────────────── */

test('normalizeWarmupUrls：非数组 → 空计划，不抛错', () => {
  const inputs: unknown[] = [null, undefined, '', 'https://a.example', 42, true, { urls: [] }]
  for (const input of inputs) {
    assert.deepEqual(
      normalizeWarmupUrls(input),
      { urls: [], rejected: [], truncated: 0 },
      `输入 ${String(input)}`
    )
  }
})

test('normalizeWarmupUrls：空白项忽略，不当作失败', () => {
  assert.deepEqual(normalizeWarmupUrls(['', '   ', '\t\n', ' \r\n ']), {
    urls: [],
    rejected: [],
    truncated: 0
  })
})

/* ────────────────────────────── 协议过滤 ────────────────────────────── */

test('normalizeWarmupUrls：只留 http/https，其它协议进 rejected', () => {
  const plan = normalizeWarmupUrls([
    'ftp://files.example/a',
    'file:///etc/passwd',
    'data:text/html,<h1>x</h1>',
    'javascript:alert(1)',
    'mailto:someone@example.com',
    'https://ok.example/'
  ])

  assert.deepEqual(plan.urls, ['https://ok.example/'])
  assert.deepEqual(plan.rejected, [
    'ftp://files.example/a',
    'file:///etc/passwd',
    'data:text/html,<h1>x</h1>',
    'javascript:alert(1)',
    'mailto:someone@example.com'
  ])
  assert.equal(plan.truncated, 0)
})

test('normalizeWarmupUrls：协议大小写不敏感，http 与 https 都保留', () => {
  const plan = normalizeWarmupUrls(['HTTP://A.example', 'HtTpS://b.example'])
  assert.deepEqual(plan.urls, ['HTTP://A.example', 'HtTpS://b.example'])
  assert.deepEqual(plan.rejected, [])
})

test('normalizeWarmupUrls：畸形 URL 与非字符串项进 rejected，原文保留', () => {
  const plan = normalizeWarmupUrls([
    'http://',
    'https://exa mple.com',
    'not a url',
    123,
    null,
    true,
    'https://ok.example'
  ])

  assert.deepEqual(plan.urls, ['https://ok.example'])
  assert.deepEqual(plan.rejected, [
    'http://',
    'https://exa mple.com',
    'not a url',
    '123',
    'null',
    'true'
  ])
})

/* ────────────────────────────── trim / 去重 ────────────────────────────── */

test('normalizeWarmupUrls：trim 并保留首次出现的原文', () => {
  const plan = normalizeWarmupUrls([
    '  https://a.example/path  ',
    'https://a.example/path',
    '\thttps://b.example\t',
    'HTTPS://B.EXAMPLE'
  ])

  assert.deepEqual(plan.urls, ['https://a.example/path', 'https://b.example'])
  assert.equal(plan.truncated, 0)
})

test('normalizeWarmupUrls：href 相同即视为同一地址（空路径与根路径）', () => {
  // 浏览器里 http://a.example 与 http://a.example/ 是同一个地址；
  // 不去重会让同一个页面被访问两次，停留时间翻倍，反而更像脚本。
  assert.deepEqual(
    normalizeWarmupUrls(['http://a.example', 'http://a.example/', 'http://a.example', 'http://a.example']).urls,
    ['http://a.example']
  )
})

test('normalizeWarmupUrls：路径 / 查询 / 片段不同不去重', () => {
  const plan = normalizeWarmupUrls([
    'https://a.example/x',
    'https://a.example/y',
    'https://a.example/x?q=1',
    'https://a.example/x#top'
  ])
  assert.equal(plan.urls.length, 4)
})

/* ────────────────────────────── 30 条上限 ────────────────────────────── */

test('normalizeWarmupUrls：上限是 30 条，超出截断并计数', () => {
  assert.equal(WARMUP_MAX_URLS, 30)

  const input = Array.from(
    { length: WARMUP_MAX_URLS + 5 },
    (_, i) => `https://site${i}.example/`
  )
  const plan = normalizeWarmupUrls(input)

  assert.equal(plan.urls.length, 30)
  assert.equal(plan.urls[0], 'https://site0.example/')
  assert.equal(plan.urls[29], 'https://site29.example/')
  assert.deepEqual(plan.rejected, [])
  assert.equal(plan.truncated, 5)
})

test('normalizeWarmupUrls：截断只数合法去重后的条数', () => {
  const input: unknown[] = []
  // 40 项但只有 25 个不同地址 → 达不到上限，不应报告截断
  for (let i = 0; i < 40; i += 1) input.push(`https://site${i % 25}.example/`)
  input.push('file:///tmp/x', '   ')

  const plan = normalizeWarmupUrls(input)
  assert.equal(plan.urls.length, 25)
  assert.deepEqual(plan.rejected, ['file:///tmp/x'])
  assert.equal(plan.truncated, 0)

  // 35 个不同地址 + 末尾重复 → 仍截掉 5 条
  const exact = Array.from({ length: 35 }, (_, i) => `https://n${i}.example/`)
  exact.push(...exact.slice(0, 10))
  const truncated = normalizeWarmupUrls(exact)
  assert.equal(truncated.urls.length, 30)
  assert.equal(truncated.truncated, 5)
  assert.equal(truncated.rejected.length, 0)
})

/* ────────────────────────────── i18n ────────────────────────────── */

const WARMUP_KEYS = [
  'data.warmup.button',
  'data.warmup.title',
  'data.warmup.desc',
  'data.warmup.urls',
  'data.warmup.urlsPlaceholder',
  'data.warmup.run',
  'data.warmup.running',
  'data.warmup.done',
  'data.warmup.failedDetail',
  'data.warmup.noProfile'
] as const

test('i18n：预热文案的 zh/en 键齐全且非空', () => {
  for (const key of WARMUP_KEYS) {
    assert.equal(typeof zh[key], 'string', `zh 缺少 ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺少 ${key}`)
    assert.ok(zh[key].length > 0, `zh 的 ${key} 为空`)
    assert.ok(en[key].length > 0, `en 的 ${key} 为空`)
  }
})

test('i18n：占位符在中英文里都存在', () => {
  for (const dict of [zh, en]) {
    assert.ok(dict['data.warmup.done'].includes('{ok}'))
    assert.ok(dict['data.warmup.done'].includes('{total}'))
    assert.ok(dict['data.warmup.failedDetail'].includes('{n}'))
  }
  // textarea 的 placeholder 必须真的是两行示例
  const lines = zh['data.warmup.urlsPlaceholder'].split('\n').filter((line) => line.trim() !== '')
  assert.equal(lines.length, 2)
  assert.equal(en['data.warmup.urlsPlaceholder'], zh['data.warmup.urlsPlaceholder'])
})
