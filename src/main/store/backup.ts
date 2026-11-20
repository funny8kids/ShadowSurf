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
 */

import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { safeStorage } from 'electron'

const MAGIC = 'SSBACKUP1'
const BACKUP_DIR = 'backups'

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

function collect(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (!statSync(p).isFile()) continue
    // 不备份备份自身，也不备份 .tmp（写一半的临时文件）
    if (name.startsWith('.tmp') || name.startsWith('.bak-')) continue
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
  const { randomFillSync } = await import('node:crypto')
  randomFillSync(nonce)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const enc = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  const out = Buffer.concat([
    Buffer.from(MAGIC, 'utf8'),
    nonce,
    tag,
    enc
  ])

  const dir = join(dataDir, BACKUP_DIR)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `workspace-${new Date().toISOString().replace(/[:.]/g, '-')}.ssbak`)
  writeFileSync(path, out)
  return path
}

export async function restoreBackup(
  backupPath: string,
  dataDir: string,
  runtime?: { stop: (id: string) => Promise<void>; runningIds: () => string[] }
): Promise<void> {
  const key = backupKey()
  const raw = readFileSync(backupPath)
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

  // 停运行中的环境（不关控制台自己）
  if (runtime) {
    for (const id of runtime.runningIds()) {
      await runtime.stop(id).catch(() => undefined)
    }
  }

  // 先把当前目录整体改名保留
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const keeper = join(dataDir, `.bak-${stamp}`)
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
  // 成功也保留 .bak-（不自动删）：用户确认没问题后自己清
}
