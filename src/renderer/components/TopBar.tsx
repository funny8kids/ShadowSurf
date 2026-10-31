/**
 * 顶部条：面包屑 + 搜索 + 通知 + 主操作。
 *
 * 搜索框支持 ⌘K / Ctrl+K 聚焦；Esc 清空。查询串由 App 持有，
 * 这样切到任务页再切回来时筛选条件还在。
 */

import { useEffect, useRef } from 'react'
import { Button, Icon } from './ui'
import type { NavKey } from './Sidebar'

interface TopBarProps {
  view: NavKey
  query: string
  onQuery: (q: string) => void
  onNew: () => void
  onBell: () => void
  runningCount: number
}

export function TopBar({ view, query, onQuery, onNew, onBell, runningCount }: TopBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <header className="topbar">
      <div className="crumb">
        <b>{view === 'tasks' ? '任务' : '环境'}</b>
        <span className="slash">/</span>
        {view === 'tasks' ? '执行记录' : '全部环境'}
      </div>

      <div className="spacer" />

      <div className="search">
        <Icon name="search" size={13} strokeWidth={2} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onQuery('')
          }}
          placeholder={view === 'tasks' ? '搜索任务或环境' : '搜索环境、标签或代理'}
          aria-label="搜索"
        />
        <kbd>⌘K</kbd>
      </div>

      <button type="button" className="icon-btn" onClick={onBell} aria-label="通知">
        <Icon name="bell" size={15} />
        {runningCount > 0 ? <span className="badge" /> : null}
      </button>

      <Button variant="primary" icon="plus" onClick={onNew}>
        {view === 'tasks' ? '新建任务' : '新建环境'}
      </Button>
    </header>
  )
}
