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
 * L0 只读 / L1 可逆 / L2 不可逆（必须人工确认）
 * 判定发生在**执行器**，不依赖模型自觉。
 */
export type RiskLevel = 'L0' | 'L1' | 'L2'

export interface RiskVerdict {
  level: RiskLevel
  reason: string
  /** 命中的关键词，用于在确认弹窗里高亮 */
  matched?: string
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
