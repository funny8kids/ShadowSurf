/**
 * Webhook 目标地址的安全校验。
 *
 * ── 要防的是什么 ──
 * Webhook 由**主进程**（Node fetch，不在浏览器沙箱里）发出，
 * 因此它绕开了浏览器的 CORS / PNA / 代理策略 ——
 * 可以打到只对本机开放的管理接口（Docker 2375、各类 admin API），
 * 也可以打到云主机的元数据服务（169.254.169.254）去换 IAM 凭据。
 *
 * 原先只检查了协议（http/https），地址一概不问；
 * 而且 `fetch` **默认跟随重定向** ——
 * 于是「一个公网地址 302 到内网」这条路径也通。
 *
 * ── 现在的规则 ──
 * 1. 协议必须是 http/https（原有的规则）。
 * 2. 目标不能是回环 / 链路本地 / 私网 / CGNAT 地址，
 *    域名要**解析后**逐个检查（evil.com → 127.0.0.1 这条路要堵住）。
 * 3. 重定向**逐跳**重新校验，且最多跟几跳。
 * 4. 用户明确勾选「允许内网地址」时，第 2 条放行（有些人的回调就在自己家里）。
 *
 * 归属：webhooks-agent
 */

import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

/** 最多跟几跳重定向 */
export const MAX_REDIRECTS = 3

/**
 * 这个地址是不是"内网 / 本机 / 元数据"那类不该被主进程主动打到的地方。
 *
 * 纯函数（不解析 DNS），所以能被单测钉住。
 */
export function isPrivateAddress(address: string): boolean {
  const addr = address.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (addr === '') return false

  // 主机名（不是 IP）：localhost 与常见的内网命名
  if (isIP(addr) === 0) {
    if (addr === 'localhost' || addr.endsWith('.localhost')) return true
    // mDNS 与常见的内网后缀
    if (addr.endsWith('.local') || addr.endsWith('.internal') || addr.endsWith('.lan')) return true
    return false
  }

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr)
  if (v4 !== null) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 127) return true // 回环
    if (a === 10) return true // 私网 10/8
    if (a === 172 && b >= 16 && b <= 31) return true // 私网 172.16/12
    if (a === 192 && b === 168) return true // 私网 192.168/16
    if (a === 169 && b === 254) return true // 链路本地（含云元数据 169.254.169.254）
    if (a === 0) return true // 0.0.0.0/8 "本网络"
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
    if (a >= 224) return true // 组播 / 保留
    return false
  }

  // IPv6
  if (addr === '::1' || addr === '::') return true
  if (addr.startsWith('fe80')) return true // 链路本地 fe80::/10
  if (/^f[cd]/.test(addr)) return true // 唯一本地地址 fc00::/7
  // IPv4 映射（::ffff:127.0.0.1）按 IPv4 判
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr)
  if (mapped !== null) return isPrivateAddress(mapped[1])
  return false
}

/**
 * 校验一个回调地址是否可以投递。
 *
 * @param url       目标地址
 * @param allowInternal 用户是否明确勾选了「允许内网地址」
 * @returns 不通过时抛错，错误信息是给人看的
 */
export async function assertDeliverableTarget(url: string, allowInternal: boolean): Promise<void> {
  const parsed = new URL(url)
  const host = parsed.hostname.replace(/^\[|\]$/g, '')

  if (isPrivateAddress(host)) {
    if (allowInternal) return
    throw new Error(
      '回调地址指向本机或内网（回环 / 私网 / 链路本地 / 云元数据）地址，已拒绝投递。' +
        '如果确实要发到内网，请勾选「允许内网地址」。'
    )
  }

  // 域名：解析后逐个检查。evil.com 解析到 127.0.0.1 这条路必须堵住。
  if (isIP(host) === 0) {
    let addresses: Array<{ address: string }> = []
    try {
      addresses = await lookup(host, { all: true })
    } catch (err) {
      // 解析不了：交给 fetch 去报错，这里不重复判
      console.warn('[webhook] 域名解析失败：' + (err instanceof Error ? err.message : String(err)))
      return
    }
    for (const item of addresses) {
      if (isPrivateAddress(item.address)) {
        if (allowInternal) return
        throw new Error(
          `回调域名 ${host} 解析到了内网地址（${item.address}），已拒绝投递。` +
            '如果确实要发到内网，请勾选「允许内网地址」。'
        )
      }
    }
  }
}
