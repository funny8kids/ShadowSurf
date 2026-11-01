/**
 * 任务页：左侧任务列表 + 右侧回放时间线。
 *
 * 回放的数据全部来自 TaskRecord（steps 已含 label / thought / result / 时间），
 * 因此「看历史」和「看实时」用的是同一套渲染，不会出现两套说法。
 */

import { useEffect, useMemo, useState } from 'react'
import type { Profile, TaskRecord } from '@shared/types'
import { Button, Icon, cx, useToast } from './ui'
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
  stepStatusText,
  taskProgress,
  taskStatusText,
  taskTone
} from '@renderer/lib/format'

interface TaskListProps {
  tasks: TaskRecord[]
  profiles: Profile[]
  loading: boolean
  query: string
  onNew: () => void
  onOpenProfile: (profileId: string) => void
}

export function TaskList({ tasks, profiles, loading, query, onNew, onOpenProfile }: TaskListProps) {
  const toast = useToast()
  const [selectedId, setSelectedId] = useState<string | null>(null)

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

  return (
    <>
      <div className="page-head">
        <div>
          <h2>任务</h2>
          <p>影子的执行记录 · 每一步都可回放、可接管</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            variant="ghost"
            icon="download"
            onClick={() => toast.push('审计导出尚未接入主进程', 'err')}
          >
            导出审计
          </Button>
          <Button variant="primary" icon="plus" onClick={onNew}>
            新建任务
          </Button>
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <div className="k">
            <i />
            今日任务
          </div>
          <div className="v">{stats.today}</div>
          <div className="d">累计 {tasks.length} 条执行记录</div>
        </div>
        <div className="stat">
          <div className="k">
            <i className="g" />
            成功率
          </div>
          <div className="v">
            {stats.settled > 0 ? formatPercent(stats.rate).replace('%', '') : '—'}
            {stats.settled > 0 ? <small>%</small> : null}
          </div>
          <div className="d">共 {stats.settled} 个已结算任务</div>
        </div>
        <div className="stat">
          <div className="k">
            <i />
            平均耗时
          </div>
          <div className="v">{stats.avg > 0 ? formatDuration(stats.avg) : '—'}</div>
          <div className="d">从任务开始到 done 事件</div>
        </div>
        <div className="stat">
          <div className="k">
            <i className="a" />
            Token 消耗
          </div>
          <div className="v">{stats.tokens.toLocaleString('en-US')}</div>
          <div className="d">模型与代理消耗未折算成本</div>
        </div>
      </div>

      <div className="task-wrap">
        <div className="task-list">
          {loading ? (
            <div className="empty">
              <div className="mark">
                <Icon name="tasks" size={20} strokeWidth={2} />
              </div>
              <h3>正在读取任务…</h3>
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty">
              <div className="mark">
                <Icon name="tasks" size={20} strokeWidth={2} />
              </div>
              <h3>还没有任务</h3>
              <p>在双轨窗口里给影子下一个指令，执行记录会出现在这里，每一步都能回放。</p>
              <Button variant="primary" icon="plus" onClick={onNew}>
                新建任务
              </Button>
            </div>
          ) : (
            filtered.map((t) => {
              const env = profiles.find((p) => p.id === t.profileId)
              const p = taskProgress(t)
              return (
                <button
                  key={t.id}
                  type="button"
                  className={cx('task', t.id === selectedId && 'on')}
                  onClick={() => setSelectedId(t.id)}
                >
                  <div className="r1">
                    <span className={cx('dot-s', taskTone(t.status))} />
                    <span className="t">{t.intent}</span>
                    <span className="tm">
                      {t.status === 'running' ? taskStatusText(t.status) : formatRelative(t.startedAt)}
                    </span>
                  </div>
                  <div className="r2">
                    <span className="env-tag">{profileNo(t.profileId)}</span>
                    {env?.name ?? t.profileId}
                    <span className="muted">·</span>
                    {t.status === 'running'
                      ? `${p.done}/${Math.max(p.total, p.done)}`
                      : t.finishedAt
                        ? formatDuration(t.finishedAt - t.startedAt)
                        : taskStatusText(t.status)}
                  </div>
                </button>
              )
            })
          )}
        </div>

        {selected ? (
          <div className="replay">
            <div className="rp-head">
              <div className="r1">
                <span className={cx('dot-s', taskTone(selected.status))} />
                <h3>{selected.intent}</h3>
                <span className="ab-step">
                  第 {progress.done} 步 / 共 {Math.max(progress.total, progress.done)} 步
                </span>
              </div>
              <div className="meta">
                <span>
                  环境 <b>{profiles.find((p) => p.id === selected.profileId)?.name ?? selected.profileId}</b>
                </span>
                <span>
                  开始 <b>{formatClock(selected.startedAt)}</b>
                </span>
                <span>
                  耗时{' '}
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
                  日期 <b>{formatDate(selected.startedAt)}</b>
                </span>
              </div>
            </div>

            <div className="rp-ctrl">
              <button
                type="button"
                className="play"
                aria-label="播放回放"
                title="回放播放器尚未接入（当前展示静态时间线）"
                onClick={() => toast.push('回放播放器尚未接入主进程', 'err')}
              >
                <Icon name="play" size={10} strokeWidth={2} />
              </button>
              <div className="scrub">
                <i style={{ width: `${ratio * 100}%` }} />
                <u style={{ left: `${ratio * 100}%` }} />
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
                接管
              </Button>
            </div>

            <div className="rp-steps scroll-thin">
              {selected.steps.length === 0 ? (
                <div className="note">这一步还没有产生记录。任务执行后，每一步的动作、思考摘要与结果都会写在这里。</div>
              ) : (
                selected.steps.map((s) => (
                  <div key={s.index} className={cx('step', s.status)}>
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
                          {stepStatusText(s.status)}
                        </span>
                      </div>
                    </div>
                    <div className="thumb">{ACTION_LABEL[s.action.type] ?? s.action.type}</div>
                  </div>
                ))
              )}
            </div>

            <div className="rp-output">
              <div className="out-head">
                <h4>产出预览</h4>
                <span>
                  {selected.summary || `${selected.steps.length} 步执行记录`}
                </span>
                <Button
                  size="sm"
                  variant="quiet"
                  icon="external"
                  onClick={() => onOpenProfile(selected.profileId)}
                >
                  打开环境
                </Button>
              </div>
              <div className="out-table">
                <div className="out-row head">
                  <span>步骤</span>
                  <span>结果</span>
                </div>
                {selected.steps.length === 0 ? (
                  <div className="out-row">
                    <span className="txt">暂无产出</span>
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
