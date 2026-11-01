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
import type { Settings, TestResult } from '@shared/types'
import { PROVIDERS } from '@shared/presets'
import { Button, Icon, Modal, cx, useToast } from './ui'
import { bridge, errorMessage, onAgentEvent } from '@renderer/lib/api'
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

const SUGGESTIONS = ['提取这一页的关键信息', '把这一页里价格最低的套餐列出来', '在页面里找到搜索框并搜索「shadow」']

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: '影子待命',
  running: '正在执行',
  waiting: '等待确认',
  done: '已完成',
  error: '执行出错'
}

function upsertStep(list: AgentStep[], next: AgentStep): AgentStep[] {
  const idx = list.findIndex((s) => s.index === next.index)
  if (idx === -1) return [...list, next].sort((a, b) => a.index - b.index)
  const copy = [...list]
  copy[idx] = next
  return copy
}

/**
 * 把动作翻译成一句人话。
 *
 * 渲染层手里**没有快照**，所以拿不到元素的可读名 —— 那就说「某个元素」，
 * 绝不把 `action.id`（协议里的 `e12`）印出来：那是每轮临时分配的编号，
 * 对用户没有意义，出现在界面上只会让人以为页面上真有个叫 e12 的东西。
 * 主进程侧有快照，那边由 `describeAction(action, snapshot)` 给出带名字的版本。
 */
function describeAction(action: Action): string {
  switch (action.type) {
    case 'click':
      return '点击某个页面元素'
    case 'type':
      return `在某个输入框输入「${action.text ?? ''}」${action.submit ? ' 并回车提交' : ''}`
    case 'press':
      return `按下 ${action.key ?? '（未指定）'} 键`
    case 'scroll':
      return `向${action.direction ?? '下'}滚动 ${action.amount ?? ''}`
    case 'navigate':
      return `导航到 ${action.url ?? '（未指定地址）'}`
    case 'extract':
      return `提取：${action.query ?? '（未指定内容）'}`
    default:
      return action.summary ?? '结束任务'
  }
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
        toast.push('当前没有可用的环境，请先打开一个环境', 'err')
        return
      }
      if (needKey && !settings.apiKey.trim()) {
        toast.push('还没有配置模型 API Key', 'err')
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
    [needKey, profileId, settings.apiKey, tabId, toast]
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
      toast.push(`已重新读取：${snap.elements.length} 个可交互元素`, 'ok')
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
      toast.push('模型配置已保存', 'ok')
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
    <aside className="agent-panel" aria-label="影子面板">
      <div className="ap-head">
        <div className="ap-mark">
          <Icon name="wave" size={12} strokeWidth={2.2} />
        </div>
        <div className="ap-id">
          <b>ShadowSurf</b>
          <span className={subtitleClass}>
            {STATUS_LABEL[status]}
            {status === 'running' && steps.length > 0 ? ` · 第 ${steps.length} 步` : ''}
          </span>
        </div>
        <div className="spacer" />
        <button
          type="button"
          className={cx('ap-gear', settingsOpen && 'on')}
          onClick={() => setSettingsOpen((v) => !v)}
          aria-label="模型设置"
          aria-pressed={settingsOpen}
        >
          <Icon name="settings" size={14} />
        </button>
        <button type="button" className="ap-gear" onClick={onClose} aria-label="收起侧栏">
          <Icon name="close" size={14} strokeWidth={2} />
        </button>
      </div>

      <div className="ap-context">
        <Icon name="lock" size={11} strokeWidth={2} />
        <span className="t" title={title}>
          {title || '未打开页面'}
        </span>
        <button
          type="button"
          className="refresh"
          onClick={() => void refreshPage()}
          aria-label="重新读取当前页面"
          title="重新读取当前页面"
        >
          <Icon name="reload" size={11} strokeWidth={2} />
        </button>
      </div>

      {settingsOpen ? (
        <div className="ap-settings scroll-thin">
          <label className="set-lbl">服务商</label>
          <div className="prov-grid">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={cx('prov', draft.provider === p.id && 'on')}
                title={p.hint}
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    provider: p.id,
                    baseUrl: p.baseUrl || d.baseUrl,
                    model: p.model || d.model
                  }))
                }
              >
                {p.label}
              </button>
            ))}
          </div>

          <label className="set-lbl">BASE URL</label>
          <input
            className="set-input mono"
            value={draft.baseUrl}
            placeholder="https://api.deepseek.com/v1"
            onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
            spellCheck={false}
          />
          <div className="set-hint">
            实际请求：<b>{endpoint || '—'}</b>
          </div>

          <label className="set-lbl">API KEY</label>
          <div className="key-wrap">
            <input
              className="set-input mono"
              type={showKey ? 'text' : 'password'}
              value={draft.apiKey}
              placeholder={needKey ? 'sk-…' : '本地模型可留空'}
              onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="button"
              className="key-eye"
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? '隐藏 Key' : '显示 Key'}
            >
              <Icon name={showKey ? 'eyeOff' : 'eye'} size={13} />
            </button>
          </div>
          <div className="set-hint">已保存的 Key：{maskKey(settings.apiKey)}</div>

          <label className="set-lbl">模型</label>
          <input
            className="set-input"
            value={draft.model}
            placeholder="deepseek-chat"
            onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
            spellCheck={false}
          />

          <div className="set-row">
            <div>
              <label className="set-lbl">温度</label>
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
              <label className="set-lbl">最大步数</label>
              <input
                className="set-input"
                type="number"
                min="1"
                max="50"
                value={draft.maxSteps}
                onChange={(e) => setDraft((d) => ({ ...d, maxSteps: Number(e.target.value) || 1 }))}
              />
            </div>
          </div>

          {testResult ? (
            <div className={testResult.ok ? 'test-ok' : 'test-bad'}>
              <Icon name={testResult.ok ? 'check' : 'alert'} size={12} strokeWidth={2.2} />
              <span>
                {testResult.ok
                  ? `连接正常${testResult.latency ? ` · ${testResult.latency}ms` : ''}${testResult.reply ? ` · ${testResult.reply}` : ''}`
                  : `连接失败：${testResult.error ?? '未知错误'}`}
              </span>
            </div>
          ) : null}

          <div className="set-actions">
            <Button variant="ghost" disabled={busy} onClick={() => void testConnection()}>
              测试连接
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void saveSettings()}>
              保存
            </Button>
          </div>

          <div className="set-hint" style={{ marginTop: 10 }}>
            Key 只保存在本机，请求直连你填写的服务商，不经任何中转服务器。共用电脑请用完清空。
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
                <h3>影子待命</h3>
                <p>
                  我能读懂这一页，也能替你点按钮。
                  <br />
                  先告诉我你想做什么。
                </p>
                <div className="ap-suggest">
                  <div className="lbl">试试这些</div>
                  {SUGGESTIONS.map((s) => (
                    <button key={s} type="button" className="sg" onClick={() => start(s)}>
                      <span>{s}</span>
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
                  <b>计划</b>
                  <span>{plan.length} 步</span>
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
                  已完成
                </div>
                <p>{result.summary}</p>
                <div className="meta">
                  {steps.length} 步 · {result.tokens} tokens
                </div>
              </div>
            ) : null}

            {error ? (
              <div className="error-card">
                <div className="hd">
                  <Icon name="alert" size={11} strokeWidth={2.2} />
                  执行失败
                </div>
                <p>{error}</p>
                <div className="act">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="reload"
                    onClick={() => start(intent)}
                  >
                    重试
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => setSettingsOpen(true)}>
                    检查模型配置
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
                placeholder={running ? '执行中可以继续输入下一个任务' : '让影子做点什么…'}
                aria-label="任务输入"
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
                  aria-label="停止执行"
                  title="停止执行"
                >
                  <Icon name="stop" size={13} strokeWidth={2} />
                </button>
              ) : (
                <button
                  type="button"
                  className="send-btn"
                  onClick={() => start(text)}
                  disabled={!text.trim()}
                  aria-label="发送"
                  title="发送（Enter）"
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
                title="打开模型设置"
              >
                {draft.model || '未配置模型'}
              </button>
              <div className="spacer" />
              <span>{running ? '执行中 · 可继续输入' : `上限 ${draft.maxSteps} 步`}</span>
            </div>
          </div>
        </>
      )}

      <Modal
        open={confirm !== null}
        title="等待你在系统窗口中确认"
        icon="alert"
        onClose={() => void cancelFromConfirm()}
        footer={
          <>
            <Button variant="ghost" onClick={() => void cancelFromConfirm()}>
              取消本次任务
            </Button>
          </>
        }
        note="确认窗口由操作系统绘制 · 这个页面无权替你点「允许」"
      >
        <span>
          {confirm?.reason ?? '这一步可能产生不可逆的结果。'}
        </span>
        <span className="muted">
          请到应用弹出的系统确认窗口上点「允许执行」。这里的按钮只能取消 ——
          批准必须来自那个窗口，否则被篡改的界面就能自己批准自己。
        </span>
        {confirm ? <span className="code">{describeAction(confirm.action)}</span> : null}
      </Modal>
    </aside>
  )
}
