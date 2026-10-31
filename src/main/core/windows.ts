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

import { BrowserWindow, WebContentsView } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BrowserTab, Profile, TrackKind, WindowState } from '@shared/types'
import { bridgeFor, disposeBridge } from '@main/core/cdp'
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

export interface TabHandle {
  windowId: string
  tabId: string
  profileId: string
  wc: Electron.WebContents
  view: Electron.WebContentsView
  tab: BrowserTab
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
  getProfile: (id: string) => Profile | null
  onState: (state: WindowState) => void
  onProfileStopped: (profileId: string) => void
}

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

  private async injectFingerprint(wc: Electron.WebContents, profile: Profile): Promise<void> {
    // 同一个 webContents 只注入一次：addScriptToEvaluateOnNewDocument 是常驻的，
    // 重复注册会让噪声叠加（坐标被扰动两次、音量被加两次），指纹反而变得异常
    if (this.injected.has(wc)) return
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
      const source = buildInjectionScript(profile.fingerprint, profile.seed)
      await bridge.send('Page.addScriptToEvaluateOnNewDocument', { source })
      this.injected.add(wc)
    } catch (err) {
      // 指纹注入失败只降级不阻断：环境能开比开不了更重要，
      // 但必须留下明确日志，否则会变成静默的指纹泄漏。
      console.error(`[windows] 指纹注入失败 profile=${profile.id}`, err)
    }
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

  private profileOf(rec: WindowRecord): Profile {
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

function shortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

/** electron-vite 产物的 preload 扩展名随构建格式变化，两个候选都探一次 */
function resolvePreload(): string | undefined {
  for (const name of ['index.js', 'index.mjs']) {
    const candidate = join(__dirname, `../preload/${name}`)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}
