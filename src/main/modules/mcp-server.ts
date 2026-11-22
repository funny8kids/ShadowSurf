/**
 * MCP（Model Context Protocol）stdio 服务器。
 *
 * ── 为什么现在有这个东西 ──
 *
 * 这个项目的全部主张是「AI agent 驱动浏览器」，但它此前**没有任何一个 agent 能连上来的接口**：
 * 只有给人看的界面，和给脚本用的本地 HTTP API。GoLogin / AdsPower / Undetectable /
 * Incogniton / MoreLogin 这五家都已经上了 MCP —— 也就是说，「能不能被 Claude / Cursor
 * 直接驱动」已经是这个品类的入场券，不是加分项。
 *
 * ── 架构：它自己没有任何权限 ──
 *
 * 这个服务器**不是一个平行实现**，它是应用本地 HTTP API 的一个遥控器：
 *
 *     MCP 客户端  ──stdio/JSON-RPC──▶  MCP 服务器（本文件）
 *                                          │  Bearer 令牌
 *                                          ▼
 *                                   127.0.0.1:7717 本地 API
 *                                          │
 *                                          ▼
 *                                   主进程：风险分级 → 原生确认窗口 → 执行器 → 审计
 *
 * 关键点在最下面那一层：**不可逆动作的授权由主进程弹出的系统原生窗口取得**，
 * 而那扇窗在这个进程之外，遥控器碰不到。所以「MCP 能不能绕过同意」这个问题
 * 在结构上就没有答案 —— 它连执行器的门都进不去，只能调 `/act`，
 * 而 `/act` 会自己重算风险等级、自己要票。
 *
 * 本地 API 已经有的东西这里全部复用：Bearer 令牌、`timingSafeEqual` 比对、
 * CORS 白名单、请求体上限、错误码语义（`E_CONSENT_DENIED` / `E_CONSENT_TIMEOUT` /
 * `E_CONSENT_UNAVAILABLE`）。**这里不重新实现任何一道闸门**，只负责把 MCP 的
 * 调用翻译成一次本地 API 调用，并把失败原样带回去。
 *
 * ── 令牌怎么给 ──
 *
 * 通过**环境变量** `SS_LOCAL_API_TOKEN`：
 *
 *   - 不用 argv：argv 在进程列表里是公开的（`ps`、任务管理器都能看到），
 *     等于把令牌贴在墙上；
 *   - 不用文件：应用自己的令牌文件是 safeStorage 密封的（`enc:`），
 *     只有主进程解得开；而纯 Node 进程解不开 —— 想让 MCP 服务器能读，
 *     就只能另写一份明文文件，那是一个**用户可读、长期存在**的泄漏点，
 *     比环境变量糟得多（环境变量至少随进程一起消失）。
 *
 * 必须诚实说明的**残留风险**：同一个操作系统用户下的其它进程仍然能读到这个环境变量。
 * 这一点应用的界面上本来就已经写明了，本服务器不假装自己解决了它 ——
 * 令牌的价值是「不让网页内容拿到」，不是「不让本机的另一个程序拿到」。
 *
 * ── 怎么跑 ──
 *
 * 独立进程（推荐 —— 由 MCP 客户端自己拉起，这是 MCP 的常规部署方式）：
 *
 *     SS_LOCAL_API_URL=http://127.0.0.1:7717 \
 *     SS_LOCAL_API_TOKEN=<应用「本地 API」面板里复制的令牌> \
 *     node dist/mcp-server.mjs
 *
 * 开发期（源码直跑，Node 22.18+ 自带类型擦除）：
 *
 *     SS_LOCAL_API_URL=http://127.0.0.1:7717 \
 *     SS_LOCAL_API_TOKEN=<令牌> \
 *     node --experimental-strip-types src/main/modules/mcp-server.ts
 *
 * `dist/mcp-server.mjs` 指的是「把本文件单独打成一个 ESM 文件」的产物。
 * 本仓库的构建只给主进程一个入口（electron.vite.config.ts），所以这个文件
 * 需要额外加一个构建入口才能产出 —— 那是构建配置的事，不是本模块的事。
 *
 * ⚠️ stdout **只能**有 JSON-RPC 消息。任何一行日志混进去都会让客户端解析失败，
 * 所以本文件所有诊断信息一律走 stderr。
 *
 * ── 依赖 ──
 *
 * 零第三方依赖：JSON-RPC 的帧与消息形状都是自己实现的（stdio 传输就是
 * 「一行一个 JSON 对象的 JSON-RPC 2.0」）。不引 SDK 的理由和 localapi.ts
 * 不用框架是同一个：安全边界必须逐行看得清。
 *
 * 运行期**不 import electron**：这个文件要能被纯 Node 加载（standalone 模式）。
 * 所有类型引用都是 `import type`，运行期会被擦掉。
 */

import { createInterface } from 'node:readline'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'

/* ────────────────────────────── 协议常量 ────────────────────────────── */

/**
 * 支持的 MCP 协议版本，从新到旧。
 *
 * 协商规则（按 MCP 规范）：客户端报了一个我们支持的版本 → 原样回它；
 * 报了一个不支持的版本 → 回我们支持的最新版本，由客户端决定要不要继续。
 * 所以这里是「我们能说什么」，不是「客户端想听什么就说什么」——
 * 后者会让一份老客户端收到一份它读不懂的响应。
 */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const

/** 本地 API 的默认地址。与 localapi.ts 的 DEFAULT_PORT 保持一致 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:7717'

/** JSON-RPC 2.0 的标准错误码 */
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

/** 一次 API 响应的体积上限。快照是里面最大的一块，但仍要封顶 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
/** stdio 单行请求的上限（一行 = 一条完整 JSON-RPC 消息） */
const MAX_REQUEST_CHARS = 4 * 1024 * 1024

/** 本地 API 请求超时。快照与自检要跑页面内探针，给得比代理探测宽一些 */
const DEFAULT_TIMEOUT_MS = 30_000

/* ────────────────────────────── 类型 ────────────────────────────── */

export type JsonRpcId = string | number | null

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: JsonRpcError
}

export interface JsonSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export interface McpTool {
  name: string
  description: string
  inputSchema: JsonSchema
}

/** 工具执行的结果 */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  structuredContent?: Record<string, unknown>
}

/**
 * 调用应用本地 API 的入口。
 *
 * 契约：返回的是应用响应里**已经拆开的那一份** —— 应用回 `{ok:true,data:…}`，
 * 拆包由 HTTP 客户端负责（见 `createHttpApiClient`）。所以工具拿到的直接是
 * `data`，不必再判断 `ok`。
 *
 * 抽成接口有两个原因：测试里换成一个桩就能测 JSON-RPC 层（不需要真的起应用），
 * 以及「这个服务器自己不碰网络细节」这件事在类型上写清楚。
 */
export type ApiCaller = (
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
) => Promise<unknown>

export interface McpServerDeps {
  /** 调用本地 API 的入口 */
  callApi: ApiCaller
  /** serverInfo.name，默认 shadowsurf-mcp */
  name?: string
  /** serverInfo.version */
  version?: string
  /** tools/list 每页几个。默认一页给完；调小是为了让分页路径本身可测 */
  pageSize?: number
}

export interface McpServer {
  /**
   * 处理一行（一条 JSON-RPC 消息）。
   *
   * 返回要写回客户端的文本；返回 null 表示这是**通知**（notification），
   * 按 JSON-RPC 规范不回应。
   */
  handleMessage(line: string): Promise<string | null>
  /** 处理一条已解析的消息 */
  handle(message: unknown): Promise<JsonRpcResponse | null>
  /** 工具清单 */
  listTools(): McpTool[]
  /** 调用一个工具（返回 MCP 的 tool result） */
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>
}

/* ────────────────────────────── 小工具 ────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/* ────────────────────────────── 本地 API 客户端 ────────────────────────────── */

/**
 * 本地 API 的一次失败。
 *
 * 单独一个类型而不是直接抛字符串：调用方要区分「应用没开」「令牌不对」
 * 「这个端点还没有」「用户拒绝了」—— 这四件事的补救动作完全不同，
 * 折成一句话之后，客户端只能一律重试，而「一律重试」对着一个
 * 明确被拒绝的动作就是在骚扰机器前的人。
 */
export class McpApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 0) {
    super(message)
    this.name = 'McpApiError'
    this.code = code
    this.status = status
  }
}

export interface HttpApiOptions {
  /** 本地 API 的基地址 */
  baseUrl: string
  /** Bearer 令牌 */
  token: string
  /** 单次请求超时 */
  timeoutMs?: number
}

/**
 * 把一次本地 API 调用翻译成 HTTP 请求。
 *
 * 失败时的措辞是**面向 agent 的**：说清楚「应用没开」还是「令牌不对」，
 * 因为这两种的补救动作完全不同（去启动应用 vs 去复制令牌）。
 */
export function createHttpApiClient(opts: HttpApiOptions): ApiCaller {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return async (method, path, body): Promise<unknown> => {
    const url = new URL(path, opts.baseUrl)
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')

    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.token}`,
      accept: 'application/json'
    }
    if (payload !== null) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(payload.length)
    }

    const raw = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port === '' ? 80 : Number(url.port),
          path: url.pathname + url.search,
          method,
          headers
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = []
          let size = 0
          res.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy()
              reject(new McpApiError('E_RESPONSE_TOO_LARGE', '本地 API 的响应超过体积上限'))
              return
            }
            chunks.push(chunk)
          })
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })
          })
          res.on('error', (err: Error) => reject(err))
        }
      )
      req.setTimeout(timeoutMs, () => {
        req.destroy()
        reject(new McpApiError('E_TIMEOUT', `本地 API 请求超时（${String(timeoutMs)} 毫秒无响应）`))
      })
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNREFUSED') {
          reject(
            new McpApiError(
              'E_APP_NOT_RUNNING',
              `连不上应用（${opts.baseUrl}）：应用没有运行，或者「本地 API」没有启动。` +
                '请先启动 ShadowSurf 并在它的「本地 API」面板里启动服务。'
            )
          )
          return
        }
        reject(new McpApiError('E_NETWORK', `连不上应用（${opts.baseUrl}）：${err.message}`))
      })
      if (payload !== null) req.write(payload)
      req.end()
    })

    let parsed: unknown
    try {
      parsed = raw.text === '' ? null : (JSON.parse(raw.text) as unknown)
    } catch {
      if (raw.status >= 200 && raw.status < 300) {
        throw new McpApiError('E_BAD_RESPONSE', '本地 API 返回的不是合法 JSON', raw.status)
      }
      throw new McpApiError('E_HTTP', `本地 API 返回了 HTTP ${String(raw.status)}`, raw.status)
    }

    if (raw.status >= 200 && raw.status < 300) {
      // 应用的成功形状是 {ok:true,data}；文档里的形状是 {data}。两种都认。
      if (isRecord(parsed) && parsed['ok'] === true) return parsed['data']
      if (isRecord(parsed) && 'data' in parsed) return parsed['data']
      return parsed
    }

    // 失败：应用会回 {ok:false,error:{code,message}}，把它的原话带出去。
    // 同意相关的三种码（拒绝 / 超时 / 弹不出来）必须让调用方看得见区别 ——
    // 「一律重试」对着用户明确拒绝的动作就是在骚扰机器前的人。
    if (isRecord(parsed) && isRecord(parsed['error'])) {
      const err = parsed['error']
      const code = typeof err['code'] === 'string' ? err['code'] : 'E_UNKNOWN'
      let message = typeof err['message'] === 'string' ? err['message'] : '未知错误'
      if (raw.status === 404) {
        // 404 在这里几乎总是「应用侧还没有这个端点」，不是调用方写错了路径。
        // 这一点必须说清楚：不然调用方会去改自己的参数（重试、改路径），
        // 而真正缺的是应用侧的能力。
        message += '（应用的本地 API 里还没有这个端点 —— 这是应用侧的能力缺口，不是参数问题）'
      }
      throw new McpApiError(code, message, raw.status)
    }
    throw new McpApiError('E_HTTP', `本地 API 返回了 HTTP ${String(raw.status)}`, raw.status)
  }
}

/* ────────────────────────────── 工具 ────────────────────────────── */

/**
 * 动作类型清单。
 *
 * 与 `shared/protocol.ts` 的 `ActionType` 联合类型平行的一份。
 *
 * 为什么不能直接 import 那个联合类型：联合类型在运行期**不存在**，
 * 要拿到候选值就得 import 一个运行期对象（`ACTION_LABEL`），
 * 而 `@shared/*` 是构建期别名 —— 纯 Node 加载不了（本文件必须能 standalone 跑）。
 *
 * 为什么不担心它漂移：应用侧会用它自己的 `ACTION_TYPES` 校验动作类型，
 * 不符就是 400。这里的枚举过期只是「给 agent 的候选少了一个」，不是安全问题。
 * （tests/mcp-server.test.ts 里有一条断言盯着它与 protocol.ts 不漂移。）
 */
const ACTION_TYPES = ['click', 'type', 'press', 'scroll', 'navigate', 'extract', 'done'] as const

/** 从本地 API 拿回来的环境对象里，只往外发这些字段 */
function toProfileBrief(raw: unknown): Record<string, unknown> {
  const item = isRecord(raw) ? raw : {}
  return {
    id: item['id'],
    name: item['name'],
    group: item['group'],
    status: item['status'],
    platform: item['platform']
  }
}

/** 环境的非机密详情。刻意不含 seed / fingerprint / 代理凭据 */
function toProfileDetail(raw: unknown): Record<string, unknown> {
  const item = isRecord(raw) ? raw : {}
  return {
    id: item['id'],
    name: item['name'],
    group: item['group'],
    status: item['status'],
    platform: item['platform'],
    browserVersion: item['browserVersion'],
    tags: item['tags'],
    note: item['note'],
    createdAt: item['createdAt'],
    updatedAt: item['updatedAt'],
    lastUsedAt: item['lastUsedAt']
  }
}

interface ToolContext {
  callApi: ApiCaller
}

interface ToolDefinition extends McpTool {
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>
}

/*
 * ── 下面这张表与本地 API 的对应关系 ──
 *
 * 已经实现的端点（今天就能用）：
 *   GET  /v1/profiles                      → list_profiles / get_profile
 *   GET  /v1/tasks                         → list_tasks
 *   POST /v1/profiles/{id}/launch|stop     → launch_profile / stop_profile
 *   GET  /v1/profiles/{id}/snapshot        → snapshot_profile
 *   POST /v1/profiles/{id}/act             → act
 *
 * 文档里有、但应用**还没实现**的端点（今天会拿到明确的 404，而不是假成功）：
 *   GET  /v1/profiles/{id}/consistency     → fingerprint_selfcheck
 *   GET  /v1/proxies                       → list_proxies
 *   GET  /v1/audit/verify                  → audit_verify
 *
 * 文档与实现都还没有、需要应用侧补上的端点：
 *   GET  /v1/templates                     → list_templates
 *   GET  /v1/scripts                       → list_scripts
 *
 * 为什么不去别处绕（直接读应用的数据目录）：那会变成**第二条读路径** ——
 * 应用自己的 store 还要处理信封、迁移与损坏降级，MCP 侧再实现一遍必然漂移；
 * 而漂移的表现是「文件读不出来」被渲染成「列表是空的」，
 * 正是 store/json-file.ts 那条「读不到 ≠ 不存在」要防的事。
 * 所以这里宁可诚实地 404，也不自己造一条读路径。
 */

/** 从参数里取一个非空字符串，缺了就抛 —— 抛出来就是「工具执行失败」，不是静默默认值 */
function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`缺少参数 ${key}`)
  }
  return value.trim()
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'list_profiles',
    description:
      '列出 ShadowSurf 里的全部环境（浏览器身份）：id、名称、分组、运行状态、目标平台。' +
      '只读，不接触任何凭据。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (_args, ctx) => {
      const data = await ctx.callApi('GET', '/v1/profiles')
      const list = Array.isArray(data) ? data : []
      return { profiles: list.map(toProfileBrief) }
    }
  },
  {
    name: 'get_profile',
    description:
      '取一个环境的非机密详情（名称、分组、平台、标签、备注等）。' +
      '不会返回种子、指纹参数或代理凭据。',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: '环境 id（list_profiles 给的）' }
      },
      required: ['profileId'],
      additionalProperties: false
    },
    run: async (args, ctx) => {
      const profileId = requireString(args, 'profileId')
      // 用列表接口过滤而不是直接 GET /v1/profiles/{id}：
      // 本地 API 目前只实现了列表端点，直接取详情会 404。
      // 两边都是应用自己的数据源，不存在「读到了别的东西」的风险。
      const data = await ctx.callApi('GET', '/v1/profiles')
      const list = Array.isArray(data) ? data : []
      const hit = list.find((item) => isRecord(item) && item['id'] === profileId)
      if (hit === undefined) throw new Error(`环境不存在：${profileId}`)
      return { profile: toProfileDetail(hit) }
    }
  },
  {
    name: 'list_templates',
    description: '列出已保存的指纹模板。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (_args, ctx) => {
      const data = await ctx.callApi('GET', '/v1/templates')
      return { templates: Array.isArray(data) ? data : [] }
    }
  },
  {
    name: 'list_proxies',
    description:
      '列出代理池。**不返回用户名与口令** —— 那是凭证，agent 没有理由拿到。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (_args, ctx) => {
      const data = await ctx.callApi('GET', '/v1/proxies')
      const list = Array.isArray(data) ? data : []
      return {
        proxies: list.map((raw) => {
          const item = isRecord(raw) ? raw : {}
          // 只挑非机密字段：凭证一旦交出去，就等于把整条代理线交出去
          return {
            id: item['id'],
            name: item['name'],
            protocol: item['protocol'],
            host: item['host'],
            port: item['port'],
            region: item['region'],
            lastCheck: item['lastCheck']
          }
        })
      }
    }
  },
  {
    name: 'list_tasks',
    description: '列出任务记录（状态、意图、起止时间）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (_args, ctx) => {
      const data = await ctx.callApi('GET', '/v1/tasks')
      const list = Array.isArray(data) ? data : []
      return {
        tasks: list.map((raw) => {
          const item = isRecord(raw) ? raw : {}
          return {
            id: item['id'],
            profileId: item['profileId'],
            intent: item['intent'],
            status: item['status'],
            startedAt: item['startedAt'],
            finishedAt: item['finishedAt']
          }
        })
      }
    }
  },
  {
    name: 'list_scripts',
    description: '列出已保存的自动化脚本（名称、步骤数、更新时间）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (_args, ctx) => {
      const data = await ctx.callApi('GET', '/v1/scripts')
      const list = Array.isArray(data) ? data : []
      return {
        scripts: list.map((raw) => {
          const item = isRecord(raw) ? raw : {}
          const steps = Array.isArray(item['steps']) ? item['steps'] : []
          return {
            id: item['id'],
            name: item['name'],
            description: item['description'],
            stepCount: steps.length,
            updatedAt: item['updatedAt']
          }
        })
      }
    }
  },
  {
    name: 'audit_verify',
    description:
      '校验审计哈希链，返回结论（是否自洽、断在第几条、断链类型）。' +
      '只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (_args, ctx) => {
      const data = await ctx.callApi('GET', '/v1/audit/verify')
      return { verdict: data }
    }
  },
  {
    name: 'fingerprint_selfcheck',
    description:
      '对**运行中的**环境做指纹一致性自检：把配置里的指纹与页面真实读数逐项对照，' +
      '返回每一项的判定（pass / warn / fail）。环境必须已经启动，否则没有页面可测。',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: '环境 id' }
      },
      required: ['profileId'],
      additionalProperties: false
    },
    run: async (args, ctx) => {
      const profileId = requireString(args, 'profileId')
      const data = await ctx.callApi('GET', `/v1/profiles/${encodeURIComponent(profileId)}/consistency`)
      return { report: data }
    }
  },
  {
    name: 'launch_profile',
    description:
      '启动一个环境（打开它的浏览器窗口）。启动后才可以对它做动作。',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: '环境 id' }
      },
      required: ['profileId'],
      additionalProperties: false
    },
    run: async (args, ctx) => {
      const profileId = requireString(args, 'profileId')
      const data = await ctx.callApi('POST', `/v1/profiles/${encodeURIComponent(profileId)}/launch`)
      return { result: data }
    }
  },
  {
    name: 'stop_profile',
    description: '停止一个环境（关掉它的浏览器窗口）。',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: '环境 id' }
      },
      required: ['profileId'],
      additionalProperties: false
    },
    run: async (args, ctx) => {
      const profileId = requireString(args, 'profileId')
      const data = await ctx.callApi('POST', `/v1/profiles/${encodeURIComponent(profileId)}/stop`)
      return { result: data }
    }
  },
  {
    name: 'snapshot_profile',
    description:
      '抓取运行中环境的当前页面快照：URL、标题、正文摘要，以及页面元素列表' +
      '（元素用 e1、e2… 这样的短编号标识，**没有选择器**）。' +
      '动作必须用这里的编号，编号不在当轮快照里的动作会被判为幻觉并拒绝执行。',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: '环境 id' }
      },
      required: ['profileId'],
      additionalProperties: false
    },
    run: async (args, ctx) => {
      const profileId = requireString(args, 'profileId')
      const data = await ctx.callApi('GET', `/v1/profiles/${encodeURIComponent(profileId)}/snapshot`)
      return { snapshot: data }
    }
  },
  {
    name: 'act',
    description:
      '在运行中的环境里执行一个动作（点击 / 输入 / 按键 / 滚动 / 导航 / 提取）。' +
      '⚠️ 动作跑在**真实浏览器**里、对着**真实环境**：它会真的点击、真的输入、真的提交。' +
      '不可逆动作（支付、下单、删除、发送、发布）由应用弹出**系统原生确认窗口**，' +
      '必须有人在机器前点「允许执行」才会执行 —— 本工具没有、也不会有绕过它的参数。' +
      '没有该确认时调用会返回明确失败，请如实转达给用户，不要重试。',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: '环境 id' },
        action: {
          type: 'object',
          description:
            '要执行的动作。click / type / press 必须带 id（来自 snapshot_profile 的元素编号）。',
          properties: {
            type: { type: 'string', enum: [...ACTION_TYPES], description: '动作类型' },
            id: { type: 'string', description: '元素编号（e1、e2…），click/type/press 必填' },
            text: { type: 'string', description: 'type 动作要输入的文本' },
            key: { type: 'string', description: 'press 动作的按键名，如 Enter' },
            submit: { type: 'boolean', description: '输入后是否回车提交' },
            direction: {
              type: 'string',
              enum: ['up', 'down', 'top', 'bottom'],
              description: 'scroll 动作的方向'
            },
            amount: { type: 'number', description: 'scroll 动作的像素数' },
            url: { type: 'string', description: 'navigate 动作的地址（只允许 http/https）' },
            query: { type: 'string', description: 'extract 动作的取数指令' },
            summary: { type: 'string', description: 'done 动作的收尾说明' }
          },
          required: ['type'],
          additionalProperties: false
        }
      },
      required: ['profileId', 'action'],
      additionalProperties: false
    },
    run: async (args, ctx) => {
      const profileId = requireString(args, 'profileId')
      const action = args['action']
      if (!isRecord(action)) throw new Error('缺少参数 action')
      // 不做任何「补一个 confirm」的处理：应用侧的同意票只有主进程弹出的原生窗口
      // 能铸出来。这里就算收到 confirm 字段也不会转给应用 ——
      // 转过去也只是被忽略，而「被忽略」看起来像「生效了」。
      const body = { action }
      const data = await ctx.callApi(
        'POST',
        `/v1/profiles/${encodeURIComponent(profileId)}/act`,
        body
      )
      return { result: data }
    }
  }
]

/* ────────────────────────────── JSON-RPC ────────────────────────────── */

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/** 通知（没有 id）不回应 —— JSON-RPC 2.0 的硬规则 */
function isNotification(message: Record<string, unknown>): boolean {
  return message['id'] === undefined
}

function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === 'string') {
    const found = SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === requested)
    if (found !== undefined) return found
  }
  return SUPPORTED_PROTOCOL_VERSIONS[0]
}

/** 游标：把下标编码一下，让客户端别去猜它的含义 */
function encodeCursor(index: number): string {
  return Buffer.from(String(index), 'utf8').toString('base64url')
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0
  try {
    const parsed = Number(Buffer.from(cursor, 'base64url').toString('utf8'))
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
  } catch {
    return 0
  }
}

function toToolResult(payload: unknown, isError: boolean): McpToolResult {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  const result: McpToolResult = { content: [{ type: 'text', text }] }
  if (isError) result.isError = true
  if (isRecord(payload)) result.structuredContent = payload
  return result
}

/**
 * 造一个 MCP 服务器。
 *
 * 依赖只有三样：怎么调本地 API、叫什么名字、每页几个工具。
 * 刻意不把「工具清单」做成参数 —— 工具集是这个模块的**产品定义**，
 * 做成参数就等于允许运行期换掉它，而那份清单是要跟本地 API 的能力对齐的。
 */
export function createMcpServer(deps: McpServerDeps): McpServer {
  const pageSize = deps.pageSize ?? TOOLS.length
  const serverInfo = {
    name: deps.name ?? 'shadowsurf-mcp',
    version: deps.version ?? '0.1.0'
  }

  const findTool = (name: string): ToolDefinition | undefined =>
    TOOLS.find((tool) => tool.name === name)

  const server: McpServer = {
    listTools: (): McpTool[] =>
      TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      })),

    async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
      const tool = findTool(name)
      if (tool === undefined) throw new Error(`没有这个工具：${name}`)
      const payload = await tool.run(args, { callApi: deps.callApi })
      return toToolResult(payload, false)
    },

    async handleMessage(line: string): Promise<string | null> {
      let parsed: unknown
      try {
        parsed = JSON.parse(line) as unknown
      } catch (err) {
        // 解析错误也要回一条错误响应（id 只能是 null），
        // 否则客户端会一直等 —— 而 stdio 传输里没有「超时」这种自动兜底
        return JSON.stringify(errorResponse(null, PARSE_ERROR, 'JSON 解析失败：' + describe(err)))
      }
      const response = await server.handle(parsed)
      return response === null ? null : JSON.stringify(response)
    },

    async handle(message: unknown): Promise<JsonRpcResponse | null> {
      if (Array.isArray(message)) {
        // JSON-RPC 2.0 允许批量，但 MCP 的 stdio 传输是「一条消息一行」，
        // 这里明确拒绝而不是半支持
        return errorResponse(null, INVALID_REQUEST, '不支持批量请求：stdio 传输要求一条消息一行')
      }
      if (!isRecord(message)) {
        return errorResponse(null, INVALID_REQUEST, '请求必须是一个 JSON-RPC 对象')
      }

      const notification = isNotification(message)
      const id: JsonRpcId =
        typeof message['id'] === 'string' || typeof message['id'] === 'number'
          ? message['id']
          : null

      if (message['jsonrpc'] !== '2.0') {
        if (notification) return null
        return errorResponse(id, INVALID_REQUEST, 'jsonrpc 字段必须是 "2.0"')
      }

      const method = typeof message['method'] === 'string' ? message['method'] : ''
      if (method === '') {
        if (notification) return null
        return errorResponse(id, INVALID_REQUEST, '缺少 method')
      }

      const params = isRecord(message['params']) ? message['params'] : {}

      switch (method) {
        case 'initialize': {
          if (notification) return null
          return ok(id, {
            protocolVersion: negotiateProtocolVersion(params['protocolVersion']),
            capabilities: { tools: { listChanged: false } },
            serverInfo,
            instructions:
              '这个服务器是 ShadowSurf 本地 API 的遥控器，本身没有任何权限。' +
              '不可逆动作需要有人在应用窗口上点「允许执行」，无法通过参数绕过。'
          })
        }

        case 'notifications/initialized':
          // 通知：按规范不回应
          return null

        case 'ping':
          if (notification) return null
          return ok(id, {})

        case 'tools/list': {
          if (notification) return null
          const start = decodeCursor(params['cursor'])
          const slice = TOOLS.slice(start, start + pageSize)
          const next = start + slice.length
          const result: Record<string, unknown> = {
            tools: slice.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema
            }))
          }
          if (next < TOOLS.length) result['nextCursor'] = encodeCursor(next)
          return ok(id, result)
        }

        case 'tools/call': {
          if (notification) return null
          const name = typeof params['name'] === 'string' ? params['name'] : ''
          const args = isRecord(params['arguments']) ? params['arguments'] : {}
          const tool = findTool(name)
          if (tool === undefined) {
            // 「没有这个工具」是**协议层**的错误（请求本身就不成立），
            // 不是工具执行失败 —— MCP 把这两类分开：前者回 JSON-RPC error，
            // 后者在结果里带 isError
            return errorResponse(id, INVALID_PARAMS, `没有这个工具：${name || '(空)'}`)
          }
          try {
            const payload = await tool.run(args, { callApi: deps.callApi })
            return ok(id, toToolResult(payload, false))
          } catch (err) {
            const message = describe(err)
            const code = err instanceof McpApiError ? err.code : 'E_TOOL_FAILED'
            // 工具执行失败：结果里带 isError，并把错误码一起给出去 ——
            // 「用户拒绝了」和「应用没开」在调用方那里必须能分开处理
            return ok(id, {
              content: [{ type: 'text', text: message }],
              isError: true,
              structuredContent: { code, message }
            })
          }
        }

        default:
          if (notification) return null
          return errorResponse(id, METHOD_NOT_FOUND, `没有这个方法：${method}`)
      }
    }
  }

  return server
}

/* ────────────────────────────── stdio 传输 ────────────────────────────── */

/**
 * 跑 stdio 传输。
 *
 * 三条规矩：
 * 1. **stdout 只有 JSON-RPC 消息。** 任何日志混进去都会让客户端解析失败。
 * 2. **一行一条消息。** stdio 传输的定义就是「换行分隔的 JSON」。
 * 3. **按到达顺序处理。** 消息串行处理，避免响应乱序让客户端困惑。
 */
export function runStdio(
  server: McpServer,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream
): void {
  let chain: Promise<void> = Promise.resolve()
  const reader = createInterface({ input, crlfDelay: Infinity })
  reader.on('line', (line: string) => {
    chain = chain.then(async () => {
      const text = line.trim()
      if (text === '') return
      /**
       * 单行长度上限。
       *
       * stdio 协议一行就是一条完整消息，没有 HTTP 那种 Content-Length 可以预检。
       * 没有这道拦阻，一个写坏了的客户端（或被攻破的调用方）发出几百 MB 的一行，
       * 会先被 readline 整行读进内存，再交给 JSON.parse —— 主进程直接假死。
       *
       * 4MB 远大于任何正常的 MCP 调用（工具参数都是短 JSON）。
       * 超限**回一条合法错误响应**：stdio 里没有超时自动兜底，不回客户端就一直等。
       * id 只能是 null —— 这行连 JSON 都 parse 不了，拿不到调用方给的 id。
       */
      if (text.length > MAX_REQUEST_CHARS) {
        output.write(
          JSON.stringify(
            errorResponse(null, INVALID_PARAMS, `请求过长（上限 ${MAX_REQUEST_CHARS / 1024 / 1024}MB）`)
          ) + '\n'
        )
        return
      }
      try {
        const response = await server.handleMessage(text)
        if (response !== null) output.write(response + '\n')
      } catch (err) {
        // 走到这里说明连消息处理都炸了（内部 bug）。仍然要回一条合法响应，
        // 否则客户端会一直等下去
        output.write(
          JSON.stringify(errorResponse(null, INTERNAL_ERROR, '服务器内部错误：' + describe(err))) + '\n'
        )
      }
    })
  })
}

/* ────────────────────────────── 入口 ────────────────────────────── */

/**
 * 独立运行。
 *
 * 令牌从环境变量读，**不落盘、不打日志**。
 */
export async function main(): Promise<void> {
  const baseUrl = process.env['SS_LOCAL_API_URL'] ?? DEFAULT_BASE_URL
  const token = process.env['SS_LOCAL_API_TOKEN'] ?? ''
  if (token.trim() === '') {
    // 缺令牌就不启动：宁可明确失败，也不要「看起来能跑但每个调用都 401」
    process.stderr.write(
      '[mcp] 缺少环境变量 SS_LOCAL_API_TOKEN。\n' +
        '  令牌在 ShadowSurf 的「本地 API」面板里用「复制令牌」取得，' +
        '它是调用本地 API 的 Bearer 凭证。\n'
    )
    process.exitCode = 1
    return
  }

  const server = createMcpServer({ callApi: createHttpApiClient({ baseUrl, token }) })
  runStdio(server, process.stdin, process.stdout)
}

/**
 * 判断本文件是不是被直接运行的入口。
 *
 * 用**文件名**判断而不是 `import.meta.url`：主进程产物是 CommonJS，
 * `import.meta` 在那里会被打包器改写；而这里必须对
 * 「node dist/mcp-server.mjs」和「node --experimental-strip-types src/.../mcp-server.ts」
 * 两种跑法都成立。
 */
function isStandaloneEntry(): boolean {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry === '') return false
  const base = entry.replace(/\\/g, '/').split('/').pop() ?? ''
  return base === 'mcp-server.ts' || base === 'mcp-server.mjs' || base === 'mcp-server.js'
}

if (isStandaloneEntry()) {
  void main()
}
