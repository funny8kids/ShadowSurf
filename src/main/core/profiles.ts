/**
 * 环境运行时：只做「哪些 Profile 正在跑」的记账。
 *
 * 真正的窗口创建在 WindowManager 里，这里刻意不重复实现启动逻辑，
 * 否则「启动」会有两条路径，迟早出现状态不一致（比如 UI 显示 running 但没有窗口）。
 */

import type { WindowManager } from '@main/core/windows'

export class ProfileRuntime {
  private readonly windows: WindowManager
  /** profileId → 该环境当前打开的窗口集合（一个环境可以开多个窗口） */
  private readonly running = new Map<string, Set<string>>()
  /** 正在启动中的请求，用于合并并发 launch，避免同一环境被开两次 */
  private readonly inflight = new Map<string, Promise<string>>()

  constructor(windows: WindowManager) {
    this.windows = windows
  }

  async launch(id: string): Promise<void> {
    const existing = this.running.get(id)
    if (existing && existing.size > 0) {
      // 重复 launch 是「回到这个环境」而不是「再开一个」
      this.focus([...existing][0])
      return
    }

    const pending = this.inflight.get(id)
    if (pending) {
      await pending
      return
    }

    const task = this.windows.open(id)
    this.inflight.set(id, task)
    try {
      const windowId = await task
      const set = this.running.get(id) ?? new Set<string>()
      set.add(windowId)
      this.running.set(id, set)
    } finally {
      this.inflight.delete(id)
    }
  }

  async stop(id: string): Promise<void> {
    const ids = this.running.get(id)
    if (!ids) return
    this.running.delete(id)
    for (const windowId of [...ids]) {
      await this.windows.close(windowId)
    }
  }

  isRunning(id: string): boolean {
    const ids = this.running.get(id)
    return !!ids && ids.size > 0
  }

  runningIds(): string[] {
    return [...this.running.keys()]
  }

  /** WindowManager 在该环境的最后一个窗口关闭时回调，这里只负责落账 */
  markStopped(id: string): void {
    this.running.delete(id)
  }

  private focus(windowId: string): void {
    const found = this.windows.getWindow(windowId)
    if (!found || found.win.isDestroyed()) return
    if (found.win.isMinimized()) found.win.restore()
    found.win.focus()
  }
}
