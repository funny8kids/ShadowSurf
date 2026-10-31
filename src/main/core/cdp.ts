/**
 * CDP 桥。
 *
 * 为什么不用 Playwright：本项目只依赖 Chromium 自带协议，Electron 每次大版本升级
 * 都会让 Playwright 的私有补丁失效，而 CDP 是 Chromium 对外的稳定契约。
 *
 * 为什么要自己维护事件订阅：Electron 的 `webContents.debugger` 只会抛 `message` 事件，
 * 它把 `method` 作为第二个参数传进来，并没有 `Page.loadEventFired` 这种具名事件。
 * 所以这里做一层「按 method 分发」的转换，调用方才能按 CDP 语义订阅。
 */

import type { WebContents } from 'electron'

const DEFAULT_TIMEOUT = 15_000

export type CdpParams = Record<string, unknown>
type CdpListener = (params: CdpParams) => void

/** 按 webContents.id 缓存，保证同一目标只 attach 一次（重复 attach 会抛异常） */
const cache = new Map<number, CdpBridge>()

export class CdpBridge {
  private readonly wc: WebContents
  private readonly listeners = new Map<string, Set<CdpListener>>()
  /** 是否已经挂过 message/detach 监听，避免 attach 复用路径上重复注册 */
  private listening = false

  constructor(wc: WebContents) {
    this.wc = wc
  }

  get attached(): boolean {
    if (this.wc.isDestroyed()) return false
    try {
      return this.wc.debugger.isAttached()
    } catch {
      // 目标正在销毁时 isAttached 也可能抛，等价于未附着
      return false
    }
  }

  async attach(): Promise<void> {
    this.assertAlive('attach')
    if (this.attached) {
      // 别人（比如 DevTools）先 attach 了，复用而不是报错
      this.listen()
      return
    }
    try {
      this.wc.debugger.attach('1.3')
    } catch (err) {
      // 并发 attach 的竞态：另一条路径刚抢到，视为成功
      if (!this.attached) throw wrap('attach', err)
    }
    this.listen()
  }

  detach(): void {
    if (!this.attached) return
    try {
      this.wc.debugger.detach()
    } catch {
      // 已经随目标一起没了，忽略
    }
  }

  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT
  ): Promise<T> {
    this.assertAlive(method)
    if (!this.attached) await this.attach()

    let timer: NodeJS.Timeout | undefined
    try {
      const result = await Promise.race([
        this.wc.debugger.sendCommand(method, params),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`[cdp] ${method} 超时（${timeoutMs}ms）`)),
            timeoutMs
          )
        })
      ])
      return result as T
    } catch (err) {
      throw wrap(method, err)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** 返回取消订阅函数，调用方无需关心底层只有单一 message 事件 */
  on(event: string, cb: CdpListener): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(cb)
    return () => {
      const current = this.listeners.get(event)
      if (!current) return
      current.delete(cb)
      if (current.size === 0) this.listeners.delete(event)
    }
  }

  waitFor(event: string, predicate?: (p: CdpParams) => boolean, timeoutMs = DEFAULT_TIMEOUT): Promise<CdpParams> {
    return new Promise<CdpParams>((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error(`[cdp] 等待事件 ${event} 超时（${timeoutMs}ms）`))
      }, timeoutMs)

      const off = this.on(event, (params) => {
        if (predicate && !predicate(params)) return
        clearTimeout(timer)
        off()
        resolve(params)
      })

      // 目标在等待期间被销毁时立即失败，否则调用方会一直挂到超时
      if (this.wc.isDestroyed()) {
        clearTimeout(timer)
        off()
        reject(new Error(`[cdp] webContents 已销毁，无法等待 ${event}`))
      }
    })
  }

  private listen(): void {
    if (this.listening) return
    this.listening = true

    this.wc.debugger.on('message', (_event, method, params) => {
      const set = this.listeners.get(method)
      if (!set) return
      const payload = (params ?? {}) as CdpParams
      // 逐个 try：某个订阅者抛错不能拖垮其他订阅者
      for (const cb of [...set]) {
        try {
          cb(payload)
        } catch (err) {
          console.error(`[cdp] 订阅 ${method} 的处理器抛错`, err)
        }
      }
    })

    this.wc.debugger.on('detach', () => {
      // 保留 listeners，重新 attach 后订阅仍然有效
      this.listening = false
    })
  }

  private assertAlive(method: string): void {
    if (this.wc.isDestroyed()) {
      throw new Error(`[cdp] webContents 已销毁，无法执行 ${method}`)
    }
  }
}

export function bridgeFor(wc: WebContents): CdpBridge {
  const cached = cache.get(wc.id)
  if (cached) return cached

  const bridge = new CdpBridge(wc)
  cache.set(wc.id, bridge)
  // 目标销毁后立刻清缓存，否则 id 被复用时会拿到已死的 bridge
  wc.once('destroyed', () => {
    cache.delete(wc.id)
  })
  return bridge
}

export function disposeBridge(wcId: number): void {
  const bridge = cache.get(wcId)
  if (!bridge) return
  bridge.detach()
  cache.delete(wcId)
}

function wrap(method: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (message.startsWith('[cdp]')) return err instanceof Error ? err : new Error(message)
  return new Error(`[cdp] ${method} 失败：${message}`)
}
