/**
 * 指纹模板与迁移包模块。
 *
 * 职责：
 * - 首次启动时用内置平台预设生成三张只读模板（Windows / macOS / Linux）
 * - 把某个环境的整套指纹参数存成可复用模板
 * - 模板应用到其他环境（只换指纹，保留环境名、代理、标签）
 * - 迁移包导出/导入（跨机器搬环境，不含任何明文密钥）
 *
 * 归属：template-agent
 */

import { CH } from '@shared/ipc'
import type { MigrationAdoptReport, MigrationImportResult } from '@shared/ipc'
import { OS_TEMPLATES, resolveFingerprint } from '@shared/presets'
import type {
  BundleSealHeader,
  FingerprintConfig,
  FingerprintTemplate,
  MigrationBundle,
  MigrationBundleEntry,
  MigrationBundleV1,
  MigrationBundleV2,
  MigrationProfile,
  MigrationProxy,
  OSKind,
  Profile,
  ProxyProtocol,
  ProxyRecord
} from '@shared/types'
import { BUNDLE_VERSION, MIN_PASSWORD_LENGTH, createOpener, createSealer } from '@main/core/portable-seed'
import { CollectionStore } from '@main/store'
import { appendAudit } from './audit'
import type { ModuleContext } from './context'

const OS_KINDS: readonly OSKind[] = ['windows', 'macos', 'linux']
const PROXY_PROTOCOLS: readonly ProxyProtocol[] = ['http', 'https', 'socks5']
const CANVAS_MODES = ['noise', 'off'] as const
const WEBRTC_MODES = ['proxy', 'disabled', 'real'] as const

/* ────────────────────────────── 内置模板 ────────────────────────────── */

/**
 * 内置模板的说明文案按平台写死，而不是从预设里读：
 * 预设文件只描述「参数是什么」，用户看到的「为什么长这样」属于产品文案，
 * 放在这里改动不会牵连指纹引擎。
 */
const BUILTIN_DESC: Record<OSKind, string> = {
  windows: '内置预设：Windows 11 桌面，UA、字体白名单与 WebGL 渲染器对齐真实机器',
  macos: '内置预设：macOS Sequoia，含 Apple Metal 渲染器与 Retina 分辨率',
  linux: '内置预设：Ubuntu GNOME，集成显卡特征，默认不开启 WebGPU'
}

/**
 * 已确认写过内置模板就不再重复检查。
 * 模板列表在正常使用中永远非空（内置模板不可删除），但首次调用可能并发进来两次，
 * 用一个进程内标记挡住第二次，避免同一套内置模板被写两遍。
 */
let builtinsReady = false

function buildBuiltin(os: OSKind, createdAt: number): FingerprintTemplate {
  const preset = OS_TEMPLATES[os]
  // 固定 seed 而不是随机：内置模板必须每次重建都得到同一套参数，
  // 否则用户清空数据后，同一张卡片上的分辨率、核数会莫名其妙地变。
  const fingerprint = resolveFingerprint(os, `builtin:${os}`, {
    // resolveFingerprint 会用 seed 给 Windows 随机挑分辨率和核数，
    // 内置模板要的是「预设里写的那一套」，所以显式覆盖回去。
    screen: { ...preset.screen },
    hardware: { ...preset.hardware }
  })

  return {
    id: CollectionStore.newId('tpl'),
    name: preset.label,
    description: BUILTIN_DESC[os],
    os,
    fingerprint,
    builtin: true,
    createdAt
  }
}

function ensureBuiltinTemplates(ctx: ModuleContext): FingerprintTemplate[] {
  const store = ctx.stores.templates
  const existing = store.list()
  if (builtinsReady || existing.length > 0) {
    builtinsReady = true
    return existing
  }

  const now = Date.now()
  // 三个平台的 createdAt 依次递增，列表按时间排序时顺序稳定
  OS_KINDS.map((os, index) => buildBuiltin(os, now + index)).forEach((tpl) => store.add(tpl))
  builtinsReady = true
  return store.list()
}

/* ────────────────────────────── 模板读写 ────────────────────────────── */

function saveTemplate(
  ctx: ModuleContext,
  fromProfileId: string,
  name: string,
  description?: string
): FingerprintTemplate {
  const profile = ctx.stores.profiles.get(fromProfileId)
  if (profile === null) throw new Error(`环境不存在：${fromProfileId}`)

  const trimmed = name.trim()
  if (trimmed === '') throw new Error('模板名称不能为空')

  const template: FingerprintTemplate = {
    id: CollectionStore.newId('tpl'),
    name: trimmed,
    description: description?.trim() || undefined,
    os: profile.fingerprint.os,
    // 深拷贝：模板是快照，之后改环境的指纹不该让模板跟着漂移
    fingerprint: structuredClone(profile.fingerprint),
    builtin: false,
    createdAt: Date.now()
  }
  return ctx.stores.templates.add(template)
}

/**
 * 应用模板 = 把模板里的整套参数克隆到目标环境。
 *
 * 语义上这是「同一个身份多开」：seed 保持不动，只覆盖站点能观测到的参数，
 * 于是两台机器看到的是同一个「人」。需要一份全新身份时应该走 profiles.regenerate
 * （重掷种子并重新生成整套参数），而不是换一张模板。
 */
function applyTemplate(ctx: ModuleContext, templateId: string, profileId: string): Profile {
  const template = ctx.stores.templates.get(templateId)
  if (template === null) throw new Error(`模板不存在：${templateId}`)

  const profile = ctx.stores.profiles.get(profileId)
  if (profile === null) throw new Error(`环境不存在：${profileId}`)

  const fingerprint = structuredClone(template.fingerprint)
  // platform / browserVersion 是 fingerprint 的冗余投影，必须一起改，
  // 否则卡片上显示的平台会和实际 UA 对不上。
  return ctx.stores.profiles.update(profileId, {
    fingerprint,
    platform: fingerprint.os,
    browserVersion: fingerprint.uaVersion
  })
}

function removeTemplate(ctx: ModuleContext, id: string): void {
  const template = ctx.stores.templates.get(id)
  if (template === null) throw new Error(`模板不存在：${id}`)
  if (template.builtin) {
    throw new Error('内置模板不可删除：它是按平台生成指纹的基准，只能删除自己保存的模板')
  }
  ctx.stores.templates.remove(id)
}

/* ────────────────────────────── 迁移包：导出 ────────────────────────────── */

/** 代理去重键。主机名大小写不敏感，凭据相同才算同一个出口 */
function proxyKeyOf(protocol: string, host: string, port: number, username?: string): string {
  return `${protocol}|${host.trim().toLowerCase()}|${port}|${(username ?? '').trim()}`
}

function exportBundle(ctx: ModuleContext, profileIds: string[], rawPassword: unknown): string {
  const ids = Array.from(new Set(profileIds.map((id) => id.trim()).filter((id) => id !== '')))
  if (ids.length === 0) throw new Error('请先选择要导出的环境')

  const password = assertPassword(rawPassword)
  // 先建封装器：口令太短要在读任何环境数据**之前**就拒掉。
  // 反过来写（先收集再校验口令）会让一次注定失败的导出也把全部 seed 在内存里
  // 过一遍，而这次导出的失败原因恰恰是「口令太弱」。
  const sealer = createSealer(password)

  const entries: MigrationBundleEntry[] = []
  const proxies = new Map<string, MigrationProxy>()

  ids.forEach((id, index) => {
    // 导出必须拿内部形态：包里要封 seed
    const profile = ctx.stores.profiles.getStored(id)
    if (profile === null) throw new Error(`第 ${index + 1} 个环境不存在：${id}`)

    let proxyKey: string | undefined
    const proxy = profile.proxy
    if (proxy !== null) {
      proxyKey = proxyKeyOf(proxy.type, proxy.host, proxy.port, proxy.username)
      if (!proxies.has(proxyKey)) {
        proxies.set(proxyKey, {
          key: proxyKey,
          // ProxyConfig 没有独立名字，用地址当显示名，导入方能一眼看出是哪个出口
          name: `${proxy.host}:${proxy.port}`,
          protocol: proxy.type,
          host: proxy.host,
          port: proxy.port,
          username: proxy.username,
          // 迁移包可能在聊天工具里传来传去，密码一律留空，由导入方自行补齐
          password: ''
        })
      }
    }

    // 明文层只放 name + platform：够人核对「这个包里有哪几个环境」，
    // 不含任何身份参数。`note` 进密封层 —— 它经常写着「主店，卡尾号 XXXX」，
    // 泄露它和泄露身份是同一级别的事。
    //
    // 分组、标签、颜色仍然不导出：它们属于本机组织方式，带过去只会和目标机器
    // 的习惯打架。这一点与 v1 相同。
    const plain = { name: profile.name, platform: profile.platform }
    const sealed = sealer.seal(
      plain,
      {
        seed: profile.seed,
        fingerprint: structuredClone(profile.fingerprint),
        note: profile.note || undefined,
        proxyKey
      },
      index
    )

    entries.push({ name: plain.name, platform: plain.platform, sealed })
  })

  const bundle: MigrationBundleV2 = {
    version: 2,
    exportedAt: Date.now(),
    app: 'ShadowSurf',
    header: sealer.header,
    entries,
    proxies: Array.from(proxies.values())
  }
  // 缩进 2 空格：迁移包经常被人打开肉眼核对，可读性优先于体积
  return JSON.stringify(bundle, null, 2)
}

function assertPassword(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('参数「password」必须是字符串')
  if (raw.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `口令至少 ${String(MIN_PASSWORD_LENGTH)} 个字符：这个包一旦泄露，里面的身份就全部泄露`
    )
  }
  return raw
}

/* ────────────────────────────── 迁移包：校验 ────────────────────────────── */

function fail(message: string): never {
  throw new Error(message)
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function reqString(obj: Record<string, unknown>, key: string, path: string): string {
  const value = obj[key]
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${path} 缺少必填字段「${key}」`)
  }
  return value
}

function optString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function reqNumber(obj: Record<string, unknown>, key: string, path: string): number {
  const value = obj[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${path} 的「${key}」必须是数字`)
  }
  return value
}

function reqBool(obj: Record<string, unknown>, key: string, path: string): boolean {
  const value = obj[key]
  if (typeof value !== 'boolean') fail(`${path} 的「${key}」必须是布尔值`)
  return value
}

function reqEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly T[]
): T {
  const value = reqString(obj, key, path)
  if (!(allowed as readonly string[]).includes(value)) {
    fail(`${path} 的「${key}」只能是 ${allowed.join(' / ')}，收到「${value}」`)
  }
  return value as T
}

function reqStringArray(obj: Record<string, unknown>, key: string, path: string): string[] {
  const value = obj[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(`${path} 的「${key}」必须是字符串数组`)
  }
  return value.slice() as string[]
}

function parseGeolocation(value: unknown, path: string): FingerprintConfig['geolocation'] {
  // 经纬度允许为空（直连且不关心地理位置的环境），空值不算缺字段
  if (value === null || value === undefined) return null
  const record = asRecord(value, path)
  return {
    latitude: reqNumber(record, 'latitude', path),
    longitude: reqNumber(record, 'longitude', path)
  }
}

function parseFingerprint(raw: unknown, where: string): FingerprintConfig {
  const path = `${where} 的 fingerprint`
  const record = asRecord(raw, path)
  const screen = asRecord(record.screen, `${path}.screen`)
  const hardware = asRecord(record.hardware, `${path}.hardware`)
  const webgl = asRecord(record.webgl, `${path}.webgl`)

  return {
    os: reqEnum(record, 'os', path, OS_KINDS),
    osLabel: reqString(record, 'osLabel', path),
    userAgent: reqString(record, 'userAgent', path),
    uaVersion: reqString(record, 'uaVersion', path),
    timezone: reqString(record, 'timezone', path),
    locale: reqString(record, 'locale', path),
    languages: reqStringArray(record, 'languages', path),
    geolocation: parseGeolocation(record.geolocation, `${path}.geolocation`),
    screen: {
      width: reqNumber(screen, 'width', `${path}.screen`),
      height: reqNumber(screen, 'height', `${path}.screen`),
      dpr: reqNumber(screen, 'dpr', `${path}.screen`),
      colorDepth: reqNumber(screen, 'colorDepth', `${path}.screen`)
    },
    hardware: {
      cpuCores: reqNumber(hardware, 'cpuCores', `${path}.hardware`),
      memoryGB: reqNumber(hardware, 'memoryGB', `${path}.hardware`)
    },
    webgl: {
      vendor: reqString(webgl, 'vendor', `${path}.webgl`),
      renderer: reqString(webgl, 'renderer', `${path}.webgl`)
    },
    canvas: reqEnum(record, 'canvas', path, CANVAS_MODES),
    audio: reqEnum(record, 'audio', path, CANVAS_MODES),
    webrtc: reqEnum(record, 'webrtc', path, WEBRTC_MODES),
    fonts: reqStringArray(record, 'fonts', path),
    clientRectsNoise: reqBool(record, 'clientRectsNoise', path),
    webgpu: reqBool(record, 'webgpu', path)
  }
}

function parseMigrationProfile(raw: unknown, index: number): MigrationProfile {
  const where = `迁移包第 ${index + 1} 个环境`
  const record = asRecord(raw, where)
  return {
    name: reqString(record, 'name', where),
    platform: reqEnum(record, 'platform', where, OS_KINDS),
    note: optString(record, 'note'),
    fingerprint: parseFingerprint(record.fingerprint, where),
    proxyKey: optString(record, 'proxyKey')
  }
}

function parseMigrationProxy(raw: unknown, index: number): MigrationProxy {
  const where = `迁移包第 ${index + 1} 个代理`
  const record = asRecord(raw, where)
  const host = reqString(record, 'host', where)
  const port = reqNumber(record, 'port', where)
  if (port <= 0 || port > 65535) fail(`${where} 的端口 ${port} 不在 1–65535 之间`)
  return {
    key: reqString(record, 'key', where),
    name: optString(record, 'name') ?? `${host}:${port}`,
    protocol: reqEnum(record, 'protocol', where, PROXY_PROTOCOLS),
    host,
    port,
    username: optString(record, 'username'),
    password: optString(record, 'password')
  }
}

function parseBundle(raw: string): MigrationBundle {
  const text = raw.trim()
  if (text === '') throw new Error('迁移包内容为空：请粘贴 JSON 或选择文件')

  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`迁移包不是合法的 JSON：${detail}`)
  }

  const root = asRecord(data, '迁移包')
  const version = root.version

  // 版本号是唯一的兼容性开关：宁可明确拒绝，也不要按旧格式猜字段。
  //
  // 对**更高**版本单独给一句话，因为那句「请升级应用」是唯一有用的建议。
  // 混在「不支持 version X」里，用户会以为包坏了，然后回去重新导出一遍 ——
  // 而他能导出的仍然是同一台机器上的同一个版本。
  if (version !== 1 && version !== BUNDLE_VERSION) {
    if (typeof version === 'number' && version > BUNDLE_VERSION) {
      throw new Error(
        `此包由更新版本的 ShadowSurf 创建（version=${String(version)}，本版本最高支持 ${String(BUNDLE_VERSION)}）。` +
          '请升级应用后再导入 —— 按本版本的格式猜字段，会得到一批看起来正常、实际身份不对的环境。'
      )
    }
    throw new Error(
      `不支持的迁移包版本：${String(version)}（本版本支持 1 和 ${String(BUNDLE_VERSION)}）`
    )
  }
  if (root.proxies !== undefined && !Array.isArray(root.proxies)) {
    fail('迁移包的「proxies」必须是数组')
  }

  const proxies = ((root.proxies ?? []) as unknown[]).map(parseMigrationProxy)
  const exportedAt = typeof root.exportedAt === 'number' ? root.exportedAt : Date.now()
  const app = typeof root.app === 'string' ? root.app : 'ShadowSurf'

  if (version === 1) {
    if (!Array.isArray(root.profiles)) fail('迁移包缺少必填字段「profiles」')
    const v1: MigrationBundleV1 = {
      version: 1,
      exportedAt,
      app,
      profiles: (root.profiles as unknown[]).map(parseMigrationProfile),
      proxies
    }
    return v1
  }

  if (!Array.isArray(root.entries)) fail('环境包缺少必填字段「entries」')
  const v2: MigrationBundleV2 = {
    version: 2,
    exportedAt,
    app,
    header: parseSealHeader(root.header),
    entries: (root.entries as unknown[]).map(parseBundleEntry),
    proxies
  }
  return v2
}

/**
 * 这里只断言「是个对象」，真正的参数逐项校验在 `portable-seed` 的 `assertHeader` 里。
 *
 * 分开写不是为了少做一次检查，而是因为那条校验的位置**必须**在派生密钥之前：
 * 一个 `n: 2**30` 的包能让导入方分配几十 GB，等解到一半才发现参数不对就已经晚了。
 * 把校验留在那个模块里，它就和「先验参数再 scrypt」这个顺序绑在一起，搬不走。
 */
function parseSealHeader(raw: unknown): BundleSealHeader {
  const rec = asRecord(raw, '环境包的口令派生头（kdf）')
  return rec as unknown as BundleSealHeader
}

function parseBundleEntry(raw: unknown, index: number): MigrationBundleEntry {
  const where = `环境包第 ${String(index + 1)} 条`
  const rec = asRecord(raw, where)
  const sealed = asRecord(rec.sealed, where + ' 的密文段（sealed）')
  return {
    name: reqString(rec, 'name', where),
    platform: reqEnum(rec, 'platform', where, OS_KINDS),
    sealed: {
      iv: reqString(sealed, 'iv', where + ' 的密文段'),
      tag: reqString(sealed, 'tag', where + ' 的密文段'),
      ct: reqString(sealed, 'ct', where + ' 的密文段')
    }
  }
}

/* ────────────────────────────── 迁移包：导入 ────────────────────────────── */

/**
 * 重名自动加「副本 N」后缀。
 * 直接覆盖或静默跳过都会让用户以为导入失败，加后缀是唯一能看出「多了一份」的做法。
 */
function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} 副本 ${n}`
    if (!taken.has(candidate)) return candidate
  }
  fail(`环境名「${base}」的副本过多，请先清理重名环境`)
}

/**
 * v1 包导入后**具体会变**的东西。
 *
 * 写「身份会变」是没用的 —— 用户无法据此判断该不该继续，也无法在事后核对
 * 到底变了什么。这里每一条都对应一个真实机制，且都能被验证。
 *
 * 有一条需要特别说清楚：v1 包**是带 `fingerprint` 的**（它明文放在包里），
 * 所以导入后 UA / 屏幕 / 时区 / 语言这些**参数会原样保留**。真正变的是 `seed`，
 * 而 `seed` 是注入脚本的噪声种子（`fingerprint.ts` 里 `h32()` 把 `S` 直接
 * XOR 进去）。于是结果是「参数全对、噪声全变」—— 站点拿到的指纹哈希变了，
 * 用户却看不出任何区别。这种状态比「参数明显变了」更难发现，所以更要提前说。
 */
const LOST_FIELDS_V1: readonly string[] = [
  'seed（环境身份根）：导入后由本机 master.key 重新派生，与包里那个不是同一个',
  'canvas 噪声序列：注入脚本把 seed 当噪声种子（h32 里 XOR 进 S），seed 一变，每个像素的偏移都变',
  'audio / WebGL 等所有经 seed 抖动的读数：同上，整条序列一起变',
  '站点侧的指纹哈希：上面两项一变，站点算出的 visitor id 就变，风控会把这台机器当成新设备',
  '与 seed 的自洽性：fingerprint 参数会原样保留，但按新 seed 重算会得到另一套；此后任何「按 seed 重建指纹」的操作（重掷种子、应用模板、克隆时换指纹）都会把环境改成另一个样子',
  '代理密码：v1 包一律留空，需导入后自行补齐（这一条与 v2 相同，不是 v1 独有）'
]

/**
 * 「这个包会换掉身份，你确认吗」不是一个普通错误，所以它带 `code` 和结构化字段。
 *
 * 为什么用抛异常而不是返回 `{ ok:false }`：`ctx.handle` 的统一信封已经把
 * 「失败」表达成 `{ ok:false, error }`。再在 data 里套一层 `ok:false`，渲染层
 * 就要判断两层 ok，而漏判的那次表现是「弹了确认框但什么都没发生」。
 */
class LegacyIdentityLossError extends Error {
  readonly code = 'legacy-identity-loss'
  readonly lostFields: string[]

  constructor() {
    super(
      '这个迁移包是旧格式（version 1），里面不含任何身份参数。导入本身会成功，' +
        '但导入后的环境与包里那些**不是同一个身份** —— 站点会把它当成一台新设备。' +
        '要继续，需要显式确认。'
    )
    this.name = 'LegacyIdentityLossError'
    this.lostFields = [...LOST_FIELDS_V1]
  }
}

function importBundle(
  ctx: ModuleContext,
  json: string,
  rawPassword: unknown,
  acceptLegacyIdentityLoss: unknown
): MigrationImportResult {
  const bundle = parseBundle(json)

  if (bundle.version === 1) {
    if (acceptLegacyIdentityLoss !== true) {
      // 这里在解析之后、**任何 store 调用之前**就返回。
      // 「不写任何文件」靠的不是事后清理，而是顺序：没有「先建一半再问」的可能。
      throw new LegacyIdentityLossError()
    }
    const result = importV1(ctx, bundle)
    // 用户确认过「身份会变」，这条必须留痕。
    // 将来他发现某个店铺被风控，需要能查到「这批环境是某天用旧包导进来的」——
    // 没有这条记录，那天就只是一次「正常的导入」。
    appendAudit(
      ctx.stores,
      'migration.import.legacy',
      `${String(result.profiles)} 个环境`,
      `确认以旧格式（v1）导入：seed 重新派生，身份未搬迁；代理 ${String(result.proxies)} 个`
    )
    return result
  }

  return importV2(ctx, bundle, rawPassword)
}

/** v1：包里只有可见信息，seed 由本机重新派生 —— 这就是「身份没搬过来」 */
function importV1(ctx: ModuleContext, bundle: MigrationBundleV1): MigrationImportResult {
  if (bundle.profiles.length === 0) throw new Error('迁移包里没有任何环境')

  // 落盘前先做一次整体校验。原来这段校验放在创建环境的 forEach 里，
  // 结果是前几个环境已经写进库、第 N 个才发现引用错了，留下半截数据。
  // 引用错误是纯静态可判的，没有任何理由拖到写了一半才发现。
  const bundleProxyKeys = new Set(bundle.proxies.map((item) => item.key))
  bundle.profiles.forEach((item, index) => {
    if (item.proxyKey !== undefined && !bundleProxyKeys.has(item.proxyKey)) {
      throw new Error(
        `迁移包第 ${index + 1} 个环境引用的代理「${item.proxyKey}」不在迁移包中，已取消整批导入`
      )
    }
  })

  // 先建代理：环境要按 key 引用代理，顺序反了就只能拿到空引用
  const { keyToProxy, created: createdProxies } = importProxies(ctx, bundle.proxies)

  const taken = new Set(ctx.stores.profiles.list().map((profile) => profile.name))
  const written: string[] = []
  const adopted: MigrationAdoptReport[] = []

  try {
    for (const item of bundle.profiles) {
      const created = ctx.stores.profiles.create({
        name: uniqueName(item.name, taken),
        platform: item.platform,
        fingerprint: structuredClone(item.fingerprint),
        proxy: proxyConfigOf(
          item.proxyKey !== undefined ? keyToProxy.get(item.proxyKey) : undefined
        )
      })
      written.push(created.id)
      taken.add(created.name)

      // CreateProfileInput 没有 note 字段，只能建完再补一次。
      if (item.note !== undefined) {
        ctx.stores.profiles.update(created.id, { note: item.note })
      }

      // v1 没有可比的东西：包里没有 seed，所以「搬过来的身份是不是同一个」
      // 这个问题的答案是「没有搬过来」。这里如实写进报告，而不是省掉这一栏 ——
      // 空列表和「明确说没搬」在界面上是两种完全不同的信息。
      adopted.push({
        name: created.name,
        ok: false,
        compared: [
          { field: 'seed', from: '(v1 包不含 seed)', to: created.seedHint + '…（本机新派生）' },
          { field: 'fingerprint 参数', from: '包内原值', to: '原样写回（未重算）' }
        ]
      })
    }
  } catch (err) {
    rollback(ctx, written, createdProxies)
    throw err
  }

  return { profiles: written.length, proxies: createdProxies.length, adopted }
}

/**
 * v2：解全部 → 校验全部 → 才写盘。
 *
 * 这个顺序是硬要求，不是风格。流式导入（解一条写一条）在第 N 条口令/密文出错时，
 * 会在库里留下前 N-1 条**身份正确**的环境和一条都没有的失败提示 —— 用户看到
 * 「导入失败」，实际却已经搬进来一半。半导入的身份比没有更糟：他会去重试，
 * 于是同一批身份在库里出现两份。
 */
function importV2(
  ctx: ModuleContext,
  bundle: MigrationBundleV2,
  rawPassword: unknown
): MigrationImportResult {
  if (bundle.entries.length === 0) throw new Error('环境包里没有任何环境')
  if (typeof rawPassword !== 'string' || rawPassword === '') {
    throw new Error('这个环境包需要口令才能打开：没有口令无法解开里面的身份')
  }

  const opener = createOpener(bundle.header, rawPassword)

  // ── 第一步：全部解密。一条解不开就整批不做 ──
  const opened = bundle.entries.map((entry, index) => {
    const payload = opener.open(
      entry.sealed,
      { name: entry.name, platform: entry.platform },
      index
    )
    const fingerprint = asBundleFingerprint(payload.fingerprint, `「${entry.name}」`)
    // AAD 绑定了明文的 name|platform，所以这两项改不了。但**密文里**的
    // `fingerprint.os` 是导出方写的，GCM 只保证它没被改过，不保证它和明文层一致。
    // 一个平台写 windows、指纹写 macos 的包能解开，但导入后会得到一条
    // 「列表说 windows、注入按 macos 走」的环境 —— 这种自相矛盾要在写盘前挡掉。
    if (fingerprint.os !== entry.platform) {
      throw new Error(
        `「${entry.name}」的平台自相矛盾：包内明文写的是 ${entry.platform}，` +
          `密文里的指纹是 ${String(fingerprint.os)}。已取消整批导入。`
      )
    }
    return { entry, payload, fingerprint }
  })

  // ── 第二步：全部校验。代理引用错是纯静态可判的 ──
  const bundleProxyKeys = new Set(bundle.proxies.map((item) => item.key))
  opened.forEach(({ entry, payload }, index) => {
    if (payload.proxyKey !== undefined && !bundleProxyKeys.has(payload.proxyKey)) {
      throw new Error(
        `环境包第 ${index + 1} 个环境（${entry.name}）引用的代理「${payload.proxyKey}」不在包中，已取消整批导入`
      )
    }
  })

  // ── 第三步：才写盘 ──
  const { keyToProxy, created: createdProxies } = importProxies(ctx, bundle.proxies)
  const taken = new Set(ctx.stores.profiles.list().map((profile) => profile.name))
  const written: string[] = []
  const adopted: MigrationAdoptReport[] = []

  try {
    for (const { entry, payload, fingerprint } of opened) {
      const result = ctx.stores.profiles.adopt(
        {
          name: uniqueName(entry.name, taken),
          platform: entry.platform,
          fingerprint,
          proxy: proxyConfigOf(
            payload.proxyKey !== undefined ? keyToProxy.get(payload.proxyKey) : undefined
          )
        },
        payload.seed
      )

      adopted.push({
        name: result.profile === null ? entry.name : result.profile.name,
        ok: result.ok,
        compared: result.compared
      })

      if (result.profile === null) {
        // adopt 已经把自己写进去的那一条回滚了，但前面几条还在 —— 一起撤掉
        const diff = result.compared
          .filter((row) => row.from !== row.to)
          .slice(0, 3)
          .map((row) => `${row.field}：包内 ${row.from} → 盘上 ${row.to}`)
          .join('；')
        throw new Error(
          `「${entry.name}」写盘后从盘上读回来的身份与包里的不一致，已回滚整批导入。` +
            (diff === '' ? '（差异字段未能列出）' : '差异：' + diff)
        )
      }

      written.push(result.profile.id)
      taken.add(result.profile.name)
      if (payload.note !== undefined) {
        ctx.stores.profiles.update(result.profile.id, { note: payload.note })
      }
    }
  } catch (err) {
    rollback(ctx, written, createdProxies)
    throw err
  }

  return { profiles: written.length, proxies: createdProxies.length, adopted }
}

/**
 * 密文里的 fingerprint 只保证「没被改过」，不保证「形状完整」——
 * 导出方可能是个更旧或更怪的版本。这里只查两个字段，因为少了这两个，
 * `adopt` 会写出一条 `platform` 投影落空的环境，症状要等到启动时才出现。
 */
function asBundleFingerprint(raw: unknown, where: string): FingerprintConfig {
  const rec = asRecord(raw, where + ' 的 fingerprint')
  const os = rec.os
  if (typeof os !== 'string' || !(OS_KINDS as readonly string[]).includes(os)) {
    throw new Error(`${where} 的 fingerprint.os 不合法：${String(os)}`)
  }
  if (typeof rec.userAgent !== 'string' || rec.userAgent === '') {
    throw new Error(`${where} 的 fingerprint.userAgent 缺失`)
  }
  return rec as unknown as FingerprintConfig
}

/** 建代理并返回「包内 key → 本机记录」的映射。v1 / v2 共用 */
function importProxies(
  ctx: ModuleContext,
  items: MigrationProxy[]
): { keyToProxy: Map<string, ProxyRecord>; created: string[] } {
  const keyToProxy = new Map<string, ProxyRecord>()
  const knownKeys = new Map<string, ProxyRecord>()
  for (const record of ctx.stores.proxies.list()) {
    knownKeys.set(proxyKeyOf(record.protocol, record.host, record.port, record.username), record)
  }

  const created: string[] = []
  for (const item of items) {
    const identity = proxyKeyOf(item.protocol, item.host, item.port, item.username)
    let record = knownKeys.get(identity)
    if (record === undefined) {
      record = {
        id: CollectionStore.newId('pxy'),
        name: item.name,
        protocol: item.protocol,
        host: item.host,
        port: item.port,
        username: item.username,
        // 导出时密码是空的，这里保持 undefined 而不是空串，
        // 让「没有密码」和「密码是空字符串」在后续编辑里能区分开
        password: item.password,
        lastCheck: null,
        createdAt: Date.now()
      }
      ctx.stores.proxies.add(record)
      knownKeys.set(identity, record)
      created.push(record.id)
    }
    // 迁移包内的 key 可能和本机去重键不同（比如对方手工改过），两套映射都要建
    keyToProxy.set(item.key, record)
  }
  return { keyToProxy, created }
}

function proxyConfigOf(proxy: ProxyRecord | undefined): Profile['proxy'] {
  if (proxy === undefined) return null
  return {
    type: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    password: proxy.password
  }
}

/**
 * 整批失败时把自己刚写进去的删掉。
 *
 * 为什么不在失败点上各自回滚：写盘发生在循环里，任何一步都可能抛
 * （adopt 的深比较失败、update 的 note 写入失败）。逐个 catch 的写法等于
 * 「每个抛点都要记得回滚」，漏一个就是半批数据。这里只在外面兜一层。
 *
 * 已经不在库里的 id 不算失败：回滚的目标是「回到导入前的状态」，
 * 而那条本来就不在了，状态已经对了。
 */
function rollback(ctx: ModuleContext, profileIds: string[], proxyIds: string[]): void {
  for (const id of profileIds) {
    try {
      ctx.stores.profiles.remove(id)
    } catch {
      // 已被 adopt 自己回滚掉的那条会走到这里，属正常
    }
  }
  for (const id of proxyIds) {
    try {
      ctx.stores.proxies.remove(id)
    } catch {
      // 同上
    }
  }
}

/* ────────────────────────────── 参数收敛 ────────────────────────────── */

function asId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`参数「${field}」缺失`)
  }
  return value.trim()
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function asIdList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('参数「profileIds」必须是字符串数组')
  return value.filter((item): item is string => typeof item === 'string')
}

/* ────────────────────────────── 注册 ────────────────────────────── */

export function registerTemplateModule(ctx: ModuleContext): void {
  ctx.handle(CH.templates.list, () => ensureBuiltinTemplates(ctx))

  ctx.handle(CH.templates.save, (_event, fromProfileId, name, description) =>
    saveTemplate(ctx, asId(fromProfileId, 'fromProfileId'), asId(name, 'name'), asText(description))
  )

  ctx.handle(CH.templates.apply, (_event, templateId, profileId) =>
    applyTemplate(ctx, asId(templateId, 'templateId'), asId(profileId, 'profileId'))
  )

  ctx.handle(CH.templates.remove, (_event, id) => removeTemplate(ctx, asId(id, 'id')))

  ctx.handle(CH.migration.export, (_event, profileIds, password) =>
    exportBundle(ctx, asIdList(profileIds), password)
  )

  ctx.handle(CH.migration.import, (_event, json, password, acceptLegacyIdentityLoss) => {
    if (typeof json !== 'string') throw new Error('参数「json」必须是字符串')
    return importBundle(ctx, json, password, acceptLegacyIdentityLoss)
  })
}
