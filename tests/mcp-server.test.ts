/**
 * MCP 服务器的 JSON-RPC 层与工具清单的回归测试。
 *
 * 被测的是 `modules/mcp-server.ts`。它不 import electron、也不 import `@shared/*`
 * 的**运行期**值，所以 `node --test` 能直接加载它 —— 这一点是刻意的：
 * MCP 服务器本来就要能作为独立进程跑，如果它只能在整个 Electron 应用里加载，
 * 那就等于没法单独测、也没法单独发布。
 *
 * ── 这里测的是什么，不测什么 ──
 *
 * 测：JSON-RPC 的帧（哪些要回应、哪些不回应、错误码对不对）、tools/list 的形状、
 *      工具调用的路径与参数、以及「工具执行失败」与「协议错误」的分界。
 * 不测：本地 API 自己答得对不对 —— 那是 localapi.ts 的事，那边有它自己的测试。
 *
 * 之所以要专门测「协议错误 vs 工具执行失败」这条分界：MCP 把它们分成两种机制
 * （JSON-RPC error vs 结果里的 isError）。分错了的后果是：客户端会把
 * 「这个工具不存在」当成「工具执行失败」，于是换个名字重试同一个调用，
 * 或者把「用户拒绝了不可逆动作」当成一次可重试的网络抖动。
 *
 * 跑法：node --experimental-strip-types --test tests/mcp-server.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createMcpServer, runStdio } from '../src/main/modules/mcp-server.ts'
import type { ApiCaller, JsonRpcResponse, McpToolResult } from '../src/main/modules/mcp-server.ts'

const ROOT = join(import.meta.dirname, '..')

/* ────────────────────────────── 夹具 ────────────────────────────── */

/**
 * 记录调用过哪些端点的桩。
 *
 * 契约：`callApi` 返回的是应用响应里**已经拆开的那一份**（应用回 `{ok:true,data:…}`，
 * HTTP 客户端负责把 `data` 拆出来）。所以桩直接返回数据本身。
 */
function stubApi(responder?: (method: string, path: string, body?: unknown) => unknown): {
  callApi: ApiCaller
  calls: Array<{ method: string; path: string; body?: unknown }>
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const callApi: ApiCaller = async (method, path, body) => {
    calls.push({ method, path, body })
    if (responder === undefined) return { ok: true }
    return responder(method, path, body)
  }
  return { callApi, calls }
}

const EXPECTED_TOOLS = [
  'list_profiles',
  'get_profile',
  'list_templates',
  'list_proxies',
  'list_tasks',
  'list_scripts',
  'audit_verify',
  'fingerprint_selfcheck',
  'launch_profile',
  'stop_profile',
  'snapshot_profile',
  'act'
]

/* ────────────────────────────── JSON-RPC 帧 ────────────────────────────── */

test('initialize：回协议版本、能力与服务器信息', async () => {
  const { callApi } = stubApi()
  const server = createMcpServer({ callApi })

  const res = (await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } }
  })) as JsonRpcResponse

  assert.equal(res.jsonrpc, '2.0')
  assert.equal(res.id, 1)
  const result = res.result as Record<string, unknown>
  assert.equal(result['protocolVersion'], '2025-06-18')
  assert.ok(result['capabilities'], '必须声明能力')
  const info = result['serverInfo'] as Record<string, unknown>
  assert.equal(info['name'], 'shadowsurf-mcp')
})

test('协议版本协商：客户端报不支持的版本时，回我们支持的最新版本', async () => {
  const { callApi } = stubApi()
  const server = createMcpServer({ callApi })

  const res = (await server.handle({
    jsonrpc: '2.0',
    id: 'x',
    method: 'initialize',
    params: { protocolVersion: '1999-01-01' }
  })) as JsonRpcResponse

  const result = res.result as Record<string, unknown>
  assert.equal(result['protocolVersion'], '2025-06-18')
})

test('通知不回应：notifications/initialized 与没有 id 的请求都不该有输出', async () => {
  const { callApi } = stubApi()
  const server = createMcpServer({ callApi })

  assert.equal(
    await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    null
  )
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'ping' }), null)
  assert.equal(await server.handleMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}'), null)
})

test('ping 回应一个空结果', async () => {
  const { callApi } = stubApi()
  const server = createMcpServer({ callApi })
  const res = (await server.handle({ jsonrpc: '2.0', id: 7, method: 'ping' })) as JsonRpcResponse
  assert.deepEqual(res.result, {})
})

test('未知方法回 -32601；非法请求回 -32600；坏 JSON 回 -32700', async () => {
  const { callApi } = stubApi()
  const server = createMcpServer({ callApi })

  const unknown = (await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'resources/list'
  })) as JsonRpcResponse
  assert.equal(unknown.error?.code, -32601)

  const invalid = (await server.handle({ id: 2, method: 'ping' })) as JsonRpcResponse
  assert.equal(invalid.error?.code, -32600)

  const parseFailed = await server.handleMessage('{ 这不是 json')
  assert.ok(parseFailed !== null)
  assert.equal((JSON.parse(parseFailed) as JsonRpcResponse).error?.code, -32700)
})

test('handleMessage 把响应序列化回一行 JSON', async () => {
  const { callApi } = stubApi()
  const server = createMcpServer({ callApi })
  const text = await server.handleMessage('{"jsonrpc":"2.0","id":9,"method":"ping"}')
  assert.ok(text !== null)
  assert.ok(!text.includes('\n'), '响应必须是单行（stdio 传输一行一条消息）')
  const parsed = JSON.parse(text) as JsonRpcResponse
  assert.equal(parsed.id, 9)
})

/* ────────────────────────────── tools/list ────────────────────────────── */

test('tools/list：工具名齐全，每个都有描述与输入 schema', async () => {
  const { callApi } = stubApi()
  const server = createMcpServer({ callApi })

  const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as JsonRpcResponse
  const result = res.result as { tools: Array<Record<string, unknown>> }
  const names = result.tools.map((tool) => tool['name'])

  for (const expected of EXPECTED_TOOLS) {
    assert.ok(names.includes(expected), `tools/list 里少了 ${expected}`)
  }
  assert.equal(names.length, EXPECTED_TOOLS.length, '不该有多余的工具')

  for (const tool of result.tools) {
    assert.equal(typeof tool['description'], 'string')
    assert.ok((tool['description'] as string).length > 0, `${String(tool['name'])} 缺少描述`)
    const schema = tool['inputSchema'] as Record<string, unknown>
    assert.equal(schema['type'], 'object', `${String(tool['name'])} 的输入 schema 必须是 object`)
    assert.ok(schema['properties'] !== undefined, `${String(tool['name'])} 缺少 properties`)
  }
})

test('tools/list 分页：每页给的游标能接着翻，且翻完不多不少', async () => {
  const { callApi } = stubApi()
  const server = createMcpServer({ callApi, pageSize: 5 })

  const seen: string[] = []
  let cursor: string | undefined
  for (let guard = 0; guard < 10; guard += 1) {
    const res = (await server.handle({
      jsonrpc: '2.0',
      id: guard,
      method: 'tools/list',
      params: cursor === undefined ? {} : { cursor }
    })) as JsonRpcResponse
    const result = res.result as { tools: Array<Record<string, unknown>>; nextCursor?: string }
    for (const tool of result.tools) seen.push(tool['name'] as string)
    cursor = result.nextCursor
    if (cursor === undefined) break
  }

  assert.deepEqual(seen, EXPECTED_TOOLS, '分页翻完必须正好是全部工具，不重不漏')
})

test('act 的描述里必须写明动作跑在真实浏览器里、且要人确认', async () => {
  const { callApi } = stubApi()
  const server = createMcpServer({ callApi })
  const tools = server.listTools()
  const act = tools.find((tool) => tool.name === 'act')
  assert.ok(act !== undefined)
  assert.match(act.description, /真实浏览器/)
  assert.match(act.description, /确认/)
})

test('act 的输入 schema 里没有 confirm 之类的参数：授权不能由调用方声明', async () => {
  const { callApi } = stubApi()
  const server = createMcpServer({ callApi })
  const act = server.listTools().find((tool) => tool.name === 'act')
  assert.ok(act !== undefined)
  const schema = act.inputSchema as { properties: Record<string, unknown> }
  assert.deepEqual(Object.keys(schema.properties).sort(), ['action', 'profileId'])
  const action = schema.properties['action'] as { properties: Record<string, unknown> }
  assert.ok(!('confirm' in action.properties), 'act 不该接受 confirm')
})

/* ────────────────────────────── tools/call ────────────────────────────── */

test('list_profiles：只往外发 id / 名称 / 分组 / 状态 / 平台', async () => {
  const { callApi } = stubApi(() => [
    {
      id: 'prf_1',
      name: '商店一号',
      group: '电商',
      status: 'running',
      platform: 'windows',
      seedHint: 'abcd1234',
      fingerprint: { userAgent: 'x' },
      proxy: { username: 'u', password: 'p' }
    }
  ])
  const server = createMcpServer({ callApi })

  const res = (await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'list_profiles', arguments: {} }
  })) as JsonRpcResponse

  const result = res.result as McpToolResult
  assert.notEqual(result.isError, true)
  const payload = result.structuredContent as { profiles: Array<Record<string, unknown>> }
  assert.equal(payload.profiles.length, 1)
  assert.deepEqual(Object.keys(payload.profiles[0] ?? {}).sort(), [
    'group',
    'id',
    'name',
    'platform',
    'status'
  ])
})

test('act：打到 /act 且请求体里只有 action，不带任何「已确认」标记', async () => {
  const { callApi, calls } = stubApi(() => ({ ok: true, message: '已执行' }))
  const server = createMcpServer({ callApi })

  await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'act',
      arguments: { profileId: 'prf_1', action: { type: 'click', id: 'e3' }, confirm: true }
    }
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.method, 'POST')
  assert.equal(calls[0]?.path, '/v1/profiles/prf_1/act')
  const body = calls[0]?.body as Record<string, unknown>
  assert.deepEqual(Object.keys(body), ['action'])
  assert.deepEqual(body['action'], { type: 'click', id: 'e3' })
})

test('act：同意被拒绝时，错误原样带出去，且带 isError', async () => {
  const { callApi } = stubApi(() => {
    throw new Error('这是一个不可逆动作，需要有人在应用窗口上点「允许执行」才能继续。')
  })
  const server = createMcpServer({ callApi })

  const res = (await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'act', arguments: { profileId: 'prf_1', action: { type: 'click', id: 'e3' } } }
  })) as JsonRpcResponse

  const result = res.result as McpToolResult
  assert.equal(result.isError, true)
  assert.match(result.content[0]?.text ?? '', /允许执行/)
  assert.equal(res.error, undefined, '工具执行失败不是协议错误')
})

test('没有这个工具回 -32602（协议错误），与工具执行失败区分开', async () => {
  const { callApi } = stubApi()
  const server = createMcpServer({ callApi })

  const res = (await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: '不存在的工具', arguments: {} }
  })) as JsonRpcResponse

  assert.equal(res.error?.code, -32602)
  assert.equal(res.result, undefined)
})

test('缺参数要报错，而不是用默认值蒙混过去', async () => {
  const { callApi } = stubApi()
  const server = createMcpServer({ callApi })

  const res = (await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'snapshot_profile', arguments: {} }
  })) as JsonRpcResponse

  const result = res.result as McpToolResult
  assert.equal(result.isError, true)
  assert.match(result.content[0]?.text ?? '', /profileId/)
})

/* ────────────────────────────── 与协议层的同步 ────────────────────────────── */

test('动作类型清单不得与 shared/protocol.ts 漂移', () => {
  // MCP 服务器不能 import '@shared/protocol' 的运行期值（纯 Node 解析不了这个别名），
  // 所以它自己写了一份清单。这份清单一旦漂移，agent 就会拿到一个应用根本不认的动作类型 ——
  // 表现是「接口说有这个动作，调用就 400」。所以这里读源码把两边钉在一起。
  const protocol = readFileSync(join(ROOT, 'src/shared/protocol.ts'), 'utf8')
  const union = /export type ActionType =([\s\S]*?)\n\n/.exec(protocol)
  assert.ok(union !== null, '找不到 protocol.ts 里的 ActionType 联合类型')
  const protocolTypes = [...(union[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort()

  const server = readFileSync(join(ROOT, 'src/main/modules/mcp-server.ts'), 'utf8')
  const list = /const ACTION_TYPES = \[([\s\S]*?)\]/.exec(server)
  assert.ok(list !== null, '找不到 mcp-server.ts 里的 ACTION_TYPES')
  const serverTypes = [...(list[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort()

  assert.deepEqual(serverTypes, protocolTypes, 'MCP 服务器的动作类型清单与协议层漂移了')
})

/* ────────────────────────────── stdio 输入上限 ────────────────────────────── */

test('stdio 超长行必须回合法错误，不能让客户端一直等', async () => {
  const { PassThrough } = await import('node:stream')
  const input = new PassThrough()
  const output = new PassThrough()
  const chunks: string[] = []
  output.setEncoding('utf8')
  output.on('data', (s: string) => chunks.push(s))

  // 没有 API caller：本条只测输入层，不该碰到它
  const server = createMcpServer(async () => {
    throw new Error('不该被调用')
  })
  runStdio(server, input, output)

  // 4MB 上限之上随便造一行（远小于真正危险的尺寸，但足够触发判定）
  const huge = 'x'.repeat(5 * 1024 * 1024)
  input.write(huge + '\n')
  // 等一个 event loop 回合让 readline 的 'line' 事件与 promise 链跑完
  await new Promise<void>((resolve) => setTimeout(resolve, 50))

  assert.equal(chunks.length, 1, '超限行必须回一条响应，不能不回让客户端一直等')
  const res = JSON.parse(chunks[0]) as JsonRpcResponse & { error?: { code: number } }
  assert.equal(res.error?.code, -32602, '超限属于参数错误，不是内部错误')
  assert.match(String(res.error?.message ?? ''), /请求过长/)
})
