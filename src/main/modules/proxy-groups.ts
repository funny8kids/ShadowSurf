/**
 * 代理组：一组出口，按策略给环境轮换，并在选中出口失败时故障转移。
 *
 * ── 为什么不退回直连 ──
 * 这是本模块最重要的安全语义。环境一旦挂了代理组，用户要的就是「从这个池子
 * 的某个出口出去」。池子全挂时如果把 proxy 清成 null，Chromium 就会用本机真实
 * IP —— 那些账号此前积累的地理位置 / 登录态会在这一刻全部对不上，而且界面上
 * 看起来只是「环境起得慢了一点」。所以失败时直接抛错，让环境起不来。
 * 起不来是可行动的（去修代理），静默泄漏是不可行动的。
 *
 * ── 为什么解析结果不落盘 ──
 * profile.proxy 是用户显式挂的单条代理；proxyGroupId 才是指向池子的引用。
 * 每次启动都重新解析一次，结果只用于这次 session。如果把解析结果写回
 * profile.proxy，「轮换」就变成「第一次解析出的那条永远不变」。
 *
 * ── 为什么节点不 import windows.ts ──
 * resolveForProfile 由组合根注入 WindowManager，避免 core ↔ modules 成环；
 * windows.ts 也要能被纯 electron 探针单独加载。
 */

import { CH } from '@shared/ipc'
import type {
  ProxyConfig,
  ProxyGroup,
  ProxyGroupStrategy,
  ProxyRecord,
  StoredProfile
} from '@shared/types'
import { CollectionStore } from '@main/store'
import { appendAudit } from './audit'
import type { ModuleContext } from './context'
import { probeProxy } from './proxy'
import {
  candidateOrder,
  isStrategy,
  nextCursor,
  normalizeProxyIds
} from './proxy-group-policy'

function asId(value: unknown, field = 'id'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`参数「${field}」必须是非空字符串`)
  }
  return value.trim()
}

function asName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('参数「name」必须是字符串')
  const name = value.trim()
  if (name === '') throw new Error('代理组名称不能为空')
  if (name.length > 60) throw new Error('代理组名称不能超过 60 个字符')
  return name
}

function asStrategy(value: unknown): ProxyGroupStrategy {
  if (!isStrategy(value)) {
    throw new Error('轮换策略必须是 round-robin / random / sticky')
  }
  return value
}

function asProxyIds(value: unknown): string[] {
  return normalizeProxyIds(value)
}

function proxyOf(record: ProxyRecord): ProxyConfig {
  return {
    type: record.protocol,
    host: record.host,
    port: record.port,
    ...(record.username ? { username: record.username } : {}),
    ...(record.password ? { password: record.password } : {})
  }
}

/**
 * 轮换游标：groupId → 下次该用的下标。
 *
 * 只存在进程内，不落盘：这是调度状态，不是配置。重启后从 0 重新开始是可以的
 * （甚至更好 —— 不会把「上次停在哪个出口」当成需要持久化的事实）。
 */
const cursors = new Map<string, number>()

/**
 * 为一个环境解析出本次要用的代理。
 *
 * 返回覆盖后的 profile（只改 proxy），调用方把它用于 session 配置，不要落盘。
 */
export async function resolveForProfile(
  profile: StoredProfile,
  stores: ModuleContext['stores']
): Promise<StoredProfile> {
  const groupId = profile.proxyGroupId
  if (!groupId) return profile

  const group = stores.proxyGroups.get(groupId)
  if (group === null) {
    throw new Error(`代理组不存在（${groupId}），请到代理页重新选择出口`)
  }

  const records = group.proxyIds
    .map((id) => stores.proxies.get(id))
    .filter((r): r is ProxyRecord => r !== null)
  if (records.length === 0) {
    throw new Error(`代理组「${group.name}」没有可用出口，环境未启动（不会退回直连）`)
  }

  // 先按策略排出候选顺序，再逐条探测。探测走 proxy.ts 的同一条链路
  // （socks5 握手 / HTTP CONNECT），不另写一套。
  const cursor = cursors.get(group.id) ?? 0
  const ordered = candidateOrder(group.strategy, records, cursor, Math.random())
  cursors.set(group.id, nextCursor(group.strategy, cursor, records.length))
  if (ordered.length === 0) {
    throw new Error(`代理组「${group.name}」无法选出出口`)
  }

  for (let i = 0; i < ordered.length; i += 1) {
    const candidate = ordered[i]
    const check =
      candidate.lastCheck && Date.now() - candidate.lastCheck.at < 5 * 60_000
        ? candidate.lastCheck
        : await probeProxy(candidate)
    if (check.ok) {
      // 探测成功的结果写回记录，供面板显示与下次复用（5 分钟缓存）
      if (check !== candidate.lastCheck) {
        stores.proxies.update(candidate.id, { lastCheck: check })
      }
      if (i > 0) {
        appendAudit(
          stores,
          '代理组·故障转移',
          `环境 ${profile.name}`,
          `组「${group.name}」的第 ${i + 1} 条出口「${candidate.name}」接管`
        )
      }
      // 只返回覆盖后的 profile；**不写回 profile.proxy**。
      return { ...profile, proxy: proxyOf(candidate) }
    }
  }

  // 全都不通：明确失败，绝不退回直连
  appendAudit(
    stores,
    '代理组·启动失败',
    `环境 ${profile.name}`,
    `组「${group.name}」的 ${String(ordered.length)} 条出口全部不可用，未退回直连`
  )
  throw new Error(`代理组「${group.name}」没有可用出口，环境未启动（不会退回直连）`)
}

/* ────────────────────────────── 注册 ────────────────────────────── */

export function registerProxyGroupsModule(ctx: ModuleContext): void {
  const groups = ctx.stores.proxyGroups

  ctx.handle(CH.proxies.groupList, () => groups.list())

  ctx.handle(CH.proxies.groupCreate, (_event, raw) => {
    const input = raw as Record<string, unknown>
    const proxyIds = asProxyIds(input.proxyIds)
    for (const id of proxyIds) {
      if (ctx.stores.proxies.get(id) === null) throw new Error('代理记录不存在：' + id)
    }
    const record: ProxyGroup = {
      id: CollectionStore.newId('pg'),
      name: asName(input.name),
      proxyIds,
      strategy: asStrategy(input.strategy ?? 'round-robin'),
      failover: input.failover === undefined ? true : Boolean(input.failover),
      createdAt: Date.now()
    }
    groups.add(record)
    appendAudit(ctx.stores, '代理组·新增', record.name, `${String(proxyIds.length)} 条出口`)
    return record
  })

  ctx.handle(CH.proxies.groupUpdate, (_event, rawId, rawPatch) => {
    const id = asId(rawId)
    const current = groups.get(id)
    if (!current) throw new Error('代理组不存在')
    const patch = rawPatch as Record<string, unknown>
    const next: Partial<ProxyGroup> = {}

    if (patch.name !== undefined) next.name = asName(patch.name)
    if (patch.proxyIds !== undefined) {
      next.proxyIds = asProxyIds(patch.proxyIds)
      for (const pid of next.proxyIds) {
        if (ctx.stores.proxies.get(pid) === null) throw new Error('代理记录不存在：' + pid)
      }
    }
    if (patch.strategy !== undefined) next.strategy = asStrategy(patch.strategy)
    if (patch.failover !== undefined) next.failover = Boolean(patch.failover)

    const updated = groups.update(id, next)
    appendAudit(ctx.stores, '代理组·更新', updated.name, '策略或成员变更')
    return updated
  })

  ctx.handle(CH.proxies.groupRemove, (_event, rawId) => {
    const id = asId(rawId)
    const group = groups.get(id)
    if (!group) throw new Error('代理组不存在')

    // 环境上的引用必须清掉：留着悬空 id 会让那些环境启动时报「组不存在」，
    // 不如在这里一次性清理并广播，让界面立刻回到「未配置代理」。
    const affected = ctx.stores.profiles.list().filter((p) => p.proxyGroupId === id)
    for (const p of affected) {
      ctx.stores.profiles.update(p.id, { proxyGroupId: null })
    }
    groups.remove(id)
    cursors.delete(id)
    appendAudit(
      ctx.stores,
      '代理组·删除',
      group.name,
      `同时清理 ${String(affected.length)} 个环境的引用`
    )
    ctx.broadcast(CH.push.profileState, ctx.stores.profiles.list())
  })
}
