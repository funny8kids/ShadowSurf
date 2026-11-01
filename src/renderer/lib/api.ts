/**
 * window.ss 的薄封装。
 *
 * 只做三件事：
 * 1. 把「preload 还没注入」这种情况变成一句人话错误，而不是 undefined 崩栈；
 * 2. 统一错误文案，供 Toast 直接展示；
 * 3. 把网页视图的矩形上报给主进程（setContentInsets）。
 *
 * 注意：这里不缓存业务数据，也不做乐观更新，数据流始终是「调用 → 主进程 → 推送」。
 */

import type { ShadowSurfAPI } from '@shared/ipc'
import type { AgentEvent } from '@shared/protocol'
import type { IpcError, MaskRow, WindowState } from '@shared/types'

/* ────────────────────────────── 桥接 ────────────────────────────── */

export function hasBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.ss !== 'undefined' && window.ss !== null
}

/** 取 preload 注入的 API；未注入时抛一句能读懂的错误 */
export function bridge(): ShadowSurfAPI {
  if (!hasBridge()) {
    throw new Error('主进程尚未就绪：window.ss 未注入')
  }
  return window.ss
}

/** 把 unknown 收敛成一句可展示的文案（优先用主进程给的 IpcError.message） */
export function errorMessage(err: unknown): string {
  if (typeof err === 'string' && err) return err
  if (err && typeof err === 'object') {
    const maybe = err as Partial<IpcError>
    if (typeof maybe.message === 'string' && maybe.message) return maybe.message
    if (typeof maybe.detail === 'string' && maybe.detail) return maybe.detail
  }
  if (err instanceof Error && err.message) return err.message
  return '操作失败，请重试'
}

/* ────────────────────────────── 订阅（缺桥时降级为 noop） ────────────────────────────── */

export function onWindowState(cb: (state: WindowState) => void): () => void {
  if (!hasBridge()) return () => {}
  try {
    return bridge().window.onState(cb)
  } catch {
    return () => {}
  }
}

export function onAgentEvent(cb: (e: AgentEvent) => void): () => void {
  if (!hasBridge()) return () => {}
  try {
    return bridge().agent.onEvent(cb)
  } catch {
    return () => {}
  }
}

/**
 * 伪装状态推送。
 *
 * 拿不到桥时返回 noop 而不是抛错：控制台在没有主进程的预览环境里也要能渲染，
 * 而「没有伪装状态」在界面上显示为灰点，不会误导成「一切正常」。
 */
export function onMaskState(cb: (rows: MaskRow[]) => void): () => void {
  if (!hasBridge()) return () => {}
  try {
    return bridge().mask.onState(cb)
  } catch {
    return () => {}
  }
}

/* ────────────────────────────── 网页视图矩形上报 ────────────────────────────── */

/**
 * 网页内容区在渲染窗口里的矩形。
 *
 * 主进程据此摆放 WebContentsView：top 是「标题条 + 标签条 + 地址栏」的总高，
 * width 已经扣掉了 AI 侧栏，panelWidth 单独给出，便于主进程算分屏比例。
 */
export interface ContentInsets {
  /** false = 当前不在双轨窗口，主进程应隐藏视图 */
  visible: boolean
  top: number
  left: number
  width: number
  height: number
  /** AI 侧栏宽度；未展开为 0 */
  panelWidth: number
  /** 人轨 / 影子轨的宽度占比，0–1 */
  split: number
}

/**
 * 契约里暂时没有 setContentInsets（src/shared/ipc.ts 未声明），
 * 这里做结构化探测：主进程实现了就调用，没实现就安静跳过。
 * 不伪造通道名，也不走 invoke，避免和主进程的真实实现打架。
 */
interface InsetsHost {
  setContentInsets?: (insets: ContentInsets) => void
}

let lastReported = ''
let warnedMissing = false

export function reportContentInsets(insets: ContentInsets): void {
  if (!hasBridge()) return
  const host = window.ss.window as unknown as InsetsHost
  if (typeof host.setContentInsets !== 'function') {
    if (!warnedMissing) {
      warnedMissing = true
      console.warn('[shadowsurf] window.ss.window.setContentInsets 未实现，网页视图将无法定位')
    }
    return
  }
  // 去重：ResizeObserver 会在拖拽时高频触发，重复的矩形没有意义
  const key = `${insets.visible}|${insets.top}|${insets.left}|${insets.width}|${insets.height}|${insets.panelWidth}|${insets.split}`
  if (key === lastReported) return
  lastReported = key
  try {
    host.setContentInsets(insets)
  } catch (err) {
    console.warn('[shadowsurf] setContentInsets 调用失败', errorMessage(err))
  }
}
