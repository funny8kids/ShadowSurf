/**
 * RPA 脚本模块。
 *
 * 职责：
 * - 脚本库的增删改查（录制结果由渲染层从历史任务导入，主进程只负责落盘）
 * - 在当前环境里确定性回放：不走 LLM，不重新规划，只把录制时的选择器
 *   重新解析成当次快照里的元素编号，再复用 agent 的动作协议执行
 *
 * 为什么回放必须重新解析选择器：快照编号（e1..eN）是每次采集时按 DOM 顺序
 * 重新分配的，跨页面、跨刷新都不稳定，只有「角色 + 可读名」这类语义信息能跨轮次对齐。
 * 也因此本模块只依赖 snapshot / actions，不 import agent/loop —— 回放不允许有任何
 * 模型参与，否则「同一脚本两次跑出不同结果」就无法解释。
 *
 * 归属：rpa-agent
 */

import { CH } from '@shared/ipc'
import type { AutomationScript, ScriptRunResult, ScriptStep } from '@shared/types'
import type { Action, ActionType, PageSnapshot, SnapshotElement } from '@shared/protocol'
import type { ModuleContext } from './context'

import { CollectionStore } from '@main/store'
import { bridgeFor } from '@main/core/cdp'
import { captureSnapshot } from '@main/agent/snapshot'
import { executeAction } from '@main/agent/actions'

/** 步骤间默认等待，给页面留出渲染/请求的时间 */
const DEFAULT_DELAY_MS = 300
/** 上限：单步等太久会让一次回放卡到不可用，超过就按上限截断 */
const MAX_DELAY_MS = 5000

/** 动作协议里允许出现在脚本中的类型，其余值一律当脏数据丢掉 */
const VALID_ACTIONS: ActionType[] = [
  'click',
  'type',
  'press',
  'scroll',
  'navigate',
  'extract',
  'done'
]

/* ────────────────────────────── 选择器解析 ────────────────────────────── */

/**
 * 选择器语法（渲染层编辑框里直接手写）：
 *   role=button name=登录
 *   name="加入购物车"
 *   tag=input type=email
 *   #e3            —— 仅用于同一页面内调试，跨页面必然失效
 *   纯文本          —— 等价于 name=<纯文本>
 */
interface SelectorSpec {
  /** 快照编号直连，调试用 */
  id?: string
  role?: string
  tag?: string
  type?: string
  name?: string
}

function parseSelector(raw: string): SelectorSpec {
  const text = raw.trim()
  if (!text) return {}

  const idMatch = /^#?(e\d+)$/i.exec(text)
  if (idMatch) return { id: idMatch[1].toLowerCase() }

  const spec: SelectorSpec = {}
  const pair = /([a-zA-Z]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g
  let rest = text
  let matched = false
  let m: RegExpExecArray | null
  while ((m = pair.exec(text)) !== null) {
    matched = true
    rest = rest.replace(m[0], ' ')
    const key = m[1].toLowerCase()
    const value = (m[2] ?? m[3] ?? m[4] ?? '').trim()
    if (!value) continue
    if (key === 'role') spec.role = value.toLowerCase()
    else if (key === 'tag') spec.tag = value.toLowerCase()
    else if (key === 'type') spec.type = value.toLowerCase()
    else if (key === 'name' || key === 'text') spec.name = value
  }

  if (!matched) {
    spec.name = text
    return spec
  }
  // 允许 `role=button 登录` 这种混写：剩下的裸文本当作可读名
  const leftover = rest.replace(/\s+/g, ' ').trim()
  if (!spec.name && leftover) spec.name = leftover
  return spec
}

/** 比较可读名时忽略大小写与空白：页面上的文案经常带换行、全角空格 */
function normalizeName(value: string): string {
  return value.replace(/[\s\u00a0\u3000]+/g, '').toLowerCase()
}

/**
 * 给候选元素打分，-1 表示不合格。
 * 完全同名 > 前缀 > 包含 > 被包含：分数只用于在同名候选里挑一个，
 * 不做模糊纠错 —— 猜错元素比找不到更糟，回放必须可预测。
 */
function scoreElement(el: SnapshotElement, spec: SelectorSpec): number {
  if (spec.role && el.role.toLowerCase() !== spec.role) return -1
  if (spec.tag && el.tag.toLowerCase() !== spec.tag) return -1
  if (spec.type && (el.type ?? '').toLowerCase() !== spec.type) return -1
  if (!spec.name) return 1

  const target = normalizeName(spec.name)
  const name = normalizeName(el.name)
  if (!name) return -1
  if (name === target) return 100
  if (name.startsWith(target)) return 60
  if (name.includes(target)) return 40
  if (target.includes(name) && name.length >= 2) return 20
  return -1
}

/** 找到最匹配的元素；同分时优先可点、在视口内的那个 */
function resolveElement(snapshot: PageSnapshot, spec: SelectorSpec): SnapshotElement | null {
  if (spec.id) {
    return snapshot.elements.find((el) => el.id === spec.id) ?? null
  }

  let best: SnapshotElement | null = null
  let bestScore = -1
  for (const el of snapshot.elements) {
    const score = scoreElement(el, spec)
    if (score < 0) continue
    if (score > bestScore) {
      best = el
      bestScore = score
      continue
    }
    if (score === bestScore && best) {
      const better =
        (best.disabled && !el.disabled ? 2 : 0) + (!best.inViewport && el.inViewport ? 1 : 0)
      if (better > 0) best = el
    }
  }
  return best
}

/* ────────────────────────────── 步骤 → 动作 ────────────────────────────── */

function clampDelay(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_DELAY_MS
  return Math.min(MAX_DELAY_MS, Math.max(0, Math.round(n)))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 把一步脚本翻译成动作。
 * 解析不到元素时抛错，由调用方折算成 failedAt —— 这里不做任何降级尝试，
 * 因为「点错了」的代价远大于「停下来让人看一眼」。
 */
function buildAction(step: ScriptStep, snapshot: PageSnapshot): Action {
  switch (step.action) {
    case 'navigate': {
      const url = (step.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) throw new Error('导航步骤缺少合法的 http/https 地址')
      return { type: 'navigate', url }
    }
    case 'scroll': {
      const raw = (step.key ?? 'down').trim().toLowerCase()
      const direction: Action['direction'] =
        raw === 'up' || raw === 'top' || raw === 'bottom' ? raw : 'down'
      const amount = Number.parseInt((step.text ?? '').trim(), 10)
      const action: Action = { type: 'scroll', direction }
      if (Number.isFinite(amount) && amount > 0) action.amount = amount
      return action
    }
    case 'extract':
      return { type: 'extract', query: (step.text ?? '').trim() || '页面内容' }
    case 'done':
      return { type: 'done', summary: (step.note ?? '脚本执行完毕').trim() }
    default:
      break
  }

  const selector = (step.selector ?? '').trim()
  if (!selector) throw new Error(`缺少目标选择器（${step.action} 动作必须指定元素）`)

  const el = resolveElement(snapshot, parseSelector(selector))
  if (!el) throw new Error(`选择器「${selector}」在当前页面找不到匹配元素`)

  if (step.action === 'click') return { type: 'click', id: el.id }
  if (step.action === 'type') {
    return { type: 'type', id: el.id, text: step.text ?? '' }
  }
  return { type: 'press', id: el.id, key: (step.key ?? 'Enter').trim() || 'Enter' }
}

/* ────────────────────────────── 落盘前的清洗 ────────────────────────────── */

/**
 * 渲染层传来的步骤是不可信输入：动作类型可能被手改成未知值，
 * 延时可能是个负数或字符串。这里逐字段收敛，宁可丢字段也不写脏数据进库。
 */
function sanitizeSteps(input: unknown): ScriptStep[] {
  if (!Array.isArray(input)) return []
  const out: ScriptStep[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const step = raw as ScriptStep
    if (!VALID_ACTIONS.includes(step.action)) continue

    const next: ScriptStep = { action: step.action }
    if (typeof step.url === 'string' && step.url.trim()) next.url = step.url.trim()
    if (typeof step.selector === 'string' && step.selector.trim()) {
      next.selector = step.selector.trim()
    }
    if (typeof step.text === 'string' && step.text !== '') next.text = step.text
    if (typeof step.key === 'string' && step.key.trim()) next.key = step.key.trim()
    if (typeof step.note === 'string' && step.note.trim()) next.note = step.note.trim()
    next.delayMs = clampDelay(step.delayMs)
    out.push(next)
  }
  return out
}

/* ────────────────────────────── 注册 ────────────────────────────── */

export function registerScriptModule(ctx: ModuleContext): void {
  const scripts = ctx.stores.scripts

  ctx.handle(CH.scripts.list, () => scripts.list())

  ctx.handle(CH.scripts.get, (_event, id) => {
    const script = scripts.get(String(id))
    if (!script) throw new Error('脚本不存在，可能已被删除')
    return script
  })

  ctx.handle(CH.scripts.save, (_event, input) => {
    const raw = (input ?? {}) as Partial<AutomationScript> & { name: string }
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name) throw new Error('脚本名称不能为空')

    const now = Date.now()
    const patch: Partial<AutomationScript> = { name, updatedAt: now }
    // 只在调用方明确给了 steps 时才覆盖，避免「改个名字」把步骤清空
    if (Array.isArray(raw.steps)) patch.steps = sanitizeSteps(raw.steps)
    if (typeof raw.description === 'string') patch.description = raw.description.trim()
    if (typeof raw.profileId === 'string' && raw.profileId.trim()) {
      patch.profileId = raw.profileId.trim()
    }

    if (typeof raw.id === 'string' && raw.id) {
      const existing = scripts.get(raw.id)
      if (!existing) throw new Error('脚本不存在，可能已被删除')
      return scripts.update(raw.id, patch)
    }

    const created: AutomationScript = {
      id: CollectionStore.newId('scr'),
      name,
      steps: patch.steps ?? [],
      createdAt: now,
      updatedAt: now
    }
    if (patch.description) created.description = patch.description
    if (patch.profileId) created.profileId = patch.profileId
    return scripts.add(created)
  })

  ctx.handle(CH.scripts.remove, (_event, id) => {
    scripts.remove(String(id))
  })

  ctx.handle(CH.scripts.run, async (_event, scriptId, profileId): Promise<ScriptRunResult> => {
    const script = scripts.get(String(scriptId))
    if (!script) throw new Error('脚本不存在，可能已被删除')

    const steps = Array.isArray(script.steps) ? script.steps : []
    const total = steps.length
    if (total === 0) throw new Error('脚本还没有步骤，先添加一步或从历史任务导入')

    const handle = ctx.wm.getTab(String(profileId))
    if (!handle) throw new Error('请先打开该环境再回放')

    const cdp = bridgeFor(handle.wc)
    try {
      await cdp.attach()
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return { ok: false, executed: 0, total, failedAt: 1, error: `无法连接页面：${detail}` }
    }

    let executed = 0

    for (let i = 0; i < total; i += 1) {
      const step = steps[i]
      const at = i + 1

      // 每步都重抓快照：页面是活的，上一帧的编号可能已经指向别的元素
      const snapshot = await captureSnapshot(cdp)

      let action: Action
      try {
        action = buildAction(step, snapshot)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        return { ok: false, executed, total, failedAt: at, error: `第 ${at} 步：${detail}` }
      }

      const result = await executeAction(cdp, action, snapshot)
      if (!result.ok) {
        return {
          ok: false,
          executed,
          total,
          failedAt: at,
          error: `第 ${at} 步（${action.type}）执行失败：${result.message}`
        }
      }

      executed += 1

      // done 是脚本的终止标记，后面的步骤按「已取消」处理，不再执行
      if (step.action === 'done') break

      if (i < total - 1) await sleep(clampDelay(step.delayMs))
    }

    return { ok: true, executed, total }
  })
}
