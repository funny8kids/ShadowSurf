/**
 * 快照采集的 Node 侧封装。
 *
 * 职责边界：
 * - 本文件只负责「把页面脚本跑起来」和「把结果校验成 PageSnapshot」；
 * - 真正的采集逻辑全在 page-agent.ts 注入的页面脚本里；
 * - 任何异常都降级成最小快照，**绝不向上抛**，否则 Agent 循环会卡死在这一步。
 */
import type { CdpBridge } from '@main/core/cdp'
import type { PageSnapshot, SnapshotElement } from '@shared/protocol'
import { PAGE_AGENT_SOURCE } from '@main/agent/page-agent'

export interface SnapshotOptions {
  maxElements?: number
  maxText?: number
}

/** 默认元素上限：140 条大约 1.2k token，再多就挤掉正文了 */
const DEFAULT_MAX_ELEMENTS = 140
/** 默认正文上限：6000 字，够模型理解页面，又不至于吃掉整个上下文 */
const DEFAULT_MAX_TEXT = 6000

/** CDP Runtime.evaluate 的返回形状（只声明用到的字段，避免 any） */
interface CdpEvalResponse {
  result?: { value?: unknown; description?: string; type?: string }
  exceptionDetails?: { text?: string; exception?: { description?: string } }
}

const PING_EXPR =
  '(function(){try{return !!(window.__SS__ && window.__SS__.ping && window.__SS__.ping().ok)}catch(e){return false}})()'

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
 */
async function evaluate(cdp: CdpBridge, expression: string): Promise<unknown> {
  const res = await cdp.send<CdpEvalResponse>('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  })
  if (res.exceptionDetails) {
    const detail =
      res.exceptionDetails.exception?.description ??
      res.exceptionDetails.text ??
      '页面脚本执行失败'
    throw new Error(detail)
  }
  return res.result?.value
}

async function isAgentAlive(cdp: CdpBridge): Promise<boolean> {
  try {
    return (await evaluate(cdp, PING_EXPR)) === true
  } catch {
    return false
  }
}

/**
 * 确保页面脚本在位。
 * 先 ping；不在则注册「每次导航后自动注入」，再对当前上下文补一次。
 */
export async function ensureInjected(cdp: CdpBridge): Promise<void> {
  if (await isAgentAlive(cdp)) {
    return
  }
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_AGENT_SOURCE })
  try {
    await evaluate(cdp, PAGE_AGENT_SOURCE)
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

/** 降级快照：连页面脚本都跑不起来时，至少把正文交给模型 */
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
    let raw = await evaluate(cdp, expression)
    if (!isRecord(raw)) {
      // 页面刚导航过、脚本被清掉了：补注入一次再试，避免整轮退化成纯文本
      await ensureInjected(cdp)
      raw = await evaluate(cdp, expression)
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
