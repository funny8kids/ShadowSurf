/**
 * 本地扩展管理。
 *
 * 职责只有两件事：
 * 1. 登记「已解压扩展目录」的清单（名称 / 绝对路径 / 启用开关），落盘在
 *    `stores.extensions`；**不下载、不安装、不修改扩展本体**。远程商店是供应链
 *    攻击面，不属于这个模块的定位。
 * 2. 按环境把清单里启用的扩展加载进该环境的 `Session`
 *    （`applyExtensionsToSession`）。加载动作由调用方在环境启动流程里触发，
 *    本模块不自己挂 hook —— 谁创建 session，谁负责在正确的时机调它。
 *
 * 删除登记**不删磁盘目录**：目录是用户的文件，删掉记录只是「这个环境不再引用它」。
 *
 * 归属：extensions-agent
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Session } from 'electron'
import { CH } from '@shared/ipc'
import type { ExtensionRecord, StoredProfile } from '@shared/types'
import { CollectionStore, type Stores } from '@main/store'
import { appendAudit } from './audit'
import type { ModuleContext } from './context'

/** 名称上限。卡片上放得下、也足够区分同名扩展的不同版本 */
const MAX_NAME_LENGTH = 60

/** update 只认这三个字段。其余字段来自不可信的渲染层时一律拒绝，不静默丢弃 */
const UPDATABLE_KEYS = ['name', 'path', 'enabled'] as const
type UpdatableKey = (typeof UPDATABLE_KEYS)[number]

/* ────────────────────────────── 边界校验 ────────────────────────────── */

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`参数「${field}」必须是对象`)
  }
  return value as Record<string, unknown>
}

function asId(value: unknown, field = 'id'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`参数「${field}」缺失`)
  }
  return value.trim()
}

function asName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('参数「name」必须是字符串')
  const name = value.trim()
  if (name === '') throw new Error('扩展名称不能为空')
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`扩展名称不能超过 ${String(MAX_NAME_LENGTH)} 个字符`)
  }
  return name
}

function asPath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('参数「path」必须是字符串')
  const path = value.trim()
  if (path === '') throw new Error('扩展目录路径不能为空')
  return path
}

function asEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('参数「enabled」必须是布尔值')
  return value
}

/**
 * 「同一个目录」的比较键。
 *
 * 磁盘路径在 Windows 上大小写不敏感，在 Linux/macOS 上通常敏感 —— 用运行平台
 * 决定是否折叠大小写，而不是一律小写：Linux 上 `Ext` 与 `ext` 确实是两个目录，
 * 一律小写会把两个合法目录误判成重复。
 *
 * `resolve()` 只用来把相对路径 / `..` 收敛成同一形态，**不写回记录**：
 * 用户填的是什么，落盘就是什么，避免「保存后路径和输入框里不一样」的困惑。
 */
function pathKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * 扩展目录必须含 manifest.json —— 这是 Electron `session.loadExtension` 的最低要求。
 *
 * 在这里挡掉而不是等启动时才报：登记成功却加载失败，用户会在「环境启动」这个
 * 完全无关的场合看到一个扩展错误，而归因链已经断了一整屏。
 */
function assertManifest(path: string): void {
  if (!existsSync(join(path, 'manifest.json'))) {
    throw new Error('扩展目录里没有 manifest.json')
  }
}

/** 同一目录只登记一次；`excludeId` 用于 update 时排除自己 */
function assertUniquePath(store: Stores['extensions'], path: string, excludeId?: string): void {
  const key = pathKey(path)
  const duplicate = store
    .list()
    .find((record) => record.id !== excludeId && pathKey(record.path) === key)
  if (duplicate) {
    throw new Error(`这个目录已经登记过了：${duplicate.name}`)
  }
}

/* ────────────────────────────── 增删改查 ────────────────────────────── */

function listExtensions(store: Stores['extensions']): ExtensionRecord[] {
  // 最新登记的排在最前。createdAt 相同（同一毫秒内连续两次登记）时保留数组顺序，
  // 不额外引入随机次序 —— 界面上的行不应该每次刷新都换位置。
  return store.list().sort((a, b) => b.createdAt - a.createdAt)
}

function createExtension(stores: Stores, rawInput: unknown): ExtensionRecord {
  const input = asRecord(rawInput, 'input')
  const name = asName(input.name)
  const path = asPath(input.path)
  // enabled 缺省为 true：用户主动登记一个扩展，默认意图就是要用它；
  // 想停用的那个随后在列表里关掉即可。
  const enabled = input.enabled === undefined ? true : asEnabled(input.enabled)

  assertManifest(path)
  assertUniquePath(stores.extensions, path)

  const record: ExtensionRecord = {
    id: CollectionStore.newId('ext'),
    name,
    path,
    enabled,
    createdAt: Date.now()
  }
  stores.extensions.add(record)

  appendAudit(stores, '扩展·新增', name, path)
  return record
}

function updateExtension(stores: Stores, rawId: unknown, rawPatch: unknown): ExtensionRecord {
  const id = asId(rawId)
  const current = stores.extensions.get(id)
  if (current === null) throw new Error('扩展记录不存在，可能已被删除')

  const patch = asRecord(rawPatch, 'patch')
  for (const key of Object.keys(patch)) {
    if (!(UPDATABLE_KEYS as readonly string[]).includes(key)) {
      throw new Error(`不支持的字段「${key}」：只能更新 name / path / enabled`)
    }
  }

  const next: Partial<Pick<ExtensionRecord, UpdatableKey>> = {}

  if (patch.name !== undefined) {
    next.name = asName(patch.name)
  }

  if (patch.path !== undefined) {
    const path = asPath(patch.path)
    // 路径没变就不重新扫盘：用户改个名字时，目录可能正被占用 / 临时移走，
    // 那不是「这次更新无效」的理由。只有真的换了目录才要求 manifest。
    if (pathKey(path) !== pathKey(current.path)) {
      assertManifest(path)
      assertUniquePath(stores.extensions, path, id)
    }
    next.path = path
  }

  if (patch.enabled !== undefined) {
    next.enabled = asEnabled(patch.enabled)
  }

  return stores.extensions.update(id, next)
}

function removeExtension(stores: Stores, rawId: unknown): void {
  const id = asId(rawId)
  const record = stores.extensions.get(id)
  if (record === null) throw new Error('扩展记录不存在，可能已被删除')

  stores.extensions.remove(id)

  // 只删登记，磁盘目录原样保留（见文件头注释）。
  appendAudit(stores, '扩展·删除', record.name, record.path)
}

/* ────────────────────────────── 按环境加载 ────────────────────────────── */

export interface ApplyExtensionsResult {
  /** 本次调用结束时，该 session 里已处于加载状态的扩展数（含早已加载的） */
  loaded: number
  /** 没能加载 / 被跳过的条目。name 尽量取记录名，查不到记录时退回 id */
  failed: Array<{ name: string; error: string }>
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 把一个环境登记的扩展加载进它的 Session。
 *
 * 放在 extensions.ts 而不是 `core/session.ts`：session 层只该知道「怎么给一个
 * Session 设 UA / 代理」，让它反过来依赖 `Stores` 会形成 core → store → core 的环。
 * 本模块已经从 store 取扩展清单，是最自然的落点。
 *
 * ── 默认安全 ──
 * `profile.extensionIds` 为空 / 缺省时**一个扩展都不加载**，直接返回。
 * 「没配」和「配了空列表」在这里语义相同：扩展是用户逐个显式挂上去的，
 * 不存在「继承全局清单」这种隐式行为。
 *
 * ── 幂等 ──
 * `session.loadExtension()` 对同一路径重复调用会抛错。同一个 Session 可能被
 * 两次启动流程碰到（窗口复用、多标签页共用 session），所以每次调用先读
 * `ses.getAllExtensions()`，已经在里面的路径直接计入 loaded，不再重复加载。
 *
 * ── 跳过不是成功 ──
 * 记录不存在 / 已被停用都会写进 `failed`（带一句可读原因），而不是悄悄略过：
 * 返回值只有 loaded/failed 两栏，少报一条会让调用方以为「环境加载了 N 个」，
 * 而实际配置里有 N+1 个。调用方可以把 failed 原样展示给用户。
 */
export async function applyExtensionsToSession(
  ses: Session,
  stores: Stores,
  profile: StoredProfile
): Promise<ApplyExtensionsResult> {
  const failed: ApplyExtensionsResult['failed'] = []
  const ids = Array.isArray(profile.extensionIds) ? profile.extensionIds : []
  if (ids.length === 0) return { loaded: 0, failed }

  /**
   * 扩展 API 的入口。
   *
   * Electron 45 起 `session.loadExtension` 已标记弃用，正式入口是
   * `session.extensions.*`（见 electron.d.ts 的 Extensions 类）。这里按能力检测：
   * 新内核走新 API，旧内核 / 测试桩退回老方法 —— 两条路都不静默失败。
   */
  const api = (
    ses as unknown as {
      extensions?: {
        loadExtension: (p: string) => Promise<unknown>
        getAllExtensions?: () => Array<{ path?: string }>
      }
      loadExtension?: (p: string) => Promise<unknown>
      getAllExtensions?: () => Array<{ path?: string }>
    }
  ).extensions
  const loadOne = async (path: string): Promise<void> => {
    if (api) {
      await api.loadExtension(path)
      return
    }
    if (typeof ses.loadExtension !== 'function') {
      throw new Error('当前内核不支持加载扩展（session.loadExtension 不存在）')
    }
    await ses.loadExtension(path)
  }

  /**
   * 已加载路径集合。
   *
   * `getAllExtensions` 在部分测试桩 / 旧内核里可能不存在，能力检测失败时
   * 退化为空集：重复加载会由下面的 catch 记成 failed，而不是让整个环境启动失败。
   */
  const loadedPaths = new Set<string>()
  try {
    const list = api?.getAllExtensions ?? ses.getAllExtensions
    if (typeof list === 'function') {
      for (const ext of list.call(api ?? ses)) {
        if (typeof ext?.path === 'string' && ext.path !== '') {
          loadedPaths.add(pathKey(ext.path))
        }
      }
    }
  } catch {
    // 读不到已加载清单只影响幂等判断，不影响本次该加载什么
  }

  let loaded = 0
  const seen = new Set<string>()

  for (const rawId of ids) {
    if (typeof rawId !== 'string') {
      failed.push({ name: String(rawId), error: '扩展 id 不是字符串，已跳过' })
      continue
    }
    const id = rawId.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)

    let record: ExtensionRecord | null
    try {
      record = stores.extensions.get(id)
    } catch (err) {
      failed.push({ name: id, error: `读取扩展记录失败：${errorText(err)}` })
      continue
    }

    if (record === null) {
      // 环境引用的记录在登记表里已经不存在（被删了）。这是配置悬空，
      // 不是「没配」，所以报出来而不是静默跳过。
      failed.push({ name: id, error: '扩展记录不存在，可能已被删除' })
      continue
    }
    if (!record.enabled) {
      failed.push({ name: record.name, error: '扩展已停用，已跳过' })
      continue
    }

    const key = pathKey(record.path)
    if (loadedPaths.has(key)) {
      // 同一个 Session 里已经在加载了（前一次调用 / 别的标签页已经装过）。
      loaded += 1
      continue
    }

    try {
      await loadOne(record.path)
      loadedPaths.add(key)
      loaded += 1
    } catch (err) {
      // 错误原文必须带出去：没 manifest、版本不受支持、目录被移走是三种完全
      // 不同的处理方式，压成一句「加载失败」等于让用户去猜。
      failed.push({ name: record.name, error: errorText(err) })
    }
  }

  return { loaded, failed }
}

/* ────────────────────────────── 注册 ────────────────────────────── */

export function registerExtensionsModule(ctx: ModuleContext): void {
  ctx.handle(CH.extensions.list, () => listExtensions(ctx.stores.extensions))

  ctx.handle(CH.extensions.create, (_event, input) => createExtension(ctx.stores, input))

  ctx.handle(CH.extensions.update, (_event, id, patch) =>
    updateExtension(ctx.stores, id, patch)
  )

  ctx.handle(CH.extensions.remove, (_event, id) => removeExtension(ctx.stores, id))
}
