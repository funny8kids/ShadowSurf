/**
 * 整机数据备份 / 还原。
 *
 * ── 范围 ──
 * 备份的是整个 `data/` 目录（profiles.json / audit.json / tasks.json /
 * team-*.json / proxy*.json / scripts.json / local-api-token 等），
 * 不含 Electron 的浏览器分区（Cookie / IndexedDB 在 persist:ss_* 里，
 * 那些由站点自己同步；纯本机备份只保配置与身份）。
 *
 * ── 加密 ──
 * 用 `safeStorage` 保护的主密钥派生一个 AES-256-GCM key（HKDF），
 * 因此**只有在同一台机器、同一个系统账户下能还原**。
 * 换机器请用迁移包（口令封装，见 modules/templates.ts），
 * 不要在另一台机器上报 E_CRYPTO 后以为备份坏了 —— 这是设计。
 *
 * ── 格式 ──
 *   <version:u32><nonce:12><ciphertext+tag>
 *   明文是数据目录内所有普通文件的 JSON 映射（路径 → base64），
 *   先打成 JSON 再整体加密。文件数不多（<30），不需要 tar 流。
 *
 * ── 还原 ──
 * 不可逆：先把当前 data 目录**原地改名**保留为 `.bak-<ts>`，
 * 再解包写入。任一步失败都保留 `.bak-` 那份，绝不留下半份数据。
 * 调用方必须停掉所有环境（由 localapi 的 ctx.runtime 完成）。
 *
 * ── 三条硬约束（都是踩过的坑）──
 * 1. `.bak-` 保留目录必须是 data 目录的**兄弟**，不能是它的子目录：
 *    `rename(old, new)` 在 new 以 old 为前缀时必然 EINVAL（POSIX 规定，
 *    Windows 的 MoveFileEx 同样失败）。之前写成 `data/.bak-<ts>`，
 *    还原 100% 失败 —— 而且是在把用户所有环境都停掉之后才失败。
 * 2. 备份文件**不能**放在 data 目录里：还原会把 data 目录整个换掉，
 *    放在里面的备份会跟着旧目录一起被改名，用户会发现"备份历史空了"。
 * 3. 解密与校验必须**先于**停环境完成：停完环境再失败，
 *    用户得到的是"环境全被关了 + 一个看不懂的 EINVAL"。
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomFillSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, basename, dirname, resolve, sep } from 'node:path'
import { safeStorage } from 'electron'
import { bumpGeneration } from './db'

const MAGIC = 'SSBACKUP1'

/**
 * 备份目录：与数据目录**同级**（`<userData>/backups`），不在 data 里面。
 *
 * 放在 data 里会有两个后果：还原把它连同旧目录一起改名（备份历史消失），
 * 以及 collect() 要额外排除自己（多一层出错机会）。
 */
export function backupsDir(dataDir: string): string {
  return join(dirname(dataDir), 'backups')
}

/** 备份密钥：从 safeStorage 加密后的一个固定串派生（同一机器/账户恒定） */
function backupKey(): Buffer {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage 不可用：整机备份无法加密，拒绝生成明文备份')
  }
  const sealed = safeStorage.encryptString('shadowsurf:backup:v1')
  return Buffer.from(
    hkdfSync('sha256', sealed, Buffer.from('shadowsurf-backup', 'utf8'), Buffer.from('data-dir', 'utf8'), 32)
  )
}

interface Snapshot {
  version: 1
  at: number
  files: Record<string, string>
}

/**
 * 收集数据目录里的普通文件。
 *
 * 排除两类：
 * - 写一半的临时文件（`xxx.json.tmp`）—— 备份半截文件没有意义，
 *   还原后它还会被下一次写截断复用；
 * - 损坏隔离副本（`xxx.json.corrupt-<ts>`）—— 那是**证据**，
 *   还原回去只会让新目录再次被判定损坏。
 */
function collect(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let isFile = false
    try {
      isFile = statSync(p).isFile()
    } catch {
      continue
    }
    if (!isFile) continue
    if (name.startsWith('.tmp') || name.endsWith('.tmp')) continue
    if (name.includes('.corrupt-')) continue
    out[name] = readFileSync(p).toString('base64')
  }
  return out
}

export async function createBackup(dataDir: string): Promise<string> {
  const key = backupKey()
  const snapshot: Snapshot = { version: 1, at: Date.now(), files: collect(dataDir) }
  const plain = Buffer.from(JSON.stringify(snapshot), 'utf8')
  const nonce = Buffer.alloc(12)
  // randomFillSync 避免可预测的 nonce（同 key + 同 nonce 会毁掉 GCM 的安全性）
  randomFillSync(nonce)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const enc = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  const out = Buffer.concat([Buffer.from(MAGIC, 'utf8'), nonce, tag, enc])

  const dir = backupsDir(dataDir)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `workspace-${new Date().toISOString().replace(/[:.]/g, '-')}.ssbak`)
  writeFileSync(path, out)
  return path
}

/** 还原的结果：告诉调用方旧数据留在哪 */
export interface RestoreResult {
  /** 旧数据目录被改名保留在这里（用户确认没问题后可以自己删） */
  keeperPath: string
  /** 还原回来的文件数 */
  fileCount: number
}

/**
 * 校验待还原的文件确实躺在备份目录里。
 *
 * 没有这一条的话，本地 API 的 `POST /v1/restore` 就是任意文件读写的入口：
 * 调用方传一个系统上的任意路径，App 会拿自己的密钥去尝试解密。
 * 更糟的是"备份文件"可以来自别的机器 —— 密钥不匹配，解不开，
 * 但错误信息会把整条路径回显出去。
 */
function assertInsideBackups(backupPath: string, dataDir: string): string {
  const root = resolve(backupsDir(dataDir))
  const target = resolve(backupPath)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('备份文件不在备份目录内，拒绝还原')
  }
  if (!existsSync(target)) throw new Error('备份文件不存在')
  return target
}

export async function restoreBackup(
  backupPath: string,
  dataDir: string,
  runtime?: { stop: (id: string) => Promise<void>; runningIds: () => string[] }
): Promise<RestoreResult> {
  const key = backupKey()
  const target = assertInsideBackups(backupPath, dataDir)
  const raw = readFileSync(target)
  const magic = raw.subarray(0, MAGIC.length).toString('utf8')
  if (magic !== MAGIC) throw new Error('不是 ShadowSurf 备份文件')
  const nonce = raw.subarray(MAGIC.length, MAGIC.length + 12)
  const tag = raw.subarray(MAGIC.length + 12, MAGIC.length + 28)
  const enc = raw.subarray(MAGIC.length + 28)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  let plain: Buffer
  try {
    plain = Buffer.concat([decipher.update(enc), decipher.final()])
  } catch {
    throw new Error('备份解密失败：不是同一台机器 / 同一个系统账户，或文件被改动')
  }
  const snapshot = JSON.parse(plain.toString('utf8')) as Snapshot
  if (snapshot.version !== 1 || typeof snapshot.files !== 'object') {
    throw new Error('备份格式无法识别')
  }

  // ── 到这里为止还没有碰用户的运行环境 ──
  // 顺序很要紧：解密失败 / 格式不认识时，用户的环境还好好开着，
  // 而不是先全停了再报错。
  if (runtime) {
    for (const id of runtime.runningIds()) {
      await runtime.stop(id).catch(() => undefined)
    }
  }

  // 先把当前目录整体改名保留。
  //
  // keeper 必须是 data 目录的**兄弟**：rename(old, new) 在 new 以 old 为前缀时
  // 必然失败（EINVAL / ERROR_ACCESS_DENIED）—— 写成 data/.bak-<ts> 就是把自己
  // 改名到自己的子目录，100% 失败，且失败点在"用户环境已经全停了"之后。
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const keeper = join(dirname(dataDir), `.bak-${stamp}`)
  if (existsSync(dataDir)) renameSync(dataDir, keeper)
  mkdirSync(dataDir, { recursive: true })
  try {
    for (const [name, b64] of Object.entries(snapshot.files)) {
      // 只接受纯文件名，拒绝路径穿越（备份文件可能来自不可信来源）
      if (name !== basename(name) || name.startsWith('.')) continue
      writeFileSync(join(dataDir, name), Buffer.from(b64, 'base64'))
    }
  } catch (err) {
    // 写失败：删掉半成品，把原目录改回来
    rmSync(dataDir, { recursive: true, force: true })
    renameSync(keeper, dataDir)
    throw err
  }

  // 数据目录已经换掉了：所有 store 的内存缓存与派生状态（审计链尾）
  // 必须一并作废，否则还原之后界面继续显示旧数据、
  // 审计校验还会报一次"链被篡改"。
  bumpGeneration()

  // 成功也保留 .bak-（不自动删）：用户确认没问题后自己清
  return { keeperPath: keeper, fileCount: Object.keys(snapshot.files).length }
}
