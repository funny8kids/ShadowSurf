/**
 * 双轨窗口管理器。
 *
 * 结构：一个无边框 BrowserWindow 承载渲染层 UI（标签栏 / 地址栏 / AI 侧栏全由 React 画），
 * 网页区域是若干 WebContentsView 叠在 `win.contentView` 上。
 *
 * 为什么内容区矩形要由渲染层告诉主进程：标签栏、地址栏、侧栏的高度是 CSS 决定的，
 * 主进程不知道也不该知道。渲染层在布局变化时通过 setContentInsets 上报，
 * 主进程据此给每个 view 设 bounds——这是唯一不会出现「网页盖住地址栏」的做法。
 */

import { BrowserWindow, WebContentsView, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  BrowserTab,
  InjectionIssue,
  MaskFailure,
  MaskSource,
  MaskState,
  MaskStateRecord,
  Profile,
  StoredProfile,
  TrackKind,
  WindowState
} from '@shared/types'
import { bridgeFor, disposeBridge, type CdpBridge, type CdpParams } from '@main/core/cdp'
import { applyProfileToSession, partitionFor } from '@main/core/session'
import { buildInjectionScript, platformOf, uaMetadata } from '@main/core/fingerprint'

const DEFAULT_URL = 'https://www.bing.com'
/** 影子轨默认落在空白页，等 Agent 自己决定去哪 */
const SHADOW_START_URL = 'about:blank'

/** 影子轨占比。人轨吃剩余宽度，这样侧栏挤压时先牺牲人轨而不是把 Agent 的页面压没 */
const SHADOW_RATIO = 0.43
const DIVIDER = 1
/** 单侧最小可用宽度，低于这个值就退回单轨，否则两栏都没法用 */
const MIN_PANE = 320

/** 状态推送节流窗口：页面加载期事件很密集，不节流会把 IPC 打满 */
const EMIT_INTERVAL = 80

/**
 * 伪装状态。类型定义在 `@shared/types`：渲染层要按它渲染「上次会话回滚过」，
 * 落盘要按它校验，两处都不能从 main 里 import。
 *
 * 为什么不能只放在内存里：重启后内存没了，环境会显示「就绪」而实际是宿主真实身份，
 * 那正是全局禁止的静默降级。落盘由组合根接（`index.ts` 的 `onMaskState`），
 * 写进 `Profile.maskLast`；**但门禁不读落盘值**，理由见 `MaskLastRecord` 的注释。
 */
export type { MaskFailure, MaskSource, MaskState, MaskStateRecord } from '@shared/types'

/**
 * 回滚标记的前缀。注入脚本**只在回滚时**打一行 console.warn，成功时零输出。
 *
 * 为什么要有这个标记：注入脚本失败会整体回滚，页面恢复成「一个干净的普通浏览器」，
 * 与「根本没注入」完全同形，主进程无法区分 —— 不设标记，回滚就变成静默降级。
 *
 * 已知局限（实测，probe-tmp/gstack-2-2/console-message-shape.json）：
 * 页面里 `console.warn = function(){}` 之后，主进程**一条都收不到**（3 条 → 仍 3 条）。
 * 也就是说这条通道是可被页面掐断的。所以它只能当**快速提示**，
 * 权威判据应当是主进程侧的外部测量（见 reportInjectionIssue 的注释与验收口径）。
 */
const MASK_SIGNAL_PREFIX = '[ss-mask]'

/**
 * Worker 注入开关。**已启用**。
 *
 * 曾经停用过一段时间，停用原因是实测出来的崩溃，不是保守：
 * 把 `buildInjectionScript(profile,'worker')` 的产物经 `Runtime.evaluate`
 * 打进**暂停态** worker 后，渲染进程直接崩（`render-process-gone reason=crashed`，
 * 随后 "Render frame was disposed"，整页白屏）。
 *
 * 根因定位（证据在 probe-tmp/gstack-2-2/，可复跑）：脚本里那行
 * `new OffscreenCanvas(1, 1).getContext("webgl")` —— 为了拿到 prototype 而建实例。
 * 三组对照把条件钉死：
 *   · 普通 worker 顶层执行同一行（全程无 CDP）→ 不崩
 *   · 同一会话先 `runIfWaitingForDebugger` 再 evaluate 同一行 → 不崩
 *   · 暂停态只执行这一行、别的什么都不做 → 崩
 * 排除项：不是 evaluate 参数、不是脚本体积、不是改写 `Function.prototype.toString`。
 *
 * 修法：**不建 context**。`WebGLRenderingContext` 是 `[Exposed=(Window,Worker)]`，
 * worker 里直接可取 prototype，建实例纯属多余（见 fingerprint.ts 的 WebGL 段注释）。
 * 修完之后的验收不是「脚本不报错」，而是下面这条 —— 它才是「不建 context 也能伪装」：
 *
 *   让 worker **自己**执行 `new OffscreenCanvas(1,1).getContext("webgl")`，
 *   读 `getParameter(37445)` / `getParameter(37446)`，必须等于 profile 的
 *   `glVendor` / `glRenderer`。这条在 `npm run verify:anticheat` 的 AC-14 里
 *   （WORKER_CORE 的 C 组两项，主世界与 Worker 20 项全等才算过）。
 *
 * 重新关掉的条件：出现 `render-process-gone: crashed` 且能定位到注入。
 * **任何在注入期创建 GL/GPU 资源的代码都会重新触发这个崩溃**，别加回来。
 */
const WORKER_INJECTION_ENABLED = true

/**
 * OOPIF 注入开关。
 *
 * 走的是 `Page.addScriptToEvaluateOnNewDocument`（与页面级同一套机制、在文档创建时
 * 执行，不经过「暂停态 + Runtime.evaluate」），所以没有 Worker 那条崩溃路径。
 * 仍然单独开关：OOPIF 的注入脚本是另一份产物，出问题时要能单独关掉而不影响主世界。
 */
const IFRAME_INJECTION_ENABLED = true

/**
 * service_worker 注入的求值超时。
 *
 * 为什么必须短：这条路径本身就是一个竞态 —— 放行之后顶层立刻跑完，
 * 能抢的只有「第一个事件处理器执行之前」那一小段。默认 15s 的超时在这里
 * 没有意义：真挂住了，15s 后注入也已经太晚，白白把这条路径拖成 15s。
 * 2s 是「肯定已经太晚」的量级，用它当上限，既不会误伤正常的几毫秒，
 * 也不会让一次卡死拖住后面的 target。
 */
const SERVICE_WORKER_EVAL_TIMEOUT = 2_000

export interface TabHandle {
  windowId: string
  tabId: string
  profileId: string
  wc: Electron.WebContents
  view: Electron.WebContentsView
  tab: BrowserTab
}

/**
 * 壳层窗口的导航守卫。**两个壳层窗口（浏览器窗 + 控制台窗）都必须挂**。
 *
 * 为什么必须有：壳层 preload 暴露了完整的 `window.ss`，里面有 migration.import、
 * scripts.save、localApi.start 这些能改本机状态的能力；而壳层 `sandbox: false`。
 * `setWindowOpenHandler` 只拦 window.open / target=_blank，拦不住
 * `location.href = 'https://evil'` 和 `<a target="_self">` —— 一次顶层跳转，
 * 远程页面就拿到了这套 preload API。这不是理论风险，是 Electron 的经典提权路径。
 *
 * 允许的只有渲染层自己：开发态是 ELECTRON_RENDERER_URL，生产态是 file://。
 */
export function guardShellNavigation(win: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const allowed = (url: string): boolean =>
    devUrl ? url.startsWith(devUrl) : url.startsWith('file://')

  const wc = win.webContents

  wc.on('will-navigate', (event, url) => {
    if (allowed(url)) return
    event.preventDefault()
    // 拦下来不等于要静默失败：外链交给系统浏览器，符合浏览器产品的直觉
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })

  // 渲染层里 target=_blank 的链接同样不能开裸 Electron 窗口
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 任何试图在壳层里挂 <webview> 的行为都直接拒绝：网页视图走 WebContentsView
  wc.on('will-attach-webview', (event) => event.preventDefault())
}

export interface ContentInsets {
  top: number
  bottom: number
  left: number
  right: number
  panelWidth: number
}

interface WindowRecord {
  id: string
  win: BrowserWindow
  profileId: string
  profileName: string
  tabs: Map<string, TabHandle>
  /** 每条轨各自记住活跃页，双轨布局要同时展示两条轨的活跃页 */
  activeByTrack: Record<TrackKind, string | null>
  activeTabId: string | null
  insets: ContentInsets
  emitTimer: NodeJS.Timeout | null
  closing: boolean
}

interface WindowManagerOptions {
  /** 必须返回**内部形态**：注入脚本要 seed */
  getProfile: (id: string) => StoredProfile | null
  onState: (state: WindowState) => void
  onProfileStopped: (profileId: string) => void
  /**
   * 指纹注入的失败事实。**不传也不会丢**：同一份事实同时进 `listInjectionIssues()`，
   * 上层可以按需查询；这个回调只是给「需要实时推送」的调用方留的口子。
   *
   * 为什么单独开一条通道而不是并进 onState：onState 是高频节流的状态推送
   * （EMIT_INTERVAL=80ms），把一次性告警混进去会被节流窗口挤掉；
   * 而且注入失败是「这个环境不可信」的定性事实，不该随标签页状态一起被覆盖。
   */
  onInjectionIssue?: (issue: InjectionIssue) => void
  /**
   * 伪装状态变化。`ok` → `rolled-back` / `degraded` 是单向的，不会自己回到 ok：
   * 一旦某个环境被证明没伪装住，它就不可信了，重新开标签页才算新的环境。
   *
   * 与 onInjectionIssue 分开：那条是「某次注入失败」的**事件**，
   * 这条是「这个环境现在是什么状态」的**状态**。渲染层标红、门禁禁 L2 要读后者。
   */
  onMaskState?: (record: MaskStateRecord) => void
}

/**
 * 一条「某个执行环境没能伪装」的事实。
 *
 * 存在的理由：Worker 注入失败时页面侧不降级（页面仍是伪装值、Worker 是宿主值），
 * 这个组合本身就是可被检测的矛盾。如果只 console.warn，上层拿不到，
 * 最终表现就是「AC-14 红但没人知道为什么」。
 *
 * 类型本体在 `shared/types.ts` —— 渲染层要显示它，而两份字符串联合迟早会不一致。
 * 这里只 re-export，让既有 import 路径不变。
 */
export type { InjectionIssue }

/** 渲染层还没上报真实布局前的兜底值，避免第一帧网页盖住标签栏 */
const DEFAULT_INSETS: ContentInsets = { top: 92, bottom: 0, left: 0, right: 0, panelWidth: 0 }

export class WindowManager {
  private readonly windows = new Map<string, WindowRecord>()
  /**
   * 已经注入过指纹的 webContents。
   *
   * 幂等原来靠页面里的 window.__SS_FP__ 全局标记，但那行代码一行就能查到，
   * 等于主动告诉对方「这个页面被改过」。记账放在主进程，页面里不留痕迹。
   */
  private readonly injected = new WeakSet<Electron.WebContents>()
  /**
   * 注入失败台账。
   *
   * 用数组而不是 Map：同一个标签页每新建一个 Worker 都可能失败一次，
   * 合并成一条会把「反复失败」这个信号抹掉。上限 200 条，防止恶意页面
   * 反复 new Worker 把内存打满（失败路径同样会被触发）。
   */
  private readonly injectionIssues: InjectionIssue[] = []
  /**
   * 每个 webContents 当前的伪装状态。
   *
   * 用 Map 而不是 WeakMap：`listMaskStates()` 要给门禁/渲染层枚举，
   * WeakMap 无法枚举。条目随 webContents 销毁清理（见 watchMaskSignal）。
   */
  private readonly maskStates = new Map<number, MaskStateRecord>()
  /**
   * 已经手动附着过的 shared_worker targetId。
   *
   * `Target.setAutoAttach` 不覆盖 shared_worker，只能从 `targetCreated` 里发现再
   * `attachToTarget`。同一个 target 的 `targetCreated` 可能来不止一次，而注入脚本
   * **不幂等**（`_maskOne` 会把已经包过的函数再包一层），重复注入会把函数身份
   * 越包越歪。所以在这里挡一道。
   *
   * 只增不减：targetId 是 Chromium 侧的一次性标识，worker 销毁后不会复用。
   */
  private readonly swAttached = new Set<string>()
  private readonly opts: WindowManagerOptions

  constructor(opts: WindowManagerOptions) {
    this.opts = opts
  }

  /* ────────────────────────────── 窗口 ────────────────────────────── */

  async open(profileId: string, initialUrl?: string): Promise<string> {
    const profile = this.opts.getProfile(profileId)
    if (!profile) throw new Error(`环境不存在：${profileId}`)

    const windowId = `win_${shortId()}`
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: MIN_PANE * 2,
      minHeight: 560,
      frame: false,
      titleBarStyle: 'hidden',
      backgroundColor: '#F6F5F2',
      show: false,
      webPreferences: {
        preload: resolvePreload(),
        contextIsolation: true,
        nodeIntegration: false,
        // 壳层 preload 需要 require electron 模块，不能开 sandbox
        sandbox: false
      }
    })

    // 壳层 preload 能力很宽（迁移/脚本/本地 API），必须堵住顶层导航这条提权路
    guardShellNavigation(win)

    const rec: WindowRecord = {
      id: windowId,
      win,
      profileId,
      profileName: profile.name,
      tabs: new Map(),
      activeByTrack: { human: null, shadow: null },
      activeTabId: null,
      insets: { ...DEFAULT_INSETS },
      emitTimer: null,
      closing: false
    }
    this.windows.set(windowId, rec)

    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show()
    })
    win.on('resize', () => {
      this.layout(rec)
      this.scheduleEmit(windowId)
    })
    win.on('move', () => this.scheduleEmit(windowId))
    win.on('maximize', () => {
      this.layout(rec)
      this.scheduleEmit(windowId)
    })
    win.on('unmaximize', () => {
      this.layout(rec)
      this.scheduleEmit(windowId)
    })
    win.on('closed', () => this.handleClosed(windowId))

    this.loadShell(win, windowId, profileId)

    try {
      // 双轨是产品形态本身：一开窗就给人轨和影子轨各一个页面
      const humanTabId = await this.newTab(windowId, initialUrl ?? DEFAULT_URL, 'human')
      await this.newTab(windowId, SHADOW_START_URL, 'shadow')
      await this.activateTab(windowId, humanTabId)
    } catch (err) {
      // 初始化失败不能留下一个空壳窗口
      await this.close(windowId)
      throw err
    }

    this.emit(windowId)
    return windowId
  }

  async close(windowId: string): Promise<void> {
    const rec = this.windows.get(windowId)
    if (!rec || rec.closing) return
    rec.closing = true

    if (rec.emitTimer) {
      clearTimeout(rec.emitTimer)
      rec.emitTimer = null
    }

    for (const handle of [...rec.tabs.values()]) this.destroyHandle(rec, handle)
    rec.tabs.clear()

    this.windows.delete(windowId)
    if (!rec.win.isDestroyed()) rec.win.destroy()

    // 一个 Profile 可以开多个窗口，只有最后一个关掉才算这个环境停了
    if (!this.hasWindowFor(rec.profileId)) this.opts.onProfileStopped(rec.profileId)
  }

  async closeAll(): Promise<void> {
    for (const windowId of [...this.windows.keys()]) {
      await this.close(windowId)
    }
  }

  /* ────────────────────────────── 标签页 ────────────────────────────── */

  async newTab(windowId: string, url?: string, track: TrackKind = 'human'): Promise<string> {
    const rec = this.require(windowId)
    const profile = this.profileOf(rec)

    const tabId = `tab_${shortId()}`
    const view = new WebContentsView({
      webPreferences: {
        partition: partitionFor(profile.id),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        // 影子轨常常在后台被 Agent 驱动，节流会让定时器和动画卡住
        backgroundThrottling: false
      }
    })
    const wc = view.webContents

    rec.win.contentView.addChildView(view)

    // CDP 的 Page domain 要等 webContents 有过一次导航才可用。
    // 对刚创建、还没加载任何东西的 view 发 Page.enable，命令会一直悬着直到超时，
    // 整个建标签页流程就卡死在这里（窗口只剩一个 0×0 的空视图）。
    // 先落一个本地空白页，几十毫秒，之后注入才有意义。
    await wc.loadURL('about:blank').catch(() => undefined)

    const tab: BrowserTab = {
      id: tabId,
      profileId: profile.id,
      track,
      url: 'about:blank',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      // 影子轨天生由 Agent 驱动，人轨要等 Agent 主动接管才算绑定
      agentBound: track === 'shadow'
    }
    const handle: TabHandle = { windowId, tabId, profileId: profile.id, wc, view, tab }
    rec.tabs.set(tabId, handle)

    this.wire(rec, handle)

    // 顺序不能变：先落到正确的 session（UA/代理），再注入指纹，最后才发第一个请求
    await applyProfileToSession(wc.session, profile)
    await this.injectFingerprint(wc, profile)


    rec.activeByTrack[track] = tabId
    rec.activeTabId = tabId

    // 先布局再加载：首屏可能要十几秒（网络慢 / 目标站被墙 / 走代理），
    // 如果 await 加载完成，窗口会长时间只有一个 0×0 的空白视图，
    // 第二个（影子）标签页也建不出来。
    this.layout(rec)
    this.scheduleEmit(windowId)

    void this.loadUrl(wc, url ?? DEFAULT_URL)
    return tabId
  }

  async closeTab(windowId: string, tabId: string): Promise<void> {
    const rec = this.require(windowId)
    const handle = rec.tabs.get(tabId)
    if (!handle) return

    this.destroyHandle(rec, handle)

    // 最后一个标签关掉就关窗，和普通浏览器一致
    if (rec.tabs.size === 0) {
      await this.close(windowId)
      return
    }

    this.layout(rec)
    this.scheduleEmit(windowId)
  }

  async activateTab(windowId: string, tabId: string): Promise<void> {
    const rec = this.require(windowId)
    const handle = rec.tabs.get(tabId)
    if (!handle) throw new Error(`标签页不存在：${tabId}`)

    rec.activeByTrack[handle.tab.track] = tabId
    rec.activeTabId = tabId

    this.layout(rec)
    this.scheduleEmit(windowId)
  }

  async navigate(windowId: string, tabId: string, url: string): Promise<void> {
    const handle = this.requireTab(windowId, tabId)
    await this.loadUrl(handle.wc, url)
  }

  async back(windowId: string, tabId: string): Promise<void> {
    const { wc } = this.requireTab(windowId, tabId)
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  }

  async forward(windowId: string, tabId: string): Promise<void> {
    const { wc } = this.requireTab(windowId, tabId)
    if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  }

  async reload(windowId: string, tabId: string): Promise<void> {
    this.requireTab(windowId, tabId).wc.reload()
  }

  async stopLoading(windowId: string, tabId: string): Promise<void> {
    this.requireTab(windowId, tabId).wc.stop()
  }

  /* ────────────────────────────── 查询 ────────────────────────────── */

  getTab(profileId: string, tabId?: string): TabHandle | null {
    for (const rec of this.windows.values()) {
      if (rec.profileId !== profileId) continue
      if (tabId) {
        const handle = rec.tabs.get(tabId)
        if (handle) return handle
        continue
      }
      const active = rec.activeTabId ? rec.tabs.get(rec.activeTabId) : undefined
      if (active) return active
    }
    return null
  }

  listWindows(): WindowState[] {
    return [...this.windows.values()].map((rec) => this.snapshot(rec))
  }

  getWindow(windowId: string): { win: Electron.BrowserWindow; state: WindowState } | null {
    const rec = this.windows.get(windowId)
    if (!rec) return null
    return { win: rec.win, state: this.snapshot(rec) }
  }

  stateOf(windowId: string): WindowState | null {
    const rec = this.windows.get(windowId)
    return rec ? this.snapshot(rec) : null
  }

  /* ────────────────────────────── 布局 ────────────────────────────── */

  setContentInsets(windowId: string, insets: ContentInsets): void {
    const rec = this.windows.get(windowId)
    if (!rec) return
    rec.insets = {
      top: Math.max(0, Math.round(insets.top)),
      bottom: Math.max(0, Math.round(insets.bottom)),
      left: Math.max(0, Math.round(insets.left)),
      right: Math.max(0, Math.round(insets.right)),
      panelWidth: Math.max(0, Math.round(insets.panelWidth))
    }
    this.layout(rec)
  }

  /**
   * 布局算法：
   * 内容区 = 窗口内容尺寸减去渲染层上报的四边留白。
   * 双轨时影子轨取内容区宽度的 46%，人轨吃掉剩下的（再扣 1px 分隔），
   * 1px 缝隙直接露出窗口背景色，省掉一个只为画线的 WebContentsView 进程。
   * 内容区窄到两栏都不可用时退回单轨，展示当前活跃页。
   */
  private layout(rec: WindowRecord): void {
    if (rec.win.isDestroyed()) return
    const [width, height] = rec.win.getContentSize()
    const { top, bottom, left, right } = rec.insets

    const area = {
      x: left,
      y: top,
      width: Math.max(0, width - left - right),
      height: Math.max(0, height - top - bottom)
    }

    const human = rec.activeByTrack.human ? rec.tabs.get(rec.activeByTrack.human) : undefined
    const shadow = rec.activeByTrack.shadow ? rec.tabs.get(rec.activeByTrack.shadow) : undefined
    const canSplit =
      !!human && !!shadow && human !== shadow && area.width >= MIN_PANE * 2 + DIVIDER

    if (canSplit && human && shadow) {
      const shadowWidth = Math.min(
        Math.max(MIN_PANE, Math.round(area.width * SHADOW_RATIO)),
        area.width - MIN_PANE - DIVIDER
      )
      const humanWidth = area.width - shadowWidth - DIVIDER

      this.place(human, { x: area.x, y: area.y, width: humanWidth, height: area.height })
      this.place(shadow, {
        x: area.x + humanWidth + DIVIDER,
        y: area.y,
        width: shadowWidth,
        height: area.height
      })

      for (const handle of rec.tabs.values()) {
        if (handle !== human && handle !== shadow) handle.view.setVisible(false)
      }
      return
    }

    const active = rec.activeTabId ? rec.tabs.get(rec.activeTabId) : undefined
    if (active) this.place(active, area)
    for (const handle of rec.tabs.values()) {
      if (handle !== active) handle.view.setVisible(false)
    }
  }

  private place(handle: TabHandle, bounds: Electron.Rectangle): void {
    if (bounds.width <= 0 || bounds.height <= 0) {
      handle.view.setVisible(false)
      return
    }
    handle.view.setVisible(true)
    handle.view.setBounds(bounds)
  }

  /* ────────────────────────────── 内部 ────────────────────────────── */

  private wire(rec: WindowRecord, handle: TabHandle): void {
    const { wc, tab } = handle

    wc.on('did-start-loading', () => {
      tab.loading = true
      this.scheduleEmit(rec.id)
    })
    wc.on('did-stop-loading', () => {
      tab.loading = false
      this.syncNav(handle)
      this.scheduleEmit(rec.id)
    })
    wc.on('page-title-updated', (_event, title) => {
      tab.title = title
      this.scheduleEmit(rec.id)
    })
    wc.on('page-favicon-updated', (_event, favicons) => {
      const icon = favicons[0]
      if (icon) tab.favicon = icon
      this.scheduleEmit(rec.id)
    })
    wc.on('did-navigate', (_event, url) => {
      tab.url = url
      // 跨页后旧 favicon 不再适用，等新页自己上报
      tab.favicon = undefined
      this.syncNav(handle)
      this.scheduleEmit(rec.id)
    })
    wc.on('did-navigate-in-page', (_event, url) => {
      tab.url = url
      this.syncNav(handle)
      this.scheduleEmit(rec.id)
    })

    // target=_blank / window.open 一律收编成同轨新标签，避免冒出裸 Electron 窗口
    wc.setWindowOpenHandler(({ url }) => {
      void this.newTab(rec.id, url, tab.track)
      return { action: 'deny' }
    })

    wc.on('destroyed', () => {
      disposeBridge(wc.id)
    })
  }

  private syncNav(handle: TabHandle): void {
    const { wc, tab } = handle
    if (wc.isDestroyed()) return
    tab.canGoBack = wc.navigationHistory.canGoBack()
    tab.canGoForward = wc.navigationHistory.canGoForward()
  }

  private async injectFingerprint(wc: Electron.WebContents, profile: StoredProfile): Promise<void> {
    // 同一个 webContents 只注入一次：addScriptToEvaluateOnNewDocument 是常驻的，
    // 重复注册会让噪声叠加（坐标被扰动两次、音量被加两次），指纹反而变得异常
    if (this.injected.has(wc)) return
    // 监听必须早于注入：回滚标记可能在注入后的第一次脚本执行里就出现
    this.watchMaskSignal(wc, profile)
    try {
      const bridge = bridgeFor(wc)
      await bridge.attach()
      await bridge.send('Page.enable')

      // session.setUserAgent 只改了 navigator.userAgent，网络层照旧发
      // "...Chrome/156 Electron/45.2.1"，一眼就能看出是套壳。
      // 必须在 CDP 层用 setUserAgentOverride 连 UA-CH（Client Hints）一起改。
      await bridge.send('Network.enable').catch(() => undefined)
      await bridge.send('Network.setUserAgentOverride', {
        userAgent: profile.fingerprint.userAgent,
        acceptLanguage: profile.fingerprint.languages.join(','),
        platform: platformOf(profile.fingerprint.os),
        userAgentMetadata: uaMetadata(profile.fingerprint)
      })

      // screen.width 在 JS 层改得再干净也没用：CSS 的 (device-width: Npx)
      // 媒体查询读的是渲染器的真实屏幕参数。creepjs 就是靠对比这两者
      // 来判断有没有伪装（实测出现过 JS 报 2560、媒体查询报 1707 的情况）。
      // dontSetVisibleSize 保证只改「报告值」，不真的缩放视口。
      const fp = profile.fingerprint
      await bridge
        .send('Emulation.setDeviceMetricsOverride', {
          width: 0,
          height: 0,
          // 0 表示「不覆盖」，DPR 就会退回宿主机的真实值。
          // JS 侧把 devicePixelRatio 改成 2 而媒体查询仍是 1，
          // matchMedia('(resolution: 2dppx)') 一比对就穿帮，所以这里必须给真实值。
          deviceScaleFactor: fp.screen.dpr,
          mobile: false,
          screenWidth: fp.screen.width,
          screenHeight: fp.screen.height,
          dontSetVisibleSize: true
        })
        .catch((err) => {
          console.warn('[windows] 屏幕参数覆盖失败，媒体查询会与 JS 读数不一致', err)
        })

      // 必须用 addScriptToEvaluateOnNewDocument：在文档创建前执行，
      // 页面脚本（含反检测脚本）读到的第一手值就是伪造后的。
      //
      // 但它**只作用于 frame**，管不到 Worker —— 实测 worker target 上
      // Page 域根本不存在（`'Page.addScriptToEvaluateOnNewDocument' wasn't found`）。
      // Worker / OOPIF 由下面的 attachChildTargets 走另一条通道。
      const source = buildInjectionScript(profile)
      await bridge.send('Page.addScriptToEvaluateOnNewDocument', { source })

      // 台账回读必须挂在**每次**文档加载之后：注入脚本是 addScriptToEvaluateOnNewDocument，
      // 每导航一次就重跑一次，台账也每页重建一次。用 `on` 而不是 `once`，
      // 否则第二个页面起就不再测量，状态会停在上一页的结论上。
      wc.on('did-finish-load', () => {
        void this.checkPageMaskLedger(wc, profile)
      })

      // 顺序在 page 注入之后：子 target 的注入脚本和 page 用同一份指纹配置，
      // 但走 Runtime.evaluate / 子 session 的 Page 域，两者互不覆盖。
      await this.attachChildTargets(bridge, wc, profile)

      this.injected.add(wc)
      // 到这里只证明**脚本已排进队列**，不证明任何一条属性真的装上了 ——
      // `addScriptToEvaluateOnNewDocument` 的返回值只覆盖「注册成功」这一步。
      //
      // 原先这里置 `'ok'`，于是「一个属性都没装上的页面」状态也是 ok，
      // 门禁读到的是一次**从未测量过的成功**。现在置 `'unknown'`：
      // 真正的 `'ok'` 只能由页面台账回读（`__ss_mask_failed__` = 0 条）来置，
      // 在那之前门禁按「未测量」处置 —— 拒绝 L2。
      //
      // 状态机保证它不会把已有的坏状态洗回 `unknown`（见 setMaskState）。
      this.setMaskState(wc, profile, 'unknown', [], 'page')
    } catch (err) {
      // 指纹注入失败只降级不阻断：环境能开比开不了更重要，
      // 但必须留下明确日志，否则会变成静默的指纹泄漏。
      console.error(`[windows] 指纹注入失败 profile=${profile.id}`, err)
      // 失败事实同时进台账：页面此刻是宿主值，属于「环境不可用」而不是「已伪装」
      this.reportInjectionIssue(wc, profile, 'page', '', `页面级注入失败：${messageOf(err)}`)
    }
  }

  /**
   * 打开子 target 自动附着（Worker / OOPIF），并额外发现 shared_worker。
   *
   * 为什么需要：`Page.addScriptToEvaluateOnNewDocument` 只作用于 frame，
   * Worker 里 `navigator.hardwareConcurrency` 仍是宿主值 —— 主世界报 12、Worker 报 32，
   * 这个矛盾比完全不伪装更容易被判定为套壳。
   *
   * `waitForDebuggerOnStart: true` 是**必须**的：它让子 target 在跑第一行代码前停住，
   * 注入才能落在「页面脚本读值之前」。代价是每条路径都必须放行，见
   * `onChildTargetAttached` 的 finally —— 漏一条，页面侧 API 会永久悬着
   * （实测 `serviceWorker.register()` 在 SW target 被挂住时永不 resolve）。
   *
   * ── shared_worker 为什么还要单独发现一遍 ──
   * `Target.setAutoAttach` **不覆盖 shared_worker**。读数见
   * `artifacts/probe-shared-worker.json`：手动 `attachToTarget` 之前的
   * `attachedToTarget` 里只有 `worker`；shared_worker 那条要等我们主动 attach
   * 才会出现（是回声，不是投递）。所以这里补一条 `Target.setDiscoverTargets`，
   * 从 `targetCreated` 里认出它，再手动 attach。
   * 代价：多一次发现订阅；收益：shared_worker 从「完全不可达」变成「可事后注入」。
   * 但**顶层仍然覆盖不了**（它没被暂停），这一点在注入时如实记账，不写成「已覆盖」。
   */
  private async attachChildTargets(
    bridge: CdpBridge,
    wc: Electron.WebContents,
    profile: StoredProfile
  ): Promise<void> {
    // 先订阅再开自动附着：顺序反了会漏掉第一个 target（它是同步抛出来的）
    bridge.on('Target.attachedToTarget', (params) => {
      void this.onChildTargetAttached(bridge, wc, profile, params)
    })
    // shared_worker 只能靠发现 + 手动 attach，见上面的说明
    bridge.on('Target.targetCreated', (params) => {
      void this.onTargetCreated(bridge, wc, profile, params)
    })
    await bridge.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    try {
      await bridge.send('Target.setDiscoverTargets', { discover: true })
    } catch (err) {
      // 发现订阅开不起来只影响 shared_worker 这一条路径，不能因此让页面起不来。
      // 但必须说出来 —— 否则「shared_worker 已支持」就成了一句没有前提的话。
      this.reportInjectionIssue(
        wc,
        profile,
        'shared_worker',
        '',
        `Target.setDiscoverTargets 失败，shared_worker 将完全不被覆盖：${messageOf(err)}`
      )
    }
  }

  /**
   * 发现了一个 target。目前只有 shared_worker 需要在这里处理。
   *
   * 去重靠 `swAttached`：`targetCreated` 对同一个 target 可能来不止一次
   * （发现订阅重开、页面复用同一个 worker 脚本），重复 `attachToTarget` 会拿到
   * 同一 session，但会重复注入一遍 —— 注入脚本不是幂等的（`_maskOne` 会把自己
   * 再包一层），所以必须挡在这里。
   */
  private async onTargetCreated(
    bridge: CdpBridge,
    wc: Electron.WebContents,
    profile: StoredProfile,
    params: CdpParams
  ): Promise<void> {
    const info = (params['targetInfo'] ?? {}) as { type?: unknown; targetId?: unknown }
    if (info.type !== 'shared_worker') return
    const targetId = typeof info.targetId === 'string' ? info.targetId : ''
    if (!targetId) return
    if (this.swAttached.has(targetId)) return
    this.swAttached.add(targetId)
    try {
      // flatten:true 才能拿到可直接下命令的 session；非 flatten 要再走
      // Target.sendMessageToTarget，多一层且与本文件其余部分不一致。
      await bridge.send('Target.attachToTarget', { targetId, flatten: true })
    } catch (err) {
      this.reportInjectionIssue(
        wc,
        profile,
        'shared_worker',
        '',
        `shared_worker 附着失败（该 worker 读到的是宿主值）：${messageOf(err)}`
      )
    }
  }

  /**
   * 一个子 target 附着上来了。按 `targetInfo.type` 分流。
   *
   * 分流依据全部来自实测（Electron 45.2.1）。worker / iframe 两条分支的**结果**
   * 由 AC-14 / AC-21 在 `npm run verify:anticheat` 里守住；shared_worker 与
   * service_worker 的**覆盖边界**由 `npm run verify:shared-worker` 守住。
   * 域可用性、暂停期超时这类**协议层行为仍然没有自动门禁**，改这一层要重新手工实测：
   *   - worker        → 有 Runtime 域、**没有 Page 域** → Runtime.evaluate
   *   - iframe(OOPIF) → 有 Page 域；但 target 刚建时 Runtime.evaluate 报
   *                     "Cannot find default execution context"（文档还没建）
   *                     → Page.addScriptToEvaluateOnNewDocument
   *   - page          → 已由页面级 addScript 覆盖，重注会让噪声叠加，直接跳过
   *   - service_worker→ 暂停期间**任何命令都不返回**（实测连续 3 次 6s 超时）。
   *                     所以只能「先放行、再抢在第一个事件之前注入」：
   *                     顶层覆盖不了（放行时顶层已经跑完），
   *                     install/activate/fetch/message 事件处理器有机会覆盖 —— 这是**竞态**，
   *                     不是保证，所以每次都要把实际耗时记下来，不写成「已覆盖」。
   *   - shared_worker → `Target.setAutoAttach` 不覆盖它，靠 `onTargetCreated` 手动
   *                     attach 后走到这里；它**没被暂停**，因此同样是事后注入。
   */
  private async onChildTargetAttached(
    bridge: CdpBridge,
    wc: Electron.WebContents,
    profile: StoredProfile,
    params: CdpParams
  ): Promise<void> {
    const info = (params['targetInfo'] ?? {}) as { type?: unknown }
    const type = typeof info.type === 'string' ? info.type : 'unknown'
    // 直接读 params.sessionId：这是「被附着的子 target」的 session。
    // 不要用事件回调的第二个参数 —— 那条 attachedToTarget 是**根 session** 发出的，
    // 第二个参数代表「谁发的」，在这里恰好是根 session 而不是子 target。
    const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : ''
    if (!sessionId) return

    /* 放行（`Runtime.runIfWaitingForDebugger`）只在**真的被挂住**时才需要。
     *
     * `waitingForDebugger` 是 CDP 给的权威字段，不用它会踩两个坑：
     *   1. 对没暂停的 target 发这条命令，Electron 会回错误，于是记下一条
     *      「放行失败（该 target 会一直挂住）」—— 一条纯噪声的假警报。
     *      shared_worker 走手动 attach 时正是这种状态（实测 waitingForDebugger=false）。
     *   2. service_worker 那条路要**自己先放行**再注入，不能等 finally，
     *      所以需要一个「已经放过」的标记，避免重复发。
     * 两个坑都靠这一个 `released` 标记 + `paused` 判断收口。 */
    const paused = params['waitingForDebugger'] === true
    let released = false
    const release = async (): Promise<void> => {
      if (released || !paused) return
      released = true
      try {
        await bridge.send('Runtime.runIfWaitingForDebugger', {}, sessionId)
      } catch (err) {
        this.reportInjectionIssue(
          wc,
          profile,
          type,
          sessionId,
          `放行失败（该 target 会一直挂住）：${messageOf(err)}`
        )
      }
    }

    try {
      if (type === 'page') {
        // 根目标。页面级 Page.addScriptToEvaluateOnNewDocument 已经覆盖它，
        // 这里再注一遍会让噪声叠加（windows.ts 顶部的幂等注释同理）
        return
      }
      if (type === 'worker') {
        if (!WORKER_INJECTION_ENABLED) {
          // 停用期间也必须记一条：Worker 此刻读到的是宿主值，
          // 不记就等于「静默未伪装」。措辞只说「被停用」这个事实，
          // 不写死某一次崩溃的根因 —— 开关可能因为别的原因被关掉，
          // 那时这句话就会指错方向。
          this.reportInjectionIssue(
            wc,
            profile,
            'worker',
            sessionId,
            'worker 注入被停用（WORKER_INJECTION_ENABLED=false），该 Worker 读到的是宿主值；' +
              '历史根因见 windows.ts 开关处的注释'
          )
          return
        }
        await this.injectWorkerTarget(bridge, profile, sessionId)
        return
      }
      if (type === 'iframe') {
        if (!IFRAME_INJECTION_ENABLED) {
          this.reportInjectionIssue(wc, profile, 'iframe', sessionId, 'iframe 注入已停用，该 OOPIF 仍是宿主值')
          return
        }
        await this.injectIframeTarget(bridge, profile, sessionId)
        return
      }
      if (type === 'service_worker') {
        // 顺序不能反：暂停态下 evaluate 不返回（实测 3 次 6s 超时），
        // 必须先放行。放行之后顶层立刻跑完 —— 这是**已知且不可挽回**的损失，
        // 能抢的只有「第一个事件处理器执行之前」这一小段。
        const t0 = Date.now()
        await release()
        await this.injectServiceWorkerTarget(bridge, wc, profile, sessionId, Date.now() - t0)
        return
      }
      if (type === 'shared_worker') {
        // 走到这里说明 `onTargetCreated` 手动 attach 成功了（echo）。
        // 它没被暂停，所以不需要 release —— 也就是只能事后注入。
        await this.injectSharedWorkerTarget(bridge, wc, profile, sessionId)
        return
      }
      this.reportInjectionIssue(wc, profile, type, sessionId, `target 类型 ${type} 未覆盖，该环境仍是宿主值`)
    } catch (err) {
      // 注入失败：页面侧不跟着降级（否则连主世界都伪装不了），
      // 但事实必须带出去，否则就是「Worker 静默未伪装却报成功」
      this.reportInjectionIssue(wc, profile, type, sessionId, `注入失败：${messageOf(err)}`)
    } finally {
      // 无论成功、失败还是提前 return，都要放行 —— 否则页面侧 API 会永久悬着。
      // 用 finally 而不是 catch 之后补发：`return` 走的是 finally，不是 catch。
      await release()
    }
  }

  /**
   * Worker：只能 Runtime.evaluate，且必须显式检查 exceptionDetails。
   *
   * 三种 worker（dedicated / shared / service）共用这段注入+自检，差别只在
   * **时机**和**能覆盖到哪一层**。所以这里只做「注进去 + 回读证明它真的生效」，
   * 时机与覆盖边界的记账交给各自的调用方。
   */
  private async injectWorkerTarget(
    bridge: CdpBridge,
    profile: StoredProfile,
    sessionId: string,
    timeoutMs?: number
  ): Promise<void> {
    await this.applyWorkerScript(bridge, profile, sessionId, timeoutMs)
  }

  /**
   * 注入 worker 脚本并回读一个真实值。失败抛错，由调用方决定记成什么。
   *
   * 为什么要回读：注入脚本自己可能整段被 try/catch 吞掉（现有 page 版就是这样），
   * 所以不能以「evaluate 没报错」为准。而「没报错」和「没跑」在外部完全同形。
   */
  private async applyWorkerScript(
    bridge: CdpBridge,
    profile: StoredProfile,
    sessionId: string,
    timeoutMs?: number
  ): Promise<number> {
    /* `navigator.userAgentData`（UA-CH）**不是** JS 注入的那一段 —— 它由 CDP 的
     * `Network.setUserAgentOverride` 下发。而 CDP 的 override 是**按 target** 生效的：
     * 页面那次调用只覆盖了页面本身与它派生的 dedicated worker，
     * shared_worker / service_worker 是独立 target，拿不到。
     *
     * 实测（tools/probe-uach.mjs，宿主 Windows / 环境 macOS）：
     *   主世界          platform=macOS  [15.0.0]
     *   dedicated       platform=macOS  [15.0.0]   ← 会话级副作用，不是注入的功劳
     *   shared_worker   platform=Windows[19.0.0]   ← 宿主真值
     *   service_worker  platform=Windows[19.0.0]   ← 宿主真值
     *
     * 也就是说：B4 那句「已注入」对 cores/tz/Intl 成立，对 UA-CH **不成立**。
     * 而「主世界说 macOS、worker 说 Windows」是**矛盾**，比「未伪装」更容易被判死 ——
     * 检测方只要在 worker 里读一次 `navigator.userAgentData.platform` 就够了。
     *
     * 这里用引擎自己的机制补下发，**不新增 JS 面**：JS 层伪造 `userAgentData`
     * 会在实例上留下 own property，那是另一个更便宜的 tell。
     *
     * 失败不抛：Network 域在 worker 上未必可用。补不上时读数会照旧矛盾，
     * 由 `verify:shared-worker` 的 uach gate 报出来 —— 静默失败在这条路上不可接受，
     * 所以那个 gate 读的是**值**，不是「命令有没有回 200」。
     */
    await bridge
      .send(
        'Network.setUserAgentOverride',
        {
          userAgent: profile.fingerprint.userAgent,
          acceptLanguage: profile.fingerprint.languages.join(','),
          platform: platformOf(profile.fingerprint.os),
          userAgentMetadata: uaMetadata(profile.fingerprint)
        },
        sessionId
      )
      .catch(() => undefined)

    const source = buildInjectionScript(profile, 'worker')
    const outcome = await bridge.evaluate(source, sessionId, timeoutMs)
    if (!outcome.ok) {
      // 这一步是本次修复最容易假阳性的地方：Runtime.evaluate 在脚本抛错时
      // **不 reject**，而是 resolve 带 exceptionDetails。不显式检查就会把
      // 「脚本一行没跑」记成「注入成功」。
      throw new Error(`注入脚本抛错：${outcome.error ?? '未知'}`)
    }

    const check = await bridge.evaluate('navigator.hardwareConcurrency', sessionId, timeoutMs)
    if (!check.ok) throw new Error(`自检读值失败：${check.error ?? '未知'}`)
    // 类型必须先钉住。早先这里写 `Number(check.value)`，而 check.value 曾经是
    // CDP 的 RemoteObject 而不是数字 —— `Number({})` = NaN，于是自检**每次都失败**，
    // 注入成功也记成「注入失败」。现在 evaluate 已经拆包，但这里仍然先判类型：
    // 将来若 evaluate 的契约再变，这条会给出「回读值不是数字」这个明确原因，
    // 而不是一个看起来像「伪装没生效」的数值不符。
    if (typeof check.value !== 'number') {
      throw new Error(`自检回读值不是数字（拿到 ${typeof check.value}）：evaluate 契约可能变了`)
    }
    const expected = profile.fingerprint.hardware.cpuCores
    if (check.value !== expected) {
      throw new Error(`自检不通过：读到 ${String(check.value)}，期望 ${expected}`)
    }
    return check.value
  }

  /**
   * service_worker：先放行、再抢在第一个事件之前注入。
   *
   * 两条保证必须分开说，否则「已覆盖」会被读成全绿：
   *   顶层脚本          → **不覆盖**。暂停态下任何命令都不返回，resume 的那一刻
   *                       顶层就执行完了。实测顶层读到宿主值（3/3）。
   *   install/activate/
   *   fetch/message     → **覆盖**。事件是放行之后才投递的，注入只要赶在第一个事件
   *                       之前就生效。实测注入在 resume 后 2–5ms 完成，
   *                       install 时刻读到的是伪装值（3/3）。
   *
   * 第二条虽然是实测稳定的，但结构上仍是竞态（依赖注入往返比事件投递快），
   * 所以这里把实际耗时写进台账 —— 它是这条路径唯一有鉴别力的读数。
   */
  private async injectServiceWorkerTarget(
    bridge: CdpBridge,
    wc: Electron.WebContents,
    profile: StoredProfile,
    sessionId: string,
    resumeMs: number
  ): Promise<void> {
    const t0 = Date.now()
    let read: number
    try {
      read = await this.applyWorkerScript(bridge, profile, sessionId, SERVICE_WORKER_EVAL_TIMEOUT)
    } catch (err) {
      this.reportInjectionIssue(
        wc,
        profile,
        'service_worker',
        sessionId,
        `service_worker 注入失败（该 worker 全程读到宿主值）：${messageOf(err)}；` +
          `resume 用了 ${resumeMs}ms`
      )
      return
    }
    this.reportInjectionIssue(
      wc,
      profile,
      'service_worker',
      sessionId,
      `service_worker 已注入（回读 ${read}，resume→注入完成 ${Date.now() - t0}ms）。` +
        '**顶层脚本覆盖不了** —— 暂停态下任何命令都不返回，resume 的那一刻顶层就执行完了' +
        '（实测顶层读到宿主值）。install/activate/fetch/message 处理器内为伪装值：' +
        '实测注入在 resume 后 2–5ms 完成，稳定抢在 install 之前'
    )
  }

  /**
   * shared_worker：没被暂停，靠「发现 → attach → 注入」抢在脚本执行之前。
   *
   * 它不在 `waitForDebuggerOnStart` 的覆盖范围内（`Target.setAutoAttach` 根本不覆盖
   * shared_worker，见 `onTargetCreated`），所以拿到 session 时**理论上**脚本可能已经
   * 跑完。但实测（3/3）注入仍然赶在顶层脚本之前 —— 因为 target 在脚本 fetch 之前
   * 就建出来了，attach + 注入的往返比一次网络取脚本快。
   *
   * 「理论上可能跑完」和「实测每次都赶上」是两件事，所以这里既不写「顶层已覆盖」
   * （那是把竞态当保证），也不写「顶层必漏」（那是把没测过的话当事实）。
   * 台账里写的是：已注入 + 这是竞态 + 实测结果。
   */
  private async injectSharedWorkerTarget(
    bridge: CdpBridge,
    wc: Electron.WebContents,
    profile: StoredProfile,
    sessionId: string
  ): Promise<void> {
    let read: number
    try {
      read = await this.applyWorkerScript(bridge, profile, sessionId)
    } catch (err) {
      this.reportInjectionIssue(
        wc,
        profile,
        'shared_worker',
        sessionId,
        `shared_worker 注入失败（该 worker 全程读到宿主值）：${messageOf(err)}`
      )
      return
    }
    this.reportInjectionIssue(
      wc,
      profile,
      'shared_worker',
      sessionId,
      `shared_worker 已注入（回读 ${read}）。它**没被暂停**（setAutoAttach 不覆盖它，靠 targetCreated + ` +
        'attachToTarget 才拿到 session），所以「注入赶不赶得上顶层脚本」取决于 attach 与脚本 fetch 的时序 —— ' +
        '实测 3/3 赶上了（顶层读到的也是伪装值），但这是竞态，不是保证：脚本一旦先跑完，顶层那一次读就是宿主值'
    )
  }

  /** OOPIF：有 Page 域，用 addScriptToEvaluateOnNewDocument；此时还没有执行上下文 */
  private async injectIframeTarget(
    bridge: CdpBridge,
    profile: StoredProfile,
    sessionId: string
  ): Promise<void> {
    await bridge.send('Page.enable', {}, sessionId).catch(() => undefined)
    const source = buildInjectionScript(profile, 'iframe')
    await bridge.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId)
  }

  /**
   * 回读页面注入台账（`__ss_mask_failed__`）。
   *
   * 为什么必须回读，而不是信「没报错」：
   * page 脚本里每一处 `defineProperty` 都包在 `catch` 里。失败时该属性保持宿主值，
   * 而其它属性仍是伪装值 —— 页面看起来一切正常，只是这一项是**真实指纹**。
   * 「没报错」和「没跑」在外部完全同形，所以默认必须是**不信**。
   *
   * 三态，全部显式：
   *   `[]`      → 台账存在且为空：脚本跑了，且每一项都装上 → `ok`
   *   `[...]`   → 有失败项 → `degraded`，reason 带属性名
   *   `null`    → 台账读不到（脚本没跑 / 被页面删掉 / 不是数组）→ **同样 degraded**
   *
   * 第三条是关键：读不到台账 = 无法证明伪装生效。把「读不到」判成 ok，
   * 就等于让「脚本根本没执行」和「脚本完美执行」得到同一个结论。
   */
  private async checkPageMaskLedger(wc: Electron.WebContents, profile: StoredProfile): Promise<void> {
    let failed: Array<{ p: string; why: string }> | null
    try {
      const bridge = bridgeFor(wc)
      const res = await bridge.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
        // 一次往返同时拿到「有没有台账」和「失败明细」。
        // 不用 `length` 再取一次，那会在两次往返之间留一个可被页面改写的窗口。
        expression: `(function () {
          try {
            var a = window.__ss_mask_failed__;
            if (!Array.isArray(a)) { return null; }
            var out = [];
            for (var i = 0; i < a.length && i < 20; i++) {
              out.push({ p: String(a[i] && a[i].p), why: String(a[i] && a[i].why).slice(0, 160) });
            }
            return out;
          } catch (e) { return null; }
        })()`,
        returnByValue: true
      })
      const v = res?.result?.value
      failed = Array.isArray(v) ? (v as Array<{ p: string; why: string }>) : null
    } catch (err) {
      // 求值本身失败（调试器已断 / 页面已销毁）—— 和「台账读不到」同一处置
      console.warn('[windows] 台账回读失败，按 degraded 处置', messageOf(err))
      failed = null
    }

    if (failed === null) {
      this.setMaskState(wc, profile, 'degraded', [{ attr: 'ledger-missing', reason: '台账读不到' }], 'page')
      this.reportInjectionIssue(
        wc,
        profile,
        'page',
        '',
        '伪装台账读不到（脚本可能未执行，或被页面删除）—— 无法证明伪装生效，按 degraded 处置'
      )
      return
    }

    if (failed.length === 0) {
      // 台账存在且为空：这是**唯一**能把状态置成 `ok` 的地方。
      //
      // 早先这里没有任何调用方，于是状态永远停在 `'unknown'`（见 injectFingerprint 里
      // 那句 setMaskState 的注释）—— 门禁读到的永远是「未测量」，L2 永久被拒。
      // 那是把「默认不信」实现成了「永远不信」，等于整条拦截链路失效。
      this.setMaskState(wc, profile, 'ok', [], 'page')
      return
    }

    const detail = failed.map((f) => `${f.p}(${f.why})`).join(', ')
    this.setMaskState(
      wc,
      profile,
      'degraded',
      failed.map((f) => ({ attr: f.p, reason: f.why })),
      'page'
    )
    this.reportInjectionIssue(wc, profile, 'page', '', `伪装未完全生效：${detail}`)
  }

  /**
   * 监听页面里的回滚标记。
   *
   * 参数形态实测（Electron 45.2.1 / Chromium 156，probe-tmp/gstack-2-2/console-message-shape.json）：
   *   `(event, level:number, message:string, line:number, sourceId:string)` —— 5 个位置参数，
   *   同时 `event` 上还带 `{ frame, level:'warning'|'info'|'error', message, lineNumber, sourceId }`。
   * level 数值：info=1 / warning=2 / error=3。
   * 这里优先读 `event.message`（带 frame，便于将来按 frame 区分主文档与 iframe），
   * 回落到第 3 个位置参数，两种形态都兼容。
   */
  private watchMaskSignal(wc: Electron.WebContents, profile: StoredProfile): void {
    const onMessage = (
      event: { message?: unknown; frame?: unknown } | undefined,
      levelOrMessage?: unknown,
      maybeMessage?: unknown
    ): void => {
      let message = ''
      if (event && typeof event.message === 'string') message = event.message
      else if (typeof maybeMessage === 'string') message = maybeMessage
      else if (typeof levelOrMessage === 'string') message = levelOrMessage
      // 前缀过滤放在最前面：页面 console 量很大，不能每条都进解析
      if (!message || !message.startsWith(MASK_SIGNAL_PREFIX)) return
      this.applyRollbackMarker(wc, profile, message)
    }

    wc.on('console-message', onMessage)
    wc.once('destroyed', () => {
      // 显式解绑：Map 里也要清，否则长会话下按 webContents.id 无限增长
      try {
        wc.off('console-message', onMessage)
      } catch {
        // 已经销毁，忽略
      }
      this.maskStates.delete(wc.id)
    })
  }

  /** 解析 `[ss-mask] rollback failed=a(b),c(d)` 并把状态置为 rolled-back */
  private applyRollbackMarker(wc: Electron.WebContents, profile: StoredProfile, message: string): void {
    const failed = parseRollbackMarker(message)
    // 标记到达 = 注入脚本自己判定失败并回滚了。这是**确定的**坏消息，
    // 即使状态已经是 degraded 也要升级成 rolled-back（后者更具体、更能定位）。
    // 来源一定是 page：这条标记只由页面侧的注入脚本打出来。
    this.setMaskState(wc, profile, 'rolled-back', failed, 'page')
    this.reportInjectionIssue(
      wc,
      profile,
      'page',
      '',
      failed.length > 0
        ? `注入脚本回滚，未生效属性：${failed.map((f) => f.attr + '(' + f.reason + ')').join(', ')}`
        : `注入脚本回滚：${message.slice(0, 200)}`
    )
  }

  /**
   * 记录一次状态变化。
   *
   * ── `source` 为什么是参数而不是从 `failed` 里读 ──
   * 调用方知道自己报的是哪一侧（`applyRollbackMarker` 一定是 page，
   * `reportInjectionIssue` 带着 target）。让这里从 attr 猜来源，等于把
   * 「页面/子目标」这个语义塞进一个自由文本字段里，猜错一次就静默改变拦截范围。
   *
   * ── `failed` 为什么是累积而不是覆盖 ──
   * 原先每次调用都整份替换。于是「page 侧失败」之后来一条「worker 侧失败」，
   * 前一条就被抹掉了 —— 而门禁的拦截条件是「有没有 page 侧失败」，
   * 抹掉之后状态还是 `degraded`，但原因不见了，拦截判定随之翻转。
   * 累积 + 按 attr+source 去重，保证「坏过」这件事不会因为后来的消息被洗掉。
   */
  private setMaskState(
    wc: Electron.WebContents,
    profile: StoredProfile,
    state: MaskState,
    failed: Array<{ attr: string; reason: string }>,
    source: MaskSource
  ): void {
    const prev = this.maskStates.get(wc.id)
    // 状态机是单向的：一旦坏过就不能自己回到 ok，否则「先坏后好」会把告警抹掉。
    // rolled-back 也不能被 degraded 覆盖 —— 前者带具体属性清单，信息更多。
    // `unknown` 与 `ok` 同级对待：它同样不能覆盖已经坏掉的状态，
    // 否则每次重新注入都会把 degraded 洗成「未测量」，拦截判定随之翻转。
    if (prev) {
      if (prev.state === 'rolled-back' && state !== 'rolled-back') return
      if (prev.state === 'degraded' && (state === 'ok' || state === 'unknown')) return
    }

    const merged: MaskFailure[] = prev ? prev.failed.slice() : []
    for (const f of failed) {
      const hit = merged.find((m) => m.attr === f.attr && m.source === source)
      if (hit === undefined) merged.push({ attr: f.attr, reason: f.reason, source })
      else hit.reason = f.reason
    }

    if (prev && prev.state === state && prev.failed.length === merged.length) return
    const record: MaskStateRecord = {
      webContentsId: wc.id,
      profileId: profile.id,
      state,
      failed: merged,
      at: Date.now()
    }
    this.maskStates.set(wc.id, record)
    console.error('[mask-state]', JSON.stringify(record))
    try {
      this.opts.onMaskState?.(record)
    } catch (err) {
      console.error('[windows] onMaskState 回调抛错', err)
    }
  }

  /**
   * 查询某个窗口的伪装状态。
   *
   * 门禁的唯一读数入口。**不传 id 时返回 `null`，而不是「全部」或「ok」**：
   * 「查不到」必须能被调用方区分出来 —— 返回 `'ok'` 会让「窗口已销毁 / 编号不对」
   * 变成放行，返回 `'unknown'` 则会让调用方以为「查过了，是未测量」。
   * 两种猜测都会把「缺失」这个事实藏起来，所以这里返回 null，由调用方按拒绝处理。
   */
  maskStateOf(webContentsId?: number): MaskStateRecord | null {
    if (typeof webContentsId !== 'number') return null
    return this.maskStates.get(webContentsId) ?? null
  }

  /**
   * 枚举（界面与审计用，**不是门禁**）。
   *
   * 不传 webContentsId 返回全部。门禁不要用这个方法：它拿到的是数组，
   * 「空数组」既可能是没有窗口，也可能是调用方传错了 id，两者无法区分。
   *
   * 门禁走的是 `maskStateOf()`（单个、可为 null），接线在 `src/main/index.ts`
   * 的 `setMaskStateLookup` → `core/mask-gate.ts` 的 `judgeMask`。
   *
   * `maskStateOf()` 现有两个读者：门禁（拦 L2）与指纹自检报告
   * （`modules/audit.ts` 的 `runSelfCheck`，用同一个 `judgeMask` 定 severity，
   * 不另设阈值）。
   *
   * 本方法的读者是环境页的状态点：`ipc/handlers.ts` 的 `CH.mask.list`
   * → `maskRowOf()`（同一张 `judgeMask` 表）→ 渲染层 `shared/mask-ui.ts` 选颜色。
   * 也就是说界面拿到的 `allow/kind/reason` 是门禁算的，界面自己不算。
   *
   * `listInjectionIssues()` 的读者是环境抽屉里的诊断区（`CH.injection.list`
   * → `FingerprintDrawer` 的「本次会话的注入问题」）。它记录的是「注入过程中
   * 报过什么」，与「此刻状态如何」不是一回事 —— 所以是两条通道，不是一条。
   * `opts.onInjectionIssue` 仍然零订阅者：没有「需要实时推送」的调用方，
   * 那就别假装有。要接的时候先接读者。
   */
  listMaskStates(webContentsId?: number): MaskStateRecord[] {
    return webContentsId === undefined
      ? [...this.maskStates.values()]
      : [...this.maskStates.values()].filter((s) => s.webContentsId === webContentsId)
  }

  /** 记一条失败事实：进台账 + 打结构化日志 + 通知上层（如果有订阅者） */
  private reportInjectionIssue(
    wc: Electron.WebContents,
    profile: StoredProfile,
    target: string,
    sessionId: string,
    reason: string
  ): void {
    // 任何一条注入失败都意味着「这个环境没伪装住」——状态至少是 degraded。
    // 不在这里同步状态，就会出现「台账里有记录、状态还是 unknown」的自相矛盾。
    //
    // 这里**不再自己判断 prev 是否 ok**：原先写的是 `if (!prev || prev.state === 'ok')`，
    // 而初始状态改成 `'unknown'` 之后，那条判断会把「页面失败」整个跳过 ——
    // 状态停在 unknown、失败清单是空的，门禁虽然仍然拒绝，但拒绝理由丢了。
    // 单调性由 setMaskState 统一负责，这里只管把事实交上去。
    this.setMaskState(wc, profile, 'degraded', [{ attr: target, reason }], sourceOf(target))
    const issue: InjectionIssue = {
      webContentsId: wc.id,
      profileId: profile.id,
      target,
      sessionId,
      reason,
      at: Date.now()
    }
    // 有上限的台账：恶意页面反复 new Worker 会反复失败，不能无界增长
    if (this.injectionIssues.length >= 200) this.injectionIssues.shift()
    this.injectionIssues.push(issue)
    // 结构化前缀，便于日志侧 grep 与后续接告警
    console.error('[inject-issue]', JSON.stringify(issue))
    try {
      this.opts.onInjectionIssue?.(issue)
    } catch (err) {
      // 订阅者抛错不能反过来影响注入流程
      console.error('[windows] onInjectionIssue 回调抛错', err)
    }
  }

  /**
   * 查询注入失败台账。
   *
   * 给上层（AC-14 门禁 / 状态面板 / 验收脚本）留的读取口：
   * 注入失败不再只存在于 console 里。不传 webContentsId 返回全部。
   *
   * 目前**零调用方**。唯一会被真正触达的是 `reportInjectionIssue` 里的
   * `console.error('[inject-issue]', …)`，它进的是主进程日志，验收脚本可以 grep ——
   * 但那是日志，不是接口。界面/审计要读这条台账时先接读者，再接展示。
   */
  listInjectionIssues(webContentsId?: number): InjectionIssue[] {
    return webContentsId === undefined
      ? [...this.injectionIssues]
      : this.injectionIssues.filter((i) => i.webContentsId === webContentsId)
  }

  private async loadUrl(wc: Electron.WebContents, url: string): Promise<void> {
    if (wc.isDestroyed()) throw new Error('webContents 已销毁')
    const target = normalizeUrl(url)
    try {
      await wc.loadURL(target)
    } catch (err) {
      // loadURL 在 4xx/5xx、被后续导航打断、下载触发时都会 reject，
      // 但页面实际上已经在加载，这里吞掉，真实失败由 did-fail-load 体现。
      const message = err instanceof Error ? err.message : String(err)
      if (!message.includes('ERR_ABORTED')) {
        console.warn(`[windows] 加载 ${target} 失败：${message}`)
      }
    }
  }

  private destroyHandle(rec: WindowRecord, handle: TabHandle): void {
    rec.tabs.delete(handle.tabId)

    if (rec.activeByTrack[handle.tab.track] === handle.tabId) {
      rec.activeByTrack[handle.tab.track] = this.pickNeighbor(rec, handle.tab.track)
    }
    if (rec.activeTabId === handle.tabId) {
      rec.activeTabId = rec.activeByTrack[handle.tab.track] ?? this.firstTabId(rec)
    }

    // 先摘调试器再关页面，否则 CDP 会话会在销毁过程中报一堆无关错误
    disposeBridge(handle.wc.id)
    try {
      handle.wc.close()
    } catch {
      // 可能已经随渲染进程崩溃一起没了
    }
    try {
      rec.win.contentView.removeChildView(handle.view)
    } catch {
      // 窗口先于标签销毁时 childView 已不存在
    }
  }

  private pickNeighbor(rec: WindowRecord, track: TrackKind): string | null {
    for (const handle of rec.tabs.values()) {
      if (handle.tab.track === track) return handle.tabId
    }
    return null
  }

  private firstTabId(rec: WindowRecord): string | null {
    const first = rec.tabs.values().next()
    return first.done ? null : first.value.tabId
  }

  private handleClosed(windowId: string): void {
    const rec = this.windows.get(windowId)
    if (!rec) return
    if (rec.emitTimer) {
      clearTimeout(rec.emitTimer)
      rec.emitTimer = null
    }
    // 用户用系统快捷键关窗时走这里，webContents 可能已经被一起销毁
    for (const handle of [...rec.tabs.values()]) {
      disposeBridge(handle.wc.id)
      if (!handle.wc.isDestroyed()) handle.wc.close()
    }
    rec.tabs.clear()
    this.windows.delete(windowId)
    if (!this.hasWindowFor(rec.profileId)) this.opts.onProfileStopped(rec.profileId)
  }

  private hasWindowFor(profileId: string): boolean {
    for (const rec of this.windows.values()) {
      if (rec.profileId === profileId) return true
    }
    return false
  }

  private scheduleEmit(windowId: string): void {
    const rec = this.windows.get(windowId)
    if (!rec || rec.emitTimer) return
    rec.emitTimer = setTimeout(() => {
      rec.emitTimer = null
      this.emit(windowId)
    }, EMIT_INTERVAL)
  }

  private emit(windowId: string): void {
    const rec = this.windows.get(windowId)
    if (!rec) return
    this.opts.onState(this.snapshot(rec))
  }

  private snapshot(rec: WindowRecord): WindowState {
    const bounds = rec.win.isDestroyed()
      ? { x: 0, y: 0, width: 0, height: 0 }
      : rec.win.getBounds()
    return {
      id: rec.id,
      profileId: rec.profileId,
      profileName: rec.profileName,
      tabs: [...rec.tabs.values()].map((handle) => ({ ...handle.tab })),
      activeTabId: rec.activeTabId,
      bounds,
      maximized: !rec.win.isDestroyed() && rec.win.isMaximized()
    }
  }

  private profileOf(rec: WindowRecord): StoredProfile {
    const profile = this.opts.getProfile(rec.profileId)
    if (!profile) throw new Error(`环境不存在：${rec.profileId}`)
    return profile
  }

  private require(windowId: string): WindowRecord {
    const rec = this.windows.get(windowId)
    if (!rec) throw new Error(`窗口不存在：${windowId}`)
    return rec
  }

  private requireTab(windowId: string, tabId: string): TabHandle {
    const handle = this.require(windowId).tabs.get(tabId)
    if (!handle) throw new Error(`标签页不存在：${tabId}`)
    return handle
  }

  private loadShell(win: BrowserWindow, windowId: string, profileId: string): void {
    // 同一个 renderer 既要能当控制台，也要能当双轨窗口的壳。
    // 用 query 告诉它自己的角色，避免「先渲染控制台再切浏览器」的闪屏。
    const query =
      `role=browser&windowId=${encodeURIComponent(windowId)}` +
      `&profileId=${encodeURIComponent(profileId)}`
    // electron-vite 在 dev 下注入 ELECTRON_RENDERER_URL，生产包走 out/renderer
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) {
      void win.loadURL(`${devUrl}?${query}`)
      return
    }
    void win.loadFile(join(__dirname, '../renderer/index.html'), { search: query })
  }
}

/* ────────────────────────────── 工具函数 ────────────────────────────── */

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

/** 地址栏输入归一化：带协议直接用，像域名的补 https，其余当搜索词 */
function normalizeUrl(raw: string): string {
  const input = raw.trim()
  if (!input) return DEFAULT_URL
  if (SCHEME_RE.test(input)) return input
  if (input.includes(' ') || !input.includes('.')) {
    return `https://www.bing.com/search?q=${encodeURIComponent(input)}`
  }
  return `https://${input}`
}

/**
 * 解析回滚标记：`[ss-mask] rollback failed=hardwareConcurrency(不可配置),platform(宿主对象不存在)`
 *
 * 括号里可能还有括号和逗号（错误信息什么都有），所以不能简单 split(',')：
 * 按括号深度切，深度回到 0 之后的逗号才是属性分隔符。
 * 解析不出来时返回空数组而不是抛错 —— 标记本身能说明「回滚发生了」，
 * 属性清单只是附加信息，不能因为解析失败就把整条标记丢掉。
 */
function parseRollbackMarker(message: string): Array<{ attr: string; reason: string }> {
  const out: Array<{ attr: string; reason: string }> = []
  const at = message.indexOf('failed=')
  if (at < 0) return out
  const body = message.slice(at + 'failed='.length).trim()

  let depth = 0
  let cur = ''
  const parts: string[] = []
  for (const ch of body) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) parts.push(cur)

  for (const raw of parts) {
    const item = raw.trim()
    if (!item) continue
    const open = item.indexOf('(')
    if (open < 0) {
      out.push({ attr: item, reason: '未提供原因' })
      continue
    }
    const attr = item.slice(0, open).trim()
    const reason = item.slice(open + 1, item.endsWith(')') ? item.length - 1 : item.length).trim()
    if (attr) out.push({ attr, reason })
  }
  return out
}

function shortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

/**
 * 把台账里的 target 字符串映射成拦截范围。
 *
 * 这个映射决定「哪些失败会拦 L2」，所以**不能靠字符串包含关系猜**：
 * `service_worker` 里含 `worker`，用 `includes('worker')` 会把它算成 worker 侧，
 * 而它其实是另一个 target 类型（注入路径完全不同）。
 * 显式枚举，未知一律落到 `other` —— `other` 不拦 L2，但会在界面标红，
 * 漏判的代价是「多一条告警」，猜错的代价是「该拦的没拦」。
 */
function sourceOf(target: string): MaskSource {
  if (target === 'page') return 'page'
  if (target === 'worker') return 'worker'
  if (target === 'iframe') return 'iframe'
  return 'other'
}

/**
 * 取错误文本。
 *
 * CDP 抛出来的东西不一定是 Error：`wrap()` 会造 Error，但 Electron 在某些路径上
 * 直接抛字符串；`String(err)` 对对象会得到 "[object Object]"，把原始信息丢掉，
 * 而注入失败的原始信息恰恰是唯一能定位问题的东西。
 */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/** electron-vite 产物的 preload 扩展名随构建格式变化，两个候选都探一次 */
function resolvePreload(): string | undefined {
  for (const name of ['index.js', 'index.mjs']) {
    const candidate = join(__dirname, `../preload/${name}`)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}
