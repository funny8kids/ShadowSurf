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
  ScheduleKind,
  ScheduleRecord,
  ScriptRunResult,
  ScriptStep,
  TaskRecord
} from '@shared/types'
import type { ScriptRunOptions } from '@shared/ipc'
import type { ActionType, AgentStep } from '@shared/protocol'
import { Badge, Button, Icon, Modal, Toggle, cx, useToast } from '@renderer/components/ui'
import { bridge, errorMessage } from '@renderer/lib/api'
import { ACTION_LABEL, formatRelative, profileNo } from '@renderer/lib/format'
import { useI18n } from '@renderer/lib/i18n'
import './script.css'

export interface PanelProps {
  profiles: Profile[]
}

const DEFAULT_DELAY = 300

/**
 * 脚本库列表的读取状态。
 *
 * DESIGN.md #1「不可判读状态」：空 / 错 / 加载必须三态可分。
 * 旧实现把「读失败」压进 toast + 空数组，结果「读不到」和「确实没有」画成同一张脸——
 * 用户据此以为库是空的，去新建同名的脚本，反而覆盖了自己读不到的那份。
 * 这里用可辨识联合把三态在类型层就分开，渲染层必须逐分支处理。
 */
type ScriptListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; scripts: AutomationScript[] }

/** 任务选择器（「从任务导入」弹窗里那张表）的读取状态，同样按三态拆开 */
type TaskPickerState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; tasks: TaskRecord[] }

/**
 * 定时任务列表的读取状态。
 *
 * 同样遵守「空 / 错 / 加载三态可分」：读失败时不能把列表画成空，
 * 否则用户会以为任务被删了，转身又建一条同名的。
 */
type ScheduleListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; items: ScheduleRecord[] }

/**
 * 去掉 Electron 套在 IPC 失败外的通道名前缀。
 *
 * 原始消息长这样：`Error invoking remote method 'ss:script:list': Error: EACCES: ...`
 * 前半截是通道名，用户不需要知道，而且会把真正的原因挤到屏幕外。
 * DESIGN.md 要求读失败必须「带错误原因原文」，所以这里只剥壳、不改写原因本身。
 */
function cleanIpcMessage(raw: string): string {
  const m = /Error invoking remote method '[^']*':\s*(?:Error:\s*)?([\s\S]*)$/.exec(raw)
  return (m?.[1] ?? raw).trim()
}

/**
 * 动作类型 → 中文：**不在这里自己写一份**。
 *
 * 这里原来有一份独立副本，7 条里 3 条措辞和正本不同（`打开网址` / `提取内容` / `结束脚本`）。
 * 症状是「同一个动作在脚本编辑器下拉里叫『打开网址』、在审计页叫『导航』」——
 * 用户不会把这个当 bug 报，他会以为这是两个不同的动作。
 *
 * 正本在 `@shared/protocol` 的 `ACTION_LABEL`（主进程写审计「目标」列时也要用），
 * 经 `@renderer/lib/format` 转出。要改措辞就改正本，一处改、两处生效。
 */

const ACTION_ORDER: ActionType[] = ['click', 'type', 'press', 'scroll', 'navigate', 'extract', 'done']

/** 这三类动作必须指向具体元素，选择器为空时直接拦住，别等到回放才报错 */
const NEEDS_SELECTOR = new Set<ActionType>(['click', 'type', 'press'])

const SELECTOR_HINT: Partial<Record<ActionType, string>> = {
  click: 'script.hint.selector.click',
  type: 'script.hint.selector.type',
  press: 'script.hint.selector.press'
}

function cloneScript(script: AutomationScript): AutomationScript {
  // 旧版本落盘的记录可能没有 steps 字段，这里补齐，避免编辑器首屏就崩
  const steps = Array.isArray(script.steps) ? script.steps : []
  return { ...script, steps: steps.map((step) => ({ ...step })) }
}

function blankScript(name: string): AutomationScript {
  const now = Date.now()
  return { id: '', name, description: '', steps: [], createdAt: now, updatedAt: now }
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
  const { t } = useI18n()

  const [scripts, setScripts] = useState<AutomationScript[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<AutomationScript | null>(null)
  const [dirty, setDirty] = useState(false)
  /** 脚本库的读取状态：空 / 错 / 加载三态分列，读失败走内联琥珀而不是 toast */
  const [listState, setListState] = useState<ScriptListState>({ kind: 'loading' })
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [runProfileId, setRunProfileId] = useState('')
  const [result, setResult] = useState<ScriptRunResult | null>(null)

  const [importOpen, setImportOpen] = useState(false)
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  /** 任务选择器的读取状态；idle = 弹窗还没打开过，没读就不该显示「空」 */
  const [taskPicker, setTaskPicker] = useState<TaskPickerState>({ kind: 'idle' })

  const [pendingSelect, setPendingSelect] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AutomationScript | null>(null)
  /** 回放被风险闸门拦下，等用户看过原因再决定续不续 */
  const [pendingRun, setPendingRun] = useState<ScriptRunResult | null>(null)

  /* ── 定时任务 ── */

  const [scheduleState, setScheduleState] = useState<ScheduleListState>({ kind: 'loading' })
  const [schedKind, setSchedKind] = useState<ScheduleKind>('launch')
  const [schedTarget, setSchedTarget] = useState('')
  // 脚本定时必须指定运行环境：AutomationScript.profileId 只是录制来源，不能当运行环境
  const [schedProfileId, setSchedProfileId] = useState('')
  const [schedMode, setSchedMode] = useState<'interval' | 'daily'>('interval')
  const [schedMinutes, setSchedMinutes] = useState('30')
  const [schedDailyAt, setSchedDailyAt] = useState('09:00')
  const [schedSaving, setSchedSaving] = useState(false)
  const [schedUpdatingId, setSchedUpdatingId] = useState<string | null>(null)
  const [schedRunningId, setSchedRunningId] = useState<string | null>(null)
  const [schedDeleteTarget, setSchedDeleteTarget] = useState<ScheduleRecord | null>(null)

  const loadScripts = useCallback(async () => {
    // 读失败不是「空」：先声明进入 loading，成功写 ready，失败写带原因的 error。
    // 不再 toast —— toast 会自己消失，而「读不到」必须留在页面上等人处理。
    setListState({ kind: 'loading' })
    try {
      const list = await bridge().scripts.list()
      setScripts(list)
      setSelectedId((current) => current ?? list[0]?.id ?? null)
      setListState({ kind: 'ready', scripts: list })
    } catch (err) {
      setListState({ kind: 'error', message: cleanIpcMessage(errorMessage(err)) })
    }
  }, [])

  useEffect(() => {
    void loadScripts()
  }, [loadScripts])

  const loadSchedules = useCallback(async () => {
    // 与脚本库同一口径：先 loading，成功 ready，失败带原文的 error。
    setScheduleState({ kind: 'loading' })
    try {
      const items = await bridge().schedules.list()
      setScheduleState({ kind: 'ready', items })
    } catch (err) {
      setScheduleState({ kind: 'error', message: cleanIpcMessage(errorMessage(err)) })
    }
  }, [])

  useEffect(() => {
    void loadSchedules()
  }, [loadSchedules])

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

  /** 定时任务表单的目标候选：按 action 类型在「环境」和「脚本」之间切换 */
  const scheduleTargets = useMemo(
    () =>
      schedKind === 'launch'
        ? profiles.map((p) => ({ id: p.id, label: `${profileNo(p.id)} ${p.name}` }))
        : scripts.map((s) => ({ id: s.id, label: s.name })),
    [schedKind, profiles, scripts]
  )

  // 切换动作类型后，原来选的目标可能不属于新类型；自动落到第一个可用目标，
  // 避免提交出「类型是 launch、targetId 却是脚本 id」的混合配置。
  useEffect(() => {
    setSchedTarget((current) =>
      scheduleTargets.some((item) => item.id === current)
        ? current
        : (scheduleTargets[0]?.id ?? '')
    )
  }, [scheduleTargets])

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
    setDraft(blankScript(t('script.untitled')))
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
      toast.push(t('script.err.needName'), 'err')
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
      toast.push(t('script.toast.saved'), 'ok')
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
      toast.push(t('script.toast.deleted'), 'ok')
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
      toast.push(t('script.err.saveFirst'), 'err')
      return
    }
    // 按钮已按 dirty 禁用，但确认弹窗是直接调 run() 的，绕过了按钮。
    // 主进程读的是库里的版本，草稿没保存时「用户看到要跑的」和「实际跑的」不是同一份。
    if (dirty) {
      toast.push(t('script.err.unsavedRun'), 'err')
      return
    }
    if (!runProfileId) {
      toast.push(t('script.err.needProfile'), 'err')
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
        res.ok
          ? t('script.toast.runOk', { executed: res.executed, total: res.total })
          : t('script.toast.runFail', { n: res.failedAt ?? '?' }),
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
   *
   * 注意这里**不带任何「我已确认」的标记** —— 那不是省略，是被删掉的字段。
   * 续跑时主进程会为那一步重新弹出系统原生确认窗口，用户当场点了才跑。
   * 传 `confirmed: true` 这种「渲染层自称用户已同意」的东西，等于把闸门
   * 交给最可能被攻破的那一层，所以它已经不存在了（传了也会被忽略）。
   */
  async function confirmRun() {
    const pending = pendingRun
    setPendingRun(null)
    if (!pending || !pending.failedAt) return
    await run({ startAt: pending.failedAt })
  }

  /* ────────────────────────────── 从任务导入 ────────────────────────────── */

  async function openImport() {
    setImportOpen(true)
    // 每次打开都重读：上次读失败后关掉再开，应该有机会恢复，而不是永远停在 error。
    setTaskPicker({ kind: 'loading' })
    try {
      const list = await bridge().tasks.list()
      setTasks(list)
      setTaskPicker({ kind: 'ready', tasks: list })
    } catch (err) {
      // 选择器读失败同样不能伪装成「没有任务」：内联错误 + 重试，不用 toast。
      setTaskPicker({ kind: 'error', message: cleanIpcMessage(errorMessage(err)) })
    }
  }

  function applyImport(task: TaskRecord) {
    const steps = importableSteps(task)
    if (steps.length === 0) {
      toast.push(t('script.err.noSteps'), 'err')
      return
    }
    setDraft((prev) => {
      const base = prev ?? blankScript(t('script.untitled'))
      const name =
        base.name === t('script.untitled') || !base.name.trim()
          ? task.intent.slice(0, 40)
          : base.name
      return { ...base, name, steps, profileId: task.profileId }
    })
    setDirty(true)
    setResult(null)
    setImportOpen(false)
    toast.push(t('script.toast.imported', { n: steps.length }), 'ok')
  }

  /* ────────────────────────────── 定时任务操作 ────────────────────────────── */

  function scheduleTargetName(rec: ScheduleRecord): string {
    if (rec.kind === 'launch') {
      return profiles.find((p) => p.id === rec.targetId)?.name ?? rec.targetId
    }
    return scripts.find((s) => s.id === rec.targetId)?.name ?? rec.targetId
  }

  function scheduleCycleText(rec: ScheduleRecord): string {
    if (typeof rec.everyMinutes === 'number') {
      return t('sched.everyMinutes', { n: rec.everyMinutes })
    }
    if (rec.dailyAt) return t('sched.dailyAt', { time: rec.dailyAt })
    return '—'
  }

  async function addSchedule() {
    if (!schedTarget) return
    setSchedSaving(true)
    try {
      const saved = await bridge().schedules.create(
        schedMode === 'interval'
          ? {
              kind: schedKind,
              targetId: schedTarget,
              everyMinutes: Number(schedMinutes),
              enabled: true
            }
          : { kind: schedKind, targetId: schedTarget, dailyAt: schedDailyAt, enabled: true }
      )
      // 主进程按 createdAt 降序返回；新建的排最前，本地镜像保持同一顺序
      setScheduleState((prev) =>
        prev.kind === 'ready'
          ? { kind: 'ready', items: [saved, ...prev.items] }
          : { kind: 'ready', items: [saved] }
      )
      toast.push(t('sched.saved'), 'ok')
    } catch (err) {
      // 校验失败（间隔越界 / 时间格式错 / 目标为空）由主进程给原文
      toast.push(errorMessage(err), 'err')
    } finally {
      setSchedSaving(false)
    }
  }

  async function toggleSchedule(rec: ScheduleRecord, enabled: boolean) {
    setSchedUpdatingId(rec.id)
    try {
      const saved = await bridge().schedules.update(rec.id, { enabled })
      setScheduleState((prev) =>
        prev.kind === 'ready'
          ? {
              kind: 'ready',
              items: prev.items.map((item) => (item.id === saved.id ? saved : item))
            }
          : prev
      )
      toast.push(t('sched.saved'), 'ok')
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setSchedUpdatingId(null)
    }
  }

  async function runScheduleNow(rec: ScheduleRecord) {
    setSchedRunningId(rec.id)
    try {
      const res = await bridge().schedules.runNow(rec.id)
      // 手动触发不推进 lastRunAt（主进程保证），这里只把结果镜像到列表，
      // 不重读整个列表 —— 避免面板闪一下 loading。
      setScheduleState((prev) =>
        prev.kind === 'ready'
          ? {
              kind: 'ready',
              items: prev.items.map((item) =>
                item.id === rec.id ? { ...item, lastResult: res.message } : item
              )
            }
          : prev
      )
      toast.push(
        res.ok ? t('sched.ran') : t('sched.runFailed', { message: res.message }),
        res.ok ? 'ok' : 'err'
      )
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setSchedRunningId(null)
    }
  }

  async function confirmRemoveSchedule() {
    const target = schedDeleteTarget
    if (!target) return
    try {
      await bridge().schedules.remove(target.id)
      setScheduleState((prev) =>
        prev.kind === 'ready'
          ? { kind: 'ready', items: prev.items.filter((item) => item.id !== target.id) }
          : prev
      )
      toast.push(t('sched.removed'), 'ok')
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setSchedDeleteTarget(null)
    }
  }

  /* ────────────────────────────── 渲染 ────────────────────────────── */

  return (
    <div className="tool-panel scr-panel">
      <header className="tool-head scr-head">
        <div>
          <h2>{t('script.title')}</h2>
          <p>{t('script.subtitle')}</p>
        </div>
        <div className="scr-head-actions">
          <Button icon="download" onClick={() => void openImport()}>
            {t('script.importFromTask')}
          </Button>
          <Button variant="primary" icon="plus" onClick={startNew}>
            {t('script.create')}
          </Button>
        </div>
      </header>

      <div className="scr-wrap">
        <aside className="scr-side">
          <div className="scr-side-head">
            <span>{t('script.library')}</span>
            <span className="scr-count">{scripts.length}</span>
          </div>

          {listState.kind === 'loading' ? (
            <div className="scr-side-empty">{t('script.loading')}</div>
          ) : listState.kind === 'error' ? (
            <div className="scr-err">
              <b>{t('script.error.title')}</b>
              <p className="scr-err-reason">{listState.message}</p>
              {/* DESIGN.md：读不到 ≠ 没有脚本。现在既不能说有也不能说没有，所以停下别动、再读一次。 */}
              <p className="scr-err-hint">{t('script.error.hint')}</p>
              <Button size="sm" variant="ghost" icon="reload" onClick={() => void loadScripts()}>
                {t('common.retry')}
              </Button>
            </div>
          ) : sorted.length === 0 ? (
            <div className="scr-side-empty">{t('script.emptyLibrary')}</div>
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
                    <span className="env-tag">
                      {t('script.stepsCount', { n: item.steps.length })}
                    </span>
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
              <h3>{t('script.empty.title')}</h3>
              <p>{t('script.empty.body')}</p>
              <Button variant="primary" icon="download" onClick={() => void openImport()}>
                {t('script.importFromTask')}
              </Button>
            </div>
          ) : (
            <>
              <div className="scr-ed-head">
                <input
                  className="scr-title"
                  value={draft.name}
                  aria-label={t('script.nameAria')}
                  placeholder={t('script.namePlaceholder')}
                  onChange={(e) => patchDraft({ name: e.target.value })}
                />
                <input
                  className="scr-desc"
                  value={draft.description ?? ''}
                  aria-label={t('script.descAria')}
                  placeholder={t('script.descPlaceholder')}
                  onChange={(e) => patchDraft({ description: e.target.value })}
                />
              </div>

              <div className="scr-bar">
                <span className="scr-steps-count">
                  {t('script.stepsTotal', { n: draft.steps.length })}
                  {dirty ? <i className="scr-dirty">{t('script.unsaved')}</i> : null}
                </span>

                <div className="scr-spacer" />

                <label className="scr-run-field">
                  {t('script.profile')}
                  <select
                    className="scr-input scr-run-select"
                    value={runProfileId}
                    aria-label={t('script.replayProfileAria')}
                    onChange={(e) => setRunProfileId(e.target.value)}
                  >
                    {profiles.length === 0 ? (
                      <option value="">{t('script.noProfiles')}</option>
                    ) : null}
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {profileNo(p.id)} {p.name}
                        {p.status === 'running' ? t('script.runningSuffix') : ''}
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
                      ? t('script.run.title.noId')
                      : dirty
                        ? t('script.run.title.dirty')
                        : t('script.run.title.ok')
                  }
                >
                  {running ? t('script.running') : t('script.run')}
                </Button>
                <Button
                  variant="primary"
                  icon="check"
                  disabled={saving || !dirty}
                  onClick={() => void save()}
                >
                  {saving ? t('script.saving') : t('common.save')}
                </Button>
                {draft.id ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="trash"
                    onClick={() => setDeleteTarget(draft)}
                    ariaLabel={t('script.delete.title')}
                  >
                    {t('common.delete')}
                  </Button>
                ) : null}
              </div>

              {result ? (
                <div className={cx('scr-result', result.ok ? 'ok' : 'bad')}>
                  <Icon name={result.ok ? 'check' : 'alert'} size={13} strokeWidth={2.4} />
                  <div>
                    <b>
                      {result.ok
                        ? t('script.result.ok', {
                            executed: result.executed,
                            total: result.total
                          })
                        : t('script.result.fail', {
                            at: result.failedAt ?? '?',
                            executed: result.executed,
                            total: result.total
                          })}
                    </b>
                    {result.error ? <span>{result.error}</span> : null}
                  </div>
                </div>
              ) : null}

              <div className="scr-steps">
                {draft.steps.length === 0 ? (
                  <div className="scr-steps-empty">{t('script.steps.empty')}</div>
                ) : (
                  draft.steps.map((step, index) => (
                    <div className="scr-step" key={`${index}-${step.action}`}>
                      <div className="scr-step-row">
                        <span className="scr-no">{index + 1}</span>
                        <select
                          className="scr-input scr-sel"
                          value={step.action}
                          aria-label={t('script.step.actionAria', { n: index + 1 })}
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
                            aria-label={t('script.step.selectorAria', { n: index + 1 })}
                            placeholder={t(
                              SELECTOR_HINT[step.action] ?? 'script.step.selectorFallback'
                            )}
                            onChange={(e) => patchStep(index, { selector: e.target.value })}
                          />
                        ) : (
                          <span className="scr-step-hint">
                            {step.action === 'navigate'
                              ? t('script.step.hint.navigate')
                              : step.action === 'scroll'
                                ? t('script.step.hint.scroll')
                                : step.action === 'extract'
                                  ? t('script.step.hint.extract')
                                  : t('script.step.hint.done')}
                          </span>
                        )}

                        <div className="scr-tools">
                          <button
                            type="button"
                            className="scr-icon"
                            aria-label={t('script.step.moveUp')}
                            disabled={index === 0}
                            onClick={() => moveStep(index, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="scr-icon"
                            aria-label={t('script.step.moveDown')}
                            disabled={index === draft.steps.length - 1}
                            onClick={() => moveStep(index, 1)}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className="scr-icon danger"
                            aria-label={t('script.step.remove')}
                            onClick={() => removeStep(index)}
                          >
                            <Icon name="close" size={11} strokeWidth={2.4} />
                          </button>
                        </div>
                      </div>

                      <div className="scr-extra">
                        {step.action === 'type' ? (
                          <label>
                            {t('script.step.text')}
                            <input
                              className="scr-input scr-param"
                              value={step.text ?? ''}
                              onChange={(e) => patchStep(index, { text: e.target.value })}
                            />
                          </label>
                        ) : null}

                        {step.action === 'press' ? (
                          <label>
                            {t('script.step.key')}
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
                              {t('script.step.direction')}
                              <select
                                className="scr-input scr-param"
                                value={step.key ?? 'down'}
                                onChange={(e) => patchStep(index, { key: e.target.value })}
                              >
                                <option value="down">{t('script.step.down')}</option>
                                <option value="up">{t('script.step.up')}</option>
                                <option value="top">{t('script.step.top')}</option>
                                <option value="bottom">{t('script.step.bottom')}</option>
                              </select>
                            </label>
                            <label>
                              {t('script.step.pixels')}
                              <input
                                className="scr-input scr-param"
                                value={step.text ?? ''}
                                placeholder={t('script.step.pixelsPlaceholder')}
                                onChange={(e) => patchStep(index, { text: e.target.value })}
                              />
                            </label>
                          </>
                        ) : null}

                        {step.action === 'navigate' ? (
                          <label className="scr-grow">
                            {t('script.step.address')}
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
                            {t('script.step.extractPrompt')}
                            <input
                              className="scr-input scr-param scr-wide"
                              value={step.text ?? ''}
                              placeholder={t('script.step.extractPlaceholder')}
                              onChange={(e) => patchStep(index, { text: e.target.value })}
                            />
                          </label>
                        ) : null}

                        {step.action === 'done' ? (
                          <label className="scr-grow">
                            {t('script.step.note')}
                            <input
                              className="scr-input scr-param scr-wide"
                              value={step.note ?? ''}
                              placeholder={t('script.step.notePlaceholder')}
                              onChange={(e) => patchStep(index, { note: e.target.value })}
                            />
                          </label>
                        ) : null}

                        <label>
                          {t('script.step.delay')}
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
                  {t('script.addStep')}
                </button>
              </div>
            </>
          )}
        </section>
      </div>

      <section className="scr-editor" aria-label={t('sched.title')}>
        <div className="scr-ed-head">
          <div className="tool-head">
            <h2>{t('sched.title')}</h2>
            <p>{t('sched.desc')}</p>
          </div>
        </div>

        {/* 新增表单：动作 → 目标 → 周期 → 添加。目标候选随动作类型切换 */}
        <div className="scr-bar">
          <select
            className="scr-input scr-sel"
            value={schedKind}
            aria-label={`${t('sched.kind.launch')} / ${t('sched.kind.script')}`}
            onChange={(e) => setSchedKind(e.target.value as ScheduleKind)}
          >
            <option value="launch">{t('sched.kind.launch')}</option>
            <option value="script">{t('sched.kind.script')}</option>
          </select>

          <label className="scr-run-field">
            {t('sched.target')}
            <select
              className="scr-input scr-run-select"
              value={schedTarget}
              disabled={scheduleTargets.length === 0}
              onChange={(e) => setSchedTarget(e.target.value)}
            >
              {scheduleTargets.length === 0 ? <option value="">—</option> : null}
              {scheduleTargets.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          {schedKind === 'script' ? (
            <label className="scr-run-field">
              {t('sched.runProfile')}
              <select
                className="scr-input scr-run-select"
                value={schedProfileId}
                disabled={profiles.length === 0}
                onChange={(e) => setSchedProfileId(e.target.value)}
              >
                {profiles.length === 0 ? <option value="">—</option> : null}
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <select
            className="scr-input scr-sel"
            value={schedMode}
            aria-label={`${t('sched.mode.interval')} / ${t('sched.mode.daily')}`}
            onChange={(e) => setSchedMode(e.target.value as 'interval' | 'daily')}
          >
            <option value="interval">{t('sched.mode.interval')}</option>
            <option value="daily">{t('sched.mode.daily')}</option>
          </select>

          {schedMode === 'interval' ? (
            <label className="scr-run-field">
              {t('sched.everyMinutes', { n: 'N' })}
              <input
                className="scr-input scr-delay"
                type="number"
                min={1}
                max={1440}
                step={1}
                value={schedMinutes}
                onChange={(e) => setSchedMinutes(e.target.value)}
              />
            </label>
          ) : (
            <label className="scr-run-field">
              {t('sched.dailyAt', { time: 'HH:MM' })}
              <input
                className="scr-input"
                type="time"
                value={schedDailyAt}
                onChange={(e) => setSchedDailyAt(e.target.value)}
              />
            </label>
          )}

          <div className="scr-spacer" />

          <Button
            variant="primary"
            icon="plus"
            disabled={schedSaving || !schedTarget || (schedKind === 'script' && !schedProfileId)}
            onClick={() => void addSchedule()}
          >
            {t('sched.add')}
          </Button>
        </div>

        <div className="scr-steps">
          {scheduleState.kind === 'loading' ? (
            <div className="scr-steps-empty">{t('common.loading')}</div>
          ) : scheduleState.kind === 'error' ? (
            <div className="scr-err">
              <b>{t('sched.readFailed')}</b>
              <p className="scr-err-reason">{scheduleState.message}</p>
              <Button size="sm" variant="ghost" icon="reload" onClick={() => void loadSchedules()}>
                {t('common.retry')}
              </Button>
            </div>
          ) : scheduleState.items.length === 0 ? (
            <div className="scr-steps-empty">{t('sched.empty')}</div>
          ) : (
            scheduleState.items.map((rec) => {
              const name = scheduleTargetName(rec)
              const busy = schedUpdatingId === rec.id || schedRunningId === rec.id
              return (
                <div className="scr-step" key={rec.id}>
                  <div className="scr-step-row">
                    <Badge tone={rec.enabled ? 'ok' : 'neutral'}>
                      {rec.kind === 'launch'
                        ? t('sched.kind.launch')
                        : t('sched.kind.script')}
                    </Badge>
                    <span className="scr-step-hint" title={name}>
                      {name}
                    </span>
                    <span className="scr-steps-count">{scheduleCycleText(rec)}</span>
                    <div className="scr-tools">
                      <Toggle
                        checked={rec.enabled}
                        disabled={busy}
                        label={t('sched.enabled')}
                        onChange={(next) => void toggleSchedule(rec, next)}
                      />
                    </div>
                  </div>

                  <div className="scr-extra">
                    <span>
                      {t('sched.lastRun')}:{' '}
                      {rec.lastRunAt === null ? t('sched.never') : formatRelative(rec.lastRunAt)}
                    </span>
                    {rec.lastResult ? (
                      <span className="scr-step-hint" title={rec.lastResult}>
                        {rec.lastResult}
                      </span>
                    ) : null}
                    <div className="scr-spacer" />
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="play"
                      disabled={busy}
                      onClick={() => void runScheduleNow(rec)}
                    >
                      {t('sched.runNow')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      disabled={busy}
                      onClick={() => setSchedDeleteTarget(rec)}
                    >
                      {t('sched.remove')}
                    </Button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </section>

      <Modal
        open={importOpen}
        title={t('script.import.title')}
        icon="download"
        tone="accent"
        align="left"
        maxWidth={560}
        onClose={() => setImportOpen(false)}
        note={t('script.import.note')}
        footer={<Button onClick={() => setImportOpen(false)}>{t('common.close')}</Button>}
      >
        {taskPicker.kind === 'idle' || taskPicker.kind === 'loading' ? (
          <div className="scr-modal-empty">{t('script.import.loading')}</div>
        ) : taskPicker.kind === 'error' ? (
          <div className="scr-err">
            <b>{t('script.import.errorTitle')}</b>
            <p className="scr-err-reason">{taskPicker.message}</p>
            <p className="scr-err-hint">{t('script.import.errorHint')}</p>
            <Button
              size="sm"
              variant="ghost"
              icon="reload"
              onClick={() => void openImport()}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : importableTasks.length === 0 ? (
          <div className="scr-modal-empty">{t('script.import.empty')}</div>
        ) : (
          <div className="scr-import-list">
            {importableTasks.map((task) => {
              const count = importableSteps(task).length
              const env = profiles.find((p) => p.id === task.profileId)
              return (
                <div className="scr-import-row" key={task.id}>
                  <div className="r1">
                    <span className="t">{task.intent}</span>
                    <span className="c">{t('script.stepsCount', { n: count })}</span>
                  </div>
                  <div className="r2">
                    <span>
                      {env?.name ?? task.profileId} · {formatRelative(task.startedAt)}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => applyImport(task)}>
                      {t('script.import.action')}
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
        title={t('script.unsaved.title')}
        icon="alert"
        onClose={() => setPendingSelect(null)}
        footer={
          <>
            <Button onClick={() => setPendingSelect(null)}>{t('script.continueEdit')}</Button>
            <Button
              variant="danger"
              onClick={() => {
                const next = pendingSelect
                setPendingSelect(null)
                if (next === '') {
                  setSelectedId(null)
                  setDraft(blankScript(t('script.untitled')))
                  setDirty(true)
                  setResult(null)
                } else if (next) {
                  setSelectedId(next)
                  setResult(null)
                }
              }}
            >
              {t('script.discard')}
            </Button>
          </>
        }
      >
        {t('script.unsaved.body')}
      </Modal>

      <Modal
        open={pendingRun !== null}
        title={t('script.confirm.title')}
        icon="alert"
        onClose={() => setPendingRun(null)}
        footer={
          <>
            <Button onClick={() => setPendingRun(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={() => void confirmRun()}>
              {t('script.confirm.retry')}
            </Button>
          </>
        }
      >
        <p>{pendingRun?.error}</p>
        <p>
          {pendingRun && pendingRun.executed > 0
            ? t('script.confirm.continued', {
                executed: pendingRun.executed,
                at: pendingRun.failedAt ?? '?'
              })
            : t('script.confirm.startAt', { at: pendingRun?.failedAt ?? 1 })}
        </p>
        <p>{t('script.confirm.native')}</p>
        <p>{t('script.confirm.cancelNote')}</p>
      </Modal>

      <Modal
        open={deleteTarget !== null}
        title={t('script.delete.title')}
        icon="trash"
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={() => void confirmDelete()}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {t('script.delete.confirm', { name: deleteTarget?.name ?? '' })}
      </Modal>

      <Modal
        open={schedDeleteTarget !== null}
        title={t('sched.remove')}
        icon="trash"
        onClose={() => setSchedDeleteTarget(null)}
        footer={
          <>
            <Button onClick={() => setSchedDeleteTarget(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={() => void confirmRemoveSchedule()}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {t('sched.removeConfirm', {
          name: schedDeleteTarget ? scheduleTargetName(schedDeleteTarget) : ''
        })}
      </Modal>
    </div>
  )
}
