/**
 * 单张环境卡片。
 *
 * 一屏内要回答四个问题：这是谁（编号 + 名称）、跑在什么上（平台 / 版本）、
 * 从哪出去（代理 + 延迟）、指纹像不像（时区 / 语言 / 分辨率）。
 * 底部状态行区分「影子正在干活」与「影子待命」，进度条只在进行中出现。
 *
 * 包了 `memo`：200 个环境 × 40-60 个 DOM 节点，搜索框每敲一个键都会让父组件
 * 重渲染，没有 memo 时每张卡片都要重新 diff。props 里的回调必须稳定
 * （App.tsx 用 useCallback 传进来），否则 memo 永远命中不了。
 */

import { memo } from 'react'
import type { MaskRow, TaskRecord, Profile } from '@shared/types'
import { MASK_TONE_SHORT, maskHintOf, maskToneOf } from '@shared/mask-ui'
import { Button, Icon, cssVars } from './ui'
import { useI18n } from '@renderer/lib/i18n'
import {
  chromeMajor,
  countryLabel,
  formatRelative,
  latencyTier,
  localeCountry,
  osShortLabel,
  profileNo,
  taskProgress,
  tzOffsetLabel
} from '@renderer/lib/format'

interface ProfileCardProps {
  profile: Profile
  task?: TaskRecord
  /**
   * 这个环境此刻最坏的一条伪装读数（主进程 `judgeMask` 判完下发）。
   *
   * `null` 有两种含义，由 `running` 区分：没在跑 = 没东西可测；
   * 在跑但没读数 = 门禁此刻拒绝。这里不自己判，交给 `maskToneOf`。
   */
  mask?: MaskRow | null
  selected: boolean
  /** 代理延迟（ms）。契约里没有这个字段，主进程探测后由上层传入 */
  latency?: number | null
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onConfig: (id: string) => void
  /** 收藏 / 置顶。收藏态会在排序里被提到最前（见 ProfileGrid） */
  onToggleFavorite: (id: string) => void
}

export const ProfileCard = memo(function ProfileCard({
  profile,
  task,
  mask = null,
  selected,
  latency = null,
  onSelect,
  onOpen,
  onConfig,
  onToggleFavorite
}: ProfileCardProps) {
  const { t } = useI18n()
  const fp = profile.fingerprint
  const progress = taskProgress(task)
  const running = Boolean(task && task.status === 'running')
  const failed = profile.status === 'error'
  const starting = profile.status === 'starting'

  const tier = latencyTier(latency)
  const latencyText =
    tier === 'timeout'
      ? t('profiles.latency.timeout')
      : tier === 'unknown'
        ? t('profiles.latency.unknown')
        : `${Math.round(latency ?? 0)}ms`

  let statusClass = 'status'
  let statusLabel = t('profiles.status.idle')
  if (running) {
    statusClass = 'status run'
    statusLabel = t('profiles.card.runningStatus', {
      done: progress.done,
      total: Math.max(progress.total, progress.done)
    })
  } else if (failed || starting) {
    statusClass = 'status warn'
    statusLabel = starting ? t('profiles.status.starting') : t('profiles.status.failed')
  }

  // 启动中也要算「有窗口」：此刻门禁已经在拦，界面不能还是灰的
  const maskTone = maskToneOf(mask, running || starting)
  const maskHint = maskHintOf(mask, running || starting)
  const maskLabel = t(`profiles.mask.tone.${maskTone}`)
  const maskShort = MASK_TONE_SHORT[maskTone]

  const barWidth = running && progress.total > 0 ? (progress.done / progress.total) * 100 : 0

  // 星标用文本 ★/☆ 而不是新增图标：ui.tsx 不在本次归属内，文本零依赖，
  // 且读屏由外层按钮的 aria-label 承担（内层 span 标 aria-hidden）。
  const favorite = profile.favorite === true
  const favoriteLabel = favorite ? t('profiles.favorite.remove') : t('profiles.favorite.add')

  return (
    /*
     * 卡片**不是** role="button"。
     *
     * 原先整张卡是 role="button" + tabIndex=0，里面却塞着三个真正的
     * <button>（选中框、星标、更多）。这在 ARIA 上是错的：
     * button 角色的可交互后代必须被压平，读屏软件会把内部控件的语义吞掉，
     * 键盘用户 Tab 进卡片后也不知道自己在哪。
     *
     * 现在分成两条路径：
     * - **鼠标**：点卡片空白处仍然打开（onClick 留在 article 上，纯便利路径）；
     * - **键盘 / 读屏**：靠里面的环境名按钮（真正的 <button>，有 aria-label）。
     *
     * 内部控件一律 stopPropagation，不让点击冒泡成"打开环境"。
     */
    <article
      className={`env${selected ? ' sel' : ''}`}
      style={cssVars({ '--c': profile.color })}
      onClick={() => onOpen(profile.id)}
      title={failed && profile.lastError ? profile.lastError : undefined}
    >
      <div className="env-top">
        <button
          type="button"
          className={`cb${selected ? ' on' : ''}`}
          aria-label={selected ? t('profiles.deselect') : t('profiles.select')}
          aria-pressed={selected}
          onClick={(e) => {
            e.stopPropagation()
            onSelect(profile.id)
          }}
        >
          <Icon name="check" size={9} strokeWidth={3.5} />
        </button>
        <span className="env-id">{profileNo(profile.id)}</span>
        <button
          type="button"
          className="env-name env-name-btn"
          aria-label={t('profiles.card.openAria', { name: profile.name })}
          onClick={(e) => {
            e.stopPropagation()
            onOpen(profile.id)
          }}
        >
          {profile.name}
        </button>
        {/*
          伪装状态点。只在有东西可说的时候出现：
          idle（环境没启动）什么都不画 —— 那时候没有窗口，也就没有可测的状态，
          画个灰点会让人以为「测过了，没问题」。
        */}
        {maskTone !== 'idle' ? (
          <span
            className={`mask-dot ${maskTone}`}
            title={maskHint}
            aria-label={t('profiles.mask.aria', { state: maskLabel })}
          >
            <i />
            {maskShort !== '' ? <em>{t(`profiles.mask.short.${maskTone}`)}</em> : null}
          </span>
        ) : null}
        {/*
          已豁免伪装闸门。**与状态点分开画**：状态点说的是「此刻测到了什么」，
          这个标记说的是「这个环境被配置成绕过闸门」。
          合成一个点会让人以为「伪装好了」，而事实正好相反 —— 它是伪装没修好、
          但用户显式放行的状态。计划里要求「界面必须显式标注该环境已豁免」。
        */}
        {profile.allowUnmaskedL2 ? (
          <span
            className="mask-dot exempt"
            title={t('profiles.exempt.title')}
            aria-label={t('profiles.exempt.aria')}
          >
            <i />
            <em>{t('profiles.exempt.badge')}</em>
          </span>
        ) : null}
        <button
          type="button"
          className="env-more"
          aria-label={t('profiles.card.configAria')}
          onClick={(e) => {
            e.stopPropagation()
            onConfig(profile.id)
          }}
        >
          <Icon name="more" size={13} />
        </button>
        {/*
          收藏星标。放在标题行最右侧（more 之后）：`.env-more` 的 margin-left:auto
          会把两者一起推到右端，这里再把星标自己的 auto 外边距清零，避免两个
          auto 均分空白。keydown 也要拦 —— 否则回车既触发本按钮的 click，
          又冒泡到卡片的 onKeyDown，把「收藏」做成了「打开环境」。
        */}
        <button
          type="button"
          className="env-more"
          style={{ marginLeft: 0, color: favorite ? 'var(--amber)' : undefined, fontSize: 14 }}
          aria-label={favoriteLabel}
          aria-pressed={favorite}
          title={favoriteLabel}
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite(profile.id)
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <span aria-hidden="true">{favorite ? '★' : '☆'}</span>
        </button>
      </div>

      <div className="env-sub">
        <span className="cc">{localeCountry(fp.locale)}</span>
        {countryLabel(fp.locale)}
        <span className="sep">·</span>
        {osShortLabel(fp)}
        <span className="sep">·</span>
        Chrome {chromeMajor(profile.browserVersion || fp.uaVersion)}
      </div>

      <div className={`proxy${failed ? ' bad' : ''}${profile.proxy ? '' : ' none'}`}>
        <Icon name="globe" size={11} strokeWidth={2} />
        <span className="addr-text">
          {profile.proxy ? `${profile.proxy.host}:${profile.proxy.port}` : t('profiles.direct')}
        </span>
        <span className={`lat ${tier === 'fast' ? '' : tier === 'unknown' ? 'unknown' : 'slow'}`}>
          <i />
          {latencyText}
        </span>
      </div>

      <div className="fp">
        <span>{tzOffsetLabel(fp.timezone)}</span>
        <span>{fp.locale}</span>
        <span>
          {fp.screen.width}×{fp.screen.height}
        </span>
      </div>

      <div className="env-foot">
        <span className={statusClass} title={profile.lastError}>
          <i />
          {statusLabel}
        </span>
        {/* 分组在卡片上必须看得见：色条只能表达「有颜色」，说不出组名。
            没有分组就不画，避免每张卡都多一个「未分组」标签。 */}
        {profile.group ? (
          <span
            className="env-group"
            title={profile.group === '默认' ? t('profiles.group.default') : profile.group}
          >
            {profile.group === '默认' ? t('profiles.group.default') : profile.group}
          </span>
        ) : null}
        <div className="env-actions" onClick={(e) => e.stopPropagation()}>
          {running ? (
            <Button size="sm" variant="ghost" onClick={() => onOpen(profile.id)}>
              {t('profiles.view')}
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onConfig(profile.id)}
              >
                {t('profiles.configure')}
              </Button>
              <Button size="sm" variant="primary" onClick={() => onOpen(profile.id)}>
                {t('profiles.open')}
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="bar">
        <i style={{ width: `${barWidth}%` }} />
      </div>

      <span className="sr-only">
        {t('profiles.lastUsed', { time: formatRelative(profile.lastUsedAt) })}
      </span>
    </article>
  )
})
