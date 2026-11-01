/**
 * 单张环境卡片。
 *
 * 一屏内要回答四个问题：这是谁（编号 + 名称）、跑在什么上（平台 / 版本）、
 * 从哪出去（代理 + 延迟）、指纹像不像（时区 / 语言 / 分辨率）。
 * 底部状态行区分「影子正在干活」与「影子待命」，进度条只在进行中出现。
 */

import type { MaskRow, TaskRecord, Profile } from '@shared/types'
import { MASK_TONE_LABEL, MASK_TONE_SHORT, maskHintOf, maskToneOf } from '@shared/mask-ui'
import { Button, Icon, cssVars } from './ui'
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
}

export function ProfileCard({
  profile,
  task,
  mask = null,
  selected,
  latency = null,
  onSelect,
  onOpen,
  onConfig
}: ProfileCardProps) {
  const fp = profile.fingerprint
  const progress = taskProgress(task)
  const running = Boolean(task && task.status === 'running')
  const failed = profile.status === 'error'
  const starting = profile.status === 'starting'

  const tier = latencyTier(latency)
  const latencyText =
    tier === 'timeout' ? '超时' : tier === 'unknown' ? '未探测' : `${Math.round(latency ?? 0)}ms`

  let statusClass = 'status'
  let statusLabel = '影子待命'
  if (running) {
    statusClass = 'status run'
    statusLabel = `影子执行中 ${progress.done}/${Math.max(progress.total, progress.done)}`
  } else if (failed || starting) {
    statusClass = 'status warn'
    statusLabel = starting ? '启动中' : '启动失败'
  }

  // 启动中也要算「有窗口」：此刻门禁已经在拦，界面不能还是灰的
  const maskTone = maskToneOf(mask, running || starting)
  const maskHint = maskHintOf(mask, running || starting)
  const maskLabel = MASK_TONE_LABEL[maskTone]
  const maskShort = MASK_TONE_SHORT[maskTone]

  const barWidth = running && progress.total > 0 ? (progress.done / progress.total) * 100 : 0

  return (
    <article
      className={`env${selected ? ' sel' : ''}`}
      style={cssVars({ '--c': profile.color })}
      onClick={() => onOpen(profile.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(profile.id)
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`打开环境 ${profile.name}`}
      title={failed && profile.lastError ? profile.lastError : undefined}
    >
      <div className="env-top">
        <button
          type="button"
          className={`cb${selected ? ' on' : ''}`}
          aria-label={selected ? '取消选择' : '选择环境'}
          aria-pressed={selected}
          onClick={(e) => {
            e.stopPropagation()
            onSelect(profile.id)
          }}
        >
          <Icon name="check" size={9} strokeWidth={3.5} />
        </button>
        <span className="env-id">{profileNo(profile.id)}</span>
        <span className="env-name">{profile.name}</span>
        {/*
          伪装状态点。只在有东西可说的时候出现：
          idle（环境没启动）什么都不画 —— 那时候没有窗口，也就没有可测的状态，
          画个灰点会让人以为「测过了，没问题」。
        */}
        {maskTone !== 'idle' ? (
          <span
            className={`mask-dot ${maskTone}`}
            title={maskHint}
            aria-label={`伪装状态：${maskLabel}`}
          >
            <i />
            {maskShort !== '' ? <em>{maskShort}</em> : null}
          </span>
        ) : null}
        <button
          type="button"
          className="env-more"
          aria-label="配置环境"
          onClick={(e) => {
            e.stopPropagation()
            onConfig(profile.id)
          }}
        >
          <Icon name="more" size={13} />
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
          {profile.proxy ? `${profile.proxy.host}:${profile.proxy.port}` : '直连 · 未配置代理'}
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
        <div className="env-actions" onClick={(e) => e.stopPropagation()}>
          {running ? (
            <Button size="sm" variant="ghost" onClick={() => onOpen(profile.id)}>
              查看
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onConfig(profile.id)}
              >
                配置
              </Button>
              <Button size="sm" variant="primary" onClick={() => onOpen(profile.id)}>
                打开
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="bar">
        <i style={{ width: `${barWidth}%` }} />
      </div>

      <span className="sr-only">
        最后使用 {formatRelative(profile.lastUsedAt)}
      </span>
    </article>
  )
}
