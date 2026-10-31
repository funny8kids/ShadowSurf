/**
 * 代理池模块。
 *
 * 职责：
 * - 代理记录的增删改查与批量导入
 * - 真实连通性检测（出口 IP / 时区 / 延迟）
 * - 把代理挂到环境上
 *
 * 归属：proxy-agent
 *
 * 检测为什么走 CONNECT 而不是直接用 https.request 的 proxy 选项：
 * Node 没有内置 HTTP 代理支持，第三方库又不该为一次探测引进依赖。
 * CONNECT 建隧道是代理协议里最小、最通用的能力，建好之后在隧道里发一个
 * 明文 HTTP 请求，就能拿到出口 IP —— 这条路径对 http / https 代理都成立。
 */

import { request as httpRequest } from 'node:http'
import type { ClientRequest } from 'node:http'
import type { Socket } from 'node:net'
import { CH } from '@shared/ipc'
import { CollectionStore } from '@main/store'
import type { ModuleContext } from './context'
import type {
  Profile,
  ProxyCheck,
  ProxyConfig,
  ProxyImportResult,
  ProxyInput,
  ProxyProtocol,
  ProxyRecord
} from '@shared/types'

/* ────────────────────────────── 常量 ────────────────────────────── */

/** 探测出口用 ip-api：免费、无需 key、一次返回国家与时区 */
const PROBE_HOST = 'ip-api.com'
const PROBE_PATH = '/json/?fields=status,country,timezone,query'
/** 8 秒：跨国代理常见 1–3 秒，再久说明这条线不可用，没必要让 UI 干等 */
const PROBE_TIMEOUT_MS = 8000
/** 导入失败的行只回报前 10 条：粘贴 500 行时刷屏没有意义，用户要的是「去改哪几行」 */
const MAX_IMPORT_ERRORS = 10

const PROTOCOLS: readonly ProxyProtocol[] = ['http', 'https', 'socks5']

/* ────────────────────────────── 小工具 ────────────────────────────── */

function isProtocol(value: string): value is ProxyProtocol {
  return (PROTOCOLS as readonly string[]).includes(value)
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/** 去掉首尾空白并压掉内部空格：从表格里粘出来的地址常带不可见空白 */
function cleanHost(raw: string): string {
  return raw.trim().replace(/\s+/g, '')
}

function basicAuth(username: string, password: string): string {
  return 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64')
}

/** 同一条代理的判定口径：host:port 相同即视为同一条，与用户名无关 */
function addressKey(host: string, port: number): string {
  return `${host.trim().toLowerCase()}:${port}`
}

function toProxyConfig(record: ProxyRecord): ProxyConfig {
  // Profile 侧字段名是 type，代理池侧叫 protocol；其余字段一致
  const config: ProxyConfig = { type: record.protocol, host: record.host, port: record.port }
  if (record.username) config.username = record.username
  if (record.password) config.password = record.password
  return config
}

/* ────────────────────────────── 导入解析 ────────────────────────────── */

interface ParsedLine {
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string
  password?: string
}

type ParseOutcome = { ok: true; value: ParsedLine } | { ok: false; reason: string }

/**
 * 三种写法：
 *   protocol://user:pass@host:port
 *   host:port:user:pass
 *   host:port
 * 无协议时按 http 处理 —— 用户从商家后台复制出来的绝大多数是裸地址。
 */
function parseLine(line: string): ParseOutcome {
  const text = line.trim()
  if (text === '') return { ok: false, reason: '空行' }

  let protocol: ProxyProtocol = 'http'
  let rest = text

  const schemeAt = text.indexOf('://')
  if (schemeAt > 0) {
    const scheme = text.slice(0, schemeAt).toLowerCase()
    if (!isProtocol(scheme)) return { ok: false, reason: `不支持的协议 ${scheme}` }
    protocol = scheme
    rest = text.slice(schemeAt + 3)
  }

  // 密码里允许出现 @ 和 :，所以按最后一个 @ 切分凭证与地址
  let username: string | undefined
  let password: string | undefined
  const at = rest.lastIndexOf('@')
  if (at >= 0) {
    const cred = rest.slice(0, at)
    rest = rest.slice(at + 1)
    const colon = cred.indexOf(':')
    if (colon < 0) return { ok: false, reason: '凭证缺少密码分隔符' }
    username = cred.slice(0, colon)
    password = cred.slice(colon + 1)
  }

  const parts = rest.split(':')
  if (parts.length < 2) return { ok: false, reason: '缺少端口' }

  const host = cleanHost(parts[0])
  const port = Number(parts[1])
  if (host === '' || host.includes('/')) return { ok: false, reason: '主机名无效' }
  if (!isValidPort(port)) return { ok: false, reason: '端口无效' }

  // host:port:user:pass 形态；密码里再出现冒号时整体归给密码
  if (username === undefined && parts.length >= 3) {
    username = parts[2]
    password = parts.length > 3 ? parts.slice(3).join(':') : ''
  }
  if (parts.length > 4) return { ok: false, reason: '字段过多，无法判断格式' }

  const value: ParsedLine = { protocol, host, port }
  if (username) value.username = username
  if (password !== undefined) value.password = password
  return { ok: true, value }
}

function shortLine(line: string): string {
  const text = line.trim()
  return text.length > 42 ? text.slice(0, 42) + '…' : text
}

/* ────────────────────────────── 探测 ────────────────────────────── */

/** 从隧道里读回来的原始 HTTP 响应里取出 body，兼容 chunked 与定长两种编码 */
function extractBody(raw: Buffer): string | null {
  const sep = raw.indexOf('\r\n\r\n')
  if (sep < 0) return null
  const head = raw.subarray(0, sep).toString('latin1')
  const body = raw.subarray(sep + 4)
  if (/transfer-encoding:\s*chunked/i.test(head)) return dechunk(body).toString('utf8')
  return body.toString('utf8')
}

function dechunk(raw: Buffer): Buffer {
  const parts: Buffer[] = []
  let cursor = 0
  while (cursor < raw.length) {
    const lineEnd = raw.indexOf('\r\n', cursor)
    if (lineEnd < 0) break
    const size = parseInt(raw.subarray(cursor, lineEnd).toString('latin1').trim(), 16)
    if (!Number.isFinite(size) || size <= 0) break
    const start = lineEnd + 2
    parts.push(raw.subarray(start, start + size))
    cursor = start + size + 2
  }
  return Buffer.concat(parts)
}

interface IpApiReply {
  status?: string
  message?: string
  country?: string
  timezone?: string
  query?: string
}

/**
 * 真连一次代理。
 *
 * 延迟只算到「隧道建立」为止：那才是代理本身的响应速度。
 * 出口查询要走代理之后的国际链路，把它算进延迟会让同一条代理的数值大幅抖动。
 */
function probe(record: ProxyRecord): Promise<ProxyCheck> {
  return new Promise<ProxyCheck>((resolve) => {
    let settled = false
    let outer: ClientRequest | null = null
    let tunnel: Socket | null = null
    const startedAt = Date.now()

    const finish = (result: ProxyCheck): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      tunnel?.destroy()
      outer?.destroy()
      resolve(result)
    }
    const fail = (error: string): void => finish({ ok: false, error, at: Date.now() })

    const timer = setTimeout(() => fail('探测超时（8 秒无响应）'), PROBE_TIMEOUT_MS)

    const headers: Record<string, string> = { Host: `${PROBE_HOST}:80` }
    if (record.username) {
      headers['Proxy-Authorization'] = basicAuth(record.username, record.password ?? '')
    }

    try {
      outer = httpRequest({
        host: record.host,
        port: record.port,
        method: 'CONNECT',
        path: `${PROBE_HOST}:80`,
        headers,
        // 不复用连接池：探测要回答「此刻能不能连上」，复用旧 socket 会给出假阳性
        agent: false
      })
    } catch (err) {
      fail('无法发起连接：' + (err instanceof Error ? err.message : String(err)))
      return
    }

    outer.setTimeout(PROBE_TIMEOUT_MS, () => fail('探测超时（8 秒无响应）'))
    outer.on('error', (err) => fail('连接代理失败：' + err.message))

    outer.on('connect', (res, socket) => {
      tunnel = socket
      if (res.statusCode !== 200) {
        fail(`代理拒绝建立隧道（HTTP ${res.statusCode ?? '未知'}）`)
        return
      }
      const latencyMs = Date.now() - startedAt

      socket.setTimeout(PROBE_TIMEOUT_MS, () => fail('隧道读取超时'))
      socket.on('error', (err) => fail('隧道中断：' + err.message))

      const chunks: Buffer[] = []
      socket.on('data', (chunk: Buffer) => chunks.push(chunk))
      socket.on('end', () => {
        const body = extractBody(Buffer.concat(chunks))
        if (body === null) {
          fail('出口查询返回了无法解析的响应')
          return
        }
        let reply: IpApiReply
        try {
          reply = JSON.parse(body) as IpApiReply
        } catch {
          fail('出口查询返回的不是 JSON，可能被中间设备改写')
          return
        }
        if (reply.status !== 'success' || !reply.query) {
          fail('出口查询失败：' + (reply.message ?? '未返回出口 IP'))
          return
        }
        const result: ProxyCheck = { ok: true, ip: reply.query, latencyMs, at: Date.now() }
        if (reply.country) result.country = reply.country
        if (reply.timezone) result.timezone = reply.timezone
        finish(result)
      })

      // 隧道建立后 socket 上跑的就是裸 TCP，请求报文得自己拼
      socket.write(
        `GET ${PROBE_PATH} HTTP/1.1\r\n` +
          `Host: ${PROBE_HOST}\r\n` +
          'Accept: application/json\r\n' +
          'Connection: close\r\n\r\n'
      )
    })

    outer.end()
  })
}

async function runCheck(ctx: ModuleContext, id: string): Promise<ProxyCheck> {
  const record = ctx.stores.proxies.get(id)
  if (record === null) throw new Error('代理不存在：' + id)

  const result: ProxyCheck =
    record.protocol === 'socks5'
      ? // 不做假成功：socks5 需要先完成握手协商，当前没有实现，就明确告诉用户
        { ok: false, error: '暂不支持 socks5 探测', at: Date.now() }
      : await probe(record)

  ctx.stores.proxies.update(id, { lastCheck: result })
  return result
}

/* ────────────────────────────── 写入前的校验 ────────────────────────────── */

function normalizeInput(input: ProxyInput): ProxyInput {
  const name = (input.name ?? '').trim()
  const host = cleanHost(input.host ?? '')
  const port = Number(input.port)
  if (host === '') throw new Error('代理主机不能为空')
  if (!isValidPort(port)) throw new Error('端口必须是 1-65535 之间的整数')
  if (!isProtocol(input.protocol)) throw new Error('不支持的代理协议：' + String(input.protocol))

  const next: ProxyInput = {
    name: name || `${host}:${port}`,
    protocol: input.protocol,
    host,
    port
  }
  if (input.username) next.username = input.username
  if (input.password) next.password = input.password
  if (input.region) next.region = input.region.trim()
  return next
}

/* ────────────────────────────── 注册 ────────────────────────────── */

export function registerProxyModule(ctx: ModuleContext): void {
  ctx.handle(CH.proxies.list, () => ctx.stores.proxies.list())

  ctx.handle(CH.proxies.create, (_event, raw) => {
    const input = normalizeInput(raw as ProxyInput)
    const record: ProxyRecord = {
      id: newProxyId(),
      ...input,
      // 新建时一律是「未检测」：没连过就标绿会让人误以为可用
      lastCheck: null,
      createdAt: Date.now()
    }
    ctx.stores.proxies.add(record)
    return record
  })

  ctx.handle(CH.proxies.update, (_event, id, patch) => {
    const proxyId = String(id)
    const existing = ctx.stores.proxies.get(proxyId)
    if (existing === null) throw new Error('代理不存在：' + proxyId)

    const raw = (patch ?? {}) as Partial<ProxyInput>
    // 只认这几个字段：id / createdAt / lastCheck 由主进程维护，不接受渲染层写入
    const next: ProxyRecord = { ...existing }
    if (typeof raw.name === 'string') next.name = raw.name.trim() || existing.name
    if (typeof raw.host === 'string') {
      const host = cleanHost(raw.host)
      if (host === '') throw new Error('代理主机不能为空')
      next.host = host
    }
    if (raw.port !== undefined) {
      const port = Number(raw.port)
      if (!isValidPort(port)) throw new Error('端口必须是 1-65535 之间的整数')
      next.port = port
    }
    if (raw.protocol !== undefined) {
      if (!isProtocol(raw.protocol)) throw new Error('不支持的代理协议：' + String(raw.protocol))
      next.protocol = raw.protocol
    }
    // 空字符串等于「清空这一项」：编辑时用户把用户名删掉，必须真的从记录里去掉
    if (typeof raw.username === 'string') next.username = raw.username || undefined
    if (typeof raw.password === 'string') next.password = raw.password || undefined
    if (typeof raw.region === 'string') next.region = raw.region.trim() || undefined

    // 地址、协议或凭证变了，旧检测结果就不再代表这条代理，直接清空
    const changed =
      next.host !== existing.host ||
      next.port !== existing.port ||
      next.protocol !== existing.protocol ||
      next.username !== existing.username ||
      next.password !== existing.password
    if (changed) next.lastCheck = null

    return ctx.stores.proxies.update(proxyId, next)
  })

  ctx.handle(CH.proxies.remove, (_event, id) => {
    const proxyId = String(id)
    const removed = ctx.stores.proxies.get(proxyId)
    if (removed === null) throw new Error('代理不存在：' + proxyId)

    ctx.stores.proxies.remove(proxyId)

    // Profile.proxy 只存地址快照、不存代理 id，所以按 host:port 找回挂载关系。
    // 不清理的话环境会拿着一条已删除的代理去启动，表现为「启动即断网」。
    for (const profile of ctx.stores.profiles.list()) {
      const attached = profile.proxy
      if (attached === null) continue
      if (attached.host !== removed.host || attached.port !== removed.port) continue
      ctx.stores.profiles.update(profile.id, { proxy: null })
    }
  })

  ctx.handle(CH.proxies.import, (_event, rawText): ProxyImportResult => {
    const text = typeof rawText === 'string' ? rawText : ''
    const existing = new Set(
      ctx.stores.proxies.list().map((item) => addressKey(item.host, item.port))
    )
    const result: ProxyImportResult = { added: 0, skipped: 0, errors: [] }
    let suppressed = 0

    const pushError = (message: string): void => {
      if (result.errors.length < MAX_IMPORT_ERRORS) result.errors.push(message)
      else suppressed += 1
    }

    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.trim() === '' || line.trim().startsWith('#')) continue

      const parsed = parseLine(line)
      if (!parsed.ok) {
        pushError(`第 ${index + 1} 行「${shortLine(line)}」：${parsed.reason}`)
        continue
      }

      const key = addressKey(parsed.value.host, parsed.value.port)
      if (existing.has(key)) {
        result.skipped += 1
        continue
      }

      const record: ProxyRecord = {
        id: newProxyId(),
        name: `${parsed.value.host}:${parsed.value.port}`,
        protocol: parsed.value.protocol,
        host: parsed.value.host,
        port: parsed.value.port,
        lastCheck: null,
        createdAt: Date.now()
      }
      if (parsed.value.username) record.username = parsed.value.username
      if (parsed.value.password) record.password = parsed.value.password

      ctx.stores.proxies.add(record)
      existing.add(key)
      result.added += 1
    }

    // 截断也要说清楚截断了，否则用户会以为错误只有 10 条
    if (suppressed > 0) {
      result.errors[MAX_IMPORT_ERRORS - 1] = `…另有 ${suppressed} 行解析失败未列出`
    }
    return result
  })

  ctx.handle(CH.proxies.check, (_event, id) => runCheck(ctx, String(id)))

  ctx.handle(CH.proxies.checkAll, async () => {
    // 串行而不是并发：一次几十条并发会把本机出口打满，测出来的延迟全是假的
    for (const record of ctx.stores.proxies.list()) {
      try {
        await runCheck(ctx, record.id)
      } catch {
        // 单条异常不打断整批，失败的详情已经写在各自的 lastCheck 里
      }
    }
    return ctx.stores.proxies.list()
  })

  ctx.handle(CH.proxies.apply, (_event, rawProfileId, rawProxyId): Profile => {
    const profileId = String(rawProfileId)
    const profile = ctx.stores.profiles.get(profileId)
    if (profile === null) throw new Error('环境不存在：' + profileId)

    if (rawProxyId === null || rawProxyId === undefined) {
      return ctx.stores.profiles.update(profileId, { proxy: null })
    }

    const proxyId = String(rawProxyId)
    const record = ctx.stores.proxies.get(proxyId)
    if (record === null) throw new Error('代理不存在：' + proxyId)

    return ctx.stores.profiles.update(profileId, { proxy: toProxyConfig(record) })
  })
}

/* ────────────────────────────── id ────────────────────────────── */

/** 与其它集合共用同一套短 ID 规则，前缀 prx 便于在日志里一眼认出是代理 */
function newProxyId(): string {
  return CollectionStore.newId('prx')
}
