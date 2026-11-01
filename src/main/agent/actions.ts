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
 *
 * 授权本身也换了一次来源。「谁授权了」原先是一句调用方声明
 * （`approvedBy: 'user'`），于是被 XSS 的渲染层只要不弹窗、直接发那条 IPC
 * 就等于用户点了同意。现在调用方只能递一张 **ticket**，而 ticket 只有一个来源：
 * `consent.ts` 里那次 `dialog.showMessageBox` —— 操作系统窗口上的一次真实点击。
 * 调用方连「我授权了」这句话都说不了了，它只能证明「刚才有个对话框被点过」。
 */
import type { Action, ActionResult, PageSnapshot } from '@shared/protocol'
import { actionSemantic, findElement } from '@shared/protocol'
import type { MaskStateRecord } from '@shared/types'
import type { CdpBridge } from '@main/core/cdp'
import { runInAgentWorld } from '@main/agent/snapshot'
import { assessRisk } from '@main/agent/risk'
import { consumeTicket, digestAction } from '@main/agent/consent'
import { judgeMask } from '@main/core/mask-gate'

/**
 * 伪装状态查询函数，由组合根注入（`index.ts`）。
 *
 * 为什么是注入而不是直接 `wm.maskStateOf(...)`：执行器被 `tools/probe-gate.mjs`
 * 在纯 Node 里加载，真去 import `windows.ts` 会把 electron 整条链拖进来 ——
 * 探针跑不起来，于是「闸门有效」这件事又只能靠读代码证明。
 *
 * 与 `consent.ts` 的 `setConsentAuditSink` 是同一个模式，理由也一样。
 */
export type MaskStateLookup = (webContentsId?: number) => MaskStateRecord | null

let maskLookup: MaskStateLookup | null = null

export function setMaskStateLookup(fn: MaskStateLookup | null): void {
  maskLookup = fn
}

/**
 * 授权凭据。
 *
 * 这里**故意不放 `level`**。早先的设想是让调用方把 `assessRisk` 的结论传进来，
 * 但那样闸门的强度就等于「调用方有没有老实调用」—— 而绕过闸门的两条路径
 * 恰恰就是没老实调用的那两条。等级必须由执行器自己算，调用方只能证明授权来源。
 *
 * 同理也**故意不放 `approvedBy`**：授权来源不再是声明，而是「ticket 有没有被消费成功」。
 * 有且仅有 `consent.ts` 能铸票，所以「消费成功」严格等价于「用户在系统窗口点了允许」。
 */
export type Approval = {
  /**
   * 一次性同意凭证。L2 动作必须有；L1 不需要。
   * 由 `requestConsent` 产生 —— 调用方无法凭空造出一个能通过的字符串。
   */
  ticket?: string
  /** 调用方身份，**仅用于审计记录「谁发起的」**，不作为授权依据 */
  origin: 'agent' | 'script' | 'api'
  /**
   * 补充语义：模型自述、录制备注之类，**不含元素名**。
   *
   * 元素名一律由执行器自己从快照取（`actionSemantic`）。调用方不许拼进来 ——
   * 本地 HTTP API 手里只有 `action.id`，根本拿不到元素名；一旦允许调用方拼，
   * 那条路径就会「看起来接了闸门、实际扫不到任何语义」。
   *
   * 字段名从 `extra` 改成 `note`：名字本身说明这里只放备注，让「该放什么」
   * 由类型强制一遍，而不是靠三条调用路径的作者各自记得。
   */
  note?: string
  /**
   * 闸门判定时用的只读意图。
   *
   * 不传 = 按空意图重算 = 永不降级 = 最保守等级。
   * 外部 API 与脚本回放都没有「用户意图」这个东西可传，所以它们天然最保守；
   * agent loop 传的是用户原话，与它自己那次判定同源，不会出现两份结论打架。
   */
  intent?: string
  /**
   * 发起方 webContents id。凭证里记了同一个值时才比对 ——
   * 用于把票绑到「弹出那个对话框时所在的窗口」，防止一张票被另一个窗口用掉。
   * localApi 路径没有 sender，此时不参与比对。
   */
  senderId?: number
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
  /**
   * 授权来源，**由 ticket 是否被消费成功推导**，不是调用方声明的。
   * 'user' 只可能来自「用户在系统原生窗口点了允许」这一件事。
   */
  approvedBy: 'none' | 'user'
  /** 谁发起的（审计用），不参与授权判断 */
  origin: Approval['origin']
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
 *
 * 注意「补一个确认」现在不是补一个字段：得让 `requestConsent` 弹出一个
 * 系统原生窗口，并且有人真的在上面点了「允许执行」。
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

/**
 * 伪装状态不足以执行不可逆动作。
 *
 * 单独一个类型，因为它和另外两个错误的**补救动作完全不同**：
 *   - `ApprovalRequiredError`：补一次确认就能过（人点头即可）
 *   - `AuditUnavailableError`：环境问题，补什么确认都没用，要修磁盘
 *   - 这个：**补确认也没用**，要等伪装真的装上（或用户显式选择「以未伪装身份继续」）
 * 混成一个，用户会看到一句错的提示，然后反复点「允许」。
 */
export class MaskIncompleteError extends Error {
  readonly kind: string
  readonly state: string

  constructor(reason: string, kind: string, state: string) {
    super(reason)
    this.name = 'MaskIncompleteError'
    this.kind = kind
    this.state = state
  }
}

/** 这三个动作必须带编号 */
const NEEDS_ID = new Set<Action['type']>(['click', 'type', 'press'])

/** navigate 之后页面正在跳，等一拍再让循环继续，避免拿到半截快照 */
const NAVIGATE_SETTLE_MS = 900

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
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
  const target = findElement(snapshot, action.id)
  const verdict = assessRisk(action, approval.intent ?? '', actionSemantic(action, snapshot, approval.note))

  // ── 伪装闸门（在消费凭证之前）──
  //
  // 顺序很关键：**先判伪装，再烧票**。反过来的话，伪装不完整时用户点的那次
  // 「允许执行」会被白白烧掉，他下次还得再点一次，而两次点击之间页面可能已经变了。
  //
  // 只拦 L2：伪装失败影响的是「不可逆动作的授权前提」。L1 可回退，拦它等于
  // 回滚之后浏览器完全不能用 —— 用户会去找办法把整个机制关掉，那比不实现更坏。
  //
  // 查不到就拒绝（`judgeMask(null)`）：窗口已销毁 / 这条路径没有发起窗口 /
  // 组合根忘了注入 —— 三种情况都不是「伪装成功」，按拒绝处理。
  if (verdict.level === 'L2') {
    const record = maskLookup === null ? null : maskLookup(approval.senderId)
    const mask = judgeMask(record)
    if (!mask.allow) {
      // 被拦下的动作要留痕，理由用伪装那条而不是风险那条 ——
      // 否则审计里会写「未获授权（无有效票据）」，而真实原因是「没伪装住」，
      // 事后追责会照着它得出错误结论。
      try {
        approval.onGate?.({
          level: 'L2',
          approvedBy: 'none',
          origin: approval.origin,
          action,
          matched: verdict.matched,
          reason: mask.reason
        })
      } catch {
        // 审计写不进去也不改变结论：这次就是不执行。
      }
      throw new MaskIncompleteError(mask.reason, mask.kind, mask.state)
    }
  }

  // 闸门事件先落审计再抛错：被拦下的动作是最该留痕的，
  // 原先三条路径里只有脚本那条会写审计，agent 跑了 40 步一个字节都不留。
  //
  // L2 走「没有记录就没有执行」：审计写不进去时宁可不动。
  // 不可逆动作 + 事后查不到是谁放的 —— 这正是这一整轮要消掉的那类缺陷。
  // L1 不拦：它可回退，为了记不上账而卡住正常浏览没有道理。
  //
  // 凭证必须**在写审计之前**消费：审计里要落「用户到底点了没有」，
  // 而这个事实只有一个来源 —— consumeTicket 的返回值。
  // 顺序反过来就只能先记「未授权」再放行，那条记录是错的。
  // 代价是：若审计随后写失败，这张票已经被烧掉了。宁可让用户再点一次，
  // 也不要出现「票没烧、动作没跑、审计没记」的三不管状态。
  const granted =
    verdict.level === 'L2'
      ? consumeTicket(
          typeof approval.ticket === 'string' ? approval.ticket : '',
          digestAction(action),
          approval.senderId
        )
      : false

  let gateLogged = true
  try {
    approval.onGate?.({
      level: verdict.level === 'L2' ? 'L2' : 'L1',
      approvedBy: granted ? 'user' : 'none',
      origin: approval.origin,
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
    if (!granted) {
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
