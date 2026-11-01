/**
 * CDP 桥。
 *
 * 为什么不用 Playwright：本项目只依赖 Chromium 自带协议，Electron 每次大版本升级
 * 都会让 Playwright 的私有补丁失效，而 CDP 是 Chromium 对外的稳定契约。
 *
 * 为什么要自己维护事件订阅：Electron 的 `webContents.debugger` 只会抛 `message` 事件，
 * 它把 `method` 作为第二个参数传进来，并没有 `Page.loadEventFired` 这种具名事件。
 * 所以这里做一层「按 method 分发」的转换，调用方才能按 CDP 语义订阅。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 关于子 target（Worker / OOPIF）：为什么这一层必须携带 sessionId
 * ─────────────────────────────────────────────────────────────────────
 * 实测（Electron 45.2.1，2026-10-31）。当时的一次性探针已随任务结束移除，
 * 结果侧回归由 `npm run verify:anticheat` 的 AC-14（worker）/ AC-21（OOPIF）守住；
 * 但**下面这些协议层细节（sessionId 取值、域可用性、暂停期超时）目前没有自动门禁**，
 * 改动这一层必须重新手工实测，不能只看门禁绿：
 *   - `Target.setAutoAttach { flatten: true }` 在 page session 上可以设成功；
 *   - `Target.attachedToTarget` 会到达，`params.sessionId` 就是子 target 的 session；
 *   - 但**根 session 发出的这条事件，回调第 4 参是空串 `""`**，真 sessionId 在
 *     `params.sessionId` 里；只有子 session 自己发的事件（如
 *     `Inspector.workerScriptLoaded`）第 4 参才是真值。
 * 所以取 sessionId 不能只读第 4 参，也不能写成 `params.sessionId || raw`
 * （空串是 falsy，会把「根 session」误判成子 session）。见 `resolveSessionId`。
 *
 * `sendCommand` 的第三参是 **sessionId**（electron.d.ts:8131
 * `sendCommand(method, commandParams?, sessionId?)`），不是超时。
 * 曾经这里把第三参当 `timeoutMs` 且从未把 sessionId 传下去 —— 结果是命令永远
 * 发给根 session，子 target 拿不到注入，而且**不报错**：实测传一个数字当第三参
 * Electron 会静默忽略。所以下面的签名把 sessionId 放第三、超时放第四，
 * 与 Electron 原生顺序一致，改错位置会立刻在类型上暴露。
 */

import type { WebContents } from 'electron'

const DEFAULT_TIMEOUT = 15_000

export type CdpParams = Record<string, unknown>
/** 第二个参数是「发出这条事件的 session」：根 session 为 ''，子 session 为其 id */
type CdpListener = (params: CdpParams, sessionId: string) => void

/** 按 webContents.id 缓存，保证同一目标只 attach 一次（重复 attach 会抛异常） */
const cache = new Map<number, CdpBridge>()

/** `Runtime.evaluate` 的结果。JS 抛错/语法错是 resolve 带 exceptionDetails，不是 reject。 */
export interface EvalOutcome {
  ok: boolean
  value?: unknown
  /** 失败原因：exceptionDetails 的原文，或 CDP 命令本身的错误 */
  error?: string
}

export class CdpBridge {
  private readonly wc: WebContents
  private readonly listeners = new Map<string, Set<CdpListener>>()
  /** 是否已经挂过 message/detach 监听，避免 attach 复用路径上重复注册 */
  private listening = false
  /**
   * 已登记的 autoAttach 参数。
   *
   * 为什么要在这一层记账：autoAttach 是**协议状态**，随 session 一起消失。
   * detach 之后（打开 DevTools、webContents 重建）只重挂监听是不够的，
   * 必须把 `Target.setAutoAttach` 重发一遍，否则子 target 从此静默不再上报。
   */
  private autoAttachParams: CdpParams | null = null
  /** 防止 attach → 重发 autoAttach → send → attach 的递归 */
  private arming = false

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
      await this.rearmAutoAttach()
      return
    }
    try {
      this.wc.debugger.attach('1.3')
    } catch (err) {
      // 并发 attach 的竞态：另一条路径刚抢到，视为成功
      if (!this.attached) throw wrap('attach', err)
    }
    this.listen()
    await this.rearmAutoAttach()
  }

  detach(): void {
    if (!this.attached) return
    try {
      this.wc.debugger.detach()
    } catch {
      // 已经随目标一起没了，忽略
    }
  }

  /**
   * 打开子 target 自动附着（Worker / OOPIF）。
   *
   * 登记下来而不是只发一次：attach 路径会重放（见 `rearmAutoAttach`）。
   * 注意 `waitForDebuggerOnStart: true` 会把子 target **挂住**，调用方必须在
   * 每条路径上都发 `Runtime.runIfWaitingForDebugger`，否则页面侧 API 会一直悬着
   * —— 实测 `serviceWorker.register()` 在 SW target 被挂住时永不 resolve。
   */
  async setAutoAttach(params: CdpParams): Promise<void> {
    this.autoAttachParams = { ...params }
    this.assertAlive('Target.setAutoAttach')
    if (!this.attached) await this.attach()
    await this.send('Target.setAutoAttach', this.autoAttachParams)
  }

  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs = DEFAULT_TIMEOUT
  ): Promise<T> {
    this.assertAlive(method)
    if (!this.attached) await this.attach()

    let timer: NodeJS.Timeout | undefined
    try {
      const result = await Promise.race([
        // 三参透传：不传 sessionId 时命令发给根 session，与旧行为一致
        sessionId
          ? this.wc.debugger.sendCommand(method, params, sessionId)
          : this.wc.debugger.sendCommand(method, params),
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

  /**
   * `Runtime.evaluate` 的安全封装。
   *
   * 存在的理由：CDP 的 `Runtime.evaluate` 在脚本抛错时**不会 reject**，
   * 而是 resolve 一个带 `exceptionDetails` 的结果。实测（Electron 45.2.1，2026-10-31）：
   *   `throw new Error("boom")`   → ok=true, result.exceptionDetails = {...}
   *   `function (`                → ok=true, result.exceptionDetails = {SyntaxError...}
   * 直接 `await send('Runtime.evaluate', …)` 然后当成成功，会把「注入脚本一行没跑」
   * 记成「注入成功」——这正是本仓库反复出现的假阳性类型。这里统一转成 ok=false。
   */
  async evaluate(expression: string, sessionId?: string, timeoutMs?: number): Promise<EvalOutcome> {
    let raw: { result?: unknown; exceptionDetails?: { text?: string; exception?: { description?: string } } }
    try {
      raw = await this.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
        // 不传就沿用 send 的默认值。service_worker 那条路要短超时：
        // 它的目标可能刚 resume、上下文还没建，命令会挂住；按 15s 等会让
        // 整个事件期注入的竞态彻底输掉（本来就是要赶在 install 之前）。
        timeoutMs ?? DEFAULT_TIMEOUT
      )
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (raw && raw.exceptionDetails) {
      const detail = raw.exceptionDetails
      return {
        ok: false,
        error: detail.exception?.description || detail.text || 'Runtime.evaluate 抛出异常'
      }
    }
    // ── 这里必须拆包 ──
    // `raw.result` 是 CDP 的 **RemoteObject**（`{type, value, description, …}`），
    // 不是值本身。早先这里原样当 `value` 返回，于是调用方写
    // `Number(outcome.value)` 拿到 NaN、`String(outcome.value)` 拿到 "[object Object]"。
    // 后果是实测到的：worker 自检**每一次**都判「不通过」，
    // 而注入明明是成功的 —— 审计里于是留下一条「注入失败」的假记录。
    // 请求里已经带了 `returnByValue: true`，调用方要的必然是值，就在这里拆开。
    const ro = raw?.result as
      | { value?: unknown; unserializableValue?: string; type?: string }
      | undefined
    if (ro === undefined) return { ok: true, value: undefined }
    if (ro.value !== undefined) return { ok: true, value: ro.value }
    // NaN / ±Infinity / -0 不放进 value，走 unserializableValue。
    // 不处理的话它们会变成 undefined，调用方拿到的 NaN 就「消失」了。
    if (typeof ro.unserializableValue === 'string') {
      const u = ro.unserializableValue
      const n =
        u === 'NaN'
          ? NaN
          : u === 'Infinity'
            ? Infinity
            : u === '-Infinity'
              ? -Infinity
              : u === '-0'
                ? -0
                : Number(u)
      return { ok: true, value: n }
    }
    // 剩下的是「要了 by value 但拿不到值」：undefined，或序列化不了的对象。
    return { ok: true, value: undefined }
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

  waitFor(
    event: string,
    predicate?: (p: CdpParams, sessionId: string) => boolean,
    timeoutMs = DEFAULT_TIMEOUT
  ): Promise<CdpParams> {
    return new Promise<CdpParams>((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error(`[cdp] 等待事件 ${event} 超时（${timeoutMs}ms）`))
      }, timeoutMs)

      const off = this.on(event, (params, sessionId) => {
        if (predicate && !predicate(params, sessionId)) return
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

    this.wc.debugger.on('message', (_event, method, params, rawSessionId) => {
      const set = this.listeners.get(method)
      if (!set) return
      const payload = (params ?? {}) as CdpParams
      const sessionId = resolveSessionId(rawSessionId, payload)
      // 逐个 try：某个订阅者抛错不能拖垮其他订阅者
      for (const cb of [...set]) {
        try {
          cb(payload, sessionId)
        } catch (err) {
          console.error(`[cdp] 订阅 ${method} 的处理器抛错`, err)
        }
      }
    })

    this.wc.debugger.on('detach', () => {
      // 保留 listeners，重新 attach 后订阅仍然有效。
      // 但 autoAttach 是协议状态，已经随 session 一起没了 —— 重新 attach 时
      // 由 attach() 里的 rearmAutoAttach() 重发，这里只负责让 attach 路径重新跑。
      this.listening = false
    })
  }

  /** attach 成功后把 autoAttach 重放一遍。失败只记日志：attach 是公共路径，不能被它拖垮。 */
  private async rearmAutoAttach(): Promise<void> {
    if (!this.autoAttachParams || this.arming) return
    this.arming = true
    try {
      await this.send('Target.setAutoAttach', this.autoAttachParams)
    } catch (err) {
      // 不静默：子 target 从此不再上报，指纹只覆盖主世界而没有任何报错是最难查的形态
      console.error('[cdp] 重放 Target.setAutoAttach 失败，Worker/OOPIF 将不再自动附着', err)
    } finally {
      this.arming = false
    }
  }

  private assertAlive(method: string): void {
    if (this.wc.isDestroyed()) {
      throw new Error(`[cdp] webContents 已销毁，无法执行 ${method}`)
    }
  }
}

/**
 * 解析事件属于哪个 session。
 *
 * 两种情况都实测过（Electron 45.2.1，2026-10-31 的事件流）：
 *   - 根 session 的 `Target.attachedToTarget`：第 4 参 `""`，真 sessionId 在 `params.sessionId`
 *   - 子 session 的 `Inspector.workerScriptLoaded`：第 4 参是真值，`params.sessionId` 不存在
 * 必须显式判非空字符串：空串是 falsy，用 `||` 或 `??` 裸接都会把根 session 判错。
 */
function resolveSessionId(raw: unknown, params: CdpParams): string {
  if (typeof raw === 'string' && raw.length > 0) return raw
  const fromParams = params['sessionId']
  if (typeof fromParams === 'string' && fromParams.length > 0) return fromParams
  return ''
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
