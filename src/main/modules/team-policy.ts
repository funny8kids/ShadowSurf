/**
 * 本地团队权限策略（纯函数，零运行时依赖）。
 *
 * 为什么单独成文件：这里的每个判定都是「以后每次加角色/授权都会重犯」的那类
 * 边界，只有测试能守住，而测试必须能在纯 Node 里便宜地跑。若把纯函数塞进
 * `team.ts`，那个文件 import 了 electron 与 store，Node 里加载即失败，
 * 测试就不得不起整个主进程 —— 于是没人跑，规则就烂掉了。
 *
 * 本文件**只做纯判定**，不读盘、不写日志、不抛业务副作用（除两个 assert 显式抛错）。
 * 所有数据都是 LOCAL-ONLY：无登录、无云端、无遥测。角色描述的是「本机上这个成员
 * 能做什么」，不是一个可跨设备验证的身份。
 *
 * 归属：团队/协作本地模块
 */

import type {
  TeamRole,
  TeamMember,
  TeamProfileShare,
  TeamActivity,
  TeamState
} from '@shared/types'

/** 成员姓名上限。够放下中文姓名与常见昵称，超出就拒绝而不是静默截断（见 team.ts 边界校验） */
export const TEAM_NAME_CAP = 40

/**
 * 能否管理成员（增删、改角色/禁用）。
 *
 * owner / admin 可以；member / viewer 不行。
 * 这是**本地多角色**的约定，不代表存在能登录的远程账号。
 */
export function canManageMembers(role: TeamRole): boolean {
  return role === 'owner' || role === 'admin'
}

/**
 * 能否「使用」某个环境（启动 / 打开 / 读）。
 *
 * 为什么 owner/admin 无条件放行：他们是**本机操作者**，本机上所有环境本来就在
 * 他们的文件系统与账户之下，逐环境授权只是给普通成员/访客收口用的。给 owner/admin
 * 也要求 share，只会产生「在自己机器上被自己锁在外面」的荒谬状态，而他们随时能
 * 直接改 store 绕过 —— 那这种校验就是自欺欺人。诚实做法是承认他们天然拥有全部权限。
 *
 * member / viewer 必须**恰好命中属于自己的那条 share**，且权限是 'use' 或 'manage'
 * （manage 蕴含 use）。传进来的 share 若属于别的成员，一律不算 —— 防止拿别人的授权冒充。
 */
export function canUseProfile(
  role: TeamRole,
  share: TeamProfileShare | null,
  memberId: string
): boolean {
  if (role === 'owner' || role === 'admin') return true
  if (!share || share.memberId !== memberId) return false
  return share.permission === 'use' || share.permission === 'manage'
}

/**
 * 能否「管理」某个环境（改配置 / 删除 / 改授权）。
 *
 * owner/admin 同上：本机操作者，无条件放行。
 * member 只有在拿到该环境的 'manage' 授权时才行（'use' 只看不碰）。
 * viewer 永远只读：即使被误发了 'manage' share 也不放行 —— 访客角色的定义就是
 * 「能看不能动」，把 manage share 当成对 viewer 的越权通道，会让「设成 viewer」
 * 这个收紧动作在某些环境下反而放开权限，与最小权限原则相反。
 */
export function canManageProfile(
  role: TeamRole,
  share: TeamProfileShare | null,
  memberId: string
): boolean {
  if (role === 'owner' || role === 'admin') return true
  if (role === 'viewer') return false
  if (!share || share.memberId !== memberId) return false
  return share.permission === 'manage'
}

/**
 * 最后一个 owner 守卫。
 *
 * 返回 true 表示：`id` 指向一个**当前有效**的 owner，且它是唯一的有效 owner ——
 * 此时不得删除它、不得降级它、也不得禁用它。
 *
 * 「有效」= role 为 owner 且 disabled 为 false。把禁用也计入会失去意义：禁用的
 * owner 不能管理任何东西，若把它算进来，就会出现「还有一个 owner（但已禁用）」
 * 而工作区实际无人能管的死局。
 *
 * 为什么必须有这条：工作区任何时刻都要 ≥1 个能管理它的人。若最后一个 owner 被
 * 移除或降级，剩下的全是 member/viewer，谁都不能增删成员、改授权 —— 工作区不可管理，
 * 而且因为 owner 无法从内部再产生，这个状态不可逆。失败必须**响亮**，绝不静默放行。
 */
export function isLastOwner(members: TeamMember[], id: string): boolean {
  const target = members.find((m) => m.id === id)
  if (!target || target.role !== 'owner' || target.disabled) return false
  const activeOwners = members.filter((m) => m.role === 'owner' && !m.disabled)
  return activeOwners.length <= 1
}

/**
 * 活动日志排序：最新在前，同时间戳用 id 倒序做稳定裁决。
 *
 * 为什么返回新数组而不原地 sort：调用方手里通常是 store 读出的副本，但纯函数
 * 不该依赖「反正是副本」这种外部约定 —— 那是以后被某次重构打破的口子。
 */
export function sortActivity(entries: TeamActivity[]): TeamActivity[] {
  return entries.slice().sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
}

/**
 * 解析「当前操作者」。
 *
 * 规则（见 Settings.activeMemberId 的说明）：
 * - 未配置 / 空 → **本机所有者**（`OWNER_SEED_ID`），全权限；
 * - 配置了一个存在的成员 → 用它的角色判定；
 * - 配置了不存在的 id（成员被删了）→ 抛错而不是静默放行。
 *   静默放行会让「删掉某个成员」变成「权限凭空回到 owner」，那是权限放大。
 *
 * 返回 `null` 表示「本机所有者」——调用方据此跳过所有 ACL 检查。
 */
export function resolveActor(
  state: TeamState,
  activeMemberId: string | undefined
): TeamMember | null {
  if (!activeMemberId) return null
  const member = state.members.find((m) => m.id === activeMemberId)
  if (!member) throw new Error(`当前操作者不存在（${activeMemberId}），可能已被删除`)
  if (member.disabled) throw new Error(`当前操作者已禁用（${activeMemberId}）`)
  return member
}

/**
 * 当前操作者能否「使用」该环境；本机所有者直接放行。
 */
export function actorCanUse(
  state: TeamState,
  activeMemberId: string | undefined,
  profileId: string
): boolean {
  const actor = resolveActor(state, activeMemberId)
  if (actor === null) return true
  const share = state.shares.find((s) => s.profileId === profileId && s.memberId === actor.id) ?? null
  return canUseProfile(actor.role, share, actor.id)
}

/**
 * 当前操作者能否「管理」该环境；本机所有者直接放行。
 */
export function actorCanManage(
  state: TeamState,
  activeMemberId: string | undefined,
  profileId: string
): boolean {
  const actor = resolveActor(state, activeMemberId)
  if (actor === null) return true
  const share = state.shares.find((s) => s.profileId === profileId && s.memberId === actor.id) ?? null
  return canManageProfile(actor.role, share, actor.id)
}

/** 抛错版的便捷封装（handler 里用，错误文案带上操作者与环境） */
export function assertActorCanManage(
  state: TeamState,
  activeMemberId: string | undefined,
  profileId: string
): void {
  if (actorCanManage(state, activeMemberId, profileId)) return
  const actor = resolveActor(state, activeMemberId)
  const name = state.members.find((m) => m.id === profileId)
  throw new Error(
    `当前成员${actor ? `（${actor.name}）` : ''}无权管理环境${name ? `「${name.name}」` : ` ${profileId}`}；` +
      '需要在成员页获得该环境的「管理」授权，或切换回所有者'
  )
}

/**
 * 门禁断言（**为后续集成预留，当前尚未接入任何执行路径**）。
 *
 * 诚实说明：本应用目前是**单操作者**的 —— 所有操作都从本机所有者这一个身份发起，
 * 没有登录、没有「当前成员」上下文，agent / 本地 API / 脚本回放三条执行路径都没调用
 * 这两个函数。把它们接进去需要先把「本次调用以哪个成员身份执行」贯穿到执行层，
 * 那会牵动 L2 风险闸门，属于另一个改动，风险与本模块无关，故不在此处接线。
 * 现在它们只是可被上层调用的纯能力，不构成任何已生效的强制。
 */
export function assertCanUseProfile(
  state: TeamState,
  memberId: string,
  profileId: string
): void {
  const member = state.members.find((m) => m.id === memberId)
  if (!member) throw new Error(`成员不存在：${memberId}`)
  if (member.disabled) throw new Error(`成员已禁用：${memberId}`)
  const share =
    state.shares.find((s) => s.memberId === memberId && s.profileId === profileId) ?? null
  if (!canUseProfile(member.role, share, memberId)) {
    throw new Error(`成员 ${memberId} 无权使用环境 ${profileId}`)
  }
}

/** 同 `assertCanUseProfile`，校验的是管理权限；尚未接入执行路径，见其上说明 */
export function assertCanManageProfile(
  state: TeamState,
  memberId: string,
  profileId: string
): void {
  const member = state.members.find((m) => m.id === memberId)
  if (!member) throw new Error(`成员不存在：${memberId}`)
  if (member.disabled) throw new Error(`成员已禁用：${memberId}`)
  const share =
    state.shares.find((s) => s.memberId === memberId && s.profileId === profileId) ?? null
  if (!canManageProfile(member.role, share, memberId)) {
    throw new Error(`成员 ${memberId} 无权管理环境 ${profileId}`)
  }
}
