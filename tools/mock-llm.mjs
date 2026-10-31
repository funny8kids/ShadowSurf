/**
 * 本地 mock 模型服务。
 *
 * 目的：在没有真实 API Key 的情况下，把 Agent 循环完整跑一遍——
 * 快照 → 决策 → 风险判定 → 执行 → 再快照 → 收尾。
 *
 * 它只实现 OpenAI 兼容协议里用得到的那一小块：
 * POST /v1/chat/completions → { choices: [{ message: { content } }] }
 *
 * 用法：node tools/mock-llm.mjs [port]
 * 然后把面板里的 Base URL 填 http://127.0.0.1:9977/v1，模型名随意。
 */

import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? 9977)

/** 按调用次数返回预设动作，模拟一个「先跳转、再收尾」的极简任务 */
const SCRIPT = [
  {
    plan: '打开示例页，读出标题',
    thought: '当前页是 Bing，先导航到 example.com 再读取。',
    action: { type: 'navigate', url: 'https://example.com' }
  },
  {
    plan: '打开示例页，读出标题',
    thought: '页面已经跳转完成，标题可以从快照的 title 字段直接拿到。',
    action: {
      type: 'done',
      summary: '页面标题是 Example Domain，正文说明了该域名用于文档示例。',
      data: { title: 'Example Domain', url: 'https://example.com' }
    }
  }
]

let calls = 0

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors()).end()
    return
  }

  if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}')
    return
  }

  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let parsed = {}
    try {
      parsed = JSON.parse(body)
    } catch {
      /* 忽略：mock 不校验请求体 */
    }

    const step = SCRIPT[Math.min(calls, SCRIPT.length - 1)]
    calls += 1

    // 从 user 消息里抓一下当前 URL，回显在 thought 里，方便肉眼确认「模型看到了什么」
    const userMsg = parsed.messages?.find((m) => m.role === 'user')?.content ?? ''
    const urlMatch = /url="([^"]+)"/.exec(userMsg)
    const seenUrl = urlMatch ? urlMatch[1] : '未知'

    console.log(`[mock] #${calls} 看到页面 ${seenUrl} → ${step.action.type}`)

    const payload = {
      id: `chatcmpl-mock-${calls}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-agent',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: JSON.stringify(step) },
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 800, completion_tokens: 60, total_tokens: 860 }
    }

    res.writeHead(200, { 'content-type': 'application/json', ...cors() }).end(JSON.stringify(payload))
  })
})

function cors() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'POST, OPTIONS'
  }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] OpenAI 兼容服务已启动：http://127.0.0.1:${PORT}/v1`)
  console.log(`[mock] 共 ${SCRIPT.length} 步预设动作，调用超过后重复最后一步`)
})
