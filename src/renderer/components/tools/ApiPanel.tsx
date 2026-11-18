/**
 * 本地 API 面板。
 *
 * 在回环地址上起一个带 Bearer Token 的 REST 服务，供外部程序驱动环境。
 * 这一页只做三件事：控制开关、把令牌交到用户手里、把端点写在屏幕上。
 *
 * 样式写在同目录 api.css，类名统一 api- 前缀：
 * 六个工具面板的 css 会同时进同一个样式表，不加前缀迟早互相覆盖。
 */

import { useCallback, useEffect, useState } from 'react'
import type { LocalApiState, Profile } from '@shared/types'
import { Button, Icon, cx, useToast } from '@renderer/components/ui'
import { formatClock, formatRelative } from '@renderer/lib/format'
import { useI18n } from '@renderer/lib/i18n'
import './api.css'

export interface PanelProps {
  profiles: Profile[]
}

const DEFAULT_PORT = 7717

/**
 * 读取本地 API 状态的三态。
 *
 * 为什么不能只用 `LocalApiState | null`：`null` 同时表示「还没读到」和「读不到」，
 * 而渲染层会把它当成「已停止」—— 那是把「不知道」画成「没在跑」。
 * 读不到时唯一诚实的说法是「读不到」，所以 error 必须是独立的一支。
 */
type ApiLoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; state: LocalApiState }

const ENDPOINTS: Array<{ method: 'GET' | 'POST'; path: string; descKey: string }> = [
  { method: 'GET', path: '/health', descKey: 'api.ep.health' },
  { method: 'GET', path: '/profiles', descKey: 'api.ep.profiles' },
  { method: 'POST', path: '/profiles/:id/launch', descKey: 'api.ep.launch' },
  { method: 'POST', path: '/profiles/:id/stop', descKey: 'api.ep.stop' },
  { method: 'GET', path: '/profiles/:id/snapshot', descKey: 'api.ep.snapshot' },
  { method: 'POST', path: '/profiles/:id/act', descKey: 'api.ep.act' },
  { method: 'GET', path: '/tasks', descKey: 'api.ep.tasks' }
]

function errText(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  return fallback
}

/**
 * 去掉 Electron 给 IPC 失败套的那层壳。
 *
 * 为什么这里再写一份：AuditPanel 里那份是模块私有的（没有 export），
 * 而本轮只能动 ApiPanel 与 api.css —— 为了复用它去改审计页属于越界。
 * 正则与那边逐字一致，否则同一个 IPC 错误在两个面板里会显示成两种样子。
 */
function cleanIpcMessage(raw: string): string {
  const m = /Error invoking remote method '[^']*':\s*(?:Error:\s*)?([\s\S]*)$/.exec(raw)
  return (m?.[1] ?? raw).trim()
}

/**
 * 剪贴板：navigator.clipboard 只在安全上下文可用，打包后页面是 file://，
 * 不保证有；所以保留一条 textarea + execCommand 的退路，复制按钮不能有时灵有时不灵。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 落到兜底分支
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

export function ApiPanel({ profiles }: PanelProps) {
  const toast = useToast()
  const { t } = useI18n()
  /* 三态源。原来这里是 `LocalApiState | null`，读取失败只剩 toast 一条，
     面板本体继续按 null 渲染 —— 于是失败长得和「服务没启动」一模一样。 */
  const [load, setLoad] = useState<ApiLoadState>({ kind: 'loading' })
  const [port, setPort] = useState(String(DEFAULT_PORT))
  const [busy, setBusy] = useState(false)

  /* 其它逻辑（指标、端口回显、按钮可用性）只认「读到的那份状态」：
     loading / error 一律 null，不在错误态下把默认值或旧值当成事实。 */
  const state = load.kind === 'ready' ? load.state : null

  /* 读取状态的唯一入口：首次加载和「重试」按钮共用一条路径，
     否则重试会和首屏跑出两套不同的成功/失败处理。 */
  const loadState = useCallback(async (): Promise<void> => {
    setLoad({ kind: 'loading' })
    try {
      const next = await window.ss.localApi.state()
      setLoad({ kind: 'ready', state: next })
      if (next.port > 0) setPort(String(next.port))
    } catch (err) {
      // 错误留在原地，不能只弹 toast：toast 会消失，消失后面板又会回到
      // 「已停止」那句假话。原因里的通道名是 IPC 噪音，先剥掉。
      setLoad({
        kind: 'error',
        message: cleanIpcMessage(errText(err, t('api.err.readState')))
      })
    }
  }, [t])

  useEffect(() => {
    void loadState()
    // 主进程每次状态变化都会推一遍，页面不需要轮询
    const off = window.ss.localApi.onState((next) => setLoad({ kind: 'ready', state: next }))
    return () => off()
  }, [loadState])

  const running = state?.running === true
  const portNumber = Number(port)
  const portValid =
    /^\d{1,5}$/.test(port) && portNumber >= 1 && portNumber <= 65535 && Number.isInteger(portNumber)

  const call = useCallback(
    async (task: () => Promise<LocalApiState>, okText: string) => {
      setBusy(true)
      try {
        const next = await task()
        setLoad({ kind: 'ready', state: next })
        if (next.port > 0) setPort(String(next.port))
        toast.push(okText, 'ok')
      } catch (err) {
        toast.push(errText(err, t('api.err.operation')), 'err')
      } finally {
        setBusy(false)
      }
    },
    [toast, t]
  )

  const onStart = (): void => {
    if (!portValid) {
      toast.push(t('api.err.port'), 'err')
      return
    }
    void call(() => window.ss.localApi.start(portNumber), t('api.toast.started'))
  }

  const onStop = (): void => {
    void call(() => window.ss.localApi.stop(), t('api.toast.stopped'))
  }

  // 契约里没有单独的 regenerate 通道，主进程把「已运行时再次 start」约定为重掷令牌
  const onRegenerate = (): void => {
    void call(() => window.ss.localApi.start(), t('api.toast.regenerated'))
  }

  const onCopy = async (text: string, label: string): Promise<void> => {
    const ok = await copyText(text)
    toast.push(ok ? t('api.toast.copied', { label }) : t('common.copyFailed'), ok ? 'ok' : 'err')
  }

  /**
   * 令牌不走 IPC 回到这里 —— 只有主进程能把它写进剪贴板。
   *
   * 界面上不显示完整令牌是刻意的：能显示就能被读走，而这一页跑在渲染层，
   * 恰恰是最可能被页面内容攻破的那一层。用户真正的需求是「粘到别处」，
   * 剪贴板正好满足，且渲染层读不到剪贴板。
   */
  const onCopyToken = async (): Promise<void> => {
    try {
      await window.ss.localApi.copyToken()
      toast.push(t('api.toast.tokenCopied'), 'ok')
    } catch (err) {
      toast.push(errText(err, t('api.err.copyToken')), 'err')
    }
  }

  const base = `http://127.0.0.1:${state?.port && state.port > 0 ? state.port : DEFAULT_PORT}`
  const sampleId = profiles[0]?.id ?? 'prf_xxxxxxxxxxxx'

  const curlShown = `curl -X POST "${base}/profiles/${sampleId}/launch" \\\n  -H "Authorization: Bearer <token>"`

  return (
    <div className="api-panel">
      <header className="api-head">
        <div>
          <h2>{t('api.title')}</h2>
          <p>{t('api.subtitle', { n: profiles.length })}</p>
        </div>
      </header>

      <section className="api-card">
        <div className="api-status">
          {/* 读不到时绝不落到「已停止」那一支 —— 那是把「不知道」画成「没在跑」。
              「读取中…」与「已停止」也分开：前者是没结论，后者是结论。 */}
          {load.kind === 'error' ? (
            <div className="api-err" role="alert">
              <Icon name="alert" size={13} strokeWidth={2} />
              <div className="api-err-body">
                <b>{t('api.error.title')}</b>
                <span>{load.message}</span>
              </div>
              <Button size="sm" variant="ghost" icon="reload" onClick={() => void loadState()}>
                {t('common.retry')}
              </Button>
            </div>
          ) : (
            <span className={cx('api-state', running && 'on')}>
              <i />
              {load.kind === 'loading'
                ? t('api.loading')
                : running
                  ? t('api.running')
                  : t('api.stopped')}
            </span>
          )}
          <code className="api-addr">{base}</code>
          <div className="api-controls">
            <input
              className="api-input"
              value={port}
              inputMode="numeric"
              aria-label={t('api.portAria')}
              title={running ? t('api.port.title.running') : t('api.port.title.idle')}
              disabled={running || busy}
              onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, '').slice(0, 5))}
            />
            {running ? (
              <Button variant="danger" icon="stop" disabled={busy} onClick={onStop}>
                {t('api.stop')}
              </Button>
            ) : (
              <Button variant="primary" icon="play" disabled={busy} onClick={onStart}>
                {t('api.start')}
              </Button>
            )}
          </div>
        </div>

        <div className="api-metrics">
          <div className="api-metric">
            <span>{t('api.metric.address')}</span>
            <b>127.0.0.1</b>
          </div>
          <div className="api-metric">
            <span>{t('api.metric.port')}</span>
            <b>{running && state?.port ? state.port : '—'}</b>
          </div>
          <div className="api-metric">
            <span>{t('api.metric.requests')}</span>
            <b>{state ? state.requests.toLocaleString('en-US') : '—'}</b>
          </div>
          <div className="api-metric">
            <span>{t('api.metric.startedAt')}</span>
            <b>{state?.startedAt ? formatClock(state.startedAt) : '—'}</b>
            {state?.startedAt ? <em>{formatRelative(state.startedAt)}</em> : null}
          </div>
        </div>
      </section>

      <section className="api-card">
        <div className="api-card-head">
          <h3>{t('api.token.title')}</h3>
          <span>{t('api.token.requirement')}</span>
        </div>
        {/* 能力边界必须放在令牌**之前**。
            这个面板原本已经说了三件让人安心的事（令牌存在哪、不印完整值、只监听回环），
            每句都成立，但语义方向一致 —— 用户读完会得出「风险已处理」。
            而唯一该说的那句一直缺席：持有这个令牌 = 能在这台机器上执行任意环境的
            不可逆动作。部分披露比完全不提更误导，因为用户会以为问完了。

            令牌不再泄露给渲染层之后，这里的能力边界也要跟着改口径：
            持有令牌能做的是**可回退动作**；不可逆动作仍然要人在应用窗口上点一次。
            写「持有令牌就能支付」在改动之后是错的，而错的边界说明比没有更糟。 */}
        <p className="api-scope">
          <Icon name="alert" size={13} strokeWidth={2} />
          <span>
            {t('api.scope.lead')}
            <strong>{t('api.scope.anyProfile')}</strong>
            {t('api.scope.afterAny')}
            <strong>{t('api.scope.reversible')}</strong>
            {t('api.scope.afterReversible')}
            <strong>{t('api.scope.irreversible')}</strong>
            {t('api.scope.afterIrreversible')}
            <br />
            {t('api.scope.br')}
            <strong>{t('api.scope.design')}</strong>
            {t('api.scope.tail')}
          </span>
        </p>
        <div className="api-token">
          <code className="api-token-value">{t('api.token.hidden')}</code>
          <div className="api-tools">
            <Button size="sm" variant="ghost" onClick={() => void onCopyToken()}>
              {t('api.token.copy')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon="dice"
              disabled={!running || busy}
              title={
                running
                  ? t('api.token.regenerate.title.on')
                  : t('api.token.regenerate.title.off')
              }
              onClick={onRegenerate}
            >
              {t('api.token.regenerate')}
            </Button>
          </div>
        </div>
        <p className="api-hint">
          {t('api.hint.lead')}
          <strong>{t('api.hint.noShow')}</strong>
          {t('api.hint.mid')}
          <strong>{t('api.hint.regenerate')}</strong>
          {t('api.hint.tail')}
        </p>
      </section>

      <section className="api-card">
        <div className="api-card-head">
          <h3>{t('api.endpoints.title')}</h3>
          <span>
            {t('api.endpoints.response', {
              ok: '{ ok: true, data }',
              error: '{ ok: false, error }'
            })}
          </span>
        </div>
        <div className="api-endpoints">
          {ENDPOINTS.map((ep) => (
            <div className="api-ep" key={`${ep.method} ${ep.path}`}>
              <span className={cx('api-method', ep.method.toLowerCase())}>{ep.method}</span>
              <code className="api-path">{ep.path}</code>
              <span className="api-desc">{t(ep.descKey)}</span>
            </div>
          ))}
        </div>
        <p className="api-hint">
          {t('api.act.lead')}
          {`{ "action": { "type": "click", "id": "e3" } }`}
          {t('api.act.afterBody')}
          {`"confirm": true`}{' '}
          <strong>{t('api.act.noEffect')}</strong>
          {t('api.act.tail')}
        </p>
      </section>

      <section className="api-card">
        <div className="api-card-head">
          <h3>{t('api.example.title')}</h3>
          <span>{t('api.example.hint')}</span>
        </div>
        <pre className="api-curl">{curlShown}</pre>
        <div className="api-curl-foot">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void onCopy(curlShown, t('api.copy.curl'))}
          >
            {t('api.example.copy')}
          </Button>
          <span className="api-hint">{t('api.example.body')}</span>
        </div>
      </section>

      {/* 这里原本用的是 shield 图标。shield 在这个产品里固定表示「安全能力」
          （侧栏审计、审计页分数都用它），拿它给一条安抚信息背书，
          等于把「我们已经处理好了」又加固了一层。换成中性的 globe：
          这条只是说明服务监听在哪，不是一项安全保证。 */}
      <p className="api-note">
        <Icon name="globe" size={13} strokeWidth={2} />
        {t('api.note.lead')}
        <strong>{t('api.note.who')}</strong>
        {t('api.note.tail')}
      </p>
    </div>
  )
}
