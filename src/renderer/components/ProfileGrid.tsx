/**
 * 环境列表主视图：统计卡 + 分组筛选 + 卡片网格 + 批量操作栏。
 *
 * 所有派生数字（运行中、今日任务、成功率）都从真实 Profile / TaskRecord 算，
 * 没有数据就显示 0，不用假数据占位。
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { MaskRow, Profile, ProfileStatus, TaskRecord } from '@shared/types'
import { ProfileCard } from './ProfileCard'
import { AnimatedNumber, Button, Icon, Modal, Skeleton, cssVars, useToast } from './ui'
import { bridge, errorMessage } from '@renderer/lib/api'
import {
  formatClock,
  formatDate,
  formatRelative,
  isToday,
  platformLabel,
  profileNo,
  proxyAddress,
  profileStatusText
} from '@renderer/lib/format'
import { useI18n } from '@renderer/lib/i18n'
import { MASK_TONE_SHORT, maskHintOf, maskToneOf, pickWorstMaskRow } from '@shared/mask-ui'
import '../styles/profile-list.css'

export type BatchAction = 'start' | 'stop' | 'move' | 'proxy' | 'remove'

/**
 * 列表排序方式。
 *
 * `favorite` 作为默认：商业指纹浏览器里「收藏置顶 + 最近使用」是最常见的默认，
 * 用户把常用环境收藏后打开应用就能直接看到，不必每次找。
 */
type SortKey = 'recent' | 'name' | 'created' | 'favorite'

const SORT_STORAGE_KEY = 'ss:profile-sort'
const DEFAULT_SORT: SortKey = 'favorite'
const SORT_KEYS: readonly SortKey[] = ['recent', 'name', 'created', 'favorite']

/** 读排序偏好；localStorage 被禁用 / 值是脏的时回落到默认（收藏优先） */
function loadSort(): SortKey {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY)
    return SORT_KEYS.includes(raw as SortKey) ? (raw as SortKey) : DEFAULT_SORT
  } catch {
    return DEFAULT_SORT
  }
}

/**
 * 分组筛选的内部哨兵值。
 * 显示文案走 i18n，但 App 的初始 state 与这里的比较逻辑共用同一批字符串，
 * 所以它们不是文案，不能在组件里翻译。
 */
const ALL_GROUP = '全部'
const UNGROUPED = '未分组'
/**
 * 主进程建环境时把 group 默认写成字面量「默认」。它是**数据**，不是文案，
 * 英文界面下直接渲染会漏出一句中文。展示层统一过这个映射；存储值不动，
 * 否则既有环境的分组会在升级后全部变成「未分组」。
 */
const DEFAULT_GROUP_STORED = '默认'

/** 列表视图的状态文案键；色调仍由 `profileStatusText` 给出，不在这里另判。 */
const PROFILE_STATUS_KEY: Record<ProfileStatus, string> = {
  idle: 'profiles.status.idle',
  starting: 'profiles.status.starting',
  running: 'profiles.status.running',
  error: 'profiles.status.failed'
}

/**
 * 回收站的删除时间：`2026-11-18 09:41:03`。
 *
 * 用绝对时间而不是「3 天前」：回收站的首要问题是「这个还能不能恢复」，
 * 用户需要的是一个可核对的时间点；相对时间在列表停留几分钟后就失准了。
 */
function deletedAtText(deletedAt: number | null | undefined): string {
  if (typeof deletedAt !== 'number') return '—'
  return `${formatDate(deletedAt)} ${formatClock(deletedAt)}`
}

/**
 * 首屏快照的三态，和 App 里的 ConsoleLoadState 同形。
 * 这里按结构声明而非 import 类型，避免面板 ↔ App 的循环依赖；TS 按结构匹配。
 */
interface GridLoadState {
  kind: 'loading' | 'error' | 'ready'
  message?: string
}

interface ProfileGridProps {
  profiles: Profile[]
  tasks: TaskRecord[]
  /**
   * 每个窗口此刻的伪装读数，由主进程用 `judgeMask` 判完下发。
   *
   * 只含有读数的窗口：环境在跑但还没回读时这里查不到 —— 卡片必须按
   * 「不可逆动作被拦」显示（门禁此刻就是拒绝的），不能当成正常。
   */
  maskRows: MaskRow[]
  /** 已选中的环境 id。Set 而不是数组：卡片里 `has(id)` 是 O(1)，全选/批量不用 includes */
  selected: Set<string>
  query: string
  group: string
  loading: boolean
  /** 首屏快照三态；读失败态带原文，渲染成独立的琥珀色错误块，绝不当成空。 */
  loadState: GridLoadState
  /** 重新读取整份控制台快照（环境 / 任务 / 设置 / 伪装）。 */
  onRetry: () => void
  bridgeOk: boolean
  onGroup: (group: string) => void
  onSelect: (id: string) => void
  onSelectAll: (ids: string[]) => void
  onClearSelection: () => void
  onOpen: (id: string) => void
  onConfig: (id: string) => void
  /** 收藏 / 置顶（卡片标题行的星标） */
  onToggleFavorite: (id: string) => void
  onNew: () => void
  /** 批量新建 N 个环境（商业产品普遍有的 bulk create） */
  onBulkCreate: (count: number) => void
  onBatch: (action: BatchAction, ids: string[], value?: string) => void
}

export function ProfileGrid({
  profiles,
  tasks,
  maskRows,
  selected,
  query,
  group,
  loading,
  loadState,
  onRetry,
  bridgeOk,
  onGroup,
  onSelect,
  onSelectAll,
  onClearSelection,
  onOpen,
  onConfig,
  onToggleFavorite,
  onNew,
  onBulkCreate,
  onBatch
}: ProfileGridProps) {
  const { t } = useI18n()
  /** 分组名的展示文案：存储值 '默认' → 当前语言；空串 → 未分组 */
  const groupText = useCallback(
    (group: string): string => {
      if (!group) return t('profiles.ungrouped')
      if (group === DEFAULT_GROUP_STORED) return t('profiles.group.default')
      return group
    },
    [t]
  )
  const toast = useToast()
  const [modal, setModal] = useState<{ kind: 'move' | 'proxy'; value: string } | null>(null)
  // 批量新建弹窗：count 用字符串存，允许用户清空重填（中间态）
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkCount, setBulkCount] = useState('5')

  /**
   * 回收站视图状态。
   *
   * 数据**不能**从 `profiles` 里筛：`list()` 已经在主进程排除了 `deletedAt`
   * 非空的记录，渲染层手里根本没有回收站数据。进入回收站时单独调
   * `window.ss.profiles.trash()`，放在局部 state —— 这份数据只服务这个视图，
   * 不需要污染 App 的全局快照。
   */
  const [trashView, setTrashView] = useState(false)
  const [trashItems, setTrashItems] = useState<Profile[]>([])
  const [trashLoading, setTrashLoading] = useState(false)
  const [trashError, setTrashError] = useState<string | null>(null)
  /** 彻底删除的二次确认目标；null 表示弹窗关闭 */
  const [purgeTarget, setPurgeTarget] = useState<Profile | null>(null)
  /** 正在恢复/彻底删除的环境 id：防连点，也用于禁用另一颗按钮 */
  const [busyId, setBusyId] = useState<string | null>(null)

  const loadTrash = useCallback(async (): Promise<void> => {
    setTrashLoading(true)
    setTrashError(null)
    try {
      const list = await bridge().profiles.trash()
      // 验形而不是只靠 try/catch：IPC 少包一层 Result 时拿到的是 undefined，
      // catch 根本不会触发，setTrashItems(undefined) 之后渲染里的 .map()
      // 直接抛，React 卸载整棵树 —— 用户看到的是白屏，不是"读失败"。
      if (!Array.isArray(list)) throw new Error('回收站列表返回了无法识别的结果')
      setTrashItems(list)
    } catch (err) {
      // 读失败 ≠ 回收站为空：清空旧数据会把「读不到」伪装成「没有」，
      // 与正常列表的 loadState 同一条原则。
      setTrashItems([])
      const message = errorMessage(err)
      setTrashError(message)
      toast.push(message, 'err')
    } finally {
      setTrashLoading(false)
    }
  }, [toast])

  // 进入回收站时拉一次；离开不主动清空，下次进入会重新拉（数据可能已变）。
  useEffect(() => {
    if (!trashView) return
    void loadTrash()
  }, [trashView, loadTrash])

  /**
   * 切换回收站视图。
   *
   * 进入时先把 `trashLoading` 置 true 再切视图：effect 要等这一帧渲染完才跑，
   * 否则第一次进入会先闪一下「回收站是空的」，再变成骨架 —— 那一帧会让人
   * 真的以为回收站是空的。
   */
  const toggleTrashView = useCallback(() => {
    if (!trashView) setTrashLoading(true)
    setTrashView((on) => !on)
  }, [trashView])

  const restoreFromTrash = useCallback(
    async (id: string): Promise<void> => {
      setBusyId(id)
      try {
        const restored = await bridge().profiles.restore(id)
        toast.push(t('profiles.trash.restored', { name: restored.name }), 'ok')
        await loadTrash()
        // 恢复后环境回到正常列表：触发一次控制台快照刷新，
        // 否则用户切回去只能看到一份旧的 profiles 数组。
        onRetry()
      } catch (err) {
        toast.push(errorMessage(err), 'err')
      } finally {
        setBusyId(null)
      }
    },
    [loadTrash, onRetry, t, toast]
  )

  const confirmPurge = useCallback(async (): Promise<void> => {
    const target = purgeTarget
    if (target === null) return
    setBusyId(target.id)
    try {
      await bridge().profiles.purge(target.id)
      toast.push(t('profiles.trash.purged', { name: target.name }), 'ok')
      setPurgeTarget(null)
      await loadTrash()
      onRetry()
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setBusyId(null)
    }
  }, [loadTrash, onRetry, purgeTarget, t, toast])

  /**
   * 搜索延迟渲染。
   *
   * 200 个环境 × 40-60 个 DOM 节点，直接绑 `query` 的话每敲一个键都要重算
   * filter 并重渲染整片网格（20-45ms），输入框会明显发卡。
   * `useDeferredValue` 让 React 先用旧的关键词完成这次紧急渲染（输入框立刻响应），
   * 再在低优先级里用新关键词重算 —— 结果最终一致，只是晚一帧。
   */
  const deferredQuery = useDeferredValue(query)

  // 网格 / 列表只是「这个用户此刻想怎么看」的显示偏好，与身份、配置无关：
  // 既不落盘也不走 IPC，放渲染层局部 state 最合适。默认网格 = 零回归。
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')

  /** 排序偏好：和视图密度一样是纯显示偏好，存 localStorage、不走 IPC */
  const [sort, setSort] = useState<SortKey>(loadSort)
  useEffect(() => {
    try {
      localStorage.setItem(SORT_STORAGE_KEY, sort)
    } catch {
      // 存不了就算了（隐私模式 / 配额满），本次会话仍然生效
    }
  }, [sort])

  const groups = useMemo(() => {
    const map = new Map<string, number>()
    profiles.forEach((p) => {
      const key = p.group || UNGROUPED
      map.set(key, (map.get(key) ?? 0) + 1)
    })
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1])
  }, [profiles])

  const stats = useMemo(() => {
    const running = profiles.filter((p) => p.status === 'running' || p.status === 'starting').length
    const errors = profiles.filter((p) => p.status === 'error').length
    const todayTasks = tasks.filter((t) => isToday(t.startedAt))
    const todayDone = todayTasks.filter((t) => t.status === 'done').length
    const todayFailed = todayTasks.filter((t) => t.status === 'failed').length

    const week = tasks.filter((t) => Date.now() - t.startedAt < 7 * 86_400_000)
    const settled = week.filter((t) => t.status === 'done' || t.status === 'failed')
    const ok = settled.filter((t) => t.status === 'done').length
    const rate = settled.length > 0 ? (ok / settled.length) * 100 : 0

    return { running, errors, todayTasks: todayTasks.length, todayDone, todayFailed, rate, settled: settled.length }
  }, [profiles, tasks])

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    return profiles.filter((p) => {
      if (group !== ALL_GROUP && (p.group || UNGROUPED) !== group) return false
      if (!q) return true
      const haystack = [
        p.name,
        p.group,
        p.note,
        ...p.tags,
        p.proxy ? `${p.proxy.host}:${p.proxy.port}` : '',
        p.fingerprint.locale,
        p.fingerprint.timezone
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [profiles, group, deferredQuery])

  /**
   * 排序在筛选之后、渲染之前做。
   *
   * 不把排序塞进 `filtered` 的同一个 useMemo：两者的依赖不同（排序变化不需要
   * 重新做一次文本匹配），拆开之后切换排序只复制数组、不重跑搜索。
   * 每个分支都先 `slice()`，否则 sort 会原地改掉 filtered 的顺序。
   */
  const sorted = useMemo(() => {
    const list = filtered.slice()
    // null 的 lastUsedAt 当 0：时间戳恒为正，于是「从未使用」自然排在最后
    const byLastUsed = (a: Profile, b: Profile): number =>
      (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)

    switch (sort) {
      case 'recent':
        list.sort(byLastUsed)
        break
      case 'name':
        // undefined locale = 系统默认排序，跟随用户语言环境
        list.sort((a, b) => a.name.localeCompare(b.name))
        break
      case 'created':
        list.sort((a, b) => b.createdAt - a.createdAt)
        break
      case 'favorite':
      default:
        list.sort(
          (a, b) =>
            Number(b.favorite === true) - Number(a.favorite === true) || byLastUsed(a, b)
        )
        break
    }
    return list
  }, [filtered, sort])

  // 批量操作接口收 string[]（App 的 runBatch 也按数组处理）；
  // Set 只在渲染层用，出界前转一次数组。
  const selectedIds = useMemo(() => Array.from(selected), [selected])

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((p) => selected.has(p.id))

  /** 全选 / 取消全选当前筛选结果。useCallback 稳定引用，避免工具栏无谓重渲染 */
  const toggleSelectAll = useCallback(() => {
    onSelectAll(allFilteredSelected ? [] : filtered.map((p) => p.id))
  }, [allFilteredSelected, filtered, onSelectAll])

  const closeModal = useCallback(() => setModal(null), [])

  /**
   * profileId → 这个环境最坏的一条读数。
   *
   * 一个环境可以有多个窗口，各自状态不同。挑最坏的那条显示：
   * 画绿点等于把另一个窗口的回滚藏起来，而用户看到绿点就不会去点开它。
   */
  const maskByProfile = useMemo(() => {
    const grouped = new Map<string, MaskRow[]>()
    for (const row of maskRows) {
      const bucket = grouped.get(row.profileId)
      if (bucket === undefined) grouped.set(row.profileId, [row])
      else bucket.push(row)
    }
    const map = new Map<string, MaskRow>()
    for (const [profileId, rows] of grouped) {
      const worst = pickWorstMaskRow(rows)
      if (worst !== null) map.set(profileId, worst as MaskRow)
    }
    return map
  }, [maskRows])

  const taskByProfile = useMemo(() => {
    const map = new Map<string, TaskRecord>()
    tasks.forEach((t) => {
      if (t.status === 'running' && !map.has(t.profileId)) map.set(t.profileId, t)
    })
    return map
  }, [tasks])

  return (
    <>
      <div className="page-head">
        <div>
          <h2>{t('profiles.title')}</h2>
          <p>
            {trashView ? (
              <>
                <b>{trashItems.length}</b> {t('profiles.trash.subtitle')} ·{' '}
                {t('profiles.trash.irreversible')}
              </>
            ) : (
              <>
                <b>{profiles.length}</b> {t('profiles.subtitle.isolated')} ·{' '}
                <b>{stats.running}</b> {t('profiles.subtitle.running')} ·{' '}
                {stats.errors > 0 ? (
                  <b>{t('profiles.subtitle.needsAttention', { n: stats.errors })}</b>
                ) : (
                  t('profiles.subtitle.allReady')
                )}
              </>
            )}
          </p>
        </div>
        <div className="seg" role="group" aria-label={t('profiles.view.density')}>
          <button
            type="button"
            className={viewMode === 'grid' ? 'on' : ''}
            aria-label={t('profiles.view.grid')}
            aria-pressed={viewMode === 'grid'}
            onClick={() => setViewMode('grid')}
          >
            <Icon name="grid" size={13} />
          </button>
          <button
            type="button"
            className={viewMode === 'list' ? 'on' : ''}
            aria-label={t('profiles.view.list')}
            aria-pressed={viewMode === 'list'}
            onClick={() => setViewMode('list')}
          >
            <Icon name="list" size={13} />
          </button>
        </div>
      </div>

      {/* 回收站里不显示「今日任务 / 成功率」这些在跑数据：
          它们统计的是正常环境，摆在回收站上方会让人以为回收站也有 14 个环境。 */}
      {trashView ? null : (
      <div className="stats">
        <div className="stat">
          <div className="k">
            <i />
            {t('profiles.stat.total')}
          </div>
          <div className="v"><AnimatedNumber value={profiles.length} /></div>
          <div className="d">
            {t('profiles.stat.totalDesc', { n: groups.length })}
            {stats.errors > 0 ? t('profiles.stat.errorSuffix', { n: stats.errors }) : ''}
          </div>
        </div>
        <div className="stat">
          <div className="k">
            <i className="g" />
            {t('profiles.stat.running')}
          </div>
          <div className="v">
            <AnimatedNumber value={stats.running} />
            <small>{t('profiles.stat.runningUnit')}</small>
          </div>
          <div className="d">{t('profiles.stat.managed', { n: taskByProfile.size })}</div>
        </div>
        <div className="stat">
          <div className="k">
            <i />
            {t('profiles.stat.today')}
          </div>
          <div className="v"><AnimatedNumber value={stats.todayTasks} /></div>
          <div className="d">
            {t('profiles.stat.todayDesc', {
              done: stats.todayDone,
              failed: stats.todayFailed
            })}
          </div>
        </div>
        <div className="stat">
          <div className="k">
            <i className="a" />
            {t('profiles.stat.rate')}
          </div>
          <div className="v">
            {stats.settled > 0 ? (
              <AnimatedNumber value={Math.round(stats.rate)} format={(n) => String(n)} />
            ) : (
              '—'
            )}
            {stats.settled > 0 ? <small>%</small> : null}
          </div>
          <div className="d">{t('profiles.stat.rateDesc', { n: stats.settled })}</div>
        </div>
      </div>
      )}

      <div className="toolbar">
        {trashView ? (
          <div className="tabs">
            <button type="button" className="tab on">
              {t('profiles.trash.title')} <span className="n">{trashItems.length}</span>
            </button>
          </div>
        ) : (
          <div className="tabs">
            <button
              type="button"
              className={`tab${group === ALL_GROUP ? ' on' : ''}`}
              onClick={() => onGroup(ALL_GROUP)}
            >
              {t('profiles.filter.all')} <span className="n">{profiles.length}</span>
            </button>
            {groups.map(([name, count]) => (
              <button
                key={name}
                type="button"
                className={`tab${group === name ? ' on' : ''}`}
                onClick={() => onGroup(name)}
                title={name}
              >
                <span className="tab-name">
                  {groupText(name)}
                </span>{' '}
                <span className="n">{count}</span>
              </button>
            ))}
          </div>
        )}
        <div className="spacer" />
        {/* 排序 / 全选 / 新建 / 批量新建都只对正常列表有意义：
            回收站里没有分组筛选、没有批量启动，也不该从回收站「新建」。 */}
        {trashView ? null : (
          <>
            <select
              className="filter-btn"
              value={sort}
              aria-label={t('profiles.sort.label')}
              title={t('profiles.sort.label')}
              onChange={(e) => setSort(e.target.value as SortKey)}
            >
              <option value="recent">{t('profiles.sort.recent')}</option>
              <option value="name">{t('profiles.sort.name')}</option>
              <option value="created">{t('profiles.sort.created')}</option>
              <option value="favorite">{t('profiles.sort.favorite')}</option>
            </select>
            <button
              type="button"
              className="filter-btn"
              onClick={toggleSelectAll}
              title={t('profiles.selectAllTitle')}
            >
              <Icon name="check" size={12} strokeWidth={2.2} />
              {allFilteredSelected ? t('profiles.deselectAll') : t('profiles.selectAll')}
            </button>
            <button type="button" className="filter-btn" onClick={onNew}>
              <Icon name="plus" size={12} strokeWidth={2.2} />
              {t('profiles.new')}
            </button>
            <button type="button" className="filter-btn" onClick={() => setBulkOpen(true)} title={t('profiles.bulk.title')}>
              <Icon name="grid" size={12} strokeWidth={2.2} />
              {t('profiles.bulk.button')}
            </button>
          </>
        )}
        <button
          type="button"
          className="filter-btn"
          aria-pressed={trashView}
          title={trashView ? t('profiles.trash.back') : t('profiles.trash.toggle')}
          onClick={toggleTrashView}
          style={
            trashView
              ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
              : undefined
          }
        >
          <Icon name={trashView ? 'chevronLeft' : 'trash'} size={12} strokeWidth={2.2} />
          {trashView ? t('profiles.trash.back') : t('profiles.trash.toggle')}
        </button>
      </div>

      {!bridgeOk ? (
        <div className="bridge-warn">
          <Icon name="alert" size={13} strokeWidth={2} />
          {t('profiles.bridgeWarn')}
        </div>
      ) : null}

      <div className={trashView || viewMode === 'list' ? 'grid pl-wrap' : 'grid'}>
        {trashView ? (
          trashError !== null ? (
            /* 回收站读失败也要说「没读到」，不能显示成空态 —— 空态会被读成
               「回收站里没有环境」，而真实情况可能是记录还在、只是没读到。 */
            <div className="load-error">
              <div className="le-mark">
                <Icon name="alert" size={20} strokeWidth={2.2} />
              </div>
              <h3>{t('profiles.error.title')}</h3>
              <p className="le-reason">{trashError}</p>
              <p className="le-hint">{t('profiles.error.hint')}</p>
              <Button variant="ghost" icon="reload" onClick={() => void loadTrash()}>
                {t('common.retry')}
              </Button>
            </div>
          ) : trashLoading && trashItems.length === 0 ? (
            <div className="grid" aria-busy="true" aria-label={t('profiles.loadingAria')}>
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="env env-skel" aria-hidden="true">
                  <Skeleton width="60%" height="14px" radius="var(--r-sm)" />
                  <Skeleton width="40%" height="11px" radius="var(--r-sm)" />
                  <div className="env-skel-rows">
                    <Skeleton width="80%" height="10px" radius="var(--r-sm)" />
                    <Skeleton width="65%" height="10px" radius="var(--r-sm)" />
                  </div>
                  <Skeleton width="100%" height="26px" radius="var(--r-sm)" />
                </div>
              ))}
            </div>
          ) : trashItems.length === 0 ? (
            <div className="empty">
              <div className="mark">
                <Icon name="trash" size={20} strokeWidth={2.2} />
              </div>
              <h3>{t('profiles.trash.title')}</h3>
              <p>{t('profiles.trash.empty')}</p>
            </div>
          ) : (
            <table className="pl-table pl-table-trash">
              <colgroup>
                <col style={{ width: '42%' }} />
                <col style={{ width: '180px' }} />
                <col style={{ width: '190px' }} />
                <col style={{ width: '190px' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>{t('profiles.table.name')}</th>
                  <th>{t('profiles.table.group')}</th>
                  <th>{t('profiles.trash.deletedAt')}</th>
                  <th className="pl-cell-actions">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {trashItems.map((p) => (
                  <tr key={p.id} style={{ cursor: 'default' }}>
                    <td>
                      <div className="pl-name">
                        <span className="pl-no">{profileNo(p.id)}</span>
                        <span className="pl-title">{p.name}</span>
                      </div>
                    </td>
                    <td className="pl-group">{groupText(p.group)}</td>
                    <td>{deletedAtText(p.deletedAt)}</td>
                    <td className="pl-cell-actions">
                      <div className="pl-actions">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busyId === p.id}
                          onClick={() => void restoreFromTrash(p.id)}
                        >
                          {t('profiles.trash.restore')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busyId === p.id}
                          onClick={() => setPurgeTarget(p)}
                        >
                          {t('profiles.trash.purge')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : loadState.kind === 'error' ? (
          /* 读失败 ≠ 空：琥珀色、带错误原文、带「重试」。容器用实线琥珀边框，
             和下面的空态（虚线卡片 + 品牌柔光 + 绿色新建按钮）一眼可分。
             不知道就是不知道，不能用空态替系统下「没有环境」的结论。 */
          <div className="load-error">
            <div className="le-mark">
              <Icon name="alert" size={20} strokeWidth={2.2} />
            </div>
            <h3>{t('profiles.error.title')}</h3>
            <p className="le-reason">{loadState.message}</p>
            <p className="le-hint">{t('profiles.error.hint')}</p>
            <Button variant="ghost" icon="reload" onClick={onRetry}>
              {t('common.retry')}
            </Button>
          </div>
        ) : loading ? (
          /* 骨架卡片：与真实卡片同尺寸（.grid 的列宽由 CSS 控制），
             让用户看到「正在来的东西长这样」，而不是一块孤零零的文字。 */
          <div className="grid" aria-busy="true" aria-label={t('profiles.loadingAria')}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="env env-skel" aria-hidden="true">
                <Skeleton width="60%" height="14px" radius="var(--r-sm)" />
                <Skeleton width="40%" height="11px" radius="var(--r-sm)" />
                <div className="env-skel-rows">
                  <Skeleton width="80%" height="10px" radius="var(--r-sm)" />
                  <Skeleton width="65%" height="10px" radius="var(--r-sm)" />
                </div>
                <Skeleton width="100%" height="26px" radius="var(--r-sm)" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty">
            <div className="mark">
              <Icon name="wave" size={20} strokeWidth={2.2} />
            </div>
            <h3>{profiles.length === 0 ? t('profiles.empty.createTitle') : t('profiles.empty.noMatchTitle')}</h3>
            <p>
              {profiles.length === 0
                ? t('profiles.empty.createDesc')
                : t('profiles.empty.noMatchDesc')}
            </p>
            <Button
              variant="primary"
              icon="plus"
              onClick={() => (profiles.length === 0 ? onNew() : onGroup(ALL_GROUP))}
            >
              {profiles.length === 0 ? t('profiles.empty.createAction') : t('profiles.empty.showAllAction')}
            </Button>
            <div className="hint">{t('profiles.empty.hint')}</div>
          </div>
        ) : viewMode === 'list' ? (
          <table className="pl-table">
            <colgroup>
              <col style={{ width: '30%' }} />
              <col style={{ width: '104px' }} />
              <col style={{ width: '144px' }} />
              <col style={{ width: '148px' }} />
              <col style={{ width: '150px' }} />
              <col style={{ width: '116px' }} />
              <col style={{ width: '148px' }} />
            </colgroup>
            <thead>
              <tr>
                <th>{t('profiles.table.name')}</th>
                <th>{t('profiles.table.platform')}</th>
                <th>{t('profiles.table.group')}</th>
                <th>{t('common.status')}</th>
                <th>{t('profiles.table.proxy')}</th>
                <th>{t('profiles.table.lastUsed')}</th>
                <th className="pl-cell-actions">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => {
                const running = Boolean(taskByProfile.get(p.id)?.status === 'running')
                const starting = p.status === 'starting'
                // 与卡片同一套：最坏读数 + maskToneOf，不在这里另判严重度。
                const worst = maskByProfile.get(p.id) ?? null
                const tone = maskToneOf(worst, running || starting)
                const status = profileStatusText(p.status)
                return (
                  <tr
                    key={p.id}
                    className={selected.has(p.id) ? 'pl-sel' : ''}
                    onClick={() => onOpen(p.id)}
                    tabIndex={0}
                    aria-selected={selected.has(p.id)}
                    onKeyDown={(e) => {
                      // 整行可聚焦：列表视图是表格，键盘用户不该只能 Tab 到
                      // 复选框和两个按钮。Enter / Space 与卡片保持同一语义。
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onOpen(p.id)
                      }
                    }}
                  >
                    <td>
                      <div className="pl-name">
                        <button
                          type="button"
                          className={`cb${selected.has(p.id) ? ' on' : ''}`}
                          aria-label={selected.has(p.id) ? t('profiles.deselect') : t('profiles.select')}
                          aria-pressed={selected.has(p.id)}
                          onClick={(e) => {
                            e.stopPropagation()
                            onSelect(p.id)
                          }}
                        >
                          <Icon name="check" size={9} strokeWidth={3.5} />
                        </button>
                        <span className="pl-no">{profileNo(p.id)}</span>
                        <span className="pl-title" title={p.lastError ?? undefined}>
                          {p.name}
                        </span>
                        <button
                          type="button"
                          className={`pl-fav${p.favorite ? ' on' : ''}`}
                          aria-label={
                            p.favorite ? t('profiles.favorite.remove') : t('profiles.favorite.add')
                          }
                          aria-pressed={Boolean(p.favorite)}
                          onClick={(e) => {
                            e.stopPropagation()
                            onToggleFavorite(p.id)
                          }}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <span aria-hidden="true">{p.favorite ? '★' : '☆'}</span>
                        </button>
                      </div>
                    </td>
                    <td>{platformLabel(p.platform)}</td>
                    <td className="pl-group">{groupText(p.group)}</td>
                    <td>
                      <div className="pl-status">
                        <span className={`dot-s ${status.tone}`} />
                        {t(PROFILE_STATUS_KEY[p.status])}
                        {tone !== 'idle' ? (
                          <span
                            className={`mask-dot ${tone}`}
                            title={maskHintOf(worst, running || starting)}
                            aria-label={t('profiles.mask.aria', {
                              state: t(`profiles.mask.tone.${tone}`)
                            })}
                          >
                            <i />
                            {MASK_TONE_SHORT[tone] !== '' ? (
                              <em>{t(`profiles.mask.short.${tone}`)}</em>
                            ) : null}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="pl-proxy">
                      {p.proxy ? proxyAddress(p) : t('profiles.direct')}
                    </td>
                    <td className="pl-last">{formatRelative(p.lastUsedAt)}</td>
                    <td className="pl-cell-actions">
                      <div className="pl-actions" onClick={(e) => e.stopPropagation()}>
                        <Button size="sm" variant="ghost" onClick={() => onConfig(p.id)}>
                          {t('profiles.configure')}
                        </Button>
                        <Button size="sm" variant="primary" onClick={() => onOpen(p.id)}>
                          {t('profiles.open')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          sorted.map((p) => (
            <ProfileCard
              key={p.id}
              profile={p}
              task={taskByProfile.get(p.id)}
              mask={maskByProfile.get(p.id) ?? null}
              selected={selected.has(p.id)}
              onSelect={onSelect}
              onOpen={onOpen}
              onConfig={onConfig}
              onToggleFavorite={onToggleFavorite}
            />
          ))
        )}
      </div>

      {!trashView && selected.size > 0 ? (
        <div className="batch" style={cssVars({ '--n': selected.size })}>
          <div className="n">
            {t('profiles.batch.selected', { n: selected.size })}{' '}
            <span>{t('profiles.batch.total', { n: profiles.length })}</span>
          </div>
          <div className="vline" />
          <button type="button" onClick={() => onBatch('start', selectedIds)}>
            <Icon name="play" size={12} strokeWidth={2} />
            {t('profiles.batch.start')}
          </button>
          <button type="button" onClick={() => onBatch('stop', selectedIds)}>
            <Icon name="square" size={12} strokeWidth={2} />
            {t('profiles.batch.stop')}
          </button>
          <button type="button" onClick={() => setModal({ kind: 'move', value: '' })}>
            <Icon name="folder" size={12} strokeWidth={2} />
            {t('profiles.action.moveGroup')}
          </button>
          <button
            type="button"
            onClick={() =>
              setModal({ kind: 'proxy', value: profiles.find((p) => p.id === selectedIds[0])?.proxy?.host ?? '' })
            }
          >
            <Icon name="globe" size={12} strokeWidth={2} />
            {t('profiles.action.switchProxy')}
          </button>
          <button type="button" className="danger" onClick={() => onBatch('remove', selectedIds)}>
            <Icon name="trash" size={12} strokeWidth={2} />
            {t('common.delete')}
          </button>
          <div className="vline" />
          <button
            type="button"
            className="close"
            aria-label={t('profiles.clearSelection')}
            onClick={onClearSelection}
          >
            <Icon name="close" size={12} strokeWidth={2} />
          </button>
        </div>
      ) : null}

      <Modal
        open={modal !== null}
        title={
          t(modal?.kind === 'move' ? 'profiles.action.moveGroup' : 'profiles.action.switchProxy')
        }
        icon={modal?.kind === 'move' ? 'folder' : 'globe'}
        tone="accent"
        align="left"
        maxWidth={340}
        onClose={closeModal}
        footer={
          <>
            <Button variant="ghost" onClick={closeModal}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (!modal) return
                const value = modal.value.trim()
                if (modal.kind === 'move' && value) onBatch('move', selectedIds, value)
                if (modal.kind === 'proxy' && value) onBatch('proxy', selectedIds, value)
                closeModal()
              }}
            >
              {t('profiles.modal.applyTo', { n: selected.size })}
            </Button>
          </>
        }
        note={modal?.kind === 'proxy' ? t('profiles.modal.proxyNote') : undefined}
      >
        <div className="m-field">
          <label>
            {t(modal?.kind === 'move' ? 'profiles.modal.groupName' : 'profiles.modal.proxyAddress')}
          </label>
          <input
            className="set-input"
            value={modal?.value ?? ''}
            autoFocus
            placeholder={t(
              modal?.kind === 'move'
                ? 'profiles.modal.groupPlaceholder'
                : 'profiles.modal.proxyPlaceholder'
            )}
            onChange={(e) =>
              setModal((m) => (m ? { ...m, value: e.target.value } : { kind: 'move', value: '' }))
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter' && modal) {
                const value = modal.value.trim()
                if (modal.kind === 'move' && value) onBatch('move', selectedIds, value)
                if (modal.kind === 'proxy' && value) onBatch('proxy', selectedIds, value)
                closeModal()
              }
            }}
          />
        </div>
        </Modal>

      {/* 批量新建：商业指纹浏览器普遍有 bulk create（一次建 5–20 个环境） */}
      <Modal
        open={bulkOpen}
        title={t('profiles.bulk.title')}
        icon="grid"
        tone="accent"
        align="left"
        maxWidth={340}
        onClose={() => setBulkOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBulkOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const n = Number.parseInt(bulkCount, 10)
                if (Number.isFinite(n) && n > 0) onBulkCreate(n)
                setBulkOpen(false)
              }}
            >
              {t('profiles.bulk.confirm')}
            </Button>
          </>
        }
        note={t('profiles.bulk.note')}
      >
        <div className="m-field">
          <label>{t('profiles.bulk.count')}</label>
          <input
            className="set-input"
            value={bulkCount}
            autoFocus
            inputMode="numeric"
            onChange={(e) => setBulkCount(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const n = Number.parseInt(bulkCount, 10)
                if (Number.isFinite(n) && n > 0) onBulkCreate(n)
                setBulkOpen(false)
              }
            }}
          />
        </div>
      </Modal>

      {/* 彻底删除：回收站里唯一不可逆的动作，必须二次确认。
          文案把「清 Cookie / localStorage / IndexedDB」写出来 —— 用户以为
          「删环境 = 删记录」，而真正不可恢复的是站点数据。 */}
      <Modal
        open={purgeTarget !== null}
        title={t('profiles.trash.purgeConfirmTitle')}
        icon="trash"
        tone="danger"
        onClose={() => {
          if (busyId === null) setPurgeTarget(null)
        }}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={busyId !== null}
              onClick={() => setPurgeTarget(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={busyId !== null}
              onClick={() => void confirmPurge()}
            >
              {t('profiles.trash.purge')}
            </Button>
          </>
        }
        note={t('profiles.trash.purgeConfirmNote')}
      >
        <p>{purgeTarget?.name}</p>
      </Modal>
    </>
  )
}