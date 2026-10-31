/**
 * 统一模型网关。
 *
 * 设计取舍：**只认 OpenAI 兼容的 `POST /chat/completions`，不引 SDK、不用 function calling。**
 * 原因有三：
 * 1. 用户换服务商时只需要改 Base URL + Key，9 家预设（含本地 Ollama / LM Studio）都能直接跑；
 *    一旦引入某家 SDK，就等于把该家的私有协议又请回来了。
 * 2. function calling 在兼容服务上实现程度参差不齐（有的只返回半截 JSON、有的忽略 schema），
 *    而本项目的动作协议是「每轮只输出一个 JSON」，自己约束 prompt 反而更稳、更可控。
 * 3. 只用 Node 22 自带的 fetch，零依赖，也方便打包。
 */

import type { Settings, TestResult } from '@shared/types'

/* ────────────────────────────── 对外类型 ────────────────────────────── */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  settings: Settings
  messages: ChatMessage[]
  /** 请求 response_format=json_object；服务端不支持时自动降级重试 */
  jsonMode?: boolean
  /** 覆盖 settings.temperature */
  temperature?: number
  /** 默认 90s */
  timeoutMs?: number
  /** 外部取消信号，会与内部超时联动 */
  signal?: AbortSignal
}

export interface ChatResult {
  content: string
  tokens: number
}

/* ────────────────────────────── 内部常量与类型 ────────────────────────────── */

const DEFAULT_TIMEOUT_MS = 90_000
/** 连通性测试不需要等 90s，用户盯着按钮等 */
const TEST_TIMEOUT_MS = 20_000

/** 请求体形状，独立声明是为了在降级重试时能安全地摘掉 response_format */
interface ChatPayload {
  model: string
  messages: ChatMessage[]
  temperature: number
  stream: false
  response_format?: { type: 'json_object' }
}

interface CompletionChoice {
  message?: { content?: string | null }
  finish_reason?: string | null
}

interface CompletionResponse {
  choices?: CompletionChoice[]
  usage?: { total_tokens?: number }
}

/** 携带 HTTP 状态码与原始响应体，便于在 catch 里做「人话翻译」与降级判断 */
class HttpError extends Error {
  readonly status: number
  readonly body: string

  constructor(status: number, body: string) {
    super(`HTTP ${status}`)
    this.name = 'HttpError'
    this.status = status
    this.body = body
  }
}

/* ────────────────────────────── 端点解析 ────────────────────────────── */

/**
 * 把用户随手填的 Base URL 归一化成完整的 chat/completions 端点。
 *
 * 必须兼容三种填法，因为设置页是自由输入框，用户不会照文档填：
 * - 裸域名      https://api.deepseek.com          → /v1/chat/completions
 * - 已带版本段  https://open.bigmodel.cn/api/paas/v4 → /chat/completions（智谱是 v4 不是 v1）
 * - 完整端点    https://x/v1/chat/completions      → 原样返回（重复拼接会 404）
 */
export function resolveEndpoint(baseUrl: string): string {
  let url = (baseUrl ?? '').trim()
  if (!url) throw new Error('未填写 Base URL，请到设置里选一个服务商或手动填写')

  // 用户常常只填 api.xxx.com，补协议头，否则 fetch 直接报错
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  // 尾部斜杠会让后续拼接出现 `//chat`，部分网关会 404
  url = url.replace(/\/+$/, '')

  if (/\/chat\/completions$/i.test(url)) return url
  // 版本段：/v1 /v4 /v1beta …… 已经带了就不再补 v1
  if (/\/v\d+[a-z0-9]*$/i.test(url)) return `${url}/chat/completions`
  return `${url}/v1/chat/completions`
}

/* ────────────────────────────── 主入口 ────────────────────────────── */

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const endpoint = resolveEndpoint(opts.settings.baseUrl)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const payload: ChatPayload = {
    model: opts.settings.model,
    messages: opts.messages,
    temperature: opts.temperature ?? opts.settings.temperature ?? 0.2,
    stream: false,
    ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {})
  }

  try {
    return await postChat(endpoint, opts.settings, payload, timeoutMs, opts.signal)
  } catch (err) {
    // 很多「兼容」服务并不支持 response_format，直接回 400。
    // 这不该让用户看到一个莫名其妙的失败，降级重试一次（不带该参数）成功率极高。
    if (opts.jsonMode && isJsonModeUnsupported(err)) {
      const { response_format: _dropped, ...rest } = payload
      return postChat(endpoint, opts.settings, rest, timeoutMs, opts.signal)
    }
    throw err
  }
}

/* ────────────────────────────── 连通性测试 ────────────────────────────── */

/**
 * 设置页的「测试连接」。
 * 约定：**永不抛异常**，所有失败都折成 { ok:false, error }，否则 IPC 层会变成未捕获错误。
 */
export async function testConnection(settings: Settings): Promise<TestResult> {
  const started = Date.now()
  let endpoint: string | undefined
  try {
    endpoint = resolveEndpoint(settings.baseUrl)
    const res = await chat({
      settings,
      messages: [{ role: 'user', content: '只回复 ok' }],
      temperature: 0,
      timeoutMs: TEST_TIMEOUT_MS
    })
    return {
      ok: true,
      endpoint,
      latency: Date.now() - started,
      reply: res.content.trim().slice(0, 80)
    }
  } catch (err) {
    return {
      ok: false,
      endpoint,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/* ────────────────────────────── 宽松 JSON 解析 ────────────────────────────── */

/**
 * 模型输出常常裹着 ```json 围栏、前言或后记。
 * 策略：先剥围栏，再截取首个 `{` 到末个 `}`，最后 JSON.parse。
 * 失败时把原文前 200 字带进错误里——排查「模型到底吐了什么」全靠这个。
 */
export function parseJSONLoose<T = unknown>(text: string): T {
  const source = (text ?? '').trim()
  if (!source) throw new Error('模型返回了空内容，无法解析 JSON')

  let body = source
  const fenced = source.match(/```[a-zA-Z]*\s*([\s\S]*?)```/)
  if (fenced && fenced[1].trim()) body = fenced[1].trim()

  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start !== -1 && end > start) body = body.slice(start, end + 1)

  try {
    return JSON.parse(body) as T
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`模型输出不是合法 JSON（${reason}）：${source.slice(0, 200)}`)
  }
}

/* ────────────────────────────── 底层请求 ────────────────────────────── */

async function postChat(
  endpoint: string,
  settings: Settings,
  payload: ChatPayload,
  timeoutMs: number,
  external?: AbortSignal
): Promise<ChatResult> {
  const apiKey = (settings.apiKey ?? '').trim()
  const local = isLocalHost(endpoint)
  if (!apiKey && !local) {
    throw new Error('未填写 API Key（本地服务可留空）')
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  // 本地推理服务通常不校验鉴权，带上空的 Bearer 反而会被某些网关拒掉
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  // 手动转发外部 signal，而不是 AbortSignal.any：
  // 一是 lib 目标是 ES2023，二是这里需要区分「超时」与「用户取消」两种 abort 原因。
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const forward = (): void => controller.abort()

  if (external) {
    if (external.aborted) {
      clearTimeout(timer)
      throw new Error('已取消')
    }
    external.addEventListener('abort', forward, { once: true })
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    })

    const raw = await res.text()
    if (!res.ok) throw new HttpError(res.status, raw)

    let data: CompletionResponse
    try {
      data = JSON.parse(raw) as CompletionResponse
    } catch {
      // 典型场景：Base URL 指到了官网首页，返回一段 HTML
      throw new Error(`服务返回的不是 JSON，请检查 Base URL 是否指向兼容接口（当前请求：${endpoint}）`)
    }

    const choice = data.choices?.[0]
    const content = choice?.message?.content ?? ''
    if (!content.trim()) {
      if (choice?.finish_reason === 'length') {
        throw new Error('模型输出被截断，请调大 max_tokens 或换模型')
      }
      throw new Error('模型返回了空内容，请检查模型名是否正确')
    }

    return { content, tokens: data.usage?.total_tokens ?? 0 }
  } catch (err) {
    throw translate(err, endpoint, timeoutMs, timedOut, external)
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', forward)
  }
}

/* ────────────────────────────── 错误翻译 ────────────────────────────── */

/**
 * 把底层错误翻成人话。
 * 原因：这些错误最终会显示在侧边栏，用户看到 `fetch failed` / `HTTP 401` 完全无从下手。
 */
function translate(
  err: unknown,
  endpoint: string,
  timeoutMs: number,
  timedOut: boolean,
  external?: AbortSignal
): Error {
  if (err instanceof HttpError) {
    const detail = err.body.replace(/\s+/g, ' ').slice(0, 160)
    if (err.status === 401 || err.status === 403) {
      return new Error(`API Key 无效或无权限（HTTP ${err.status}）`)
    }
    if (err.status === 404) {
      return new Error(`接口地址不对，请检查 Base URL（当前请求：${endpoint}）`)
    }
    if (err.status === 429) {
      return new Error('触发限流，稍后再试（HTTP 429）')
    }
    if (err.status >= 500) {
      return new Error(`服务商暂时不可用（HTTP ${err.status}）`)
    }
    return new Error(`请求被拒绝（HTTP ${err.status}）：${detail}`)
  }

  if (isAbortError(err)) {
    if (timedOut) {
      return new Error(`请求超时（${Math.round(timeoutMs / 1000)}s），模型或网络太慢`)
    }
    if (external?.aborted) return new Error('已取消')
    return new Error('请求被中断')
  }

  // fetch 在 DNS 失败 / 连接被拒 / TLS 出错时统一抛 TypeError
  if (err instanceof TypeError) {
    return new Error(`无法连接到 ${hostOf(endpoint)}，检查网络或 Base URL`)
  }

  return err instanceof Error ? err : new Error(String(err))
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
}

function isJsonModeUnsupported(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false
  if (err.status !== 400 && err.status !== 422) return false
  return /response_format|unsupported|not support/i.test(err.body)
}

function isLocalHost(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0'
  } catch {
    return false
  }
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}
