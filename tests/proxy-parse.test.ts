/**
 * 批量设置代理的文本解析测试（纯逻辑）。
 *
 * 被测模块 src/renderer/lib/proxy-parse.ts 只有 type-only import，
 * 没有 React / DOM / electron 运行时依赖，所以能像 team.test.ts 一样
 * 用 node:test + --experimental-strip-types 直接在纯 Node 里跑：
 *   node --experimental-strip-types --test tests/proxy-parse.test.ts
 *
 * 守的是三个曾经会静默出错的点：
 *   1. 协议被硬编码成 http（粘 socks5:// 后代理直接不可用）；
 *   2. IPv6 被 split(':') 切坏；
 *   3. 非法端口 / 非法协议被放行或静默兜底。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseProxy } from '../src/renderer/lib/proxy-parse.ts'

/* ────────────────────────────── 空值与直连 ────────────────────────────── */

test('空串 / 纯空白 → null（调用方按直连处理）', () => {
  assert.equal(parseProxy(''), null)
  assert.equal(parseProxy('   \t\n '), null)
})

/* ────────────────────────────── 协议 ────────────────────────────── */

test('裸 host:port 默认按 http 解析', () => {
  const p = parseProxy('1.2.3.4:8080')
  assert.notEqual(p, null)
  assert.equal(p?.type, 'http')
  assert.equal(p?.host, '1.2.3.4')
  assert.equal(p?.port, 8080)
})

test('显式 http / https scheme 会被保留', () => {
  const http = parseProxy('http://1.2.3.4:3128')
  assert.equal(http?.type, 'http')
  assert.equal(http?.port, 3128)

  const https = parseProxy('https://proxy.example.com:8443')
  assert.equal(https?.type, 'https')
  assert.equal(https?.host, 'proxy.example.com')
  assert.equal(https?.port, 8443)
})

test('socks5 不再被硬编码成 http', () => {
  const p = parseProxy('socks5://1.2.3.4:1080')
  assert.equal(p?.type, 'socks5')
  assert.equal(p?.host, '1.2.3.4')
  assert.equal(p?.port, 1080)
})

test('socks5h 保留远程 DNS 语义，不被降成 socks5', () => {
  const p = parseProxy('socks5h://1.2.3.4:1080')
  assert.equal(p?.type, 'socks5h')
  assert.equal(p?.port, 1080)
})

test('不支持的协议 → null（不猜、不静默当 http）', () => {
  assert.equal(parseProxy('ftp://1.2.3.4:21'), null)
  assert.equal(parseProxy('socks://1.2.3.4:1080'), null)
  assert.equal(parseProxy('file:///etc/passwd'), null)
})

/* ────────────────────────────── 凭证 ────────────────────────────── */

test('user:pass@host:port（无 scheme）按 http 解析出凭证', () => {
  const p = parseProxy('alice:secret@1.2.3.4:1080')
  assert.equal(p?.type, 'http')
  assert.equal(p?.username, 'alice')
  assert.equal(p?.password, 'secret')
})

test('URL 编码的凭证会被解码', () => {
  const p = parseProxy('socks5://user:p%40ss%3Aword@1.2.3.4:1080')
  assert.equal(p?.username, 'user')
  assert.equal(p?.password, 'p@ss:word')
})

test('没有凭证时不写 username / password', () => {
  const p = parseProxy('1.2.3.4:1080')
  assert.equal(p?.username, undefined)
  assert.equal(p?.password, undefined)
})

/* ────────────────────────────── IPv6 ────────────────────────────── */

test('IPv6 [::1]:1080 不会被冒号切坏，且保留方括号', () => {
  // 保留方括号是刻意的：session.ts 的 rulesFor() 直接拼 `${host}:${port}`
  // 交给 Chromium，Chromium 的 proxyRules 里 IPv6 必须写成 `[::1]:1080`。
  const p = parseProxy('[::1]:1080')
  assert.notEqual(p, null)
  assert.equal(p?.host, '[::1]')
  assert.equal(p?.port, 1080)
  assert.equal(p?.type, 'http')
})

test('完整 IPv6 URL（含协议与凭证）', () => {
  const p = parseProxy('socks5://u:p@[2001:db8::1]:1080')
  assert.equal(p?.type, 'socks5')
  assert.equal(p?.host, '[2001:db8::1]')
  assert.equal(p?.port, 1080)
  assert.equal(p?.username, 'u')
  assert.equal(p?.password, 'p')
})

test('IPv6 缺省端口回落 8080', () => {
  const p = parseProxy('socks5h://[2001:db8::1]')
  assert.equal(p?.host, '[2001:db8::1]')
  assert.equal(p?.port, 8080)
})

test('未加方括号的裸 IPv6 是歧义输入 → null', () => {
  // 无法区分 `::1:1080` 里的最后一段是端口还是地址的一部分，宁可拒绝
  assert.equal(parseProxy('::1:1080'), null)
})

/* ────────────────────────────── 端口 ────────────────────────────── */

test('缺省端口沿用 8080（兼容只给 host 的代理）', () => {
  const p = parseProxy('proxy.example.com')
  assert.equal(p?.host, 'proxy.example.com')
  assert.equal(p?.port, 8080)
})

test('非法端口 → null，不静默改成 8080', () => {
  assert.equal(parseProxy('1.2.3.4:70000'), null)
  assert.equal(parseProxy('1.2.3.4:0'), null)
  assert.equal(parseProxy('1.2.3.4:abc'), null)
  assert.equal(parseProxy('1.2.3.4:-1'), null)
})

/* ────────────────────────────── 脏输入 ────────────────────────────── */

test('无法解析的输入 → null', () => {
  assert.equal(parseProxy('http://'), null)
  assert.equal(parseProxy('http://[::1'), null)
  assert.equal(parseProxy('not a host'), null)
})

test('前后空白会被 trim', () => {
  const p = parseProxy('  socks5://1.2.3.4:1080  ')
  assert.equal(p?.type, 'socks5')
  assert.equal(p?.host, '1.2.3.4')
  assert.equal(p?.port, 1080)
})
