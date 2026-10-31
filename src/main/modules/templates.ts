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
import { OS_TEMPLATES, resolveFingerprint } from '@shared/presets'
import type {
  FingerprintConfig,
  FingerprintTemplate,
  MigrationBundle,
  MigrationProfile,
  MigrationProxy,
  OSKind,
  Profile,
  ProxyProtocol,
  ProxyRecord
} from '@shared/types'
import { CollectionStore } from '@main/store'
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

function exportBundle(ctx: ModuleContext, profileIds: string[]): string {
  const ids = Array.from(new Set(profileIds.map((id) => id.trim()).filter((id) => id !== '')))
  if (ids.length === 0) throw new Error('请先选择要导出的环境')

  const profiles: MigrationProfile[] = []
  const proxies = new Map<string, MigrationProxy>()

  ids.forEach((id, index) => {
    const profile = ctx.stores.profiles.get(id)
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

    // 只导出可重建身份的最小集合：分组、标签、颜色属于本机组织方式，
    // 带过去反而会和目标机器的习惯打架。
    profiles.push({
      name: profile.name,
      platform: profile.platform,
      note: profile.note || undefined,
      fingerprint: structuredClone(profile.fingerprint),
      proxyKey
    })
  })

  const bundle: MigrationBundle = {
    version: 1,
    exportedAt: Date.now(),
    app: 'ShadowSurf',
    profiles,
    proxies: Array.from(proxies.values())
  }
  // 缩进 2 空格：迁移包经常被人打开肉眼核对，可读性优先于体积
  return JSON.stringify(bundle, null, 2)
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
  if (root.version !== 1) {
    // 版本号是唯一的兼容性开关：宁可明确拒绝，也不要按旧格式猜字段
    fail(`不支持的迁移包版本：${String(root.version)}，当前只支持 version 1`)
  }
  if (!Array.isArray(root.profiles)) fail('迁移包缺少必填字段「profiles」')
  if (root.proxies !== undefined && !Array.isArray(root.proxies)) {
    fail('迁移包的「proxies」必须是数组')
  }

  const proxyRaw = (root.proxies ?? []) as unknown[]
  return {
    version: 1,
    exportedAt: typeof root.exportedAt === 'number' ? root.exportedAt : Date.now(),
    app: typeof root.app === 'string' ? root.app : 'ShadowSurf',
    profiles: (root.profiles as unknown[]).map(parseMigrationProfile),
    proxies: proxyRaw.map(parseMigrationProxy)
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

function importBundle(ctx: ModuleContext, json: string): { profiles: number; proxies: number } {
  const bundle = parseBundle(json)
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
  const keyToProxy = new Map<string, ProxyRecord>()
  const knownKeys = new Map<string, ProxyRecord>()
  for (const record of ctx.stores.proxies.list()) {
    knownKeys.set(proxyKeyOf(record.protocol, record.host, record.port, record.username), record)
  }

  let proxyCount = 0
  for (const item of bundle.proxies) {
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
      proxyCount += 1
    }
    // 迁移包内的 key 可能和本机去重键不同（比如对方手工改过），两套映射都要建
    keyToProxy.set(item.key, record)
  }

  const taken = new Set(ctx.stores.profiles.list().map((profile) => profile.name))
  let profileCount = 0

  bundle.profiles.forEach((item) => {
    const proxy = item.proxyKey !== undefined ? keyToProxy.get(item.proxyKey) : undefined

    const created = ctx.stores.profiles.create({
      name: uniqueName(item.name, taken),
      platform: item.platform,
      fingerprint: structuredClone(item.fingerprint),
      proxy:
        proxy === undefined
          ? null
          : {
              type: proxy.protocol,
              host: proxy.host,
              port: proxy.port,
              username: proxy.username,
              password: proxy.password
            }
    })
    taken.add(created.name)

    // CreateProfileInput 没有 note 字段，只能建完再补一次。
    // 放在 create 之后而不是合并进一次写入，是为了不改动 store 的既有签名。
    if (item.note !== undefined) {
      ctx.stores.profiles.update(created.id, { note: item.note })
    }
    profileCount += 1
  })

  return { profiles: profileCount, proxies: proxyCount }
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

  ctx.handle(CH.migration.export, (_event, profileIds) =>
    exportBundle(ctx, asIdList(profileIds))
  )

  ctx.handle(CH.migration.import, (_event, json) => {
    if (typeof json !== 'string') throw new Error('参数「json」必须是字符串')
    return importBundle(ctx, json)
  })
}
