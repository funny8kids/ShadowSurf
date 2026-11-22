/**
 * 备份的**纯文件操作**：路径规则、保留策略、旧目录盘点。
 *
 * ── 为什么不放在 backup.ts 里 ──
 * 那个文件顶部 `import { app } from 'electron'`（要拿 DPAPI 密钥），
 * 于是任何想测这些规则的单测都得先起一个 Electron 环境。
 * 而它们都是纯 `node:fs` 操作 —— 让它们能被 Node 直接测，
 * 比把它们和加密逻辑放在一起重要。
 *
 * 这也符合本仓库的一贯做法：`json-file.ts` / `health.ts` 零相对依赖，
 * 就是为了让"最该被测的部分"真的被测到。
 *
 * 归属：backup-agent
 */

import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 备份目录：与数据目录**同级**（`<userData>/backups`），不在 data 里面。
 *
 * 放在 data 里会有两个后果：还原把它连同旧目录一起改名（备份历史消失），
 * 以及 collect() 要额外排除自己（多一层出错机会）。
 */
export function backupsDir(dataDir: string): string {
  return join(dirname(dataDir), 'backups')
}

/** 备份文件保留策略：只留最近 KEEP_BACKUPS 份 */
export const KEEP_BACKUPS = 10

/**
 * 清理过期备份。
 *
 * 为什么需要：原先每次点"立即备份"都新增一个文件，**永不清理** ——
 * 一个备份是整个数据目录的加密快照（几 MB 到几十 MB），
 * 点一年就是几百个文件、几个 GB，而磁盘满是这个 App 最怕的故障。
 *
 * 只删**最旧的**，且只在新建备份之后调用：不会在用户没操作时动他的文件。
 *
 * 按文件名里的时间戳排序（文件名是 ISO 时间戳，字典序 = 时间序），
 * 不按 mtime —— 复制/同步会改 mtime，文件名不会。
 *
 * 只处理 `workspace-*.ssbak`：备份目录里可能有用户自己放的文件，
 * 那些**一个都不碰**。
 */
export function pruneBackups(dir: string): number {
  try {
    const all = readdirSync(dir).filter((n) => n.startsWith('workspace-') && n.endsWith('.ssbak'))
    if (all.length <= KEEP_BACKUPS) return 0
    all.sort()
    const stale = all.slice(0, all.length - KEEP_BACKUPS)
    let removed = 0
    for (const name of stale) {
      try {
        unlinkSync(join(dir, name))
        removed += 1
      } catch {
        /* 删不掉就算了（被占用），下次再试 */
      }
    }
    if (removed > 0) {
      console.warn(`[backup] 已清理 ${String(removed)} 份过期备份（保留最近 ${String(KEEP_BACKUPS)} 份）`)
    }
    return removed
  } catch {
    /* 备份目录读不了就不清理：不能因为清理失败影响备份本身 */
    return 0
  }
}

/**
 * 还原时被改名保留的旧数据目录。
 *
 * 为什么要点出来：还原提示说"旧数据保留为 .bak- 目录，确认后可自行删除"，
 * 但没有任何界面告诉用户它在哪、有多大 —— 于是它成了看不见的磁盘占用。
 *
 * 只报"在哪 / 多大 / 什么时候"，**不提供删除**：
 * 那是还原前的唯一完整数据，误删代价太大。
 */
export interface KeptDir {
  path: string
  bytes: number
  at: number
}

export function listKeptDirs(dataDir: string): KeptDir[] {
  const parent = dirname(dataDir)
  const out: KeptDir[] = []
  let names: string[] = []
  try {
    names = readdirSync(parent)
  } catch {
    return out
  }
  for (const name of names) {
    if (!name.startsWith('.bak-')) continue
    const full = join(parent, name)
    try {
      if (!statSync(full).isDirectory()) continue
    } catch {
      continue
    }
    const raw = name.slice('.bak-'.length)
    // 目录名来自 `new Date().toISOString().replace(/[:.]/g, '-')`：
    // `2026-11-21T10-30-00-000Z` —— 冒号和毫秒点都被换成了连字符，
    // Date.parse() 认不了这种格式。把 T 之后的三个分隔符还原成冒号/点，
    // 日期部分保持连字符（ISO 日期本来就是这个格式）。
    const iso = raw.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1T$2:$3:$4.$5Z')
    const stamp = Date.parse(iso)
    out.push({ path: full, bytes: dirSize(full), at: Number.isFinite(stamp) ? stamp : 0 })
  }
  return out.sort((a, b) => b.at - a.at)
}

/** 目录占用（递归求和）。出错就返回已累计的部分 —— 这是个诊断数字，不该抛 */
function dirSize(dir: string): number {
  let total = 0
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return total
  }
  for (const name of entries) {
    try {
      const st = statSync(join(dir, name))
      if (st.isDirectory()) total += dirSize(join(dir, name))
      else total += st.size
    } catch {
      /* 单个文件读不到就跳过 */
    }
  }
  return total
}

/** 这个文件名是不是本机生成的备份（不是用户自己放的东西） */
export function isGeneratedBackupName(name: string): boolean {
  return name.startsWith('workspace-') && name.endsWith('.ssbak')
}
