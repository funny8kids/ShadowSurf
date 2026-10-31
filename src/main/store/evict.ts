/**
 * 容量裁剪。
 *
 * 单独成文件、零依赖，是为了能被直接单测：`collection.ts` 会 import `./db`，
 * 而 `db.ts` 依赖 `electron`，在 Node 里跑不起来。裁剪规则本身是纯数组操作，
 * 不该被存储层的依赖拖住。
 */

export interface Evictable {
  id: string
}

/**
 * 就地裁剪到 `maxItems` 条：从头部（最旧）开始丢，`retain` 命中的跳过。
 *
 * 为什么不是 `splice(0, n)` 一把切：审计日志里混着两类记录，普通动作流水和
 * 闸门判定。后者是「谁批准了这笔支付」的唯一证据，被一次高频自动化挤出窗口
 * 之后，`verifyChain` 只会看到链头 prev 指向已裁掉的记录，判定为正常裁剪放行 ——
 * 也就是这个缺口不会让任何门禁变红。
 *
 * 兜底：整段都是受保护记录时仍然服从上限，退化成「丢最旧的」。宁可丢一条闸门
 * 记录，也不能让文件无限长 —— 磁盘写满会让应用先挂掉，那时候连丢了什么都查不出来。
 * 正常走不到这条：5000 条全是闸门记录意味着每一步都是不可逆动作。
 */
export function evictInPlace<T extends Evictable>(
  draft: T[],
  maxItems: number,
  retain?: (item: T) => boolean
): void {
  if (maxItems <= 0) return
  const overflow = draft.length - maxItems
  if (overflow <= 0) return

  let removed = 0
  let i = 0
  while (removed < overflow && i < draft.length) {
    if (retain !== undefined && retain(draft[i])) {
      i += 1
      continue
    }
    draft.splice(i, 1)
    removed += 1
    // splice 之后同一位置换成了下一个元素，i 不前进
  }

  if (draft.length > maxItems) {
    draft.splice(0, draft.length - maxItems)
  }
}
