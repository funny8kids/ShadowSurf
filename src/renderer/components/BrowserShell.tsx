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
import type { Profile, Settings, TaskRecord, WindowState, BrowserTab } from '@shared/types'
import { AgentPanel } from './AgentPanel'
import { Button, Icon, useToast } from './ui'
import { bridge, errorMessage, reportContentInsets } from '@renderer/lib/api'
import {
  chromeMajor,
  formatDuration,
  osShortLabel,
  tzOffsetLabel
} from '@renderer/lib/format'

/** 人轨占内容区宽度的比例，影子轨拿剩下的 43% */
const HUMAN_SPLIT = 0.57
const PROGRESS_CELLS = 20

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
  const [panelOpen, setPanelOpen] = useState(true)
  const [urlDraft, setUrlDraft] = useState('')
  const stageRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const tabs = state?.tabs ?? []
  const humanTabs = tabs.filter((t) => t.track === 'human')
  const shadowTabs = tabs.filter((t) => t.track === 'shadow')
  const active = tabs.find((t) => t.id === state?.activeTabId) ?? null
  const shadowTab = shadowTabs[0] ?? null
  const shadowPending = !shadowTab || shadowTab.loading

  useEffect(() => {
    setUrlDraft(active?.url ?? '')
  }, [active?.id, active?.url])

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
      split: HUMAN_SPLIT
    })
  }, [])

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
        split: HUMAN_SPLIT
      })
    }
  }, [report, panelOpen])

  const fp = profile?.fingerprint
  const progress = useMemo(() => {
    const total = Math.max(task?.plan.length ?? 0, task?.steps.length ?? 0)
    const done = task?.steps.filter((s) => s.status === 'ok').length ?? 0
    return { done, total, ratio: total > 0 ? done / total : 0 }
  }, [task])

  const lastStep = task?.steps[task.steps.length - 1]
  const agentTitle = lastStep?.label ?? (task ? '影子正在执行' : '影子待命')
  const agentDesc = task
    ? `${task.summary || lastStep?.result || '影子在后台继续，左侧浏览不受影响'}`
    : '打开一个任务后，影子会在这个独立空间里执行，不影响你当前浏览。'

  async function guard(fn: () => Promise<void>, fallback: string): Promise<void> {
    try {
      await fn()
    } catch (err) {
      toast.push(errorMessage(err) || fallback, 'err')
    }
  }

  function selectTab(tab: BrowserTab): void {
    if (!state) return
    void guard(() => bridge().window.activateTab(state.id, tab.id), '切换标签失败')
  }

  function closeTab(tab: BrowserTab): void {
    if (!state) return
    void guard(() => bridge().window.closeTab(state.id, tab.id), '关闭标签失败')
  }

  function navigate(): void {
    if (!state || !active) return
    const raw = urlDraft.trim()
    if (!raw) return
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    void guard(() => bridge().window.navigate(state.id, active.id, url), '导航失败')
  }

  const trackIsShadow = active?.track === 'shadow'

  return (
    <div className="browser">
      <div className="bw-title">
        <div className="lights">
          <i />
          <i />
          <i />
        </div>
        <div className="t">
          ShadowSurf · <b>{profile?.name ?? state?.profileName ?? '未命名环境'}</b>
        </div>
        <div className="right">
          <span className="bw-chip">
            <i />
            {profile ? `Chrome ${chromeMajor(profile.browserVersion)}` : '—'}
          </span>
          <button type="button" className="bw-x" onClick={onClose} aria-label="关闭双轨窗口">
            <Icon name="close" size={13} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className={`tabsbar${trackIsShadow ? ' is-shadow' : ''}`}>
        <div className="tgroup human">
          {humanTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`btab${tab.id === active?.id ? ' on' : ''}`}
              onClick={() => selectTab(tab)}
              title={tab.url}
            >
              <span className="fav" />
              <span className="txt">{tab.title || '新标签页'}</span>
              {tab.loading ? <span className="spin" /> : null}
              <span
                className="x"
                role="button"
                aria-label="关闭标签"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab)
                }}
              >
                <Icon name="close" size={9} strokeWidth={2.4} />
              </span>
            </button>
          ))}
          <button
            type="button"
            className="tab-new"
            aria-label="新建标签页"
            onClick={() => {
              if (!state) return
              void guard(async () => {
                await bridge().window.newTab(state.id)
              }, '新建标签失败')
            }}
          >
            <Icon name="plus" size={12} strokeWidth={2.2} />
          </button>
        </div>

        <div className="tgroup shadow">
          {shadowTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`btab shadow-tab${tab.id === active?.id ? ' on' : ''}`}
              onClick={() => selectTab(tab)}
              title={tab.url}
            >
              <span className="ic">
                <Icon name="wave" size={9} strokeWidth={2.5} />
              </span>
              <span className="txt">{tab.title || '影子 · 新任务'}</span>
              <span className="shadow-badge">影子</span>
              {tab.loading ? <span className="spin" /> : null}
            </button>
          ))}
          {shadowTabs.length === 0 ? (
            <button type="button" className="btab shadow-tab" disabled title="尚未创建影子标签">
              <span className="ic">
                <Icon name="wave" size={9} strokeWidth={2.5} />
              </span>
              <span className="txt">影子 · 待命</span>
              <span className="shadow-badge">影子</span>
            </button>
          ) : null}
        </div>
      </div>

      <div className={`bw-addr${trackIsShadow ? ' is-shadow' : ''}`}>
        <button
          type="button"
          className="nav-btn"
          disabled={!active?.canGoBack}
          aria-label="后退"
          onClick={() => {
            if (!state || !active) return
            void guard(() => bridge().window.back(state.id, active.id), '后退失败')
          }}
        >
          <Icon name="chevronLeft" size={13} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="nav-btn"
          disabled={!active?.canGoForward}
          aria-label="前进"
          onClick={() => {
            if (!state || !active) return
            void guard(() => bridge().window.forward(state.id, active.id), '前进失败')
          }}
        >
          <Icon name="chevronRight" size={13} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="nav-btn"
          aria-label="刷新"
          onClick={() => {
            if (!state || !active) return
            void guard(() => bridge().window.reload(state.id, active.id), '刷新失败')
          }}
        >
          <Icon name="reload" size={13} strokeWidth={2} />
        </button>

        <div className="addr">
          <Icon name="lock" size={10} strokeWidth={2} />
          <input
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') navigate()
              if (e.key === 'Escape') setUrlDraft(active?.url ?? '')
            }}
            placeholder="输入地址或搜索"
            aria-label="地址栏"
            spellCheck={false}
          />
        </div>

        <div className="addr-meta">
          <span title={profile?.proxy ? '代理出口' : '直连'}>
            {profile?.proxy ? `${profile.proxy.host}` : '直连'}
          </span>
          <span className="vline" />
          <span title="指纹平台与时区">
            {fp ? `${osShortLabel(fp)} · ${tzOffsetLabel(fp.timezone)}` : '—'}
          </span>
          <span className="vline" />
          <button
            type="button"
            className={`ai-toggle${panelOpen ? ' on' : ''}`}
            onClick={() => setPanelOpen((v) => !v)}
            aria-pressed={panelOpen}
            title={panelOpen ? '收起 AI 侧栏' : '展开 AI 侧栏'}
          >
            <Icon name="wave" size={11} strokeWidth={2.2} />
            AI
          </button>
        </div>
      </div>

      <div className="bw-body">
        <div className="stage" ref={stageRef}>
          <div className="stage-placeholder">
            <Icon name="globe" size={22} strokeWidth={1.5} />
            <div className="ph-title">
              {state ? '网页视图由主进程渲染' : '等待主进程创建窗口'}
            </div>
            <div className="ph-sub">
              {state
                ? '这块矩形已上报给主进程，WebContentsView 会精确覆盖在这里。'
                : 'window.ss.window.open(profileId) 之后，标签与网页会出现在这里。'}
            </div>
          </div>

          <div className={`shadow-pane${shadowPending ? ' stripe' : ''}`}>
            <div className="sp-badge">
              <Icon name="wave" size={10} strokeWidth={2.4} />
              影子 Space · 独立会话
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
              pageTitle={active?.title || urlDraft || '未打开页面'}
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
            title="当前协议只提供取消，点击后影子会停止执行"
            onClick={() => {
              void guard(() => bridge().agent.cancel(), '停止失败')
            }}
          >
            暂停
          </Button>
          <Button
            variant="take"
            icon="hand"
            onClick={() => {
              const human = humanTabs[0]
              if (human && state) {
                void guard(() => bridge().window.activateTab(state.id, human.id), '切换失败')
                toast.push('已切回人轨，影子继续在后台执行', 'ok')
              } else {
                toast.push('当前没有可切换的人轨标签', 'err')
              }
            }}
          >
            接管
          </Button>
        </div>
      </div>

      {task ? (
        <span className="sr-only">
          影子任务 {task.intent} · 已用 {formatDuration(Date.now() - task.startedAt)}
        </span>
      ) : null}
    </div>
  )
}
