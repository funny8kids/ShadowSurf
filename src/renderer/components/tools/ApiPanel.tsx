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
import './api.css'

export interface PanelProps {
  profiles: Profile[]
}

const DEFAULT_PORT = 7717

const ENDPOINTS: Array<{ method: 'GET' | 'POST'; path: string; desc: string }> = [
  { method: 'GET', path: '/health', desc: '探活，唯一免鉴权的端点' },
  { method: 'GET', path: '/profiles', desc: '环境列表' },
  { method: 'POST', path: '/profiles/:id/launch', desc: '启动环境' },
  { method: 'POST', path: '/profiles/:id/stop', desc: '停止环境' },
  { method: 'GET', path: '/profiles/:id/snapshot', desc: '页面快照' },
  { method: 'POST', path: '/profiles/:id/act', desc: '执行单个动作' },
  { method: 'GET', path: '/tasks', desc: '任务列表' }
]

function errText(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  return fallback
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
  const [state, setState] = useState<LocalApiState | null>(null)
  const [port, setPort] = useState(String(DEFAULT_PORT))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void window.ss.localApi
      .state()
      .then((next) => {
        if (!alive) return
        setState(next)
        if (next.port > 0) setPort(String(next.port))
      })
      .catch((err: unknown) => {
        if (alive) toast.push(errText(err, '读取本地 API 状态失败'), 'err')
      })

    // 主进程每次状态变化都会推一遍，页面不需要轮询
    const off = window.ss.localApi.onState((next) => setState(next))
    return () => {
      alive = false
      off()
    }
  }, [toast])

  const running = state?.running === true
  const portNumber = Number(port)
  const portValid =
    /^\d{1,5}$/.test(port) && portNumber >= 1 && portNumber <= 65535 && Number.isInteger(portNumber)

  const call = useCallback(
    async (task: () => Promise<LocalApiState>, okText: string) => {
      setBusy(true)
      try {
        const next = await task()
        setState(next)
        if (next.port > 0) setPort(String(next.port))
        toast.push(okText, 'ok')
      } catch (err) {
        toast.push(errText(err, '操作失败'), 'err')
      } finally {
        setBusy(false)
      }
    },
    [toast]
  )

  const onStart = (): void => {
    if (!portValid) {
      toast.push('端口必须是 1-65535 之间的整数', 'err')
      return
    }
    void call(() => window.ss.localApi.start(portNumber), '本地 API 已启动')
  }

  const onStop = (): void => {
    void call(() => window.ss.localApi.stop(), '本地 API 已停止')
  }

  // 契约里没有单独的 regenerate 通道，主进程把「已运行时再次 start」约定为重掷令牌
  const onRegenerate = (): void => {
    void call(() => window.ss.localApi.start(), '令牌已重新生成，旧令牌立即失效')
  }

  const onCopy = async (text: string, label: string): Promise<void> => {
    const ok = await copyText(text)
    toast.push(ok ? `${label}已复制` : '复制失败，请手动选中文本复制', ok ? 'ok' : 'err')
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
      toast.push('令牌已复制到剪贴板', 'ok')
    } catch (err) {
      toast.push(errText(err, '复制令牌失败'), 'err')
    }
  }

  const base = `http://127.0.0.1:${state?.port && state.port > 0 ? state.port : DEFAULT_PORT}`
  const sampleId = profiles[0]?.id ?? 'prf_xxxxxxxxxxxx'

  const curlShown = `curl -X POST "${base}/profiles/${sampleId}/launch" \\\n  -H "Authorization: Bearer <token>"`

  return (
    <div className="api-panel">
      <header className="api-head">
        <div>
          <h2>本地 API</h2>
          <p>
            在回环地址上起一个 REST 服务，外部脚本、CLI、IDE 插件都能用它驱动环境。
            当前 {profiles.length} 个环境可被调用。
          </p>
        </div>
      </header>

      <section className="api-card">
        <div className="api-status">
          <span className={cx('api-state', running && 'on')}>
            <i />
            {running ? '运行中' : '已停止'}
          </span>
          <code className="api-addr">{base}</code>
          <div className="api-controls">
            <input
              className="api-input"
              value={port}
              inputMode="numeric"
              aria-label="监听端口"
              title={running ? '停止后才能修改端口' : '监听端口，默认 7717'}
              disabled={running || busy}
              onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, '').slice(0, 5))}
            />
            {running ? (
              <Button variant="danger" icon="stop" disabled={busy} onClick={onStop}>
                停止
              </Button>
            ) : (
              <Button variant="primary" icon="play" disabled={busy} onClick={onStart}>
                启动
              </Button>
            )}
          </div>
        </div>

        <div className="api-metrics">
          <div className="api-metric">
            <span>监听地址</span>
            <b>127.0.0.1</b>
          </div>
          <div className="api-metric">
            <span>端口</span>
            <b>{running && state?.port ? state.port : '—'}</b>
          </div>
          <div className="api-metric">
            <span>已处理请求</span>
            <b>{state ? state.requests.toLocaleString('en-US') : '—'}</b>
          </div>
          <div className="api-metric">
            <span>启动时间</span>
            <b>{state?.startedAt ? formatClock(state.startedAt) : '—'}</b>
            {state?.startedAt ? <em>{formatRelative(state.startedAt)}</em> : null}
          </div>
        </div>
      </section>

      <section className="api-card">
        <div className="api-card-head">
          <h3>访问令牌</h3>
          <span>除 /health 外，所有请求都要带 Authorization: Bearer &lt;token&gt;</span>
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
            持有此令牌的本地进程可以在<strong>任意环境</strong>上执行操作。
            <strong>可回退动作</strong>（点击链接、滚动、取数）直接执行；
            <strong>不可逆动作</strong>（支付、删除、发布、发送）需要在本机弹窗确认，
            必须有人当场点「允许执行」才会跑 —— 无人值守的自动化跑到那一步会停住，
            然后在 120 秒后拿到 409 超时。
            <br />
            这不是能力限制，是设计：<strong>自动化可以做，不可逆的那一下要有人在场。</strong>
            令牌文件以当前用户身份可读，同一账户下的其他程序也能读到它。
          </span>
        </p>
        <div className="api-token">
          <code className="api-token-value">保存在主进程内，界面不显示</code>
          <div className="api-tools">
            <Button size="sm" variant="ghost" onClick={() => void onCopyToken()}>
              复制令牌
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon="dice"
              disabled={!running || busy}
              title={running ? '作废旧令牌并生成新的' : '服务启动后才能重新生成令牌'}
              onClick={onRegenerate}
            >
              重新生成
            </Button>
          </div>
        </div>
        <p className="api-hint">
          令牌是 32 字节随机值，存在数据目录的 local-api-token.json 里，重启应用不会变。
          <strong> 界面上没有「显示令牌」是有意的</strong>：这一页跑在渲染层，能显示就能被读走。
          「复制令牌」由主进程直接写剪贴板，明文不经过这里。
          <strong> 重新生成是唯一的补救动作</strong>：作废旧令牌后，已发出的调用立即失效。
        </p>
      </section>

      <section className="api-card">
        <div className="api-card-head">
          <h3>端点速查</h3>
          <span>成功返回 {`{ ok: true, data }`}，失败返回 {`{ ok: false, error }`}</span>
        </div>
        <div className="api-endpoints">
          {ENDPOINTS.map((ep) => (
            <div className="api-ep" key={`${ep.method} ${ep.path}`}>
              <span className={cx('api-method', ep.method.toLowerCase())}>{ep.method}</span>
              <code className="api-path">{ep.path}</code>
              <span className="api-desc">{ep.desc}</span>
            </div>
          ))}
        </div>
        <p className="api-hint">
          /act 的 body 形如 {`{ "action": { "type": "click", "id": "e3" } }`}；
          元素编号取自 /snapshot，编号不存在会被直接拒绝。
          body 里的 {`"confirm": true`} <strong>没有任何效力</strong>：
          不可逆动作的授权只能来自应用窗口上的一次人工点击。
        </p>
      </section>

      <section className="api-card">
        <div className="api-card-head">
          <h3>调用示例</h3>
          <span>复制后可直接在终端执行</span>
        </div>
        <pre className="api-curl">{curlShown}</pre>
        <div className="api-curl-foot">
          <Button size="sm" variant="ghost" onClick={() => void onCopy(curlShown, 'curl 命令')}>
            复制 curl
          </Button>
          <span className="api-hint">
            示例用的是列表里第一个环境，可替换成任意 profile id。复制后把 &lt;token&gt;
            换成上一步「复制令牌」拿到的那串值。
          </span>
        </div>
      </section>

      {/* 这里原本用的是 shield 图标。shield 在这个产品里固定表示「安全能力」
          （侧栏审计、审计页分数都用它），拿它给一条安抚信息背书，
          等于把「我们已经处理好了」又加固了一层。换成中性的 globe：
          这条只是说明服务监听在哪，不是一项安全保证。 */}
      <p className="api-note">
        <Icon name="globe" size={13} strokeWidth={2} />
        只监听 127.0.0.1，局域网访问不到；关闭服务或退出应用后端口立即释放。
        这限制的是<strong>谁能连上来</strong>，不限制连上之后能做什么 —— 能力边界见上方令牌说明。
      </p>
    </div>
  )
}
