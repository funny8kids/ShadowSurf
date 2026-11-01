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
  fs.mkdirSync(dir, { recursive: true })
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
