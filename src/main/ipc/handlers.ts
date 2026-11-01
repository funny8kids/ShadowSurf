/**
 * IPC 接线层。
 *
 * 这里是唯一把「模块」拼成「应用」的地方：
 * - 每个通道都包一层 Result，异常不会穿过进程边界变成 "Error invoking remote method"；
 * - Agent 运行期状态（取消 / 确认）挂在模块级，因为同一时刻只允许一个任务；
 * - 环境状态变化后广播，控制台和浏览器窗口都能实时刷新。
 */

import { BrowserWindow, ipcMain, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { CH } from '@shared/ipc'
import type {
  CloneOptions,
  CreateProfileInput,
  Profile,
  Settings,
  TaskRecord
} from '@shared/types'
import type { AgentEvent, RunRequest } from '@shared/protocol'
import { getStores, collectStoreHealth, dataDir } from '@main/store'
import type { WindowManager } from '@main/core/windows'
import type { ContentInsets } from '@main/core/windows'
import type { ProfileRuntime } from '@main/core/profiles'
import { bridgeFor } from '@main/core/cdp'
import { buildFingerprint } from '@main/core/fingerprint'
import { maskRowOf } from '@main/core/mask-gate'
import { captureSnapshot } from '@main/agent/snapshot'
import { runAgent } from '@main/agent/loop'
import { setConsentAuditSink } from '@main/agent/consent'
import { testConnection } from '@main/agent/llm'
import type { ModuleContext } from '@main/modules/context'
import { registerProxyModule } from '@main/modules/proxy'
import { registerTemplateModule } from '@main/modules/templates'
import { registerScriptModule } from '@main/modules/scripts'
import { registerLocalApiModule } from '@main/modules/localapi'
import { auditConsent, registerAuditModule } from '@main/modules/audit'
import { registerDataModule } from '@main/modules/data'

export interface HandlerContext {
  wm: WindowManager
  runtime: ProfileRuntime
}

/* ────────────────────────────── 工具 ────────────────────────────── */

interface ActiveRun {
  controller: AbortController
}

let activeRun: ActiveRun | null = null

interface ErrorPayload {
  code: string
  message: string
  detail?: string
  /**
   * 少数错误自带**结构化**的补充信息，必须原样过到渲染层。
   *
   * 目前只有一处：`legacy-identity-loss` 需要列出「导入后会变的具体字段」。
   * 不把它塞进 `message` 字符串里，是因为界面要拿它渲染成一个清单 ——
   * 从一段中文里正则抠字段名，是那种「今天能跑、改一次文案就断」的做法。
   *
   * 这里只做透传，不做白名单：加白名单等于每加一种结构化错误就要改这个
   * 文件，而漏改的症状是「字段悄悄消失、界面显示空清单」，不会有人发现。
   */
  lostFields?: string[]
}

function toErrorPayload(err: unknown): ErrorPayload {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code ?? 'E_INTERNAL'
    const payload: ErrorPayload = {
      code,
      message: err.message,
      detail: err.stack?.split('\n').slice(1, 3).join('\n')
    }
    const lost = (err as Error & { lostFields?: unknown }).lostFields
    if (Array.isArray(lost) && lost.every((item) => typeof item === 'string')) {
      payload.lostFields = lost as string[]
    }
    return payload
  }
  return { code: 'E_INTERNAL', message: String(err) }
}

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

/** 统一包装：任何异常都转成 {ok:false,error}，渲染层拿到的是可读消息 */
function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, data: await fn(event, ...args) }
    } catch (err) {
      return { ok: false, error: toErrorPayload(err) }
    }
  })
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/* ────────────────────────────── 注册 ────────────────────────────── */

export function registerHandlers(ctx: HandlerContext): void {
  const stores = getStores()

  /**
   * 把「同意询问的结果」接到审计链上。
   *
   * 挂在这里（组合根）而不是 `consent.ts` 内部直接 import audit：
   * `consent.ts` 必须能在纯 Node 里被探针加载（它是同意的唯一来源，
   * 加载不了就只能靠读代码「证明」闸门有效）。注入之后挂载点仍然只有
   * `requestConsent` 一处 —— loop / script / localapi 三条路径都经过它，
   * 所以「拒签不写审计」这种漏记不可能发生。
   */
  setConsentAuditSink((outcome, req) => auditConsent(stores, outcome, req))

  /* ── 环境 ── */

  const pushProfiles = (): void => {
    broadcast(CH.push.profileState, stores.profiles.list())
  }

  handle(CH.profiles.list, () => stores.profiles.list())

  handle(CH.profiles.get, (_e, id) => {
    const profile = stores.profiles.get(id as string)
    if (!profile) throw new Error(`环境不存在：${String(id)}`)
    return profile
  })

  handle(CH.profiles.create, (_e, input) => {
    const profile = stores.profiles.create((input ?? {}) as CreateProfileInput)
    pushProfiles()
    return profile
  })

  handle(CH.profiles.update, (_e, id, patch) => {
    const profile = stores.profiles.update(id as string, patch as Partial<Profile>)
    pushProfiles()
    return profile
  })

  /**
   * 用盘上的种子算一套指纹给界面预览。**种子不出这个函数。**
   *
   * 只接受 `platform` 一个输入：种子的其他用途（改分辨率、改核数）都必须走
   * `update({ fingerprint })`，那才是可审计的路径。这里做宽了，
   * 就等于给渲染层一个「按任意参数试探指纹」的接口。
   */
  handle(CH.profiles.preview, (_e, id, patch) => {
    const stored = stores.profiles.getStored(String(id))
    if (stored === null) throw new Error(`环境不存在：${String(id)}`)
    const raw = (patch ?? {}) as { platform?: unknown }
    const platform = raw.platform === undefined ? stored.platform : raw.platform
    if (platform !== 'windows' && platform !== 'macos' && platform !== 'linux') {
      throw new Error(`不支持的平台：${String(platform)}`)
    }
    return buildFingerprint(platform, stored.seed)
  })

  handle(CH.profiles.remove, (_e, id) => {
    stores.profiles.remove(id as string)
    pushProfiles()
  })

  /**
   * 伪装闸门豁免的开关。**唯一**入口。
   *
   * 三个入参都过一遍运行时检查，不信渲染层：
   *   `id`           必须是字符串，否则 `getStored` 拿到 undefined 只会报「环境不存在」，
   *                  而真实原因是入参形状错了 —— 那种错误信息会把人带到错的方向。
   *   `enabled`      必须是布尔。`'true'` / `1` 一律拒绝，不做「宽容解析」：
   *                  这个开关的方向是「关掉一道安全闸」，宽容解析在这里没有正当理由。
   *   `confirmName`  只在开启时校验，由 `setExemption` 比对环境名。
   *
   * 失败时抛错而不是返回 `{ok:false}`：这是一个**被拒绝的写操作**，
   * 调用方必须看到它失败，而不是拿到一个「操作完成」的返回值再自己检查。
   */
  handle(CH.profiles.setExemption, (_e, id, enabled, confirmName) => {
    if (typeof id !== 'string' || id === '') throw new Error('环境 id 必须是字符串')
    if (typeof enabled !== 'boolean') {
      throw new Error('enabled 必须是布尔值（收到 ' + typeof enabled + '），不做宽容解析')
    }
    const profile = stores.profiles.setExemption(
      id,
      enabled,
      typeof confirmName === 'string' ? confirmName : ''
    )
    pushProfiles()
    return profile
  })

  handle(CH.profiles.clone, (_e, id, opts) => {
    const profile = stores.profiles.clone(id as string, opts as CloneOptions)
    pushProfiles()
    return profile
  })

  handle(CH.profiles.regenerate, (_e, id) => {
    const profile = stores.profiles.regenerate(id as string)
    pushProfiles()
    return profile
  })

  handle(CH.profiles.launch, async (_e, id) => {
    await ctx.runtime.launch(id as string)
    pushProfiles()
  })

  handle(CH.profiles.stop, async (_e, id) => {
    await ctx.runtime.stop(id as string)
    pushProfiles()
  })

  /* ── 伪装状态 ── */

  /**
   * 环境页每一行状态点的数据源。
   *
   * 走 `wm.listMaskStates()`（枚举）而不是 `maskStateOf()`（单个）：
   * 这里要的是「所有窗口」，而门禁要的是「这一个窗口，查不到就拒绝」。
   * 两个用途本来就不该共用一个方法 —— 门禁拿数组分不清「没窗口」和「编号错」。
   *
   * `maskRowOf` 在 `core/mask-gate.ts` 里，用的是拦 L2 的同一个 `judgeMask`。
   * 这一层不重新判断任何东西。
   */
  handle(CH.mask.list, () => ctx.wm.listMaskStates().map(maskRowOf))

  /* ── 窗口 ── */

  handle(CH.window.open, async (_e, profileId) => {
    await ctx.runtime.launch(profileId as string)
  })

  handle(CH.window.close, async (_e, windowId) => {
    await ctx.wm.close(windowId as string)
  })

  handle(CH.window.newTab, async (_e, windowId, url) => {
    return ctx.wm.newTab(windowId as string, url as string | undefined)
  })

  handle(CH.window.closeTab, async (_e, windowId, tabId) => {
    await ctx.wm.closeTab(windowId as string, tabId as string)
  })

  handle(CH.window.activateTab, async (_e, windowId, tabId) => {
    await ctx.wm.activateTab(windowId as string, tabId as string)
  })

  handle(CH.window.navigate, async (_e, windowId, tabId, url) => {
    await ctx.wm.navigate(windowId as string, tabId as string, url as string)
  })

  handle(CH.window.back, async (_e, windowId, tabId) => {
    await ctx.wm.back(windowId as string, tabId as string)
  })

  handle(CH.window.forward, async (_e, windowId, tabId) => {
    await ctx.wm.forward(windowId as string, tabId as string)
  })

  handle(CH.window.reload, async (_e, windowId, tabId) => {
    await ctx.wm.reload(windowId as string, tabId as string)
  })

  handle(CH.window.stopLoading, async (_e, windowId, tabId) => {
    await ctx.wm.stopLoading(windowId as string, tabId as string)
  })

  // 高频通道：send 而非 invoke，不做回执
  ipcMain.on(CH.window.setContentInsets, (event, raw: ContentInsets) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    const windowId = ctx.wm
      .listWindows()
      .find((state) => ctx.wm.getWindow(state.id)?.win === win)?.id
    if (!windowId) return
    const insets: ContentInsets = {
      top: Math.max(0, Math.round(raw.top)),
      bottom: Math.max(0, Math.round(raw.bottom)),
      left: Math.max(0, Math.round(raw.left)),
      right: Math.max(0, Math.round(raw.right)),
      panelWidth: Math.max(0, Math.round(raw.panelWidth))
    }
    ctx.wm.setContentInsets(windowId, insets)
  })

  /* ── Agent ── */

  handle(CH.agent.run, async (event, raw) => {
    if (activeRun) throw new Error('已有任务在执行，请先停止')

    const req = raw as RunRequest
    const tab = ctx.wm.getTab(req.profileId, req.tabId)
    if (!tab) throw new Error('没有找到可操作的标签页，请先打开该环境')

    const controller = new AbortController()
    const run: ActiveRun = { controller }
    // 锁必须在这里同步落下。原来写在 await cdp.attach() 之后，
    // 两个并发的 agent.run 都能越过上面的检查，各自跑一个循环。
    activeRun = run

    const cdp = bridgeFor(tab.wc)
    try {
      await cdp.attach()
    } catch (err) {
      if (activeRun === run) activeRun = null
      throw err
    }

    const sender = event.sender
    const emit = (payload: AgentEvent): void => {
      if (!sender.isDestroyed()) sender.send(CH.push.agentEvent, payload)
    }

    try {
      const task = await runAgent(
        req,
        {
          // 页面被关掉后返回 null，循环会抛「目标页面已关闭」而不是对着死对象发命令
          getCdp: () => (cdp.attached && !tab.wc.isDestroyed() ? cdp : null),
          settings: stores.settings.get(),
          emit,
          // 把发起方 webContents id 传下去，凭证会绑到这个窗口上。
          // 这里**不再有 askConfirm**：同意只能来自主进程弹出的系统原生窗口，
          // 渲染层回答什么都不影响决策。
          senderId: event.sender.id
        },
        controller.signal
      )

      stores.tasks.add(task)
      broadcast(CH.push.taskUpdate, task)
      return task as TaskRecord
    } finally {
      if (activeRun === run) activeRun = null
    }
  })

  handle(CH.agent.cancel, () => {
    activeRun?.controller.abort()
  })

  /*
   * 这里原本是 `ss:agent:confirm`：读一个 boolean 就当作用户同意。
   *
   * 它有三个独立的毛病，任何一个都足够致命：
   * 1. `_e`（发起方）完全没用 —— 没有 sender 校验，谁调都算；
   * 2. 同意由**调用方声明**，而不是主进程持有的凭证。被 XSS 的渲染层只要
   *    不显示弹窗、直接 invoke 这个通道，一次支付就被批准了；
   * 3. 收参没有类型约束，而它当时是 `settle?.(Boolean(approved))` ——
   *    `Boolean('false') === true`，渲染层送 `'false'` / `'no'` / `'0'`
   *    任一非空字符串，拿到的都是**批准**。JS 里最经典的一类隐式转换，
   *    而它偏偏出现在最该 fail-closed 的那一处。
   *
   * 现在整个通道被删掉了，而不是改成「只能取消」。
   * 一个名字叫 confirm、行为却是取消的通道比没有更危险：下一个人看到
   * `CH.agent.confirm` 会以为它是批准入口，写出依赖它的代码，然后在运行时
   * 才发现「点了没反应」。渲染层的「取消本次任务」本来就走 `agent.cancel()`，
   * 删掉这个通道不破任何东西。
   *
   * 批准的唯一入口是 `requestConsent` 弹出的系统原生窗口 —— 渲染层只能请求，
   * 不能断言。
   */

  handle(CH.agent.snapshot, async (_e, profileId, tabId) => {
    const tab = ctx.wm.getTab(profileId as string, tabId as string | undefined)
    if (!tab) throw new Error('没有找到可操作的标签页')
    const cdp = bridgeFor(tab.wc)
    await cdp.attach()
    return captureSnapshot(cdp)
  })

  /* ── 任务 ── */

  handle(CH.tasks.list, () => stores.tasks.list())
  handle(CH.tasks.get, (_e, id) => stores.tasks.get(id as string))
  handle(CH.tasks.clear, () => {
    stores.tasks.clear()
  })

  /* ── 设置 ── */

  handle(CH.settings.get, () => stores.settings.get())
  handle(CH.settings.set, (_e, patch) => {
    const next: Settings = stores.settings.set((patch ?? {}) as Partial<Settings>)
    broadcast(CH.push.profileState, stores.profiles.list())
    return next
  })

  handle(CH.settings.test, async (_e, patch) => {
    const merged: Settings = { ...stores.settings.get(), ...((patch ?? {}) as Partial<Settings>) }
    return testConnection(merged)
  })

  /* ── 系统 ── */

  handle(CH.system.info, () => ({
    appVersion: process.env['npm_package_version'] ?? '0.1.0',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform
  }))

  /**
   * 数据健康快照。
   *
   * 这是「备份物证存在但无消费方」的唯一解 —— 没有这条通道的话，`json-file.ts`
   * 写出来的 `.corrupt-*` / `.preupgrade*` 永远没人看，用户只会看到空列表。
   *
   * 刻意做成「每次调用都重新扫盘」而不是缓存：用户可能刚手工改完文件、
   * 刚关掉占用文件的杀软，缓存会让这个面板骗人。
   */
  handle(CH.system.storeHealth, () =>
    collectStoreHealth(dataDir(), [
      stores.profiles.health,
      stores.tasks.health,
      stores.settings.health,
      stores.proxies.health,
      stores.templates.health,
      stores.scripts.health,
      stores.audit.health,
      stores.history.health
    ])
  )

  handle(CH.system.openExternal, async (_e, url) => {
    const target = String(url)
    // 只放行 http(s)，避免 file:// 或自定义协议被当成跳板
    if (!/^https?:\/\//i.test(target)) throw new Error('只允许打开 http/https 链接')
    await shell.openExternal(target)
  })

  /* ── 功能模块 ──
     每个域一个文件，只通过 ModuleContext 拿依赖，
     这样并行开发时谁都不用碰 handlers.ts。 */

  const moduleCtx: ModuleContext = {
    stores,
    wm: ctx.wm,
    runtime: ctx.runtime,
    handle,
    broadcast
  }

  registerProxyModule(moduleCtx)
  registerTemplateModule(moduleCtx)
  registerScriptModule(moduleCtx)
  registerLocalApiModule(moduleCtx)
  registerAuditModule(moduleCtx)
  registerDataModule(moduleCtx)
}
