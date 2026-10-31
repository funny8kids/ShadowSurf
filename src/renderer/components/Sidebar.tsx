/**
 * 左侧导航。
 *
 * 只有「环境 / 任务」是真实路由（view = workbench | tasks），
 * 其余入口是占位：点击给出「尚未接入」的提示，而不是假装能跳转。
 */

import type { ReactElement } from 'react'
import { Icon } from './ui'
import type { IconName } from './ui'

export type NavKey =
  | 'workbench'
  | 'tasks'
  | 'proxies'
  | 'templates'
  | 'scripts'
  | 'data'
  | 'api'
  | 'audit'

interface NavItem {
  key: NavKey | null
  label: string
  icon: IconName
  count?: number
  dot?: boolean
}

interface SidebarProps {
  view: NavKey | 'browser'
  onNavigate: (key: NavKey) => void
  onUnavailable: (label: string) => void
  profileCount: number
  runningCount: number
  hasRunningTask: boolean
  proxyCount?: number
  scriptCount?: number
}

export function Sidebar({
  view,
  onNavigate,
  onUnavailable,
  profileCount,
  runningCount,
  hasRunningTask,
  proxyCount,
  scriptCount
}: SidebarProps) {
  const primary: NavItem[] = [
    { key: 'workbench', label: '环境', icon: 'grid', count: profileCount },
    { key: 'tasks', label: '任务', icon: 'tasks', dot: hasRunningTask },
    { key: 'proxies', label: '代理', icon: 'globe', count: proxyCount || undefined }
  ]

  const tools: NavItem[] = [
    { key: 'scripts', label: '自动化', icon: 'spark', count: scriptCount || undefined },
    { key: 'templates', label: '模板', icon: 'folder' },
    { key: 'data', label: '数据', icon: 'list' },
    { key: 'api', label: '本地 API', icon: 'external' },
    { key: 'audit', label: '审计', icon: 'shield' }
  ]

  const team: NavItem[] = [{ key: null, label: '成员', icon: 'users' }]

  const renderItem = (item: NavItem): ReactElement => {
    const active = item.key !== null && item.key === view
    return (
      <button
        key={item.label}
        type="button"
        className={item.key !== null ? `nav-item${active ? ' on' : ''}` : 'nav-item'}
        onClick={() => {
          if (item.key) onNavigate(item.key)
          else onUnavailable(item.label)
        }}
        aria-current={active ? 'page' : undefined}
      >
        <Icon name={item.icon} size={15} />
        {item.label}
        {item.dot ? <span className="dot" /> : null}
        {typeof item.count === 'number' ? <span className="count">{item.count}</span> : null}
      </button>
    )
  }

  return (
    <aside className="side">
      <div className="brand">
        <div className="brand-mark">
          <Icon name="wave" size={14} strokeWidth={2.2} />
        </div>
        <div className="brand-name">ShadowSurf</div>
        <div className="brand-ver">0.1</div>
      </div>

      <div className="nav-group">{primary.map(renderItem)}</div>

      <div className="nav-group">
        <div className="nav-label">工具</div>
        {tools.map(renderItem)}
      </div>

      <div className="nav-group">
        <div className="nav-label">团队</div>
        {team.map(renderItem)}
      </div>

      <div className="side-foot">
        <button type="button" className="nav-item" onClick={() => onUnavailable('设置')}>
          <Icon name="settings" size={15} />
          设置
        </button>
        <button type="button" className="user" onClick={() => onUnavailable('账户')}>
          <div className="avatar">本</div>
          <div className="user-meta">
            <b>本地空间</b>
            <span>未登录 · 单机模式</span>
          </div>
        </button>
      </div>
    </aside>
  )
}
