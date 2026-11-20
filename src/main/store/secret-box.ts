/**
 * 本机凭据的静态加密（safeStorage 封装）。
 *
 * ── 为什么需要 ──
 * seed、LLM API Key、本地 API token 都已经用 `safeStorage`（Windows DPAPI /
 * macOS Keychain / Linux libsecret）封装，唯独**代理密码是明文**落盘。
 * 这是这一层最刺眼的不一致：拿到数据目录 = 拿到所有指纹，同时也拿到所有
 * 代理账号的密码，而它们往往就是目标站的登录凭据。
 *
 * ── 格式 ──
 *   `enc:<base64>`  = safeStorage 密文
 *   `raw:<明文>`    = 明文（safeStorage 不可用时的降级）
 *   `裸字符串`       = 老数据（未加密），读取时按明文处理
 *
 * ── 降级策略 ──
 * safeStorage 不可用时**明确降级为明文并写 `raw:` 前缀**，不假装安全。
 * 与 `seed-seal.ts` 同一口径：这台机器上「拿到数据目录 = 拿到全部凭据」
 * 的前提没有解除，必须在日志里说清楚，而不是让人以为加密生效了。
 */

import { safeStorage } from 'electron'

export const ENC_PREFIX = 'enc:'
export const RAW_PREFIX = 'raw:'

/** 加密一个明文密码；空串原样返回 */
export function encryptSecret(plain: string): string {
  if (plain.length === 0) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
    }
  } catch {
    /* 加密后端异常，走明文降级 */
  }
  return RAW_PREFIX + plain
}

/** 解密；老数据（裸字符串）按明文返回 */
export function decryptSecret(stored: string): string {
  if (stored.length === 0) return ''
  if (stored.startsWith(RAW_PREFIX)) return stored.slice(RAW_PREFIX.length)
  if (!stored.startsWith(ENC_PREFIX)) return stored
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
  } catch {
    // 换了机器 / 换了系统账户就解不开了，当作没有密码
    return ''
  }
}

/**
 * 给「要写回盘的值」用：如果 patch 里的值已经是密文（enc:/raw: 前缀），
 * 说明调用方把读出来的值原样传回，不要再加密一次。
 *
 * 不处理这个的话，「读取 → 保存」一个来回就会把密文再加密一层，
 * 第二次读取解出来的是上一层的密文字符串，代理认证直接失败。
 */
export function sealIfPlain(value: string): string {
  if (value.startsWith(ENC_PREFIX) || value.startsWith(RAW_PREFIX)) return value
  return encryptSecret(value)
}

/** 给「要用在请求里」的值用：可能是密文，也可能是明文 */
export function revealSecret(value: string): string {
  return decryptSecret(value)
}