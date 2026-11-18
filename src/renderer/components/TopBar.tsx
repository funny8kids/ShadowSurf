/**
 * 顶部条：面包屑 + 搜索 + 通知 + 主操作。
 *
 * 搜索框支持 ⌘K / Ctrl+K 聚焦；Esc 清空。查询串由 App 持有，
 * 这样切到任务页再切回来时筛选条件还在。
 */

import { useEffect, useRef } from 'react'
import { useI18n } from '@renderer/lib/i18n'
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

/**
 * 每个路由在顶栏面包屑里的显示名。
 *
 * 为什么必须有这一份映射：顶栏之前只认 `tasks` / 其它两态，
 * 于是停在代理 / 模板 / 脚本 / 数据 / API / 审计 / 成员页时，
 * 面包屑一律显示「环境 / 全部环境」—— 用户会以为自己还在环境页。
 * 路由名与页面标题必须由同一个事实来源派生，不能各写一份。
 */
const CRUMB: Record<NavKey, { titleKey: string; subKey: string }> = {
  workbench: { titleKey: 'nav.env', subKey: 'crumb.workbench.sub' },
  tasks: { titleKey: 'nav.tasks', subKey: 'crumb.tasks.sub' },
  proxies: { titleKey: 'nav.proxies', subKey: 'crumb.proxies.sub' },
  templates: { titleKey: 'nav.templates', subKey: 'crumb.templates.sub' },
  scripts: { titleKey: 'nav.scripts', subKey: 'crumb.scripts.sub' },
  data: { titleKey: 'nav.data', subKey: 'crumb.data.sub' },
  api: { titleKey: 'nav.api', subKey: 'crumb.api.sub' },
  audit: { titleKey: 'nav.audit', subKey: 'crumb.audit.sub' },
  extensions: { titleKey: 'nav.extensions', subKey: 'crumb.extensions.sub' },
  team: { titleKey: 'nav.members', subKey: 'crumb.team.sub' }
}

/** 只有这两页有列表搜索框；其余页的 query 无人消费，显示出来就是死控件 */
const SEARCHABLE: ReadonlySet<NavKey> = new Set<NavKey>(['workbench', 'tasks'])

/** 平台正确的修饰键文案：Windows/Linux 显示 Ctrl，macOS 显示 ⌘ */
const MOD_LABEL =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

export function TopBar({ view, query, onQuery, onNew, onBell, runningCount }: TopBarProps) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const crumb = CRUMB[view] ?? CRUMB.workbench
  const showSearch = SEARCHABLE.has(view)

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
        <b>{t(crumb.titleKey)}</b>
        <span className="slash">/</span>
        {t(crumb.subKey)}
      </div>

      <div className="spacer" />

      {showSearch ? (
        <div className="search">
          <Icon name="search" size={13} strokeWidth={2} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onQuery('')
            }}
            placeholder={view === 'tasks' ? t('topbar.searchTask') : t('topbar.searchEnv')}
            aria-label={t('topbar.search')}
          />
          <kbd>{MOD_LABEL}K</kbd>
        </div>
      ) : null}

      <button type="button" className="icon-btn" onClick={onBell} aria-label={t('topbar.notifications')}>
        <Icon name="bell" size={15} />
        {runningCount > 0 ? <span className="badge" /> : null}
      </button>

      <Button variant="primary" icon="plus" onClick={onNew}>
        {view === 'tasks' ? t('topbar.newTask') : t('topbar.newEnv')}
      </Button>
    </header>
  )
}
