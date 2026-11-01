/**
 * 动作协议与页面快照。
 *
 * 核心约束：**模型永远拿不到选择器**。
 * 快照里的元素用 `e1..eN` 短编号，编号与元素的对应关系存在 isolated world 的
 * WeakMap 里（不进 DOM、不进主世界），执行器按编号在那边回查。
 * 编号不在当轮快照表里 → 判为幻觉，直接拒绝执行。
 */

/* ────────────────────────────── 快照 ────────────────────────────── */

export interface ElementBox {
  x: number
  y: number
  w: number
  h: number
}

export interface SnapshotElement {
  /** e1..eN */
  id: string
  tag: string
  /** 归一化角色：button / link / textbox / checkbox / combobox / menuitem ... */
  role: string
  /** 可读名：aria-label > label > placeholder > 文本内容 */
  name: string
  type?: string
  value?: string
  disabled: boolean
  inViewport: boolean
  box: ElementBox
}

export interface PageSnapshot {
  url: string
  title: string
  viewport: { width: number; height: number }
  scroll: { y: number; maxY: number }
  /** 正文摘要，已剥离脚本样式与零宽字符 */
  text: string
  elements: SnapshotElement[]
  capturedAt: number
  /** 元素被 token 预算截断时为 true */
  truncated: boolean
}

/* ────────────────────────────── 动作 ────────────────────────────── */

export type ActionType =
  | 'click'
  | 'type'
  | 'press'
  | 'scroll'
  | 'navigate'
  | 'extract'
  | 'done'

/**
 * 动作类型 → 中文。**唯一来源**。
 *
 * 放在 shared 而不是各层各一份，是因为它同时被两个进程用到：
 * 主进程往审计里写「目标」列（`modules/audit.ts`），渲染层画任务缩略标签
 * （`lib/format.ts` → `TaskList.tsx` / `AuditPanel.tsx`）。两份副本的下场是
 * 改一份、另一份静默留在旧词上 —— 而症状是「同一个动作在两个页面叫不同名字」，
 * 没人会把它当 bug 报。
 *
 * 用 `Record<ActionType, string>` 而不是普通对象：协议里加一个动作时，
 * 这里少写一条会**编译失败**，而不是在界面上显示英文原文。
 */
export const ACTION_LABEL: Record<ActionType, string> = {
  click: '点击',
  type: '输入',
  press: '按键',
  scroll: '滚动',
  navigate: '导航',
  extract: '提取',
  done: '结束'
}

/**
 * 把一个动作拆成「审计的目标列」和「给复盘用的技术标识」。
 *
 * **这不是 `describeAction`。** 两者输出不同、用途不同、稳定性要求也不同：
 *   - 本函数的 `target` 会**参与审计哈希**（`digest` 的输入含 target），
 *     改一个字，历史链就全部验不过 —— 所以它只依赖 `action` 本身，且措辞冻结；
 *   - `describeAction` 是给人读的当场文案，会用快照里的元素名，措辞可以改。
 *
 * 曾经两者同名，于是「改一句界面文案」和「改审计哈希」看起来是同一件事。
 *
 * 原先审计里是把协议原文直接拼进去的：
 *     [action.type, action.id ? `#${action.id}` : '', action.url ?? ''].join(' ')
 * 于是中文界面里出现英文动作名（`navigate https://…`）和一轮快照用完即弃的
 * 元素编号（`click #e7`）—— 用户既看不懂，也拿它做不了任何事。
 *
 * 元素编号没有丢，只是挪进 `marker`：
 *   - 目标列是给人扫一眼的，编号在那里是噪音；
 *   - marker 会被拼进审计的 detail，需要复盘时才看；
 *   - 两列**都参与哈希**（`digest` 的输入含 target 与 detail），所以挪位置不改变
 *     可校验性。反过来是硬约束：绝不能为了界面上好看，把信息塞进一个不参与哈希的
 *     展示字段 —— 那种字段谁都能改，审计就不再是审计了。
 *
 * 放在 shared 里（而不是 `modules/audit.ts` 内部）是为了能被 Node 单测：
 * `audit.ts` 静态 import 了 electron，纯 Node 里连模块都求值不了。
 */
export function describeAuditTarget(action: Action): { target: string; marker: string } {
  const verb = ACTION_LABEL[action.type] ?? action.type
  const target = [verb, action.id ? '某个元素' : '', action.url ?? '']
    .filter((v) => v.length > 0)
    .join(' ')
  return { target, marker: action.id ? `；元素=#${action.id}` : '' }
}

export interface Action {
  type: ActionType
  /** click / type / press 必填，必须是当轮快照里出现过的编号 */
  id?: string
  /** type 的文本 */
  text?: string
  /** press 的按键名，如 Enter / Tab / Escape */
  key?: string
  /** type 后是否回车提交 */
  submit?: boolean
  direction?: 'up' | 'down' | 'top' | 'bottom'
  amount?: number
  /** navigate 的目标地址，只允许 http/https */
  url?: string
  /** extract 的取数指令，自然语言 */
  query?: string
  /** done 的收尾说明 */
  summary?: string
  /** done 携带的结构化结果 */
  data?: unknown
}

/** 模型每一轮必须输出的 JSON 形状 */
export interface ModelDecision {
  plan: string
  thought: string
  action: Action
}

/* ────────────────────────────── 风险分级 ────────────────────────────── */

/**
 * 闸门与执行器**唯一允许**的语义拼接方式。
 *
 * ── 为什么必须只有一份实现 ──
 *
 * 这两处各自拼过一次串，而且拼法不同：
 *
 *   loop.ts      extra = [name, thought].join(' ')                  ← name 出现 1 次
 *   actions.ts   extra = [name, approval.extra].join(' ')            ← name 出现 2 次
 *
 * 抑制规则看的是「命中词**紧邻**的右文」。name 被拼两次之后，第一个 name 的右文
 * 从 `"s"` 变成了 `"Checkout s s"` —— 相邻关系被打断，抑制失效，于是
 * **闸门判 L1、执行器判 L2**：不弹确认框、没有票、动作被拦，用户从未被问过。
 *
 * 实测（`name='Checkout s'`, `thought='s'`）：
 *   拼一次 → L1（抑制生效）
 *   拼两次 → L2（抑制失效）
 *
 * 也就是说「两边结论一致」原先靠的是一个**下标的巧合**，不是断言。
 * 把拼接收成一个函数之后，「拼两次」在结构上写不出来。
 */
export function semanticOf(name: string, thought: string): string {
  return [name, thought].filter((v) => v.length > 0).join(' ')
}

/**
 * 按编号取快照元素。**编号先 trim 再比**。
 *
 * 三条路径原先各写一遍 `snapshot.elements.find(el => el.id === id)`，
 * 其中执行器那一条 trim 了、闸门那两条没有。于是模型吐出 `" e7"` 时：
 * 闸门查不到元素 → 语义里没有元素名 → 判 L1 → 不弹框；
 * 执行器 trim 后查到了 → 判 L2 → 抛 ApprovalRequiredError。
 * 用户从头到尾没被问过，动作被拦，模型重试到步数耗尽。
 *
 * 这种「同一份数据两种查法」不该靠人记住，所以收敛成一个函数。
 */
export function findElement(snapshot: PageSnapshot, id?: string): SnapshotElement | undefined {
  if (typeof id !== 'string') return undefined
  const key = id.trim()
  if (key.length === 0) return undefined
  return snapshot.elements.find((el) => el.id === key)
}

/**
 * 闸门与执行器**唯一**的语义入口。
 *
 * 元素名一律由这里从快照取，`note` 只放「模型自述 / 录制备注」这类不含元素名的文本。
 * 这样「name 被拼两次」在结构上写不出来 —— 不是靠三条路径的作者都记得只拼一次。
 *
 * 历史：这个 bug 真实发生过。闸门判 L1、执行器判 L2，动作被拦而用户从未被问过，
 * 实测 98 个用例里 50 个误拦、0 个真绕过 —— 它不会放行危险动作，
 * 但会让支付按钮彻底点不动，用户只会去把整个机制关掉。
 */
export function actionSemantic(action: Action, snapshot: PageSnapshot, note?: string): string {
  return semanticOf(findElement(snapshot, action.id)?.name ?? '', note ?? '')
}

/* ────────────────────── 动作的人话描述（全仓唯一一份） ────────────────────── */

/**
 * 把一个动作翻译成给人读的一句中文。
 *
 * ── 为什么在这里，而不是在 `main/agent/actions.ts` ──
 *
 * 这句话有三个消费方：agent 的步骤流、主进程的系统原生确认窗口、
 * 以及渲染层的步骤面板。渲染层手里**没有快照**，所以它原先自己写了一份
 * 「某个页面元素」的兜底文案 —— 于是同一句话有两个版本，改一处忘一处。
 * 放到 `shared/` 之后，`snapshot` 是可选的：有就带元素名，没有就说「某个元素」。
 *
 * ── 一条硬规则：绝不把协议字段吐进这句话 ──
 *
 * 元素编号（`e12`）是每轮快照里临时分配的，对用户没有任何意义，
 * 而且它出现在确认窗口里会让人误以为那是页面上的某个东西。
 * 拿不到可读名时就说「某个元素」—— 模糊但诚实，比一个假的可读标识强。
 *
 * ── 为什么不是 `describeAuditTarget` ──
 *
 * 那个的输出会进审计哈希，措辞冻结、不能依赖快照。这个可以改措辞、可以读快照。
 * 两者同名过一次，结果是「改一句界面文案」看起来像「改审计哈希」。
 */
export function describeAction(action: Action, snapshot?: PageSnapshot): string {
  const el = snapshot === undefined ? undefined : findElement(snapshot, action.id)
  // 只有真的有可读名时才用它；空名字不算「可读」
  const name = el?.name && el.name.trim().length > 0 ? el.name.trim() : ''
  const label = name ? `「${name}」` : ''

  switch (action.type) {
    case 'click': {
      return name ? `点击${label}` : '点击某个元素'
    }
    case 'type': {
      const text = action.text ?? ''
      const submit = action.submit ? '并提交' : ''
      if (!name) return `在某个输入框输入「${text}」${submit}`
      const suffix = el?.role === 'textbox' ? '输入框' : ''
      return `在${label}${suffix}输入「${text}」${submit}`
    }
    case 'press': {
      const key = action.key ?? 'Enter'
      return name ? `在${label}上按下 ${key} 键` : `按下 ${key} 键`
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

/**
 * L0 只读 / L1 可逆 / L2 不可逆（必须人工确认）
 * 判定发生在**执行器**，不依赖模型自觉。
 */
export type RiskLevel = 'L0' | 'L1' | 'L2'

export interface RiskVerdict {
  level: RiskLevel
  reason: string
  /** 命中的关键词，用于在确认弹窗里高亮 */
  matched?: string
  /**
   * 命中了词表、但被宾语抑制掉的那些词根（可能不止一个）。
   *
   * 为什么要把「没命中」和「命中后被抑制」分开暴露：两者都返回 L1，
   * 但含义相反 —— 前者是「这句话里没有不可逆语义」，后者是「有，但判定它是
   * 名词不是动作」。合并之后，测试只能断言 L1，于是「抑制规则写宽了、
   * 把真动作也吞了」和「词表根本没覆盖这门语言」会得到同一个绿。
   * 这个字段存在，那两种情况才各自可观测。
   *
   * **必须是数组**：一条动作可以同时命中多个被抑制的词根（`支払い方法と注文履歴`
   * 会同时抑制 `支払` 和 `注文`）。只记第一个的话，「抑制规则误吞了支付」这种
   * 情况会因为另一个词根先被记下而从证据里消失 —— 审计记录里少了最关键的那条。
   */
  suppressed?: string[]
}

/* ────────────────────────────── 执行结果 ────────────────────────────── */

/**
 * 失败分类。**不要用 message 的字符串来判**，也不要把它直接渲染给用户。
 *
 * `message` 是写给模型看的：它进下一轮 prompt，所以必须具体、必须带上下文，
 * 比如「模型引用了不存在的元素 e3」。这句话对模型有用（它会换一个元素），
 * 对用户毫无意义 —— 用户不知道 e3 是什么，也不知道该做什么。
 * 两套文案由这个字段连接，而不是靠匹配字符串：
 * 字符串会改，改了以后匹配会静默失效，而类型不会。
 */
export type ActionFailure =
  /** 元素编号缺失或不在当轮快照里 —— 页面变了，或模型看错了 */
  | 'not-found'
  /** 页面接受了请求但没做成：脚本未就绪、CDP 断开、页面抛错 */
  | 'exec'

export interface ActionResult {
  ok: boolean
  /** 给模型看的一句话结果 */
  message: string
  /** 失败分类，仅 ok === false 时有值 */
  failure?: ActionFailure
  /** 执行后 URL 是否发生变化，循环据此决定是否等待 */
  navigated?: boolean
  /** extract 的产出 */
  data?: unknown
}

/* ────────────────────────────── 运行期事件 ────────────────────────────── */

export type StepStatus = 'running' | 'ok' | 'failed' | 'rejected' | 'confirm'

/** 一步的完整记录：UI 用它渲染步骤流，任务页用它做回放 */
export interface AgentStep {
  index: number
  plan: string
  thought: string
  action: Action
  status: StepStatus
  /** 执行结果或失败原因。**面向模型**，渲染层不要直接展示 */
  result?: string
  /** 失败分类。界面据此选文案，比解析 result 可靠 */
  failure?: ActionFailure
  /** 人话描述，例：点击「加入购物车」 */
  label: string
  at: number
  durationMs?: number
}

export type AgentEvent =
  | { type: 'started'; taskId: string; at: number }
  | { type: 'plan'; plan: string[] }
  | { type: 'thinking'; index: number }
  | { type: 'step'; step: AgentStep }
  | { type: 'need-confirm'; reason: string; action: Action; stepIndex: number }
  | { type: 'done'; summary: string; data?: unknown; steps: AgentStep[]; tokens: number }
  | { type: 'error'; message: string }
  | { type: 'stopped' }

export interface RunRequest {
  profileId: string
  /** 不传则用该窗口的活跃标签页 */
  tabId?: string
  intent: string
}
