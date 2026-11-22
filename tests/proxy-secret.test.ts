/**
 * 代理密码的落盘与写回规则。
 *
 * 这条链上出过两个真实缺陷，都很难从症状看出真因：
 *
 * 1. **写回抹掉真密码**：界面拿到的密码永远是脱敏占位符，
 *    用户改了主机或端口顺手一保存，占位符原样写回盘上 → 真密码消失。
 *    症状是"代理突然不认密码了"，而真因是用户刚才点了一下保存。
 * 2. **落盘是明文**：同一条凭据，走代理池写的是 `enc:`，
 *    走环境写入的却是明文 —— 而"哪条路径写进来的"是调用点决定的，不是数据决定的。
 *
 * 所以这里既有行为测试（纯函数），也有结构断言（密封点只有一个）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  MASKED_SECRET,
  isMaskedSecret,
  mergeProxyPassword
} from '../src/shared/proxy-secret.ts'

const ROOT = join(import.meta.dirname, '..')
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8')

test('脱敏占位符：写回时等于「不改这个字段」', () => {
  // 占位符 + 盘上有密码 → 保留盘上那份
  assert.equal(mergeProxyPassword(MASKED_SECRET, 'real-secret'), 'real-secret')
  // 占位符 + 盘上本来没密码 → 落成空串，不凭空造一个
  assert.equal(mergeProxyPassword(MASKED_SECRET, undefined), '')
  // 占位符 + 盘上是空串 → 还是空串
  assert.equal(mergeProxyPassword(MASKED_SECRET, ''), '')
})

test('脱敏占位符：新密码与主动清空都要被尊重', () => {
  // 新密码照原样写
  assert.equal(mergeProxyPassword('brand-new', 'old-secret'), 'brand-new')
  // 空串 = 用户主动清空，不能被当成「不改」
  assert.equal(mergeProxyPassword('', 'old-secret'), '')
  // undefined = 没有密码这个字段
  assert.equal(mergeProxyPassword(undefined, 'old-secret'), undefined)
})

test('脱敏占位符：判定只认那一个字符串', () => {
  assert.equal(isMaskedSecret(MASKED_SECRET), true)
  assert.equal(isMaskedSecret(''), false)
  assert.equal(isMaskedSecret(undefined), false)
  assert.equal(isMaskedSecret('real-secret'), false)
})

test('密封点只有一个：代理密码与 seed 走同一个落盘点', () => {
  const src = read('src/main/store/profiles.ts')
  // 落盘：密封
  assert.match(src, /sealIfPlain\(p\.proxy\.password\)/, '代理密码必须在 sealProfiles 里密封')
  // 读盘：还原成内存里的明文形态
  assert.match(src, /decryptSecret\(p\.proxy\.password\)/, '代理密码必须在读路径还原成明文')
  // 密封点唯一：不能在各个写方法里各封一次
  const seals = src.match(/sealIfPlain\(/g) ?? []
  assert.equal(seals.length, 1, `sealIfPlain 只能在密封点出现一次，实际 ${String(seals.length)} 次`)
})

test('界面不把占位符当成密码显示或写回', () => {
  const src = read('src/renderer/components/FingerprintDrawer.tsx')
  // 输入框的值不能是占位符本身（要显示成空 + 提示"已配置"）
  assert.doesNotMatch(
    src,
    /value=\{draft\.proxy\?\.password \?\? ''\}/,
    '密码框不能直接显示 draft 里的密码（那是占位符）'
  )
  assert.match(src, /proxyPasswordValue\(/, '密码框必须走 proxyPasswordValue 过滤占位符')
})

/* ────────────── 代理池的密封点：四条写路径都要加密 ────────────── */

test('代理池所有写路径都经过加密，不能有一条漏网', () => {
  const src = read('src/main/modules/proxy.ts')
  // create / update / import / checkAll 四条写路径，每条都要有 encryptSecret。
  // 之前 import 那条直接写明文，而 reveal() 对裸串原样返回 ——
  // 功能完全正常，只有看盘才能发现，所以必须靠结构断言钉住。
  const total = (src.match(/encryptSecret\(/g) ?? []).length
  assert.ok(
    total >= 4,
    `encryptSecret 至少出现 4 次（create / update / import / checkAll），实际 ${String(total)} 次`
  )
  // 存量密码迁移用的幂等密封
  assert.match(src, /sealIfPlain\(r\.password\)/, '存量明文密码必须在启动时封存')
  // 导入路径必须是加密的（紧挨着 parsed.value.password 的那一行）
  assert.match(
    src,
    /parsed\.value\.password\)\s*record\.password = encryptSecret\(/,
    'proxies.import 必须加密密码，不能写明文'
  )
})
