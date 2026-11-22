/**
 * 环境运行时：只做「哪些 Profile 正在跑」的记账。
 *
 * 真正的窗口创建在 WindowManager 里，这里刻意不重复实现启动逻辑，
 * 否则「启动」会有两条路径，迟早出现状态不一致（比如 UI 显示 running 但没有窗口）。
 */

import type { WindowManager } from '@main/core/windows'

/**
 * 状态写入口。
 *
 * 为什么用注入而不是直接拿 store：core 层不依赖 store（core/store 依赖方向要
 * 保持单向），而且探针（probe-*）会单独加载本文件。
 */
export type ProfileStatusWriter = (
  id: string,
  status: 'starting' | 'running' | 'idle' | 'error',
  error?: string
) => void

export class ProfileRuntime {
  private readonly windows: WindowManager
  /** profileId → 该环境当前打开的窗口集合（一个环境可以开多个窗口） */
  private readonly running = new Map<string, Set<string>>()
  /** 正在启动中的请求，用于合并并发 launch，避免同一环境被开两次 */
  private readonly inflight = new Map<string, Promise<string>>()
  /**
   * 把运行状态写回 Profile.status。
   *
   * 以前这个字段**从来没有被写过** —— 于是 `ProfileCard` 上的「失败」红标恒为
   * false、控制台的「运行中 N / 需要关注 N」两个统计位恒为 0：界面上的这两处
   * 是死代码。这里把状态真正记下来。
   *
   * 写失败不能让启动失败：状态是展示用的派生信息，不是启动的前提。
   */
  private readonly writeStatus: ProfileStatusWriter | undefined

  constructor(windows: WindowManager, writeStatus?: ProfileStatusWriter) {
    this.windows = windows
    this.writeStatus = writeStatus
  }

  private setStatus(id: string, status: 'starting' | 'running' | 'idle' | 'error', error?: string): void {
    if (!this.writeStatus) return
    try {
      this.writeStatus(id, status, error)
    } catch {
      /* 状态写不进去不影响窗口本身 */
    }
  }

  async launch(id: string): Promise<void> {
    const existing = this.running.get(id)
    if (existing && existing.size > 0) {
      // 重复 launch 是「回到这个环境」而不是「再开一个」
      this.focus([...existing][0])
      this.setStatus(id, 'running')
      return
    }

    const pending = this.inflight.get(id)
    if (pending) {
      await pending
      return
    }

    this.setStatus(id, 'starting')
    const task = this.windows.open(id)
    this.inflight.set(id, task)
    try {
      const windowId = await task
      const set = this.running.get(id) ?? new Set<string>()
      set.add(windowId)
      this.running.set(id, set)
      this.setStatus(id, 'running')
    } catch (err) {
      // 启动失败要留下原因：卡片上的「失败」红标与控制台的「需要关注」都靠它。
      this.setStatus(id, 'error', err instanceof Error ? err.message : String(err))
      throw err
    } finally {
      this.inflight.delete(id)
    }
  }

  async stop(id: string): Promise<void> {
    const ids = this.running.get(id)
    // 内存里没有这个环境，也要把状态落回 idle。
    //
    // 什么情况下会这样：盘上残留着 `status:'running'`（上次异常退出），
    // 或窗口被外部关掉时 onProfileStopped 那一跳丢了。
    // 原先这里直接 return，于是用户点「停止」什么都没发生 ——
    // 卡片永远显示"运行中"，而窗口根本不存在，只能重启 App 碰运气。
    //
    // 启动时的归零覆盖了"重启"那条路径；这里是**运行中**的兜底。
    if (!ids) {
      this.setStatus(id, 'idle')
      return
    }
    this.running.delete(id)
    this.setStatus(id, 'idle')
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
    this.setStatus(id, 'idle')
  }

  private focus(windowId: string): void {
    const found = this.windows.getWindow(windowId)
    if (!found || found.win.isDestroyed()) return
    if (found.win.isMinimized()) found.win.restore()
    found.win.focus()
  }
}
