/**
 * 极简 JSON 持久化层。
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

function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

/** 深拷贝：store 对外只给快照，调用方随便改都不会污染内存缓存 */
function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * 单文件 JSON 集合。
 *
 * 三个关键点：
 * 1. 原子写：tmp → fsync → rename。rename 在同一分区上是原子的，
 *    断电最坏情况是留下旧的完整文件或 .tmp 残留，绝不会出现半个 JSON。
 * 2. 损坏自愈：JSON.parse 失败时把坏文件改名备份，用 fallback 重建，
 *    不让一个坏文件把整个应用卡死在启动阶段。
 * 3. mtime 校验：外部进程（或用户手改）改了文件后，缓存自动失效。
 */
export class JsonStore<T> {
  private readonly file: string
  private readonly fallback: () => T
  private readonly migrate?: (raw: unknown) => T

  private cache: T | null = null
  private cachedMtime = 0
  private writes = 0

  constructor(fileName: string, fallback: () => T, migrate?: (raw: unknown) => T) {
    this.file = filePath(fileName)
    this.fallback = fallback
    this.migrate = migrate
  }

  /** 写次数计数。UI 可以据此判断「有没有变过」，比对比整个对象便宜 */
  get version(): number {
    return this.writes
  }

  read(): T {
    const st = statOrNull(this.file)

    // 命中缓存：文件 mtime 没动过就直接返回
    if (this.cache !== null && st !== null && st.mtimeMs === this.cachedMtime) {
      return this.cache
    }

    // 首次运行：文件不存在，落盘一份默认值
    if (st === null) {
      return this.reset(this.fallback())
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown
    } catch {
      return this.reset(this.recover())
    }

    let value: T
    try {
      value = this.migrate ? this.migrate(parsed) : (parsed as T)
    } catch {
      // 迁移函数自己炸了也按损坏处理，避免旧格式把启动卡住
      return this.reset(this.recover())
    }

    this.cache = value
    this.cachedMtime = st.mtimeMs
    return value
  }

  write(data: T): void {
    this.persist(data)
  }

  /** 读 → 改 → 写。fn 拿到的是副本，可以随意原地改 */
  update(fn: (draft: T) => void): T {
    const draft = clone(this.read())
    fn(draft)
    this.persist(draft)
    return draft
  }

  /* ───────────────────────────── 内部实现 ───────────────────────────── */

  private reset(value: T): T {
    this.persist(value)
    return value
  }

  /** 损坏文件改名备份后返回 fallback，绝不抛异常 */
  private recover(): T {
    try {
      fs.renameSync(this.file, this.file + '.corrupt-' + String(Date.now()))
    } catch {
      /* 备份失败也要继续，至少不能让读流程挂掉 */
    }
    return this.fallback()
  }

  private persist(data: T): void {
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true })

    const tmp = this.file + '.tmp'
    const json = JSON.stringify(data, null, 2)

    // 先写 tmp 并落盘，再原子替换；顺序不能颠倒
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, json, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, this.file)

    const st = statOrNull(this.file)
    this.cache = clone(data)
    this.cachedMtime = st === null ? 0 : st.mtimeMs
    this.writes += 1
  }
}
