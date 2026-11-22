/**
 * 同意之后、执行之前的**目标重新定位**。
 *
 * ── 要防的是什么 ──
 * 系统的确认窗口最多等 120 秒。这段时间里：
 *   1. 页面可以把那个按钮换掉（"加入购物车" → "立即支付"）；
 *   2. 任何一次新的快照都会**重新分配元素编号** —— 编号是按快照里的
 *      位置给的（e1..eN），页面上下多一个横幅，后面所有元素的编号都往后挪一位。
 *
 * 而风险等级、确认框文案（「点击『立即支付』」）都是用**旧快照**算的，
 * 执行器里的编号校验也只对着旧快照 —— 于是会出现：
 *
 *     **用户批准的是 A，系统点的是 B。**
 *
 * 这不是理论风险：本地 API 自己就暴露了快照与动作两个端点，
 * 同一个环境上的并发调用会让编号漂移；页面自己的 DOM 变化更是随时发生
 * （购物车角标更新、列表重排、弹层插入）。
 *
 * ── 怎么修 ──
 * 参照脚本回放已经做对的那条路（`modules/scripts.ts` 的 resolveElement）：
 * **重新采一帧，按元素的可读名重新定位**，然后用新快照里的编号执行。
 *
 * 名变了就是"目标变了" —— 宁可中止让模型/调用方重来，
 * 也绝不沿用旧编号点下去。**宁可误拦，不可误点。**
 */

import type { Action, PageSnapshot, SnapshotElement } from '@shared/protocol'
import { findElement } from '@shared/protocol'
import type { CdpBridge } from '@main/core/cdp'
import { captureSnapshot } from './snapshot'

export interface RetargetOutcome {
  /** 复核通过：可以执行（action 里的编号已换成新快照的） */
  ok: boolean
  /** 复核用的新快照（无论成不成都返回最新那一帧） */
  snapshot: PageSnapshot
  /** 复核通过时的动作；不通过时原样返回 */
  action: Action
  /** 不通过时的原因（一句话说清发生了什么） */
  reason?: string
}

/**
 * 两个元素是不是"同一个"。
 *
 * 只比**可读名 + 标签 + 角色**：这三样合起来才是用户眼里的那个按钮。
 * 位置（box）不算 —— 页面滚动、布局微调都会动它，
 * 而用户批准的是"那个叫『立即支付』的按钮"，不是"那个坐标"。
 */
function sameIdentity(a: SnapshotElement, b: SnapshotElement): boolean {
  return a.name === b.name && a.tag === b.tag && a.role === b.role
}

/**
 * 重新采集并重新定位目标。
 *
 * 只在**拿到了用户同意票之后**调用 —— 那之后才有"用户批准的是哪一个元素"
 * 这件事需要保护。L1 动作从快照到执行只有毫秒级间隔，不值得多一次 CDP 往返。
 */
export async function retargetApprovedAction(
  cdp: CdpBridge,
  action: Action,
  approved: PageSnapshot
): Promise<RetargetOutcome> {
  const fresh = await captureSnapshot(cdp)

  // 没有元素编号的动作（navigate / scroll / extract / done）不涉及"点哪个元素"
  if (action.id === undefined || action.id === '') {
    return { ok: true, snapshot: fresh, action }
  }

  const old = findElement(approved, action.id)
  if (old === undefined) {
    return {
      ok: false,
      snapshot: fresh,
      action,
      reason: '批准时那个元素已经不在当轮快照里了'
    }
  }

  const candidates = fresh.elements.filter((el) => sameIdentity(el, old))
  if (candidates.length === 0) {
    return {
      ok: false,
      snapshot: fresh,
      action,
      reason:
        old.name === ''
          ? '目标元素已从页面上消失'
          : `目标已变化：批准时是「${old.name}」，现在页面上找不到它了`
    }
  }
  if (candidates.length > 1) {
    // 同名同标签同角色的候选不止一个：无法确定是哪一个。
    // 这里**不猜** —— 猜错元素比找不到更糟（脚本回放那边也是同一个原则）。
    return {
      ok: false,
      snapshot: fresh,
      action,
      reason: `页面上有 ${candidates.length} 个同名同类型的元素，无法确定是哪一个`
    }
  }

  return { ok: true, snapshot: fresh, action: { ...action, id: candidates[0].id } }
}
