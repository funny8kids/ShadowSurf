/**
 * 同意凭证（consent ticket）。
 *
 * 这个模块存在的唯一理由，用一句话说：
 *
 *   **「用户已同意」原先被实现成了调用方的一个字段，而不是主进程持有的一个凭证。**
 *
 * 三条通道（`agent.confirm` / `scripts.run` 的 `confirmed` / `localapi` 的 `confirm`）
 * 没有一个能让主进程独立验证「用户同意过」—— 它们全都只是把发起方自己的话
 * 转述了一遍。所以那不是三个 bug，是一个设计错误。
 *
 * 这里把这句话反过来：**渲染层只能请求，不能断言。**
 * 同意由主进程弹出一个操作系统窗口去问，答案留在主进程手里，只以一次性凭证的形式
 * 交给执行器校验。渲染层从头到尾没有机会说「他同意了」。
 *
 * 加 nonce 治不好：nonce 由谁发？如果由主进程在「渲染层显示弹窗时」发，
 * 那渲染层只要不显示弹窗、直接要 nonce 就行 —— 伪造成本从「调一个 IPC」变成「调两个 IPC」。
 *
 * 所以同意来源是 `dialog.showMessageBox`：OS 级窗口，渲染层碰不到，
 * 也没有任何 IPC 通道能代替它被点掉。界面朴素是代价，「不可伪造」优先于「好看」。
 *
 * 为什么不新开 BrowserWindow + 独立 preload + 独立 HTML：
 * 那要多一个 preload、多一个 HTML 入口、多一条 IPC 通道 —— 每一样都是新的攻击面，
 * 而它能提供的只是「好看」。原生对话框的窗口由操作系统画，没有可被注入的文档。
 */

import { createHash, randomBytes } from 'node:crypto'
import { BrowserWindow, dialog, webContents } from 'electron'
import type { Action } from '@shared/protocol'
import { boundDetail, boundMatched, boundTarget } from '@main/modules/audit-bound'

/* ────────────────────────────── 契约 ────────────────────────────── */

/** 谁发起的。只用于审计记录「这次询问是谁引起的」，不参与任何判断 */
export type ConsentOrigin = 'loop' | 'script' | 'localapi'

export interface ConsentRequest {
  action: Action
  level: 'L2'
  /** 闸门给出的理由（来自 assessRisk） */
  reason: string
  /** 命中的不可逆语义词 */
  matched?: string
  /** 动作的人话描述，例如「点击「立即支付」」。由调用方用 describeAction 生成 */
  target: string
  origin: ConsentOrigin
}

/**
 * 询问的结果。
 *
 * 为什么不沿用「返回 ticket 或 null」：`denied`（人点了取消）和 `timeout`
 * （120 秒没人理）和 `unavailable`（窗口根本弹不出来）在事后追责时是三件不同的事，
 * 折成一个 null 就只能靠调用方猜。审计必须能分开写。
 */
export type ConsentOutcome =
  | { kind: 'granted'; ticket: string }
  | { kind: 'denied' }
  | { kind: 'timeout' }
  | { kind: 'unavailable' }

interface TicketRecord {
  expiresAt: number
  actionDigest: string
  /** 发起方 webContents id；只有双方都有值时才会比对 */
  senderId?: number
  used: boolean
}

/* ────────────────────────────── 常量 ────────────────────────────── */

/**
 * 凭证有效期 120 秒：够用户读完理由再决定，又不至于让一张票在内存里躺一整天。
 *
 * 允许用 `SS_CONSENT_TTL_MS` 覆盖，但**只能缩短不能延长**（见下面的 Math.min）。
 * 存在的意义是让探针能在毫秒级验证「过期票被拒」——120 秒的用例没法等。
 * 它不能用来放宽闸门：把值调大一律无效，所以即便被人为设置也不构成绕过。
 */
const DEFAULT_TTL_MS = 120_000

const TTL_MS: number = (() => {
  const raw = Number(process.env['SS_CONSENT_TTL_MS'])
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TTL_MS
  return Math.min(DEFAULT_TTL_MS, Math.floor(raw))
})()

/** 待消费凭证上限。正常使用同时最多存在一两张，超过这个量级说明有东西在刷 */
const MAX_PENDING = 64

/* ────────────────────────────── 状态 ────────────────────────────── */

const tickets = new Map<string, TicketRecord>()

/**
 * 惰性清理：每次发新票时顺手扫一遍。
 *
 * 不挂 setInterval 的原因：这个 Map 平时是空的，为了一个空 Map 常驻一个定时器
 * 会让进程在测试里无法自然退出（探针和 `node --test` 都会被它挂住）。
 * 清理时机跟「用得上」的时机绑定，反而更准。
 */
function sweep(now: number): void {
  for (const [key, rec] of tickets) {
    if (rec.used || rec.expiresAt <= now) tickets.delete(key)
  }
  // 极端情况下（大量并发请求且都还没过期）仍然要设个硬上限
  while (tickets.size >= MAX_PENDING) {
    const oldest = tickets.keys().next()
    if (oldest.done === true) break
    tickets.delete(oldest.value)
  }
}

/* ────────────────────────────── 摘要 ────────────────────────────── */

/**
 * 参与摘要的字段，顺序固定。
 *
 * 不包含 `data`：它是 done 动作的任意结构化结果，形状由模型决定，
 * 可能含 undefined / 循环引用 / 超大对象 —— 摘要函数必须永远能算出一个稳定值。
 * 其余字段就是「这个动作要干什么」的全部：指向哪个元素、输入什么、跳到哪。
 */
const DIGEST_FIELDS = [
  'type',
  'id',
  'text',
  'key',
  'submit',
  'direction',
  'amount',
  'url',
  'query',
  'summary'
] as const

/**
 * 动作的稳定摘要。作用是把一张凭证钉死在**这一个动作**上：
 * 用户批准的是「点击立即支付」，那张票就不能拿去执行「删除全部」。
 */
export function digestAction(action: Action): string {
  const fields = DIGEST_FIELDS.map((field) => {
    const value = (action as unknown as Record<string, unknown>)[field]
    if (value === undefined || value === null) return ''
    return typeof value === 'string' ? value : JSON.stringify(value)
  })
  // 用 JSON.stringify 序列化数组而不是自己拼分隔符：
  // 文本里出现分隔符时，自拼会产生 `a|b` 与 `a` + `|b` 撞摘要的歧义。
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex')
}

/* ────────────────────────────── 审计落点 ────────────────────────────── */

/**
 * 询问结果的审计落点，由组合根注入（见 ipc/handlers.ts）。
 *
 * 为什么是注入而不是在这里 `import { auditConsent } from '@main/modules/audit'`：
 * 那会把 `@main/store` → db.ts → electron/磁盘 整条链拖进来，于是
 * `tools/probe-gate.mjs` 在纯 Node 里就加载不了这个模块 —— 而它是「同意」的
 * 唯一来源，探针加载不了它就只能靠读代码「证明」闸门有效，那不是验证。
 *
 * 注入点仍然只有 `requestConsent` 一处：loop / script / localapi 三条路径
 * 都会经过它，所以「拒签不写审计」这种漏记不可能发生。
 */
export type ConsentAuditSink = (outcome: ConsentOutcome, req: ConsentRequest) => void

let auditSink: ConsentAuditSink | null = null

export function setConsentAuditSink(sink: ConsentAuditSink | null): void {
  auditSink = sink
}

function report(outcome: ConsentOutcome, req: ConsentRequest): void {
  try {
    auditSink?.(outcome, req)
  } catch (err) {
    // 审计写不进去不能反过来把「用户拒绝了」变成一次异常：
    // 拒绝本身已经生效，这里只丢掉一条记录。L2 的「没记录就不执行」由执行器管，
    // 而执行器只在真的拿到票时才会走到那一步。
    console.error('[consent] 同意结果写入审计失败', err)
  }
}

/* ────────────────────────────── 发券 ────────────────────────────── */

/** 同一时刻只允许一个对话框：排队而不是并发弹窗，否则用户会看到一叠窗口 */
let queue: Promise<unknown> = Promise.resolve()

function showDialog(req: ConsentRequest, senderId?: number): Promise<ConsentOutcome> {
  return new Promise<ConsentOutcome>((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const finish = (outcome: ConsentOutcome): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(outcome)
    }

    // 超时必须是**拒绝**：既不能挂起（调用方永远等），也不能放行。
    // 这是原来 `askConfirm` 那个 5 分钟超时 `resolve(false)` 的等价物，
    // 只是从 5 分钟收到 120 秒 —— 用户读完一段话再决定，120 秒够了。
    timer = setTimeout(() => finish({ kind: 'timeout' }), TTL_MS)

    // 正文与标题都要有界。
    //   · `req.target` 来自 `describeAction`，里面含元素名，而 `type` 动作还会把
    //     **要输入的整段文本**写进去 —— 模型可以输入 10KB，标题就跟着变 10KB；
    //   · `req.reason` 现在在 `assessRisk` 里已经有界，这里再兜一层，
    //     因为 consent 是**最后一个**能把这段字送进系统窗口的地方。
    // 用 `boundTarget` / `boundDetail`（`audit-bound.ts`，零依赖）而不是本地 slice：
    // 审计与对话框对「多长算长」必须是同一个数，否则会出现
    // 「对话框里看到的和审计里记的不是同一段话」，事后核对时无法对齐。
    const detailLines = [boundDetail(req.reason) ?? '']
    if (req.matched) detailLines.push(`命中关键词：「${boundMatched(req.matched)}」`)
    detailLines.push('这是一次不可逆操作，执行后无法撤销。')

    const options = {
      type: 'warning' as const,
      // 默认按钮**必须是取消**：用户误按回车时不能批准任何事
      buttons: ['取消', '允许执行'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: '确认不可逆操作',
      message: boundTarget(req.target) ?? '（目标未知）',
      detail: detailLines.join('\n')
    }

    // 有父窗口就挂成模态，没有（localApi 触发时通常没有焦点窗口）就用无父窗口形式
    let parent: BrowserWindow | null = null
    try {
      // fromId() 的返回类型是 WebContents | undefined（不是 null），
      // 所以这里只能用真值判断收窄 —— 写 `wc !== null` 收窄不掉 undefined，
      // 类型检查会直接报 TS2345。
      const wc = typeof senderId === 'number' ? webContents.fromId(senderId) : undefined
      parent = wc ? BrowserWindow.fromWebContents(wc) : null
    } catch {
      parent = null
    }

    let pending: Promise<{ response: number }>
    try {
      pending =
        parent !== null && !parent.isDestroyed()
          ? dialog.showMessageBox(parent, options)
          : dialog.showMessageBox(options)
    } catch {
      // 连窗口都弹不出来 = 无法取得同意，不是「用户拒绝了」。
      // 这两种情况在审计里必须分开：一个是产品/环境故障，一个是人的决定。
      finish({ kind: 'unavailable' })
      return
    }

    pending.then(
      (result) => {
        // 已经超时：这次点击不再产生任何凭证。对话框还开着，但那张票不会被铸出来。
        if (settled) return
        // 只有「允许执行」是 1。其余任何返回值（取消 / 关闭 / 未知）都按拒绝处理 ——
        // 这里是白名单，不是黑名单：新加一个按钮不会意外变成「同意」。
        if (result.response !== 1) {
          finish({ kind: 'denied' })
          return
        }
        const now = Date.now()
        sweep(now)
        const ticket = randomBytes(32).toString('hex')
        const record: TicketRecord = {
          expiresAt: now + TTL_MS,
          actionDigest: digestAction(req.action),
          used: false
        }
        if (typeof senderId === 'number') record.senderId = senderId
        tickets.set(ticket, record)
        finish({ kind: 'granted', ticket })
      },
      () => finish({ kind: 'unavailable' })
    )
  })
}

/**
 * 弹原生对话框问一次，把结果（含拒绝/超时/不可用）交给审计。
 *
 * 这是整个仓库里**唯一**能产生 `ticket` 的地方。执行器只认 ticket，
 * 所以「同意」这件事只有一条来源：操作系统窗口上的一次真实点击。
 */
export function requestConsent(
  req: ConsentRequest,
  senderId?: number
): Promise<ConsentOutcome> {
  const run = queue.then(
    () => showDialog(req, senderId),
    () => showDialog(req, senderId)
  )
  queue = run.catch(() => undefined)

  return run.then((outcome) => {
    report(outcome, req)
    return outcome
  })
}

/* ────────────────────────────── 消费 ────────────────────────────── */

/**
 * 一次性消费凭证。
 *
 * 校验顺序：存在 → 未用过 → 未过期 → 摘要匹配 → 发起方匹配。
 * **任何一项失败都作废这张票**：它是一次性能力，拿着一张活票反复试参数
 * 是唯一有意义的攻击方式（试到某个动作的摘要撞上为止），所以失败即销毁。
 *
 * 校验与标记 used 在同一次同步执行里完成，中间没有 await —— 不存在 TOCTOU 窗口：
 * 两个并发调用拿到的是同一个 rec 对象，第二个看到的 used 一定是 true。
 */
export function consumeTicket(ticket: string, actionDigest: string, senderId?: number): boolean {
  if (typeof ticket !== 'string' || ticket.length === 0) return false
  if (typeof actionDigest !== 'string' || actionDigest.length === 0) return false

  const record = tickets.get(ticket)
  if (record === undefined) return false

  const now = Date.now()
  const expired = record.used || record.expiresAt <= now
  const digestOk = record.actionDigest === actionDigest
  // 双方都有值时才比对：localApi 那条路径没有 sender，不能因此把票判成无效
  const senderOk =
    record.senderId === undefined || senderId === undefined || record.senderId === senderId

  // 先作废再返回，不区分「哪一种失败」—— 对外只回答 true/false，
  // 详细的失败原因写日志由调用方决定，免得调用方能靠错误信息探测票的状态
  tickets.delete(ticket)

  if (expired || !digestOk || !senderOk) return false
  record.used = true
  return true
}

/** 仅供审计与探针读取：当前有多少张未消费的票 */
export function pendingTicketCount(): number {
  return tickets.size
}
