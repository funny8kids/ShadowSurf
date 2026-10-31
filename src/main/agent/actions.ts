/**
 * 动作执行器。
 *
 * 防幻觉的唯一闸门就在这里：模型给的 id 必须出现在**当轮快照**的 elements 里，
 * 否则直接拒绝，绝不去 DOM 上碰运气。模型因此无法指向列表之外的任何元素。
 */
import type { Action, ActionResult, PageSnapshot, SnapshotElement } from '@shared/protocol'
import type { CdpBridge } from '@main/core/cdp'
import { runInAgentWorld } from '@main/agent/snapshot'

/** 这三个动作必须带编号 */
const NEEDS_ID = new Set<Action['type']>(['click', 'type', 'press'])

/** navigate 之后页面正在跳，等一拍再让循环继续，避免拿到半截快照 */
const NAVIGATE_SETTLE_MS = 900

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function findElement(snapshot: PageSnapshot, id?: string): SnapshotElement | undefined {
  if (!id) {
    return undefined
  }
  return snapshot.elements.find((el) => el.id === id)
}

function isHttpUrl(url?: string): boolean {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim())
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toActionResult(raw: unknown): ActionResult {
  if (!isRecord(raw)) {
    return { ok: false, message: '页面没有返回执行结果' }
  }
  const ok = raw.ok === true
  const fallback = ok ? '已执行' : '执行失败'
  const message =
    typeof raw.message === 'string' && raw.message.length > 0 ? raw.message : fallback
  const result: ActionResult = { ok, message }
  if (raw.navigated === true) {
    result.navigated = true
  }
  if ('data' in raw) {
    result.data = raw.data
  }
  return result
}

/**
 * 执行一个动作。
 * 先做编号校验，再交给页面脚本；navigate 额外等 900ms。
 */
export async function executeAction(
  cdp: CdpBridge,
  action: Action,
  snapshot: PageSnapshot
): Promise<ActionResult> {
  if (NEEDS_ID.has(action.type)) {
    const id = typeof action.id === 'string' ? action.id.trim() : ''
    if (!id) {
      return { ok: false, message: `${action.type} 动作缺少元素编号` }
    }
    // 防幻觉核心：编号必须存在于当轮快照
    if (!findElement(snapshot, id)) {
      return { ok: false, message: `模型引用了不存在的元素 ${id}` }
    }
  }

  if (action.type === 'navigate' && !isHttpUrl(action.url)) {
    return { ok: false, message: '只允许 http/https 地址' }
  }

  // 序列化两次：外层是 JS 字符串字面量，页面侧再 JSON.parse 还原动作
  const literal = JSON.stringify(JSON.stringify(action))
  const expression =
    '(function(){var a=JSON.parse(' +
    literal +
    ');if(!window.__SS__||!window.__SS__.act){return{ok:false,message:"页面脚本未就绪，请先获取快照"}};' +
    'return window.__SS__.act(a)})()'

  let raw: unknown
  try {
    // 必须在 isolated world 里求值：主世界的 window 上没有 __SS__，
    // 页面脚本也没法抢先定义一个假的把结果伪造掉
    raw = await runInAgentWorld(cdp, expression)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `执行失败：${detail}` }
  }

  const result = toActionResult(raw)
  if (action.type === 'navigate' && result.ok) {
    await sleep(NAVIGATE_SETTLE_MS)
    result.navigated = true
  }
  return result
}

/** 给 UI 和步骤流看的中文人话 */
export function describeAction(action: Action, snapshot: PageSnapshot): string {
  const el = findElement(snapshot, action.id)
  const label = el?.name ? `「${el.name}」` : ''

  switch (action.type) {
    case 'click': {
      if (el) {
        return `点击${label || ` ${el.id}`}`
      }
      return `点击 ${action.id ?? '元素'}`
    }
    case 'type': {
      const text = action.text ?? ''
      const submit = action.submit ? '并提交' : ''
      if (el) {
        const suffix = el.role === 'textbox' ? '输入框' : ''
        return `在${label}${suffix}输入「${text}」${submit}`
      }
      return `在 ${action.id ?? '元素'} 输入「${text}」${submit}`
    }
    case 'press': {
      const key = action.key ?? 'Enter'
      return el ? `在${label}上按下 ${key} 键` : `按下 ${key} 键`
    }
    case 'scroll': {
      const amount = typeof action.amount === 'number' && action.amount > 0 ? action.amount : 0
      switch (action.direction) {
        case 'top':
          return '滚动到页面顶部'
        case 'bottom':
          return '滚动到页面底部'
        case 'up':
          return amount > 0 ? `向上滚动 ${amount}px` : '向上滚动一屏'
        default:
          return amount > 0 ? `向下滚动 ${amount}px` : '向下滚动一屏'
      }
    }
    case 'navigate':
      return `打开 ${action.url ?? '目标地址'}`
    case 'extract':
      return `提取：${action.query ?? '页面内容'}`
    case 'done':
      return `完成：${action.summary ?? '任务结束'}`
    default:
      return `执行 ${String(action.type)}`
  }
}
