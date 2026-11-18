/**
 * 本地团队与成员面板（LOCAL-ONLY）。
 *
 * 这里展示的是**单机多角色**：没有登录、没有账号体系、没有服务端、没有遥测。
 * 角色与逐环境授权只描述「本机上这个成员能做什么」，用来在本地协作 / 演示时
 * 表达权限差异 —— 绝不代表存在一个能跨设备鉴权的身份。页头那句副标题不是
 * 营销词，是能力边界：看到「成员」不要以为这是一款多人 SaaS。
 *
 * ── 三态原则（和 AuditPanel 同一套） ────────────────────────────────
 * 用 discriminated union 而不是布尔量，编译器会逼着每个分支回答「画什么」：
 *   TeamView = loading | error | ready
 * 读失败必须留在原地（内联错误 + 重试），不能只弹一个会消失的 toast ——
 * 否则面板会说「还没有成员 / 没有授权 / 没有动态」，把一次读不到说成「什么都没有」。
 * 「读不到」和「读到但是空」必须在界面上长得不一样。
 *
 * 归属：团队 / 协作本地模块（渲染层接线）
 * 样式只写同目录 team.css，类名统一 tp- 前缀，避免和其他工具面板互相覆盖。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Profile, TeamRole, TeamState, TeamProfileShare } from '@shared/types'
import { Badge, Button, Field, Icon, Modal, Select, cx, useToast } from '@renderer/components/ui'
import { errorMessage } from '@renderer/lib/api'
import { formatClock, formatDate, formatRelative } from '@renderer/lib/format'
import { useI18n } from '@renderer/lib/i18n'
import './team.css'

type TeamView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; state: TeamState }

const ROLE_KEY: Record<TeamRole, string> = {
  owner: 'team.roles.owner',
  admin: 'team.roles.admin',
  member: 'team.roles.member',
  viewer: 'team.roles.viewer'
}

const ROLE_TONE: Record<TeamRole, 'accent' | 'info' | 'neutral'> = {
  owner: 'accent',
  admin: 'info',
  member: 'neutral',
  viewer: 'neutral'
}

const ROLE_OPTION_KEYS: Array<{ value: TeamRole; labelKey: string }> = [
  { value: 'owner', labelKey: 'team.roles.owner' },
  { value: 'admin', labelKey: 'team.roles.admin' },
  { value: 'member', labelKey: 'team.roles.member' },
  { value: 'viewer', labelKey: 'team.roles.viewer' }
]

const PERMISSION_KEY: Record<TeamProfileShare['permission'], string> = {
  use: 'team.permissions.use',
  manage: 'team.permissions.manage'
}

const PERMISSION_OPTION_KEYS: Array<{
  value: TeamProfileShare['permission']
  labelKey: string
}> = [
  { value: 'use', labelKey: 'team.permissions.useDesc' },
  { value: 'manage', labelKey: 'team.permissions.manageDesc' }
]

/**
 * 活动区首批渲染多少条 / 每次「加载更多」加多少条。
 *
 * 为什么不全量渲染：活动记录跟着每次增删改走，上限 2000 条，每条又是
 * 「谁 · 做了什么 · 对象 · 相对时间」四五个节点。几千行一次铺开，
 * 面板的滚动和任何一次 setState 都会连带重排，输入框打字都会掉帧。
 *
 * 与 DataPanel 一样只改渲染量：快照仍然一次取全，只是先画前 100 条。
 */
const ACTIVITY_PAGE = 100
const ACTIVITY_STEP = 200

/** 去掉 Electron 套在 IPC 失败外的通道名前缀，用户不需要看 `ss:team:*` */
function cleanMessage(raw: string): string {
  const m = /Error invoking remote method '[^']*':\s*(?:Error:\s*)?([\s\S]*)$/.exec(raw)
  return (m?.[1] ?? raw).trim()
}

/**
 * 判断 `id` 是否是「最后一个有效所有者」。
 *
 * 主进程 team-policy.ts 里有同样的守卫，但那是 src/main 下的模块，渲染层引不到
 * （也不该引）—— 这里只做**界面层的按钮禁用**，真正的拒绝仍由主进程做。
 * 两处规则要一致：有效 = role 为 owner 且未禁用；数量 <= 1 即受保护。
 * 界面禁用是为了不让用户点了才被拒，而不是把主进程判定搬过来当门禁。
 */
function isProtectedOwner(members: TeamState['members'], id: string): boolean {
  const target = members.find((m) => m.id === id)
  if (!target || target.role !== 'owner' || target.disabled) return false
  return members.filter((m) => m.role === 'owner' && !m.disabled).length <= 1
}

export function TeamPanel() {
  const toast = useToast()
  const { t } = useI18n()
  const [view, setView] = useState<TeamView>({ kind: 'loading' })
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [profilesError, setProfilesError] = useState<string | null>(null)

  /* ── 表单草稿 ── */
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState<TeamRole>('member')
  const [shareProfileId, setShareProfileId] = useState('')
  const [shareMemberId, setShareMemberId] = useState('')
  const [sharePermission, setSharePermission] = useState<TeamProfileShare['permission']>('use')
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** 活动区当前渲染多少条（见 ACTIVITY_PAGE 的注释）。活动没有环境/筛选维度，
   *  所以没有「切换筛选要重置」的场景；只在用户显式点「刷新动态」时回到首批。 */
  const [activityShown, setActivityShown] = useState(ACTIVITY_PAGE)

  /** 主快照：成员 / 授权 / 活动一次拿到，避免三份列表拼出撕裂画面 */
  const refresh = useCallback(async (): Promise<void> => {
    // 已有数据时不退回「加载中」：每次增删改都闪成骨架，比不刷新更难读。
    // 但失败必须覆盖成功结果 —— 继续显示旧数据等于谎报新鲜度。
    setView((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
    try {
      setView({ kind: 'ready', state: await window.ss.team.state() })
    } catch (err) {
      setView({ kind: 'error', message: cleanMessage(errorMessage(err)) })
    }
  }, [])

  /** 环境列表：只给「分配授权」的下拉用，读失败留在原地的授权区说明，不只弹 toast */
  const loadProfiles = useCallback(async (): Promise<void> => {
    try {
      const list = await window.ss.profiles.list()
      setProfiles(list)
      setProfilesError(null)
    } catch (err) {
      setProfilesError(cleanMessage(errorMessage(err)))
    }
  }, [])

  useEffect(() => {
    void refresh()
    void loadProfiles()
  }, [refresh, loadProfiles])

  /**
   * 所有写操作的统一出口：失败给 toast（会消失但操作上下文还在），成功后重拉快照。
   * 读快照失败仍会进三态的内联错误，不会被这里的 toast 吞掉。
   */
  const mutate = useCallback(
    async (task: () => Promise<unknown>, okText: string): Promise<boolean> => {
      setBusy(true)
      try {
        await task()
        toast.push(okText, 'ok')
        await refresh()
        return true
      } catch (err) {
        toast.push(cleanMessage(errorMessage(err)), 'err')
        return false
      } finally {
        setBusy(false)
      }
    },
    [refresh, toast]
  )

  /** 活动区单独的刷新：走 activity 通道，只换活动数组，不动成员 / 授权 */
  const refreshActivity = useCallback(async (): Promise<void> => {
    try {
      const activity = await window.ss.team.activity()
      // 用户显式刷新 = 重新拿一份数据，展开条数回到首批
      setActivityShown(ACTIVITY_PAGE)
      setView((prev) =>
        prev.kind === 'ready' ? { ...prev, state: { ...prev.state, activity } } : prev
      )
    } catch (err) {
      toast.push(cleanMessage(errorMessage(err)), 'err')
    }
  }, [toast])

  /* ── 派生 ── */
  const members = view.kind === 'ready' ? view.state.members : []
  const shares = view.kind === 'ready' ? view.state.shares : []
  const activity = view.kind === 'ready' ? view.state.activity : []

  const nameOf = useCallback(
    (id: string): string => members.find((m) => m.id === id)?.name ?? id,
    [members]
  )
  const profileNameOf = useCallback(
    (id: string): string => profiles.find((p) => p.id === id)?.name ?? id,
    [profiles]
  )

  // 环境 / 成员列表异步到达，草稿里的 id 失效后自动落到第一个可用项
  useEffect(() => {
    if (profiles.length === 0) {
      if (shareProfileId !== '') setShareProfileId('')
      return
    }
    if (!profiles.some((p) => p.id === shareProfileId)) setShareProfileId(profiles[0].id)
  }, [profiles, shareProfileId])

  useEffect(() => {
    if (members.length === 0) {
      if (shareMemberId !== '') setShareMemberId('')
      return
    }
    if (!members.some((m) => m.id === shareMemberId)) setShareMemberId(members[0].id)
  }, [members, shareMemberId])

  const shareCapable = useMemo(
    () => members.filter((m) => !m.disabled).map((m) => ({ value: m.id, label: m.name })),
    [members]
  )

  const roleOptions = useMemo(
    () => ROLE_OPTION_KEYS.map((opt) => ({ value: opt.value, label: t(opt.labelKey) })),
    [t]
  )
  const permissionOptions = useMemo(
    () =>
      PERMISSION_OPTION_KEYS.map((opt) => ({ value: opt.value, label: t(opt.labelKey) })),
    [t]
  )

  /** 新增成员：姓名在主进程 trim + 校验，这里只挡明显的空串，不重复实现规则 */
  async function addMember(): Promise<void> {
    const name = newName.trim()
    if (!name) {
      toast.push(t('team.err.needName'), 'info')
      return
    }
    const ok = await mutate(
      () => window.ss.team.memberAdd({ name, role: newRole }),
      t('team.toast.added', { name })
    )
    if (ok) setNewName('')
  }

  /** 改角色：下拉即改。最后一个所有者不允许降级，select 已在渲染层禁用 */
  async function changeRole(id: string, role: TeamRole): Promise<void> {
    await mutate(() => window.ss.team.memberUpdate(id, { role }), t('team.toast.roleUpdated'))
  }

  /** 禁用 / 启用：最后一个所有者不允许禁用，按钮已禁用 */
  async function toggleDisabled(id: string, disabled: boolean): Promise<void> {
    await mutate(
      () => window.ss.team.memberUpdate(id, { disabled }),
      disabled ? t('team.toast.disabled') : t('team.toast.enabled')
    )
  }

  /** 移除：二次确认；主进程还会顺手清掉这个成员的环境授权 */
  async function removeMember(): Promise<void> {
    const id = confirmRemoveId
    setConfirmRemoveId(null)
    if (!id) return
    await mutate(() => window.ss.team.memberRemove(id), t('team.toast.removed'))
  }

  async function setShare(): Promise<void> {
    if (!shareProfileId || !shareMemberId) {
      toast.push(t('team.err.needShare'), 'info')
      return
    }
    await mutate(
      () => window.ss.team.shareSet(shareProfileId, shareMemberId, sharePermission),
      t('team.toast.shareSet')
    )
  }

  async function revokeShare(profileId: string, memberId: string): Promise<void> {
    await mutate(() => window.ss.team.shareRemove(profileId, memberId), t('team.toast.shareRevoked'))
  }

  const removeTarget = members.find((m) => m.id === confirmRemoveId) ?? null

  return (
    <div className="tp-panel">
      <header className="tp-head">
        <div>
          <h2>{t('team.title')}</h2>
          <p>{t('team.subtitle')}</p>
        </div>
        <Button size="sm" variant="ghost" icon="reload" onClick={() => void refresh()}>
          {t('common.refresh')}
        </Button>
      </header>

      <p className="tp-scope">
        <Icon name="alert" size={13} strokeWidth={2} />
        <span>
          {t('team.scope.lead')}
          <strong>{t('team.scope.singleMachine')}</strong>
          {t('team.scope.mid')}
          <strong>{t('team.scope.notCrossDevice')}</strong>
          {t('team.scope.tail')}
        </span>
      </p>

      {/* 三态：加载 / 失败 / 就绪。失败留在原地并可重试，绝不退化成「空列表」 */}
      {view.kind === 'loading' ? (
        <div className="tp-state">
          <Icon name="users" size={20} />
          <b>{t('team.loading')}</b>
        </div>
      ) : view.kind === 'error' ? (
        <div className="tp-state bad">
          <Icon name="alert" size={20} />
          <b>{t('team.error.title')}</b>
          <p>{view.message}</p>
          <p className="tp-state-hint">{t('team.error.hint')}</p>
          <Button variant="ghost" icon="reload" onClick={() => void refresh()}>
            {t('common.retryRead')}
          </Button>
        </div>
      ) : (
        <>
          {/* ────────────────── 成员 ────────────────── */}
          <section className="tp-card">
            <div className="tp-card-head">
              <div>
                <h3>{t('team.members.title')}</h3>
                <span>{t('team.members.subtitle', { n: members.length })}</span>
              </div>
            </div>

            {members.length === 0 ? (
              <div className="tp-empty">
                <b>{t('team.members.empty.title')}</b>
                <p>{t('team.members.empty.body')}</p>
              </div>
            ) : (
              <div className="tp-table">
                <div className="tp-tr tp-th">
                  <span>{t('team.members.table.member')}</span>
                  <span>{t('team.members.table.role')}</span>
                  <span>{t('team.members.table.lastActive')}</span>
                  <span>{t('common.actions')}</span>
                </div>
                {members.map((m) => {
                  const protectedOwner = isProtectedOwner(members, m.id)
                  const lastOwnerTitle = t('team.members.lastOwnerTitle')
                  return (
                    <div className={cx('tp-tr', m.disabled && 'off')} key={m.id}>
                      <span className="tp-who">
                        <b title={m.name}>{m.name}</b>
                        {m.role === 'owner' ? (
                          <Badge tone="accent">{t('team.roles.owner')}</Badge>
                        ) : null}
                        {m.disabled ? (
                          <Badge tone="bad">{t('team.members.badge.disabled')}</Badge>
                        ) : null}
                        <i title={m.id}>{m.id}</i>
                      </span>
                      <span className="tp-role">
                        <Badge tone={ROLE_TONE[m.role]}>{t(ROLE_KEY[m.role])}</Badge>
                      </span>
                      <span className="tp-who-time">{formatRelative(m.lastActiveAt)}</span>
                      <span className="tp-actions">
                        <select
                          className="tp-inline-select"
                          value={m.role}
                          disabled={busy || protectedOwner}
                          title={
                            protectedOwner
                              ? lastOwnerTitle
                              : t('team.members.roleTitle')
                          }
                          aria-label={t('team.members.roleAria', { name: m.name })}
                          onChange={(e) => void changeRole(m.id, e.target.value as TeamRole)}
                        >
                          {roleOptions.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                        <Button
                          size="sm"
                          variant="quiet"
                          disabled={busy || protectedOwner}
                          title={
                            protectedOwner
                              ? lastOwnerTitle
                              : m.disabled
                                ? t('team.members.restore')
                                : t('team.members.disableHint')
                          }
                          onClick={() => void toggleDisabled(m.id, !m.disabled)}
                        >
                          {m.disabled ? t('common.enable') : t('common.disable')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          icon="trash"
                          disabled={busy || protectedOwner}
                          title={
                            protectedOwner
                              ? lastOwnerTitle
                              : t('team.members.removeTitle')
                          }
                          onClick={() => setConfirmRemoveId(m.id)}
                        >
                          {t('common.remove')}
                        </Button>
                      </span>
                    </div>
                  )
                })}
              </div>
            )}

            <div className="tp-form">
              <Field
                label={t('team.members.name')}
                hint={t('team.members.nameHint')}
              >
                <input
                  className="tp-input"
                  value={newName}
                  disabled={busy}
                  placeholder={t('team.members.namePlaceholder')}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addMember()
                  }}
                />
              </Field>
              <Field label={t('team.members.table.role')}>
                <Select
                  options={roleOptions}
                  value={newRole}
                  disabled={busy}
                  onChange={(v) => setNewRole(v as TeamRole)}
                />
              </Field>
              <Button
                variant="primary"
                icon="plus"
                disabled={busy || newName.trim() === ''}
                onClick={() => void addMember()}
              >
                {t('team.members.add')}
              </Button>
            </div>
          </section>

          {/* ────────────────── 环境授权 ────────────────── */}
          <section className="tp-card">
            <div className="tp-card-head">
              <div>
                <h3>{t('team.shares.title')}</h3>
                <span>{t('team.shares.subtitle', { n: shares.length })}</span>
              </div>
            </div>

            {profilesError ? (
              <div className="tp-inline-error">
                <Icon name="alert" size={13} />
                <span>{t('team.shares.profilesError', { message: profilesError })}</span>
                <Button size="sm" variant="ghost" onClick={() => void loadProfiles()}>
                  {t('common.retry')}
                </Button>
              </div>
            ) : null}

            {shares.length === 0 ? (
              <div className="tp-empty">
                <b>{t('team.shares.empty.title')}</b>
                <p>{t('team.shares.empty.body')}</p>
              </div>
            ) : (
              <div className="tp-table tp-table-shares">
                <div className="tp-tr tp-th">
                  <span>{t('team.shares.table.profile')}</span>
                  <span>{t('team.members.table.member')}</span>
                  <span>{t('team.shares.table.permission')}</span>
                  <span>{t('common.actions')}</span>
                </div>
                {shares.map((s) => (
                  <div className="tp-tr" key={`${s.profileId}::${s.memberId}`}>
                    <span className="tp-cell" title={s.profileId}>
                      {profileNameOf(s.profileId)}
                    </span>
                    <span className="tp-cell" title={s.memberId}>
                      {nameOf(s.memberId)}
                    </span>
                    <span>
                      <Badge tone={s.permission === 'manage' ? 'accent' : 'neutral'}>
                        {t(PERMISSION_KEY[s.permission])}
                      </Badge>
                    </span>
                    <span className="tp-actions">
                      <Button
                        size="sm"
                        variant="quiet"
                        title={t('team.shares.revokeTitle', {
                          member: nameOf(s.memberId),
                          profile: profileNameOf(s.profileId)
                        })}
                        onClick={() => void revokeShare(s.profileId, s.memberId)}
                      >
                        {t('team.shares.revoke')}
                      </Button>
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="tp-form">
              <Field label={t('team.shares.table.profile')}>
                <Select
                  options={
                    profiles.length === 0
                      ? [{ value: '', label: t('team.shares.noProfiles') }]
                      : profiles.map((p) => ({ value: p.id, label: p.name }))
                  }
                  value={shareProfileId}
                  disabled={busy || profiles.length === 0}
                  onChange={setShareProfileId}
                />
              </Field>
              <Field label={t('team.members.table.member')}>
                <Select
                  options={
                    shareCapable.length === 0
                      ? [{ value: '', label: t('team.shares.noMembers') }]
                      : shareCapable
                  }
                  value={shareMemberId}
                  disabled={busy || shareCapable.length === 0}
                  onChange={setShareMemberId}
                />
              </Field>
              <Field label={t('team.shares.table.permission')}>
                <Select
                  options={permissionOptions}
                  value={sharePermission}
                  disabled={busy}
                  onChange={(v) => setSharePermission(v as TeamProfileShare['permission'])}
                />
              </Field>
              <Button
                variant="primary"
                icon="check"
                disabled={busy || !shareProfileId || !shareMemberId}
                onClick={() => void setShare()}
              >
                {t('team.shares.set')}
              </Button>
            </div>
          </section>

          {/* ────────────────── 活动 ────────────────── */}
          <section className="tp-card">
            <div className="tp-card-head">
              <div>
                <h3>{t('team.activity.title')}</h3>
                <span>{t('team.activity.subtitle', { n: activity.length })}</span>
              </div>
              <Button size="sm" variant="ghost" icon="reload" onClick={() => void refreshActivity()}>
                {t('team.activity.refresh')}
              </Button>
            </div>

            {activity.length === 0 ? (
              <div className="tp-empty">
                <b>{t('team.activity.empty.title')}</b>
                <p>{t('team.activity.empty.body')}</p>
              </div>
            ) : (
              <div className="tp-activity">
                {activity.slice(0, activityShown).map((a) => (
                  <div className="tp-act" key={a.id}>
                    <span className="tp-act-dot" />
                    <div className="tp-act-main">
                      <div className="tp-act-line">
                        <b title={a.actorId}>{a.actorName}</b>
                        <span className="tp-act-action">{a.action}</span>
                        <span className="tp-act-target" title={a.detail ?? a.target}>
                          {a.detail ?? a.target}
                        </span>
                      </div>
                      <span className="tp-act-time" title={`${formatDate(a.at)} ${formatClock(a.at)}`}>
                        {formatRelative(a.at)}
                      </span>
                    </div>
                  </div>
                ))}
                {activityShown < activity.length ? (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0' }}>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setActivityShown((n) => n + ACTIVITY_STEP)}
                    >
                      {t('common.loadMore', { n: activity.length - activityShown })}
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
          </section>
        </>
      )}

      {/* 移除确认：只把成员名当文本节点渲染，绝不用 innerHTML —— 成员名是不可信输入 */}
      <Modal
        open={confirmRemoveId !== null}
        title={t('team.remove.title')}
        icon="trash"
        tone="danger"
        onClose={() => setConfirmRemoveId(null)}
        note={t('team.remove.note')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRemoveId(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" icon="trash" onClick={() => void removeMember()}>
              {t('team.remove.confirm')}
            </Button>
          </>
        }
      >
        <p>
          {t('team.remove.body', { name: removeTarget?.name ?? '' })}
          {removeTarget && isProtectedOwner(members, removeTarget.id)
            ? t('team.remove.lastOwner')
            : ''}
        </p>
      </Modal>
    </div>
  )
}
