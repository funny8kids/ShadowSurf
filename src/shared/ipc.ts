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
  FingerprintConfig,
  OSKind,
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
  LocalApiState,
  StoreHealth
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
    regenerate: 'ss:profiles:regenerate',
    preview: 'ss:profiles:preview'
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
    openExternal: 'ss:system:openExternal',
    /**
     * 数据健康快照。
     *
     * 为什么单独一条通道而不是塞进 `info()`：`info()` 是启动时拉一次的静态信息，
     * 而健康状态会在运行中变化（用户手工改了文件、杀软放开了句柄）。分开之后
     * 界面可以按需重拉，不用把整份系统信息也重拉一遍。
     */
    storeHealth: 'ss:system:storeHealth'
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
    stop: 'ss:localApi:stop',
    /** 把令牌写进剪贴板；不返回令牌本身 —— 渲染层永远拿不到明文 */
    copyToken: 'ss:localApi:copyToken'
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
  /**
   * 用**盘上的种子** + 指定平台，算一套指纹出来给界面预览。
   *
   * 存在的理由：界面切平台时要把「换到那个平台会长什么样」显示出来，而完整
   * 种子不出主进程（见 `Profile.seedHint`）。所以这件事只能在主进程做。
   *
   * 注意它调的是 `buildFingerprint` 而不是 `resolveFingerprint` —— 后者对
   * macos/linux 不叠 seed 扰动，一批环境会退化成同一个分辨率。此前渲染层
   * 直接调 `resolveFingerprint`，于是「预览看到的分辨率」和「保存后实际的」
   * 不是同一个值：预览是模板默认值，保存后是扰动值。这条一起修了。
   */
  preview(id: string, patch: { platform?: OSKind }): Promise<FingerprintConfig>
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
  /**
   * 这里**没有 `confirm()`**。
   *
   * 它曾经存在，签名是 `confirm(approved: boolean)`：渲染层回一个 boolean，
   * 主进程就把它当作用户同意。也就是说「用户已同意」是**调用方的一个字段**，
   * 而不是主进程持有的凭证 —— 被 XSS 的渲染层不显示任何弹窗、直接 invoke
   * 就能批准一次支付。
   *
   * 现在批准只能来自主进程弹出的系统原生确认窗口。渲染层能做的只有
   * `cancel()`：请求可以发起，断言不行。
   */
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
  /**
   * 数据健康快照：哪些文件坏了、备份在哪、备份里还有没有明文 seed。
   *
   * 只读，不提供「修复」动作 —— 损坏文件是证据，含明文 seed 的备份可能是唯一
   * 的已知良好快照，删不删该由人决定，不该由一次按钮点击决定。
   */
  storeHealth(): Promise<StoreHealth>
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

/** 导入时逐条的环境核对结果，用于在界面上贴出「搬过来的还是不是同一个人」 */
export interface MigrationAdoptReport {
  name: string
  ok: boolean
  /** `from` 来自包里的密文，`to` 来自落盘后从盘上读回来的那份 */
  compared: Array<{ field: string; from: string; to: string }>
}

export interface MigrationImportResult {
  profiles: number
  proxies: number
  /**
   * 每条环境的身份核对结果。
   *
   * 存在的理由：`profiles` 这个计数只说明「写了几行」，不说明「身份对不对」。
   * 用户真正要问的是后者，而这个答案只有 main 进程能给出（它才看得见盘上那份）。
   */
  adopted: MigrationAdoptReport[]
}

export interface MigrationAPI {
  /**
   * 导出成 JSON 字符串，由渲染层触发下载。
   *
   * `password` 不是可选的：v2 包里每个环境的 seed / fingerprint / 代理 key
   * 都用它派生的密钥封着。没有口令就没有包，不存在「不加密的降级导出」。
   */
  export(profileIds: string[], password: string): Promise<string>
  /**
   * 导入。返回 `{ ok:false, code:'legacy-identity-loss', lostFields }` 的**唯一**
   * 情形是：包是 v1（不含身份），且调用方没有带 `acceptLegacyIdentityLoss`。
   * 这时 main 进程**一个字节都不写**。
   *
   * `acceptLegacyIdentityLoss` 的类型是字面量 `true` 而不是 `boolean`：传 `false`
   * 和传 `undefined` 在这个决策点上没有区别，允许 `false` 只会让调用方以为
   * 「显式拒绝了」是个有意义的状态，而实际上它和忘了传一样。
   */
  import(
    json: string,
    password: string,
    acceptLegacyIdentityLoss?: true
  ): Promise<MigrationImportResult>
}

export interface ScriptsAPI {
  list(): Promise<AutomationScript[]>
  get(id: string): Promise<AutomationScript>
  save(script: Partial<AutomationScript> & { name: string }): Promise<AutomationScript>
  remove(id: string): Promise<void>
  /**
   * 在当前环境里回放，复用同一套动作协议。
   *
   * 含不可逆步骤时**没有**「一次确认整段放行」这回事：每遇到一步 L2 动作都会
   * 由主进程弹出系统原生确认框，用户当场点「允许执行」那一步才会跑。
   * 停在被拦下的步骤时返回 `needsConfirm`，带 `{ startAt: failedAt }` 重发可以从
   * 那一步续跑 —— 但续跑时该步骤仍会再问一次。
   */
  run(scriptId: string, profileId: string, options?: ScriptRunOptions): Promise<ScriptRunResult>
}

export interface ScriptRunOptions {
  /**
   * 从第几步开始（1 起）。用于确认后从被拦下的那一步续跑。
   *
   * 注意这里**没有 `confirmed`**：那个字段等于「渲染层自称用户已同意」，
   * 而渲染层正是可能被攻破的那一层。授权只能来自主进程弹的系统原生窗口。
   */
  startAt?: number
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
  /**
   * 服务状态。
   *
   * 返回值里**没有令牌**：渲染层只需要知道有没有在跑、在哪个端口。
   * 令牌曾经在这里出现（而且服务没启动时就已经给了），于是被 XSS 的渲染层
   * 零交互就能拿到凭证。要拿令牌请用 `copyToken()`，它只写剪贴板。
   */
  state(): Promise<LocalApiState>
  start(port?: number): Promise<LocalApiState>
  stop(): Promise<LocalApiState>
  /** 由主进程把令牌写进剪贴板；令牌本身不会经过 IPC 回到渲染层 */
  copyToken(): Promise<{ copied: boolean }>
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
