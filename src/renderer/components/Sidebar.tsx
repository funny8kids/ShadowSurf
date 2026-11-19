/**
 * 左侧导航。
 *
 * 「环境 / 任务 / 各工具面板 / 成员」是真实路由（view = NavKey），
 * 其余入口（设置 / 账户）仍是占位：点击给出「尚未接入」的提示，而不是假装能跳转。
 *
 * 文案全部走 i18n catalog（`nav.*` / `theme.*` / `density.*`），中英切换即时生效。
 */

import type { ReactElement } from 'react'
import type { ThemeMode } from '@shared/types'
import type { DensityMode } from '@renderer/lib/theme'
import { useI18n } from '@renderer/lib/i18n'
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
  | 'extensions'
  | 'proxy-groups'
  | 'sync'
  | 'webhooks'
  | 'team'

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
  theme: ThemeMode
  onTheme: (mode: ThemeMode) => void
  density: DensityMode
  onDensity: (mode: DensityMode) => void
  onOpenPalette: () => void
  lang: 'zh' | 'en'
  onLang: (next: 'zh' | 'en') => void
}

/** 平台正确的修饰键文案：Windows/Linux 显示 Ctrl，macOS 显示 ⌘ */
const MOD_KEY =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

/** 三档主题。顺序固定为「跟随系统 / 亮 / 暗」，切换时位置不跳 */
const THEME_OPTIONS: ReadonlyArray<{ mode: ThemeMode; icon: IconName; labelKey: string }> = [
  { mode: 'system', icon: 'auto', labelKey: 'theme.system' },
  { mode: 'light', icon: 'sun', labelKey: 'theme.light' },
  { mode: 'dark', icon: 'moon', labelKey: 'theme.dark' }
]

/**
 * 密度两档。文字标签而不是图标：图标很难区分「舒适 / 紧凑」，
 * 一个写错就静默切换，不如直接写明白。
 */
const DENSITY_OPTIONS: ReadonlyArray<{ mode: DensityMode; labelKey: string; titleKey: string }> = [
  { mode: 'comfortable', labelKey: 'density.comfortable', titleKey: 'density.comfortableTitle' },
  { mode: 'compact', labelKey: 'density.compact', titleKey: 'density.compactTitle' }
]

export function Sidebar({
  view,
  onNavigate,
  onUnavailable,
  profileCount,
  runningCount: _runningCount,
  hasRunningTask,
  proxyCount,
  scriptCount,
  theme,
  onTheme,
  density,
  onDensity,
  onOpenPalette,
  lang,
  onLang
}: SidebarProps) {
  const { t } = useI18n()

  const primary: NavItem[] = [
    { key: 'workbench', label: t('nav.env'), icon: 'grid', count: profileCount },
    { key: 'tasks', label: t('nav.tasks'), icon: 'tasks', dot: hasRunningTask },
    { key: 'proxies', label: t('nav.proxies'), icon: 'globe', count: proxyCount || undefined }
  ]

  const tools: NavItem[] = [
    { key: 'scripts', label: t('nav.scripts'), icon: 'spark', count: scriptCount || undefined },
    { key: 'templates', label: t('nav.templates'), icon: 'folder' },
    { key: 'data', label: t('nav.data'), icon: 'list' },
    { key: 'api', label: t('nav.api'), icon: 'external' },
    { key: 'audit', label: t('nav.audit'), icon: 'shield' },
    { key: 'extensions', label: t('nav.extensions'), icon: 'square' },
    { key: 'proxy-groups', label: t('nav.proxyGroups'), icon: 'globe' },
    { key: 'sync', label: t('nav.sync'), icon: 'swap' },
    { key: 'webhooks', label: t('nav.webhooks'), icon: 'send' }
  ]

  // 成员页是真实路由：本地团队的增删改都在这里，不再只是占位提示。
  const team: NavItem[] = [{ key: 'team', label: t('nav.members'), icon: 'users' }]

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
        <div className="nav-label">{t('nav.group.tools')}</div>
        {tools.map(renderItem)}
      </div>

      <div className="nav-group">
        <div className="nav-label">{t('nav.group.team')}</div>
        {team.map(renderItem)}
      </div>

      <div className="side-foot">
        <div className="theme-switch" role="group" aria-label={t('common.lang')}>
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.mode}
              type="button"
              className="theme-opt"
              aria-pressed={theme === opt.mode}
              aria-label={t(opt.labelKey)}
              title={t(opt.labelKey)}
              onClick={() => onTheme(opt.mode)}
            >
              <Icon name={opt.icon} size={14} strokeWidth={1.7} />
            </button>
          ))}
        </div>

        {/*
          密度开关紧贴主题控件。用独立的 density-opt 类而不是 theme-opt：
          tools/verify-theme.mjs 会全局查 .theme-opt 并要求恰好一个 aria-pressed，
          复用那个类会让一个正确的 UI 在主题校验里失败。
          密度存 localStorage 而非 Settings：纯渲染层偏好，不跨窗口、不随 seed 迁移，
          走 Settings 契约要穿过主进程校验，得不偿失。
        */}
        <div className="theme-switch density-switch" role="group" aria-label="density">
          {DENSITY_OPTIONS.map((opt) => (
            <button
              key={opt.mode}
              type="button"
              className="density-opt"
              aria-pressed={density === opt.mode}
              aria-label={t(opt.labelKey)}
              title={t(opt.titleKey)}
              onClick={() => onDensity(opt.mode)}
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>

        {/* 语言切换：两个按钮而不是下拉 —— 只有两种语言，下拉反而多一次点击 */}
        <div className="theme-switch density-switch lang-switch" role="group" aria-label={t('common.lang')}>
          <button
            type="button"
            className="density-opt"
            aria-pressed={lang === 'zh'}
            onClick={() => onLang('zh')}
          >
            {t('common.langZh')}
          </button>
          <button
            type="button"
            className="density-opt"
            aria-pressed={lang === 'en'}
            onClick={() => onLang('en')}
          >
            {t('common.langEn')}
          </button>
        </div>

        <button type="button" className="nav-item" onClick={() => onUnavailable(t('nav.settings'))}>
          <Icon name="settings" size={15} />
          {t('nav.settings')}
        </button>
        {/* 命令面板入口：和「设置」挨着放，复用 .nav-item 的布局，.count 当快捷键提示 */}
        <button type="button" className="nav-item" onClick={onOpenPalette}>
          <Icon name="search" size={15} />
          {t('nav.palette')}
          <span className="count">{MOD_KEY}K</span>
        </button>
        <button type="button" className="user" onClick={() => onUnavailable(t('nav.account'))}>
          <div className="avatar">{lang === 'zh' ? '本' : 'L'}</div>
          <div className="user-meta">
            <b>{t('nav.localSpace')}</b>
            <span>{t('nav.signedOut')}</span>
          </div>
        </button>
      </div>
    </aside>
  )
}
