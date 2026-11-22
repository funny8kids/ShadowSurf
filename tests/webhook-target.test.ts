/**
 * Webhook 目标的 SSRF 防护。
 *
 * Webhook 由**主进程**发出（Node fetch，不在浏览器沙箱里），绕开了浏览器的
 * CORS / PNA / 代理策略 —— 能打到只对本机开放的管理接口，也能打到云主机的
 * 元数据服务换 IAM 凭据。而原先只检查了协议，地址一概不问，
 * 且 `fetch` 默认跟随重定向（"公网地址 302 到内网"那条路也通）。
 *
 * 这里钉住"哪些地址算内网"这个判定表 —— 它是这条防线唯一容易写错的地方。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isPrivateAddress } from '../src/main/modules/webhook-target.ts'

test('回环 / 本机：全部拒', () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true)
  assert.equal(isPrivateAddress('127.13.9.2'), true)
  assert.equal(isPrivateAddress('0.0.0.0'), true)
  assert.equal(isPrivateAddress('::1'), true)
  assert.equal(isPrivateAddress('localhost'), true)
  assert.equal(isPrivateAddress('api.localhost'), true)
})

test('私网段：拒', () => {
  assert.equal(isPrivateAddress('10.0.0.5'), true)
  assert.equal(isPrivateAddress('192.168.1.1'), true)
  assert.equal(isPrivateAddress('172.16.0.1'), true)
  assert.equal(isPrivateAddress('172.31.255.254'), true)
})

test('链路本地（含云元数据）：拒', () => {
  assert.equal(isPrivateAddress('169.254.169.254'), true)
  assert.equal(isPrivateAddress('169.254.1.1'), true)
  assert.equal(isPrivateAddress('fe80::1'), true)
})

test('CGNAT / 唯一本地地址 / 组播：拒', () => {
  assert.equal(isPrivateAddress('100.64.0.1'), true)
  assert.equal(isPrivateAddress('fd00::1'), true)
  assert.equal(isPrivateAddress('fc00::1'), true)
  assert.equal(isPrivateAddress('224.0.0.1'), true)
})

test('IPv4 映射的 IPv6：按 IPv4 判', () => {
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true)
  assert.equal(isPrivateAddress('::ffff:10.1.2.3'), true)
  assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false)
})

test('公网地址：放行', () => {
  assert.equal(isPrivateAddress('1.1.1.1'), false)
  assert.equal(isPrivateAddress('8.8.8.8'), false)
  assert.equal(isPrivateAddress('93.184.216.34'), false)
  // 172.15 / 172.32 是公网，不在 172.16/12 里
  assert.equal(isPrivateAddress('172.15.0.1'), false)
  assert.equal(isPrivateAddress('172.32.0.1'), false)
  // 100.128 在 CGNAT 之外
  assert.equal(isPrivateAddress('100.128.0.1'), false)
})

test('普通域名与内网后缀域名', () => {
  assert.equal(isPrivateAddress('example.com'), false)
  assert.equal(isPrivateAddress('hooks.my-company.io'), false)
  assert.equal(isPrivateAddress('nas.local'), true)
  assert.equal(isPrivateAddress('db.internal'), true)
})
