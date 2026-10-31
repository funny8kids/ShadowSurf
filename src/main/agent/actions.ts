/**
 * 动作执行器。
 *
 * 防幻觉的唯一闸门就在这里：模型给的 id 必须出现在**当轮快照**的 elements 里，
 * 否则直接拒绝，绝不去 DOM 上碰运气。模型因此无法指向列表之外的任何元素。
 *
 * 风险闸门也在这里（A14）。原本只有 agent loop 调 `assessRisk`，本地 HTTP API
 * 和脚本回放两条路径直接调执行器，把闸门整个绕过去了 —— 它们的注释里写着
 * 「必须自己调 assessRisk」，但「必须」只是注释，没有任何东西强制。
 * 现在执行器自己算等级：调用方只能声明**谁授权了**，不能声明**几级**。
 */
import type { Action, ActionResult, PageSnapshot, SnapshotElement } from '@shared/protocol'
import type { CdpBridge } from '@main/core/cdp'
import { runInAgentWorld } from '@main/agent/snapshot'
import { assessRisk } from '@main/agent/risk'

/**
 * 授权凭据。
 *
 * 这里**故意不放 `level`**。早先的设想是让调用方把 `assessRisk` 的结论传进来，
 * 但那样闸门的强度就等于「调用方有没有老实调用」—— 而绕过闸门的两条路径
 * 恰恰就是没老实调用的那两条。等级必须由执行器自己算，调用方只能证明授权来源。
 */
export type Approval = {
  /** 'none' = 没有授权，只允许执行非 L2 动作 */
  approvedBy: 'none' | 'user' | 'api'
  /** 目标元素可读名 + 模型自述。页面可控，只会抬高等级，不会被用来降低 */
  extra?: string
  /**
   * 闸门判定时用的只读意图。
   *
   * 不传 = 按空意图重算 = 永不降级 = 最保守等级。
   * 外部 API 与脚本回放都没有「用户意图」这个东西可传，所以它们天然最保守；
   * agent loop 传的是用户原话，与它自己那次判定同源，不会出现两份结论打架。
   */
  intent?: string
  /**
   * 闸门事件的落点。
   *
   * 用注入而不是在这里直接 `getStores()`：执行器被 `tools/probe-gate.mjs` 在
   * 纯 Node 里加载，真去写审计库会让探针污染用户数据，也跑不起来。
   */
  onGate?: (event: GateEvent) => void
}

export interface GateEvent {
  level: 'L1' | 'L2'
  /** 真正做出决定的授权来源，不是调用方声明的 */
  approvedBy: Approval['approvedBy']
  action: Action
  /** 命中的不可逆语义词 */
  matched?: string
  reason: string
}

/**
 * L2 动作在没有授权时被拦下。
 *
 * 用异常而不是 `{ok:false}`：`ok:false` 在执行器里表示「动作跑了但页面说失败」，
 * 调用方会把它当成业务失败继续往下走；授权缺失是**根本没跑**，语义不同。
 */
export class ApprovalRequiredError extends Error {
  readonly actionType: Action['type']
  readonly matched?: string

  constructor(reason: string, actionType: Action['type'], matched?: string) {
    super(reason)
    this.name = 'ApprovalRequiredError'
    this.actionType = actionType
    this.matched = matched
  }
}

/**
 * 审计写不进去，于是 L2 动作不执行。
 *
 * 单独一个类型是因为它的处置方式不同：`ApprovalRequiredError` 是「补一个确认就能过」，
 * 这个是「环境有问题，补什么确认都没用」。混成一个，调用方只能给用户看一句错的提示。
 */
export class AuditUnavailableError extends Error {
  constructor(detail: string) {
    super(`无法写入审计记录，动作已中止（${detail}）。请检查磁盘空间与审计文件权限`)
    this.name = 'AuditUnavailableError'
  }
}

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
    return { ok: false, message: '页面没有返回执行结果', failure: 'exec' }
  }
  const ok = raw.ok === true
  const fallback = ok ? '已执行' : '执行失败'
  const message =
    typeof raw.message === 'string' && raw.message.length > 0 ? raw.message : fallback
  const result: ActionResult = { ok, message }
  if (!ok) {
    // 页面自己报的失败一律归 exec。页面脚本不会区分「找不到元素」和「点不动」，
    // 而这两个的差别只对模型有意义（它据此决定换元素还是重试），对用户是同一件事。
    result.failure = 'exec'
  }
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
 *
 * 顺序：授权 → 编号校验 → 交给页面脚本；navigate 额外等 900ms。
 * 授权排在最前，是因为「能不能做」比「做哪一步」更外层：没授权的动作
 * 连元素都不该去找，否则一次点击的成败会被元素是否存在掩盖过去。
 */
export async function executeAction(
  cdp: CdpBridge,
  action: Action,
  snapshot: PageSnapshot,
  approval: Approval
): Promise<ActionResult> {
  // A14：自己重算等级，不接收调用方传来的结论。
  // intent 缺省为 '' → hitReadOnlyIntent 返回 undefined → 永不降级 → 最保守。
  //
  // 元素可读名在这里自己取，不要调用方传：本地 HTTP API 手里只有 action.id，
  // 拿不到元素名，于是「点『立即支付』」在它那条路径上扫到的语义是空的 ——
  // 闸门看起来接了、其实对这路径完全不设防。谁调用都得有元素名，那就别指望调用方。
  const target = typeof action.id === 'string' ? findElement(snapshot, action.id.trim()) : undefined
  const extra = [target?.name ?? '', approval.extra ?? '']
    .filter((v) => v.length > 0)
    .join(' ')
  const verdict = assessRisk(action, approval.intent ?? '', extra)

  // 闸门事件先落审计再抛错：被拦下的动作是最该留痕的，
  // 原先三条路径里只有脚本那条会写审计，agent 跑了 40 步一个字节都不留。
  //
  // L2 走「没有记录就没有执行」：审计写不进去时宁可不动。
  // 不可逆动作 + 事后查不到是谁放的 —— 这正是这一整轮要消掉的那类缺陷。
  // L1 不拦：它可回退，为了记不上账而卡住正常浏览没有道理。
  let gateLogged = true
  try {
    approval.onGate?.({
      level: verdict.level === 'L2' ? 'L2' : 'L1',
      approvedBy: approval.approvedBy,
      action,
      matched: verdict.matched,
      reason: verdict.reason
    })
  } catch (err) {
    gateLogged = false
    if (verdict.level === 'L2') {
      throw new AuditUnavailableError(err instanceof Error ? err.message : String(err))
    }
  }

  if (verdict.level === 'L2') {
    if (!gateLogged) {
      throw new AuditUnavailableError('审计未落盘')
    }
    if (approval.approvedBy === 'none') {
      throw new ApprovalRequiredError(verdict.reason, action.type, verdict.matched)
    }
  }

  if (NEEDS_ID.has(action.type)) {
    const id = typeof action.id === 'string' ? action.id.trim() : ''
    if (!id) {
      return { ok: false, message: `${action.type} 动作缺少元素编号`, failure: 'not-found' }
    }
    // 防幻觉核心：编号必须存在于当轮快照
    if (!findElement(snapshot, id)) {
      return { ok: false, message: `模型引用了不存在的元素 ${id}`, failure: 'not-found' }
    }
  }

  if (action.type === 'navigate' && !isHttpUrl(action.url)) {
    return { ok: false, message: '只允许 http/https 地址', failure: 'exec' }
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
    // 页面脚本也没法抢先定义一个假的把结果伪造掉。
    // retry:false —— 动作有副作用，「已执行但响应丢失」时重试会变成点两次
    raw = await runInAgentWorld(cdp, expression, { retry: false })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `执行失败：${detail}`, failure: 'exec' }
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
