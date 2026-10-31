/**
 * 环境列表主视图：统计卡 + 分组筛选 + 卡片网格 + 批量操作栏。
 *
 * 所有派生数字（运行中、今日任务、成功率）都从真实 Profile / TaskRecord 算，
 * 没有数据就显示 0，不用假数据占位。
 */

import { useMemo, useState } from 'react'
import type { Profile, TaskRecord } from '@shared/types'
import { ProfileCard } from './ProfileCard'
import { Button, Icon, Modal, cssVars } from './ui'
import { formatPercent, isToday } from '@renderer/lib/format'

export type BatchAction = 'start' | 'stop' | 'move' | 'proxy' | 'remove'

interface ProfileGridProps {
  profiles: Profile[]
  tasks: TaskRecord[]
  selected: string[]
  query: string
  group: string
  loading: boolean
  bridgeOk: boolean
  onGroup: (group: string) => void
  onSelect: (id: string) => void
  onSelectAll: (ids: string[]) => void
  onClearSelection: () => void
  onOpen: (id: string) => void
  onConfig: (id: string) => void
  onNew: () => void
  onBatch: (action: BatchAction, ids: string[], value?: string) => void
}

export function ProfileGrid({
  profiles,
  tasks,
  selected,
  query,
  group,
  loading,
  bridgeOk,
  onGroup,
  onSelect,
  onSelectAll,
  onClearSelection,
  onOpen,
  onConfig,
  onNew,
  onBatch
}: ProfileGridProps) {
  const [modal, setModal] = useState<{ kind: 'move' | 'proxy'; value: string } | null>(null)

  const groups = useMemo(() => {
    const map = new Map<string, number>()
    profiles.forEach((p) => {
      const key = p.group || '未分组'
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
    const q = query.trim().toLowerCase()
    return profiles.filter((p) => {
      if (group !== '全部' && (p.group || '未分组') !== group) return false
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
  }, [profiles, group, query])

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((p) => selected.includes(p.id))

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
          <h2>环境</h2>
          <p>
            <b>{profiles.length}</b> 个隔离环境 · <b>{stats.running}</b> 个正在运行 ·{' '}
            {stats.errors > 0 ? <b>{stats.errors} 个需要处理</b> : '全部就绪'}
          </p>
        </div>
        <div className="seg" role="group" aria-label="视图密度">
          <button type="button" className="on" aria-label="网格视图">
            <Icon name="grid" size={13} />
          </button>
          <button type="button" aria-label="列表视图" title="列表视图尚未实现">
            <Icon name="list" size={13} />
          </button>
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <div className="k">
            <i />
            环境总数
          </div>
          <div className="v">{profiles.length}</div>
          <div className="d">
            {groups.length} 个分组{stats.errors > 0 ? ` · ${stats.errors} 个异常` : ''}
          </div>
        </div>
        <div className="stat">
          <div className="k">
            <i className="g" />
            运行中
          </div>
          <div className="v">
            {stats.running}
            <small>个</small>
          </div>
          <div className="d">{taskByProfile.size} 个由影子托管</div>
        </div>
        <div className="stat">
          <div className="k">
            <i />
            今日任务
          </div>
          <div className="v">{stats.todayTasks}</div>
          <div className="d">
            成功 {stats.todayDone} · 失败 {stats.todayFailed}
          </div>
        </div>
        <div className="stat">
          <div className="k">
            <i className="a" />
            成功率
          </div>
          <div className="v">
            {stats.settled > 0 ? formatPercent(stats.rate).replace('%', '') : '—'}
            {stats.settled > 0 ? <small>%</small> : null}
          </div>
          <div className="d">近 7 日 · 共 {stats.settled} 个已结算任务</div>
        </div>
      </div>

      <div className="toolbar">
        <div className="tabs">
          <button
            type="button"
            className={`tab${group === '全部' ? ' on' : ''}`}
            onClick={() => onGroup('全部')}
          >
            全部 <span className="n">{profiles.length}</span>
          </button>
          {groups.map(([name, count]) => (
            <button
              key={name}
              type="button"
              className={`tab${group === name ? ' on' : ''}`}
              onClick={() => onGroup(name)}
            >
              {name} <span className="n">{count}</span>
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button
          type="button"
          className="filter-btn"
          onClick={() =>
            onSelectAll(allFilteredSelected ? [] : filtered.map((p) => p.id))
          }
          title="全选当前筛选结果"
        >
          <Icon name="check" size={12} strokeWidth={2.2} />
          {allFilteredSelected ? '取消全选' : '全选'}
        </button>
        <button type="button" className="filter-btn" onClick={onNew}>
          <Icon name="plus" size={12} strokeWidth={2.2} />
          新建
        </button>
      </div>

      {!bridgeOk ? (
        <div className="bridge-warn">
          <Icon name="alert" size={13} strokeWidth={2} />
          主进程尚未就绪（window.ss 未注入），当前列表为空。启动 Electron 后会自动拉取环境。
        </div>
      ) : null}

      <div className="grid">
        {loading ? (
          <div className="empty">
            <div className="mark">
              <Icon name="wave" size={20} strokeWidth={2.2} />
            </div>
            <h3>正在读取环境…</h3>
            <p>从主进程拉取 Profile 列表与指纹配置。</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty">
            <div className="mark">
              <Icon name="wave" size={20} strokeWidth={2.2} />
            </div>
            <h3>{profiles.length === 0 ? '新建第一个环境' : '没有匹配的环境'}</h3>
            <p>
              {profiles.length === 0
                ? '每个环境都是一套独立的指纹、代理与 Cookie 空间。影子在里面干活，你在另一个环境里浏览，互不干扰。'
                : '换个关键词，或切回「全部」分组。'}
            </p>
            <Button
              variant="primary"
              icon="plus"
              onClick={() => (profiles.length === 0 ? onNew() : onGroup('全部'))}
            >
              {profiles.length === 0 ? '新建环境' : '查看全部'}
            </Button>
            <div className="hint">指纹按平台模板确定性生成，同一个环境永远同一套参数</div>
          </div>
        ) : (
          filtered.map((p) => (
            <ProfileCard
              key={p.id}
              profile={p}
              task={taskByProfile.get(p.id)}
              selected={selected.includes(p.id)}
              onSelect={onSelect}
              onOpen={onOpen}
              onConfig={onConfig}
            />
          ))
        )}
      </div>

      {selected.length > 0 ? (
        <div className="batch" style={cssVars({ '--n': selected.length })}>
          <div className="n">
            已选 {selected.length} 项 <span>共 {profiles.length} 个环境</span>
          </div>
          <div className="vline" />
          <button type="button" onClick={() => onBatch('start', selected)}>
            <Icon name="play" size={12} strokeWidth={2} />
            启动
          </button>
          <button type="button" onClick={() => onBatch('stop', selected)}>
            <Icon name="square" size={12} strokeWidth={2} />
            停止
          </button>
          <button type="button" onClick={() => setModal({ kind: 'move', value: '' })}>
            <Icon name="folder" size={12} strokeWidth={2} />
            移到分组
          </button>
          <button
            type="button"
            onClick={() =>
              setModal({ kind: 'proxy', value: profiles.find((p) => p.id === selected[0])?.proxy?.host ?? '' })
            }
          >
            <Icon name="globe" size={12} strokeWidth={2} />
            切换代理
          </button>
          <button type="button" className="danger" onClick={() => onBatch('remove', selected)}>
            <Icon name="trash" size={12} strokeWidth={2} />
            删除
          </button>
          <div className="vline" />
          <button type="button" className="close" aria-label="取消选择" onClick={onClearSelection}>
            <Icon name="close" size={12} strokeWidth={2} />
          </button>
        </div>
      ) : null}

      <Modal
        open={modal !== null}
        title={modal?.kind === 'move' ? '移到分组' : '切换代理'}
        icon={modal?.kind === 'move' ? 'folder' : 'globe'}
        tone="accent"
        align="left"
        maxWidth={340}
        onClose={() => setModal(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setModal(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (!modal) return
                const value = modal.value.trim()
                if (modal.kind === 'move' && value) onBatch('move', selected, value)
                if (modal.kind === 'proxy' && value) onBatch('proxy', selected, value)
                setModal(null)
              }}
            >
              应用到 {selected.length} 个环境
            </Button>
          </>
        }
        note={modal?.kind === 'proxy' ? '格式：host:port，协议沿用原配置；留空表示改为直连' : undefined}
      >
        <div className="m-field">
          <label>{modal?.kind === 'move' ? '分组名称' : '代理地址'}</label>
          <input
            className="set-input"
            value={modal?.value ?? ''}
            autoFocus
            placeholder={modal?.kind === 'move' ? '例如：电商' : '例如：45.132.8.21:8000'}
            onChange={(e) =>
              setModal((m) => (m ? { ...m, value: e.target.value } : { kind: 'move', value: '' }))
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter' && modal) {
                const value = modal.value.trim()
                if (modal.kind === 'move' && value) onBatch('move', selected, value)
                if (modal.kind === 'proxy' && value) onBatch('proxy', selected, value)
                setModal(null)
              }
            }}
          />
        </div>
      </Modal>
    </>
  )
}
