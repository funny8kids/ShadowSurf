/**
 * 批量设置代理时的文本解析。
 *
 * 单独放在 lib 里而不是留在 App.tsx：Node 的 `--experimental-strip-types`
 * 只剥类型、不做 JSX 转换，测试进程 import 不了 `.tsx`。这里只有纯解析逻辑，
 * 不碰 React / DOM，所以能被 tests/proxy-parse.test.ts 直接覆盖。
 */

import type { ProxyConfig, ProxyProtocol } from '@shared/types'

const ALLOWED_PROTOCOLS: readonly ProxyProtocol[] = ['http', 'https', 'socks5', 'socks5h']

/**
 * `host:port` / `protocol://user:pass@host:port` → ProxyConfig。
 *
 * 空串表示「改为直连」，返回 null。解析失败也返回 null（调用点统一把 null
 * 当作直连并提示），这样脏输入不会写进环境配置，只是无法区分「用户清空」
 * 与「粘贴了垃圾」——调用方若需要更精确的报错，应改成返回可区分的结果。
 */
export function parseProxy(raw: string): ProxyConfig | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // 旧实现有两个硬伤：
  //   1. `type: 'http'` 是硬编码的。用户粘 `socks5://...` 时，代理会被当成
  //      HTTP 代理交给 Chromium，对着 SOCKS5 端口说 HTTP，环境里所有页面
  //      都加载失败 —— 而界面显示「已切换代理」，看不出是协议被吞了。
  //   2. 用 `split(':')` 切 host/port。IPv6 字面量本身就含冒号，
  //      `[::1]:1080` 会被切成 host='['、port=':1]:1080'，直接切坏。
  //
  // 改用 WHATWG URL：协议、端口、凭证、IPv6 一次解析干净。
  // 裸地址按 http 补 scheme —— 商家后台复制出来的大多不带协议。
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`

  try {
    const u = new URL(withScheme)
    const protocol = u.protocol.replace(':', '')
    if (!ALLOWED_PROTOCOLS.includes(protocol as ProxyProtocol)) return null

    // 端口缺省沿用 8080（与旧行为一致）：不少代理只给 host 不给端口。
    // URL 已经拒绝 >65535 / 非数字的端口，这里再核一遍整数范围，
    // 防止将来换成别的 URL 实现时静默放进非法值。
    const port = u.port ? Number(u.port) : 8080
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null

    // IPv6 必须保留方括号：URL 的 hostname 对 `[::1]` 返回带括号的形式，
    // 而 session.ts 的 rulesFor() 会直接拼 `${host}:${port}` 交给 Chromium。
    // Chromium 的 proxyRules 用冒号分隔 host/port，IPv6 只有带方括号
    // （`[::1]:1080`）才能被识别成一个地址；去掉括号的 `::1:1080` 无法解析。
    return {
      type: protocol as ProxyProtocol,
      host: u.hostname,
      port,
      username: decodeURIComponent(u.username) || undefined,
      password: decodeURIComponent(u.password) || undefined
    }
  } catch {
    // URL 构造失败（含非法端口、空 host、未加括号的裸 IPv6 等）
    return null
  }
}
