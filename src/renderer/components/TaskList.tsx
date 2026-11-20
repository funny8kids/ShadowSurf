/**
 * 任务页：左侧任务列表 + 右侧回放时间线。
 *
 * 回放的数据全部来自 TaskRecord（steps 已含 label / thought / result / 时间），
 * 因此「看历史」和「看实时」用的是同一套渲染，不会出现两套说法。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { Profile, TaskRecord } from '@shared/types'
import { Button, Icon, Skeleton, cx, useToast } from './ui'
import { bridge, errorMessage } from '@renderer/lib/api'
import { useI18n } from '@renderer/lib/i18n'
import {
  ACTION_LABEL,
  formatClock,
  formatDate,
  formatDuration,
  formatPercent,
  formatRelative,
  isToday,
  profileNo,
  stepResultText,
  taskProgress,
  taskTone
} from '@renderer/lib/format'

/**
 * 首屏快照三态，和 App 的 ConsoleLoadState 同形。
 * 按结构声明以减少 import 耦合；TS 结构匹配，App 直接传同一对象。
 */
interface ListLoadState {
  kind: 'loading' | 'error' | 'ready'
  message?: string
}

interface TaskListProps {
  tasks: TaskRecord[]
  profiles: Profile[]
  loading: boolean
  /** 首屏快照三态；读失败带原文，单独渲染成琥珀色错误块，绝不当成「还没有任务」。 */
  loadState: ListLoadState
  /** 重新读取整份控制台快照（任务 / 环境 / 设置 / 伪装一起读）。 */
  onRetry: () => void
  query: string
  onNew: () => void
  onOpenProfile: (profileId: string) => void
}

export function TaskList({
  tasks,
  profiles,
  loading,
  loadState,
  onRetry,
  query,
  onNew,
  onOpenProfile
}: TaskListProps) {
  const { t } = useI18n()
  const toast = useToast()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // 回放头：steps 下标；null = 没有活动的播放会话。playing 单独记「定时器是否在跑」，
  // 因为暂停时 playhead 要保留（见下），单看它分不清「在播」和「停在原处」。
  const [playhead, setPlayhead] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const timerRef = useRef<number | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = [...tasks].sort((a, b) => b.startedAt - a.startedAt)
    if (!q) return list
    return list.filter((t) => {
      const env = profiles.find((p) => p.id === t.profileId)?.name ?? ''
      return `${t.intent} ${env} ${t.summary}`.toLowerCase().includes(q)
    })
  }, [tasks, profiles, query])

  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedId(null)
      return
    }
    if (!selectedId || !filtered.some((t) => t.id === selectedId)) {
      setSelectedId(filtered[0].id)
    }
  }, [filtered, selectedId])

  const selected = filtered.find((t) => t.id === selectedId) ?? null

  const stats = useMemo(() => {
    const today = tasks.filter((t) => isToday(t.startedAt))
    const settled = tasks.filter((t) => t.status === 'done' || t.status === 'failed')
    const ok = settled.filter((t) => t.status === 'done').length
    const durations = settled
      .map((t) => (t.finishedAt ? t.finishedAt - t.startedAt : null))
      .filter((v): v is number => v !== null && v >= 0)
    const avg = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0
    const tokens = tasks.reduce((a, t) => a + t.tokens, 0)
    return {
      today: today.length,
      rate: settled.length > 0 ? (ok / settled.length) * 100 : 0,
      settled: settled.length,
      avg,
      tokens
    }
  }, [tasks])

  const progress = taskProgress(selected ?? undefined)
  const ratio = progress.total > 0 ? progress.done / progress.total : 0

  const steps = selected?.steps ?? []
  const stepCount = steps.length

  /* ── 审计导出 ──
   * 用现成的 audit.list()，不新增 IPC。导出 JSON 而不是自造格式：审计链自己落盘、
   * 自己校验用的就是这套字段（seq / prev / hash / detail），原样倒出来才能保证
   * 「导出物」和「链本身」逐字段对得上；换个格式就得另写一份映射，迟早分家。
   * 不传 limit：主进程的 listAudit 默认封顶 200 条，恰恰是面板显示的那批，
   * 这里不要“尽量多导”去绕开那个上限。
   */
  const exportAudit = async (): Promise<void> => {
    try {
      const entries = await bridge().audit.list()
      const payload = {
        exportedAt: new Date().toISOString(),
        count: entries.length,
        entries
      }
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `shadowsurf-audit-${formatDate(Date.now())}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      // 与 Cookie 导出一致：给 Chromium 一帧时间去读 blob，提前 revoke 会得到空文件。
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.push(t('tasks.auditExported', { n: entries.length }), 'ok')
    } catch (err) {
      // 读不到就明说读不到，绝不弹「导出成功」——空列表不等于导出成功。
      toast.push(errorMessage(err), 'err')
    }
  }

  /* 切换任务时，旧任务的播放头与定时器都不能留下：
   * 一个泄漏的 interval 会在用户跳走之后继续 setState，时间线自己往前走。 */
  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    setPlayhead(null)
    setPlaying(false)
  }, [selectedId])

  // 卸载时兜底清一次，防止组件被整棵移除时定时器残留。
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current)
    }
  }, [])

  const stopTimer = (): void => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    setPlaying(false)
  }

  const togglePlay = (): void => {
    if (stepCount === 0) return
    if (playing) {
      stopTimer()
      return
    }
    // 从头播还是续播：播完重置成 null，暂停则保留 playhead，这里据此判断。
    const start = playhead === null || playhead >= stepCount - 1 ? 0 : playhead
    let current = start
    setPlayhead(current)
    setPlaying(true)
    // ~900ms 贴合 Agent 每一步的实际节奏（一次动作 + 一段思考摘要）；
    // 这里只是回放已有时间线，不是重新驱动 Agent，用 JS interval 足够，不碰主进程。
    timerRef.current = window.setInterval(() => {
      const next = current + 1
      if (next >= stepCount) {
        // 走完最后一步再停，并重置成 null —— 让播放头回到「未播放」语义，
        // 进度条随之退回 done/total，而不是停在末尾假装还在播。
        stopTimer()
        setPlayhead(null)
        return
      }
      current = next
      setPlayhead(current)
    }, 900)
  }

  const onScrub = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (stepCount === 0) return
    const box = e.currentTarget.getBoundingClientRect()
    if (box.width <= 0) return
    const frac = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width))
    stopTimer()
    setPlayhead(Math.round(frac * (stepCount - 1)))
  }

  const onScrubKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (stepCount === 0) return
    let next: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(stepCount - 1, (playhead ?? -1) + 1)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, (playhead ?? stepCount) - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = stepCount - 1
    if (next === null) return
    e.preventDefault()
    stopTimer()
    setPlayhead(next)
  }

  // 播放中按播放头走；否则维持原来的 done/total 进度，不因为暂停就篡改已完成比例。
  const scrubRatio = playhead !== null && stepCount > 0 ? (playhead + 1) / stepCount : ratio

  return (
    <>
      <div className="page-head">
        <div>
          <h2>{t('tasks.title')}</h2>
          <p>{t('tasks.subtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            variant="ghost"
            icon="download"
            onClick={() => void exportAudit()}
          >
            {t('tasks.exportAudit')}
          </Button>
          <Button variant="primary" icon="plus" onClick={onNew}>
            {t('tasks.newTask')}
          </Button>
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <div className="k">
            <i />
            {t('tasks.stat.today')}
          </div>
          <div className="v">{stats.today}</div>
          <div className="d">{t('tasks.stat.total', { n: tasks.length })}</div>
        </div>
        <div className="stat">
          <div className="k">
            <i className="g" />
            {t('tasks.stat.rate')}
          </div>
          <div className="v">
            {stats.settled > 0 ? formatPercent(stats.rate).replace('%', '') : '—'}
            {stats.settled > 0 ? <small>%</small> : null}
          </div>
          <div className="d">{t('tasks.stat.rateDesc', { n: stats.settled })}</div>
        </div>
        <div className="stat">
          <div className="k">
            <i />
            {t('tasks.stat.avg')}
          </div>
          <div className="v">{stats.avg > 0 ? formatDuration(stats.avg) : '—'}</div>
          <div className="d">{t('tasks.stat.avgDesc')}</div>
        </div>
        <div className="stat">
          <div className="k">
            <i className="a" />
            {t('tasks.stat.tokens')}
          </div>
          <div className="v">{stats.tokens.toLocaleString('en-US')}</div>
          <div className="d">{t('tasks.stat.tokensDesc')}</div>
        </div>
      </div>

      <div className="task-wrap">
        <div className="task-list">
        {loadState.kind === 'error' ? (
          /* 读失败 ≠ 空：琥珀色、带原文、带「重试」，和下面的「还没有任务」
             空态（虚线卡片 + 「新建任务」）在容器、色调、按钮上都不同。 */
          <div className="load-error">
            <div className="le-mark">
              <Icon name="alert" size={20} strokeWidth={2.2} />
            </div>
            <h3>{t('tasks.error.title')}</h3>
            <p className="le-reason">{loadState.message}</p>
            <p className="le-hint">{t('tasks.error.hint')}</p>
            <Button variant="ghost" icon="reload" onClick={onRetry}>
              {t('common.retry')}
            </Button>
          </div>
        ) : loading ? (
          /* 加载态用**骨架**，不与空态共用容器。
           *
           * 原来加载态与空态都是 `.empty`（同样的虚线卡片、同样的圆角、
           * 同样的背景），只有标题文案不同。按 DESIGN.md「不可判读状态」的
           * 判据——「遮住文字，只看容器和颜色，三者是否已经不同」——
           * 答案是否：用户在加载完成前会以为「没有任务」，于是不会点重试。
           * 环境页用的是骨架卡（ProfileGrid 的 .env-skel），这里跟着对齐。 */
          <div className="task-skel-list" aria-busy="true" aria-label={t('tasks.loading')}>
            {Array.from({ length: 3 }).map((_, i) => (
              <div className="task-skel" key={i} aria-hidden="true">
                <Skeleton width="52%" height="13px" radius="var(--r-sm)" />
                <Skeleton width="76%" height="10px" radius="var(--r-sm)" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty">
            <div className="mark">
              <Icon name="tasks" size={20} strokeWidth={2} />
            </div>
            <h3>{t('tasks.empty.title')}</h3>
            <p>{t('tasks.empty.desc')}</p>
            <Button variant="primary" icon="plus" onClick={onNew}>
              {t('tasks.newTask')}
            </Button>
          </div>
        ) : (
          filtered.map((task) => {
              const env = profiles.find((p) => p.id === task.profileId)
              const p = taskProgress(task)
              return (
                <button
                  key={task.id}
                  type="button"
                  className={cx('task', task.id === selectedId && 'on')}
                  onClick={() => setSelectedId(task.id)}
                >
                  <div className="r1">
                    <span className={cx('dot-s', taskTone(task.status))} />
                    <span className="t">{task.intent}</span>
                    <span className="tm">
                      {task.status === 'running'
                        ? t('tasks.status.running')
                        : formatRelative(task.startedAt)}
                    </span>
                  </div>
                  <div className="r2">
                    <span className="env-tag">{profileNo(task.profileId)}</span>
                    {env?.name ?? task.profileId}
                    <span className="muted">·</span>
                    {task.status === 'running'
                      ? `${p.done}/${Math.max(p.total, p.done)}`
                      : task.finishedAt
                        ? formatDuration(task.finishedAt - task.startedAt)
                        : t(`tasks.status.${task.status}`)}
                  </div>
                </button>
              )
            })
          )}
        </div>        {selected ? (
          <div className="replay">
            <div className="rp-head">
              <div className="r1">
                <span className={cx('dot-s', taskTone(selected.status))} />
                <h3>{selected.intent}</h3>
                <span className="ab-step">
                  {t('tasks.replay.stepOf', {
                    done: progress.done,
                    total: Math.max(progress.total, progress.done)
                  })}
                </span>
              </div>
              <div className="meta">
                <span>
                  {t('tasks.replay.profile')}{' '}
                  <b>{profiles.find((p) => p.id === selected.profileId)?.name ?? selected.profileId}</b>
                </span>
                <span>
                  {t('tasks.replay.start')} <b>{formatClock(selected.startedAt)}</b>
                </span>
                <span>
                  {t('tasks.replay.duration')}{' '}
                  <b>
                    {formatDuration(
                      (selected.finishedAt ?? Date.now()) - selected.startedAt
                    )}
                  </b>
                </span>
                <span>
                  Tokens <b>{selected.tokens.toLocaleString('en-US')}</b>
                </span>
                <span>
                  {t('tasks.replay.date')} <b>{formatDate(selected.startedAt)}</b>
                </span>
              </div>
            </div>

            <div className="rp-ctrl">
              <button
                type="button"
                className="play"
                aria-label={playing ? t('tasks.replay.pause') : t('tasks.replay.play')}
                title={t('tasks.replay.playTitle')}
                onClick={togglePlay}
              >
                <Icon name={playing ? 'pause' : 'play'} size={10} strokeWidth={2} />
              </button>
              <div
                className="scrub"
                onClick={onScrub}
                onKeyDown={onScrubKey}
                role="slider"
                tabIndex={stepCount > 0 ? 0 : -1}
                aria-label={t('tasks.replay.progress')}
                aria-valuemin={1}
                aria-valuemax={Math.max(stepCount, 1)}
                aria-valuenow={playhead !== null ? playhead + 1 : progress.done}
              >
                <i style={{ width: `${scrubRatio * 100}%` }} />
                <u style={{ left: `${scrubRatio * 100}%` }} />
              </div>
              <span className="rp-time">
                {formatDuration(progress.done > 0 ? (selected.finishedAt ?? Date.now()) - selected.startedAt : 0)} /{' '}
                {formatDuration((selected.finishedAt ?? Date.now()) - selected.startedAt)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onOpenProfile(selected.profileId)}
              >
                {t('tasks.replay.takeOver')}
              </Button>
            </div>

            <div className="rp-steps scroll-thin">
              {selected.steps.length === 0 ? (
                <div className="note">{t('tasks.replay.noSteps')}</div>
              ) : (
                selected.steps.map((s, i) => {
                  const isPlaying = playhead !== null && i === playhead
                  const dimmed = playhead !== null && i > playhead
                  return (
                    <div
                      key={s.index}
                      className={cx('step', s.status, isPlaying && 'playing')}
                      style={{
                        // 单一高亮态用内联样式写令牌：TaskList 没有自己的 CSS 文件，
                        // 为了一个 .playing 去动全局 app.css 越过了本次所有权边界。
                        borderLeftColor: isPlaying ? 'var(--accent)' : 'transparent',
                        borderLeftWidth: '2px',
                        borderLeftStyle: 'solid',
                        opacity: dimmed ? 0.45 : 1
                      }}
                    >
                      <div className="sn">
                        {s.status === 'ok' ? (
                          <Icon name="check" size={9} strokeWidth={3} />
                        ) : s.status === 'failed' || s.status === 'rejected' ? (
                          <Icon name="close" size={9} strokeWidth={3} />
                        ) : s.status === 'confirm' ? (
                          <Icon name="alert" size={9} strokeWidth={2.6} />
                        ) : (
                          s.index + 1
                        )}
                      </div>
                      <div className="sb">
                        <div className="sa">{s.label}</div>
                        {s.thought ? <div className="sthought">{s.thought}</div> : null}
                        <div className="sd">
                          <span>{formatClock(s.at)}</span>
                          {typeof s.durationMs === 'number' ? (
                            <span>+{(s.durationMs / 1000).toFixed(1)}s</span>
                          ) : null}
                          <span
                            style={{
                              color:
                                s.status === 'ok'
                                  ? 'var(--green)'
                                  : s.status === 'failed'
                                    ? 'var(--red)'
                                    : s.status === 'confirm'
                                      ? 'var(--amber)'
                                      : undefined
                            }}
                          >
                            {t(`tasks.stepStatus.${s.status}`)}
                          </span>
                        </div>
                      </div>
                      <div className="thumb">{ACTION_LABEL[s.action.type] ?? s.action.type}</div>
                    </div>
                  )
                })
              )}
            </div>

            <div className="rp-output">
              <div className="out-head">
                <h4>{t('tasks.output.title')}</h4>
                <span>
                  {selected.summary || t('tasks.output.stepCount', { n: selected.steps.length })}
                </span>
                <Button
                  size="sm"
                  variant="quiet"
                  icon="external"
                  onClick={() => onOpenProfile(selected.profileId)}
                >
                  {t('tasks.output.openProfile')}
                </Button>
              </div>
              <div className="out-table">
                <div className="out-row head">
                  <span>{t('tasks.output.step')}</span>
                  <span>{t('tasks.output.result')}</span>
                </div>
                {selected.steps.length === 0 ? (
                  <div className="out-row">
                    <span className="txt">{t('tasks.output.empty')}</span>
                    <b>—</b>
                  </div>
                ) : (
                  selected.steps.slice(0, 8).map((s) => (
                    <div className="out-row" key={s.index}>
                      <span className="txt">{s.label}</span>
                      <b title={s.failure ? s.result : undefined}>{stepResultText(s)}</b>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </>
  )
}
