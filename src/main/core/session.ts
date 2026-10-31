/**
 * 环境隔离层：一个 Profile 一个 partition。
 *
 * 隔离的根本不在渲染层，而在 Chromium 的 storage partition：
 * `persist:ss_<profileId>` 让 cookie / localStorage / IndexedDB / cache 全部落在
 * 独立的 userData 子目录里，两个环境之间天然不可见。
 *
 * 这里只负责「能在 session 层设置的东西」——UA、Accept-Language、拼写检查、代理。
 * 时区 / 屏幕 / WebGL 等只能在页面 JS 里伪造，交给指纹注入脚本，不在这里做。
 */

import { app, session } from 'electron'
import type { Session } from 'electron'
import type { Profile, ProxyConfig } from '@shared/types'

const PARTITION_PREFIX = 'persist:ss_'

/** Chromium 的 session 身份由 partition 字符串决定，profileId 本身是安全的 base32，无需转义 */
export function partitionFor(profileId: string): string {
  return `${PARTITION_PREFIX}${profileId}`
}

export function sessionFor(profileId: string): Session {
  return session.fromPartition(partitionFor(profileId))
}

export async function applyProfileToSession(ses: Session, profile: Profile): Promise<void> {
  const fp = profile.fingerprint

  // UA 与 Accept-Language 必须同时设置：只改 UA 不改语言头是最常见的指纹破绽。
  // Electron 45 起 Session 没有独立的 setAcceptLanguages，语言只能随 setUserAgent 一起给。
  ses.setUserAgent(fp.userAgent, fp.languages.join(','))

  applySpellChecker(ses, fp.languages)

  applyWebRtcPolicy(ses, profile)

  await applyProxy(ses, profile.proxy)
}

/**
 * WebRTC 的 UDP **不走 HTTP 代理**，这是真实 IP 最主要的泄漏面。
 *
 * 只在页面 JS 里丢 srflx 候选是补丁级别的修法：ICE 收集本身仍在直连，
 * 任何绕过我们那层包装的路径（Worker、iframe 里的新 RTCPeerConnection、
 * 或者我们没覆盖到的 API）都能拿到真实公网地址。
 * 必须在 Chromium 侧把「非代理 UDP」整个关掉，这才是根上的修法。
 *
 * 没有代理时不动（`real` 是用户明确要真实 WebRTC 的选项）。
 */
function applyWebRtcPolicy(ses: Session, profile: Profile): void {
  const webrtc = profile.fingerprint.webrtc
  // 注意：`proxy` 模式下**不管当前有没有配代理**都要关掉非代理 UDP。
  // 早先写成 `webrtc === 'proxy' && profile.proxy`，等于「先配环境、后挂代理」时
  // 环境根本没有防护 —— 而这段代码看起来恰恰是「更谨慎的那个分支」。
  // 用户选了 proxy 语义，就是要求 WebRTC 不许绕过代理，与当前是否已挂代理无关。
  const policy =
    webrtc === 'disabled' || webrtc === 'proxy' ? 'disable_non_proxied_udp' : 'default'

  // Electron 各版本对 Session 上这个方法的存在性不一致，用能力检测而不是断言
  const target = ses as Session & {
    setWebRTCIPHandlingPolicy?: (p: string) => void
  }
  if (typeof target.setWebRTCIPHandlingPolicy !== 'function') return
  try {
    target.setWebRTCIPHandlingPolicy(policy)
  } catch {
    // 旧内核不支持该策略值时退化为默认，不阻断环境启动
  }
}

export async function applyProxy(ses: Session, proxy: ProxyConfig | null): Promise<void> {
  if (!proxy) {
    proxyBySession.delete(ses)
    await ses.setProxy({ mode: 'direct' })
    return
  }

  // 先登记凭据再设代理：setProxy 生效后第一个 CONNECT 可能立刻挑战认证
  if (proxy.username) {
    proxyBySession.set(ses, proxy)
    ensureLoginHook()
  } else {
    proxyBySession.delete(ses)
  }

  await ses.setProxy({
    proxyRules: rulesFor(proxy),
    // 负号前缀表示「连回环地址也走代理」，避免本机请求泄漏真实出口
    proxyBypassRules: '<-loopback>'
  })

  // Chromium 的代理串不支持 `user:pass@host`，认证必须由 login 事件回调应答。
  // 不接管的话认证代理会弹出原生登录框，而 Agent 无法应答，环境等于不可用。
}

export async function clearProfileData(profileId: string): Promise<void> {
  const ses = sessionFor(profileId)
  await ses.clearStorageData()
  await ses.clearCache()
}

export function proxyLabel(p: ProxyConfig | null): string {
  if (!p) return '直连'
  const host = `${p.host}:${p.port}`
  return p.type === 'socks5' ? `socks5://${host}` : host
}

/* ────────────────────────────── 内部实现 ────────────────────────────── */

/** 代理凭据按 session 对象身份登记，因为 Session 没有暴露 partition 名可反查 */
const proxyBySession = new WeakMap<Session, ProxyConfig>()
let loginHookInstalled = false

/**
 * Electron 45 已移除 session 级的 `login` 事件，代理认证只剩 app 级一个入口，
 * 所以只能全局挂一次，再用 webContents.session 的对象身份判断是哪个环境发起的。
 */
function ensureLoginHook(): void {
  if (loginHookInstalled) return
  loginHookInstalled = true

  app.on('login', (event, webContents, _details, authInfo, callback) => {
    // 站点自身的 401 必须放行，否则页面登录、HTTP Basic 鉴权会全部失效
    if (!authInfo.isProxy || !webContents) return
    const proxy = proxyBySession.get(webContents.session)
    if (!proxy || !proxy.username) return
    // 防止一次挑战串到另一个代理（例如环境里既有代理又有 PAC 的场景）
    if (authInfo.host && authInfo.host !== proxy.host) return
    event.preventDefault()
    callback(proxy.username, proxy.password ?? '')
  })
}

function rulesFor(proxy: ProxyConfig): string {
  const host = `${proxy.host}:${proxy.port}`
  // socks5 用 URL 形式，Chromium 会自动把它应用到所有协议
  if (proxy.type === 'socks5') return `socks5://${host}`
  // https 代理自身是 TLS 隧道；http 代理则同时承担 http 与 https 流量
  if (proxy.type === 'https') return `https=${host}`
  return `http=${host};https=${host}`
}

/**
 * setSpellCheckerLanguages 对不支持的语种会直接抛错，
 * 而指纹里的 languages 是伪造的目标环境语言，未必是本机词典支持的。
 * 取交集，交集为空就退回英文，宁可少校验也不能让启动流程挂掉。
 */
function applySpellChecker(ses: Session, languages: string[]): void {
  try {
    const available = new Set(ses.availableSpellCheckerLanguages)
    const wanted = languages.filter((l) => available.has(l))
    ses.setSpellCheckerLanguages(wanted.length > 0 ? wanted : ['en-US'].filter((l) => available.has(l)))
  } catch (err) {
    console.warn('[session] 设置拼写检查语言失败，已跳过', err)
  }
}
