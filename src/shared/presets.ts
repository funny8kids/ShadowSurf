/**
 * 内置预设：模型服务商、默认设置、指纹平台模板。
 *
 * 这里的值是「开箱可用」的默认值，不是唯一事实。
 * 指纹模板在生成 Profile 时被解析成 FingerprintConfig 的具体值并落库，
 * 之后再改本文件不会影响已有环境（避免指纹漂移）。
 */

import type {
  FingerprintConfig,
  FingerprintPermissionState,
  ResolvedFingerprintConfig,
  Settings,
  OSKind
} from './types'

/* ────────────────────────────── 模型服务商 ────────────────────────────── */

export interface ProviderPreset {
  id: string
  label: string
  baseUrl: string
  model: string
  /** 是否需要 API Key。本地推理服务填 false */
  needKey: boolean
  hint: string
  /** 英文界面用的显示名。缺省用 label（多数是品牌名，中英同形） */
  labelEn?: string
  /** 英文界面用的提示。缺省用 hint */
  hintEn?: string
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    needKey: true,
    hint: '性价比高，中文指令跟随好',
    hintEn: 'Cost-effective, follows Chinese instructions well'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    needKey: true,
    hint: '官方接口，需可访问的网络',
    hintEn: 'Official API; requires network access'
  },
  {
    id: 'qwen',
    label: '通义千问',
    labelEn: 'Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    needKey: true,
    hint: '阿里云 DashScope 兼容模式',
    hintEn: 'Alibaba Cloud DashScope compatible mode'
  },
  {
    id: 'kimi',
    label: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-32k',
    needKey: true,
    hint: '长上下文，适合整页理解',
    hintEn: 'Long context; good for full-page understanding'
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    labelEn: 'Zhipu GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-plus',
    needKey: true,
    hint: '注意路径含 /v4',
    hintEn: 'Note the /v4 path segment'
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    labelEn: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-72B-Instruct',
    needKey: true,
    hint: '多模型聚合，可自填模型名',
    hintEn: 'Multi-model aggregator; custom model names allowed'
  },
  {
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:14b',
    needKey: false,
    hint: '本地推理，免 Key',
    hintEn: 'Local inference; no API key needed'
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-model',
    needKey: false,
    hint: '本地推理，需在 LM Studio 里开服务',
    hintEn: 'Local inference; start the server in LM Studio'
  },
  {
    id: 'custom',
    label: '自定义',
    labelEn: 'Custom',
    baseUrl: '',
    model: '',
    needKey: true,
    hint: '任何兼容 /chat/completions 的服务',
    hintEn: 'Any service compatible with /chat/completions'
  }
]

export const DEFAULT_SETTINGS: Settings = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.2,
  maxSteps: 12,
  autoRun: true,
  panelWidth: 380,
  theme: 'system'
}

/* ────────────────────────────── 环境标识色 ────────────────────────────── */

export const PROFILE_COLORS = [
  '#0F766E',
  '#0EA5E9',
  '#8B5CF6',
  '#EC4899',
  '#F59E0B',
  '#10B981',
  '#EF4444',
  '#6366F1'
]

/* ────────────────────────────── 指纹平台模板 ────────────────────────────── */

/** 当前内置 Chromium 主版本，UA 与 UA-CH 都要与之对齐 */
// 必须与 Electron 内置的 Chromium 一致：UA 说 141 而引擎是 156，
// 任何做特性检测的站点都能一眼看穿（`CSS.supports` 之类的新 API 会露馅）
export const CHROME_VERSION = '156.0.8078.75'
export const CHROME_MAJOR = '156'

export interface OSFingerprintTemplate {
  os: OSKind
  label: string
  userAgent: string
  screen: FingerprintConfig['screen']
  hardware: FingerprintConfig['hardware']
  webgl: FingerprintConfig['webgl']
  fonts: string[]
  timezone: string
  locale: string
  languages: string[]
}

export const OS_TEMPLATES: Record<OSKind, OSFingerprintTemplate> = {
  windows: {
    os: 'windows',
    label: 'Windows 11 · 23H2',
    userAgent:
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`,
    screen: { width: 1920, height: 1080, dpr: 1, colorDepth: 24 },
    hardware: { cpuCores: 8, memoryGB: 16 },
    webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    // 白名单是「负向拦截」的基准：不在表里的字体一律按 fallback 量。
    // 所以表必须尽量贴近真实系统清单，漏一个就等于多一个矛盾点
    // （creepjs 在 macOS 环境里检出 Cambria Math 就是这么露的）。
    fonts: [
      'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Calibri Light', 'Cambria', 'Cambria Math',
      'Candara', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Ebrima',
      'Franklin Gothic Medium', 'Gabriola', 'Gadugi', 'Georgia', 'Impact', 'Ink Free', 'Javanese Text',
      'Leelawadee UI', 'Lucida Console', 'Lucida Sans Unicode', 'Malgun Gothic', 'Marlett',
      'Microsoft Himalaya', 'Microsoft JhengHei', 'Microsoft New Tai Lue', 'Microsoft PhagsPa',
      'Microsoft Sans Serif', 'Microsoft Tai Le', 'Microsoft YaHei', 'Microsoft Yi Baiti', 'MingLiU-ExtB',
      'Mongolian Baiti', 'MS Gothic', 'MV Boli', 'Myanmar Text', 'Nirmala UI', 'Palatino Linotype',
      'Segoe Fluent Icons', 'Segoe MDL2 Assets', 'Segoe Print', 'Segoe Script', 'Segoe UI',
      'Segoe UI Emoji', 'Segoe UI Historic', 'Segoe UI Symbol', 'SimSun', 'Sitka', 'Sylfaen',
      'Symbol', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Webdings', 'Wingdings',
      'Yu Gothic'
    ],
    timezone: 'America/Los_Angeles',
    locale: 'en-US',
    languages: ['en-US', 'en']
  },
  macos: {
    os: 'macos',
    label: 'macOS 15 · Sequoia',
    userAgent:
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`,
    screen: { width: 1512, height: 982, dpr: 2, colorDepth: 30 },
    hardware: { cpuCores: 10, memoryGB: 16 },
    webgl: { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' },
    fonts: [
      'American Typewriter', 'Andale Mono', 'Apple Chancery', 'Apple Color Emoji', 'Apple SD Gothic Neo',
      'Apple Symbols', 'Arial', 'Arial Hebrew', 'Arial Narrow', 'Avenir', 'Avenir Next',
      'Avenir Next Condensed', 'Baskerville', 'Big Caslon', 'Bodoni 72', 'Bradley Hand', 'Brush Script MT',
      'Chalkboard', 'Chalkboard SE', 'Chalkduster', 'Cochin', 'Comic Sans MS', 'Copperplate', 'Courier',
      'Courier New', 'Didot', 'DIN Alternate', 'DIN Condensed', 'Futura', 'Geneva', 'Georgia',
      'Gill Sans', 'Helvetica', 'Helvetica Neue', 'Herculanum', 'Hoefler Text', 'Impact',
      'Lucida Grande', 'Luminari', 'Marker Felt', 'Menlo', 'Monaco', 'Noteworthy', 'Optima',
      'Palatino', 'Papyrus', 'Phosphate', 'Rockwell', 'San Francisco', 'Savoye LET', 'SignPainter',
      'Skia', 'Snell Roundhand', 'Tahoma', 'Times', 'Times New Roman', 'Trattatello', 'Trebuchet MS',
      'Verdana', 'Zapfino'
    ],
    timezone: 'America/New_York',
    locale: 'en-US',
    languages: ['en-US', 'en']
  },
  linux: {
    os: 'linux',
    label: 'Ubuntu 24.04 · GNOME',
    userAgent:
      `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`,
    screen: { width: 1920, height: 1080, dpr: 1, colorDepth: 24 },
    hardware: { cpuCores: 4, memoryGB: 8 },
    webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)' },
    fonts: [
      'Cantarell', 'DejaVu Sans', 'DejaVu Sans Mono', 'DejaVu Serif', 'FreeMono', 'FreeSans',
      'FreeSerif', 'Liberation Mono', 'Liberation Sans', 'Liberation Serif', 'Noto Color Emoji',
      'Noto Mono', 'Noto Sans', 'Noto Sans Mono', 'Noto Serif', 'Ubuntu', 'Ubuntu Condensed',
      'Ubuntu Mono', 'Ubuntu Sans', 'Ubuntu Sans Mono'
    ],
    timezone: 'Europe/Berlin',
    locale: 'en-US',
    languages: ['en-US', 'en']
  }
}

/** 时区 → 默认经纬度，用于 geolocation 与代理出口对齐 */
export const TIMEZONE_GEO: Record<string, { latitude: number; longitude: number }> = {
  'America/Los_Angeles': { latitude: 37.7749, longitude: -122.4194 },
  'America/New_York': { latitude: 40.7128, longitude: -74.006 },
  'Europe/London': { latitude: 51.5074, longitude: -0.1278 },
  'Europe/Berlin': { latitude: 52.52, longitude: 13.405 },
  'Asia/Shanghai': { latitude: 31.2304, longitude: 121.4737 },
  'Asia/Tokyo': { latitude: 35.6762, longitude: 139.6503 },
  'Asia/Singapore': { latitude: 1.3521, longitude: 103.8198 }
}

/* ─────────────────────── 新增指纹面的纯数据 ─────────────────────── */

/**
 * 权限表是**实测值**，不是「一律 prompt」。
 *
 * 写成全 prompt 看起来最安全，但 clipboard-write / payment-handler 这类
 * 在真 Chrome 里默认就是 granted —— 一个站点读自己的权限状态时看到的
 * 是「这个浏览器在撒谎」，比暴露真实状态更硬。
 * periodic-background-sync 反过来默认是 denied（Chrome 默认关掉后台同步）。
 */
export const DEFAULT_PERMISSION_STATES: Readonly<Record<string, FingerprintPermissionState>> = {
  'clipboard-read': 'prompt',
  'clipboard-write': 'granted',
  'geolocation': 'prompt',
  'camera': 'prompt',
  'microphone': 'prompt',
  'notifications': 'prompt',
  'background-sync': 'granted',
  'periodic-background-sync': 'denied',
  'payment-handler': 'granted',
  'storage-access': 'granted',
  'midi': 'prompt',
  'midi-sysex': 'prompt',
  'persistent-storage': 'prompt',
  'speaker-selection': 'prompt',
  'idle-detection': 'prompt',
  'local-fonts': 'prompt'
}

/**
 * 桌面 Chrome 的插件表就是五个内置 PDF viewer。
 * 多一个（Flash / 假扩展）都是编的；名字顺序也是实测顺序。
 */
export const PDF_PLUGIN_NAMES = [
  'PDF Viewer',
  'Chrome PDF Viewer',
  'Chromium PDF Viewer',
  'Microsoft Edge PDF Viewer',
  'WebKit built-in PDF'
] as const

export interface PdfMimeType {
  type: string
  suffixes: string
  description: string
}

export const PDF_MIME_TYPES: readonly PdfMimeType[] = [
  { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
  { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' }
]

export interface PluginDescriptor {
  name: string
  description: string
  filename: string
  mimeTypes: string[]
}

/**
 * 插件描述符只生成一次，注入脚本照抄。
 *
 * 脚本侧不自己拼这张表：两处写同一份事实必然漂移，而漂移的读数
 * 是 `plugins[1].name` 说 Chrome、`mimeTypes` 却少一项 —— 一眼可见的不一致。
 */
export function resolvePluginDescriptors(plugins: FingerprintConfig['plugins']): PluginDescriptor[] {
  if (plugins === 'none') return []
  return PDF_PLUGIN_NAMES.map((name) => ({
    name,
    description: 'Portable Document Format',
    filename: 'internal-pdf-viewer',
    mimeTypes: PDF_MIME_TYPES.map((m) => m.type)
  }))
}

export interface UaBrand {
  brand: string
  version: string
}

/**
 * `navigator.userAgentData.brands` / `fullVersionList` 的唯一来源。
 *
 * 主进程的 CDP `Network.setUserAgentOverride` 与页面里的 JS 必须读同一份值，
 * 否则「Client Hints 头说 Chrome 156、JS 说 Chromium 141」不需要任何参照就能判定。
 */
export function resolveUaBrands(fp: FingerprintConfig): {
  brands: UaBrand[]
  fullVersionList: UaBrand[]
} {
  const major = fp.uaVersion.split('.')[0] || CHROME_MAJOR
  const brands = [
    { brand: 'Google Chrome', version: major },
    { brand: 'Chromium', version: major },
    { brand: 'Not_A Brand', version: '24' }
  ]
  const fullVersionList = [
    { brand: 'Google Chrome', version: fp.uaVersion },
    { brand: 'Chromium', version: fp.uaVersion },
    { brand: 'Not_A Brand', version: '24.0.0.0' }
  ]
  return { brands, fullVersionList }
}

/**
 * `getHighEntropyValues()` 的返回值。
 *
 * 不读宿主：architecture 在 x64 上**就是 "x86"**（x86-64 的 ISA 族名），
 * 写 "x86_64" 是把自己机器字的宽度当成 API 值。model 桌面恒空串，
 * wow64 桌面恒 false；platformVersion 跟系统走，Linux 报内核版本而不是 macOS 的 15。
 */
export function resolveUaHighEntropy(fp: FingerprintConfig): Record<string, unknown> {
  const { brands, fullVersionList } = resolveUaBrands(fp)
  return {
    architecture: 'x86',
    bitness: '64',
    model: '',
    platform: fp.os === 'windows' ? 'Windows' : fp.os === 'macos' ? 'macOS' : 'Linux',
    platformVersion: fp.os === 'linux' ? '6.8.0' : '15.0.0',
    uaFullVersion: fp.uaVersion,
    fullVersionList,
    brands,
    mobile: false,
    wow64: false,
    formFactors: ['Desktop']
  }
}

export interface WebgpuAdapterInfo {
  vendor: string
  architecture: string
  device: string
  description: string
}

/**
 * `GPUAdapter.info` 只能给到 vendor 一个可信维度。
 *
 * architecture / device 要从 `webgl.renderer` 的 ANGLE 串里拆，但 WebGPU 的
 * `adapter.info.vendor` 枚举与 WebGL vendor 不是一一对应（ANGLE 的 NVIDIA
 * 在 Dawn 里报 "nvidia"，Apple 报 "apple"，Intel 报 "intel"）。能稳定映射的
 * 只有这三个前缀；拆不出来的部分**留空**，不编一个看似合理的型号 ——
 * 编的 device 会和 `adapter.limits` / 实际驱动行为对不上。
 */
export function resolveWebgpuAdapterInfo(fp: FingerprintConfig): WebgpuAdapterInfo {
  const v = fp.webgl.vendor.toLowerCase()
  let vendor = ''
  if (v.includes('nvidia')) vendor = 'nvidia'
  else if (v.includes('apple')) vendor = 'apple'
  else if (v.includes('intel')) vendor = 'intel'
  else if (v.includes('amd') || v.includes('radeon')) vendor = 'amd'
  return { vendor, architecture: '', device: '', description: '' }
}

/**
 * 真桌面 Chrome 是否在 `Navigator.prototype` 上暴露 Web Share（share / canShare）。
 *
 * 这是「造不造属性」这条决策的**唯一真值**，注入脚本经 `C.webShare` 取用。
 * 判据全部来自实测，不靠印象：
 *   - windows：true —— Windows Chrome 156 实测 `'share' in navigator === true`。
 *   - linux：  false —— Linux Chrome 157（headless + headful、secure context）实测
 *                       `'share' / 'canShare' in navigator === false`。
 *   - macos：  false —— **未测量**，保守取“不造”。属性存在性比值更硬，凭空造一个
 *                       真 Chrome 没有的属性是比漏掉更糟的 tell；若 macOS Chrome
 *                       实际有这两个 API，那是一个已知的未观测缺口，等实测再改，
 *                       不在这里凭猜测补齐。
 */
export function webShareSupportedOn(os: OSKind): boolean {
  return os === 'windows'
}

/** 缺省 connection：一次正常宽带，不是每次读都抖的随机值 */
export const DEFAULT_CONNECTION = {
  effectiveType: '4g' as const,
  downlink: 10,
  rtt: 50,
  saveData: false
}

/** 桌面没有电池时 Chrome 的 getBattery() 读数 */
export const DEFAULT_BATTERY = {
  charging: true,
  level: 1,
  chargingTime: 0,
  dischargingTime: Infinity
}

export const DEFAULT_MEDIA_DEVICES = {
  videoInput: 0,
  audioInput: 0,
  audioOutput: 0
}

/**
 * storage.estimate() 的 quota 是**钉死的常量**。
 *
 * 真实 quota 由宿主磁盘剩余空间算出来，把它透出去等于暴露「这台机器盘多大」。
 * 10 GiB 是真实浏览器上常见的配额量级，.usage 很小也符合新 profile。
 */
export const DEFAULT_STORAGE_QUOTA = 10737418240

/**
 * 老盘 profile 缺新增面时补齐。
 *
 * 为什么放在这里而不是 store 层：store 的 `validateProfiles` 只检查形状不补值，
 * 而在 fingerprint 生成与注入脚本之间还有 buildFingerprint / uaMetadata 等多个
 * 读取点。补在唯一的「解析指纹」入口（resolveFingerprint）和注入脚本的入口，
 * 任何一个 profile 都不会带着 undefined 走到页面里。
 */
export function applySurfaceDefaults(fp: FingerprintConfig): ResolvedFingerprintConfig {
  const out: ResolvedFingerprintConfig = {
    ...fp,
    // 老盘上这两项是必填 boolean，但早于它们写入的 profile 里根本不存在。
    // `...fp` 不会补，于是它们是 undefined —— 消费点 `if (C.rectNoise)`
    // 把 undefined 当关闭、`if (!C.webgpu)` 把 undefined 当「删掉 navigator.gpu」，
    // 结果老环境静默失去伪装，而且没有任何报错。
    //   clientRectsNoise：真实 Chrome 有 ClientRects 噪声，缺省必须开。
    //   webgpu：Linux 上没有 WebGPU（删 navigator.gpu 才像 Linux），按 OS 决定。
    clientRectsNoise: typeof fp.clientRectsNoise === 'boolean' ? fp.clientRectsNoise : true,
    webgpu: typeof fp.webgpu === 'boolean' ? fp.webgpu : fp.os !== 'linux',
    maxTouchPoints: typeof fp.maxTouchPoints === 'number' ? fp.maxTouchPoints : 0,
    connection: {
      effectiveType: fp.connection?.effectiveType ?? DEFAULT_CONNECTION.effectiveType,
      downlink: fp.connection?.downlink ?? DEFAULT_CONNECTION.downlink,
      rtt: fp.connection?.rtt ?? DEFAULT_CONNECTION.rtt,
      saveData: fp.connection?.saveData ?? DEFAULT_CONNECTION.saveData
    },
    battery: {
      charging: fp.battery?.charging ?? DEFAULT_BATTERY.charging,
      level: fp.battery?.level ?? DEFAULT_BATTERY.level,
      chargingTime: fp.battery?.chargingTime ?? DEFAULT_BATTERY.chargingTime,
      dischargingTime: fp.battery?.dischargingTime ?? DEFAULT_BATTERY.dischargingTime
    },
    mediaDevices: {
      videoInput: fp.mediaDevices?.videoInput ?? DEFAULT_MEDIA_DEVICES.videoInput,
      audioInput: fp.mediaDevices?.audioInput ?? DEFAULT_MEDIA_DEVICES.audioInput,
      audioOutput: fp.mediaDevices?.audioOutput ?? DEFAULT_MEDIA_DEVICES.audioOutput
    },
    permissions:
      fp.permissions && typeof fp.permissions === 'object'
        ? { ...DEFAULT_PERMISSION_STATES, ...fp.permissions }
        : { ...DEFAULT_PERMISSION_STATES },
    mediaCapabilities: fp.mediaCapabilities === undefined ? true : fp.mediaCapabilities,
    plugins: fp.plugins === 'chrome-pdf' || fp.plugins === 'none' ? fp.plugins : 'chrome-pdf',
    storageEstimate: fp.storageEstimate === undefined ? true : fp.storageEstimate,
    uaHighEntropy: fp.uaHighEntropy === undefined ? true : fp.uaHighEntropy,
    // 老盘的 'noise' / 'off' 原样保留；只有非法值才退回安全缺省。
    canvas:
      fp.canvas === 'noise' || fp.canvas === 'off' || fp.canvas === 'block' ? fp.canvas : 'noise',
    audio: fp.audio === 'noise' || fp.audio === 'off' || fp.audio === 'block' ? fp.audio : 'noise'
  }
  return out
}

/** 从模板生成一套完整指纹（seed 参与微扰，保证同 seed 同结果） */
export function resolveFingerprint(
  os: OSKind,
  seed: string,
  overrides: Partial<FingerprintConfig> = {}
): FingerprintConfig {
  const t = OS_TEMPLATES[os]
  const base: FingerprintConfig = {
    os,
    osLabel: t.label,
    userAgent: t.userAgent,
    uaVersion: CHROME_VERSION,
    timezone: t.timezone,
    locale: t.locale,
    languages: [...t.languages],
    geolocation: TIMEZONE_GEO[t.timezone] ?? null,
    screen: { ...t.screen },
    hardware: { ...t.hardware },
    webgl: { ...t.webgl },
    canvas: 'noise',
    audio: 'noise',
    webrtc: 'proxy',
    fonts: [...t.fonts],
    clientRectsNoise: true,
    webgpu: os !== 'linux',
    maxTouchPoints: 0,
    connection: { ...DEFAULT_CONNECTION },
    battery: { ...DEFAULT_BATTERY },
    mediaDevices: { ...DEFAULT_MEDIA_DEVICES },
    permissions: { ...DEFAULT_PERMISSION_STATES },
    mediaCapabilities: true,
    plugins: 'chrome-pdf',
    storageEstimate: true,
    uaHighEntropy: true
  }
  // seed 参与确定性微扰：同 seed 恒定，不同 seed 有差异
  const h = hashSeed(seed)
  const screens: Array<[number, number, number]> = [
    [1920, 1080, 1],
    [2560, 1440, 1],
    [1536, 864, 1.25],
    [1440, 900, 1],
    [1680, 1050, 1]
  ]
  if (os === 'windows') {
    const pick = screens[h % screens.length]
    base.screen = { width: pick[0], height: pick[1], dpr: pick[2], colorDepth: 24 }
    base.hardware = { cpuCores: [4, 6, 8, 12, 16][h % 5], memoryGB: [8, 16, 32][h % 3] }
  }
  // 先合并 overrides 再补齐：老盘上只有部分新增字段的 profile 传进来时，
  // 缺的那几项仍然是完整缺省，绝不能是 undefined。
  return applySurfaceDefaults({ ...base, ...overrides })
}

function hashSeed(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}
