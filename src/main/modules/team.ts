/**
 * 本地团队 / 协作模块（LOCAL-ONLY）。
 *
 * 边界先说清楚：这是**单机多角色**，不是云端多用户。没有登录、没有账号体系、
 * 没有服务端、没有遥测。所有数据都落在本机的 <userData>/data 下，通过
 * CollectionStore 原子写。角色与授权描述的是「本机上这个成员能做什么」，
 * 用来在本地协作/演示时表达权限差异，绝不代表一个能跨设备鉴权的身份。
 * 把这套东西同步到云需要账号、凭证、传输加密与服务端鉴权，那与本项目
 * 「数据不出本机、零遥测」的约束冲突，不在这一层实现。
 *
 * 本模块提供：种子所有者、成员增删查改、逐环境授权、活动日志、IPC。
 * 权限判定放在零依赖的 team-policy.ts（可被纯 Node 单测）；agent / 本地 API /
 * 脚本回放三条执行路径**当前都还没有接入这些判定** —— 见 team-policy.ts 中
 * assertCan* 的诚实说明。
 *
 * 归属：团队/协作本地模块
 */

import { CH } from '@shared/ipc'
import type {
  TeamMember,
  TeamRole,
  TeamProfileShare,
  TeamActivity,
  TeamState
} from '@shared/types'
import { CollectionStore, type Stores } from '@main/store'
import type { ModuleContext } from './context'
import {
  TEAM_NAME_CAP,
  isLastOwner,
  sortActivity
} from './team-policy'

const ROLES: readonly TeamRole[] = ['owner', 'admin', 'member', 'viewer']

/** 本地所有者种子：没有登录，所以代表「本机操作者」本人 */
const OWNER_SEED_ID = 'owner_local'
const OWNER_SEED_NAME = '本机所有者'

/* ────────────────────────────── 边界校验 ────────────────────────────── */

/**
 * 成员姓名校验：trim、非空、长度上限。
 *
 * 不信渲染层：被 XSS 的渲染层可以送来空串或 10KB 的名字。静默截断会让它声称
 * 存下的是原名（界面显示和实际不一致），所以超限一律**拒绝**，由调用方报错。
 */
function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('成员姓名必须是字符串')
  const name = raw.trim()
  if (name.length === 0) throw new Error('成员姓名不能为空')
  if (name.length > TEAM_NAME_CAP) throw new Error(`成员姓名不能超过 ${TEAM_NAME_CAP} 字`)
  return name
}

function checkId(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`${label} id 必须是非空字符串`)
  }
  return raw
}

function checkRole(raw: unknown): TeamRole {
  if (typeof raw !== 'string' || !ROLES.includes(raw as TeamRole)) {
    throw new Error(`无效的角色：${String(raw)}`)
  }
  return raw as TeamRole
}

function checkPermission(raw: unknown): TeamProfileShare['permission'] {
  if (raw !== 'use' && raw !== 'manage') {
    throw new Error(`无效的授权类型：${String(raw)}（只接受 use / manage）`)
  }
  return raw
}

/** 分享记录的复合主键。与 store/index.ts 的 TeamShareRecord 约定一致 */
function shareKey(profileId: string, memberId: string): string {
  return `${profileId}::${memberId}`
}

/* ────────────────────────────── 核心逻辑 ────────────────────────────── */

/**
 * 首次使用时播种一个本地所有者。
 *
 * 为什么不播种「管理员 + 普通用户 + 访客」之类的完整角色样板：应用是单机的，
 * 没有登录，也就没有「别人」可以成为那些角色。凭空造几个假身份只会让人误以为
 * 存在多用户体系。**恰好一个 owner**代表本机操作者本人，其余角色要由用户显式新增
 * —— 那才是真实发生的本地协作。
 *
 * 用固定 id 而不是随机：种子只应存在一份，固定 id 让「是否已经播种」的判断
 * 不依赖随机数碰撞，也方便定位这条不可被删的记录。
 */
function ensureSeeded(stores: Stores): void {
  if (stores.members.get(OWNER_SEED_ID) !== null) return
  const now = Date.now()
  stores.members.add({
    id: OWNER_SEED_ID,
    name: OWNER_SEED_NAME,
    role: 'owner',
    createdAt: now,
    lastActiveAt: null,
    disabled: false
  })
}

/**
 * 追加一条活动日志（append-only）。
 *
 * ── 与审计链的边界（刻意不合并）──
 *
 * 团队写操作**只进这里，不进 `modules/audit.ts` 的 `appendAudit` 哈希链**。
 * 两者回答的问题不同：审计链记「这条记录有没有被改过」（防篡改，带 seq/prev
 * 哈希与链尾锚点），活动日志记「谁在什么时候改了什么」（运营视角）。把团队
 * 操作接进审计链会污染闸门保留策略 —— audit store 的 maxItems 裁剪会给闸门
 * 记录（`闸门·` 前缀）开豁免，混进大量成员/授权操作后，这个窗口的含义就被
 * 稀释了，而且审计链的「完整性」宣示也会变成对运营日志的过度承诺。
 * 反过来，活动日志也不能被当成团队审计：它是 append-only 的普通集合，
 * 可以被磁盘工具直接改写。
 *
 * ── actor 归属 ──
 *
 * `actor` 一律由 `currentActor()` 在写操作开始时取：日志记的是「谁发起了这次
 * 操作」，必须取变更前的有效 owner（跳过 disabled / 已被降级的种子）。所有团队
 * 写入口（memberAdd / memberUpdate / memberRemove / shareSet / shareRemove）
 * 都在变更成功后调用本函数 —— 新增写操作时必须同样调用，否则日志会漏掉
 * 「谁做了什么」，而这个缺口不会让任何界面报错。
 *
 * 上限由 CollectionStore 的 maxItems 处理（见 store/index.ts）。
 */
function appendActivity(
  stores: Stores,
  actor: TeamMember,
  action: string,
  target: string,
  detail?: string
): TeamActivity {
  const entry: TeamActivity = {
    id: CollectionStore.newId('tact'),
    at: Date.now(),
    actorId: actor.id,
    actorName: actor.name,
    action,
    target,
    ...(detail === undefined ? {} : { detail })
  }
  stores.activity.add(entry)
  return entry
}

/**
 * 取当前操作者：单操作者模型下优先用种子所有者。
 *
 * 但「种子存在」不等于「种子可用」：只要盘上还有另一个有效 owner，
 * `updateMember()` 就允许把种子禁用或降级。活动日志不能记在一个已经被禁用、
 * 不能管理任何东西的成员名下 —— 那等于伪造操作者，事后追责会追到一个
 * 根本没有权限的人身上。所以种子必须同时满足「未禁用 + 仍是 owner」才采用，
 * 否则退回到任意一个有效 owner。
 */
function currentActor(stores: Stores): TeamMember {
  ensureSeeded(stores)
  const owner = stores.members.get(OWNER_SEED_ID)
  if (owner && !owner.disabled && owner.role === 'owner') return owner
  const fallback = stores.members.list().find((m) => !m.disabled && m.role === 'owner')
  if (fallback) return fallback
  // 正常路径下 `isLastOwner()` 会拦住「禁用/降级/删除最后一个有效 owner」，
  // 所以这里只可能是盘上数据被外力改坏。宁可响亮失败，也不凭空造一个
  // 不存在的操作者把日志记下去。
  throw new Error('没有可用的本地所有者，工作区不可管理')
}

function addMember(stores: Stores, rawName: unknown, rawRole: unknown): TeamMember {
  const actor = currentActor(stores)
  const name = cleanName(rawName)
  const role = checkRole(rawRole)
  // 新成员不能在创建时就是 disabled 吗？允许，但没有任何意义（建了就用不了）；
  // 这里只接受 name/role，disabled 恒为 false，要禁由 memberUpdate 显式做。
  const member: TeamMember = {
    id: CollectionStore.newId('tmbr'),
    name,
    role,
    createdAt: Date.now(),
    lastActiveAt: null,
    disabled: false
  }
  stores.members.add(member)
  appendActivity(stores, actor, '成员·新增', member.id, `${name}（${role}）`)
  return member
}

function updateMember(
  stores: Stores,
  rawId: unknown,
  patch: { name?: unknown; role?: unknown; disabled?: unknown }
): TeamMember {
  const actor = currentActor(stores)
  const id = checkId(rawId, '成员')
  const existing = stores.members.get(id)
  if (!existing) throw new Error(`成员不存在：${id}`)
  const input = patch ?? {}

  const changes: Partial<TeamMember> = {}
  if (input.name !== undefined) changes.name = cleanName(input.name)
  if (input.role !== undefined) changes.role = checkRole(input.role)
  if (input.disabled !== undefined) {
    if (typeof input.disabled !== 'boolean') throw new Error('disabled 必须是布尔值')
    changes.disabled = input.disabled
  }

  // 最后一个有效 owner 不得降级、不得禁用。两条都按「改完之后的状态」判定：
  // 如果这次改动会让它不再是有效 owner，而它当前正是唯一的有效 owner，就拒绝。
  const willLoseOwnership =
    (changes.role !== undefined && changes.role !== 'owner') ||
    (changes.disabled !== undefined && changes.disabled === true)
  if (willLoseOwnership && isLastOwner(stores.members.list(), id)) {
    throw new Error('不能降级或禁用最后一个所有者：工作区将无人可管理')
  }

  const updated = stores.members.update(id, changes)
  appendActivity(stores, actor, '成员·更新', id, Object.keys(changes).join('、') || '无变更')
  return updated
}

function removeMember(stores: Stores, rawId: unknown): { ok: true } {
  const actor = currentActor(stores)
  const id = checkId(rawId, '成员')
  const existing = stores.members.get(id)
  if (!existing) throw new Error(`成员不存在：${id}`)
  if (isLastOwner(stores.members.list(), id)) {
    throw new Error('不能删除最后一个所有者：工作区将无人可管理')
  }
  stores.members.remove(id)
  // 顺手清掉这个成员的环境授权，避免悬空 share 留在列表里（界面会显示「已删成员仍有授权」）
  //
  // 一次 replaceAll，而不是逐条 remove：每条 remove 都是一次整份 team-shares.json 的
  // read → 改 → 原子 rename，N 条授权就是 N 次全量写。这里先过滤出要保留的，再整份
  // 写一次。`CollectionStore.replaceAll` 直接走 `JsonStore.write`（tmp → fsync → rename，
  // 原子），并保留损坏 latch：shares 文件损坏时它抛错，而不是拿空数组覆盖坏文件。
  //
  // shares 集合没有配 maxItems / retain（见 store/index.ts 的 `new CollectionStore(...)`），
  // 所以 replaceAll 绕过 `evictInPlace` 不会漏掉任何淘汰 —— audit.ts 那里必须手动补裁，
  // 这里不需要。
  const shares = stores.shares.list()
  const remaining = shares.filter((share) => share.memberId !== id)
  // 没有匹配项时不要写盘：「删除一个没有授权的成员」不该触发一次全量重写
  if (remaining.length !== shares.length) stores.shares.replaceAll(remaining)
  appendActivity(stores, actor, '成员·删除', id, existing.name)
  return { ok: true }
}

function shareSet(
  stores: Stores,
  rawProfileId: unknown,
  rawMemberId: unknown,
  rawPermission: unknown
): TeamProfileShare {
  const actor = currentActor(stores)
  const profileId = checkId(rawProfileId, '环境')
  const memberId = checkId(rawMemberId, '成员')
  const permission = checkPermission(rawPermission)

  // 两端都必须真实存在：给不存在的环境/成员授权，界面上会显示一条永远用不上的记录，
  // 而用户以为共享已经生效。失败必须响亮。
  if (stores.profiles.get(profileId) === null) throw new Error(`环境不存在：${profileId}`)
  if (stores.members.get(memberId) === null) throw new Error(`成员不存在：${memberId}`)

  const share: TeamProfileShare = { profileId, memberId, permission }
  const record = { ...share, id: shareKey(profileId, memberId) }
  // CollectionStore.update 会保留 id；这里用 add/覆盖写，因为同一对 (profileId,memberId)
  // 应当只有一条 —— 先删后加保证不重复。
  stores.shares.remove(record.id)
  stores.shares.add(record)
  appendActivity(
    stores,
    actor,
    '授权·设置',
    `${profileId}/${memberId}`,
    `${permission}`
  )
  return share
}

function shareRemove(stores: Stores, rawProfileId: unknown, rawMemberId: unknown): { ok: true } {
  const actor = currentActor(stores)
  const profileId = checkId(rawProfileId, '环境')
  const memberId = checkId(rawMemberId, '成员')
  const id = shareKey(profileId, memberId)
  if (stores.shares.get(id) === null) {
    throw new Error(`授权不存在：环境 ${profileId} / 成员 ${memberId}`)
  }
  stores.shares.remove(id)
  appendActivity(stores, actor, '授权·撤销', `${profileId}/${memberId}`)
  return { ok: true }
}

function getState(stores: Stores): TeamState {
  // 播种放在读路径上：首次打开团队页就能看到所有者，而不是一个空白页。
  ensureSeeded(stores)
  // 「读不到 ≠ 不存在」：存储层损坏时 corruption 非空，这里把它显式带出来，
  // 让界面能区分「确实没有成员」和「成员文件读不到」，而不是把两者都画成空列表。
  // 目前 TeamState 没有 error 字段（快照契约固定），因此用 initialized 只表达
  // 「是否播种过」这一事实；损坏状态由 system.storeHealth 单独呈现，不在这里假装成功。
  return {
    initialized: stores.members.get(OWNER_SEED_ID) !== null,
    members: stores.members.list(),
    activity: sortActivity(stores.activity.list()),
    shares: stores.shares.list().map(({ profileId, memberId, permission }) => ({
      profileId,
      memberId,
      permission
    }))
  }
}

/* ────────────────────────────── 注册 ────────────────────────────── */

export function registerTeamModule(ctx: ModuleContext): void {
  const stores = ctx.stores

  ctx.handle(CH.team.state, () => getState(stores))

  ctx.handle(CH.team.memberAdd, (_e, name, role) => addMember(stores, name, role))

  ctx.handle(CH.team.memberUpdate, (_e, id, patch) =>
    updateMember(stores, id, (patch ?? {}) as {
      name?: unknown
      role?: unknown
      disabled?: unknown
    })
  )

  ctx.handle(CH.team.memberRemove, (_e, id) => removeMember(stores, id))

  ctx.handle(CH.team.shareSet, (_e, profileId, memberId, permission) =>
    shareSet(stores, profileId, memberId, permission)
  )

  ctx.handle(CH.team.shareRemove, (_e, profileId, memberId) =>
    shareRemove(stores, profileId, memberId)
  )

  ctx.handle(CH.team.activity, () => sortActivity(stores.activity.list()))
}
