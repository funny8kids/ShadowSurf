/**
 * 快照采集的 Node 侧封装。
 *
 * 职责边界：
 * - 本文件只负责「把页面脚本跑起来」和「把结果校验成 PageSnapshot」；
 * - 真正的采集逻辑全在 page-agent.ts 注入的页面脚本里；
 * - 任何异常都降级成最小快照，**绝不向上抛**，否则 Agent 循环会卡死在这一步。
 *
 * 执行上下文：页面脚本跑在 isolated world（worldName = shadow-agent）里。
 * isolated world 与主世界共享 DOM、但不共享 JS 全局，所以页面脚本既拿得到真实
 * DOM，页面脚本又看不到、也改不了 __SS__ 和元素编号。代价是**所有碰 __SS__ 的
 * Runtime.evaluate 都必须带 contextId** —— 不带就会落到主世界，直接
 * "__SS__ is not defined"。这个上下文由本文件统一管理，actions.ts 复用
 * runInAgentWorld()。
 */
import type { CdpBridge } from '@main/core/cdp'
import type { PageSnapshot, SnapshotElement } from '@shared/protocol'
import { PAGE_AGENT_SOURCE } from '@main/agent/page-agent'

export interface SnapshotOptions {
  maxElements?: number
  maxText?: number
}

/** isolated world 的名字。注入与取上下文必须用同一个名字，否则是两个世界 */
const WORLD_NAME = 'shadow-agent'

/** 默认元素上限：140 条大约 1.2k token，再多就挤掉正文了 */
const DEFAULT_MAX_ELEMENTS = 140
/** 默认正文上限：6000 字，够模型理解页面，又不至于吃掉整个上下文 */
const DEFAULT_MAX_TEXT = 6000

/** CDP Runtime.evaluate 的返回形状（只声明用到的字段，避免 any） */
interface CdpEvalResponse {
  result?: { value?: unknown; description?: string; type?: string }
  exceptionDetails?: { text?: string; exception?: { description?: string } }
}

/** Page.getFrameTree 只用到主框架 id */
interface CdpFrameTreeResponse {
  frameTree?: { frame?: { id?: string } }
}

/** Page.createIsolatedWorld 只用到上下文 id */
interface CdpIsolatedWorldResponse {
  executionContextId?: number
}

/**
 * 一个 bridge 上主框架的 isolated world。
 *
 * Chromium 里 isolated world 按「帧 + 名字」做键，同一帧同名只会有一个实例，
 * 所以每个 bridge 缓存一条 { frameId, contextId } 就等价于「按 frameId 缓存」，
 * 同时省掉每次求值都发一次 Page.getFrameTree 的往返。只关心主框架：Agent 只操作
 * 主框架，子框架的导航不该让主框架的缓存失效（清了也只是多建一次世界）。
 */
interface AgentWorld {
  frameId: string
  contextId: number
}

const worlds = new WeakMap<CdpBridge, AgentWorld>()
const watched = new WeakSet<CdpBridge>()

/** 探针只看 isolated world 的全局有没有 __SS__，用 typeof 避免 ReferenceError */
const ALIVE_EXPR = "typeof __SS__ !== 'undefined' && __SS__ !== null"

/** 降级用：只取标题 + 正文，够模型判断「现在在哪、大致有什么」 */
const MINIMAL_EXPR =
  '(function(){var d=document;var b=d.body;var t=b&&typeof b.innerText==="string"?b.innerText:"";' +
  'return{url:String(location.href||""),title:String(d.title||""),text:String(t||"").slice(0,6000)}})()'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * 在页面上下文求值。
 * userGesture=true 让 click() 之类的调用带上用户激活，减少被页面拦掉的概率。
 * 传了 contextId 就在那个 isolated world 里求值，不传则落在主世界。
 */
async function evaluate(
  cdp: CdpBridge,
  expression: string,
  contextId?: number
): Promise<unknown> {
  const params: Record<string, unknown> = {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  }
  if (contextId !== undefined) {
    params.contextId = contextId
  }
  const res = await cdp.send<CdpEvalResponse>('Runtime.evaluate', params)
  if (res.exceptionDetails) {
    const detail =
      res.exceptionDetails.exception?.description ??
      res.exceptionDetails.text ??
      '页面脚本执行失败'
    throw new Error(detail)
  }
  return res.result?.value
}

/**
 * 上下文会随导航一起销毁，缓存必须跟着失效。
 *
 * 这里只做「尽量早失效」：Page.frameNavigated 需要 Page domain 已 enable
 * （建标签页时 windows.ts 会发），Runtime.executionContextsCleared 需要 Runtime
 * domain 已 enable（没发过，收不到）。两个事件都收不到也不影响正确性 ——
 * runInAgentWorld() 遇到上下文失效的报错还会重建并重试一次。
 */
function watchContext(cdp: CdpBridge): void {
  if (watched.has(cdp)) {
    return
  }
  watched.add(cdp)
  const forget = (): void => {
    worlds.delete(cdp)
  }
  cdp.on('Page.frameNavigated', forget)
  cdp.on('Runtime.executionContextsCleared', forget)
}

/** 新建（或取到已存在的）isolated world，并记住它的上下文 id */
async function createWorld(cdp: CdpBridge): Promise<AgentWorld> {
  const tree = await cdp.send<CdpFrameTreeResponse>('Page.getFrameTree')
  const frameId = tree.frameTree?.frame?.id
  if (!frameId) {
    throw new Error('无法获取主框架 id，页面可能还没加载')
  }
  const created = await cdp.send<CdpIsolatedWorldResponse>('Page.createIsolatedWorld', {
    frameId,
    worldName: WORLD_NAME,
    grantUniveralAccess: false
  })
  const contextId = created.executionContextId
  if (typeof contextId !== 'number') {
    throw new Error('Page.createIsolatedWorld 未返回 executionContextId')
  }
  const world: AgentWorld = { frameId, contextId }
  worlds.set(cdp, world)
  return world
}

async function worldOf(cdp: CdpBridge): Promise<AgentWorld> {
  const cached = worlds.get(cdp)
  return cached ?? (await createWorld(cdp))
}

/** 上下文随导航死掉时 CDP 的两种典型报错 */
function isContextGone(detail: string): boolean {
  return (
    detail.includes('Cannot find context') ||
    detail.includes('Cannot find default execution context') ||
    detail.includes('Execution context was destroyed')
  )
}

/**
 * 在 isolated world 里求值。上下文失效时清缓存重建，并**只重试一次** ——
 * 重试一次是为了把「刚好在导航」的瞬时错误吃掉，又不至于在持续失败时打转。
 */
export async function runInAgentWorld(cdp: CdpBridge, expression: string): Promise<unknown> {
  watchContext(cdp)
  const world = await worldOf(cdp)
  try {
    return await evaluate(cdp, expression, world.contextId)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    if (!isContextGone(detail)) {
      throw err
    }
    worlds.delete(cdp)
    const fresh = await worldOf(cdp)
    return await evaluate(cdp, expression, fresh.contextId)
  }
}

async function isAgentAlive(cdp: CdpBridge): Promise<boolean> {
  try {
    return (await runInAgentWorld(cdp, ALIVE_EXPR)) === true
  } catch {
    return false
  }
}

/**
 * 确保页面脚本在位。
 * 先探 isolated world 里的 __SS__；不在则注册「每次导航后自动注入」，再对当前
 * 文档补一次 —— 注册只对**新文档**生效，已经加载完的页面必须补注入。
 */
export async function ensureInjected(cdp: CdpBridge): Promise<void> {
  if (await isAgentAlive(cdp)) {
    return
  }
  // worldName 是关键：没有它脚本还是注入主世界，页面照样看得见 __SS__
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: PAGE_AGENT_SOURCE,
    worldName: WORLD_NAME
  })
  try {
    await runInAgentWorld(cdp, PAGE_AGENT_SOURCE)
  } catch {
    // 当前上下文可能是 about:blank 或还没 document，等下次导航后自动注入即可
  }
  if (!(await isAgentAlive(cdp))) {
    throw new Error('页面脚本注入失败：__SS__ 未就绪')
  }
}

function toElement(raw: unknown): SnapshotElement | null {
  if (!isRecord(raw)) {
    return null
  }
  const id = str(raw.id)
  if (!id) {
    return null
  }
  const box: Record<string, unknown> = isRecord(raw.box) ? raw.box : {}
  const el: SnapshotElement = {
    id,
    tag: str(raw.tag, 'div'),
    role: str(raw.role, 'other'),
    name: str(raw.name),
    disabled: raw.disabled === true,
    inViewport: raw.inViewport === true,
    box: {
      x: num(box.x),
      y: num(box.y),
      w: num(box.w),
      h: num(box.h)
    }
  }
  const type = str(raw.type)
  if (type) {
    el.type = type
  }
  const value = str(raw.value)
  if (value) {
    el.value = value
  }
  return el
}

/** 页面脚本的返回是 untrusted 的，逐字段校验，形状不对就当失败走降级 */
function toSnapshot(raw: unknown): PageSnapshot | null {
  if (!isRecord(raw) || !Array.isArray(raw.elements)) {
    return null
  }
  const viewport: Record<string, unknown> = isRecord(raw.viewport) ? raw.viewport : {}
  const scroll: Record<string, unknown> = isRecord(raw.scroll) ? raw.scroll : {}
  const elements: SnapshotElement[] = []
  // Array.isArray 收窄后是 any[]，显式落到 unknown[] 避免 any 扩散
  const rawElements: unknown[] = raw.elements
  for (const item of rawElements) {
    const el = toElement(item)
    if (el) {
      elements.push(el)
    }
  }
  return {
    url: str(raw.url),
    title: str(raw.title),
    viewport: {
      width: num(viewport.width),
      height: num(viewport.height)
    },
    scroll: {
      y: num(scroll.y),
      maxY: num(scroll.maxY)
    },
    text: str(raw.text),
    elements,
    capturedAt: Date.now(),
    truncated: raw.truncated === true
  }
}

/**
 * 降级快照：连页面脚本都跑不起来时，至少把正文交给模型。
 * 故意**不带 contextId**（走主世界）：它只读 DOM、不碰 __SS__，而 isolated world
 * 本身建不出来时这条路径还要能活。
 */
async function minimalSnapshot(cdp: CdpBridge): Promise<PageSnapshot> {
  const base: PageSnapshot = {
    url: '',
    title: '',
    viewport: { width: 0, height: 0 },
    scroll: { y: 0, maxY: 0 },
    text: '',
    elements: [],
    capturedAt: Date.now(),
    truncated: false
  }
  try {
    const raw = await evaluate(cdp, MINIMAL_EXPR)
    if (!isRecord(raw)) {
      return base
    }
    return {
      ...base,
      url: str(raw.url),
      title: str(raw.title),
      text: str(raw.text)
    }
  } catch {
    return base
  }
}

/**
 * 采集一帧快照。
 * 顺序：跑页面脚本 → 校验 → 失败则降级。永不抛错。
 */
export async function captureSnapshot(
  cdp: CdpBridge,
  opts: SnapshotOptions = {}
): Promise<PageSnapshot> {
  const args = {
    max: opts.maxElements ?? DEFAULT_MAX_ELEMENTS,
    maxText: opts.maxText ?? DEFAULT_MAX_TEXT
  }
  const expression =
    'window.__SS__ && window.__SS__.snapshot ? window.__SS__.snapshot(' +
    JSON.stringify(args) +
    ') : null'

  try {
    // 这里的 window 指的是 isolated world 的全局，页面主世界看不到同一个 __SS__
    let raw = await runInAgentWorld(cdp, expression)
    if (!isRecord(raw)) {
      // 页面刚导航过、脚本被清掉了：补注入一次再试，避免整轮退化成纯文本
      await ensureInjected(cdp)
      raw = await runInAgentWorld(cdp, expression)
    }
    const snap = toSnapshot(raw)
    if (snap) {
      return snap
    }
  } catch {
    // 落到降级分支，Agent 循环靠这个自愈
  }
  return await minimalSnapshot(cdp)
}
