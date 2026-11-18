/**
 * 环境回收站：软删除之后的「恢复 / 彻底删除」两个动作，以及回收站列表。
 *
 * 记录层的软删除由 `ProfileStore.softRemove()` 负责；本模块只做编排：
 *   - trash   ：读 `listTrash()`（public 形态，不含 seed）
 *   - restore ：清 `deletedAt` → 审计 → 广播
 *   - purge   ：尽力清分区 → 删记录 → 审计 → 广播
 *
 * 为什么清分区放在这里而不是 store 里：`clearProfileData` 依赖 `electron.session`
 * 和分区目录，store 必须保持「无 Electron 也能单测」。职责分离见 `purge()` 的注释。
 */

import { CH } from '@shared/ipc'
import { clearProfileData, partitionFor } from '@main/core/session'
import { appendAudit } from './audit'
import type { ModuleContext } from './context'

/**
 * id 入参校验。
 *
 * 渲染层发来的是裸 JSON：`undefined` / `null` / `''` / 数字都可能出现。
 * 不在这里拦，`getStored(undefined)` 只会报一句「环境不存在」，
 * 而真实原因是入参形状错了 —— 那种错误信息会把人带到错的方向。
 */
function requireProfileId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('环境 id 必须是非空字符串')
  }
  return raw.trim()
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function registerTrashModule(ctx: ModuleContext): void {
  ctx.handle(CH.profiles.trash, () => ctx.stores.profiles.listTrash())

  ctx.handle(CH.profiles.restore, (_event, rawId) => {
    const id = requireProfileId(rawId)
    const profile = ctx.stores.profiles.restore(id)

    // 恢复**不碰分区**：软删除期间记录和分区都没动过，恢复只是把可见性还回去。
    // 在这里清一次分区等于「恢复 = 丢登录态」，那正是用户在回收站里点恢复时
    // 最不希望发生的事。真正的清理只在 purge 路径上做。
    appendAudit(
      ctx.stores,
      '环境·恢复',
      `环境 ${profile.name}（${id}）`,
      `从回收站恢复；${partitionFor(id)} 分区原样保留（Cookie / localStorage / IndexedDB 未清理）`
    )

    // 直接调 store 不会触发 handlers.ts 里 profiles.* 那条广播路径，
    // 所以这里自己推一次：环境卡片和回收站列表都要立刻看到状态变化。
    ctx.broadcast(CH.push.profileState, ctx.stores.profiles.list())
    return profile
  })

  ctx.handle(CH.profiles.purge, async (_event, rawId) => {
    const id = requireProfileId(rawId)

    // 先读一次：purge 之后 store 里就查不到这个名字了，而清理失败的告警和
    // 审计都需要它。记录是「这个分区属于谁」的唯一线索，必须在删之前拿到。
    const profile = ctx.stores.profiles.get(id)
    if (profile === null) throw new Error('环境不存在：' + id)

    /*
     * 顺序：**先清分区，再删记录**。
     *
     * 反过来（先删记录、再清分区）在清理失败时最坏：记录已经没了，盘上却还留着
     * 一个 `persist:ss_<id>` 目录，里面是完整的 Cookie / localStorage / IndexedDB。
     * 没有任何界面知道这个 id 曾经存在，用户也无从发现 —— 这正是「删除只删了一半」。
     *
     * 清理本身是**尽力而为**：分区可能被正在运行的窗口占用（Windows 上尤其明显），
     * 清不掉不该让「彻底删除」失败。失败只 warn + 写进审计，然后继续删记录 ——
     * 用户的意图是「让这个环境消失」，把一次记录删除变成失败只会让他反复重试，
     * 留下更多半清理状态。
     */
    let cleanupError: string | null = null
    try {
      await clearProfileData(id)
    } catch (err) {
      cleanupError = errorText(err)
      console.warn(
        `[trash] 环境 ${id} 的分区数据清理失败（记录仍会删除）：${cleanupError}`
      )
    }

    ctx.stores.profiles.purge(id)

    appendAudit(
      ctx.stores,
      '环境·彻底删除',
      `环境 ${profile.name}（${id}）`,
      cleanupError === null
        ? `记录已移除；${partitionFor(id)} 的 Cookie / localStorage / IndexedDB / 缓存已清除`
        : `记录已移除，但 ${partitionFor(id)} 的分区数据清理失败（可能被占用）：${cleanupError}；` +
          'Cookie / localStorage / IndexedDB 可能残留在磁盘'
    )

    // 回收站列表与正常列表都要刷新：purge 之后两边都不应再出现这条记录。
    ctx.broadcast(CH.push.profileState, ctx.stores.profiles.list())
  })
}
