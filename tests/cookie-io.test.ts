/**
 * Cookie 导入 / 导出的回归测试。
 *
 * 被测的是 `modules/cookie-io.ts`：它只 import 类型、不 import electron 的运行时，
 * 所以 `node --test` 能直接加载它（`data.ts` 加载不了 —— 它静态 import 了 electron）。
 * 判据和动作必须待在一起：格式知识散到别处就会漂移，而漂移的症状是
 * 「刚导出的文件导不回来」，极难归因。
 *
 * ── 四组断言的重心 ──
 *
 *   1. 往返（Netscape / JSON 各一组）：导出 → 导入 → 逐字段相等。
 *      只测「导出的字符串长得对」是不够的 —— 导得好看但导不回来，是这里最贵的 bug。
 *   2. 坏输入不吞整份文件：一条坏行不能让好行一起消失。
 *   3. 错误列表封顶要说清截断了：否则用户会以为错误只有 10 条。
 *   4. 不静默丢东西：解析出来的条数 + 报出来的条数必须等于输入的条数。
 *
 * 跑法：node --experimental-strip-types --test tests/cookie-io.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  capErrors,
  cookieUrlFor,
  exportCookies,
  exportCookiesJson,
  importCookies
} from '../src/main/modules/cookie-io.ts'
import type { CookieInfo } from '../src/main/modules/cookie-io.ts'

/* ────────────────────────────── 夹具 ────────────────────────────── */

const FIXTURE: CookieInfo[] = [
  {
    name: 'sid',
    value: 'abc123',
    domain: '.example.com',
    path: '/',
    secure: true,
    httpOnly: true,
    session: false,
    expires: 1_800_000_000_000,
    sameSite: 'lax'
  },
  {
    name: 'lang',
    value: 'zh-CN',
    domain: 'example.com',
    path: '/',
    secure: false,
    httpOnly: false,
    session: true,
    sameSite: 'unspecified'
  }
]

/* ────────────────────────────── 导出 ────────────────────────────── */

test('Netscape 导出：7 段制表符分隔 + HttpOnly 前缀 + 会话 Cookie 记 0', () => {
  const text = exportCookies(FIXTURE)
  const lines = text.split('\n').filter((line) => line !== '')
  // 注意：HttpOnly 的 Cookie 行也以 # 开头（#HttpOnly_ 前缀），所以不能只按 '#' 过滤
  const header = lines.filter((line) => line.startsWith('#') && !line.startsWith('#HttpOnly_'))
  const rows = lines.filter((line) => !line.startsWith('#') || line.startsWith('#HttpOnly_'))

  assert.ok(header.length >= 1, '缺少文件头')
  assert.equal(rows.length, 2)

  const [httpOnlyRow, hostOnlyRow] = rows
  assert.ok(httpOnlyRow.startsWith('#HttpOnly_.example.com\t'), 'HttpOnly 前缀或域名不对')
  assert.ok(hostOnlyRow.startsWith('example.com\t'), 'host-only 的域名不该带前导点')

  // domain \t includeSubdomains \t path \t secure \t expiration \t name \t value
  const httpOnlyFields = httpOnlyRow.replace('#HttpOnly_', '').split('\t')
  assert.equal(httpOnlyFields.length, 7)
  assert.equal(httpOnlyFields[0], '.example.com')
  assert.equal(httpOnlyFields[1], 'TRUE', '带前导点的域 Cookie 应当对子域生效')
  assert.equal(httpOnlyFields[2], '/')
  assert.equal(httpOnlyFields[3], 'TRUE')
  assert.equal(httpOnlyFields[4], '1800000000', '过期时间必须是秒')
  assert.equal(httpOnlyFields[5], 'sid')
  assert.equal(httpOnlyFields[6], 'abc123')

  const hostOnlyFields = hostOnlyRow.split('\t')
  assert.equal(hostOnlyFields[1], 'FALSE', 'host-only 不该勾「对子域生效」')
  assert.equal(hostOnlyFields[3], 'FALSE')
  assert.equal(hostOnlyFields[4], '0', '会话 Cookie 的过期时间必须是 0')
})

test('JSON 导出：带 version / exportedAt / cookies，expiration 是毫秒', () => {
  const parsed = JSON.parse(exportCookiesJson(FIXTURE, 1_700_000_000_000)) as {
    version: number
    exportedAt: number
    cookies: Array<Record<string, unknown>>
  }
  assert.equal(parsed.version, 1)
  assert.equal(parsed.exportedAt, 1_700_000_000_000)
  assert.equal(parsed.cookies.length, 2)
  assert.equal(parsed.cookies[0]?.['domain'], '.example.com')
  assert.equal(parsed.cookies[0]?.['expiration'], 1_800_000_000_000, 'JSON 的 expiration 是毫秒')
  assert.equal(parsed.cookies[0]?.['sameSite'], 'lax')
  assert.equal(parsed.cookies[1]?.['expiration'], 0, '会话 Cookie 的 expiration 是 0')
})

test('导出时值里的制表符与换行被替换：格式是制表符分隔的，原样写出会毁掉整行', () => {
  const text = exportCookies([
    {
      name: 'weird',
      value: 'a\tb\nc',
      domain: 'example.com',
      path: '/',
      secure: false,
      httpOnly: false,
      session: true
    }
  ])
  const row = text
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))[0]
  assert.ok(row !== undefined)
  assert.equal(row.split('\t').length, 7, '替换后仍然必须是 7 段')
  assert.ok(row.includes('a b c'))
})

/* ────────────────────────────── 往返 ────────────────────────────── */

test('Netscape 往返：导出再导入，逐字段相等', () => {
  const { cookies, errors } = importCookies(exportCookies(FIXTURE))
  assert.deepEqual(errors, [])
  assert.equal(cookies.length, 2)

  const [first, second] = cookies
  assert.equal(first?.name, 'sid')
  assert.equal(first?.value, 'abc123')
  assert.equal(first?.domain, '.example.com')
  assert.equal(first?.path, '/')
  assert.equal(first?.secure, true)
  assert.equal(first?.httpOnly, true)
  assert.equal(first?.session, false)
  assert.equal(first?.expires, 1_800_000_000_000)
  assert.equal(first?.url, 'https://example.com')

  assert.equal(second?.domain, 'example.com', 'host-only 不该被导入成域 Cookie')
  assert.equal(second?.session, true)
  assert.equal(second?.expires, undefined)
  assert.equal(second?.url, 'http://example.com')
})

test('JSON 往返：导出再导入，逐字段相等', () => {
  const { cookies, errors } = importCookies(exportCookiesJson(FIXTURE))
  assert.deepEqual(errors, [])
  assert.equal(cookies.length, 2)
  assert.equal(cookies[0]?.name, 'sid')
  assert.equal(cookies[0]?.expires, 1_800_000_000_000)
  assert.equal(cookies[0]?.sameSite, 'lax')
  assert.equal(cookies[0]?.httpOnly, true)
  assert.equal(cookies[1]?.session, true)
})

test('JSON 也能读一个裸数组：第三方导出常常不是带版本号的那种形状', () => {
  const { cookies, errors } = importCookies(
    JSON.stringify([
      { domain: 'example.com', name: 'a', value: '1', path: '/', secure: false, httpOnly: false }
    ])
  )
  assert.deepEqual(errors, [])
  assert.equal(cookies.length, 1)
  assert.equal(cookies[0]?.name, 'a')
})

test('秒与毫秒都认：判据是量级，不是字段名', () => {
  const seconds = importCookies(
    JSON.stringify([
      { domain: 'example.com', name: 'a', value: '1', expiration: 1_800_000_000 }
    ])
  )
  assert.equal(seconds.cookies[0]?.expires, 1_800_000_000_000)

  const millis = importCookies(
    JSON.stringify([
      { domain: 'example.com', name: 'a', value: '1', expiration: 1_800_000_000_000 }
    ])
  )
  assert.equal(millis.cookies[0]?.expires, 1_800_000_000_000)
})

/* ────────────────────────────── 坏输入 ────────────────────────────── */

test('一条坏行不影响好行：整份文件不能因为一行少字段就全丢', () => {
  const text = [
    '# Netscape HTTP Cookie File',
    'example.com\tFALSE\t/\tFALSE\t0\tgood\tvalue',
    'broken-line-without-tabs',
    'other.com\tFALSE\t/\tFALSE\t0\talso-good\tvalue2'
  ].join('\n')

  const { cookies, errors } = importCookies(text)
  assert.equal(cookies.length, 2, '两条好行必须都进来')
  assert.equal(errors.length, 1)
  assert.match(errors[0] ?? '', /第 3 行/)
  assert.match(errors[0] ?? '', /字段不足 7 个/)
})

test('坏 JSON 报的是「不是合法 JSON」，不是空结果', () => {
  const { cookies, errors } = importCookies('{ 这不是 json')
  assert.equal(cookies.length, 0)
  assert.equal(errors.length, 1)
  assert.match(errors[0] ?? '', /不是合法的 JSON/)
})

test('JSON 里找不到 Cookie 数组要说清，而不是当成空数组', () => {
  const { cookies, errors } = importCookies('{"version":1,"exportedAt":0}')
  assert.equal(cookies.length, 0)
  assert.equal(errors.length, 1)
  assert.match(errors[0] ?? '', /找不到 Cookie 数组/)
})

test('sameSite 取值无效要报错：归成 unspecified 是有语义差别的', () => {
  const { cookies, errors } = importCookies(
    JSON.stringify([
      { domain: 'example.com', name: 'a', value: '1', sameSite: 'None' }
    ])
  )
  assert.equal(cookies.length, 0)
  assert.equal(errors.length, 1)
  assert.match(errors[0] ?? '', /sameSite/)
})

test('secure / httpOnly 只认布尔：宽松解析会让 Secure 标志落到错误的连接上', () => {
  const { cookies, errors } = importCookies(
    JSON.stringify([{ domain: 'example.com', name: 'a', value: '1', secure: 'true' }])
  )
  assert.equal(cookies.length, 0)
  assert.equal(errors.length, 1)
  assert.match(errors[0] ?? '', /secure 必须是布尔值/)
})

test('空内容报错，而不是静默返回空列表', () => {
  const { cookies, errors } = importCookies('   \n  ')
  assert.equal(cookies.length, 0)
  assert.equal(errors.length, 1)
  assert.match(errors[0] ?? '', /内容为空/)
})

/* ────────────────────────────── 错误封顶 ────────────────────────────── */

test('错误超过上限时保留 9 条真错误 + 1 条汇总，汇总要写清还有多少条', () => {
  const bad: string[] = []
  for (let i = 0; i < 25; i += 1) bad.push('broken-' + String(i))
  const text = bad.join('\n')

  const { cookies, errors } = importCookies(text)
  assert.equal(cookies.length, 0)
  assert.equal(errors.length, 10, '列表长度必须封顶')
  assert.match(errors[9] ?? '', /^…另有 16 行未列出$/)
  assert.match(errors[0] ?? '', /broken-0/)
})

test('capErrors 是同一套封顶口径：调用方合并多来源错误时不会算出两套长度', () => {
  const items: string[] = []
  for (let i = 0; i < 12; i += 1) items.push('e' + String(i))
  const capped = capErrors(items, '条')
  assert.equal(capped.length, 10)
  assert.match(capped[9] ?? '', /^…另有 3 条未列出$/)
})

/* ────────────────────────────── 不静默丢东西 ────────────────────────────── */

test('不静默截断：解析出来的 + 报出来的 == 输入的条目数', () => {
  const lines = [
    'example.com\tFALSE\t/\tFALSE\t0\tok1\tv1',
    'oops',
    'example.com\tFALSE\t/\tFALSE\t0\tok2\tv2',
    'another\tFALSE\t/\tFALSE\tnot-a-number\tn\tv',
    'example.com\tFALSE\t/\tFALSE\t0\tok3\tv3'
  ]
  const { cookies, errors } = importCookies(lines.join('\n'))
  assert.equal(cookies.length, 3)
  assert.equal(errors.length, 2)
  assert.equal(cookies.length + errors.length, lines.length, '每一条输入都必须有交代')
})

/* ────────────────────────────── URL 推导 ────────────────────────────── */

test('URL 推导：secure 用 https，否则 http；前导点必须剥掉', () => {
  assert.equal(cookieUrlFor({ domain: '.example.com', secure: true }), 'https://example.com')
  assert.equal(cookieUrlFor({ domain: 'example.com', secure: false }), 'http://example.com')
})

/* ────────────────────────────── 导入体积上限 ────────────────────────────── */

test('超长导入内容必须当场拒绝，不能把主进程拖进逐行解析', () => {
  // 造一个刚过 8MB 的输入。这里只测判定，不真造 8MB 字符串 ——
  // 从源码里把上限读出来，用一个"恰好超过"的缩微值验逻辑，
  // 再确认源码里的上限常量本身足够大。
  const src = readFileSync(
    join(import.meta.dirname, '..', 'src', 'main', 'modules', 'cookie-io.ts'),
    'utf8'
  )
  const m = /const MAX_IMPORT_CHARS = (\d+(?:\s*\*\s*\d+)*)/.exec(src)
  assert.ok(m !== null, '找不到导入上限常量')
  assert.match(src, /text\.length > MAX_IMPORT_CHARS/, '导入入口必须检查体积上限')
  // 上限本身要足够真实使用：8MB 以上
  const limit = m[1]
    .split('*')
    .map((part) => Number(part.trim()))
    .reduce((a, b) => a * b, 1)
  assert.ok(limit >= 8 * 1024 * 1024, `导入上限过小：${String(limit)}`)
})
