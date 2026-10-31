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
import type { Action, AgentEvent, RunRequest } from '@shared/protocol'
import { getStores } from '@main/store'
import type { WindowManager } from '@main/core/windows'
import type { ContentInsets } from '@main/core/windows'
import type { ProfileRuntime } from '@main/core/profiles'
import { bridgeFor } from '@main/core/cdp'
import { captureSnapshot } from '@main/agent/snapshot'
import { runAgent } from '@main/agent/loop'
import { testConnection } from '@main/agent/llm'
import type { ModuleContext } from '@main/modules/context'
import { registerProxyModule } from '@main/modules/proxy'
import { registerTemplateModule } from '@main/modules/templates'
import { registerScriptModule } from '@main/modules/scripts'
import { registerLocalApiModule } from '@main/modules/localapi'
import { registerAuditModule } from '@main/modules/audit'
import { registerDataModule } from '@main/modules/data'

export interface HandlerContext {
  wm: WindowManager
  runtime: ProfileRuntime
}

/* ────────────────────────────── 工具 ────────────────────────────── */

interface ActiveRun {
  controller: AbortController
  /** 用户点了确认 / 拒绝时调用，用完即清 */
  resolveConfirm: ((approved: boolean) => void) | null
}

let activeRun: ActiveRun | null = null

function toErrorPayload(err: unknown): { code: string; message: string; detail?: string } {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code ?? 'E_INTERNAL'
    return { code, message: err.message, detail: err.stack?.split('\n').slice(1, 3).join('\n') }
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

  handle(CH.profiles.remove, (_e, id) => {
    stores.profiles.remove(id as string)
    pushProfiles()
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
    const run: ActiveRun = { controller, resolveConfirm: null }
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
          askConfirm: (reason: string, action: Action, stepIndex: number) =>
            new Promise<boolean>((resolve) => {
              // 5 分钟无人应答按拒绝处理：宁可少做，不可挂着等
              const timer = setTimeout(() => {
                if (run.resolveConfirm === settle) {
                  run.resolveConfirm = null
                  resolve(false)
                }
              }, 5 * 60 * 1000)
              const settle = (approved: boolean): void => {
                clearTimeout(timer)
                resolve(approved)
              }
              run.resolveConfirm = settle
              // reason/action/stepIndex 已由 loop 通过 need-confirm 事件发给渲染层
              void reason
              void action
              void stepIndex
            })
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

  handle(CH.agent.confirm, (_e, approved) => {
    const run = activeRun
    if (!run) return
    const settle = run.resolveConfirm
    run.resolveConfirm = null
    settle?.(Boolean(approved))
  })

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
