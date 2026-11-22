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
  ScriptBatchResult,
  ProxyGroup,
  ProxyGroupStrategy,
  WebhookRecord,
  WebhookEvent,
  WebhookTestResult,
  AuditEntry,
  AuditVerifyResult,
  AuditFlushStatus,
  BackupFile,
  ConsistencyReport,
  CookieItem,
  DownloadItem,
  HistoryItem,
  LocalApiState,
  MaskRow,
  InjectionIssue,
  StoreHealth,
  TeamMember,
  TeamProfileShare,
  TeamActivity,
  TeamState,
  ExtensionRecord,
  ScheduleRecord,
  ScheduleKind,
  WarmupReport
} from './types'
import type { AgentEvent, RunRequest, PageSnapshot } from './protocol'

export const CH = {
  profiles: {
    list: 'ss:profiles:list',
    get: 'ss:profiles:get',
    create: 'ss:profiles:create',
    update: 'ss:profiles:update',
    /** 批量更新：一次 IPC + 一次落盘 */
    batchUpdate: 'ss:profiles:batch-update',
    remove: 'ss:profiles:remove',
    clone: 'ss:profiles:clone',
    launch: 'ss:profiles:launch',
    stop: 'ss:profiles:stop',
    regenerate: 'ss:profiles:regenerate',
    preview: 'ss:profiles:preview',
    setExemption: 'ss:profiles:set-exemption',
    /**
     * 按当前挂载代理的出口，校准指纹里的时区 / 语言 / 坐标。
     *
     * 单独一条通道而不是让渲染层先 `proxies.check` 再 `profiles.update`：
     * 出口信息不能由渲染层声明。主进程自己探测（或复用 5 分钟内的缓存）、
     * 自己落库、自己写审计，才能保证写进去的地理参数与实际出口一致。
     */
    matchGeo: 'ss:profiles:match-geo',
    /** 回收站：列出已软删除的环境 */
    trash: 'ss:profiles:trash',
    /** 从回收站恢复 */
    restore: 'ss:profiles:restore',
    /** 彻底删除（连同分区数据） */
    purge: 'ss:profiles:purge'
  },
  extensions: {
    list: 'ss:extensions:list',
    create: 'ss:extensions:create',
    update: 'ss:extensions:update',
    remove: 'ss:extensions:remove'
  },
  warmup: {
    /** 对一个环境按给定 URL 列表做 Cookie 预热（顺序访问，带停留） */
    run: 'ss:warmup:run'
  },
  schedules: {
    list: 'ss:schedules:list',
    create: 'ss:schedules:create',
    update: 'ss:schedules:update',
    remove: 'ss:schedules:remove',
    /** 立即触发一次（不影响下次计划时间） */
    runNow: 'ss:schedules:run-now'
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
    /** 重新打开最近关闭的标签（Ctrl+Shift+T） */
    reopenClosedTab: 'ss:window:reopenClosedTab',
    setBounds: 'ss:window:setBounds',
    setContentInsets: 'ss:window:setContentInsets'
  },
  agent: {
    run: 'ss:agent:run',
    /** 取消任务：带 profileId 就只停那个环境的，不带就全停 */
    cancel: 'ss:agent:cancel',
    snapshot: 'ss:agent:snapshot',
    /**
     * 当前正在跑的任务（带 profileId 查单个，不带查全部）。
     *
     * 存在的理由：任务状态以前只走事件流，渲染层一重载事件流就断了 ——
     * 面板回到"还没开始"，而主进程里的任务还在跑、还在烧 token。
     */
    status: 'ss:agent:status'
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
    apply: 'ss:proxies:apply',
    /** 代理组：一组出口，按策略轮换 / 故障转移 */
    groupList: 'ss:proxies:group-list',
    groupCreate: 'ss:proxies:group-create',
    groupUpdate: 'ss:proxies:group-update',
    groupRemove: 'ss:proxies:group-remove'
  },
  /** Webhook：任务 / 定时结果回调 */
  webhooks: {
    list: 'ss:webhooks:list',
    create: 'ss:webhooks:create',
    update: 'ss:webhooks:update',
    remove: 'ss:webhooks:remove',
    /** 手动发一次测试事件 */
    test: 'ss:webhooks:test'
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
    run: 'ss:scripts:run',
    /** 多环境同动作（动作同步器） */
    runBatch: 'ss:scripts:run-batch'
  },
  audit: {
    list: 'ss:audit:list',
    verify: 'ss:audit:verify',
    /**
     * 落盘状态（有没有记录还卡在内存里）。
     *
     * 审计是批量落盘的，所以正常情况下存在 200ms 的窗口；
     * 落盘失败时窗口会一直开着。不把这件事说出来，
     * 用户会以为「刚才那次操作已经记下来了」。
     */
    status: 'ss:audit:status'
  },
  injection: {
    /**
     * 本次会话里「某个执行环境没能伪装」的事实清单（最多 200 条，主进程内存）。
     *
     * 与 `mask.list` 的分工：那个是**此刻的状态**（会被后来的测量覆盖），
     * 这个是**过程中发生过什么**（追加、不覆盖）。
     * 两者不能合并 —— 合并之后「现在好了」会把「刚才坏过」抹掉。
     */
    list: 'ss:injection:list'
  },
  mask: {
    /**
     * 当前所有窗口的伪装状态。
     *
     * 单独一组而不是塞进 `profiles.list()`：状态按**窗口**存在（一个环境可以有
     * 多个窗口），而且它是进程内实时读数，跟落盘的 Profile 不是一回事。
     * 塞进 Profile 会让人以为它是持久化字段，然后有一天拿它当门禁判据。
     */
    list: 'ss:mask:list'
  },
  selfcheck: {
    run: 'ss:selfcheck:run'
  },
  data: {
    cookies: 'ss:data:cookies',
    clearCookies: 'ss:data:clearCookies',
    /**
     * 导出某个环境的 Cookie。
     *
     * 单独一条而不是复用 `cookies`：那条返回的是给界面看的结构化列表，
     * 而导出要的是**别的工具能直接吃的文件内容**（Netscape 文本 / JSON）。
     * 让界面自己拼字符串的话，格式知识就散到渲染层去了 —— 而格式知识必须只有一份。
     */
    exportCookies: 'ss:data:exportCookies',
    /**
     * 导入 Cookie 到某个环境。
     *
     * 导入是**写**操作，所以它必须有明确的失败语义：写不进去的条数要报出来，
     * 不能只报「成功导入 N 条」—— 那会让用户以为整个文件都进去了。
     */
    importCookies: 'ss:data:importCookies',
    downloads: 'ss:data:downloads',
    clearDownloads: 'ss:data:clearDownloads',
    history: 'ss:data:history',
    clearHistory: 'ss:data:clearHistory',
    /**
     * 整机备份：把整个数据目录加密成一个文件。
     *
     * 单独一组而不是塞进 `localApi`：那是给外部程序用的 REST 通道，
     * 而备份/还原是**用户自己**在界面上按的操作。
     * 之前它只有 localApi 入口、界面上一个按钮都没有 ——
     * 等于桌面端用户永远用不上一个已经实现的功能。
     */
    backup: 'ss:data:backup',
    /** 列出备份目录里的备份文件 */
    backupList: 'ss:data:backup-list',
    /** 整机还原（不可逆：会把当前数据目录整体换掉） */
    restore: 'ss:data:restore'
  },
  localApi: {
    state: 'ss:localApi:state',
    start: 'ss:localApi:start',
    stop: 'ss:localApi:stop',
    /**
     * 单独的重掷令牌。
     *
     * 为什么不能靠「重复调用 start」来表达：原先"已经在跑且端口相同"时
     * start 的语义就是**重掷令牌** —— 于是任何一次"确保服务在跑"的调用
     * 都会静默作废全部在用客户端（它们立刻 401），而 401 的文案是
     * 「缺少或错误的 Bearer 令牌」，调用方分不清是自己写错了还是被轮换了。
     */
    regenerateToken: 'ss:localApi:regenerate-token',
    /** 把令牌写进剪贴板；不返回令牌本身 —— 渲染层永远拿不到明文 */
    copyToken: 'ss:localApi:copyToken'
  },
  /**
   * 本地团队（LOCAL-ONLY）。
   *
   * 全部是本机操作：没有登录、没有跨设备同步、没有遥测。通道名沿用 `ss:<域>:<动作>`
   * 规律，让主进程和渲染层都不用手写字符串。
   */
  team: {
    state: 'ss:team:state',
    memberAdd: 'ss:team:member-add',
    memberUpdate: 'ss:team:member-update',
    memberRemove: 'ss:team:member-remove',
    shareSet: 'ss:team:share-set',
    shareRemove: 'ss:team:share-remove',
    activity: 'ss:team:activity'
  },
  push: {
    windowState: 'ss:push:window-state',
    agentEvent: 'ss:push:agent-event',
    profileState: 'ss:push:profile-state',
    taskUpdate: 'ss:push:task-update',
    download: 'ss:push:download',
    localApiState: 'ss:push:local-api-state',
    /**
     * 伪装状态变化时推送整份行列表。
     *
     * 为什么推「整份」而不是「变的那一条」：状态是按窗口存的，一个环境可能
     * 同时有两个窗口、各自不同的读数；推单条会让渲染层不得不自己维护
     * 「同 profileId 的旧行要不要替换」。整份只有几十条，重发一遍比让界面
     * 去合并便宜得多，也不会合并错。
     */
    maskState: 'ss:push:mask-state',
    /**
     * 主题解析结果（'light' | 'dark'）。
     *
     * 单独一条推送而不是搭 profileState 的车：主题变更的来源有三种
     * （用户改设置、系统偏好变化、启动时首次应用），只有第一种会顺带
     * 触发 profileState。混在一起会让「系统切到深色」这个最需要即时生效的
     * 场景恰好不发。
     */
    theme: 'ss:push:theme'
  }
} as const

/* ────────────────────────────── 暴露给渲染层的 API ────────────────────────────── */

/**
 * 一次「按代理校准地理」的结果。
 *
 * `ok` 写死为字面量 `true`：失败不会以 `{ ok:false }` 返回，而是由统一的
 * `Result` 包装抛给渲染层（preload 的 `invoke` 会 throw）。这样调用方只需要
 * 处理成功形状，不用维护“成功里还套着失败”的第二套分支。
 *
 * `country` / `ip` 在探测回包缺字段时是空字符串而不是 undefined：
 * 渲染层直接展示即可，不需要在每个调用点写 `??`。
 */
export interface GeoMatchResult {
  ok: true
  timezone: string
  locale: string
  languages: string[]
  /** 出口国家。ip-api 返回的是国家名（例如 "Germany"），不是 ISO 代码 */
  country: string
  /** 出口 IP */
  ip: string
}

export interface ProfilesAPI {
  list(): Promise<Profile[]>
  get(id: string): Promise<Profile>
  create(input: CreateProfileInput): Promise<Profile>
  update(id: string, patch: Partial<Profile>): Promise<Profile>
  /**
   * 批量更新：一次 IPC + **一次落盘**，返回真正命中的条数。
   *
   * 为什么需要它：渲染层的批量改分组 / 批量换代理原来是
   * `Promise.all(ids.map(id => update(id, ...)))` —— 每个 id 一次 IPC、
   * 每次全量重写 profiles.json。1000 个环境就是 1000 次 2MB 写，
     * 主进程被这些同步写阻塞，界面在这期间完全卡住。
   *
   * 语义与单条 `update` 完全一致（同一份 WRITABLE 白名单与校验），
   * 只是把「N 次读-改-写」压成「1 次读-改-写」。
   */
  batchUpdate(ids: string[], patch: Partial<Profile>): Promise<number>
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
  /**
   * 开关「伪装闸门豁免」（`Profile.allowUnmaskedL2`）。**唯一**能改这个字段的通道。
   *
   * 为什么不是 `update(id, { allowUnmaskedL2 })`：`update` 的入参是
   * `Partial<Profile>`，被 XSS 的渲染层可以直接发裸 JSON。而这个开关的全部人为约束
   * 就是「开启时必须手打环境名」—— 约束只放在界面上等于没有约束。
   *
   * `confirmName` 只在开启时需要，且必须与环境名**完全相等**（不做大小写折叠）。
   * 关闭不需要确认：收紧永远是安全方向。
   */
  setExemption(id: string, enabled: boolean, confirmName: string): Promise<Profile>
  /**
   * 按当前挂载代理的出口校准地理字段（timezone / locale / languages / geolocation）。
   *
   * 主进程会先找代理记录：5 分钟内的成功探测直接复用，否则现场探测并回写
   * `lastCheck`。未挂代理、代理记录不存在、探测失败、出口没返回时区都会抛错，
   * **不会**用当前值冒充“已校准”。成功后返回出口信息供界面提示。
   */
  matchGeo(id: string): Promise<GeoMatchResult>
  /** 回收站列表（不含正常环境） */
  trash(): Promise<Profile[]>
  /** 从回收站恢复 */
  restore(id: string): Promise<Profile>
  /** 彻底删除，连同磁盘分区数据 */
  purge(id: string): Promise<void>
  /**
   * 环境列表的主进程推送。
   *
   * 订阅它而不是只靠每次操作后的本地 setState：定时任务、地理校准、伪装状态
   * 回收等**不是由当前界面发起**的变更不会经过本地更新路径。缺少这条订阅时，
   * 界面上会一直显示旧的环境列表（例如定时任务启动了环境，卡片仍是空闲态）。
   */
  onState(cb: (profiles: Profile[]) => void): () => void
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
  /** 重新打开最近关闭的标签（Ctrl+Shift+T）。栈空时返回 false */
  reopenClosedTab(windowId: string): Promise<boolean>
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
  /**
   * 取消任务。
   *
   * 带 profileId 只停**那个环境**的任务 —— 每个环境窗口停自己那个，
   * 不会误杀别的窗口正在跑的任务。不带就全停。
   */
  cancel(profileId?: string): Promise<void>
  /**
   * 当前正在跑的任务。
   *
   * 带 profileId 查单个（返回 null 表示这个环境没在跑），
   * 不带则返回全部运行中的任务。
   *
   * 渲染层挂载时先拉一次再订阅事件：事件流在渲染进程重载后就断了，
   * 只靠它的话，任务跑到一半按 Ctrl+R，面板会回到"还没开始"，
   * 而任务其实还在跑、还在烧 token。
   */
  status(profileId?: string): Promise<TaskRecord | TaskRecord[] | null>
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
  /**
   * 订阅「最终生效的亮/暗」。
   *
   * 推的是解析结果（'light' | 'dark'），不是 `ThemeMode` ——
   * 解析（含跟随系统）只在主进程做一次。渲染层各自去算的话，
   * 每个窗口都会自己读一次系统偏好，`nativeTheme` 变更事件到达顺序
   * 不一致时会出现两个窗口一明一暗。
   */
  onTheme(cb: (mode: 'light' | 'dark') => void): () => void
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
  /**
   * 多环境同动作（动作同步器）：把同一条脚本在多个环境里依次回放。
   *
   * 与逐个调用 `run` 的区别在于**结论是聚合的**：返回逐环境结果，
   * 让用户一眼看出「哪几个环境没跟上」，而不是自己去对日志。
   *
   * 含 L2 步骤时，每个环境仍会各自弹一次系统原生确认框 ——
   * 一次确认放行 N 个环境的批量付款，风险就被摊薄成 N 份。
   */
  runBatch(scriptId: string, profileIds: string[]): Promise<ScriptBatchResult>
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
  /** 有多少条记录还没落盘 / 上一次落盘失败的原因 */
  status(): Promise<AuditFlushStatus>
}

export interface SelfCheckAPI {
  run(profileId: string): Promise<ConsistencyReport>
}

/**
 * 伪装状态（只读）。
 *
 * 这里**没有**任何写接口：状态由注入流程测量得出，渲染层不能声明
 * 「这个环境现在是好的」。曾经有人提过加 `ack()` 让用户「点掉告警」——
 * 那等于把测量结果变成一次点击的结果。
 */
export interface MaskAPI {
  /**
   * 当前所有有读数的窗口，每个窗口一行。
   *
   * 注意：**只含有读数的窗口**。环境在跑但还没回读时，这个环境不会出现在
   * 返回值里 —— 渲染层必须把它画成 `block`（门禁此刻就是拒绝的），
   * 不能因为「没查到这个环境」就当作正常。见 `shared/mask-ui.ts` 的 `maskToneOf`。
   */
  list(): Promise<MaskRow[]>
  /** 状态变化推送（整份行列表） */
  onState(cb: (rows: MaskRow[]) => void): () => void
}

export interface InjectionAPI {
  /**
   * 本次会话的注入失败台账（最多 200 条，主进程内存，重启即清空）。
   *
   * 与 `mask.list()` 分开两条通道的理由：一个是「此刻状态」，一个是「发生过什么」。
   * 前者的读者是卡片上的状态点，后者的读者是环境抽屉里的诊断区 ——
   * 把两者塞进同一个返回值，界面就必须自己分辨哪些是当前状态、哪些是历史事件。
   */
  list(): Promise<InjectionIssue[]>
}

/**
 * Cookie 导出格式。
 *
 * `'netscape'` = 制表符分隔的文本（curl / Cookie Editor / EditThisCookie 通吃）；
 * `'json'` = `{version, exportedAt, cookies:[…]}`（字段与本应用的 CookieItem 对齐，
 * 不丢 sameSite 这类 Netscape 格式装不下的字段）。
 *
 * 之所以用字面量联合而不是 `string`：格式拼错了（比如 'JSON'）应该在编译期就红，
 * 而不是运行期导出一份格式不对的文件、让别的工具读不出来。
 */
export type CookieExportFormat = 'netscape' | 'json'

/**
 * Cookie 导入结果。
 *
 * `imported` 与 `failed` **必须同时给**：只报成功数的话，用户无法判断
 * 「有一部分没导进去」和「全都导进去了」—— 而后者是用户真正需要的答案。
 */
export interface CookieImportSummary {
  /** 成功写入的条数 */
  imported: number
  /** 写入失败的条数 */
  failed: number
  /**
   * 逐条原因（解析失败 + 写入失败合并）。
   * 最多 10 条，截断时最后一条会变成「…另有 N 条未列出」的汇总。
   */
  errors: string[]
}

export interface DataAPI {
  cookies(profileId: string): Promise<CookieItem[]>
  clearCookies(profileId: string): Promise<number>
  /**
   * 导出某个环境的 Cookie，返回**文件内容**（字符串）。
   *
   * 返回内容而不是让界面拼：格式知识必须只有一份，而它属于主进程。
   */
  exportCookies(profileId: string, format: CookieExportFormat): Promise<string>
  /**
   * 把一段 Cookie 文本/JSON 导入某个环境。
   *
   * 格式自动识别（Netscape 文本 / JSON），坏行逐条报错而不是整份丢弃。
   */
  importCookies(profileId: string, text: string): Promise<CookieImportSummary>
  downloads(): Promise<DownloadItem[]>
  clearDownloads(): Promise<void>
  history(profileId: string): Promise<HistoryItem[]>
  clearHistory(profileId: string): Promise<void>
  onDownload(cb: (item: DownloadItem) => void): () => void
  /**
   * 整机备份。返回备份文件的绝对路径。
   *
   * 备份用 `safeStorage` 派生的密钥加密，**只有同一台机器、
   * 同一个系统账户**能还原 —— 换机器请用迁移包（口令封装）。
   */
  backup(): Promise<{ path: string }>
  /** 列出备份目录里的备份文件（按时间倒序） */
  backupList(): Promise<BackupFile[]>
  /**
   * 整机还原。
   *
   * 不可逆：当前数据目录会被整体改名保留成 `.bak-<ts>`，新目录写入备份内容。
   * 保留的那份**不会自动删** —— 用户确认没问题后自己清理。
   *
   * 返回的 `keeperPath` 是旧数据的所在位置，必须让用户知道在哪。
   */
  restore(path: string): Promise<{ keeperPath: string; fileCount: number }>
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
  /**
   * 启动服务。
   *
   * 已经在跑且端口相同 → **什么都不做**（原样返回当前状态），
   * 不会重掷令牌。要重掷请用 `regenerateToken()`。
   */
  start(port?: number): Promise<LocalApiState>
  stop(): Promise<LocalApiState>
  /** 显式重掷令牌：所有在用客户端会立刻失效（这是预期行为） */
  regenerateToken(): Promise<LocalApiState>
  /** 由主进程把令牌写进剪贴板；令牌本身不会经过 IPC 回到渲染层 */
  copyToken(): Promise<{ copied: boolean }>
  onState(cb: (s: LocalApiState) => void): () => void
}

export interface TeamAPI {
  /** 一次拿到整份快照，避免成员/分享/活动三份列表在界面上拼出撕裂画面 */
  state(): Promise<TeamState>
  /** 新增本地成员。姓名会在主进程 trim 并校验，不信渲染层 */
  memberAdd(input: { name: string; role: TeamMember['role'] }): Promise<TeamMember>
  /** 改姓名 / 角色 / 禁用；最后一个 owner 不得降级或禁用 */
  memberUpdate(
    id: string,
    patch: { name?: string; role?: TeamMember['role']; disabled?: boolean }
  ): Promise<TeamMember>
  /** 删除成员；最后一个 owner 不得删除 */
  memberRemove(id: string): Promise<{ ok: true }>
  /** 设置某环境对某成员的本地授权 */
  shareSet(
    profileId: string,
    memberId: string,
    permission: TeamProfileShare['permission']
  ): Promise<TeamProfileShare>
  /** 撤销某环境对某成员的本地授权 */
  shareRemove(profileId: string, memberId: string): Promise<{ ok: true }>
  /** 活动日志，最新在前（主进程已排序） */
  activity(): Promise<TeamActivity[]>
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
  mask: MaskAPI
  injection: InjectionAPI
  data: DataAPI
  localApi: LocalApiAPI
  team: TeamAPI
  extensions: ExtensionsAPI
  warmup: WarmupAPI
  schedules: SchedulesAPI
  proxyGroups: ProxyGroupsAPI
  webhooks: WebhooksAPI
}

declare global {
  interface Window {
    ss: ShadowSurfAPI
  }
}


/* ────────────────────────────── 扩展 / 预热 / 定时 ────────────────────────────── */

export interface ExtensionsAPI {
  list(): Promise<ExtensionRecord[]>
  create(input: { name: string; path: string; enabled?: boolean }): Promise<ExtensionRecord>
  update(id: string, patch: Partial<Pick<ExtensionRecord, 'name' | 'path' | 'enabled'>>): Promise<ExtensionRecord>
  remove(id: string): Promise<void>
}

/* ────────────────────────────── 代理组 ────────────────────────────── */

export interface ProxyGroupsAPI {
  list(): Promise<ProxyGroup[]>
  create(input: {
    name: string
    proxyIds: string[]
    strategy: ProxyGroupStrategy
    failover?: boolean
  }): Promise<ProxyGroup>
  update(
    id: string,
    patch: Partial<Pick<ProxyGroup, 'name' | 'proxyIds' | 'strategy' | 'failover'>>
  ): Promise<ProxyGroup>
  remove(id: string): Promise<void>
}

/* ────────────────────────────── Webhook ────────────────────────────── */

export interface WebhooksAPI {
  list(): Promise<WebhookRecord[]>
  create(
    input: { url: string; events?: WebhookEvent[]; enabled?: boolean; allowInternal?: boolean }
  ): Promise<WebhookRecord>
  update(
    id: string,
    patch: Partial<Pick<WebhookRecord, 'url' | 'events' | 'enabled' | 'allowInternal'>>
  ): Promise<WebhookRecord>
  remove(id: string): Promise<void>
  /** 手动发一次测试事件，返回真实 HTTP 状态 */
  test(id: string): Promise<WebhookTestResult>
}

export interface WarmupAPI {
  /** urls 由用户提供；主进程顺序访问并返回逐条结果 */
  run(profileId: string, urls: string[]): Promise<WarmupReport>
}

export interface SchedulesAPI {
  list(): Promise<ScheduleRecord[]>
  create(input: {
    kind: ScheduleKind
    targetId: string
    profileId?: string
    everyMinutes?: number
    dailyAt?: string
    enabled?: boolean
  }): Promise<ScheduleRecord>
  update(id: string, patch: Partial<ScheduleRecord>): Promise<ScheduleRecord>
  remove(id: string): Promise<void>
  runNow(id: string): Promise<{ ok: boolean; message: string }>
}
