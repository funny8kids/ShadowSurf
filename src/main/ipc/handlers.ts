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
  TaskRecord,
  TeamState
} from '@shared/types'
import type { AgentEvent, RunRequest } from '@shared/protocol'
import { getStores, collectStoreHealth, dataDir, healthRefs, CollectionStore } from '@main/store'
import type { WindowManager } from '@main/core/windows'
import type { ContentInsets } from '@main/core/windows'
import type { ProfileRuntime } from '@main/core/profiles'
import { clearProfileData, partitionFor } from '@main/core/session'
import { bridgeFor } from '@main/core/cdp'
import { buildFingerprint } from '@main/core/fingerprint'
import { maskRowOf } from '@main/core/mask-gate'
import { applyThemeMode } from '@main/core/theme'
import { captureSnapshot } from '@main/agent/snapshot'
import { runAgent } from '@main/agent/loop'
import { setConsentAuditSink } from '@main/agent/consent'
import { testConnection } from '@main/agent/llm'
import type { ModuleContext } from '@main/modules/context'
import { registerProxyModule } from '@main/modules/proxy'
import { registerGeoMatchModule } from '@main/modules/geo-match'
import { registerTemplateModule } from '@main/modules/templates'
import { registerScriptModule } from '@main/modules/scripts'
import { registerLocalApiModule } from '@main/modules/localapi'
import { appendAudit, auditConsent, registerAuditModule } from '@main/modules/audit'
import { registerDataModule } from '@main/modules/data'
import { registerTeamModule } from '@main/modules/team'
import { actorCanUse, assertActorCanManage } from '@main/modules/team-policy'
import { registerTrashModule } from '@main/modules/trash'
import { registerExtensionsModule } from '@main/modules/extensions'
import { registerWarmupModule } from '@main/modules/warmup'
import { registerSchedulerModule, startScheduler } from '@main/modules/scheduler'
import { registerProxyGroupsModule } from '@main/modules/proxy-groups'
import { emitWebhook, registerWebhooksModule } from '@main/modules/webhooks'

export interface HandlerContext {
  wm: WindowManager
  runtime: ProfileRuntime
}

/* ────────────────────────────── 工具 ────────────────────────────── */

interface ActiveRun {
  controller: AbortController
  /** 任务 id：取消时能报出「停掉的是哪一个任务」 */
  taskId: string
  profileId: string
}

/**
 * 进行中的任务，**按环境分槽**。
 *
 * 原先是一个全局单例 `activeRun`：整个 App 同时只允许一个任务。
 * 后果是：环境 A 跑着一个卡在确认框的任务（最多等 120 秒）时，
 * 环境 B 里输入指令只得到一句「已有任务在执行，请先停止」，
 * 而且 B 窗口里的「暂停」按钮是灰的 —— B 里**没有任何按钮**能停掉 A 的任务，
 * 只能切回 A 窗口自己找。多环境并行时这条路完全堵死。
 *
 * 分槽之后：同一环境仍然串行（同一个标签页上两个 Agent 会互相踩），
 * 不同环境可以并行；「取消」按环境走，任何窗口都能停掉**自己**那个环境的任务。
 */
const activeRuns = new Map<string, ActiveRun>()

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

  /**
   * 团队 ACL 的读取器。
   *
   * 「当前操作者」来自 `Settings.activeMemberId`（空 = 本机所有者）。
   * 只有显式切成 member / viewer 时才会真正约束 —— 这是本机多角色，
   * 不是登录体系（没有密码 / 会话 / 云端）。
   */
  const teamState = (): TeamState => ({
    // initialized 恒为 true：能走到 handler 说明 store 已就绪（ensureSeeded 在 team 模块内做过）
    initialized: true,
    members: stores.members.list(),
    shares: stores.shares.list(),
    activity: stores.activity.list()
  })

  const activeMemberId = (): string | undefined => stores.settings.get().activeMemberId

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
    // 改环境 = 管理动作：成员必须拿到该环境的 manage 授权
    assertActorCanManage(teamState(), activeMemberId(), String(id))
    const profile = stores.profiles.update(id as string, patch as Partial<Profile>)
    pushProfiles()
    return profile
  })

  /**
   * 批量更新。
   *
   * 渲染层的批量操作（改分组 / 换代理 / 打标签）原来靠 N 次 `update`，
   * 每次全量重写 profiles.json —— 主进程被同步写阻塞，界面卡住。
   * 这里走 `updateMany`（一次读-改-写），并只广播一次状态。
   */
  handle(CH.profiles.batchUpdate, (_event, rawIds, patch) => {
    if (!Array.isArray(rawIds)) throw new Error('参数「ids」必须是字符串数组')
    const ids = rawIds.map((v) => String(v))
    if (ids.length === 0) return 0
    const actor = activeMemberId()
    for (const id of ids) {
      assertActorCanManage(teamState(), actor, id)
    }
    const changed = stores.profiles.updateMany(ids, patch as Partial<Profile>)
    pushProfiles()
    appendAudit(
      stores,
      '环境·批量修改',
      `${String(ids.length)} 个环境`,
      `命中 ${String(changed)} 个`,
      actor || 'owner'
    )
    return changed
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

  /**
   * 删除环境：**记录与分区一起删**，否则「删除」只删了一半。
   *
   * `persist:ss_<id>` 分区里存着 Cookie / localStorage / IndexedDB / Service Worker /
   * Cache Storage。只删 profiles.json 里的记录，等于用户以为身份没了，而站点手里
   * 还留着一份可用的登录态、盘上还留着一个再也没人认领的目录 —— 这是隐私泄漏。
   *
   * ── 顺序：stop → remove → clear（先停、再删记录、最后尽力清理）──
   * 1. `stop`：窗口打开时会占着分区的 Cache / LevelDB 文件，Windows 上尤其明显；
   *    先停掉才可能清干净（不在运行时 `ProfileRuntime.stop` 是安全 no-op）。
   * 2. `remove`：记录是「这个环境存在」的唯一真相源。先删记录，从用户视角删除
   *    已经成功；后面的清理只是收尾，不能再把一次成功的删除变成失败。
   * 3. `clear`：**尽力而为**。失败只 warn + 写审计，不让删除失败。
   *
   * ── 权衡 ──
   * 残留分区是隐私问题，但「环境删不掉、每次点都报错」更糟：用户会反复重试，
   * 留下更多半清理状态，而记录仍在、环境看起来还在。选「删除成功 + 审计留痕」，
   * 是因为它符合用户点下删除时的意图，也能让人事后查到哪个分区没清干净。
   *
   * 反过来的顺序（先清再删记录）在「清理成功、删记录失败」时最坏：数据没了、
   * 环境还在，用户点开发现所有登录态消失，比残留更难解释。
   */
  handle(CH.profiles.remove, async (_e, id) => {
    const profileId = id as string
    const name = stores.profiles.get(profileId)?.name ?? profileId
    // 删除 = 管理动作
    assertActorCanManage(teamState(), activeMemberId(), profileId)

    // 软删除：只停运行时 + 打 deletedAt，**不清分区**。
    // 清分区挪到「回收站 → 彻底删除」那一步（trash.purge），
    // 否则误删就真的没救了 —— 恢复后拿不到任何登录态等于没恢复。
    await ctx.runtime.stop(profileId)
    stores.profiles.softRemove(profileId)
    pushProfiles()

    try {
      appendAudit(stores, '环境·移入回收站', `环境 ${name}（${profileId}）`, '可在回收站恢复', activeMemberId() || 'owner')
    } catch (err) {
      // 审计失败不阻断删除：记录状态已经落盘，回收站里能找回
      console.error('[profiles] 写入回收站审计失败', err)
    }
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
    assertActorCanManage(teamState(), activeMemberId(), String(id))
    const profile = stores.profiles.clone(id as string, opts as CloneOptions)
    pushProfiles()
    return profile
  })

  handle(CH.profiles.regenerate, (_e, id) => {
    assertActorCanManage(teamState(), activeMemberId(), String(id))
    const profile = stores.profiles.regenerate(id as string)
    pushProfiles()
    return profile
  })

  handle(CH.profiles.launch, async (_e, id) => {
    if (!actorCanUse(teamState(), activeMemberId(), String(id))) {
      throw new Error('当前成员无权使用这个环境；需要在成员页获得「使用」授权')
    }
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

  /**
   * 注入失败台账。
   *
   * 直接把 `InjectionIssue` 原样返回，不裁剪：它的 `reason` 已经是人写的一句话
   * （带上 CDP 的原始错误），不是页面内容；而 `webContentsId` / `sessionId`
   * 对排查是必要信息。渲染层显示时自己截断 —— 那里才知道一行能放多少字。
   */
  handle(CH.injection.list, () => ctx.wm.listInjectionIssues())

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

  handle(CH.window.reopenClosedTab, async (_e, windowId) => {
    return ctx.wm.reopenClosedTab(windowId as string)
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
      panelWidth: Math.max(0, Math.round(raw.panelWidth)),
      // visible / split 必须原样过桥：这两个是「离开双轨窗口」与「分屏比例」的
      // 唯一来源，在这里丢掉就等于渲染层永远无法隐藏网页视图。
      visible: raw.visible !== false,
      split: typeof raw.split === 'number' ? raw.split : undefined
    }
    ctx.wm.setContentInsets(windowId, insets)
  })

  /* ── Agent ── */

  handle(CH.agent.run, async (event, raw) => {
    const req = raw as RunRequest
    // 按环境查占用，而不是全局查：不同环境可以并行跑任务
    const existing = activeRuns.get(req.profileId)
    if (existing) {
      throw new Error(
        `该环境已有任务在执行（任务 ${existing.taskId}），请先停止它再发起新任务`
      )
    }

    const tab = ctx.wm.getTab(req.profileId, req.tabId)
    if (!tab) throw new Error('没有找到可操作的标签页，请先打开该环境')

    // 点亮网页视图：影子轨起点是 about:blank，Agent 先做快照 / 执行脚本时未必
    // 发生导航，不点亮的话用户看到的还是占位图，会以为影子没在工作。
    ctx.wm.revealTab(req.profileId, req.tabId)

    const controller = new AbortController()
    // 锁必须在这里同步落下。原来写在 await cdp.attach() 之后，
    // 两个并发的 agent.run 都能越过上面的检查，各自跑一个循环。
    const taskId = CollectionStore.newId('tsk')
    const run: ActiveRun = { controller, taskId, profileId: req.profileId }
    activeRuns.set(req.profileId, run)

    /**
     * 任务记录**先落一条 running 的**，而不是等跑完再落。
     *
     * 原来的写法是 `runAgent` 返回之后才 `stores.tasks.add(task)`。后果有两个：
     * 1. 任务跑到一半，控制台的「任务」页是空的，环境卡片上没有进度 ——
     *    用户只能盯着右侧那条窄影子面板，以为程序卡死了；
     * 2. 任务跑到一半进程被杀 / 断电，历史里**一条记录都没有** ——
     *    恰恰是最该留痕的那种情况。
     *
     * 这里先落一条 running 的记录，每一步再更新它。
     */
    const live: TaskRecord = {
      id: taskId,
      profileId: req.profileId,
      intent: req.intent,
      status: 'running',
      plan: [],
      steps: [],
      summary: '',
      startedAt: Date.now(),
      finishedAt: null,
      tokens: 0
    }
    stores.tasks.add(live)
    broadcast(CH.push.taskUpdate, live)

    const cdp = bridgeFor(tab.wc)
    try {
      await cdp.attach()
    } catch (err) {
      if (activeRuns.get(req.profileId) === run) activeRuns.delete(req.profileId)
      // 页面连不上：把刚落的 running 记录改成失败，别留一条永远"运行中"的
      stores.tasks.update(taskId, { status: 'failed', finishedAt: Date.now() })
      broadcast(CH.push.taskUpdate, stores.tasks.get(taskId))
      throw err
    }

    const sender = event.sender
    const emit = (payload: AgentEvent): void => {
      if (!sender.isDestroyed()) sender.send(CH.push.agentEvent, payload)
      // 同步到任务记录：控制台的任务页与环境卡片要能看到**实时**进度，
      // 而不是等任务结束才突然出现一行。
      if (payload.type === 'step') {
        const steps = live.steps.filter((s) => s.index !== payload.step.index)
        steps.push(payload.step)
        steps.sort((a, b) => a.index - b.index)
        live.steps = steps
        stores.tasks.update(taskId, { steps })
        broadcast(CH.push.taskUpdate, { ...live })
      } else if (payload.type === 'plan') {
        live.plan = payload.plan
        stores.tasks.update(taskId, { plan: payload.plan })
        broadcast(CH.push.taskUpdate, { ...live })
      }
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
          senderId: event.sender.id,
          // 伪装闸门查的是**标签页**自己的 webContents 状态，而不是发起方渲染进程。
          // `senderId` 是控制台窗口的 renderer，与它下面任何标签页的 wc 编号都属于
          // 不同编号空间；拿它去查伪装状态永远是 null，L2 会被永久拦下。
          // `tab` 就是本次要操作的标签页，它的 `wc.id` 正是 `WindowManager.maskStates` 的键。
          maskWebContentsId: tab.wc.id
        },
        controller.signal
      )

      // 用最终结果覆盖那条 running 记录（**同一个 id**）：
      // 任务在跑的时候用户已经能在任务页看到它了，
      // 不能结束时又冒出第二条记录。
      stores.tasks.update(taskId, {
        ...task,
        id: taskId,
        status: task.status,
        finishedAt: task.finishedAt ?? Date.now()
      })
      broadcast(CH.push.taskUpdate, stores.tasks.get(taskId))
      // 任务结束回调：投递失败不会抛回主流程（emitWebhook 内部消化）。
      void emitWebhook(
        stores,
        task.status === 'done' ? 'task.done' : 'task.failed',
        {
          taskId: task.id,
          profileId: task.profileId,
          intent: task.intent,
          status: task.status,
          steps: task.steps.length,
          tokens: task.tokens
        }
      )
      return task as TaskRecord
    } finally {
      if (activeRuns.get(req.profileId) === run) activeRuns.delete(req.profileId)
      // 任务结束（或被中止）时确保记录不是"运行中"：
      // 异常路径（页面关闭、模型报错）也要把状态落下来，
      // 否则任务页会永远挂着一个转圈的"运行中"。
      const left = stores.tasks.get(taskId)
      if (left !== null && left.status === 'running') {
        stores.tasks.update(taskId, { status: 'failed', finishedAt: Date.now() })
        broadcast(CH.push.taskUpdate, stores.tasks.get(taskId))
      }
    }
  })

  /**
   * 取消任务。
   *
   * 带 profileId 就只停**那个环境**的（每个环境窗口停自己那个，互不误杀）；
   * 不带就全停。
   */
  handle(CH.agent.cancel, (_e, profileId) => {
    const pid = typeof profileId === 'string' ? profileId : ''
    if (pid !== '') {
      activeRuns.get(pid)?.controller.abort()
      return
    }
    for (const run of activeRuns.values()) run.controller.abort()
  })

  /**
   * 当前正在跑的任务。
   *
   * 为什么需要这条通道：任务状态以前只走事件流（`onAgentEvent`），
   * 渲染层一重载（Ctrl+R / 渲染进程崩了 / 关掉环境窗口再打开），
   * 事件流就断了 —— 面板回到"还没开始"的欢迎页，
   * 而主进程里的任务**还在跑、还在烧 token**（用户以为已经停了）。
   *
   * 有了这条通道，面板挂载时先拉一次当前状态，再订阅事件。
   */
  handle(CH.agent.status, (_e, profileId) => {
    const pid = typeof profileId === 'string' ? profileId : ''
    if (pid !== '') {
      const run = activeRuns.get(pid)
      return run === undefined ? null : stores.tasks.get(run.taskId)
    }
    return stores.tasks.listSummary().filter((t) => t.status === 'running')
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
    const prev = stores.settings.get()
    const next: Settings = stores.settings.set((patch ?? {}) as Partial<Settings>)
    // 主题变化要落到 nativeTheme 上，否则只有发起改动的那个窗口知道
    if (next.theme !== prev.theme) applyThemeMode(next.theme)
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
  handle(CH.system.storeHealth, () => collectStoreHealth(dataDir(), healthRefs(stores)))

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
  registerGeoMatchModule(moduleCtx)
  registerTemplateModule(moduleCtx)
  registerScriptModule(moduleCtx)
  registerLocalApiModule(moduleCtx)
  registerAuditModule(moduleCtx)
  registerDataModule(moduleCtx)
  registerTeamModule(moduleCtx)
  registerTrashModule(moduleCtx)
  registerExtensionsModule(moduleCtx)
  registerWarmupModule(moduleCtx)
  registerSchedulerModule(moduleCtx)
  registerProxyGroupsModule(moduleCtx)
  registerWebhooksModule(moduleCtx)
  // 调度器 30s 扫一次；应用关闭即停止（本地单机应用的边界，不冒充系统级 cron）
  startScheduler(moduleCtx)
}
