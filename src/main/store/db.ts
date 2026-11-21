/**
 * 数据目录 + 绑定了目录的 JsonStore。
 *
 * 引擎本体在 `json-file.ts`：那里零相对依赖，能被 `tests/` 直接单测。
 * 这个文件只负责「把引擎绑到 <userData>/data 上」这一件事 —— 因为它必须
 * 静态 `import { app } from 'electron'`，一旦混进业务逻辑，那部分逻辑就再也测不了。
 *
 * 为什么不用 SQLite：better-sqlite3 是原生模块，Electron 每次升级 ABI 都要重编译，
 * 对开源项目的贡献者门槛太高。JSON + 原子写在单机场景下足够可靠。
 *
 * 但接口刻意做成 read / write / update / migrate 四件套——将来换 SQLite 适配器时，
 * 上层 Store（profiles / tasks / settings）一行都不用改，因为它们只依赖这四个方法。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import { JsonStore as JsonFileStore } from './json-file'
import type { JsonStoreOptions, Migrate } from './json-file'

let cachedDir: string | null = null

/**
 * 数据目录的「代际」。每次目录被**整体替换**（整机还原）就 +1。
 *
 * 为什么需要它：store 的内存缓存能靠 mtime 作废，但**派生状态**（审计链尾 seq/hash）
 * 是从文件里算出来的，没有任何失效钩子 —— 还原之后链尾还停在旧链的最后一条，
 * 于是新记录接着旧 seq 写下去，校验时凭空多出一个「序号断点」，
 * 把一次合法还原报成一次审计篡改，而且用户永远消不掉。
 *
 * 派生状态拿不到文件句柄、也没法自己判断"盘上换没换"，
 * 所以由这里提供一个单调递增的代际号：变了就说明盘上的东西被换过，
 * 缓存与链尾一起作废。
 */
let generation = 0

/** 当前代际。派生状态（审计链尾等）用它判断自己是否过期 */
export function currentGeneration(): number {
  return generation
}

/**
 * 数据目录被整体替换后调用：作废所有 store 的内存缓存，并推进代际。
 *
 * 顺序很重要：先作废缓存（否则下一次读还会命中旧内容），
 * 再推进代际（否则派生状态可能在缓存作废前抢跑）。
 */
export function bumpGeneration(): void {
  JsonFileStore.invalidateAll()
  generation += 1
}

/** 所有数据文件的根目录：<userData>/data，首次调用时创建 */
export function dataDir(): string {
  if (cachedDir !== null) return cachedDir
  let base: string
  try {
    base = app.getPath('userData')
  } catch {
    // 脱离 Electron 主进程跑脚本（例如数据迁移工具）时的兜底，保证模块可被单独引用
    base = process.cwd()
  }
  const dir = path.join(base, 'data')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    // mkdir 失败（磁盘满 / 用户目录只读 / 网盘掉线 / 杀软锁目录）在这里抛，
    // 而这里抛的东西会一路冒到启动链上 —— 所以必须自带人话：
    // 光一个 ENOSPC 没人知道该怎么办。
    const why = err instanceof Error ? err.message : String(err)
    throw new Error(`数据目录不可用（${dir}）：${why}`)
  }
  cachedDir = dir
  return dir
}

/** 拼接数据文件绝对路径，禁止调用方自己拼路径 */
export function filePath(name: string): string {
  return path.join(dataDir(), name)
}

/**
 * 绑到 `<userData>/data` 的 JsonStore：调用方只传裸文件名。
 *
 * 传绝对路径会被拼成 `<dataDir>\<dataDir>\xxx.json` 这种双层路径 ——
 * 所以这里只接受裸文件名，路径拼装统一由 `filePath()` 负责。
 */
export class JsonStore<T> extends JsonFileStore<T> {
  constructor(fileName: string, fallback: () => T, migrate?: Migrate<T>, options?: JsonStoreOptions<T>) {
    super(filePath(fileName), fallback, migrate, options)
  }
}

export { SCHEMA_CURRENT, SCHEMA_LEGACY, SCHEMA_SEALED, StoreCorruptError } from './json-file'
export type {
  CorruptInfo,
  CorruptKind,
  Envelope,
  JsonStoreOptions,
  Migrate,
  SeedForm,
  StoreRead
} from './json-file'
