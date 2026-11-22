/**
 * Webhook：把任务 / 定时执行的结果投递到用户自己的系统。
 *
 * ── 边界 ──
 * 1. **只从本机发出**：没有中转服务器、没有云端队列，载荷不经过本项目任何服务。
 *    这与「零遥测」并不矛盾 —— 目标是用户自己填的地址，由用户决定是否接收。
 * 2. **不重试**：Webhook 失败很常见（目标临时下线），但重试会把「一次任务完成」
 *    变成「N 次重复的副作用」。失败只写审计，用户可在审计页看到。
 * 3. **不阻塞主流程**：投递是 fire-and-forget（catch 后记日志），无论目标多慢，
 *    都不会让任务结束变慢，更不会因为目标不可达让定时任务失败。
 * 4. **只允许 http/https**：file:// 与其它协议会被拒绝，避免被当成读取本机文件的原语。
 *
 * ── payload ──
 * 固定形状 { event, at, data }，不含 seed、Cookie、令牌等任何身份材料。
 * 外部系统拿到的是「ShadowSurf 上发生了一件事」，不是「ShadowSurf 的身份」。
 */

import { CH } from '@shared/ipc'
import type { WebhookEvent, WebhookRecord, WebhookTestResult } from '@shared/types'
import { CollectionStore } from '@main/store'
import { appendAudit } from './audit'
import { MAX_REDIRECTS, assertDeliverableTarget } from './webhook-target'
import type { ModuleContext } from './context'

const ALL_EVENTS: readonly WebhookEvent[] = ['task.done', 'task.failed', 'schedule.done']
const TIMEOUT_MS = 8_000

function asUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('参数「url」必须是字符串')
  const url = value.trim()
  if (url === '') throw new Error('回调地址不能为空')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('回调地址不是合法的 URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('回调地址必须是 http 或 https')
  }
  return url
}

function asEvents(value: unknown): WebhookEvent[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('参数「events」必须是数组')
  const out: WebhookEvent[] = []
  for (const item of value) {
    const e = String(item)
    if (!ALL_EVENTS.includes(e as WebhookEvent)) throw new Error('不支持的事件：' + e)
    if (!out.includes(e as WebhookEvent)) out.push(e as WebhookEvent)
  }
  return out
}

/**
 * 投递一次。
 *
 * ── 三处与"直接 fetch"不同的地方 ──
 * 1. **投递前校验目标**：主进程发出的请求绕开了浏览器的 CORS / PNA / 代理策略，
 *    能打到只对本机开放的管理接口（Docker 2375、各类 admin API），
 *    也能打到云主机的元数据服务（169.254.169.254）去换 IAM 凭据。
 *    所以目标不能是回环 / 私网 / 链路本地地址（域名要解析后逐个查）。
 * 2. **重定向不自动跟随**：跟的话，逐跳重新校验目标 ——
 *    「一个公网地址 302 到内网」这条路径必须堵住。
 * 3. 重定向最多跟 MAX_REDIRECTS 跳，避免绕圈。
 */
async function deliver(
  url: string,
  payload: unknown,
  allowInternal: boolean
): Promise<WebhookTestResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertDeliverableTarget(current, allowInternal)
      const res = await fetch(current, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'ShadowSurf-Webhook/0.1'
        },
        body: JSON.stringify(payload),
        // 自己处理重定向：每跳都要重新校验目标
        redirect: 'manual',
        signal: controller.signal
      })
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (location === null) {
          return { ok: false, status: res.status, error: '目标返回重定向，但没有 Location 头' }
        }
        try {
          current = new URL(location, current).toString()
        } catch {
          return { ok: false, status: res.status, error: '目标的重定向地址不合法' }
        }
        continue
      }
      return { ok: res.ok, status: res.status }
    }
    return { ok: false, status: 0, error: `重定向次数超过 ${String(MAX_REDIRECTS)} 跳` }
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

/** 对外：一次事件广播。不抛错、不重试。 */
export async function emitWebhook(
  stores: ModuleContext['stores'],
  event: WebhookEvent,
  data: Record<string, unknown>
): Promise<void> {
  let hooks: WebhookRecord[]
  try {
    hooks = stores.webhooks.list().filter((h) => h.enabled)
  } catch {
    // 读失败不能拖住任务结束。Webhook 是通知，不是主流程。
    return
  }

  const payload = { event, at: Date.now(), data }
  for (const hook of hooks) {
    // 空数组 = 订阅全部
    if (hook.events.length > 0 && !hook.events.includes(event)) continue
    const result = await deliver(hook.url, payload, hook.allowInternal === true)
    try {
      appendAudit(
        stores,
        'Webhook·投递',
        hook.url,
        `${event} → HTTP ${String(result.status)}${result.ok ? '' : '（未重试）'}`
      )
    } catch {
      /* 审计失败不影响下一次投递 */
    }
  }
}

export function registerWebhooksModule(ctx: ModuleContext): void {
  const hooks = ctx.stores.webhooks

  ctx.handle(CH.webhooks.list, () => hooks.list())

  ctx.handle(CH.webhooks.create, (_event, raw) => {
    const input = raw as Record<string, unknown>
    const record: WebhookRecord = {
      id: CollectionStore.newId('wh'),
      url: asUrl(input.url),
      events: asEvents(input.events),
      enabled: input.enabled === undefined ? true : Boolean(input.enabled),
      // 默认**不允许**投递到内网：主进程发出的请求能打到本机管理接口
      // 与云元数据服务，这是防"被攻破的渲染层把本机变成跳板"，不是防用户误操作。
      allowInternal: input.allowInternal === true,
      createdAt: Date.now()
    }
    hooks.add(record)
    appendAudit(ctx.stores, 'Webhook·新增', record.url, record.events.join(',') || '全部事件')
    return record
  })

  ctx.handle(CH.webhooks.update, (_event, rawId, rawPatch) => {
    const id = String(rawId)
    const current = hooks.get(id)
    if (!current) throw new Error('Webhook 不存在')
    const patch = rawPatch as Record<string, unknown>
    const next: Partial<WebhookRecord> = {}
    if (patch.url !== undefined) next.url = asUrl(patch.url)
    if (patch.events !== undefined) next.events = asEvents(patch.events)
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled)
    if (patch.allowInternal !== undefined) next.allowInternal = patch.allowInternal === true
    const updated = hooks.update(id, next)
    appendAudit(ctx.stores, 'Webhook·更新', updated.url, '配置变更')
    return updated
  })

  ctx.handle(CH.webhooks.remove, (_event, rawId) => {
    const id = String(rawId)
    const record = hooks.get(id)
    if (!record) throw new Error('Webhook 不存在')
    hooks.remove(id)
    appendAudit(ctx.stores, 'Webhook·删除', record.url, '')
  })

  ctx.handle(CH.webhooks.test, async (_event, rawId): Promise<WebhookTestResult> => {
    const id = String(rawId)
    const record = hooks.get(id)
    if (!record) throw new Error('Webhook 不存在')
    const result = await deliver(
      record.url,
      {
        event: 'task.done',
        at: Date.now(),
        data: { test: true, message: 'ShadowSurf Webhook test' }
      },
      record.allowInternal === true
    )
    appendAudit(
      ctx.stores,
      'Webhook·测试',
      record.url,
      `HTTP ${String(result.status)}${result.error ? '：' + result.error : ''}`
    )
    return result
  })
}
