/**
 * 双轨浏览器窗口外壳。
 *
 * 关键约束：网页不是 React 渲染的，而是主进程的 WebContentsView 叠在窗口上。
 * 所以这里只做三件事：
 * 1. 画固定高度的标题条 / 标签条 / 地址栏 / 底部控制条；
 * 2. 中间留出一块空的 `.stage`，并用 ResizeObserver 把它的矩形（Math.round 后）
 *    通过 window.ss.window.setContentInsets 报给主进程，让网页视图精确铺满；
 * 3. AI 侧栏展开时把 panelWidth 一起报上去，主进程据此收缩网页视图。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { Profile, Settings, TaskRecord, WindowState, BrowserTab } from '@shared/types'
import { AgentPanel } from './AgentPanel'
import { Button, Icon, cssVars, useToast } from './ui'
import { bridge, errorMessage, reportContentInsets } from '@renderer/lib/api'
import { useI18n } from '@renderer/lib/i18n'
import { filterTabs, groupColor, groupTabs } from '@renderer/lib/tab-groups'
import type { TabGroupMap } from '@renderer/lib/tab-groups'
import '../styles/browser-tabs.css'
import '../styles/browser-shell-polish.css'
import {
  chromeMajor,
  formatDuration,
  osShortLabel,
  stepResultText,
  tzOffsetLabel
} from '@renderer/lib/format'

/**
 * 影子轨宽度百分比（100 - 人轨）。可拖拽调整，clamp 到 [30, 70]，
 * 避免拖到任一侧完全消失。默认 43（与 CSS 原值一致）。
 *
 * 这个值会随 report() 上报给主进程，主进程按它摆网页视图 —— 占位设计与
 * 真实页面必须用同一个比例，否则拖完手柄两边就对不上了。
 */
const DEFAULT_SHADOW_WIDTH = 43
/**
 * 单栏最小宽度（px）。**必须与主进程 windows.ts 的 MIN_PANE 一致**：
 * 主进程摆放网页视图时按它兜底，渲染层拖动手柄时按它夹紧，两边用同一个数，
 * 占位设计与真实页面才永远对齐。
 */
const MIN_PANE_PX = 320
const PROGRESS_CELLS = 20
const GROUP_STORAGE_PREFIX = 'ss:tab-groups:'
const LAYOUT_STORAGE_KEY = 'ss:tab-layout'

/**
 * 从 URL 拆出 origin（scheme://host）与 path（其余）。
 * 为什么强调 origin：Chrome/Edge 都把 origin 加粗、路径弱化，让用户一眼
 * 判断「在哪个站」——钓鱼域名与正确域名只差一两个字符，origin 强调能救命。
 * 解析失败（about:/file:/data: 等）时整串当 path、origin 为空，原样显示。
 */
function originOf(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol === 'http:' || u.protocol === 'https:') return `${u.protocol}//${u.host}`
  } catch { /* 非 URL 原样 */ }
  return ''
}

function pathOf(url: string): string {
  const origin = originOf(url)
  if (origin && url.startsWith(origin)) return url.slice(origin.length) || '/'
  return url
}

/**
 * 分组与布局偏好存在 localStorage 而不是走 IPC：
 * 这一期分组只是渲染层的视觉组织，不是浏览器身份，主进程不拥有它的语义。
 * 按 profileId 加前缀，避免 A 环境的分组串到 B 环境；读失败一律当空，
 * 丢分组只是少一层整理，不该影响正常浏览。
 */
function readGroups(key: string): TabGroupMap {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: TabGroupMap = {}
      for (const [id, label] of Object.entries(parsed)) {
        if (typeof label === 'string' && label.trim()) out[id] = label
      }
      return out
    }
  } catch {
    // 读不到就当没有分组
  }
  return {}
}

function readLayout(): 'horizontal' | 'vertical' {
  try {
    return localStorage.getItem(LAYOUT_STORAGE_KEY) === 'vertical' ? 'vertical' : 'horizontal'
  } catch {
    return 'horizontal'
  }
}

interface BrowserShellProps {
  state: WindowState | null
  profile: Profile | null
  task: TaskRecord | undefined
  settings: Settings
  onClose: () => void
  onSettingsSaved: (next: Settings) => void
}

export function BrowserShell({
  state,
  profile,
  task,
  settings,
  onClose,
  onSettingsSaved
}: BrowserShellProps) {
  const toast = useToast()
  const { t } = useI18n()
  const [panelOpen, setPanelOpen] = useState(true)
  const [urlDraft, setUrlDraft] = useState('')
  const [addrFocused, setAddrFocused] = useState(false)
  const [tabLayout, setTabLayout] = useState<'horizontal' | 'vertical'>(readLayout)
  // 影子轨宽度百分比（100 - 人轨）。可拖拽调整，clamp 到 [30, 70]，
  // 避免拖到任一侧完全消失。默认 43（与 CSS 原值一致）。
  const [shadowWidth, setShadowWidth] = useState(DEFAULT_SHADOW_WIDTH)
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const stageRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const bwBodyRef = useRef<HTMLDivElement | null>(null)

  const groupsKey = `${GROUP_STORAGE_PREFIX}${state?.profileId ?? profile?.id ?? 'none'}`

  /* 分组是 UI 偏好，存 localStorage 不进 IPC（主进程不拥有它的语义）。
     state 里带着读取时的 key：切换环境时 key 变了，渲染期直接换成新环境的存档，
     不用等 effect —— 这样旧环境的分组绝不会借着 setState 的空档写进新 key。 */
  const [groupState, setGroupState] = useState(() => ({
    key: groupsKey,
    map: readGroups(groupsKey)
  }))
  const groups = groupState.key === groupsKey ? groupState.map : readGroups(groupsKey)

  function setGroups(next: TabGroupMap | ((prev: TabGroupMap) => TabGroupMap)): void {
    setGroupState((prev) => ({
      key: groupsKey,
      map: typeof next === 'function' ? next(prev.map) : next
    }))
  }

  useEffect(() => {
    setCollapsed({})
    setSearch('')
  }, [groupsKey])

  /* 只在「当前内存分组确实属于这个 key」时落盘；写失败不影响使用 */
  useEffect(() => {
    if (groupState.key !== groupsKey) return
    try {
      localStorage.setItem(groupsKey, JSON.stringify(groupState.map))
    } catch {
      // 隐私模式 / 配额满：分组这次会话内仍在内存里，只是不落盘
    }
  }, [groupState, groupsKey])

  const tabs = state?.tabs ?? []
  const humanTabs = tabs.filter((tab) => tab.track === 'human')
  const shadowTabs = tabs.filter((tab) => tab.track === 'shadow')
  const active = tabs.find((t) => t.id === state?.activeTabId) ?? null
  const shadowTab = shadowTabs[0] ?? null
  /* 「还没有内容」也算待命：影子轨起点是 about:blank，Agent 第一次导航之前
     那里什么都没有。骨架卡就是给这段真空准备的（见 .shadow-pane.stripe）。 */
  const shadowPending = !shadowTab || shadowTab.loading || shadowTab.url === 'about:blank'
  /* 人轨同理：页面还没导航（或正在加载）时，主进程会把网页视图收起来，
     这块区域画的是占位设计，文案要跟着状态走。 */
  const humanBlank =
    !active || active.track !== 'human' || active.url === 'about:blank' || active.loading

  useEffect(() => {
    setUrlDraft(active?.url ?? '')
  }, [active?.id, active?.url])

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, tabLayout)
    } catch {
      // 同上，布局偏好丢盘无伤大雅
    }
  }, [tabLayout])

  /* ── 把内容区矩形上报给主进程 ── */
  const report = useCallback(() => {
    const el = stageRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const panelWidth = panelRef.current?.getBoundingClientRect().width ?? 0
    reportContentInsets({
      visible: true,
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      panelWidth: Math.round(panelWidth),
      // 分屏比例必须上报真实值：用户拖动手柄后，主进程要按同一个比例摆
      // 网页视图，否则占位设计与真实页面会错开（页面压在错误的区域里）。
      // 这个值是**人轨**占比，影子轨 = 1 - split。
      split: 1 - shadowWidth / 100
    })
  }, [shadowWidth])

  useEffect(() => {
    const targets: HTMLDivElement[] = []
    if (stageRef.current) targets.push(stageRef.current)
    if (panelRef.current) targets.push(panelRef.current)

    const ro = new ResizeObserver(() => report())
    targets.forEach((t) => ro.observe(t))

    // 首帧 + 下一帧各报一次：字体加载、侧栏动画都会改变矩形
    report()
    const raf = requestAnimationFrame(() => report())
    const onResize = (): void => report()
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', onResize)
      // 离开双轨窗口：让主进程把网页视图藏起来，避免盖住控制台
      reportContentInsets({
        visible: false,
        top: 0,
        left: 0,
        width: 0,
        height: 0,
        panelWidth: 0,
        split: 1 - shadowWidth / 100
      })
    }
  }, [report, panelOpen, tabLayout, shadowWidth])

  const fp = profile?.fingerprint
  const progress = useMemo(() => {
    const total = Math.max(task?.plan.length ?? 0, task?.steps.length ?? 0)
    const done = task?.steps.filter((s) => s.status === 'ok').length ?? 0
    return { done, total, ratio: total > 0 ? done / total : 0 }
  }, [task])

  const lastStep = task?.steps[task.steps.length - 1]
  const agentTitle =
    lastStep?.label ?? (task ? t('browser.agentBar.running') : t('browser.agentBar.idle'))
  const agentDesc = task
    ? task.summary ||
      (lastStep?.result ? stepResultText(lastStep) : t('browser.agentBar.descRunning'))
    : t('browser.agentBar.descIdle')

  async function guard(fn: () => Promise<void>, fallback: string): Promise<void> {
    try {
      await fn()
    } catch (err) {
      toast.push(errorMessage(err) || fallback, 'err')
    }
  }

  function selectTab(tab: BrowserTab): void {
    if (!state) return
    void guard(() => bridge().window.activateTab(state.id, tab.id), t('browser.err.switchTab'))
  }

  function closeTab(tab: BrowserTab): void {
    if (!state) return
    void guard(() => bridge().window.closeTab(state.id, tab.id), t('browser.err.closeTab'))
  }

  function navigate(): void {
    if (!state || !active) return
    const raw = urlDraft.trim()
    if (!raw) return
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    void guard(() => bridge().window.navigate(state.id, active.id, url), t('browser.err.navigate'))
  }

  /* 分屏拖拽：拖动 handle 调整影子轨宽度。
     为什么用 window 级监听：拖拽期间鼠标可能移出 handle 本身，必须在 window 上
     跟踪 move/up 才能稳定。拖拽时禁用文本选择，避免选中页面文字。

     ── 百分比必须相对 `.stage` 算 ──
     `.shadow-pane` 的宽度百分比是相对 `.stage`（网页区，不含 AI 面板）的，
     而 `.bw-body` 还包含右侧面板。拿 body 算比例，拖出来的宽度和实际渲染
     的宽度对不上 —— 拖到 70% 时真实影子轨只有 body 的 70%，不是 stage 的。

     ── 下限必须和主进程一致 ──
     主进程摆放视图时给每一栏留 MIN_PANE_PX 的最小宽度（否则窄栏没法用）。
     渲染层如果允许拖到比它更窄，两边就会各说各话：占位设计与真实页面错开，
     页面被压在错误的区域里（看起来就是「界面格式有问题」）。
     这里用同一个常量做像素级 clamp，两边的结论必然一致。 */
  function onSplitMouseDown(e: ReactMouseEvent): void {
    e.preventDefault()
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    if (rect.width <= 0) return
    // 两栏都不能窄于 MIN_PANE_PX；同时保留 [30,70] 的手感范围
    const minShadowPct = Math.max(30, (MIN_PANE_PX / rect.width) * 100)
    const maxShadowPct = Math.min(70, ((rect.width - MIN_PANE_PX) / rect.width) * 100)
    const lo = Math.min(minShadowPct, maxShadowPct)
    const hi = Math.max(minShadowPct, maxShadowPct)
    const onMove = (ev: MouseEvent): void => {
      const pct = ((ev.clientX - rect.left) / rect.width) * 100
      // 影子轨 = 右侧部分
      const shadowPct = Math.min(hi, Math.max(lo, Math.round((100 - pct) * 10) / 10))
      setShadowWidth(shadowPct)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const trackIsShadow = active?.track === 'shadow'

  /* ── 分组 / 搜索的派生数据与本地操作 ── */
  const filteredHuman = filterTabs(humanTabs, search)
  const filteredShadow = filterTabs(shadowTabs, search)
  // 先筛再分组：搜索后没有命中的组不会生成 header，天然满足「空组头隐藏」
  const groupedHuman = groupTabs(filteredHuman, groups)
  const searchActive = search.trim().length > 0
  const noMatch = searchActive && filteredHuman.length === 0 && filteredShadow.length === 0
  const existingGroups = Array.from(
    new Set(Object.values(groups).map((g) => g.trim()).filter(Boolean))
  ).sort()

  function changeGroup(tabId: string, value: string): void {
    if (value === '__new__') {
      // 新建分组用原生 prompt：这一期分组只是视觉整理，不值得为此引入一套弹窗状态机
      const name = window.prompt(t('browser.group.prompt'))
      if (name && name.trim()) setGroups((prev) => ({ ...prev, [tabId]: name.trim() }))
      return
    }
    setGroups((prev) => {
      const next = { ...prev }
      if (value) next[tabId] = value
      else delete next[tabId]
      return next
    })
  }

  function toggleGroup(label: string): void {
    setCollapsed((prev) => ({ ...prev, [label]: !prev[label] }))
  }

  function groupControl(tab: BrowserTab) {
    const label = (groups[tab.id] ?? '').trim()
    const options = [
      { value: '', label: t('browser.group.none') },
      { value: '__new__', label: t('browser.group.new') },
      ...existingGroups.map((name) => ({ value: name, label: name }))
    ]
    return (
      <span
        className={`tab-grp${label ? '' : ' ungrouped'}`}
        style={cssVars({
          '--grp-color': label ? `var(${groupColor(label)})` : 'var(--ink-5)'
        })}
        title={label ? t('browser.group.title', { name: label }) : t('browser.group.set')}
        // 分组控件在标签内部：阻止冒泡，免得点下拉时误切换标签
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <i className="grp-dot" />
        {label ? <span className="grp-label">{label}</span> : null}
        <select
          value={label}
          aria-label={label ? t('browser.group.aria', { name: label }) : t('browser.group.setAria')}
          onChange={(e) => changeGroup(tab.id, e.target.value)}
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </span>
    )
  }

  function closeControl(tab: BrowserTab) {
    return (
      <span
        className="x"
        role="button"
        aria-label={t('browser.tab.close')}
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation()
          closeTab(tab)
        }}
        onKeyDown={(e) => {
          // 关闭键自身要能 Enter/Space 触发，否则键盘用户只能靠标签根节点
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            closeTab(tab)
          }
        }}
      >
        <Icon name="close" size={9} strokeWidth={2.4} />
      </span>
    )
  }

  /* 标签根节点用 div[role=button] 而不是 button：内部要放原生 select，
     button 里嵌交互元素是无效 DOM；顺带把焦点键盘激活补上，语义不变。
     Delete / Backspace 也关闭：标签关闭不能只有鼠标这一条路。 */
  function tabActivate(tab: BrowserTab) {
    return {
      role: 'button',
      tabIndex: 0,
      onClick: () => selectTab(tab),
      onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          selectTab(tab)
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault()
          closeTab(tab)
        }
      }
    }
  }

  function humanTabNode(tab: BrowserTab) {
    return (
      <div
        key={tab.id}
        {...tabActivate(tab)}
        className={`btab${tab.id === active?.id ? ' on' : ''}`}
        title={tab.url}
      >
        <span className="fav">
          {tab.favicon ? (
            <img src={tab.favicon} alt="" width={12} height={12} referrerPolicy="no-referrer" />
          ) : null}
        </span>
        <span className="txt">{tab.title || t('browser.tab.defaultHumanTitle')}</span>
        {tab.loading ? <span className="spin" /> : null}
        {groupControl(tab)}
        {closeControl(tab)}
      </div>
    )
  }

  function shadowTabNode(tab: BrowserTab) {
    return (
      <div
        key={tab.id}
        {...tabActivate(tab)}
        className={`btab shadow-tab${tab.id === active?.id ? ' on' : ''}`}
        title={tab.url}
      >
        <span className="ic">
          <Icon name="wave" size={9} strokeWidth={2.5} />
        </span>
        <span className="txt">{tab.title || t('browser.tab.defaultShadowTitle')}</span>
        <span className="shadow-badge">{t('browser.tab.badge')}</span>
        {tab.loading ? <span className="spin" /> : null}
        {groupControl(tab)}
      </div>
    )
  }

  return (
    <div className={`browser${tabLayout === 'vertical' ? ' tab-vertical' : ''}`}>
      <div className="bw-title">
        <div className="lights">
          <i />
          <i />
          <i />
        </div>
        <div className="t">
          ShadowSurf · <b>{profile?.name ?? state?.profileName ?? t('browser.window.untitled')}</b>
        </div>
        <div className="right">
          <span className="bw-chip">
            <i />
            {profile ? `Chrome ${chromeMajor(profile.browserVersion)}` : '—'}
          </span>
          <button type="button" className="bw-x" onClick={onClose} aria-label={t('browser.window.close')}>
            <Icon name="close" size={13} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className={`tabsbar${trackIsShadow ? ' is-shadow' : ''}`}>
        <div className="tabs-tools">
          <div className="tab-search">
            <Icon name="search" size={12} strokeWidth={2} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                // Escape 只清搜索、不装全局 Ctrl+F：页面自己的查找不能被抢
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setSearch('')
                }
              }}
              placeholder={t('browser.search.placeholder')}
              aria-label={t('browser.search.placeholder')}
              spellCheck={false}
            />
            {searchActive ? (
              <span
                className="search-clear"
                role="button"
                aria-label={t('browser.search.clear')}
                tabIndex={0}
                onClick={() => setSearch('')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setSearch('')
                }}
              >
                <Icon name="close" size={10} strokeWidth={2.2} />
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="tab-layout-toggle"
            aria-label={t('browser.tabs.vertical')}
            aria-pressed={tabLayout === 'vertical'}
            title={tabLayout === 'vertical' ? t('browser.tabs.horizontal') : t('browser.tabs.vertical')}
            onClick={() => setTabLayout((v) => (v === 'vertical' ? 'horizontal' : 'vertical'))}
          >
            <Icon name="list" size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="tgroup human">
          {groupedHuman.map((item) => {
            if (item.kind === 'header') {
              const isCollapsed = Boolean(collapsed[item.label])
              return (
                <div
                  key={item.key}
                  role="button"
                  tabIndex={0}
                  className={`grp-head${isCollapsed ? ' collapsed' : ''}`}
                  style={cssVars({ '--grp-color': `var(${item.color})` })}
                  title={
                    isCollapsed
                      ? t('browser.group.expand', { name: item.label })
                      : t('browser.group.collapse', { name: item.label })
                  }
                  onClick={() => toggleGroup(item.label)}
                  onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      toggleGroup(item.label)
                    }
                  }}
                >
                  <span className="grp-caret">
                    <Icon name="chevronLeft" size={10} strokeWidth={2.4} />
                  </span>
                  <i className="grp-dot" />
                  <span className="grp-name">{item.label}</span>
                  <span className="grp-count">{item.count}</span>
                </div>
              )
            }
            if (collapsed[item.group ?? '']) return null
            return humanTabNode(item.tab)
          })}
          <button
            type="button"
            className="tab-new"
            aria-label={t('browser.tabs.new')}
            onClick={() => {
              if (!state) return
              void guard(async () => {
                await bridge().window.newTab(state.id)
              }, t('browser.err.newTab'))
            }}
          >
            <Icon name="plus" size={12} strokeWidth={2.2} />
          </button>
        </div>

        {searchActive && filteredShadow.length > 0 ? (
          <div className="tgroup shadow">{filteredShadow.map(shadowTabNode)}</div>
        ) : !searchActive ? (
          <div className="tgroup shadow">
            {shadowTabs.map(shadowTabNode)}
            {shadowTabs.length === 0 ? (
              <div className="btab shadow-tab" title={t('browser.tab.standbyTitle')}>
                <span className="ic">
                  <Icon name="wave" size={9} strokeWidth={2.5} />
                </span>
                <span className="txt">{t('browser.tab.standby')}</span>
                <span className="shadow-badge">{t('browser.tab.badge')}</span>
              </div>
            ) : null}
          </div>
        ) : null}

        {noMatch ? <div className="tab-no-match">{t('browser.tab.noMatch')}</div> : null}
      </div>

      <div className={`bw-addr${trackIsShadow ? ' is-shadow' : ''}`}>
        <button
          type="button"
          className="nav-btn"
          disabled={!active?.canGoBack}
          aria-label={t('browser.nav.back')}
          onClick={() => {
            if (!state || !active) return
            void guard(() => bridge().window.back(state.id, active.id), t('browser.err.back'))
          }}
        >
          <Icon name="chevronLeft" size={13} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="nav-btn"
          disabled={!active?.canGoForward}
          aria-label={t('browser.nav.forward')}
          onClick={() => {
            if (!state || !active) return
            void guard(() => bridge().window.forward(state.id, active.id), t('browser.err.forward'))
          }}
        >
          <Icon name="chevronRight" size={13} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="nav-btn"
          aria-label={t('browser.nav.reload')}
          onClick={() => {
            if (!state || !active) return
            void guard(() => bridge().window.reload(state.id, active.id), t('browser.err.reload'))
          }}
        >
          <Icon name="reload" size={13} strokeWidth={2} />
        </button>

        <div className="addr" data-focused={addrFocused}>
          <Icon name="lock" size={10} strokeWidth={2} />
          {/* 地址栏未聚焦时，展示 origin 强调 + path 弱化的静态回显；
              聚焦时隐藏回显、显示可编辑 input。这样既能一眼看出「在哪个站」，
              又不影响输入。回显是纯展示，用户点击即聚焦 input。 */}
          {!addrFocused && active?.url ? (
            <span className="addr-display" aria-hidden="true">
              <b className="addr-origin">{originOf(active.url)}</b>
              <span className="addr-path">{pathOf(active.url)}</span>
            </span>
          ) : null}
          <input
            className="addr-input"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onFocus={() => setAddrFocused(true)}
            onBlur={() => setAddrFocused(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') navigate()
              if (e.key === 'Escape') setUrlDraft(active?.url ?? '')
              // Ctrl/Cmd+L 聚焦并全选地址栏；F5 / Ctrl/Cmd+R 刷新。
              // 这两个是浏览器用户最肌肉记忆的键，缺失会让外壳「不像浏览器」。
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
                e.preventDefault()
                e.currentTarget.select()
              }
              if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) {
                e.preventDefault()
                if (state && active) {
                  void guard(() => bridge().window.reload(state.id, active.id), t('browser.err.reload'))
                }
              }
            }}
            placeholder={t('browser.addr.placeholder')}
            aria-label={t('browser.addr.aria')}
            spellCheck={false}
          />
        </div>

        <div className="addr-meta">
          <span title={profile?.proxy ? t('browser.addr.proxyExit') : t('browser.addr.direct')}>
            {profile?.proxy ? `${profile.proxy.host}` : t('browser.addr.direct')}
          </span>
          <span className="vline" />
          <span title={t('browser.addr.fingerprint')}>
            {fp ? `${osShortLabel(fp)} · ${tzOffsetLabel(fp.timezone)}` : '—'}
          </span>
          <span className="vline" />
          <button
            type="button"
            className={`ai-toggle${panelOpen ? ' on' : ''}`}
            onClick={() => setPanelOpen((v) => !v)}
            aria-pressed={panelOpen}
            title={panelOpen ? t('browser.ai.collapse') : t('browser.ai.expand')}
          >
            <Icon name="wave" size={11} strokeWidth={2.2} />
            AI
          </button>
        </div>
      </div>

      <div className="bw-body" ref={bwBodyRef}>
        <div className="stage" ref={stageRef}>
          <div className="stage-placeholder">
            <Icon name="globe" size={22} strokeWidth={1.5} />
            <div className="ph-title">
              {humanBlank ? t('browser.stage.waitTitle') : t('browser.stage.readyTitle')}
            </div>
            <div className="ph-sub">
              {humanBlank ? t('browser.stage.waitDesc') : t('browser.stage.readyDesc')}
            </div>
          </div>

          {/* 可拖拽分屏 handle：拖动调整人轨/影子轨比例。
              为什么可拖：固定 57/43 在双轨浏览时很别扭，用户需要按内容调。
              拖动只改比例，不改窗口结构；inset 上报在 report() 里跟着 ResizeObserver 走。 */}
          <div
            className="split-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('browser.stage.splitAria')}
            onMouseDown={onSplitMouseDown}
          >
            <span className="split-handle-grip" />
          </div>

          <div className={`shadow-pane${shadowPending ? ' stripe' : ''}`} style={{ width: `${shadowWidth}%` }}>
            <div className="sp-badge">
              <Icon name="wave" size={10} strokeWidth={2.4} />
              {t('browser.stage.shadowSpace')}
            </div>
            {shadowPending ? (
              <div className="sp-page" aria-hidden="true">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div className="sp-card" key={i}>
                    <div className="th" />
                    <div className="ln">
                      <i />
                      <i />
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="sp-fade" />
          </div>
        </div>

        {panelOpen ? (
          <div className="panel-slot" ref={panelRef}>
            <AgentPanel
              profileId={state?.profileId ?? profile?.id ?? null}
              tabId={active?.id ?? null}
              pageTitle={active?.title || urlDraft || t('browser.page.none')}
              settings={settings}
              onSettingsSaved={onSettingsSaved}
              onClose={() => setPanelOpen(false)}
            />
          </div>
        ) : null}
      </div>

      <div className="agent-bar">
        <div className="ab-icon">
          <Icon name="wave" size={15} strokeWidth={2.2} />
        </div>
        <div className="ab-main">
          <div className="ab-top">
            <span className="ab-title">{agentTitle}</span>
            <span className="ab-step">
              {progress.done} / {progress.total || PROGRESS_CELLS}
            </span>
          </div>
          <div className="ab-desc">{agentDesc}</div>
          <div className="ab-prog">
            {Array.from({ length: PROGRESS_CELLS }, (_, i) => {
              const filled = Math.round(progress.ratio * PROGRESS_CELLS)
              const cls = i < filled ? 'done' : i === filled && task ? 'now' : ''
              return <i key={i} className={cls} />
            })}
          </div>
        </div>
        <div className="ab-actions">
          <Button
            variant="ghost"
            icon="pause"
            disabled={!task}
            title={t('browser.agentBar.pauseTitle')}
            onClick={() => {
              void guard(() => bridge().agent.cancel(), t('browser.err.stop'))
            }}
          >
            {t('browser.agentBar.pause')}
          </Button>
          <Button
            variant="take"
            icon="hand"
            onClick={() => {
              const human = humanTabs[0]
              if (human && state) {
                void guard(() => bridge().window.activateTab(state.id, human.id), t('browser.err.switchTrack'))
                toast.push(t('browser.agentBar.tookOver'), 'ok')
              } else {
                toast.push(t('browser.agentBar.noHumanTab'), 'err')
              }
            }}
          >
            {t('browser.agentBar.takeOver')}
          </Button>
        </div>
      </div>

      {task ? (
        <span className="sr-only">
          {t('browser.agentBar.sr', {
            intent: task.intent,
            time: formatDuration(Date.now() - task.startedAt)
          })}
        </span>
      ) : null}
    </div>
  )
}
