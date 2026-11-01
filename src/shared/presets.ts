/**
 * 内置预设：模型服务商、默认设置、指纹平台模板。
 *
 * 这里的值是「开箱可用」的默认值，不是唯一事实。
 * 指纹模板在生成 Profile 时被解析成 FingerprintConfig 的具体值并落库，
 * 之后再改本文件不会影响已有环境（避免指纹漂移）。
 */

import type { FingerprintConfig, Settings, OSKind } from './types'

/* ────────────────────────────── 模型服务商 ────────────────────────────── */

export interface ProviderPreset {
  id: string
  label: string
  baseUrl: string
  model: string
  /** 是否需要 API Key。本地推理服务填 false */
  needKey: boolean
  hint: string
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    needKey: true,
    hint: '性价比高，中文指令跟随好'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    needKey: true,
    hint: '官方接口，需可访问的网络'
  },
  {
    id: 'qwen',
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    needKey: true,
    hint: '阿里云 DashScope 兼容模式'
  },
  {
    id: 'kimi',
    label: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-32k',
    needKey: true,
    hint: '长上下文，适合整页理解'
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-plus',
    needKey: true,
    hint: '注意路径含 /v4'
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-72B-Instruct',
    needKey: true,
    hint: '多模型聚合，可自填模型名'
  },
  {
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:14b',
    needKey: false,
    hint: '本地推理，免 Key'
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-model',
    needKey: false,
    hint: '本地推理，需在 LM Studio 里开服务'
  },
  {
    id: 'custom',
    label: '自定义',
    baseUrl: '',
    model: '',
    needKey: true,
    hint: '任何兼容 /chat/completions 的服务'
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
    webgpu: os !== 'linux'
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
  return { ...base, ...overrides }
}

function hashSeed(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}
