/**
 * 代理组轮换的纯规则。
 *
 * 只回答「给一组出口和策略，这次选哪一条、坏了按什么顺序试下一条」，
 * 不碰 IPC / store / 网络（探测在 proxy-groups.ts 里），
 * 所以能被 node:test 直接覆盖。
 *
 * ── 为什么规则与探测分开 ──
 * 「选谁」是确定性的、可以穷举的；「通不通」取决于网络。混在一起的话，
 * 测试就要架代理服务才能验证轮询顺序 —— 那不是单测该做的事。
 */

import type { ProxyGroup, ProxyGroupStrategy, ProxyRecord } from '@shared/types'

/**
 * 按策略给出本次的候选顺序（第一条 = 首选，后面是故障转移顺序）。
 *
 * `cursor` 是 round-robin 的上次位置；`randomAt` 是外部注入的随机数（0 ≤ x < 1），
 * 让 random 策略也能被确定性测试。
 */
export function candidateOrder(
  strategy: ProxyGroupStrategy,
  records: ProxyRecord[],
  cursor = 0,
  randomAt = 0
): ProxyRecord[] {
  if (records.length === 0) return []

  if (strategy === 'random') {
    const first = records[Math.min(records.length - 1, Math.floor(randomAt * records.length))]
    return [first, ...records.filter((r) => r.id !== first.id)]
  }

  if (strategy === 'sticky') {
    // 粘性：永远从第一条开始，只有它坏了才顺次往下
    return [...records]
  }

  // round-robin：从上次位置的下一条开始，环形排列
  const start = ((cursor % records.length) + records.length) % records.length
  return [...records.slice(start), ...records.slice(0, start)]
}

/** 下一次 round-robin 游标（不落盘，进程内存即可） */
export function nextCursor(strategy: ProxyGroupStrategy, cursor: number, length: number): number {
  if (strategy !== 'round-robin' || length <= 0) return cursor
  return (cursor + 1) % length
}

/** 组内的代理 id 必须存在且顺序稳定；重复的 id 只保留第一次 */
export function normalizeProxyIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('proxyIds 必须是数组')
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('proxyIds 必须是字符串数组')
    const id = item.trim()
    // 表单里未选中的空值直接跳过（与 cleanExtensionIds 同一口径）；
    // 但整组全是空时下面会得到 []，调用方据此报「至少选一条」。
    if (id === '') continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export function isStrategy(value: unknown): value is ProxyGroupStrategy {
  return value === 'round-robin' || value === 'random' || value === 'sticky'
}

/** 组是否有效（至少有 1 条出口） */
export function isGroupUsable(group: ProxyGroup): boolean {
  return Array.isArray(group.proxyIds) && group.proxyIds.length > 0
}
