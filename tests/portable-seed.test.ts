/**
 * 口令封装的环境包（`src/main/core/portable-seed.ts`）。
 *
 * 这个文件存在的理由：`portable-seed.ts` 刻意零 electron 依赖，所以它的全部
 * 密码学行为都能在纯 Node 里被**真的跑一遍**。否则「导出→换机→导入后 seed 逐条
 * 相等」这条验收只能靠人手点，而人手点的东西不会每次都点。
 *
 * 跑法：node --experimental-strip-types --test tests/portable-seed.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BUNDLE_VERSION,
  MIN_PASSWORD_LENGTH,
  createOpener,
  createSealer
} from '../src/main/core/portable-seed.ts'

const PASSWORD = 'correct horse battery staple'

const PLAIN = [
  { name: '店铺A', platform: 'windows' },
  { name: '店铺B', platform: 'macos' }
]

const PAYLOADS = [
  {
    seed: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    fingerprint: { os: 'windows', uaVersion: '120.0.0.0' },
    proxyKey: 'socks5|1.2.3.4|1080|u1'
  },
  {
    seed: '0123456789abcdef0123456789abcdef',
    fingerprint: { os: 'macos', uaVersion: '121.0.0.0' }
  }
]

/** 建一个完整的小包：header + 两条密文 */
function buildBundle(password = PASSWORD) {
  const sealer = createSealer(password)
  const blobs = PLAIN.map((plain, i) => sealer.seal(plain, PAYLOADS[i], i))
  return { header: sealer.header, blobs }
}

test('往返：seed / fingerprint / proxyKey 逐条相等', () => {
  const { header, blobs } = buildBundle()
  const opener = createOpener(header, PASSWORD)
  const back = blobs.map((blob, i) => opener.open(blob, PLAIN[i], i))

  assert.equal(back[0].seed, PAYLOADS[0].seed)
  assert.deepEqual(back[0].fingerprint, PAYLOADS[0].fingerprint)
  assert.equal(back[0].proxyKey, PAYLOADS[0].proxyKey)
  assert.equal(back[1].seed, PAYLOADS[1].seed)
  assert.equal(back[1].proxyKey, undefined, '没有代理的环境不该凭空多出一个 proxyKey')
})

test('每条独立 nonce：同一条封两次，密文不同', () => {
  const sealer = createSealer(PASSWORD)
  const one = sealer.seal(PLAIN[0], PAYLOADS[0], 0)
  const two = sealer.seal(PLAIN[0], PAYLOADS[0], 0)
  assert.notEqual(one.iv, two.iv, 'GCM nonce 重用会直接毁掉机密性')
  assert.notEqual(one.ct, two.ct)
})

test('每条独立密钥：把第 1 条的密文挪到第 2 条的位置，必须解不开', () => {
  const { header, blobs } = buildBundle()
  const opener = createOpener(header, PASSWORD)
  assert.throws(
    () => opener.open(blobs[0], PLAIN[1], 1),
    /解不开/,
    '密文没有和它的位置绑定，等于可以任意对调身份'
  )
})

test('名字被改过：AAD 绑定必须让解密失败，而不是把 A 的身份装进 B 的名字里', () => {
  const { header, blobs } = buildBundle()
  const opener = createOpener(header, PASSWORD)
  assert.throws(() => opener.open(blobs[0], { name: '被改过的名字', platform: 'windows' }, 0), /解不开/)
})

test('平台被改过：同样失败', () => {
  const { header, blobs } = buildBundle()
  const opener = createOpener(header, PASSWORD)
  assert.throws(() => opener.open(blobs[0], { name: '店铺A', platform: 'linux' }, 0), /解不开/)
})

test('一条坏了不影响其它条（逐条独立封装的核心理由）', () => {
  const { header, blobs } = buildBundle()
  const broken = { ...blobs[0], ct: Buffer.from('garbage').toString('base64') }
  const opener = createOpener(header, PASSWORD)
  assert.throws(() => opener.open(broken, PLAIN[0], 0))
  // 第 2 条照样能开
  assert.equal(opener.open(blobs[1], PLAIN[1], 1).seed, PAYLOADS[1].seed)
})

test('错口令：明确报错，绝不返回空值或新 seed', () => {
  const { header, blobs } = buildBundle()
  const opener = createOpener(header, PASSWORD + 'x')
  assert.throws(
    () => opener.open(blobs[0], PLAIN[0], 0),
    (err) => {
      assert.match(err.message, /口令不正确/)
      return true
    }
  )
})

test('篡改密文 / tag / iv 各一个字节：GCM 必须检出', () => {
  const { header, blobs } = buildBundle()
  const opener = createOpener(header, PASSWORD)
  for (const field of ['ct', 'tag', 'iv']) {
    const raw = Buffer.from(blobs[0][field], 'base64')
    raw[0] ^= 0xff
    assert.throws(
      () => opener.open({ ...blobs[0], [field]: raw.toString('base64') }, PLAIN[0], 0),
      /解不开/,
      `${field} 被篡改却没有报错`
    )
  }
})

test('恶意参数 n=2^30：必须在派生之前拒绝，不能让导入方分配几十 GB', () => {
  const { header } = buildBundle()
  const started = Date.now()
  assert.throws(() => createOpener({ ...header, n: 2 ** 30 }, PASSWORD), /scrypt 参数 n/)
  const spent = Date.now() - started
  assert.ok(spent < 200, `参数校验必须在跑 scrypt 之前，实际耗时 ${String(spent)}ms`)
})

test('参数变小同样拒绝：削弱成本等于削弱口令', () => {
  const { header } = buildBundle()
  assert.throws(() => createOpener({ ...header, n: 2 ** 14 }, PASSWORD), /scrypt 参数 n/)
  assert.throws(() => createOpener({ ...header, r: 4 }, PASSWORD), /scrypt 参数 r/)
  assert.throws(() => createOpener({ ...header, p: 2 }, PASSWORD), /scrypt 参数 p/)
})

test('版本与算法不认识就拒绝，不猜', () => {
  const { header } = buildBundle()
  assert.throws(() => createOpener({ ...header, v: 3 }, PASSWORD), /不支持的环境包版本/)
  assert.throws(() => createOpener({ ...header, kdf: 'pbkdf2' }, PASSWORD), /不支持的口令派生算法/)
  assert.equal(header.v, BUNDLE_VERSION)
})

test('口令太短：导出时就拒绝，不留「看起来加密了」的弱包', () => {
  assert.throws(() => createSealer('x'.repeat(MIN_PASSWORD_LENGTH - 1)), /口令至少/)
})

test('seed 形态不对：导出时就拒绝', () => {
  const sealer = createSealer(PASSWORD)
  assert.throws(() => sealer.seal(PLAIN[0], { ...PAYLOADS[0], seed: 'NOT-HEX' }, 0), /不是 32 位小写 hex/)
  assert.throws(() => sealer.seal(PLAIN[0], { ...PAYLOADS[0], seed: 'a1b2c3' }, 0), /不是 32 位小写 hex/)
})

test('结构不合法：给一句能定位的话，不是 undefined 之类', () => {
  const { header, blobs } = buildBundle()
  assert.throws(() => createOpener(null, PASSWORD), /缺少口令派生头/)
  assert.throws(() => createOpener([], PASSWORD), /缺少口令派生头/)
  assert.throws(() => createOpener({ ...header, salt: undefined }, PASSWORD), /盐缺失/)
  const opener = createOpener(header, PASSWORD)
  assert.throws(() => opener.open(null, PLAIN[0], 0), /缺少密文段/)
  assert.throws(
    () => opener.open({ ...blobs[0], iv: Buffer.alloc(4).toString('base64') }, PLAIN[0], 0),
    /长度应为 12/
  )
})
