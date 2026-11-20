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
  'proxy-groups': { titleKey: 'nav.proxyGroups', subKey: 'crumb.proxyGroups.sub' },
  sync: { titleKey: 'nav.sync', subKey: 'crumb.sync.sub' },
  webhooks: { titleKey: 'nav.webhooks', subKey: 'crumb.webhooks.sub' },
  team: { titleKey: 'nav.members', subKey: 'crumb.team.sub' }
}

/** 只有这两页有列表搜索框；其余页的 query 无人消费，显示出来就是死控件 */
const SEARCHABLE: ReadonlySet<NavKey> = new Set<NavKey>(['workbench', 'tasks'])

export function TopBar({ view, query, onQuery, onNew, onBell, runningCount }: TopBarProps) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const crumb = CRUMB[view] ?? CRUMB.workbench
  const showSearch = SEARCHABLE.has(view)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 搜索框聚焦用 **/**（单键），不用 Ctrl+K。
      //
      // 为什么：Ctrl+K 已经归命令面板（Linear / VS Code / Raycast 的通用惯例，
      // 而且它是全局唯一入口，比「在两个页面里聚焦搜索框」更有价值）。
      // 原来两处都监听 Ctrl+K：TopBar 聚焦搜索框、App 打开命令面板，
      // 后者紧接着又把焦点抢走 —— 结果是**搜索框永远无法用键盘获得焦点**，
      // 而顶栏偏偏还标着 `<kbd>Ctrl K</kbd>` 提示用户去按它。
      //
      // 单键「/」是搜索框的通用唤出键（GitHub / Linear / Notion 都用它），
      // 但不能在输入框里触发（否则用户打斜杠就被抢焦点）。
      const target = e.target as HTMLElement | null
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
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
          <kbd>/</kbd>
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
