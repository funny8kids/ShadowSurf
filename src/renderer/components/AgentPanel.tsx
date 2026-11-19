/**
 * AI 侧栏（影子面板）。
 *
 * 一屏讲清四件事：你要它做什么、它打算怎么做、现在做到哪、结果是什么。
 * 布局按 docs/ai-integration.html 的四张设计稿：50px 头部 / 30px 上下文条 /
 * 自适应消息流 / 66px 起的输入区。
 *
 * 安全：页面标题、模型输出、步骤文案全部是不可信数据，只作为 React 文本节点渲染，
 * 不使用 dangerouslySetInnerHTML，也不把 URL 拼进 href。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Action, AgentStep, StepStatus } from '@shared/protocol'
/*
 * 动作文案**没有**本地实现。
 *
 * 这句话原来在这里有第三份：渲染层没有快照，就自己写了一套「某个页面元素」的措辞。
 * 于是同一句话有三个版本，改一处忘一处 —— 而且那份的 scroll 分支把英文的
 * `direction` 直接拼进了中文（「向down滚动 300」）。
 *
 * 现在统一用 `shared/protocol.ts` 的 `describeAction(action)`：
 * snapshot 缺省时它自己退化成「某个元素」，且**永不**把 `action.id` 印出来。
 */
import { describeAction } from '@shared/protocol'
import type { Settings, TestResult } from '@shared/types'
import { PROVIDERS } from '@shared/presets'
import { Button, Icon, Modal, cx, useToast } from './ui'
import { bridge, errorMessage, onAgentEvent } from '@renderer/lib/api'
import { useI18n } from '@renderer/lib/i18n'
import { maskKey, providerNeedKey, resolveEndpoint, stepResultText } from '@renderer/lib/format'

type AgentStatus = 'idle' | 'running' | 'waiting' | 'done' | 'error'

interface AgentPanelProps {
  profileId: string | null
  tabId: string | null
  pageTitle: string
  settings: Settings
  onSettingsSaved: (next: Settings) => void
  onClose: () => void
}

interface ConfirmState {
  reason: string
  action: Action
  stepIndex: number
}

const SUGGESTION_KEYS = ['agent.suggest.extract', 'agent.suggest.cheapest', 'agent.suggest.search']

const STATUS_LABEL_KEY: Record<AgentStatus, string> = {
  idle: 'agent.status.idle',
  running: 'agent.status.running',
  waiting: 'agent.status.waiting',
  done: 'agent.status.done',
  error: 'agent.status.error'
}

function upsertStep(list: AgentStep[], next: AgentStep): AgentStep[] {
  const idx = list.findIndex((s) => s.index === next.index)
  if (idx === -1) return [...list, next].sort((a, b) => a.index - b.index)
  const copy = [...list]
  copy[idx] = next
  return copy
}


function stepIcon(status: StepStatus): 'check' | 'close' | 'alert' | 'play' | null {
  if (status === 'ok') return 'check'
  if (status === 'failed') return 'close'
  if (status === 'confirm') return 'alert'
  if (status === 'rejected') return 'close'
  return null
}

export function AgentPanel({
  profileId,
  tabId,
  pageTitle,
  settings,
  onSettingsSaved,
  onClose
}: AgentPanelProps) {
  const toast = useToast()
  const { t, lang } = useI18n()

  const [intent, setIntent] = useState('')
  const [plan, setPlan] = useState<string[]>([])
  const [steps, setSteps] = useState<AgentStep[]>([])
  const [status, setStatus] = useState<AgentStatus>('idle')
  const [result, setResult] = useState<{ summary: string; tokens: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [title, setTitle] = useState(pageTitle)
  const [text, setText] = useState('')

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [draft, setDraft] = useState<Settings>(settings)
  const [showKey, setShowKey] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [busy, setBusy] = useState(false)

  const flowRef = useRef<HTMLDivElement | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => setTitle(pageTitle), [pageTitle])
  useEffect(() => setDraft(settings), [settings])

  /* ── 订阅 Agent 事件 ── */
  useEffect(() => {
    const off = onAgentEvent((e) => {
      switch (e.type) {
        case 'started':
          setStatus('running')
          setError(null)
          setResult(null)
          break
        case 'plan':
          setPlan(e.plan)
          break
        case 'thinking':
          setStatus('running')
          break
        case 'step':
          setSteps((prev) => upsertStep(prev, e.step))
          if (e.step.status === 'running') setStatus('running')
          break
        case 'need-confirm':
          setConfirm({ reason: e.reason, action: e.action, stepIndex: e.stepIndex })
          setStatus('waiting')
          break
        case 'done':
          setStatus('done')
          setResult({ summary: e.summary, tokens: e.tokens })
          setSteps(e.steps)
          break
        case 'error':
          setStatus('error')
          setError(e.message)
          break
        case 'stopped':
          setStatus('idle')
          break
        default:
          break
      }
    })
    return off
  }, [])

  /* ── 自动滚动到底部 ── */
  useEffect(() => {
    const el = flowRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [steps.length, plan.length, result, error, intent])

  /* ── textarea 自适应高度（上限 108px） ── */
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(108, Math.max(36, el.scrollHeight))}px`
  }, [text])

  const running = status === 'running' || status === 'waiting'
  const needKey = providerNeedKey(draft.provider)
  const endpoint = useMemo(() => resolveEndpoint(draft.baseUrl), [draft.baseUrl])

  const start = useCallback(
    (value: string) => {
      const trimmed = value.trim()
      if (!trimmed) return
      if (!profileId) {
        toast.push(t('agent.toast.noProfile'), 'err')
        return
      }
      if (needKey && !settings.apiKey.trim()) {
        toast.push(t('agent.toast.noApiKey'), 'err')
        setSettingsOpen(true)
        return
      }
      setIntent(trimmed)
      setText('')
      setPlan([])
      setSteps([])
      setResult(null)
      setError(null)
      setStatus('running')
      void (async () => {
        try {
          await bridge().agent.run({ profileId, tabId: tabId ?? undefined, intent: trimmed })
        } catch (err) {
          setStatus('error')
          setError(errorMessage(err))
        }
      })()
    },
    [needKey, profileId, settings.apiKey, tabId, toast, t]
  )

  async function stop(): Promise<void> {
    try {
      await bridge().agent.cancel()
      setStatus('idle')
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    }
  }

  /**
   * 这里**只能取消**。
   *
   * 原先这里有「确认执行」按钮，它会 `invoke('ss:agent:confirm', true)`，
   * 主进程读一个 boolean 就当作用户批准 —— 于是一个被 XSS 的渲染层不用显示任何弹窗，
   * 直接发那条 IPC 就能批准支付。同意来源已经换成主进程弹的系统原生窗口，
   * 这个按钮如果留着，就只是把那个漏洞重新画在界面上：点了不会有任何效果，
   * 却让人以为是自己批准的。所以删掉它，只留「取消本次任务」。
   */
  async function cancelFromConfirm(): Promise<void> {
    setConfirm(null)
    try {
      await bridge().agent.cancel()
      setStatus('idle')
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    }
  }

  async function refreshPage(): Promise<void> {
    if (!profileId) return
    try {
      const snap = await bridge().agent.snapshot(profileId, tabId ?? undefined)
      setTitle(snap.title || pageTitle)
      toast.push(t('agent.toast.resnapshot', { n: snap.elements.length }), 'ok')
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    }
  }

  async function saveSettings(): Promise<void> {
    setBusy(true)
    try {
      const next = await bridge().settings.set(draft)
      onSettingsSaved(next)
      setSettingsOpen(false)
      toast.push(t('agent.toast.settingsSaved'), 'ok')
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setBusy(false)
    }
  }

  async function testConnection(): Promise<void> {
    setBusy(true)
    setTestResult(null)
    try {
      const r = await bridge().settings.test(draft)
      setTestResult(r)
    } catch (err) {
      setTestResult({ ok: false, error: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  const subtitleClass =
    status === 'running' || status === 'waiting'
      ? 'run'
      : status === 'error'
        ? 'bad'
        : ''

  return (
    <aside className="agent-panel" aria-label={t('agent.panel.aria')}>
      <div className="ap-head">
        <div className="ap-mark">
          <Icon name="wave" size={12} strokeWidth={2.2} />
        </div>
        <div className="ap-id">
          <b>ShadowSurf</b>
          <span className={subtitleClass}>
            {t(STATUS_LABEL_KEY[status])}
            {status === 'running' && steps.length > 0
              ? t('agent.status.step', { n: steps.length })
              : ''}
          </span>
        </div>
        <div className="spacer" />
        <button
          type="button"
          className={cx('ap-gear', settingsOpen && 'on')}
          onClick={() => setSettingsOpen((v) => !v)}
          aria-label={t('agent.settings.aria')}
          aria-pressed={settingsOpen}
        >
          <Icon name="settings" size={14} />
        </button>
        <button type="button" className="ap-gear" onClick={onClose} aria-label={t('agent.panel.collapse')}>
          <Icon name="close" size={14} strokeWidth={2} />
        </button>
      </div>

      <div className="ap-context">
        <Icon name="lock" size={11} strokeWidth={2} />
        <span className="t" title={title}>
          {title || t('agent.context.noPage')}
        </span>
        <button
          type="button"
          className="refresh"
          onClick={() => void refreshPage()}
          aria-label={t('agent.context.refresh')}
          title={t('agent.context.refresh')}
        >
          <Icon name="reload" size={11} strokeWidth={2} />
        </button>
      </div>

      {settingsOpen ? (
        <div className="ap-settings scroll-thin">
          <label className="set-lbl">{t('agent.settings.provider')}</label>
          <div className="prov-grid">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={cx('prov', draft.provider === p.id && 'on')}
                title={lang === 'en' ? (p.hintEn ?? p.hint) : p.hint}
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    provider: p.id,
                    baseUrl: p.baseUrl || d.baseUrl,
                    model: p.model || d.model
                  }))
                }
              >
                {lang === 'en' ? (p.labelEn ?? p.label) : p.label}
              </button>
            ))}
          </div>

          <label className="set-lbl">{t('agent.settings.baseUrl')}</label>
          <input
            className="set-input mono"
            value={draft.baseUrl}
            placeholder="https://api.deepseek.com/v1"
            onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
            spellCheck={false}
          />
          <div className="set-hint">
            {t('agent.settings.effectiveRequest')} <b>{endpoint || '—'}</b>
          </div>

          <label className="set-lbl">{t('agent.settings.apiKey')}</label>
          <div className="key-wrap">
            <input
              className="set-input mono"
              type={showKey ? 'text' : 'password'}
              value={draft.apiKey}
              placeholder={needKey ? 'sk-…' : t('agent.settings.keyPlaceholder')}
              onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="button"
              className="key-eye"
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? t('agent.settings.hideKey') : t('agent.settings.showKey')}
            >
              <Icon name={showKey ? 'eyeOff' : 'eye'} size={13} />
            </button>
          </div>
          <div className="set-hint">
            {t('agent.settings.savedKey', { key: maskKey(settings.apiKey) })}
          </div>

          <label className="set-lbl">{t('agent.settings.model')}</label>
          <input
            className="set-input"
            value={draft.model}
            placeholder="deepseek-chat"
            onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
            spellCheck={false}
          />

          <div className="set-row">
            <div>
              <label className="set-lbl">{t('agent.settings.temperature')}</label>
              <input
                className="set-input"
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={draft.temperature}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, temperature: Number(e.target.value) || 0 }))
                }
              />
            </div>
            <div>
              <label className="set-lbl">{t('agent.settings.maxSteps')}</label>
              <input
                className="set-input"
                type="number"
                min="1"
                max="50"
                value={draft.maxSteps}
                onChange={(e) => setDraft((d) => ({ ...d, maxSteps: Number(e.target.value) || 1 }))}
              />
            </div>
            <div>
              <label className="set-lbl">{t('agent.settings.humanize')}</label>
              <select
                className="set-input"
                value={draft.humanizeInput ?? 'light'}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    humanizeInput: e.target.value as Settings['humanizeInput']
                  }))
                }
              >
                <option value="off">{t('agent.humanize.off')}</option>
                <option value="light">{t('agent.humanize.light')}</option>
                <option value="normal">{t('agent.humanize.normal')}</option>
                <option value="slow">{t('agent.humanize.slow')}</option>
              </select>
              <p className="set-hint">{t('agent.settings.humanizeHint')}</p>
            </div>
          </div>

          {testResult ? (
            <div className={testResult.ok ? 'test-ok' : 'test-bad'}>
              <Icon name={testResult.ok ? 'check' : 'alert'} size={12} strokeWidth={2.2} />
              <span>
                {testResult.ok
                  ? t('agent.settings.testOk') +
                    (testResult.latency ? ` · ${testResult.latency}ms` : '') +
                    (testResult.reply ? ` · ${testResult.reply}` : '')
                  : t('agent.settings.testFailed', {
                      error: testResult.error ?? t('agent.settings.unknownError')
                    })}
              </span>
            </div>
          ) : null}

          <div className="set-actions">
            <Button variant="ghost" disabled={busy} onClick={() => void testConnection()}>
              {t('agent.settings.test')}
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void saveSettings()}>
              {t('common.save')}
            </Button>
          </div>

          <div className="set-hint" style={{ marginTop: 10 }}>
            {t('agent.settings.keyNote')}
          </div>
        </div>
      ) : (
        <>
          <div className="ap-flow scroll-thin" ref={flowRef}>
            {!intent && status === 'idle' ? (
              <div className="ap-welcome">
                <div className="mark">
                  <Icon name="wave" size={20} strokeWidth={2.2} />
                </div>
                <h3>{t('agent.welcome.title')}</h3>
                <p>
                  {t('agent.welcome.body1')}
                  <br />
                  {t('agent.welcome.body2')}
                </p>
                <div className="ap-suggest">
                  <div className="lbl">{t('agent.welcome.tryThese')}</div>
                  {SUGGESTION_KEYS.map((key) => (
                    <button key={key} type="button" className="sg" onClick={() => start(t(key))}>
                      <span>{t(key)}</span>
                      <Icon name="chevronRight" size={11} strokeWidth={2} />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {intent ? <div className="bubble">{intent}</div> : null}

            {plan.length > 0 ? (
              <div className="plan">
                <div className="hd">
                  <b>{t('agent.plan.title')}</b>
                  <span>{t('agent.plan.steps', { n: plan.length })}</span>
                </div>
                <ol>
                  {plan.map((line, i) => (
                    <li key={`${i}-${line}`}>
                      <i>{i + 1}.</i>
                      <span>{line}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}

            {steps.length > 0 ? (
              <div className="steps">
                {steps.map((step) => {
                  const icon = stepIcon(step.status)
                  return (
                    <div key={step.index} className={`step ${step.status}`}>
                      <div className="sn">
                        {icon ? (
                          <Icon name={icon} size={9} strokeWidth={3} />
                        ) : (
                          step.index + 1
                        )}
                      </div>
                      <div className="sb">
                        <div className="sa">
                          {step.label}
                          {step.status === 'running' ? (
                            <span className="dots" aria-hidden="true">
                              <i />
                              <i />
                              <i />
                            </span>
                          ) : null}
                        </div>
                        {step.thought ? <div className="sthought">{step.thought}</div> : null}
                        {step.result ? (
                          <div className="sres" title={step.failure ? step.result : undefined}>
                            {stepResultText(step)}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : null}

            {result ? (
              <div className="result-card">
                <div className="hd">
                  <Icon name="check" size={11} strokeWidth={2.6} />
                  {t('agent.result.title')}
                </div>
                <p>{result.summary}</p>
                <div className="meta">
                  {t('agent.result.meta', { steps: steps.length, tokens: result.tokens })}
                </div>
              </div>
            ) : null}

            {error ? (
              <div className="error-card">
                <div className="hd">
                  <Icon name="alert" size={11} strokeWidth={2.2} />
                  {t('agent.error.title')}
                </div>
                <p>{error}</p>
                <div className="act">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="reload"
                    onClick={() => start(intent)}
                  >
                    {t('common.retry')}
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => setSettingsOpen(true)}>
                    {t('agent.error.checkSettings')}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          <div className="ap-input">
            <div className="box">
              <textarea
                ref={taRef}
                value={text}
                placeholder={
                  running
                    ? t('agent.input.placeholderRunning')
                    : t('agent.input.placeholder')
                }
                aria-label={t('agent.input.aria')}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  // 中文输入法选词期间的回车不能触发发送
                  if (e.nativeEvent.isComposing) return
                  if (e.shiftKey) return
                  e.preventDefault()
                  if (!running) start(text)
                }}
              />
              {running ? (
                <button
                  type="button"
                  className="send-btn stop"
                  onClick={() => void stop()}
                  aria-label={t('agent.input.stop')}
                  title={t('agent.input.stop')}
                >
                  <Icon name="stop" size={13} strokeWidth={2} />
                </button>
              ) : (
                <button
                  type="button"
                  className="send-btn"
                  onClick={() => start(text)}
                  disabled={!text.trim()}
                  aria-label={t('agent.input.send')}
                  title={t('agent.input.sendTitle')}
                >
                  <Icon name="arrowRight" size={13} strokeWidth={2} />
                </button>
              )}
            </div>
            <div className="ap-foot">
              <span className={cx('dot', !settings.apiKey && needKey && 'off')} />
              <button
                type="button"
                className="act"
                onClick={() => setSettingsOpen(true)}
                title={t('agent.footer.openSettings')}
              >
                {draft.model || t('agent.footer.noModel')}
              </button>
              <div className="spacer" />
              <span>
                {running
                  ? t('agent.footer.running')
                  : t('agent.footer.maxSteps', { n: draft.maxSteps })}
              </span>
            </div>
          </div>
        </>
      )}

      <Modal
        open={confirm !== null}
        title={t('agent.confirm.title')}
        icon="alert"
        onClose={() => void cancelFromConfirm()}
        footer={
          <>
            <Button variant="ghost" onClick={() => void cancelFromConfirm()}>
              {t('agent.confirm.cancel')}
            </Button>
          </>
        }
        note={t('agent.confirm.note')}
      >
        <span>{confirm?.reason ?? t('agent.confirm.defaultReason')}</span>
        <span className="muted">{t('agent.confirm.body')}</span>
        {confirm ? <span className="code">{describeAction(confirm.action)}</span> : null}
      </Modal>
    </aside>
  )
}
