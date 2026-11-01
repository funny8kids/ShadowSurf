/**
 * 审计哈希链的纯校验内核。
 *
 * 为什么单独成文件：这段判断必须能被 Node 直接单测，而 `modules/audit.ts` 静态
 * import 了 `@main/store`（→ `db.ts` → `electron`）和 `@main/core/cdp`，在纯 Node
 * 里连模块都求值不了。和 `store/json-file.ts` 保持零相对依赖是同一个理由：
 * **能被测到的规则才算规则**，否则它只是一段「看起来对」的实现。
 *
 * 这里只做两件事：算摘要、判断一条链（加一个日志外的锚点）是否完整。
 * 读盘、写锚点、要不要落盘都在 `audit.ts` 里 —— 那部分需要 Electron。
 *
 * 归属：audit-agent
 */

import { createHash } from 'node:crypto'

// 只做类型标注，运行时会被完全擦除 —— 这是本文件保持零依赖的前提
import type { AuditVerifyKind } from '@shared/types'

/** 链首的 prev 占位：64 个 0，长度与 sha256 的 hex 一致，校验时不必特判 */
export const ZERO_HASH = '0'.repeat(64)

/** 与 store/index.ts 里 audit 的 maxItems 保持一致，用来区分「正常裁剪」与「链头被删」 */
export const AUDIT_CAP = 5000

/** 校验只需要这几个字段，不必依赖完整的 AuditEntry（测试里手搓一条链更容易） */
export interface ChainEntry {
  seq: number
  at: number
  actor: string
  action: string
  target?: string
  detail?: string
  prev: string
  hash: string
}

/**
 * 尾部锚点：最后一条记录的序号与哈希。
 *
 * 它必须存在**日志文件外面**才有意义。记在日志里等于没记：把整份文件删掉之后，
 * 剩下的部分（包括「一条都没有」）依然完全自洽。
 */
export interface ChainHead {
  seq: number
  hash: string
}

export interface ChainVerdict {
  consistent: boolean
  total: number
  /** 第一条断链的位置，从 1 开始 */
  brokenAt?: number
  kind?: AuditVerifyKind
  message: string
  /**
   * 只在 `unanchored` 时给出：应当建立的锚点。
   *
   * 刻意不在内核里落盘 —— 这个文件要能纯函数地测。调用方拿到它之后自己写。
   */
  adoptHead?: ChainHead
}

/**
 * 为什么把字段拼成一个字符串再哈希，而不是对 JSON 哈希：
 * JSON 的键顺序、undefined 的处理都依赖实现，跨版本可能变；
 * 用固定的分隔符拼接，重算时只要顺序和空值归一规则一致就永远吻合。
 */
export function digest(
  prev: string,
  seq: number,
  at: number,
  actor: string,
  action: string,
  target: string,
  detail: string
): string {
  return createHash('sha256')
    .update([prev, seq, at, actor, action, target, detail].join('|'))
    .digest('hex')
}

/**
 * 校验一条链。
 *
 * 检查分两层，顺序不能反：
 *
 * 1. **链内**：序号连续、每条 prev 指向上一条 hash、每条 hash 能重算对上。
 *    这一层能发现「改了某条内容」「删了中间某条」「删了链首若干条」。
 * 2. **链外**：日志最后一条必须等于锚点。
 *    这一层能发现「删了尾部若干条」和「整份文件被删」——
 *    这两种情况下链内检查**一条都发现不了**，因为剩下的部分完全自洽。
 *
 * 第三层（整体重算）没有密钥就做不到，所以结论里必须写明这个边界，
 * 不能用「链路完整」这种全称说法。
 */
export function verifyChain(entries: ChainEntry[], head: ChainHead | null): ChainVerdict {
  if (entries.length === 0) {
    // 空链有两种含义，必须分开，不能都返回 ok：
    //   锚点也是空 → 确实还没写过任何记录（首次运行）
    //   锚点记着东西 → 整份日志被删了。这是唯一一种「删得越干净越安全」的形状。
    if (head === null) {
      return { consistent: true, total: 0, message: '还没有审计记录' }
    }
    return {
      consistent: false,
      total: 0,
      brokenAt: head.seq,
      kind: 'tail-truncated',
      message:
        `整份审计日志已被删除：链头锚点记着最后一条是第 ${head.seq} 条` +
        `（哈希 ${head.hash.slice(0, 8)}…），但日志文件里一条都没有`
    }
  }

  if (head === null) {
    // 升级上来的旧数据，或者 settings.json 被删。这两种在数据上无法区分，
    // 所以**不能报通过** —— 否则「删掉 settings.json」就成了一条绕过路径，
    // 而它和原来的「删掉 audit.json」一样省事。
    //
    // 这里给出应建立的锚点并明说：从这一刻起尾部可验证，之前的不行。
    const lastEntry = entries[entries.length - 1]
    return {
      consistent: false,
      total: entries.length,
      kind: 'unanchored',
      message:
        `链头锚点缺失，无法验证尾部是否被删：日志现有 ${entries.length} 条，` +
        `已按最后一条（第 ${lastEntry.seq} 条）建立锚点。` +
        '从下一次校验起尾部可验证；此前的记录只能验证「内部是否自洽」，无法证明没被删。',
      adoptHead: { seq: lastEntry.seq, hash: lastEntry.hash }
    }
  }

  // 存储有 5000 条上限，超出会从头丢最旧的。此时首条的 prev 指向已被裁掉的记录，
  // 若仍要求它等于全 0 就会在每次超限后误报断链，所以以首条自身作为锚点。
  // 但只有在「条数已顶到上限」时截断才合理；否则首条 seq 不为 1 就是有人删了链头。
  const truncated = entries[0].seq > 1 && entries.length >= AUDIT_CAP
  if (entries[0].seq > 1 && !truncated) {
    return {
      consistent: false,
      total: entries.length,
      brokenAt: entries[0].seq,
      kind: 'head-truncated',
      message: `链首缺失：第 1 条记录已不存在（当前最早为第 ${entries[0].seq} 条），链被截断或删除`
    }
  }
  let expectedPrev = truncated ? entries[0].prev : ZERO_HASH
  const startSeq = entries[0].seq

  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i]
    const where = `第 ${e.seq} 条`

    if (e.seq !== startSeq + i) {
      return {
        consistent: false,
        total: entries.length,
        brokenAt: e.seq,
        kind: 'seq-gap',
        message: `${where}记录的序号不连续，中间有记录被删除`
      }
    }
    if (e.prev !== expectedPrev) {
      return {
        consistent: false,
        total: entries.length,
        brokenAt: e.seq,
        kind: 'prev-mismatch',
        message: `${where}记录的 prev 与上一条哈希不符，前序内容被改动或删除`
      }
    }

    const recomputed = digest(e.prev, e.seq, e.at, e.actor, e.action, e.target ?? '', e.detail ?? '')
    if (recomputed !== e.hash) {
      return {
        consistent: false,
        total: entries.length,
        brokenAt: e.seq,
        kind: 'content-mismatch',
        message: `${where}记录的内容与哈希对不上，记录已被篡改`
      }
    }
    expectedPrev = e.hash
  }

  // 尾部锚点比对。上面整个循环只在日志**内部**做校验：删掉最后 k 条之后，
  // 剩下的 1..n-k 序号连续、prev 全对、每条 hash 都能重算对上 —— 循环一条都发现不了。
  const last = entries[entries.length - 1]
  if (last.seq !== head.seq || last.hash !== head.hash) {
    if (last.seq < head.seq) {
      return {
        consistent: false,
        total: entries.length,
        brokenAt: last.seq + 1,
        kind: 'tail-truncated',
        message:
          `尾部记录被删除：链头锚点记着最后一条是第 ${head.seq} 条，` +
          `日志只到第 ${last.seq} 条（少了 ${head.seq - last.seq} 条）`
      }
    }
    if (last.seq > head.seq) {
      return {
        consistent: false,
        total: entries.length,
        brokenAt: head.seq + 1,
        kind: 'tail-truncated',
        message:
          `链头锚点落后于日志：锚点停在第 ${head.seq} 条，日志已到第 ${last.seq} 条。` +
          '可能是上一次追加在写入记录之后、更新锚点之前中断（或 settings.json 当时不可写）；' +
          '下一次追加会自动对齐。'
      }
    }
    return {
      consistent: false,
      total: entries.length,
      brokenAt: last.seq,
      kind: 'tail-truncated',
      message: `最后一条与链头锚点不符：序号同为第 ${last.seq} 条，但哈希对不上 —— 它被替换或重算过`
    }
  }

  return {
    consistent: true,
    total: entries.length,
    // 「链路完整」这个说法必须去掉：digest 是无密钥 sha256，拿到算法就能把整条链
    // 从任意一条开始重算，算出完全自洽的 hash 与 prev。这里能挡的只有
    // 「改了内容但没重算」和「整份 / 尾部删除」，挡不住有意的整体重算。
    message: truncated
      ? `摘要无密钥，可被整体重算；尾部已与链头锚点核对；共 ${entries.length} 条（头部 ${startSeq - 1} 条已按上限裁剪）`
      : `摘要无密钥，可被整体重算；尾部已与链头锚点核对；共 ${entries.length} 条`
  }
}
