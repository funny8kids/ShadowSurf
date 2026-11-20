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
import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { lookup } from 'node:dns/promises'
import { CH } from '@shared/ipc'
import { CollectionStore } from '@main/store'
import { decryptSecret, encryptSecret, sealIfPlain } from '@main/store/secret-box'
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
/**
 * 「全部检测」的并发度。
 *
 * 原来是严格串行（`for await`）：50 条代理 × 每条最坏 8 秒 ≈ 400 秒，
 * 用户点了按钮只能干等。但也不能一次性全打出去 —— 那会把本机出口和
 * 上游代理同时打满，测出来的延迟全是假的，还可能被代理商判定为滥用。
 *
 * 8 是折中：50 条的最坏耗时从 ~400s 降到 ~50s（50/8 × 8s），
 * 同时对上游仍然是「一次几条」的量级。要退回原行为把这里改成 1 即可。
 */
const CHECK_CONCURRENCY = 8

const PROTOCOLS: readonly ProxyProtocol[] = ['http', 'https', 'socks5', 'socks5h']

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

/**
 * 把记录里的密码还原成明文，供探测 / 下发 session 使用。
 *
 * 盘上存的是 `enc:<base64>`（safeStorage）或 `raw:<明文>`（降级），
 * 老数据是裸明文 —— `decryptSecret` 三种都认。
 */
function reveal(record: ProxyRecord): ProxyRecord {
  if (typeof record.password !== 'string' || record.password === '') return record
  return { ...record, password: decryptSecret(record.password) }
}

function toProxyConfig(record: ProxyRecord): ProxyConfig {
  // Profile 侧字段名是 type，代理池侧叫 protocol；其余字段一致
  const plain = reveal(record)
  const config: ProxyConfig = { type: plain.protocol, host: plain.host, port: plain.port }
  if (plain.username) config.username = plain.username
  if (plain.password) config.password = plain.password
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
 * 四种协议前缀（http / https / socks5 / socks5h）加三种写法：
 *   protocol://user:pass@host:port
 *   host:port:user:pass
 *   host:port
 * socks5h 与 socks5 必须分开：前者把域名交给代理做远程解析（remote DNS），
 * 后者在本地解析。导入时必须保留这个前缀，否则用户粘贴的 socks5h 会被
 * 悄悄降成 socks5 —— 出口 IP 一样，但 DNS 查询从代理侧跑回本机，
 * 正是「界面测通了、真实场景却漏了」的那类漂移。
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

/* ────────────────────────────── SOCKS5 ────────────────────────────── */

/**
 * SOCKS5 客户端（RFC 1928）+ 用户名/口令认证（RFC 1929）。
 *
 * ── 为什么单独写，不复用上面的 HTTP CONNECT 隧道 ──
 *
 * 两者的**帧格式完全不同**：HTTP CONNECT 是一行 ASCII 请求 + 一行 ASCII 响应；
 * SOCKS5 是定长二进制前缀 + 变长地址（IPv4 4 字节 / 域名 1+n 字节 / IPv6 16 字节）。
 * 硬要共用一套读写代码，结果是两边都要塞 if —— 而那种代码一旦分叉，
 * 修一条分支时很容易忘了另一条。所以这里是一个独立的小客户端，
 * 唯一共享的是「出口查询那段 HTTP」和 `extractBody`。
 *
 * ── 帧格式（RFC 1928）──
 *
 *   1. 客户端 → 0x05 <方法数> <方法…>          这里只宣告「无需认证」或「无需认证 + 用户名口令」
 *   2. 服务端 → 0x05 <选中的方法>
 *   3. 客户端 → 0x05 0x01 0x00 <ATYP> <地址> <端口>   （0x01 = CONNECT）
 *   4. 服务端 → 0x05 <回复码> 0x00 <ATYP> <绑定地址> <绑定端口>
 *
 * 用户名口令认证（RFC 1929）是**子协商**：方法选中 0x02 之后，
 * 客户端再发 0x01 <用户名字节数> <用户名> <口令字节数> <口令>，
 * 服务端回 0x01 <状态码>（0 = 成功）。
 */

/** SOCKS5 版本号 */
const SOCKS5_VERSION = 0x05
/** 方法：无需认证 */
const SOCKS5_METHOD_NONE = 0x00
/** 方法：用户名 / 口令（RFC 1929） */
const SOCKS5_METHOD_USERPASS = 0x02
/** 方法：代理不接受本客户端提出的任何认证方式 */
const SOCKS5_METHOD_UNACCEPTABLE = 0xff
/** 用户名/口令子协商的版本号 */
const SOCKS5_AUTH_VERSION = 0x01
/** 命令：CONNECT */
const SOCKS5_CMD_CONNECT = 0x01
/** 地址类型：IPv4 */
const SOCKS5_ATYP_IPV4 = 0x01
/** 地址类型：域名 */
const SOCKS5_ATYP_DOMAIN = 0x03
/** 地址类型：IPv6 */
const SOCKS5_ATYP_IPV6 = 0x04
/** 回复码：成功 */
const SOCKS5_REP_OK = 0x00

/**
 * 握手阶段的字节上限。
 *
 * 正常情况下握手只有十几个字节。设上限不是防「正常代理」，是防**行为不端的代理**：
 * 它可以在握手阶段一直发数据，而我们的读取要缓冲 —— 不封顶的话，
 * 一个坏代理就能把本进程的内存吃光。这条是「对不可信输入设上限」的通用要求，
 * 不是针对某个具体攻击。
 */
const MAX_HANDSHAKE_BYTES = 512

/** 隧道里的 HTTP 响应上限：出口查询只回几百字节，超过就是异常 */
const MAX_TUNNEL_BYTES = 256 * 1024

/** 代理在握手后回「这些是 SOCKS5 错误码」 */
const SOCKS5_REPLIES: Record<number, string> = {
  0x01: '通用服务器故障',
  0x02: '规则不允许',
  0x03: '网络不可达',
  0x04: '主机不可达',
  0x05: '连接被拒绝',
  0x06: 'TTL 已过期',
  0x07: '不支持的命令',
  0x08: '不支持的地址类型'
}

/**
 * 顺序读取的 socket 读取器。
 *
 * 为什么不能「一次 data 事件按收到的内容直接解析」：TCP 是**字节流**，
 * 一次事件可能只到半个报文，也可能一次到好几个报文。按「收到什么就是什么」解析，
 * 在真实网络下必然偶发失败 —— 而且是那种「大部分时候好的」偶发失败，最难查。
 *
 * 为什么要有上限：读取要缓冲，而对面是不可信的。上限按阶段抬升
 * （握手 512 字节 → 隧道 256KB），既挡住恶意代理，也不误伤正常代理。
 */
class SocketReader {
  private buffer: Buffer = Buffer.alloc(0)
  private total = 0
  private limit: number
  private failure: Error | null = null
  private ended = false
  private readonly waiters: Array<{
    need: number
    resolve: (chunk: Buffer) => void
    reject: (err: Error) => void
  }> = []
  private readonly allWaiters: Array<{
    resolve: (chunk: Buffer) => void
    reject: (err: Error) => void
  }> = []

  constructor(
    socket: Socket,
    limit: number
  ) {
    this.limit = limit
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', (err: Error) => this.fail(err))
    socket.on('end', () => this.onEnd())
    socket.on('close', () => this.onEnd())
  }

  /** 进入隧道阶段后抬高上限：握手那几百字节的限制不该继续管着 HTTP 响应 */
  raiseLimit(limit: number): void {
    if (limit > this.limit) this.limit = limit
  }

  private onData(chunk: Buffer): void {
    this.total += chunk.length
    if (this.total > this.limit) {
      this.fail(new Error(`响应超过上限（${String(this.limit)} 字节）`))
      return
    }
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    this.pump()
  }

  private fail(err: Error): void {
    if (this.failure !== null) return
    this.failure = err
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter?.reject(err)
    }
    while (this.allWaiters.length > 0) {
      const waiter = this.allWaiters.shift()
      waiter?.reject(err)
    }
  }

  /**
   * 对端关闭了连接。
   *
   * 对「读满 N 字节」是失败（读不到了），对「读到关闭为止」是正常结束 ——
   * 隧道里的 HTTP 响应就是这么结束的（我们发的是 `Connection: close`）。
   */
  private onEnd(): void {
    if (this.ended) return
    this.ended = true
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter?.reject(new Error('代理提前关闭了连接'))
    }
    while (this.allWaiters.length > 0) {
      const waiter = this.allWaiters.shift()
      waiter?.resolve(Buffer.concat([this.buffer]))
    }
  }

  private pump(): void {
    while (this.waiters.length > 0 && this.buffer.length >= (this.waiters[0]?.need ?? 0)) {
      const waiter = this.waiters.shift()
      if (waiter === undefined) return
      const out = this.buffer.subarray(0, waiter.need)
      this.buffer = this.buffer.subarray(waiter.need)
      waiter.resolve(out)
    }
  }

  /** 读满 n 个字节 */
  read(need: number): Promise<Buffer> {
    if (this.failure !== null) return Promise.reject(this.failure)
    return new Promise<Buffer>((resolve, reject) => {
      this.waiters.push({ need, resolve, reject })
      this.pump()
    })
  }

  /** 读到连接关闭为止（隧道里的 HTTP 响应就是这么结束的：Connection: close） */
  readAll(): Promise<Buffer> {
    if (this.failure !== null) return Promise.reject(this.failure)
    if (this.ended) return Promise.resolve(Buffer.concat([this.buffer]))
    return new Promise<Buffer>((resolve, reject) => {
      this.allWaiters.push({ resolve, reject })
    })
  }
}

/** 组装 CONNECT 请求 */
function socks5ConnectRequest(atyp: number, address: Buffer, port: number): Buffer {
  const portBytes = Buffer.alloc(2)
  portBytes.writeUInt16BE(port, 0)
  // 0x05 版本 / 0x01 CONNECT / 0x00 保留 / ATYP
  return Buffer.concat([Buffer.from([SOCKS5_VERSION, SOCKS5_CMD_CONNECT, 0x00, atyp]), address, portBytes])
}

/** 组装用户名/口令认证子协商（RFC 1929） */
function socks5AuthRequest(username: string, password: string): Buffer {
  const user = Buffer.from(username, 'utf8')
  const pass = Buffer.from(password, 'utf8')
  return Buffer.concat([
    Buffer.from([SOCKS5_AUTH_VERSION, user.length]),
    user,
    Buffer.from([pass.length]),
    pass
  ])
}

/**
 * 目标地址。
 *
 * `socks5://` = **本地解析**：我们自己把主机名解析成 IP 再发给代理。
 * `socks5h://` = **远程解析**：把域名原样发给代理，由代理解析。
 *
 * 这个区别是用户能感知的，不是实现细节：
 *   · 本地解析会把 DNS 查询发给本机网络 —— 在做 DNS 污染的环境里，
 *     你拿到的可能是被改过的地址，于是「代理可用」但「出口不是你以为的那个」；
 *   · 远程解析把解析权交给代理，DNS 查询从代理那边出去，泄漏面小，
 *     但前提是这条代理真的支持按域名转发。
 *
 * 默认走本地解析（与 Chromium 的 `socks5://` 行为一致）：本应用的代理配置最终
 * 会被 Chromium 当作 `socks5://host:port` 使用，两边语义不一致会让「界面测通了、
 * 实际跑起来是另一个出口」。
 */
async function socks5Target(
  hostname: string,
  remoteDns: boolean
): Promise<{ atyp: number; address: Buffer }> {
  if (remoteDns) {
    const raw = Buffer.from(hostname, 'utf8')
    if (raw.length > 255) throw new Error('域名过长，SOCKS5 域名地址最长 255 字节')
    return {
      atyp: SOCKS5_ATYP_DOMAIN,
      address: Buffer.concat([Buffer.from([raw.length]), raw])
    }
  }

  const resolved = await lookup(hostname)
  if (resolved.family === 6) {
    return { atyp: SOCKS5_ATYP_IPV6, address: ipv6Bytes(resolved.address) }
  }
  return { atyp: SOCKS5_ATYP_IPV4, address: ipv4Bytes(resolved.address) }
}

function ipv4Bytes(address: string): Buffer {
  const out = Buffer.alloc(4)
  const parts = address.split('.').map((part) => Number(part))
  for (let i = 0; i < 4; i += 1) out[i] = parts[i] ?? 0
  return out
}

/**
 * IPv6 文本 → 16 字节。
 *
 * 为什么自己写：Node 只给了 `net.isIPv6()`（判合法性），没有「字符串 → 字节」的转换。
 * 形式有三种要认：8 组十六进制、`::` 压缩、以及末尾内嵌 IPv4（`::ffff:1.2.3.4`）。
 */
function ipv6Bytes(address: string): Buffer {
  const compressed = address.indexOf('::')
  const headText = compressed >= 0 ? address.slice(0, compressed) : address
  const tailText = compressed >= 0 ? address.slice(compressed + 2) : ''

  const expand = (parts: string[]): string[] => {
    if (parts.length === 0) return []
    const last = parts[parts.length - 1] ?? ''
    if (!last.includes('.')) return parts
    const octets = last.split('.').map((part) => Number(part))
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw new Error('IPv6 地址里的 IPv4 段无效：' + address)
    }
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0)
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)
    return [...parts.slice(0, -1), high.toString(16), low.toString(16)]
  }

  const headGroups = expand(headText === '' ? [] : headText.split(':'))
  const tailGroups = expand(tailText === '' ? [] : tailText.split(':'))
  const missing = 8 - headGroups.length - tailGroups.length
  if (missing < 0 || (compressed < 0 && missing !== 0)) {
    throw new Error('IPv6 地址无效：' + address)
  }
  const groups = [...headGroups, ...Array.from({ length: missing }, () => '0'), ...tailGroups]

  const out = Buffer.alloc(16)
  for (let i = 0; i < 8; i += 1) {
    const value = parseInt(groups[i] ?? '0', 16)
    if (!Number.isFinite(value) || value < 0 || value > 0xffff) {
      throw new Error('IPv6 地址无效：' + address)
    }
    out.writeUInt16BE(value, i * 2)
  }
  return out
}

/**
 * 走 SOCKS5 隧道做一次出口探测。
 *
 * 与 HTTP 路径保持一致的三件事：
 *   1. 延迟只算到「隧道建立」为止（那才是代理本身的响应速度）；
 *   2. 隧道里发的是同样的明文 HTTP 请求，出口查询的解析与判定完全复用；
 *   3. 失败时的措辞沿用同一套词（连接代理失败 / 探测超时 / 代理拒绝建立隧道 / 出口查询…）。
 */
async function socks5Probe(record: ProxyRecord, remoteDns: boolean): Promise<ProxyCheck> {
  const startedAt = Date.now()
  let socket: Socket | null = null
  let timedOut = false

  const done = (result: ProxyCheck): ProxyCheck => {
    socket?.destroy()
    return result
  }
  const fail = (error: string): ProxyCheck => done({ ok: false, error, at: Date.now() })

  try {
    socket = await connectWithTimeout(record, PROBE_TIMEOUT_MS)
  } catch (err) {
    return fail('连接代理失败：' + (err instanceof Error ? err.message : String(err)))
  }

  // 超时计时从「连上」开始算：连接阶段由 connectWithTimeout 自己管，
  // 两段各算各的 —— 否则连接慢一点就把整条探测的时间预算提前吃光，
  // 表现出来的是「有的代理总是超时，有的从来不超时」，而差别只在握手快慢。
  const timer = setTimeout(() => {
    timedOut = true
    socket?.destroy()
  }, PROBE_TIMEOUT_MS)

  const reader = new SocketReader(socket, MAX_HANDSHAKE_BYTES)

  try {
    /* ── 第一步：方法协商 ── */
    const hasCredentials = typeof record.username === 'string' && record.username.length > 0
    const methods = hasCredentials
      ? Buffer.from([SOCKS5_VERSION, 0x02, SOCKS5_METHOD_NONE, SOCKS5_METHOD_USERPASS])
      : Buffer.from([SOCKS5_VERSION, 0x01, SOCKS5_METHOD_NONE])
    socket.write(methods)

    const methodReply = await reader.read(2)
    if (methodReply[0] !== SOCKS5_VERSION) {
      return fail('SOCKS5 握手失败：代理返回的版本号不是 5')
    }
    const method = methodReply[1] ?? 0xff
    if (method === SOCKS5_METHOD_UNACCEPTABLE) {
      return fail('SOCKS5 握手失败：代理不接受任何一种认证方式')
    }

    /* ── 第二步：用户名 / 口令认证（RFC 1929 子协商）── */
    if (method === SOCKS5_METHOD_USERPASS) {
      if (!hasCredentials) {
        return fail('SOCKS5 握手失败：代理要求用户名口令认证，但这条代理没有配置凭据')
      }
      socket.write(socks5AuthRequest(record.username ?? '', record.password ?? ''))
      const authReply = await reader.read(2)
      if (authReply[0] !== SOCKS5_AUTH_VERSION) {
        return fail('SOCKS5 认证失败：认证应答的版本号不对')
      }
      if (authReply[1] !== 0x00) {
        return fail('SOCKS5 认证失败：代理拒绝了用户名口令')
      }
    } else if (method !== SOCKS5_METHOD_NONE) {
      return fail('SOCKS5 握手失败：代理选了一个本客户端不支持的认证方式')
    }

    /* ── 第三步：CONNECT ── */
    const target = await socks5Target(PROBE_HOST, remoteDns)
    socket.write(socks5ConnectRequest(target.atyp, target.address, 80))

    const replyHead = await reader.read(4)
    if (replyHead[0] !== SOCKS5_VERSION) {
      return fail('SOCKS5 握手失败：代理返回的版本号不是 5')
    }
    const rep = replyHead[1] ?? 0xff
    const atyp = replyHead[3] ?? 0xff

    // 绑定地址是变长的：IPv4 4 字节 / IPv6 16 字节 / 域名 1+n 字节，后面还有 2 字节端口
    let addressLength = -1
    if (atyp === SOCKS5_ATYP_IPV4) addressLength = 4
    else if (atyp === SOCKS5_ATYP_IPV6) addressLength = 16
    else if (atyp === SOCKS5_ATYP_DOMAIN) {
      const lengthByte = await reader.read(1)
      addressLength = (lengthByte[0] ?? 0) + 1
    } else {
      return fail('SOCKS5 握手失败：代理返回了未知的地址类型')
    }
    // 剩下的：绑定地址 + 端口
    await reader.read(addressLength + 2)

    if (rep !== SOCKS5_REP_OK) {
      const reason = SOCKS5_REPLIES[rep]
      return fail(
        `代理拒绝建立隧道（SOCKS5 回复码 0x${rep.toString(16).padStart(2, '0')}` +
          `${reason === undefined ? '' : '：' + reason}）`
      )
    }

    /* ── 隧道建立：延迟到这里为止，与 HTTP 路径口径一致 ── */
    const latencyMs = Date.now() - startedAt

    /* ── 第四步：隧道里发同样的出口查询 ── */
    reader.raiseLimit(MAX_TUNNEL_BYTES)
    socket.write(
      `GET ${PROBE_PATH} HTTP/1.1\r\n` +
        `Host: ${PROBE_HOST}\r\n` +
        'Accept: application/json\r\n' +
        'Connection: close\r\n\r\n'
    )

    const raw = await reader.readAll()
    const body = extractBody(raw)
    if (body === null) return fail('出口查询返回了无法解析的响应')
    let reply: IpApiReply
    try {
      reply = JSON.parse(body) as IpApiReply
    } catch {
      return fail('出口查询返回的不是 JSON，可能被中间设备改写')
    }
    if (reply.status !== 'success' || !reply.query) {
      return fail('出口查询失败：' + (reply.message ?? '未返回出口 IP'))
    }
    const result: ProxyCheck = { ok: true, ip: reply.query, latencyMs, at: Date.now() }
    if (reply.country) result.country = reply.country
    if (reply.timezone) result.timezone = reply.timezone
    return done(result)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    // 超时要单独说：超时是「这条线没反应」，而 socket 报错是「这条线断了」，
    // 两者的补救动作不同（换一条 vs 查网络），混成一句话就都变成「重试试试」
    if (timedOut) return fail('探测超时（8 秒无响应）')
    if (detail.includes('超过上限')) return fail('SOCKS5 握手失败：' + detail)
    if (detail.includes('提前关闭')) return fail('SOCKS5 握手失败：' + detail)
    return fail('连接代理失败：' + detail)
  } finally {
    clearTimeout(timer)
  }
}

/** 连上代理，带超时。超时抛错而不是静默挂起 */
function connectWithTimeout(record: ProxyRecord, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    let settled = false
    const socket = connect({ host: record.host, port: record.port })
    const finish = (err: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err === null) resolve(socket)
      else {
        socket.destroy()
        reject(err)
      }
    }
    const timer = setTimeout(
      () => finish(new Error(`探测超时（${String(Math.round(timeoutMs / 1000))} 秒无响应）`)),
      timeoutMs
    )
    socket.once('connect', () => finish(null))
    socket.once('error', (err: Error) => finish(err))
  })
}

async function runCheck(ctx: ModuleContext, id: string): Promise<ProxyCheck> {
  const record = ctx.stores.proxies.get(id)
  if (record === null) throw new Error('代理不存在：' + id)

  const result: ProxyCheck = await probeProxy(record)

  ctx.stores.proxies.update(id, { lastCheck: result })
  return result
}

/**
 * 按协议分派探测。
 *
 * 导出给 `modules/geo-match.ts` 复用：地理校准必须走**同一条**探测链路，
 * 否则“代理面板显示可连、校准却失败”会变成两套互相矛盾的事实。
 * 只加 `export`，探测逻辑本身不动。
 *
 * 用字符串比较而不是枚举比较，有两个原因：
 *
 * 1. `ProxyProtocol` 枚举只描述合法取值，但**记录文件是可以被手改的**。
 *    用枚举比较的话，一个被改成 'socks4' 的记录会落进默认分支（HTTP 探测），
 *    于是对一个 SOCKS4 服务器发 CONNECT —— 表现是「连不上」，
 *    而真实原因是「协议不支持」。后者是可行动的，前者会让人去换一条代理。
 * 2. socks5h（远程 DNS）虽已进枚举，但**记录文件仍可能是手改出来的任意字符串**。
 *    用枚举比较只覆盖类型系统允许的取值，挡不住盘上的脏数据；这里统一用
 *    String(...).toLowerCase() 归一化后再分派，协议决定探测方式，
 *    不能让一个手改的记录悄悄落进 HTTP 探测。
 */
export async function probeProxy(record: ProxyRecord): Promise<ProxyCheck> {
  // 盘上的密码是密文，探测必须用明文
  const plain = reveal(record)
  const protocol = String(plain.protocol).toLowerCase()

  if (protocol === 'socks5' || protocol === 'socks5h') {
    return socks5Probe(plain, protocol === 'socks5h')
  }
  // 不做假成功：SOCKS4 的帧格式与 SOCKS5 不同（没有方法协商、没有域名地址类型），
  // 要支持就得再写一个客户端。这里明确告诉用户「不支持」，而不是拿 SOCKS5 去撞。
  if (protocol === 'socks4' || protocol === 'socks4a') {
    return { ok: false, error: '暂不支持 socks4 探测', at: Date.now() }
  }
  if (protocol === 'ssh') {
    return { ok: false, error: '暂不支持 ssh 探测', at: Date.now() }
  }
  return probe(plain)
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
  ctx.handle(CH.proxies.list, () =>
    // 渲染层不该拿到密码明文；空串表示「这条代理没有密码」。
    // 详情见 store/profiles.ts 的 toPublicProfile（那里对 profile.proxy 做同样处理）。
    ctx.stores.proxies.list().map((r) =>
      typeof r.password === 'string' && r.password.length > 0 ? { ...r, password: '' } : r
    )
  )

  ctx.handle(CH.proxies.create, (_event, raw) => {
    const input = normalizeInput(raw as ProxyInput)
    const record: ProxyRecord = {
      id: newProxyId(),
      ...input,
      // 密码加密落盘（safeStorage；不可用时降级为 raw: 前缀，见 secret-box.ts）
      ...(input.password ? { password: encryptSecret(input.password) } : {}),
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
    if (typeof raw.password === 'string') {
      // 界面上密码永远显示为空（见 CH.proxies.list 的打码），所以用户没改时
      // 传回来的是空串 —— 那要保留原密码，不能清掉。
      // 只有非空值才当「新密码」，并加密落盘。
      next.password = raw.password === '' ? existing.password : encryptSecret(raw.password)
    }
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
    //
    // 批量写入：`ProfileStore.updateMany` 内部只调一次 `store.update`，
    // 把「N 个挂载环境 = N 次整份 profiles.json 重写」收成 1 次。
    // 它复用 `update()` 同一套字段白名单 / seed 拒绝 / 投影校验（批量不是绕过闸门的理由），
    // 不存在的 id 忽略（调用方拿的是刚读到的快照，中间被别处删掉是正常竞态）。
    const affected: string[] = []
    for (const profile of ctx.stores.profiles.list()) {
      const attached = profile.proxy
      if (attached === null) continue
      if (attached.host !== removed.host || attached.port !== removed.port) continue
      affected.push(profile.id)
    }
    if (affected.length > 0) ctx.stores.profiles.updateMany(affected, { proxy: null })
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
    // 一次快照：检测过程中用户可能增删代理，拿旧快照跑完再读一次最新列表，
    // 行为与原串行版一致（原版本也是先 list 再逐条 await）。
    const records = ctx.stores.proxies.list()

    // 手写并发池（不引 p-limit 之类的依赖）：固定数量的 worker 抢同一个游标，
    // 天然限流到 CHECK_CONCURRENCY 条在飞。比 `Promise.all(全部)` 安全 ——
    // 后者会瞬间开出几百条 CONNECT，也保留了「不要把所有代理同时打爆」的原意。
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= records.length) return
        const record = records[index]
        if (record === undefined) return
        try {
          await runCheck(ctx, record.id)
        } catch {
          // 单条异常不打断整批，失败的详情已经写在各自的 lastCheck 里
        }
      }
    }

    const lanes = Math.min(CHECK_CONCURRENCY, records.length)
    await Promise.all(Array.from({ length: lanes }, () => worker()))

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

    // profile.proxy 也要加密落盘：它会被序列化进 profiles.json。
    // 主进程 setProxy 时再 decryptSecret 还原（见 core/session.ts 的 applyProxy）。
    const cfg = toProxyConfig(record)
    return ctx.stores.profiles.update(profileId, {
      proxy: cfg.password ? { ...cfg, password: encryptSecret(cfg.password) } : cfg
    })
  })
}

/* ────────────────────────────── id ────────────────────────────── */

/** 与其它集合共用同一套短 ID 规则，前缀 prx 便于在日志里一眼认出是代理 */
function newProxyId(): string {
  return CollectionStore.newId('prx')
}
