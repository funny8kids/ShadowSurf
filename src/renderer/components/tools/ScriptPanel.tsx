/**
 * 自动化脚本面板。
 *
 * 左侧脚本库，右侧步骤编辑器。回放走主进程的确定性执行器，这里只负责收集参数、
 * 展示 ScriptRunResult，不做任何「猜元素」的逻辑 —— 猜错比报错更难排查。
 *
 * 「从任务导入」把 AgentStep 转成 ScriptStep 时，只取 status === 'ok' 的步骤：
 * 失败/被拒绝的步骤重放没有意义，只会让脚本第一次跑就断在同一个地方。
 * AgentStep 里没有选择器（模型只拿到 e1..eN 编号），因此用 label 里的「元素名」
 * 拼成 name=xxx 选择器，回放时按可读名重新解析。
 *
 * 归属：rpa-agent
 * 样式写在同目录 script.css，不要往全局 app.css 里加，
 * 否则多个模块并行开发时会互相覆盖。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AutomationScript,
  Profile,
  ScriptRunResult,
  ScriptStep,
  TaskRecord
} from '@shared/types'
import type { ScriptRunOptions } from '@shared/ipc'
import type { ActionType, AgentStep } from '@shared/protocol'
import { Button, Icon, Modal, cx, useToast } from '@renderer/components/ui'
import { bridge, errorMessage } from '@renderer/lib/api'
import { formatRelative, profileNo } from '@renderer/lib/format'
import './script.css'

export interface PanelProps {
  profiles: Profile[]
}

const DEFAULT_DELAY = 300

/** 下拉里显示中文名，值仍然是协议里的 ActionType，避免两套枚举 */
const ACTION_LABEL: Record<ActionType, string> = {
  click: '点击',
  type: '输入',
  press: '按键',
  scroll: '滚动',
  navigate: '打开网址',
  extract: '提取内容',
  done: '结束脚本'
}

const ACTION_ORDER: ActionType[] = ['click', 'type', 'press', 'scroll', 'navigate', 'extract', 'done']

/** 这三类动作必须指向具体元素，选择器为空时直接拦住，别等到回放才报错 */
const NEEDS_SELECTOR = new Set<ActionType>(['click', 'type', 'press'])

const SELECTOR_HINT: Partial<Record<ActionType, string>> = {
  click: '如 role=button name=登录',
  type: '如 role=textbox name=邮箱',
  press: '如 role=textbox name=搜索'
}

function cloneScript(script: AutomationScript): AutomationScript {
  // 旧版本落盘的记录可能没有 steps 字段，这里补齐，避免编辑器首屏就崩
  const steps = Array.isArray(script.steps) ? script.steps : []
  return { ...script, steps: steps.map((step) => ({ ...step })) }
}

function blankScript(): AutomationScript {
  const now = Date.now()
  return { id: '', name: '未命名脚本', description: '', steps: [], createdAt: now, updatedAt: now }
}

/**
 * 从历史任务的单步记录反推脚本步骤。
 * 编号（e3）只在录制那一帧有效，所以优先用 label 里的「元素名」，
 * 拿不到名字时才退回编号 —— 那种情况基本只能在同一页面里重放。
 */
function toScriptStep(step: AgentStep): ScriptStep | null {
  const action = step.action
  const name = /「([^」]+)」/.exec(step.label)?.[1]?.trim()
  const selector = name ? `name=${name}` : action.id ? `#${action.id}` : undefined

  switch (action.type) {
    case 'click':
      return selector ? { action: 'click', selector, delayMs: DEFAULT_DELAY } : null
    case 'type':
      return selector
        ? { action: 'type', selector, text: action.text ?? '', delayMs: DEFAULT_DELAY }
        : null
    case 'press':
      return selector
        ? { action: 'press', selector, key: action.key ?? 'Enter', delayMs: DEFAULT_DELAY }
        : null
    case 'scroll':
      return {
        action: 'scroll',
        key: action.direction ?? 'down',
        text: action.amount ? String(action.amount) : '',
        delayMs: DEFAULT_DELAY
      }
    case 'navigate':
      return action.url ? { action: 'navigate', url: action.url, delayMs: DEFAULT_DELAY } : null
    case 'extract':
      return { action: 'extract', text: action.query ?? '', delayMs: DEFAULT_DELAY }
    default:
      // done 是任务的收尾标记，不是可复用的页面动作
      return null
  }
}

function importableSteps(task: TaskRecord): ScriptStep[] {
  const out: ScriptStep[] = []
  for (const step of task.steps) {
    if (step.status !== 'ok') continue
    const converted = toScriptStep(step)
    if (converted) out.push(converted)
  }
  return out
}

export function ScriptPanel({ profiles }: PanelProps) {
  const toast = useToast()

  const [scripts, setScripts] = useState<AutomationScript[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<AutomationScript | null>(null)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [runProfileId, setRunProfileId] = useState('')
  const [result, setResult] = useState<ScriptRunResult | null>(null)

  const [importOpen, setImportOpen] = useState(false)
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [tasksLoading, setTasksLoading] = useState(false)

  const [pendingSelect, setPendingSelect] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AutomationScript | null>(null)
  /** 回放被风险闸门拦下，等用户看过原因再决定续不续 */
  const [pendingRun, setPendingRun] = useState<ScriptRunResult | null>(null)

  const loadScripts = useCallback(async () => {
    setLoading(true)
    try {
      const list = await bridge().scripts.list()
      setScripts(list)
      setSelectedId((current) => current ?? list[0]?.id ?? null)
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void loadScripts()
  }, [loadScripts])

  // 选中项变化或落盘后刷新草稿；编辑期间 scripts 不变，所以不会冲掉正在改的内容
  useEffect(() => {
    if (selectedId === null) return
    const found = scripts.find((item) => item.id === selectedId)
    setDraft(found ? cloneScript(found) : null)
    setDirty(false)
  }, [selectedId, scripts])

  // 默认挑一个正在运行的环境，省得每次回放都要手选
  useEffect(() => {
    if (profiles.length === 0) {
      setRunProfileId('')
      return
    }
    if (runProfileId && profiles.some((p) => p.id === runProfileId)) return
    const running = profiles.find((p) => p.status === 'running') ?? profiles[0]
    setRunProfileId(running.id)
  }, [profiles, runProfileId])

  const sorted = useMemo(
    () => [...scripts].sort((a, b) => b.updatedAt - a.updatedAt),
    [scripts]
  )

  const importableTasks = useMemo(
    () => tasks.filter((task) => task.steps.some((s) => s.status === 'ok')),
    [tasks]
  )

  /* ────────────────────────────── 选择与编辑 ────────────────────────────── */

  function requestSelect(id: string) {
    if (id === selectedId) return
    if (dirty) {
      setPendingSelect(id)
      return
    }
    setSelectedId(id)
    setResult(null)
  }

  function startNew() {
    if (dirty) {
      setPendingSelect('')
      return
    }
    setSelectedId(null)
    setDraft(blankScript())
    setDirty(true)
    setResult(null)
  }

  function patchDraft(patch: Partial<AutomationScript>) {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev))
    setDirty(true)
  }

  function patchStep(index: number, patch: Partial<ScriptStep>) {
    setDraft((prev) => {
      if (!prev) return prev
      const steps = prev.steps.map((step, i) => (i === index ? { ...step, ...patch } : step))
      return { ...prev, steps }
    })
    setDirty(true)
  }

  /** 切换动作类型时重建字段：留着上一种动作的残留参数，回放时最容易看走眼 */
  function changeAction(index: number, action: ActionType) {
    setDraft((prev) => {
      if (!prev) return prev
      const old = prev.steps[index]
      const next: ScriptStep = { action, delayMs: old.delayMs ?? DEFAULT_DELAY }
      if (NEEDS_SELECTOR.has(action) && old.selector) next.selector = old.selector
      if (action === 'navigate') next.url = old.url ?? 'https://'
      if (action === 'type' || action === 'extract') next.text = old.text ?? ''
      if (action === 'press') next.key = old.key ?? 'Enter'
      if (action === 'scroll') {
        next.key = old.key ?? 'down'
        next.text = old.text ?? ''
      }
      if (action === 'done') next.note = old.note ?? ''
      const steps = prev.steps.map((step, i) => (i === index ? next : step))
      return { ...prev, steps }
    })
    setDirty(true)
  }

  function addStep() {
    setDraft((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        steps: [...prev.steps, { action: 'click', selector: '', delayMs: DEFAULT_DELAY }]
      }
    })
    setDirty(true)
  }

  function removeStep(index: number) {
    setDraft((prev) => {
      if (!prev) return prev
      return { ...prev, steps: prev.steps.filter((_, i) => i !== index) }
    })
    setDirty(true)
  }

  function moveStep(index: number, offset: number) {
    setDraft((prev) => {
      if (!prev) return prev
      const target = index + offset
      if (target < 0 || target >= prev.steps.length) return prev
      const steps = prev.steps.slice()
      const [item] = steps.splice(index, 1)
      steps.splice(target, 0, item)
      return { ...prev, steps }
    })
    setDirty(true)
  }

  /* ────────────────────────────── 保存 / 删除 ────────────────────────────── */

  async function save() {
    if (!draft) return
    const name = draft.name.trim()
    if (!name) {
      toast.push('先给脚本起个名字', 'err')
      return
    }
    setSaving(true)
    try {
      const saved = await bridge().scripts.save({ ...draft, name })
      setScripts((prev) => {
        const exists = prev.some((item) => item.id === saved.id)
        return exists ? prev.map((item) => (item.id === saved.id ? saved : item)) : [saved, ...prev]
      })
      setSelectedId(saved.id)
      setDirty(false)
      toast.push('脚本已保存', 'ok')
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setSaving(false)
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    try {
      await bridge().scripts.remove(deleteTarget.id)
      setScripts((prev) => prev.filter((item) => item.id !== deleteTarget.id))
      if (selectedId === deleteTarget.id) {
        setSelectedId(null)
        setDraft(null)
        setDirty(false)
      }
      toast.push('脚本已删除', 'ok')
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setDeleteTarget(null)
    }
  }

  /* ────────────────────────────── 回放 ────────────────────────────── */

  async function run(options?: ScriptRunOptions) {
    if (!draft) return
    if (!draft.id) {
      toast.push('先保存脚本，再选择环境回放', 'err')
      return
    }
    // 按钮已按 dirty 禁用，但确认弹窗是直接调 run() 的，绕过了按钮。
    // 主进程读的是库里的版本，草稿没保存时「用户看到要跑的」和「实际跑的」不是同一份。
    if (dirty) {
      toast.push('有未保存的修改，先保存再回放', 'err')
      return
    }
    if (!runProfileId) {
      toast.push('先选择一个环境', 'err')
      return
    }
    setRunning(true)
    if (!options) setResult(null)
    try {
      const res = await bridge().scripts.run(draft.id, runProfileId, options)
      setResult(res)
      if (res.needsConfirm) {
        // 这不是失败，是「还没做」。用弹窗而不是 toast：用户需要读到原因再决定，
        // toast 会自己消失，而这一步一旦点错就收不回来了。
        setPendingRun(res)
        return
      }
      toast.push(
        res.ok ? `回放完成：${res.executed}/${res.total} 步` : `第 ${res.failedAt} 步失败`,
        res.ok ? 'ok' : 'err'
      )
    } catch (err) {
      // 主进程直接抛错（环境没打开、脚本被删）时，仍然按一次失败回放展示
      setResult({ ok: false, executed: 0, total: draft.steps.length, error: errorMessage(err) })
      toast.push(errorMessage(err), 'err')
    } finally {
      setRunning(false)
    }
  }

  /**
   * 确认后从被拦下的那一步续跑。
   *
   * 不从头再来：前面几步已经在页面上留下状态，重放等于执行两次。
   * 闸门在预扫描阶段拦下时 executed 是 0，续跑点就是第一步风险动作，
   * 和运行中拦下的情况共用同一条路径。
   */
  async function confirmRun() {
    const pending = pendingRun
    setPendingRun(null)
    if (!pending || !pending.failedAt) return
    await run({ confirmed: true, startAt: pending.failedAt })
  }

  /* ────────────────────────────── 从任务导入 ────────────────────────────── */

  async function openImport() {
    setImportOpen(true)
    setTasksLoading(true)
    try {
      const list = await bridge().tasks.list()
      setTasks(list)
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setTasksLoading(false)
    }
  }

  function applyImport(task: TaskRecord) {
    const steps = importableSteps(task)
    if (steps.length === 0) {
      toast.push('这个任务没有可复用的成功步骤', 'err')
      return
    }
    setDraft((prev) => {
      const base = prev ?? blankScript()
      const name = base.name === '未命名脚本' || !base.name.trim() ? task.intent.slice(0, 40) : base.name
      return { ...base, name, steps, profileId: task.profileId }
    })
    setDirty(true)
    setResult(null)
    setImportOpen(false)
    toast.push(`已导入 ${steps.length} 步，保存后即可回放`, 'ok')
  }

  /* ────────────────────────────── 渲染 ────────────────────────────── */

  return (
    <div className="tool-panel scr-panel">
      <header className="tool-head scr-head">
        <div>
          <h2>自动化脚本</h2>
          <p>
            把一次跑通的执行记录沉淀成脚本，之后在任意环境里按原样重放。回放不走模型，
            每一步都按选择器重新定位元素，找不到就停下。
          </p>
        </div>
        <div className="scr-head-actions">
          <Button icon="download" onClick={() => void openImport()}>
            从任务导入
          </Button>
          <Button variant="primary" icon="plus" onClick={startNew}>
            新建脚本
          </Button>
        </div>
      </header>

      <div className="scr-wrap">
        <aside className="scr-side">
          <div className="scr-side-head">
            <span>脚本库</span>
            <span className="scr-count">{scripts.length}</span>
          </div>

          {loading ? (
            <div className="scr-side-empty">正在读取脚本…</div>
          ) : sorted.length === 0 ? (
            <div className="scr-side-empty">
              还没有脚本。可以从历史任务导入，或新建一个空脚本手工编排。
            </div>
          ) : (
            <div className="scr-list">
              {sorted.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={cx('scr-item', item.id === selectedId && 'on')}
                  onClick={() => requestSelect(item.id)}
                >
                  <div className="r1">
                    <span className="t">{item.name}</span>
                    <span className="tm">{formatRelative(item.updatedAt)}</span>
                  </div>
                  <div className="r2">
                    <span className="env-tag">{item.steps.length} 步</span>
                    {item.description ? <span className="d">{item.description}</span> : null}
                  </div>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className="scr-editor">
          {!draft ? (
            <div className="scr-empty">
              <div className="scr-empty-mark">
                <Icon name="play" size={16} strokeWidth={2} />
              </div>
              <h3>选一个脚本开始编辑</h3>
              <p>
                左侧是脚本库。第一次使用建议先点「从任务导入」：挑一个已经跑通的任务，
                它成功的步骤会直接变成可回放的脚本。
              </p>
              <Button variant="primary" icon="download" onClick={() => void openImport()}>
                从任务导入
              </Button>
            </div>
          ) : (
            <>
              <div className="scr-ed-head">
                <input
                  className="scr-title"
                  value={draft.name}
                  aria-label="脚本名称"
                  placeholder="脚本名称"
                  onChange={(e) => patchDraft({ name: e.target.value })}
                />
                <input
                  className="scr-desc"
                  value={draft.description ?? ''}
                  aria-label="脚本说明"
                  placeholder="一句话说明这个脚本做什么（可选）"
                  onChange={(e) => patchDraft({ description: e.target.value })}
                />
              </div>

              <div className="scr-bar">
                <span className="scr-steps-count">
                  共 {draft.steps.length} 步
                  {dirty ? <i className="scr-dirty">未保存</i> : null}
                </span>

                <div className="scr-spacer" />

                <label className="scr-run-field">
                  环境
                  <select
                    className="scr-input scr-run-select"
                    value={runProfileId}
                    aria-label="回放环境"
                    onChange={(e) => setRunProfileId(e.target.value)}
                  >
                    {profiles.length === 0 ? <option value="">暂无环境</option> : null}
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {profileNo(p.id)} {p.name}
                        {p.status === 'running' ? '（运行中）' : ''}
                      </option>
                    ))}
                  </select>
                </label>

                <Button
                  variant="take"
                  icon="play"
                  disabled={running || draft.steps.length === 0 || !draft.id || dirty}
                  onClick={() => void run()}
                  title={
                    !draft.id
                      ? '先保存脚本再回放'
                      : dirty
                        ? '有未保存的修改，保存后再回放，避免重放旧版本'
                        : '在当前环境回放'
                  }
                >
                  {running ? '回放中…' : '回放'}
                </Button>
                <Button
                  variant="primary"
                  icon="check"
                  disabled={saving || !dirty}
                  onClick={() => void save()}
                >
                  {saving ? '保存中…' : '保存'}
                </Button>
                {draft.id ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="trash"
                    onClick={() => setDeleteTarget(draft)}
                    ariaLabel="删除脚本"
                  >
                    删除
                  </Button>
                ) : null}
              </div>

              {result ? (
                <div className={cx('scr-result', result.ok ? 'ok' : 'bad')}>
                  <Icon name={result.ok ? 'check' : 'alert'} size={13} strokeWidth={2.4} />
                  <div>
                    <b>
                      {result.ok
                        ? `回放完成，执行了 ${result.executed} / ${result.total} 步`
                        : `回放到第 ${result.failedAt ?? '?'} 步中断，已执行 ${result.executed} / ${result.total} 步`}
                    </b>
                    {result.error ? <span>{result.error}</span> : null}
                  </div>
                </div>
              ) : null}

              <div className="scr-steps">
                {draft.steps.length === 0 ? (
                  <div className="scr-steps-empty">
                    还没有步骤。点下面的「添加步骤」手工编排，或用「从任务导入」把一次成功的执行搬过来。
                  </div>
                ) : (
                  draft.steps.map((step, index) => (
                    <div className="scr-step" key={`${index}-${step.action}`}>
                      <div className="scr-step-row">
                        <span className="scr-no">{index + 1}</span>
                        <select
                          className="scr-input scr-sel"
                          value={step.action}
                          aria-label={`第 ${index + 1} 步动作`}
                          onChange={(e) => changeAction(index, e.target.value as ActionType)}
                        >
                          {ACTION_ORDER.map((action) => (
                            <option key={action} value={action}>
                              {ACTION_LABEL[action]}
                            </option>
                          ))}
                        </select>

                        {NEEDS_SELECTOR.has(step.action) ? (
                          <input
                            className="scr-input scr-selector"
                            value={step.selector ?? ''}
                            aria-label={`第 ${index + 1} 步选择器`}
                            placeholder={SELECTOR_HINT[step.action] ?? 'role=button name=登录'}
                            onChange={(e) => patchStep(index, { selector: e.target.value })}
                          />
                        ) : (
                          <span className="scr-step-hint">
                            {step.action === 'navigate'
                              ? '整页跳转，不需要定位元素'
                              : step.action === 'scroll'
                                ? '整页滚动，不需要定位元素'
                                : step.action === 'extract'
                                  ? '按描述从当前页取数'
                                  : '脚本到这里结束'}
                          </span>
                        )}

                        <div className="scr-tools">
                          <button
                            type="button"
                            className="scr-icon"
                            aria-label="上移"
                            disabled={index === 0}
                            onClick={() => moveStep(index, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="scr-icon"
                            aria-label="下移"
                            disabled={index === draft.steps.length - 1}
                            onClick={() => moveStep(index, 1)}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className="scr-icon danger"
                            aria-label="删除这一步"
                            onClick={() => removeStep(index)}
                          >
                            <Icon name="close" size={11} strokeWidth={2.4} />
                          </button>
                        </div>
                      </div>

                      <div className="scr-extra">
                        {step.action === 'type' ? (
                          <label>
                            输入文本
                            <input
                              className="scr-input scr-param"
                              value={step.text ?? ''}
                              onChange={(e) => patchStep(index, { text: e.target.value })}
                            />
                          </label>
                        ) : null}

                        {step.action === 'press' ? (
                          <label>
                            按键
                            <input
                              className="scr-input scr-param"
                              value={step.key ?? ''}
                              placeholder="Enter"
                              onChange={(e) => patchStep(index, { key: e.target.value })}
                            />
                          </label>
                        ) : null}

                        {step.action === 'scroll' ? (
                          <>
                            <label>
                              方向
                              <select
                                className="scr-input scr-param"
                                value={step.key ?? 'down'}
                                onChange={(e) => patchStep(index, { key: e.target.value })}
                              >
                                <option value="down">向下</option>
                                <option value="up">向上</option>
                                <option value="top">到顶部</option>
                                <option value="bottom">到底部</option>
                              </select>
                            </label>
                            <label>
                              像素
                              <input
                                className="scr-input scr-param"
                                value={step.text ?? ''}
                                placeholder="留空 = 一屏"
                                onChange={(e) => patchStep(index, { text: e.target.value })}
                              />
                            </label>
                          </>
                        ) : null}

                        {step.action === 'navigate' ? (
                          <label className="scr-grow">
                            地址
                            <input
                              className="scr-input scr-param scr-wide"
                              value={step.url ?? ''}
                              placeholder="https://example.com"
                              onChange={(e) => patchStep(index, { url: e.target.value })}
                            />
                          </label>
                        ) : null}

                        {step.action === 'extract' ? (
                          <label className="scr-grow">
                            取数指令
                            <input
                              className="scr-input scr-param scr-wide"
                              value={step.text ?? ''}
                              placeholder="如：当前商品的价格"
                              onChange={(e) => patchStep(index, { text: e.target.value })}
                            />
                          </label>
                        ) : null}

                        {step.action === 'done' ? (
                          <label className="scr-grow">
                            收尾说明
                            <input
                              className="scr-input scr-param scr-wide"
                              value={step.note ?? ''}
                              placeholder="如：已提交订单"
                              onChange={(e) => patchStep(index, { note: e.target.value })}
                            />
                          </label>
                        ) : null}

                        <label>
                          延时
                          <input
                            className="scr-input scr-delay"
                            type="number"
                            min={0}
                            max={5000}
                            step={100}
                            value={step.delayMs ?? DEFAULT_DELAY}
                            onChange={(e) => patchStep(index, { delayMs: Number(e.target.value) })}
                          />
                          ms
                        </label>
                      </div>
                    </div>
                  ))
                )}

                <button type="button" className="scr-add" onClick={addStep}>
                  <Icon name="plus" size={12} strokeWidth={2.2} />
                  添加步骤
                </button>
              </div>
            </>
          )}
        </section>
      </div>

      <Modal
        open={importOpen}
        title="从历史任务导入"
        icon="download"
        tone="accent"
        align="left"
        maxWidth={560}
        onClose={() => setImportOpen(false)}
        note="只导入执行成功的步骤。导入后请核对选择器，尤其是同名按钮较多的页面。"
        footer={<Button onClick={() => setImportOpen(false)}>关闭</Button>}
      >
        {tasksLoading ? (
          <div className="scr-modal-empty">正在读取任务…</div>
        ) : importableTasks.length === 0 ? (
          <div className="scr-modal-empty">
            还没有带成功步骤的任务。先在影子面板里跑通一个任务，再回来导入。
          </div>
        ) : (
          <div className="scr-import-list">
            {importableTasks.map((task) => {
              const count = importableSteps(task).length
              const env = profiles.find((p) => p.id === task.profileId)
              return (
                <div className="scr-import-row" key={task.id}>
                  <div className="r1">
                    <span className="t">{task.intent}</span>
                    <span className="c">{count} 步</span>
                  </div>
                  <div className="r2">
                    <span>
                      {env?.name ?? task.profileId} · {formatRelative(task.startedAt)}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => applyImport(task)}>
                      导入
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Modal>

      <Modal
        open={pendingSelect !== null}
        title="有未保存的修改"
        icon="alert"
        onClose={() => setPendingSelect(null)}
        footer={
          <>
            <Button onClick={() => setPendingSelect(null)}>继续编辑</Button>
            <Button
              variant="danger"
              onClick={() => {
                const next = pendingSelect
                setPendingSelect(null)
                if (next === '') {
                  setSelectedId(null)
                  setDraft(blankScript())
                  setDirty(true)
                  setResult(null)
                } else if (next) {
                  setSelectedId(next)
                  setResult(null)
                }
              }}
            >
              放弃修改
            </Button>
          </>
        }
      >
        当前脚本的改动还没有保存，切换后这些改动会丢失。
      </Modal>

      <Modal
        open={pendingRun !== null}
        title="这段回放含不可逆步骤"
        icon="alert"
        onClose={() => setPendingRun(null)}
        footer={
          <>
            <Button onClick={() => setPendingRun(null)}>取消</Button>
            <Button variant="danger" onClick={() => void confirmRun()}>
              确认并继续
            </Button>
          </>
        }
      >
        <p>{pendingRun?.error}</p>
        <p>
          {pendingRun && pendingRun.executed > 0
            ? `前 ${pendingRun.executed} 步已经执行，确认后从第 ${pendingRun.failedAt} 步继续，不会重放前面的步骤。`
            : `确认后从第 ${pendingRun?.failedAt ?? 1} 步开始执行。`}
        </p>
        <p>取消则页面停在当前状态，脚本不会自动回滚。</p>
      </Modal>

      <Modal
        open={deleteTarget !== null}
        title="删除脚本"
        icon="trash"
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="danger" onClick={() => void confirmDelete()}>
              删除
            </Button>
          </>
        }
      >
        确定删除「{deleteTarget?.name}」吗？删除后无法恢复，历史任务的记录不受影响。
      </Modal>
    </div>
  )
}
