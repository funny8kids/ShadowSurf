/**
 * 跨机器搬运身份：**口令封装的环境包**（bundle v2）。
 *
 * ── 为什么需要它 ──
 *
 * `profile.seed` 现在被 `safeStorage` 封着（Windows 上是 DPAPI），而 DPAPI 绑定
 * 「当前登录用户 + 这台机器」。换机 / 换系统账户 / 重装系统之后，数据目录里的 seed
 * 全部解不开 —— 对用户是「所有环境身份一起没了」。这个模块提供唯一一条正当的
 * 跨机器通道：用**用户自己的口令**把要搬的身份封成一个可以走聊天工具 / 网盘的包。
 *
 * ── 为什么封 seed + fingerprint + proxyKey，而不是 master.key ──
 *
 * `master.key` 是全机所有身份的根。封它有两个问题：
 *   1. 只导出 1 个环境，泄露面却是这台机器上全部环境；
 *   2. 它的真正用途只有「给**新建**的环境派生 seed」—— 已存在的环境从来不重算
 *      （`deriveSeed` 只在 create / clone(newFingerprint) / regenerate 里被调用）。
 * 而 `fingerprint` 必须一起封：它是 `buildFingerprint(platform, seed)` 的**派生输出**，
 * 只封 seed 而明文放 fingerprint 等于封了个寂寞 —— 攻击者不需要 seed，
 * 直接读指纹参数就能复现这个身份。`proxyKey` 同理：它指向代理账号，
 * 泄露它等于泄露「这个店铺走哪条线路」。
 *
 * ── 分层：明文层 / 密封层 ──
 *
 * 明文层：版本号、KDF 参数、盐、每个环境的 `name` + `platform`。
 *   够人核对「这个包里有哪些环境」，不泄露任何身份参数。
 * 密封层：每个环境一个独立 blob（独立 nonce + 独立派生密钥）。
 *   逐条独立而不是整包一个 blob，理由有三个：
 *     - 导入时可以选择只导其中几条；
 *     - 一条坏了不影响其它条（整包一个 blob 的话，任何一位翻转就全废）；
 *     - 密文里绑定了该条的 `name|platform` 作为 AAD —— 有人把两个环境的密文对调，
 *       GCM 会直接失败，而不是安静地把 A 的身份装进 B 的名字里。
 *
 * ── 一次 scrypt，N 条各用各的密钥 ──
 *
 * 每条跑一次 `scrypt` 会是 50 × 70ms ≈ 3.5s，导入时卡死。所以：
 *   口令 --scrypt(盐)--> 包密钥 --HKDF(info="entry:<下标>")--> 每条的密钥
 * 每条再有自己随机的 GCM nonce。密钥分离与 nonce 独立都拿到了，成本只有一次 scrypt。
 *
 * ── 这个模块刻意零 electron 依赖 ──
 *
 * 它只做密码学，不碰 store / window / safeStorage，所以能用
 * `node --experimental-strip-types --test` 直接测（`tests/portable-seed.test.ts`）。
 * 加密逻辑如果只能靠「跑起整个 Electron 再手工点一遍」验证，那它实际上不会被验证。
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync } from 'node:crypto'

/** v2 的唯一合法 KDF 参数。导入时逐项比对，不做「宽松接受」 */
const KDF = { n: 2 ** 15, r: 8, p: 1, keyLen: 32 } as const

/**
 * scrypt 的内存上限。128 * N * r = 32MB，正好等于 Node 的默认 maxmem，
 * 边界上容易被判为超限，所以显式抬到 64MB。
 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024

/** 包格式版本。旧包（v1，不含身份）由 templates.ts 单独处理，不进这个模块 */
export const BUNDLE_VERSION = 2

/** 口令下限。太短的口令让 scrypt 的成本失去意义 */
export const MIN_PASSWORD_LENGTH = 8

/** 密文体积上限：导入的是用户选的任意文件，先挡住明显不合理的输入再解密 */
const MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024

const SEED_RE = /^[0-9a-f]{32}$/

/** 明文层：一个环境的可见信息。**不含任何身份参数** */
export interface PlainEntry {
  name: string
  platform: string
}

/** 密封层：解开之后才拿得到的东西 */
export interface SealedEntryPayload {
  seed: string
  /** `FingerprintConfig`，这里不引它的类型 —— 这个模块要对 @shared 保持零依赖 */
  fingerprint: unknown
  /**
   * 备注也进密封层，不进明文层。
   *
   * 明文层只放 `name` + `platform`，理由是「够人核对这个包里有哪几个环境」。
   * 备注不满足这个理由，却经常是最敏感的一栏 —— 「主店，绑定卡尾号 XXXX」、
   * 「这个号只走德国住宅」这类内容，泄露出去和泄露身份是同一级别的事。
   * 而它放在密文里不影响任何人核对包内容，因为核对靠的是名字。
   */
  note?: string
  proxyKey?: string
}

/** 单条密文。字段名直白，因为用户可能打开这个 JSON 看 */
export interface SealedBlob {
  /** base64，12 字节 GCM nonce。**每条独立** */
  iv: string
  /** base64，16 字节 GCM tag */
  tag: string
  /** base64，密文 */
  ct: string
}

/** 整个包的 KDF 头。所有条目共用一次 scrypt，靠 HKDF 分离出每条自己的密钥 */
export interface SealHeader {
  v: 2
  kdf: 'scrypt'
  n: number
  r: number
  p: number
  /** base64，16 字节随机盐 */
  salt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 导入时先验参数，再派生密钥。
 *
 * **顺序不能反。** 先跑 scrypt 再看参数，等于把「算多少内存」的决定权交给了
 * 文件内容 —— 一个 `n: 2**30` 的包就能让导入方分配几十 GB。这里必须逐项相等，
 * 不接受「比预期更小」：参数变小意味着攻击者可以用更低的成本爆破同一个包。
 */
function assertHeader(raw: unknown): SealHeader {
  if (!isRecord(raw)) throw new Error('环境包缺少口令派生头（kdf 段）')
  if (raw['v'] !== BUNDLE_VERSION) {
    throw new Error(`不支持的环境包版本：${String(raw['v'])}（本版本只认 v: ${String(BUNDLE_VERSION)}）`)
  }
  if (raw['kdf'] !== 'scrypt') {
    throw new Error(`不支持的口令派生算法：${String(raw['kdf'])}（本版本只认 scrypt）`)
  }
  const pairs: Array<[string, number]> = [
    ['n', KDF.n],
    ['r', KDF.r],
    ['p', KDF.p]
  ]
  for (const [key, expected] of pairs) {
    if (raw[key] !== expected) {
      throw new Error(
        `环境包的 scrypt 参数 ${key} 必须是 ${String(expected)}，实际 ${String(raw[key])}。` +
          '拒绝使用非标准参数：参数变小会削弱口令强度，参数变大会让导入方内存耗尽。'
      )
    }
  }
  const salt = raw['salt']
  if (typeof salt !== 'string' || Buffer.from(salt, 'base64').length !== 16) {
    throw new Error('环境包的盐缺失或长度不是 16 字节')
  }
  return {
    v: BUNDLE_VERSION,
    kdf: 'scrypt',
    n: KDF.n,
    r: KDF.r,
    p: KDF.p,
    salt
  }
}

/** 把 AAD 拼成「这条密文属于谁」的绑定。改名字或改平台都会让解密失败 */
function aadOf(index: number, plain: PlainEntry): Buffer {
  return Buffer.from(
    `shadowsurf/bundle/v2/entry:${String(index)}|${plain.name}|${plain.platform}`,
    'utf8'
  )
}

/** 从包密钥分离出第 index 条的密钥 */
function entryKey(packKey: Buffer, salt: Buffer, index: number): Buffer {
  return Buffer.from(
    hkdfSync('sha256', packKey, salt, Buffer.from(`entry:${String(index)}`, 'utf8'), 32)
  )
}

function derivePackKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KDF.keyLen, {
    N: KDF.n,
    r: KDF.r,
    p: KDF.p,
    maxmem: SCRYPT_MAXMEM
  })
}

/* ────────────────────────────── 封 ────────────────────────────── */

export interface Sealer {
  header: SealHeader
  /** 封一条。`index` 必须是这条在包里的位置，导入方靠它找回同一把密钥 */
  seal(plain: PlainEntry, payload: SealedEntryPayload, index: number): SealedBlob
}

/**
 * 建一个封装器：跑**一次** scrypt，之后每条只做 HKDF + AES-GCM。
 *
 * 入参顺序与位置**有意义**：导出方和导入方靠 `index` 把密文对回各自的环境，
 * 所以这里不做排序、不去重 —— 任何「顺手整理一下」都会让身份和名字错位。
 */
export function createSealer(password: string): Sealer {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `口令至少 ${String(MIN_PASSWORD_LENGTH)} 个字符：这个包一旦泄露，里面的身份就全部泄露`
    )
  }
  const salt = randomBytes(16)
  const packKey = derivePackKey(password, salt)

  return {
    header: {
      v: BUNDLE_VERSION,
      kdf: 'scrypt',
      n: KDF.n,
      r: KDF.r,
      p: KDF.p,
      salt: salt.toString('base64')
    },
    seal(plain, payload, index) {
      if (!SEED_RE.test(payload.seed)) {
        throw new Error(
          `「${plain.name}」的 seed 不是 32 位小写 hex（长度 ${String(payload.seed.length)}）`
        )
      }
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', entryKey(packKey, salt, index), iv)
      cipher.setAAD(aadOf(index, plain))
      const ct = Buffer.concat([
        cipher.update(JSON.stringify(payload), 'utf8'),
        cipher.final()
      ])
      return {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ct: ct.toString('base64')
      }
    }
  }
}

/* ────────────────────────────── 解 ────────────────────────────── */

export interface Opener {
  open(blob: unknown, plain: PlainEntry, index: number): SealedEntryPayload
}

/**
 * 建一个解封器。同样只跑一次 scrypt。
 *
 * 口令错误与密文被篡改在这里是**同一个结果**（GCM 校验失败），所以错误信息必须
 * 同时说这两种可能 —— 假装能区分只会把人引向错误的排查方向。
 *
 * 绝不返回「解不开就给个新的」：那会让用户以为导入成功，而实际上拿到了一整套
 * 陌生身份，且要等到登录某个站点时才发现。
 */
export function createOpener(header: unknown, password: string): Opener {
  const parsed = assertHeader(header)
  const salt = Buffer.from(parsed.salt, 'base64')
  const packKey = derivePackKey(password, salt)

  return {
    open(blob, plain, index) {
      if (!isRecord(blob)) throw new Error(`「${plain.name}」缺少密文段`)
      const iv = decodeField(blob, 'iv', 12, plain.name)
      const tag = decodeField(blob, 'tag', 16, plain.name)
      const ctRaw = blob['ct']
      if (typeof ctRaw !== 'string' || ctRaw === '') {
        throw new Error(`「${plain.name}」缺少密文（ct）`)
      }
      const ct = Buffer.from(ctRaw, 'base64')
      if (ct.length > MAX_CIPHERTEXT_BYTES) {
        throw new Error(`「${plain.name}」的密文体积异常（${String(ct.length)} 字节），拒绝解密`)
      }

      let text: string
      try {
        const decipher = createDecipheriv('aes-256-gcm', entryKey(packKey, salt, index), iv)
        decipher.setAAD(aadOf(index, plain))
        decipher.setAuthTag(tag)
        text = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
      } catch {
        throw new Error(
          `「${plain.name}」解不开：口令不正确，或这份环境包已损坏（无法通过完整性校验）。` +
            '（这两种情况在密文层面无法区分 —— 口令错、内容被改过、名字被改过都会得到同一个失败。）'
        )
      }

      let parsedPayload: unknown
      try {
        parsedPayload = JSON.parse(text)
      } catch {
        throw new Error(`「${plain.name}」解开后不是合法 JSON：这份包可能被其它工具写坏了`)
      }
      if (!isRecord(parsedPayload)) throw new Error(`「${plain.name}」解开后不是对象`)

      const seed = parsedPayload['seed']
      if (typeof seed !== 'string' || !SEED_RE.test(seed)) {
        throw new Error(
          `「${plain.name}」的 seed 形态不合法（长度 ${String(typeof seed === 'string' ? seed.length : 0)}）`
        )
      }
      const fingerprint = parsedPayload['fingerprint']
      if (fingerprint === null || typeof fingerprint !== 'object') {
        throw new Error(`「${plain.name}」缺少 fingerprint`)
      }
      const proxyKey = parsedPayload['proxyKey']
      const note = parsedPayload['note']
      return {
        seed,
        fingerprint,
        note: typeof note === 'string' && note !== '' ? note : undefined,
        proxyKey: typeof proxyKey === 'string' && proxyKey !== '' ? proxyKey : undefined
      }
    }
  }
}

function decodeField(blob: Record<string, unknown>, key: string, bytes: number, name: string): Buffer {
  const value = blob[key]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`「${name}」缺少字段「${key}」`)
  }
  const buf = Buffer.from(value, 'base64')
  if (buf.length !== bytes) {
    throw new Error(`「${name}」的「${key}」长度应为 ${String(bytes)} 字节，实际 ${String(buf.length)}`)
  }
  return buf
}
