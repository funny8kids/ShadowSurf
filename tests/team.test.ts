/**
 * 本地团队权限策略测试（纯逻辑）。
 *
 * 被测模块 team-policy.ts 只做 type-only import，没有 electron / store 运行时依赖，
 * 所以可以像 tab-groups.test.ts 一样用 node:test 在纯 Node 里直接跑
 * （--experimental-strip-types），不需要起主进程。
 * 跑法：node --experimental-strip-types --test tests/team.test.ts
 *
 * 这些测试守的是「以后每加一个角色/授权都会重犯」的边界：owner/admin 的天然
 * 放行、member/viewer 的 share 约束、最后一个 owner 不可丢、日志顺序。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  canManageMembers,
  canUseProfile,
  canManageProfile,
  isLastOwner,
  sortActivity,
  assertCanUseProfile,
  assertCanManageProfile
} from '../src/main/modules/team-policy.ts'
import type {
  TeamMember,
  TeamProfileShare,
  TeamActivity,
  TeamState
} from '@shared/types'

const ROOT = join(import.meta.dirname, '..')

/* ────────────────────────────── 夹具 ────────────────────────────── */

function member(id: string, role: TeamMember['role'], disabled = false): TeamMember {
  return {
    id,
    name: id,
    role,
    createdAt: 0,
    lastActiveAt: null,
    disabled
  }
}

function share(
  profileId: string,
  memberId: string,
  permission: TeamProfileShare['permission']
): TeamProfileShare {
  return { profileId, memberId, permission }
}

/* ────────────────────────────── canManageMembers ────────────────────────────── */

test('canManageMembers：owner/admin 可以管理成员，member/viewer 不行', () => {
  assert.equal(canManageMembers('owner'), true)
  assert.equal(canManageMembers('admin'), true)
  assert.equal(canManageMembers('member'), false)
  assert.equal(canManageMembers('viewer'), false)
})

/* ────────────────────────────── owner/admin 无条件放行 ────────────────────────────── */

test('owner/admin 无需 share 即可使用和管理任意环境', () => {
  for (const role of ['owner', 'admin'] as const) {
    assert.equal(canUseProfile(role, null, 'm1'), true)
    assert.equal(canManageProfile(role, null, 'm1'), true)
    // 即使 share 明确写着别人，本地操作者依然放行（他们是本机操作者）
    assert.equal(canUseProfile(role, share('p1', 'someone-else', 'use'), 'm1'), true)
  }
})

/* ────────────────────────────── member ────────────────────────────── */

test('member 持 use-share：能使用但不能管理', () => {
  const s = share('p1', 'm1', 'use')
  assert.equal(canUseProfile('member', s, 'm1'), true)
  assert.equal(canManageProfile('member', s, 'm1'), false)
})

test('member 持 manage-share：能使用也能管理', () => {
  const s = share('p1', 'm1', 'manage')
  assert.equal(canUseProfile('member', s, 'm1'), true)
  assert.equal(canManageProfile('member', s, 'm1'), true)
})

test('member 无 share：既不能使用也不能管理', () => {
  assert.equal(canUseProfile('member', null, 'm1'), false)
  assert.equal(canManageProfile('member', null, 'm1'), false)
})

test('不能拿别人的 share 冒充自己的授权', () => {
  const other = share('p1', 'm2', 'manage')
  assert.equal(canUseProfile('member', other, 'm1'), false)
  assert.equal(canManageProfile('member', other, 'm1'), false)
})

/* ────────────────────────────── viewer ────────────────────────────── */

test('viewer 持 use-share：能使用但绝不管理', () => {
  const s = share('p1', 'v1', 'use')
  assert.equal(canUseProfile('viewer', s, 'v1'), true)
  assert.equal(canManageProfile('viewer', s, 'v1'), false)
})

test('viewer 即使被误发 manage-share 也不能管理（只读角色不可越权）', () => {
  const s = share('p1', 'v1', 'manage')
  assert.equal(canUseProfile('viewer', s, 'v1'), true)
  assert.equal(canManageProfile('viewer', s, 'v1'), false)
})

/* ────────────────────────────── 最后一个 owner ────────────────────────────── */

test('isLastOwner：唯一有效 owner 返回 true', () => {
  assert.equal(isLastOwner([member('o1', 'owner'), member('m1', 'member')], 'o1'), true)
})

test('isLastOwner：存在第二个有效 owner 时返回 false', () => {
  assert.equal(
    isLastOwner([member('o1', 'owner'), member('o2', 'owner')], 'o1'),
    false
  )
})

test('isLastOwner：禁用的 owner 不算有效，不能拿它当挡箭牌', () => {
  // o2 已禁用 → 唯一有效 owner 是 o1，删除 o1 必须被拦
  assert.equal(
    isLastOwner([member('o1', 'owner'), member('o2', 'owner', true)], 'o1'),
    true
  )
})

test('isLastOwner：目标非 owner 或不存在时返回 false', () => {
  assert.equal(isLastOwner([member('o1', 'owner')], 'm1'), false)
  assert.equal(isLastOwner([member('o1', 'owner')], 'missing'), false)
})

/* ────────────────────────────── 活动日志排序 ────────────────────────────── */

function activity(id: string, at: number): TeamActivity {
  return { id, at, actorId: 'o1', actorName: 'Owner', action: 'x', target: 't' }
}

test('sortActivity：新条目在前，旧条目在后', () => {
  const entries = [activity('a', 100), activity('b', 300), activity('c', 200)]
  assert.deepEqual(
    sortActivity(entries).map((e) => e.id),
    ['b', 'c', 'a']
  )
})

test('sortActivity：同时间戳按 id 倒序稳定裁决，且不改动原数组', () => {
  const entries = [activity('a', 100), activity('b', 100)]
  const sorted = sortActivity(entries)
  assert.deepEqual(sorted.map((e) => e.id), ['b', 'a'])
  // 原数组未被就地排序
  assert.deepEqual(entries.map((e) => e.id), ['a', 'b'])
})

/* ────────────────────────────── 门禁断言（预留） ────────────────────────────── */

function state(members: TeamMember[], shares: TeamProfileShare[]): TeamState {
  return { initialized: true, members, activity: [], shares }
}

test('assertCanUseProfile：授权放行，缺授权抛错', () => {
  const s = state(
    [member('o1', 'owner'), member('m1', 'member')],
    [share('p1', 'm1', 'use')]
  )
  assert.doesNotThrow(() => assertCanUseProfile(s, 'm1', 'p1'))
  assert.throws(() => assertCanUseProfile(s, 'm1', 'p2'), /无权使用/)
  assert.throws(() => assertCanUseProfile(s, 'missing', 'p1'), /成员不存在/)
})

test('assertCanManageProfile：viewer 管理遭拒，禁用成员遭拒', () => {
  const s = state(
    [member('v1', 'viewer'), member('m1', 'member'), member('d1', 'member', true)],
    [share('p1', 'v1', 'manage'), share('p1', 'm1', 'manage'), share('p1', 'd1', 'manage')]
  )
  assert.doesNotThrow(() => assertCanManageProfile(s, 'm1', 'p1'))
  assert.throws(() => assertCanManageProfile(s, 'v1', 'p1'), /无权管理/)
  assert.throws(() => assertCanManageProfile(s, 'd1', 'p1'), /已禁用/)
})

/* ──────────────── 操作者解析与执行路径 ACL（本轮新增） ──────────────── */

import {
  actorCanUse,
  actorCanManage,
  assertActorCanManage,
  resolveActor
} from '../src/main/modules/team-policy.ts'

function teamState(members: TeamMember[], shares: TeamProfileShare[] = []): TeamState {
  return { initialized: true, members, shares, activity: [] }
}

const OWNER = member('mem_owner', 'owner')
const VIEWER = member('mem_viewer', 'viewer')
const MEMBER = member('mem_member', 'member')

test('未设置 activeMemberId = 本机所有者，全部放行（向后兼容）', () => {
  const state = teamState([OWNER, VIEWER, MEMBER])
  assert.equal(actorCanUse(state, undefined, 'prf_any'), true)
  assert.equal(actorCanManage(state, undefined, 'prf_any'), true)
  assert.equal(actorCanManage(state, '', 'prf_any'), true)
  assert.equal(resolveActor(state, undefined), null)
  assert.equal(resolveActor(state, ''), null)
})

test('viewer 未授权时不能用也不能管环境（原缺陷：照样能改删）', () => {
  const state = teamState([OWNER, VIEWER])
  assert.equal(actorCanUse(state, VIEWER.id, 'prf_1'), false)
  assert.equal(actorCanManage(state, VIEWER.id, 'prf_1'), false)
  assert.throws(() => assertActorCanManage(state, VIEWER.id, 'prf_1'), /无权管理环境/)
})

test('viewer 拿到 use share 后能用，但仍不能管', () => {
  const share: TeamProfileShare = { id: 's1', profileId: 'prf_1', memberId: VIEWER.id, permission: 'use' }
  const state = teamState([OWNER, VIEWER], [share])
  assert.equal(actorCanUse(state, VIEWER.id, 'prf_1'), true)
  assert.equal(actorCanManage(state, VIEWER.id, 'prf_1'), false, 'viewer 拿到 use 也不能管')
})

test('member 拿到 manage share 后能管；use 只能看', () => {
  const useShare: TeamProfileShare = { id: 's2', profileId: 'prf_1', memberId: MEMBER.id, permission: 'use' }
  const manageShare: TeamProfileShare = { id: 's3', profileId: 'prf_2', memberId: MEMBER.id, permission: 'manage' }
  const state = teamState([OWNER, MEMBER], [useShare, manageShare])
  assert.equal(actorCanManage(state, MEMBER.id, 'prf_1'), false)
  assert.equal(actorCanManage(state, MEMBER.id, 'prf_2'), true)
  assert.equal(actorCanUse(state, MEMBER.id, 'prf_2'), true, 'manage 蕴含 use')
})

test('share 属于别人时不算授权（防冒充）', () => {
  const other: TeamProfileShare = { id: 's4', profileId: 'prf_1', memberId: VIEWER.id, permission: 'manage' }
  const state = teamState([OWNER, MEMBER], [other])
  assert.equal(actorCanManage(state, MEMBER.id, 'prf_1'), false)
})

test('成员被删除后 activeMemberId 指向它 → 抛错而不是静默放行', () => {
  const state = teamState([OWNER, MEMBER])
  assert.throws(() => resolveActor(state, 'mem_gone'), /当前操作者不存在/)
})

test('被禁用的当前操作者 → 抛错', () => {
  const disabled = member('mem_d', 'member', true)
  const state = teamState([OWNER, disabled])
  assert.throws(() => resolveActor(state, disabled.id), /已禁用/)
})

test('owner 本人切换 activeMemberId → 仍然全权限（本机所有者天然放行）', () => {
  const state = teamState([OWNER, VIEWER])
  assert.equal(actorCanManage(state, OWNER.id, 'prf_9'), true)
  assert.equal(actorCanUse(state, OWNER.id, 'prf_9'), true)
})

/* ────────────── 当前操作者被删/禁用后必须复位 ────────────── */

test('删除或禁用当前操作者后，activeMemberId 必须复位', () => {
  // team.ts 依赖 electron / store，不能在纯 Node 里直接跑。
  // 这里读源码钉住"两个变更点都调用了复位"——这个缺口一旦出现，
  // 用户删掉一个成员之后所有 ACL 操作都会抛「当前操作者不存在」，
  // 而界面上只显示莫名其妙的报错，没人会想到根因是几分钟前那次删除。
  const src = readFileSync(join(ROOT, 'src/main/modules/team.ts'), 'utf8')
  const calls = (src.match(/clearActiveOperatorIf\(/g) ?? []).length
  // 1 次定义 + 2 次调用（updateMember 的禁用分支、removeMember）
  assert.ok(calls >= 3, `clearActiveOperatorIf 应出现至少 3 次（定义+2 调用），实际 ${String(calls)}`)
  assert.match(
    src,
    /changes\.disabled === true\s*\)\s*clearActiveOperatorIf/,
    '禁用当前操作者后必须复位'
  )
})
