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
 *
 * 令牌**不再出现在 IPC 状态里**。原先 `state()` 在服务还没启动（`running:false`）时
 * 就返回完整 token，等于渲染层零交互就能拿到它 —— 一个被 XSS 的渲染层可以自己
 * `start()` 再自己拿 token，然后 `POST /act` 带 `"confirm":true`，全程没人点过任何东西。
 * 现在令牌只在主进程内存里，界面要拿只能让主进程写进剪贴板，渲染层始终看不到明文。
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, clipboard } from 'electron'
import { CH } from '@shared/ipc'
import type { LocalApiState, Profile } from '@shared/types'
import type { Action, ActionType } from '@shared/protocol'
import { dataDir, getStores } from '@main/store'
import { isSealed, openText, sealText } from '@main/store/seed-seal'
import { migrateSecretAtRest, writeFileAtomic } from '@main/store/secret-at-rest'
import { bridgeFor } from '@main/core/cdp'
import { captureSnapshot } from '@main/agent/snapshot'
import { describeAction, ApprovalRequiredError, AuditUnavailableError, MaskIncompleteError, executeAction } from '@main/agent/actions'
import { assessRisk } from '@main/agent/risk'
import { requestConsent } from '@main/agent/consent'
import { auditGate } from '@main/modules/audit'
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
  startedAt: null,
  requests: 0
}

/* ────────────────────────────── 令牌 ────────────────────────────── */

/**
 * 令牌只活在这个变量里。
 *
 * 它**不进 `state`**：`state` 会通过 `ss:push:local-api-state` 广播给渲染层，
 * 也会被 `ss:localApi:state` 直接返回。令牌一旦进去，渲染层就有了它，
 * 而渲染层是整个应用里最可能被页面内容攻破的一层。
 */
let secret = ''

function tokenPath(): string {
  return join(dataDir(), TOKEN_FILE)
}

/**
 * 把令牌写进磁盘。**落盘形态一律是 `enc:` 密封的**。
 *
 * 为什么这个令牌值得和 seed 用同一套保护：seed 泄露 = 身份可推算；令牌泄露 =
 * 本机可被远程驱动（L2 还要过原生窗口，但 L1 是直通的）。而它的权限比 seed 更高，
 * 所以没有理由让它明文躺在同一个目录里。
 *
 * `mode: 0o600` 保留但**不作为控制项**：Windows 上它不生效（实测 644），
 * 真正起作用的是 safeStorage 那层。留着是为了 POSIX 上多一道。
 */
function writeTokenFile(token: string): void {
  // 原子写（tmp → rename）在 `store/secret-at-rest.ts`：那是零依赖模块，能被 Node 单测。
  // 直接 `writeFileSync(target)` 不是原子的 —— 写到一半断电/磁盘满会留下一个**截断的
  // 令牌文件**，而它承载的是「正在跑的脚本靠它认证」。截断之后 loadToken 读不出字符串
  // → 重新生成 → 所有在用客户端集体 401，用户完全不知道发生了什么。
  writeFileAtomic(
    tokenPath(),
    JSON.stringify({ token: sealText(token, '本地 API 令牌'), createdAt: Date.now() }, null, 2)
  )
}

/**
 * 生成并落盘新令牌。
 * 32 字节随机：足够长到不可猜测，hex 编码后 64 字符，粘进 curl 也不会被转义。
 */
function createToken(): string {
  const token = randomBytes(32).toString('hex')
  try {
    writeTokenFile(token)
  } catch (err) {
    // 落盘失败仍然返回令牌：本次进程内可用，只是下次启动会换一个新的
    console.error('[localapi] 令牌写入失败', err)
  }
  secret = token
  return token
}

/**
 * 读磁盘上的令牌。
 *
 * 三种落盘形态都要认：
 *   1. `enc:` 密文（本版本写的）→ 解开
 *   2. 裸 hex（旧版本写的）→ **照用，并立刻密封重写**
 *   3. 解不开 / 形状不对 → 重新生成
 *
 * 第 2 条是这次升级的关键：如果对旧令牌「解不开就换新的」，所有已经在用本地 API
 * 的脚本会在升级后集体 401，而用户完全不知道发生了什么。令牌不是身份，
 * 换新的代价看似很低 —— 但对正在跑自动化的用户不是。
 *
 * 第 3 条和第 2 条的区别是「解不开」：换了机器/系统账户时旧密文确实用不了，
 * 这时重新生成是唯一选择，和 `settings.ts` 对 apiKey 的处置一致。
 */
function loadToken(): string {
  let stored: unknown
  try {
    const raw = JSON.parse(readFileSync(tokenPath(), 'utf8')) as unknown
    if (raw !== null && typeof raw === 'object') stored = (raw as Record<string, unknown>).token
  } catch {
    // 首次运行没有文件，属正常路径
  }

  if (typeof stored !== 'string' || stored === '') return createToken()

  let token = stored
  if (isSealed(stored)) {
    try {
      token = openText(stored, '本地 API 令牌')
    } catch (err) {
      console.error(
        '[localapi] 旧令牌解不开（通常是换了机器或系统账户），将重新生成：' +
          (err instanceof Error ? err.message : String(err))
      )
      return createToken()
    }
  } else {
    // 旧版明文：先照用，再就地密封。密封失败不影响本次运行（下次启动再试一次），
    // 但**不换令牌** —— 换掉会打断正在使用它的客户端。
    try {
      writeTokenFile(token)
    } catch (err) {
      console.error('[localapi] 旧令牌密封失败（令牌本身仍可用）', err)
    }
  }

  if (!TOKEN_PATTERN.test(token)) return createToken()
  secret = token
  return token
}

function ensureToken(): string {
  if (secret.length === 0) return loadToken()
  return secret
}

/**
 * 启动时把**已经存在**的明文令牌就地密封。
 *
 * ── 为什么不能只靠 `loadToken()` ──
 *
 * `ensureToken()` 只有两个调用点：启用本地 API 服务（`startService`）、
 * 以及「复制令牌」按钮。也就是说**从不使用这项功能的用户，明文令牌会一直躺在盘上**。
 * 而门禁（`tools/verify-seed-at-rest.mjs`）扫的是磁盘状态，不是「用起来之后的状态」——
 * 一个只有用起来才会修好的迁移，对绝大多数用户等于没修。这和 `sealLegacyBackups`
 * 在启动时跑是同一个理由。
 *
 * ── 逻辑在 `store/secret-at-rest.ts`，这里只负责接线 ──
 *
 * 「读 → 判断 → 密封 → 原子写」那一整套在零依赖模块里，因为 `node --test` 加载不了
 * 这个文件（静态 import 了 electron）。留在本地就只能「读代码证明它对」，那不是验证。
 * 每条「不动」的分支（不创建 / 不猜形状 / 失败不改原文件）的理由也在那边，
 * 判据和动作必须待在一起，否则下一个人改一处、另一处漂走。
 *
 * 失败不阻断启动：`sealText` 在 safeStorage 不可用时（Linux 无 keyring）会抛，
 * 那时保持明文是正确的降级 —— 门禁会把它报成红，而不是让它看起来已经修好。
 */
function migrateTokenAtRest(): void {
  const r = migrateSecretAtRest({
    file: tokenPath(),
    label: '本地 API 令牌',
    pick: (raw) =>
      raw !== null && typeof raw === 'object'
        ? ((raw as Record<string, unknown>).token as string | undefined)
        : undefined,
    isSealed,
    isWellFormed: (v) => TOKEN_PATTERN.test(v),
    seal: sealText,
    // 只换 token 的形态，其余字段（createdAt）原样保留 —— 迁移不该顺手抹掉别的字段
    render: (sealed, previous) => JSON.stringify({ ...previous, token: sealed }, null, 2)
  })

  if (r.outcome === 'resealed') {
    console.log('[localapi] 已把盘上的明文令牌就地密封（令牌值未变）')
  } else if (r.outcome === 'failed') {
    console.error('[localapi] 明文令牌密封失败，原文件未改动（下次启动再试）：' + String(r.reason))
  }
  // 其余结局（missing / unreadable / not-json / empty / already-sealed / bad-shape）
  // 都是「原文件一个字节都没动」，启动阶段不需要日志噪音。
}

/* ────────────────────────────── 状态广播 ────────────────────────────── */

/**
 * 对外状态里**没有 token 字段** —— 这不是省略，是契约。
 * 渲染层只需要知道「有没有在跑、在哪个端口」，它不需要凭证本身。
 */
function snapshot(): LocalApiState {
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
  // 空令牌一律不匹配：两个空 Buffer 做 timingSafeEqual 会返回 true，
  // 那等于「还没生成令牌」时任何 Bearer 都能过
  if (secret.length === 0) return false
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(secret, 'utf8')
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
  // query / url 必须裁剪，与 agent 侧 toAction 保持一致。
  //
  // 为什么这不是格式洁癖：这两个字段都会进 `assessRisk` 的 haystack，而
  // `\s+` 类词条（`place\s*order` / `log\s*out`）本来就吃空白，但
  // 「`place order ` 末尾带空格」和「`place order`」在**只读意图判定**里
  // 走的是 `intent.includes(...)`，两边裁剪不一致时同一个意图在两条入口
  // 会得到不同等级。闸门分叉比闸门漏判更难查，因为它取决于调用方走哪条路。
  if (typeof rec.url === 'string') action.url = rec.url.trim()
  if (typeof rec.query === 'string') action.query = rec.query.trim()
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
    requireProfile(id)
    const body = await readJsonBody(req)
    const payload = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const action = toAction(payload.action)
    // 外部调用方没有「用户意图」可传，所以这里**不传 intent**：
    // 执行器会按空意图重算，得到永不降级的最保守等级。
    //
    // 请求体里的 `confirm` 字段**已经没有任何效力**，留着也不会被读。
    // 原先 `"confirm": true` 直接把 approvedBy 抬到 'api' —— 外部脚本
    // （或者一个拿到了令牌的 XSS 载荷）自己声明一句「我确认了」就放行，
    // 而真正该问的人从头到尾没被问过。
    // 现在 L2 只能由主进程弹系统原生窗口取得凭证，意味着**机器前必须有人**。

    const tab = requireTab(id)
    const cdp = bridgeFor(tab.wc)
    await cdp.attach()
    // 外部调用方手里没有当轮快照，但编号校验是防幻觉的唯一闸门，不能因为走 API 就绕过：
    // 这里现采一帧再交给执行器，元素编号必须真实存在于当前页面。
    const snap = await captureSnapshot(cdp)

    // 先自己判一次等级：只有知道「这是不是 L2」才谈得上要不要弹确认。
    // 语义来源必须与执行器一致 —— 都从快照取元素可读名，不吃调用方输入。
    const target = action.id ? snap.elements.find((el) => el.id === action.id) : undefined
    const verdict = assessRisk(action, '', target?.name ?? '')

    let ticket: string | undefined
    if (verdict.level === 'L2') {
      const outcome = await requestConsent({
        action,
        level: 'L2',
        reason: verdict.reason,
        ...(verdict.matched !== undefined ? { matched: verdict.matched } : {}),
        target: describeAction(action, snap),
        origin: 'localapi'
      })
      if (outcome.kind !== 'granted') {
        // 三种失败要分开报，否则调用方只能看到「409」然后猜：
        // 拒绝 = 人明确不同意（别重试，去问人）；超时 = 人不在（补上人再重试）；
        // 弹不出来 = 环境问题（重试有意义）。混成一个码，客户端只能一律重试，
        // 而「一律重试」对着一个明确拒绝的动作就是在骚扰机器前的人。
        const detail = `这是一个不可逆动作，需要有人在应用窗口上点「允许执行」才能继续。${verdict.reason}`
        if (outcome.kind === 'denied') {
          throw new ApiError(
            409,
            'E_CONSENT_DENIED',
            `${detail} 本次已被本机用户明确拒绝（在确认窗口点了「取消」），请勿自动重试。`
          )
        }
        if (outcome.kind === 'timeout') {
          throw new ApiError(
            409,
            'E_CONSENT_TIMEOUT',
            `${detail} 120 秒内无人确认，已按拒绝处理。`
          )
        }
        // 503：环境问题，调用方补什么字段都没用，重试才有意义
        throw new ApiError(
          503,
          'E_CONSENT_UNAVAILABLE',
          `${detail} 本次无法弹出系统确认窗口（应用窗口已关闭或环境异常）。`
        )
      }
      ticket = outcome.ticket
    }

    let result
    try {
      result = await executeAction(cdp, action, snap, {
        ...(ticket !== undefined ? { ticket } : {}),
        origin: 'api',
        onGate: (event) => auditGate(getStores(), event)
      })
    } catch (err) {
      if (err instanceof ApprovalRequiredError) {
        // 走到这里说明我们自己那次判定是 L1、执行器重算成了 L2（两份语义不一致）。
        // 不再提供「加个字段重试」的出路：那正是被拆掉的那条旁路。
        throw new ApiError(
          409,
          'E_APPROVAL_REQUIRED',
          `${err.message}；不可逆动作必须由人在应用窗口上确认，请重试并等待系统确认框`
        )
      }
      if (err instanceof AuditUnavailableError) {
        // 503：环境问题，调用方补什么字段都没用，重试才有意义
        throw new ApiError(503, 'E_AUDIT_UNAVAILABLE', err.message)
      }
      if (err instanceof MaskIncompleteError) {
        // 503 而不是 4xx：调用方的请求没有任何问题，是**这个环境没伪装住**。
        // 不给出「加个字段跳过」的出路 —— 那等于让调用方替用户决定
        // 「指纹漏了也可以付钱」，而这正是闸门要拦的东西。
        // 单独一个错误码，是为了让调用方能区分「等一会儿重试」（环境修好）
        // 和「补字段重试」（永远没用）—— 混成 500 时这两件事长得一样。
        throw new ApiError(
          503,
          'E_MASK_INCOMPLETE',
          `${err.message}（伪装状态：${err.state}，缺口：${err.kind}）；` +
            '该环境的指纹未完全生效，不可逆动作已拦下，未执行'
        )
      }
      throw err
    }

    if (!result.ok) {
      // 动作被拒（编号不存在 / 页面脚本未就绪）属于调用方问题，用 400 让客户端能区分于服务故障
      throw new ApiError(400, 'E_ACTION_FAILED', result.message)
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
      createToken()
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
    createToken()
    state = { running: true, port: target, startedAt: Date.now(), requests: 0 }
    emit()
    await closeServer(previous)
    return snapshot()
  }

  ensureToken()
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
  state = { running: true, port: target, startedAt: Date.now(), requests: 0 }
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

  // 启动即密封历史明文令牌。放在注册里而不是 startService 里，见 migrateTokenAtRest 的注释：
  // 不启用本地 API 的用户永远走不到 startService，他们的明文令牌会一直在盘上。
  migrateTokenAtRest()

  ctx.handle(CH.localApi.state, () => snapshot())
  ctx.handle(CH.localApi.start, (_event, port) =>
    startService(typeof port === 'number' ? port : undefined)
  )
  ctx.handle(CH.localApi.stop, () => stopService())

  /**
   * 把令牌写进剪贴板，**但不把它交给渲染层**。
   *
   * 为什么不是 `revealToken(): string`：那只是把泄露点从 `state()` 挪到另一个通道，
   * 被 XSS 的渲染层照样调一下就拿走明文 —— 挪一个函数名治不好任何事。
   * 用户真正的需求是「把令牌粘到别处」，剪贴板正好满足这一点，而渲染层读不到剪贴板
   * （navigator.clipboard.readText 需要用户手势与权限，不是随手可调）。
   *
   * 代价：界面上没法「显示」完整令牌。这是有意的取舍 —— 能显示就能被读走。
   * 如果将来一定要在界面上显示，必须走「系统原生窗口确认 + 只显示一次」，
   * 而不是新增一个返回明文的通道。
   */
  ctx.handle(CH.localApi.copyToken, () => {
    const token = ensureToken()
    clipboard.writeText(token)
    return { copied: true }
  })
}
