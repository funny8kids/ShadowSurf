/**
 * IPC 契约。
 *
 * 约定：
 * - 所有 `invoke` 通道返回 `Result<T>`，renderer 侧由 preload 拆包，失败直接 throw。
 * - 所有推送通道以 `ss:push:` 开头，由 preload 转成订阅函数。
 * - 通道名一律 `ss:<域>:<动作>`，主进程用 `CH` 常量注册，禁止手写字符串。
 */

import type {
  Profile,
  CreateProfileInput,
  CloneOptions,
  Settings,
  TestResult,
  SystemInfo,
  WindowState,
  TaskRecord,
  ProxyRecord,
  ProxyInput,
  ProxyCheck,
  ProxyImportResult,
  FingerprintTemplate,
  AutomationScript,
  ScriptRunResult,
  AuditEntry,
  AuditVerifyResult,
  ConsistencyReport,
  CookieItem,
  DownloadItem,
  HistoryItem,
  LocalApiState
} from './types'
import type { AgentEvent, RunRequest, PageSnapshot } from './protocol'

export const CH = {
  profiles: {
    list: 'ss:profiles:list',
    get: 'ss:profiles:get',
    create: 'ss:profiles:create',
    update: 'ss:profiles:update',
    remove: 'ss:profiles:remove',
    clone: 'ss:profiles:clone',
    launch: 'ss:profiles:launch',
    stop: 'ss:profiles:stop',
    regenerate: 'ss:profiles:regenerate'
  },
  window: {
    open: 'ss:window:open',
    close: 'ss:window:close',
    state: 'ss:window:state',
    newTab: 'ss:window:newTab',
    closeTab: 'ss:window:closeTab',
    activateTab: 'ss:window:activateTab',
    navigate: 'ss:window:navigate',
    back: 'ss:window:back',
    forward: 'ss:window:forward',
    reload: 'ss:window:reload',
    stopLoading: 'ss:window:stopLoading',
    setBounds: 'ss:window:setBounds',
    setContentInsets: 'ss:window:setContentInsets'
  },
  agent: {
    run: 'ss:agent:run',
    cancel: 'ss:agent:cancel',
    confirm: 'ss:agent:confirm',
    snapshot: 'ss:agent:snapshot'
  },
  tasks: {
    list: 'ss:tasks:list',
    get: 'ss:tasks:get',
    clear: 'ss:tasks:clear'
  },
  settings: {
    get: 'ss:settings:get',
    set: 'ss:settings:set',
    test: 'ss:settings:test'
  },
  system: {
    info: 'ss:system:info',
    openExternal: 'ss:system:openExternal'
  },
  proxies: {
    list: 'ss:proxies:list',
    create: 'ss:proxies:create',
    update: 'ss:proxies:update',
    remove: 'ss:proxies:remove',
    import: 'ss:proxies:import',
    check: 'ss:proxies:check',
    checkAll: 'ss:proxies:checkAll',
    apply: 'ss:proxies:apply'
  },
  templates: {
    list: 'ss:templates:list',
    save: 'ss:templates:save',
    apply: 'ss:templates:apply',
    remove: 'ss:templates:remove'
  },
  migration: {
    export: 'ss:migration:export',
    import: 'ss:migration:import'
  },
  scripts: {
    list: 'ss:scripts:list',
    get: 'ss:scripts:get',
    save: 'ss:scripts:save',
    remove: 'ss:scripts:remove',
    run: 'ss:scripts:run'
  },
  audit: {
    list: 'ss:audit:list',
    verify: 'ss:audit:verify'
  },
  selfcheck: {
    run: 'ss:selfcheck:run'
  },
  data: {
    cookies: 'ss:data:cookies',
    clearCookies: 'ss:data:clearCookies',
    downloads: 'ss:data:downloads',
    clearDownloads: 'ss:data:clearDownloads',
    history: 'ss:data:history',
    clearHistory: 'ss:data:clearHistory'
  },
  localApi: {
    state: 'ss:localApi:state',
    start: 'ss:localApi:start',
    stop: 'ss:localApi:stop'
  },
  push: {
    windowState: 'ss:push:window-state',
    agentEvent: 'ss:push:agent-event',
    profileState: 'ss:push:profile-state',
    taskUpdate: 'ss:push:task-update',
    download: 'ss:push:download',
    localApiState: 'ss:push:local-api-state'
  }
} as const

/* ────────────────────────────── 暴露给渲染层的 API ────────────────────────────── */

export interface ProfilesAPI {
  list(): Promise<Profile[]>
  get(id: string): Promise<Profile>
  create(input: CreateProfileInput): Promise<Profile>
  update(id: string, patch: Partial<Profile>): Promise<Profile>
  remove(id: string): Promise<void>
  clone(id: string, opts: CloneOptions): Promise<Profile>
  launch(id: string): Promise<void>
  stop(id: string): Promise<void>
  /** 重掷指纹种子并重新生成整套参数 */
  regenerate(id: string): Promise<Profile>
}

export interface WindowAPI {
  open(profileId: string): Promise<void>
  close(windowId: string): Promise<void>
  newTab(windowId: string, url?: string): Promise<string>
  closeTab(windowId: string, tabId: string): Promise<void>
  activateTab(windowId: string, tabId: string): Promise<void>
  navigate(windowId: string, tabId: string, url: string): Promise<void>
  back(windowId: string, tabId: string): Promise<void>
  forward(windowId: string, tabId: string): Promise<void>
  reload(windowId: string, tabId: string): Promise<void>
  stopLoading(windowId: string, tabId: string): Promise<void>
  /**
   * 渲染层把网页容器的矩形报给主进程。
   * 主进程据此给 WebContentsView 设 bounds —— 网页铺不准基本都是这里没调。
   */
  setContentInsets(insets: ContentInsetsPayload): void
  onState(cb: (state: WindowState) => void): () => void
}

/** 渲染层上报的布局矩形。right 由 panelWidth 推导，不单独传 */
export interface ContentInsetsPayload {
  visible: boolean
  top: number
  left: number
  width: number
  height: number
  panelWidth: number
  split: number
}

export interface AgentAPI {
  run(req: RunRequest): Promise<void>
  cancel(): Promise<void>
  /** 风险确认弹窗的回执 */
  confirm(approved: boolean): Promise<void>
  snapshot(profileId: string, tabId?: string): Promise<PageSnapshot>
  onEvent(cb: (e: AgentEvent) => void): () => void
}

export interface TasksAPI {
  list(): Promise<TaskRecord[]>
  get(id: string): Promise<TaskRecord | null>
  clear(): Promise<void>
  /** 任务完成 / 状态变化时推送，控制台靠它实时刷新统计 */
  onUpdate(cb: (task: TaskRecord) => void): () => void
}

export interface SettingsAPI {
  get(): Promise<Settings>
  set(s: Partial<Settings>): Promise<Settings>
  test(s: Partial<Settings>): Promise<TestResult>
}

export interface SystemAPI {
  info(): Promise<SystemInfo>
  openExternal(url: string): Promise<void>
}

export interface ProxiesAPI {
  list(): Promise<ProxyRecord[]>
  create(input: ProxyInput): Promise<ProxyRecord>
  update(id: string, patch: Partial<ProxyInput>): Promise<ProxyRecord>
  remove(id: string): Promise<void>
  /** 粘贴多行文本批量导入 */
  import(text: string): Promise<ProxyImportResult>
  /** 真实发起一次请求，拿出口 IP / 时区 / 延迟 */
  check(id: string): Promise<ProxyCheck>
  checkAll(): Promise<ProxyRecord[]>
  /** 把代理挂到环境上；proxyId 传 null 表示直连 */
  apply(profileId: string, proxyId: string | null): Promise<Profile>
}

export interface TemplatesAPI {
  list(): Promise<FingerprintTemplate[]>
  /** 从现有环境抽取一套参数存成模板 */
  save(fromProfileId: string, name: string, description?: string): Promise<FingerprintTemplate>
  apply(templateId: string, profileId: string): Promise<Profile>
  remove(id: string): Promise<void>
}

export interface MigrationAPI {
  /** 导出成 JSON 字符串，由渲染层触发下载 */
  export(profileIds: string[]): Promise<string>
  import(json: string): Promise<{ profiles: number; proxies: number }>
}

export interface ScriptsAPI {
  list(): Promise<AutomationScript[]>
  get(id: string): Promise<AutomationScript>
  save(script: Partial<AutomationScript> & { name: string }): Promise<AutomationScript>
  remove(id: string): Promise<void>
  /** 在当前环境里回放，复用同一套动作协议 */
  run(scriptId: string, profileId: string): Promise<ScriptRunResult>
}

export interface AuditAPI {
  list(limit?: number): Promise<AuditEntry[]>
  verify(): Promise<AuditVerifyResult>
}

export interface SelfCheckAPI {
  run(profileId: string): Promise<ConsistencyReport>
}

export interface DataAPI {
  cookies(profileId: string): Promise<CookieItem[]>
  clearCookies(profileId: string): Promise<number>
  downloads(): Promise<DownloadItem[]>
  clearDownloads(): Promise<void>
  history(profileId: string): Promise<HistoryItem[]>
  clearHistory(profileId: string): Promise<void>
  onDownload(cb: (item: DownloadItem) => void): () => void
}

export interface LocalApiAPI {
  state(): Promise<LocalApiState>
  start(port?: number): Promise<LocalApiState>
  stop(): Promise<LocalApiState>
  onState(cb: (s: LocalApiState) => void): () => void
}

export interface ShadowSurfAPI {
  profiles: ProfilesAPI
  window: WindowAPI
  agent: AgentAPI
  tasks: TasksAPI
  settings: SettingsAPI
  system: SystemAPI
  proxies: ProxiesAPI
  templates: TemplatesAPI
  migration: MigrationAPI
  scripts: ScriptsAPI
  audit: AuditAPI
  selfcheck: SelfCheckAPI
  data: DataAPI
  localApi: LocalApiAPI
}

declare global {
  interface Window {
    ss: ShadowSurfAPI
  }
}
