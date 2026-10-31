/**
 * 时间 / 字节 / 状态文案 / 指纹一致性评分。
 *
 * 纯函数，无副作用，可单独测试。渲染层不直接拼字符串，统一走这里，
 * 保证同一份数据在卡片、抽屉、任务页里的措辞一致。
 */

import type { FingerprintConfig, Profile, ProfileStatus, TaskRecord, TaskStatus } from '@shared/types'
import type { StepStatus } from '@shared/protocol'

/* ────────────────────────────── 时间 ────────────────────────────── */

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 14:02:11 */
export function formatClock(ts: number): string {
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 2026-08-14 */
export function formatDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 刚刚 / 2 分钟前 / 3 小时前 / 2026-08-14 */
export function formatRelative(ts: number | null, now: number = Date.now()): string {
  if (!ts) return '从未使用'
  const diff = now - ts
  if (diff < 0) return '刚刚'
  if (diff < 45_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)} 天前`
  return formatDate(ts)
}

/** 1m 24s / 48s / 2m 06s */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—'
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}m ${pad2(s)}s`
}

/** 0:00 / 3:00 形式的播放器时间 */
export function formatPlayerTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${pad2(total % 60)}`
}

/* ────────────────────────────── 数值 ────────────────────────────── */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const v = bytes / Math.pow(1024, i)
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—'
  return `${value.toFixed(digits)}%`
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/* ────────────────────────────── 指纹摘要 ────────────────────────────── */

/** 用 Intl 反解时区偏移，返回 UTC-8 / UTC+5:30 / UTC+0 */
export function tzOffsetLabel(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset'
    }).formatToParts(new Date())
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? ''
    const m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(name)
    if (!m) return 'UTC+0'
    const sign = m[1]
    const hours = Number(m[2])
    const minutes = m[3] ? Number(m[3]) : 0
    return `UTC${sign}${hours}${minutes ? `:${pad2(minutes)}` : ''}`
  } catch {
    return 'UTC±0'
  }
}

const COUNTRY_NAME: Record<string, string> = {
  US: '美国',
  GB: '英国',
  UK: '英国',
  DE: '德国',
  FR: '法国',
  NL: '荷兰',
  SG: '新加坡',
  JP: '日本',
  TH: '泰国',
  CN: '中国',
  CA: '加拿大',
  AU: '澳大利亚',
  BR: '巴西',
  ES: '西班牙',
  IT: '意大利',
  KR: '韩国',
  IN: '印度',
  RU: '俄罗斯'
}

/** en-US → US */
export function localeCountry(locale: string): string {
  const m = /[-_]([A-Za-z]{2})\b/.exec(locale)
  return m ? m[1].toUpperCase() : locale.slice(0, 2).toUpperCase()
}

export function countryLabel(locale: string): string {
  const code = localeCountry(locale)
  return COUNTRY_NAME[code] ?? code
}

export function platformLabel(os: FingerprintConfig['os']): string {
  if (os === 'windows') return 'Windows'
  if (os === 'macos') return 'macOS'
  return 'Linux'
}

/** Windows 11 · 23H2（去掉模板里的多余分段，卡片上只留主版本） */
export function osShortLabel(fp: FingerprintConfig): string {
  return fp.osLabel.replace(/\s*·\s*23H2$/, '').replace(/\s*·\s*Sequoia$/, '').replace(/\s*·\s*GNOME$/, '')
}

/** Chrome 141 */
export function chromeMajor(uaVersion: string): string {
  return uaVersion.split('.')[0] || '—'
}

/** prf_xxxxxxxx → #0241 风格的四位编号（取自 id 尾部，稳定可复现） */
export function profileNo(id: string): string {
  const tail = id.replace(/[^0-9a-zA-Z]/g, '').slice(-4).toUpperCase()
  return `#${tail || '0000'}`
}

export function profileFpSummary(fp: FingerprintConfig): string {
  return `${tzOffsetLabel(fp.timezone)} · ${fp.locale} · ${fp.screen.width}×${fp.screen.height}`
}

/* ────────────────────────────── 状态文案 ────────────────────────────── */

export interface StatusText {
  label: string
  tone: 'idle' | 'run' | 'warn'
}

export function profileStatusText(status: ProfileStatus): StatusText {
  switch (status) {
    case 'running':
      return { label: '运行中', tone: 'run' }
    case 'starting':
      return { label: '启动中', tone: 'warn' }
    case 'error':
      return { label: '启动失败', tone: 'warn' }
    default:
      return { label: '影子待命', tone: 'idle' }
  }
}

export function taskStatusText(status: TaskStatus): string {
  switch (status) {
    case 'queued':
      return '排队中'
    case 'running':
      return '进行中'
    case 'paused':
      return '已暂停'
    case 'done':
      return '已完成'
    case 'failed':
      return '失败'
    default:
      return '已停止'
  }
}

export function taskTone(status: TaskStatus): 'ok' | 'run' | 'fail' | 'warn' {
  if (status === 'done') return 'ok'
  if (status === 'running' || status === 'queued') return 'run'
  if (status === 'failed') return 'fail'
  return 'warn'
}

export function stepStatusText(status: StepStatus): string {
  switch (status) {
    case 'running':
      return '正在执行'
    case 'ok':
      return '已完成'
    case 'failed':
      return '失败'
    case 'rejected':
      return '已跳过'
    default:
      return '等待确认'
  }
}

export function providerNeedKey(providerId: string): boolean {
  return providerId !== 'ollama' && providerId !== 'lmstudio'
}

/**
 * Base URL → 实际请求地址。
 * 用户经常把 /v1 漏掉或多写一遍 /chat/completions，这里统一收口，
 * 并在设置面板里实时展示，404 时第一眼就能看出问题。
 */
export function resolveEndpoint(baseUrl: string): string {
  const raw = baseUrl.trim()
  if (!raw) return ''
  let url = raw.replace(/\/+$/, '')
  url = url.replace(/\/chat\/completions$/i, '')
  if (!/\/v\d+$/i.test(url)) url = `${url}/v1`
  return `${url}/chat/completions`
}

/* ────────────────────────────── 任务派生 ────────────────────────────── */

export function taskProgress(task: TaskRecord | undefined): { done: number; total: number } {
  if (!task) return { done: 0, total: 0 }
  const total = Math.max(task.plan.length, task.steps.length)
  const done = task.steps.filter((s) => s.status === 'ok').length
  return { done, total }
}

export function findRunningTask(tasks: TaskRecord[], profileId: string): TaskRecord | undefined {
  return tasks.find((t) => t.profileId === profileId && t.status === 'running')
}

export function isToday(ts: number, now: number = Date.now()): boolean {
  const a = new Date(ts)
  const b = new Date(now)
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  )
}

/* ────────────────────────────── 指纹一致性 ────────────────────────────── */

export interface ConsistencyReport {
  score: number
  verdict: string
  issues: string[]
}

const LOCALE_REGION: Record<string, string> = {
  US: 'NA',
  CA: 'NA',
  MX: 'NA',
  BR: 'NA',
  GB: 'EU',
  IE: 'EU',
  DE: 'EU',
  FR: 'EU',
  NL: 'EU',
  BE: 'EU',
  ES: 'EU',
  IT: 'EU',
  PT: 'EU',
  PL: 'EU',
  SE: 'EU',
  NO: 'EU',
  DK: 'EU',
  FI: 'EU',
  RU: 'EU',
  TR: 'EU',
  CN: 'AS',
  HK: 'AS',
  TW: 'AS',
  JP: 'AS',
  KR: 'AS',
  SG: 'AS',
  TH: 'AS',
  VN: 'AS',
  ID: 'AS',
  MY: 'AS',
  PH: 'AS',
  IN: 'AS',
  AE: 'AS',
  AU: 'OC',
  NZ: 'OC',
  ZA: 'AF'
}

function tzRegion(tz: string): string {
  if (tz.startsWith('America') || tz.startsWith('Pacific/Honolulu')) return 'NA'
  if (tz.startsWith('Europe') || tz.startsWith('Atlantic')) return 'EU'
  if (tz.startsWith('Asia')) return 'AS'
  if (tz.startsWith('Australia') || tz.startsWith('Pacific/Auckland')) return 'OC'
  if (tz.startsWith('Africa')) return 'AF'
  return 'NA'
}

function uaPlatform(ua: string): FingerprintConfig['os'] | null {
  if (/Windows NT/i.test(ua)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos'
  if (/Linux|X11/i.test(ua)) return 'linux'
  return null
}

/**
 * 打分规则：每命中一条矛盾扣分，最后夹到 0–100。
 * 这不是安全评分，只回答一个问题——「这些参数放在一起，像不像同一台机器」。
 */
export function scoreFingerprint(fp: FingerprintConfig, hasProxy: boolean): ConsistencyReport {
  let score = 100
  const issues: string[] = []

  // 1. UA 与操作系统
  const uaOs = uaPlatform(fp.userAgent)
  if (uaOs === null) {
    score -= 12
    issues.push('User-Agent 里没有可识别的平台标识')
  } else if (uaOs !== fp.os) {
    score -= 24
    issues.push('User-Agent 与操作系统不一致')
  }

  // 2. UA 里的 Chrome 大版本与填写的版本
  const uaMajor = /Chrome\/(\d+)/.exec(fp.userAgent)?.[1]
  const declaredMajor = fp.uaVersion.split('.')[0]
  if (uaMajor && declaredMajor && uaMajor !== declaredMajor) {
    score -= 8
    issues.push('User-Agent 的浏览器版本与填写的版本不一致')
  }

  // 3. 时区与经纬度
  if (!fp.geolocation) {
    score -= 6
    issues.push('未设置地理位置，站点可反查真实位置')
  } else {
    const expected = Math.round(fp.geolocation.longitude / 15)
    const offset = tzOffsetHours(fp.timezone)
    if (offset !== null && Math.abs(expected - offset) > 2) {
      score -= 18
      issues.push('时区与经纬度不在同一区域')
    }
  }

  // 4. 语言与地区
  const region = LOCALE_REGION[localeCountry(fp.locale)]
  if (region && region !== tzRegion(fp.timezone)) {
    score -= 12
    issues.push('语言地区与时区所在大洲不匹配')
  }

  // 5. 首选语言与 locale
  if (fp.languages.length > 0 && fp.languages[0] !== fp.locale) {
    score -= 6
    issues.push('首选语言与 locale 不一致')
  }
  if (fp.languages.length === 0) {
    score -= 4
    issues.push('语言列表为空，navigator.languages 会暴露默认值')
  }

  // 6. WebRTC
  if (fp.webrtc === 'real') {
    score -= 12
    issues.push('WebRTC 暴露真实 IP')
  }

  // 7. 噪声
  if (fp.canvas === 'off' && fp.audio === 'off') {
    score -= 5
    issues.push('Canvas 与 AudioContext 均未加噪')
  }

  // 8. 出口
  if (!hasProxy) {
    score -= 8
    issues.push('未配置代理，出口 IP 与本机一致')
  }

  const final = clamp(Math.round(score), 0, 100)
  return { score: final, verdict: verdictFor(final, issues, hasProxy), issues }
}

function verdictFor(score: number, issues: string[], hasProxy: boolean): string {
  // 高分档以前写的是「UA、时区、语言与代理出口地区匹配，未检测到矛盾项」。
  // 这句话是错的：这个函数手里只有一个 hasProxy 布尔值，**从来没校验过代理出口地区**。
  // 它把「本机侧参数自洽」说成了「与代理地区一致」——最自信的结论出现在最常走的路径上。
  //
  // 现在按实际掌握的证据说话：能确认的写能确认的，没校验的明说没校验。
  // 检测方拿不到的东西，界面也不该替它下结论。
  if (score >= 95) {
    return hasProxy
      ? 'UA、时区、语言在本地参数上自洽，未检测到矛盾项。代理出口地区尚未校验 —— 需要对该代理做一次出口检测才能确认是否一致。'
      : 'UA、时区、语言在本地参数上自洽，未检测到矛盾项。未配置代理，出口 IP 与本机一致。'
  }
  if (score >= 80) return `${issues[0] ?? '存在少量不一致'}，建议核对后再启动。`
  if (score >= 60) return `${issues.slice(0, 2).join('；')}。这组指纹可能被识别为伪装。`
  return `检测到 ${issues.length} 处矛盾：${issues.slice(0, 2).join('；')}。不建议直接使用。`
}

/** 取时区当前偏移小时数（含半小时区，用小数表示） */
function tzOffsetHours(tz: string): number | null {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    const parts = dtf.formatToParts(new Date())
    const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0')
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second')
    )
    return Math.round(((asUtc - Date.now()) / 3_600_000) * 2) / 2
  } catch {
    return null
  }
}

/* ────────────────────────────── 杂项 ────────────────────────────── */

/** sk-abcd…wxyz，永远不把完整 Key 交给 DOM */
export function maskKey(key: string): string {
  const k = key.trim()
  if (!k) return '未填写'
  if (k.length <= 8) return '••••••••'
  return `${k.slice(0, 5)}••••••••${k.slice(-4)}`
}

export function proxyAddress(profile: Profile): string {
  const p = profile.proxy
  if (!p) return '直连 · 未配置代理'
  return `${p.host}:${p.port}`
}

/** 代理延迟分级：>80ms 标红、>120ms 判超时 */
export function latencyTier(ms: number | null): 'fast' | 'slow' | 'timeout' | 'unknown' {
  if (ms === null || !Number.isFinite(ms)) return 'unknown'
  if (ms > 120) return 'timeout'
  if (ms > 80) return 'slow'
  return 'fast'
}
