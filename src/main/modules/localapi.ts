/**
 * 本地 HTTP API 模块。
 *
 * 职责：
 * - 在 127.0.0.1 上起一个带 Bearer Token 的 REST 服务，供外部程序（CLI / SDK / IDE 插件）
 *   驱动环境，端点对齐 docs/api/openapi.yaml 的命名；
 * - 令牌落盘复用，进程重启后外部脚本不必重新配置；
 * - 只监听回环地址，绝不 bind 0.0.0.0。
 *
 * 为什么用 node:http 而不是 Hono/Fastify：这个服务只有 7 个端点、零中间件需求，
 * 引入框架会让「谁能访问、怎么鉴权」被框架的默认行为接管，安全边界反而看不清。
 * 这里每一行 CORS 与鉴权都是显式的。
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { CH } from '@shared/ipc'
import type { LocalApiState, Profile } from '@shared/types'
import type { Action, ActionType } from '@shared/protocol'
import { dataDir, getStores } from '@main/store'
import { bridgeFor } from '@main/core/cdp'
import { captureSnapshot } from '@main/agent/snapshot'
import { ApprovalRequiredError, executeAction } from '@main/agent/actions'
import { appendAudit } from '@main/modules/audit'
import type { ModuleContext } from './context'

/* ────────────────────────────── 常量 ────────────────────────────── */

const LOOPBACK = '127.0.0.1'
const DEFAULT_PORT = 7717
const TOKEN_FILE = 'local-api-token.json'
/** 请求体上限：动作是短 JSON，超过这个量级一定是调用方搞错了，直接拒掉免得吃内存 */
const MAX_BODY_BYTES = 512 * 1024
/** 请求计数变化很密集，合并成一个节流窗口再广播，否则一次批量调用能把 IPC 打满 */
const EMIT_INTERVAL = 200

const ACTION_TYPES: ReadonlySet<string> = new Set([
  'click',
  'type',
  'press',
  'scroll',
  'navigate',
  'extract',
  'done'
])

/** 只放行本机来源。局域网页面、file:// 页面、null 来源一律不发 CORS 头 */
const ALLOWED_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i

const TOKEN_PATTERN = /^[0-9a-f]{64}$/

/* ────────────────────────────── 模块状态 ────────────────────────────── */

let context: ModuleContext | null = null
let server: Server | null = null
let emitTimer: NodeJS.Timeout | null = null

let state: LocalApiState = {
  running: false,
  port: DEFAULT_PORT,
  token: '',
  startedAt: null,
  requests: 0
}

/* ────────────────────────────── 令牌 ────────────────────────────── */

function tokenPath(): string {
  return join(dataDir(), TOKEN_FILE)
}

/**
 * 生成并落盘新令牌。
 * 32 字节随机：足够长到不可猜测，hex 编码后 64 字符，粘进 curl 也不会被转义。
 */
function createToken(): string {
  const token = randomBytes(32).toString('hex')
  try {
    writeFileSync(
      tokenPath(),
      JSON.stringify({ token, createdAt: Date.now() }, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    )
  } catch (err) {
    // 落盘失败仍然返回令牌：本次进程内可用，只是下次启动会换一个新的
    console.error('[localapi] 令牌写入失败', err)
  }
  return token
}

/** 读磁盘上的令牌；文件不存在或形状不对都视为没有，重新生成而不是卡在启动阶段 */
function loadToken(): string {
  try {
    const raw = JSON.parse(readFileSync(tokenPath(), 'utf8')) as unknown
    if (raw !== null && typeof raw === 'object') {
      const token = (raw as Record<string, unknown>).token
      if (typeof token === 'string' && TOKEN_PATTERN.test(token)) return token
    }
  } catch {
    // 首次运行没有文件，属正常路径
  }
  return createToken()
}

function ensureToken(): string {
  if (state.token.length === 0) state.token = loadToken()
  return state.token
}

/* ────────────────────────────── 状态广播 ────────────────────────────── */

function snapshot(): LocalApiState {
  ensureToken()
  return { ...state }
}

function emit(): void {
  context?.broadcast(CH.push.localApiState, snapshot())
}

function emitSoon(): void {
  if (emitTimer !== null) return
  emitTimer = setTimeout(() => {
    emitTimer = null
    emit()
  }, EMIT_INTERVAL)
}

/* ────────────────────────────── HTTP 工具 ────────────────────────────── */

/** 统一的错误出口：HTTP 状态码 + {ok:false,error:{code,message}} */
class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin
  if (typeof origin === 'string' && ALLOWED_ORIGIN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  // 没命中白名单就不发 ACAO：浏览器自己会拦，而 curl 本来就不带 Origin
  res.setHeader('Vary', 'Origin')
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  })
  res.end(body)
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, error: { code, message } })
}

/** 读请求体并解析 JSON；超限或非法 JSON 都归到 400，调用方能看懂是自己发错了 */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false

    const fail = (err: ApiError): void => {
      if (done) return
      done = true
      reject(err)
    }

    req.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail(new ApiError(400, 'E_BODY_TOO_LARGE', '请求体过大，上限 512KB'))
        // 不 destroy：连接留着才能把 400 正常写回去，只是不再收集后续数据
        req.resume()
        return
      }
      chunks.push(chunk)
    })

    req.on('error', () => fail(new ApiError(400, 'E_BODY_READ', '请求体读取失败')))

    req.on('end', () => {
      if (done) return
      done = true
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text.length === 0) {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(text) as unknown)
      } catch {
        reject(new ApiError(400, 'E_BAD_JSON', '请求体不是合法 JSON'))
      }
    })
  })
}

/** 定长比较，避免按字节提前返回泄露令牌前缀 */
function tokenMatches(given: string): boolean {
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(state.token, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization
  if (typeof header !== 'string') return false
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) return false
  return tokenMatches(match[1].trim())
}

/* ────────────────────────────── 业务适配 ────────────────────────────── */

function requireProfile(id: string): Profile {
  const profile = getStores().profiles.get(id)
  if (!profile) throw new ApiError(404, 'E_PROFILE_NOT_FOUND', `环境不存在：${id}`)
  return profile
}

/**
 * 拿标签页。
 * 没有窗口说明环境没启动，这是调用顺序问题，用 400 而不是 500 —— 不是服务坏了。
 */
function requireTab(profileId: string) {
  const tab = context?.wm.getTab(profileId)
  if (!tab) {
    throw new ApiError(400, 'E_NO_WINDOW', '该环境没有打开的窗口，请先调用 launch 启动环境')
  }
  return tab
}

/** 只搬运协议里声明过的字段，调用方塞进来的其他键一律丢弃 */
function toAction(raw: unknown): Action {
  if (raw === null || typeof raw !== 'object') {
    throw new ApiError(400, 'E_BAD_ACTION', 'body.action 必须是对象')
  }
  const rec = raw as Record<string, unknown>
  const type = typeof rec.type === 'string' ? rec.type : ''
  if (!ACTION_TYPES.has(type)) {
    throw new ApiError(400, 'E_BAD_ACTION', `不支持的动作类型：${type || '(空)'}`)
  }

  const action: Action = { type: type as ActionType }
  if (typeof rec.id === 'string') action.id = rec.id
  if (typeof rec.text === 'string') action.text = rec.text
  if (typeof rec.key === 'string') action.key = rec.key
  if (typeof rec.url === 'string') action.url = rec.url
  if (typeof rec.query === 'string') action.query = rec.query
  if (typeof rec.summary === 'string') action.summary = rec.summary
  if (typeof rec.submit === 'boolean') action.submit = rec.submit
  if (typeof rec.amount === 'number' && Number.isFinite(rec.amount)) action.amount = rec.amount
  if (rec.direction === 'up' || rec.direction === 'down' || rec.direction === 'top' || rec.direction === 'bottom') {
    action.direction = rec.direction
  }
  return action
}

function appVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
}

/* ────────────────────────────── 路由 ────────────────────────────── */

function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    throw new ApiError(400, 'E_BAD_PATH', '路径参数编码非法')
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  applyCors(req, res)

  state.requests += 1
  emitSoon()

  const method = (req.method ?? 'GET').toUpperCase()

  // 预检不鉴权：浏览器发预检时不带 Authorization，要求鉴权会让所有跨域调用直接失败
  if (method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    res.setHeader('Access-Control-Max-Age', '600')
    res.writeHead(204)
    res.end()
    return
  }

  try {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}:${state.port}`)
    const seg = url.pathname.split('/').filter((part) => part.length > 0)
    // 文档里所有端点都带 /v1 前缀，两种写法都收，省得调用方来回改 base url
    if (seg[0] === 'v1') seg.shift()

    // /health 是唯一免鉴权的端点：外部程序先探活，再决定要不要去读令牌文件
    if (method === 'GET' && seg.length === 1 && seg[0] === 'health') {
      sendJson(res, 200, {
        ok: true,
        version: appVersion(),
        profiles: getStores().profiles.count()
      })
      return
    }

    if (!isAuthorized(req)) {
      throw new ApiError(401, 'E_UNAUTHORIZED', '缺少或错误的 Bearer 令牌')
    }

    if (seg[0] === 'profiles') {
      await handleProfiles(method, seg, req, res)
      return
    }

    if (method === 'GET' && seg.length === 1 && seg[0] === 'tasks') {
      sendJson(res, 200, { ok: true, data: getStores().tasks.list() })
      return
    }

    throw new ApiError(404, 'E_NOT_FOUND', `没有这个端点：${method} ${url.pathname}`)
  } catch (err) {
    // 响应头已经发出去了就不能再写，否则 Node 会抛 ERR_HTTP_HEADERS_SENT 盖住原始错误
    if (res.headersSent) return
    if (err instanceof ApiError) {
      sendError(res, err.status, err.code, err.message)
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    console.error('[localapi] 处理请求失败', err)
    sendError(res, 500, 'E_INTERNAL', message)
  }
}

async function handleProfiles(
  method: string,
  seg: string[],
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (seg.length === 1) {
    if (method !== 'GET') {
      throw new ApiError(404, 'E_NOT_FOUND', `没有这个端点：${method} /profiles`)
    }
    sendJson(res, 200, { ok: true, data: getStores().profiles.list() })
    return
  }

  if (seg.length !== 3) {
    throw new ApiError(404, 'E_NOT_FOUND', `没有这个端点：${method} /${seg.join('/')}`)
  }

  const id = decodeSegment(seg[1])
  const verb = seg[2]

  if (verb === 'launch') {
    if (method !== 'POST') throw new ApiError(404, 'E_NOT_FOUND', '启动环境请用 POST')
    requireProfile(id)
    await context?.runtime.launch(id)
    sendJson(res, 200, { ok: true, data: { id, running: context?.runtime.isRunning(id) ?? false } })
    return
  }

  if (verb === 'stop') {
    if (method !== 'POST') throw new ApiError(404, 'E_NOT_FOUND', '停止环境请用 POST')
    requireProfile(id)
    await context?.runtime.stop(id)
    sendJson(res, 200, { ok: true, data: { id, running: context?.runtime.isRunning(id) ?? false } })
    return
  }

  if (verb === 'snapshot') {
    if (method !== 'GET') throw new ApiError(404, 'E_NOT_FOUND', '取快照请用 GET')
    requireProfile(id)
    const tab = requireTab(id)
    const cdp = bridgeFor(tab.wc)
    await cdp.attach()
    const snap = await captureSnapshot(cdp)
    sendJson(res, 200, { ok: true, data: snap })
    return
  }

  if (verb === 'act') {
    if (method !== 'POST') throw new ApiError(404, 'E_NOT_FOUND', '执行动作请用 POST')
    const profile = requireProfile(id)
    const body = await readJsonBody(req)
    const payload = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const action = toAction(payload.action)
    // 外部调用方没有「用户意图」可传，所以这里**不传 intent**：
    // 执行器会按空意图重算，得到永不降级的最保守等级。
    // 想让 L2 动作通过，只有一条路 —— 请求体里显式写 "confirm": true。
    const confirmed = payload.confirm === true

    const tab = requireTab(id)
    const cdp = bridgeFor(tab.wc)
    await cdp.attach()
    // 外部调用方手里没有当轮快照，但编号校验是防幻觉的唯一闸门，不能因为走 API 就绕过：
    // 这里现采一帧再交给执行器，元素编号必须真实存在于当前页面。
    const snap = await captureSnapshot(cdp)

    let result
    try {
      result = await executeAction(cdp, action, snap, {
        approvedBy: confirmed ? 'api' : 'none'
      })
    } catch (err) {
      if (err instanceof ApprovalRequiredError) {
        // 409 而不是 403：调用方补一个字段就能过，不是权限不够。
        throw new ApiError(
          409,
          'E_APPROVAL_REQUIRED',
          `${err.message}；确认无副作用后在请求体加 "confirm": true 重试`
        )
      }
      throw err
    }

    if (!result.ok) {
      // 动作被拒（编号不存在 / 页面脚本未就绪）属于调用方问题，用 400 让客户端能区分于服务故障
      throw new ApiError(400, 'E_ACTION_FAILED', result.message)
    }

    // 走过确认的动作必须留痕：这是唯一一条「闸门被显式推开」的路径，
    // 事后追「谁让这个动作执行的」只能靠这里。
    if (confirmed) {
      appendAudit(
        getStores(),
        'API 确认执行',
        profile.name,
        `${action.type}${action.id ? ` #${action.id}` : ''}${action.url ? ` ${action.url}` : ''}`
      )
    }

    sendJson(res, 200, { ok: true, data: result })
    return
  }

  throw new ApiError(404, 'E_NOT_FOUND', `没有这个端点：${method} /profiles/${id}/${verb}`)
}

/* ────────────────────────────── 生命周期 ────────────────────────────── */

function resolvePort(input?: number): number {
  if (input === undefined) return state.port > 0 ? state.port : DEFAULT_PORT
  if (!Number.isInteger(input) || input < 1 || input > 65535) {
    throw new Error('端口必须是 1-65535 之间的整数')
  }
  return input
}

function listen(srv: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      srv.removeListener('listening', onListening)
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`端口 ${port} 已被占用，请换一个端口再启动本地 API`))
        return
      }
      if (err.code === 'EACCES') {
        reject(new Error(`没有权限监听端口 ${port}，请换一个 1024 以上的端口`))
        return
      }
      reject(new Error(`本地 API 启动失败：${err.message}`))
    }
    const onListening = (): void => {
      srv.removeListener('error', onError)
      resolve()
    }
    srv.once('error', onError)
    srv.once('listening', onListening)
    // 只绑回环：绑 0.0.0.0 等于把整套控制面交给同网段的任何人
    srv.listen(port, LOOPBACK)
  })
}

function closeServer(target: Server | null): Promise<void> {
  if (target === null) return Promise.resolve()
  return new Promise((resolve) => {
    target.close(() => resolve())
    // keep-alive 连接会让 close 一直挂着，主动断开空闲连接
    target.closeIdleConnections()
  })
}

function buildServer(): Server {
  const srv = createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      // handleRequest 内部已兜底，这里只是防止未捕获的 rejection 打崩主进程
      console.error('[localapi] 未捕获的请求异常', err)
      if (!res.headersSent) sendError(res, 500, 'E_INTERNAL', '内部错误')
    })
  })
  // 畸形请求（比如裸 TLS 握手）不该把服务拖垮，直接断开这条连接
  srv.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })
  return srv
}

async function startService(port?: number): Promise<LocalApiState> {
  const target = resolvePort(port)

  // 已在运行：契约里没有独立的 regenerate 通道，而「重复启动」本来没有别的语义，
  // 所以约定为重掷令牌（UI 的「重新生成」走这条路）。
  if (server !== null) {
    if (target === state.port) {
      // 同端口只换令牌，不重建监听：重启监听会打断客户端已经建立的 keep-alive 连接
      state = { ...state, token: createToken() }
      emit()
      return snapshot()
    }
    // 换端口时先起新监听再关旧的，新端口起不来时旧服务继续可用，
    // 否则一次输错端口就把正在跑的服务弄停
    const next = buildServer()
    await listen(next, target)
    next.on('error', (err) => console.error('[localapi] 服务异常', err))
    const previous = server
    server = next
    state = { running: true, port: target, token: createToken(), startedAt: Date.now(), requests: 0 }
    emit()
    await closeServer(previous)
    return snapshot()
  }

  const token = ensureToken()
  const srv = buildServer()

  try {
    await listen(srv, target)
  } catch (err) {
    state = { ...state, running: false, startedAt: null }
    emit()
    throw err
  }

  srv.on('error', (err) => console.error('[localapi] 服务异常', err))
  server = srv
  state = { running: true, port: target, token, startedAt: Date.now(), requests: 0 }
  emit()
  return snapshot()
}

async function stopService(): Promise<LocalApiState> {
  if (emitTimer !== null) {
    clearTimeout(emitTimer)
    emitTimer = null
  }
  const current = server
  server = null
  await closeServer(current)
  if (state.running) {
    state = { ...state, running: false, startedAt: null }
    emit()
  }
  return snapshot()
}

/* ────────────────────────────── 注册 ────────────────────────────── */

export function registerLocalApiModule(ctx: ModuleContext): void {
  context = ctx

  ctx.handle(CH.localApi.state, () => snapshot())
  ctx.handle(CH.localApi.start, (_event, port) =>
    startService(typeof port === 'number' ? port : undefined)
  )
  ctx.handle(CH.localApi.stop, () => stopService())
}
