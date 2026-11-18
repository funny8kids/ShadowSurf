/**
 * Cookie 导入 / 导出。
 *
 * 为什么单独成文件：这个模块是**唯一**知道「Cookie 落到磁盘上长什么样」的地方。
 * 导出有两种格式（Netscape 文本 / JSON），导入必须同时认这两种 —— 格式知识一旦
 * 分成两份，导出与导入就会各认各的形状，于是「刚导出的文件导不回来」，
 * 而症状只是「少了几条」，用户很难归因。
 *
 * 零依赖：这里只 `import type`，没有任何运行期 import。这样 tests/ 能用
 * `node --test` 直接加载它（见 tests/cookie-io.test.ts）。
 * 判据和动作必须待在一起 —— 同一句话在 store/json-file.ts 的开头写过一遍：
 * 「能被测到的规则才算规则，否则它只是一段看起来对的实现」。
 *
 * ── 两种格式各自的用途 ──
 *
 *   Netscape 文本（exportCookies）
 *     几乎所有工具都吃这个格式：Cookie Editor、EditThisCookie、Multilogin、
 *     GoLogin、curl。格式是制表符分隔的 7 段：
 *       domain \t includeSubdomains \t path \t secure \t expiration \t name \t value
 *     HttpOnly 的行首加 `#HttpOnly_` 前缀（这是该格式唯一表达 HttpOnly 的办法）。
 *
 *   JSON（exportCookiesJson）
 *     形状是 `{version, exportedAt, cookies:[...]}`，字段与本应用的 CookieItem
 *     对齐。JSON 不丢字段（Netscape 格式没有 sameSite，也没有 host-only 与域
 *     Cookie 的区分之外的东西），所以需要保真时用它。
 *
 * ── 单位约定（最容易踩坑的地方，所以写在这里而不是让用户去猜）──
 *
 *   Netscape 的 expiration：Unix **秒**（这是该格式的约定，0 表示会话 Cookie）
 *   JSON 的 expiration：Unix **毫秒**（与应用内部 CookieItem.expires 一致，0 表示会话 Cookie）
 *
 *   导入时两边都收：数值大于 1e11 判定为毫秒，否则判定为秒。
 *   判据是这个量级的当前时间在两种单位下相差 5 个数量级（1.75e12 ms vs 1.75e9 s），
 *   阈值落在中间，两边都不会误判。
 */

import type { Session } from 'electron'

/* ────────────────────────────── 类型 ────────────────────────────── */

/**
 * Electron 的原始 Cookie 形状。
 *
 * 写成 `Awaited<ReturnType<...>>` 而不是直接 import `Cookie`：
 * data.ts 原本就是这么写的，两边保持同一种取法，将来 Electron 改了类型也不会
 * 只有一处编译失败。
 */
type RawCookie = Awaited<ReturnType<Session['cookies']['get']>>[number]

export type SameSite = 'no_restriction' | 'lax' | 'strict' | 'unspecified'

/**
 * 一条 Cookie 的规范形态。
 *
 * **本应用里 Cookie 的唯一形态。** 数据面板（data.cookies）、导出、导入
 * 三处都用它，不允许再出现第二份平行定义 —— 两份定义迟早会漂移，而漂移的
 * 表现是「导出的文件导不回来」这种极难归因的现象。
 */
export interface CookieInfo {
  name: string
  value: string
  /**
   * 域名。
   *
   * 带前导点（`.example.com`）表示「域 Cookie」：对子域也生效。
   * 不带点表示「host-only」：只对精确的那个主机生效。
   * 这两者的区别会影响 Cookie 送到哪些站点上，导入时必须分清。
   */
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  /** true = 会话 Cookie：没有过期时间，浏览器退出即失效 */
  session: boolean
  /** 过期时间（毫秒时间戳）；会话 Cookie 没有这个字段 */
  expires?: number
  sameSite?: SameSite
}

/**
 * 导入得到的一条 Cookie。
 *
 * 比 `CookieInfo` 多一个 `url`：写回浏览器时 `cookies.set` 要一个能定位到
 * 该 Cookie 的 URL，而这个 URL 是**从 domain 推导出来的**，不是文件里写的 ——
 * Netscape 格式根本没有 URL 这一段，JSON 格式里的 URL 也未必可信。
 * 推导一次、集中在这里，比每个写入点各拼一次安全。
 */
export interface ImportedCookie extends CookieInfo {
  /** 写回浏览器时用的锚点 URL */
  url: string
}

export interface ImportResult {
  /** 解析成功的 Cookie */
  cookies: ImportedCookie[]
  /** 逐条错误。**解析错误与写入错误合并后的列表**，最多 10 条 */
  errors: string[]
  /**
   * 读到的条目数。
   *
   * Netscape 是「候选 Cookie 行数」（跳过空行与普通注释，`#HttpOnly_` 行计入）；
   * JSON 是数组长度。整份输入无法解析（空内容、非法 JSON、找不到数组）时为 0。
   */
  total: number
  /**
   * 解析失败的条目数（`total - cookies.length`）。
   *
   * 整份输入层面的失败（空内容、非法 JSON、找不到数组）没有「条目」可数，
   * 记为 0，由 `errors` 表达 —— 这样 `total / rejected` 才始终满足
   * 「读到的条目 = 成功 + 解析失败」这条可核对的等式。
   */
  rejected: number
}

export interface ExportOptions {
  /** 是否写文件头注释，默认 true */
  header?: boolean
}

/* ────────────────────────────── 常量 ────────────────────────────── */

/**
 * 错误条数上限。
 *
 * 与 proxy.ts 的 `MAX_IMPORT_ERRORS` 同值同理由：粘贴 500 行时刷屏没有意义，
 * 用户要的是「去改哪几行」。截断时必须说清截断了，否则用户会以为错误只有 10 条。
 */
const MAX_IMPORT_ERRORS = 10

/** JSON 导出的格式版本。将来改结构时 +1，旧版本读新文件时按版本号明确拒绝 */
const COOKIE_JSON_VERSION = 1

/** 文件头。首行必须是 Netscape 的固定文案，多数工具靠它识别格式 */
const NETSCAPE_HEADER = [
  '# Netscape HTTP Cookie File',
  '# https://curl.se/docs/http-cookies.html',
  '# 由 ShadowSurf 导出，请勿手工编辑。'
]

/** 毫秒 / 秒的分界阈值。当前时间的两种单位相差 5 个数量级，阈值落在中间 */
const MS_THRESHOLD = 1e11

/* ────────────────────────────── 小工具 ────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 截短一行用于报错文案。
 *
 * 与 proxy.ts 同一个口径：坏行可能是一整行超长内容，原样塞进错误消息会把界面撑爆。
 */
function shortLine(line: string): string {
  const text = line.trim()
  return text.length > 42 ? text.slice(0, 42) + '…' : text
}

function normalizeSameSite(value: unknown): SameSite {
  if (
    value === 'no_restriction' ||
    value === 'lax' ||
    value === 'strict' ||
    value === 'unspecified'
  ) {
    return value
  }
  return 'unspecified'
}

/**
 * 把过期时间归一成毫秒。
 *
 * 两种单位的来源是真实存在的：Netscape 格式用秒，JSON 导出用毫秒，
 * 而第三方工具两种都写。靠量级判定而不是靠「哪个字段名」—— 字段名可以骗人，
 * 量级不会。
 */
function toMillis(value: number): number {
  return value > MS_THRESHOLD ? value : value * 1000
}

/**
 * 错误列表的封顶。
 *
 * 与 proxy.ts 的 `MAX_IMPORT_ERRORS` 同一个上限、同一个理由：粘贴几百行时刷屏
 * 没有意义，用户要的是「去改哪几行」。
 *
 * 截断时必须说清截断了 —— 否则用户会以为错误只有 10 条。
 * 这里保留前 9 条真错误，把第 10 个位置换成汇总，所以列表长度恒等于上限。
 */
export function capErrors(items: string[], unit: string): string[] {
  if (items.length <= MAX_IMPORT_ERRORS) return items.slice()
  return [
    ...items.slice(0, MAX_IMPORT_ERRORS - 1),
    `…另有 ${String(items.length - MAX_IMPORT_ERRORS + 1)} ${unit}未列出`
  ]
}

/**
 * 错误收集器。
 *
 * 封装的理由：截断这件事必须**在收尾时**统一处理，而且必须说清「还有多少条没列」。
 * 每个调用点各写一遍 `if (errors.length < 10) ... else suppressed++`，
 * 迟早有一处忘了说「另有 N 条」—— 而漏说的后果是用户以为只有 10 个错。
 *
 * 收集阶段就封顶（而不是收尾时才 slice）：一份几百 MB 的坏文件不该把内存吃光。
 */
function createErrorSink(): { push: (message: string) => void; finish: (unit: string) => string[] } {
  const items: string[] = []
  let suppressed = 0
  return {
    push: (message: string): void => {
      if (items.length < MAX_IMPORT_ERRORS - 1) items.push(message)
      else suppressed += 1
    },
    finish: (unit: string): string[] => {
      if (suppressed > 0) items.push(`…另有 ${String(suppressed)} ${unit}未列出`)
      return items
    }
  }
}

/* ────────────────────────────── 转换 ────────────────────────────── */

/**
 * Electron 原始 Cookie → 本应用的 CookieInfo。
 *
 * 唯一做转换的地方：导出、导入归一、数据面板都过它，
 * 于是「域 Cookie 带不带前导点」这种细节只在这里决定一次。
 */
export function toCookieInfo(raw: RawCookie): CookieInfo {
  const info: CookieInfo = {
    name: raw.name,
    value: raw.value,
    domain: raw.domain ?? '',
    path: raw.path ?? '/',
    secure: raw.secure === true,
    httpOnly: raw.httpOnly === true,
    // Electron 对会话 Cookie 不给 expirationDate，这个缺失本身就是唯一可靠的判据
    session: raw.expirationDate === undefined,
    sameSite: normalizeSameSite((raw as { sameSite?: unknown }).sameSite)
  }
  if (raw.expirationDate !== undefined) {
    // Electron 给的是秒级时间戳，应用内部统一按毫秒处理，在边界处换算一次
    info.expires = Math.round(raw.expirationDate * 1000)
  }
  return info
}

/**
 * 由 domain 推出写回浏览器时用的 URL。
 *
 * 规则：secure 的用 https，否则用 http；前导点剥掉。
 *
 * 为什么剥前导点：`.example.com` 不是合法主机名，拼出来的 URL 过不了 URL 解析。
 * 为什么 secure 必须用 https：Secure 属性的 Cookie 只在安全上下文里有意义，
 * 用 http 的 URL 写进去，浏览器可能直接拒收 —— 那样就是「导入报成功但没生效」，
 * 比报错更坏。
 */
export function cookieUrlFor(cookie: { domain: string; secure: boolean }): string {
  const host = (cookie.domain ?? '').replace(/^\./, '')
  return `${cookie.secure ? 'https' : 'http'}://${host}`
}

/* ────────────────────────────── 导出 ────────────────────────────── */

/**
 * 值里的制表符 / 换行会破坏 Netscape 格式的分隔结构（值是最后一段，
 * 换行会直接多出一行「Cookie」），所以替换成空格。
 *
 * 代价是这几个字符**不能**逐字节保真 —— 需要保真请用 JSON 格式，
 * 那边的值一个字符都不改。这里选择替换而不是原样写出：原样写出的结果是
 * 「导出了，但别的工具读不回来」，那比换个空格更糟。
 */
function sanitizeValue(value: string): string {
  return value.replace(/[\t\r\n]/g, ' ')
}

function netscapeLine(cookie: CookieInfo): string {
  const domain = cookie.domain ?? ''
  // 域 Cookie（domain 带前导点）才勾「对子域生效」
  const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE'
  // HttpOnly 只能靠行首前缀表达 —— 这是 Netscape 格式的既有约定
  const prefix = cookie.httpOnly ? '#HttpOnly_' : ''
  const path = cookie.path && cookie.path.startsWith('/') ? cookie.path : '/'
  const secure = cookie.secure ? 'TRUE' : 'FALSE'
  // 0 = 会话 Cookie（该格式用 0 表示「无过期时间」）
  const expiration =
    cookie.session || cookie.expires === undefined ? 0 : Math.floor(cookie.expires / 1000)
  return (
    `${prefix}${domain}\t${includeSubdomains}\t${path}\t${secure}\t` +
    `${String(expiration)}\t${cookie.name}\t${sanitizeValue(cookie.value ?? '')}`
  )
}

/**
 * 导出成 Netscape 格式（curl / Cookie Editor / EditThisCookie 通吃）。
 */
export function exportCookies(cookies: CookieInfo[], opts: ExportOptions = {}): string {
  const lines: string[] = []
  if (opts.header !== false) lines.push(...NETSCAPE_HEADER)
  for (const cookie of cookies) lines.push(netscapeLine(cookie))
  // 末尾留一个换行：POSIX 文本文件以换行结尾，很多解析器（curl）据此判断文件完整
  return lines.join('\n') + '\n'
}

/**
 * 导出成 JSON。
 *
 * 字段名与本应用的 CookieItem 对齐，`expiration` 用毫秒，0 表示会话 Cookie。
 */
export function exportCookiesJson(cookies: CookieInfo[], now: number = Date.now()): string {
  const payload = {
    version: COOKIE_JSON_VERSION,
    exportedAt: now,
    cookies: cookies.map((cookie) => ({
      domain: cookie.domain,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      // 0 = 会话 Cookie（没有过期时间）
      expiration: cookie.session || cookie.expires === undefined ? 0 : cookie.expires,
      sameSite: cookie.sameSite ?? 'unspecified'
    }))
  }
  return JSON.stringify(payload, null, 2)
}

/* ────────────────────────────── 导入：Netscape ────────────────────────────── */

/**
 * 解析 Netscape 文本。
 *
 * 逐行处理，**一条坏行不影响其它行**：整份文件因为第 3 行少一个字段就全部
 * 丢弃，用户拿不到任何东西。坏行进错误列表，好的行进结果。
 */
function importNetscape(text: string): ImportResult {
  const cookies: ImportedCookie[] = []
  const sink = createErrorSink()
  const lines = text.split(/\r?\n/)
  // 「读到的条目数」：只数真正的候选 Cookie 行（空行与普通注释不算），
  // 这样 `rejected = total - cookies.length` 才是「有多少行没解析成功」。
  let total = 0

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim()
    if (raw === '') continue

    let httpOnly = false
    let body = raw
    if (body.startsWith('#HttpOnly_')) {
      // HttpOnly 行不是注释，是一条真 Cookie
      httpOnly = true
      body = body.slice('#HttpOnly_'.length)
    } else if (body.startsWith('#')) {
      continue // 普通注释
    }

    total += 1

    // 报错时把出问题的行带上：只说「第 3 行坏了」的话，用户还得自己数行
    const at = `第 ${String(index + 1)} 行「${shortLine(body)}」`

    const parts = body.split('\t')
    if (parts.length < 7) {
      sink.push(`${at}：字段不足 7 个（Netscape 格式是制表符分隔的 7 段）`)
      continue
    }

    // 值取「剩下的全部」：有些工具写出的值里含制表符，
    // 只取第 7 段会把值截断 —— 截断出来的 Cookie 是能用的假 Cookie，最难查。
    const domain = (parts[0] ?? '').trim()
    const includeSubdomains = (parts[1] ?? '').trim().toUpperCase() === 'TRUE'
    const path = (parts[2] ?? '').trim()
    const secure = (parts[3] ?? '').trim().toUpperCase() === 'TRUE'
    const expirationRaw = (parts[4] ?? '').trim()
    const name = parts[5] ?? ''
    const value = parts.slice(6).join('\t')

    if (domain === '') {
      sink.push(`${at}：缺少域名`)
      continue
    }
    if (name === '') {
      sink.push(`${at}：缺少 Cookie 名称`)
      continue
    }
    if (!/^\d+$/.test(expirationRaw)) {
      sink.push(`${at}：过期时间不是非负整数（${expirationRaw || '(空)'}）`)
      continue
    }
    const expiration = Number(expirationRaw)
    const normalizedPath = path === '' ? '/' : path
    if (!normalizedPath.startsWith('/')) {
      sink.push(`${at}：路径必须以 / 开头（${path}）`)
      continue
    }

    // 域 Cookie 的两种写法都要认：带前导点的域名，或「域名 + includeSubdomains=TRUE」。
    // 只认一种的话，另一半文件会安静地变成 host-only Cookie。
    const isDomainCookie = domain.startsWith('.') || includeSubdomains
    const normalizedDomain = isDomainCookie
      ? domain.startsWith('.')
        ? domain
        : `.${domain}`
      : domain.replace(/^\./, '')

    const info: CookieInfo = {
      name,
      value,
      domain: normalizedDomain,
      path: normalizedPath,
      secure,
      httpOnly,
      session: expiration === 0,
      sameSite: 'unspecified'
    }
    if (expiration > 0) info.expires = toMillis(expiration)

    cookies.push({ ...info, url: cookieUrlFor(info) })
  }

  return { cookies, errors: sink.finish('行'), total, rejected: total - cookies.length }
}

/* ────────────────────────────── 导入：JSON ────────────────────────────── */

/** 从 JSON 里找出 Cookie 数组。找不到就返回 null（而不是空数组）—— 两者含义不同 */
function extractJsonEntries(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed
  if (!isRecord(parsed)) return null
  if (Array.isArray(parsed['cookies'])) return parsed['cookies'] as unknown[]
  // 顺手认一下本地 API 的返回形状 {ok:true,data:[...]}：让人直接从接口响应里
  // 复制一段过来也能导
  if (Array.isArray(parsed['data'])) return parsed['data'] as unknown[]
  return null
}

function importJson(text: string): ImportResult {
  const sink = createErrorSink()
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (err) {
    // 整份输入无法解析：没有「条目」可数，total / rejected 都为 0，失败由 errors 表达
    return { cookies: [], errors: [`不是合法的 JSON：${describe(err)}`], total: 0, rejected: 0 }
  }

  const entries = extractJsonEntries(parsed)
  if (entries === null) {
    return {
      cookies: [],
      errors: ['JSON 里找不到 Cookie 数组（期望 {"cookies":[…]} 或一个直接的数组）'],
      total: 0,
      rejected: 0
    }
  }

  const cookies: ImportedCookie[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const where = `第 ${String(index + 1)} 条`
    const entry = entries[index]
    if (!isRecord(entry)) {
      sink.push(`${where}：不是对象`)
      continue
    }

    const name = entry['name']
    if (typeof name !== 'string' || name === '') {
      sink.push(`${where}：缺少 name`)
      continue
    }
    const value = entry['value']
    if (value !== undefined && typeof value !== 'string') {
      sink.push(`${where}：value 必须是字符串`)
      continue
    }
    const domain = entry['domain']
    if (typeof domain !== 'string' || domain.trim() === '') {
      sink.push(`${where}：缺少 domain`)
      continue
    }
    const path = entry['path']
    if (path !== undefined && (typeof path !== 'string' || !path.startsWith('/'))) {
      sink.push(`${where}：path 必须是以 / 开头的字符串`)
      continue
    }
    // secure / httpOnly 只认布尔：宽松解析（'true' / 1）在这两个字段上没有正当理由，
    // 而 Secure 标志错了会让 Cookie 被送到不该送的连接上
    const secureRaw = entry['secure']
    const httpOnlyRaw = entry['httpOnly']
    if (secureRaw !== undefined && typeof secureRaw !== 'boolean') {
      sink.push(`${where}：secure 必须是布尔值（收到 ${typeof secureRaw}）`)
      continue
    }
    if (httpOnlyRaw !== undefined && typeof httpOnlyRaw !== 'boolean') {
      sink.push(`${where}：httpOnly 必须是布尔值（收到 ${typeof httpOnlyRaw}）`)
      continue
    }
    const secure = secureRaw === true
    const httpOnly = httpOnlyRaw === true

    const sameSiteRaw = entry['sameSite']
    let sameSite: SameSite = 'unspecified'
    if (sameSiteRaw !== undefined) {
      if (
        sameSiteRaw !== 'no_restriction' &&
        sameSiteRaw !== 'lax' &&
        sameSiteRaw !== 'strict' &&
        sameSiteRaw !== 'unspecified'
      ) {
        // 不认识的 sameSite 归成 unspecified 是**有语义差别**的
        // （SameSite=None 与 Lax 的跨站行为完全不同），所以直接报错而不是猜
        sink.push(`${where}：sameSite 取值无效（${String(sameSiteRaw)}）`)
        continue
      }
      sameSite = sameSiteRaw
    }

    const expirationRaw = entry['expiration'] ?? entry['expires']
    let expires: number | undefined
    if (expirationRaw !== undefined && expirationRaw !== null) {
      if (typeof expirationRaw !== 'number' || !Number.isFinite(expirationRaw)) {
        sink.push(`${where}：expiration 必须是数字`)
        continue
      }
      // 0 = 会话 Cookie
      expires = expirationRaw === 0 ? undefined : toMillis(expirationRaw)
    }

    const info: CookieInfo = {
      name,
      value: typeof value === 'string' ? value : '',
      domain: domain.trim(),
      path: typeof path === 'string' ? path : '/',
      secure,
      httpOnly,
      session: expires === undefined,
      sameSite
    }
    if (expires !== undefined) info.expires = expires

    cookies.push({ ...info, url: cookieUrlFor(info) })
  }

  return {
    cookies,
    errors: sink.finish('条'),
    total: entries.length,
    rejected: entries.length - cookies.length
  }
}

/* ────────────────────────────── 导入入口 ────────────────────────────── */

/**
 * 导入 Cookie。**自动识别输入格式**。
 *
 * 判据是「第一个非空白字符是不是 { 或 [」：Netscape 文本的行首只可能是域名或
 * `#`，不可能是 JSON 的开头；而 JSON 文件必然以 { 或 [ 开头。这个判据不会
 * 误判 —— 唯一需要注意的是文件头有 BOM，所以先把它剥掉。
 */
export function importCookies(text: string): ImportResult {
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (trimmed === '') {
    return { cookies: [], errors: ['内容为空：没有可导入的 Cookie'], total: 0, rejected: 0 }
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return importJson(trimmed)
  }
  return importNetscape(text.replace(/^\uFEFF/, ''))
}
