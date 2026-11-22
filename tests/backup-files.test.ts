/**
 * 备份文件的保留策略与旧目录盘点。
 *
 * 钉住三件事：
 * 1. **只删自己生成的**：备份目录里可能有用户自己放的文件，一个都不碰；
 * 2. **只留最近 10 份**：按文件名时间戳排序（不按 mtime —— 复制会改 mtime）；
 * 3. **旧目录只读不删**：那是还原前唯一完整数据，误删代价太大。
 *
 * `backup-files.ts` 零 electron 依赖（纯 node:fs / node:path），
 * 所以能直接在 Node 里跑真实文件系统。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  KEEP_BACKUPS,
  backupsDir,
  isGeneratedBackupName,
  listKeptDirs,
  pruneBackups
} from '../src/main/store/backup-files.ts'

function sandbox(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'shadowsurf-backup-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 造 N 份备份，时间戳从 01 到 N（文件名字典序 = 时间序） */
function makeBackups(dir: string, n: number): string[] {
  const out: string[] = []
  for (let i = 1; i <= n; i += 1) {
    const name = `workspace-2026-11-${String(i).padStart(2, '0')}T00-00-00-000Z.ssbak`
    writeFileSync(join(dir, name), 'payload-' + String(i))
    out.push(name)
  }
  return out
}

test('备份目录与数据目录同级（不在 data 里面）', () => {
  const data = join('/tmp', 'appdata', 'data')
  assert.equal(backupsDir(data), join('/tmp', 'appdata', 'backups'))
})

test('只认自己生成的备份文件名', () => {
  assert.equal(isGeneratedBackupName('workspace-2026-11-21T00-00-00-000Z.ssbak'), true)
  assert.equal(isGeneratedBackupName('我的备份.ssbak'), false)
  assert.equal(isGeneratedBackupName('workspace-notes.txt'), false)
  assert.equal(isGeneratedBackupName('profiles.json'), false)
})

test('保留最近 10 份，删掉最旧的', () => {
  const box = sandbox()
  try {
    const names = makeBackups(box.dir, KEEP_BACKUPS + 5)
    const removed = pruneBackups(box.dir)
    assert.equal(removed, 5)
    const left = readdirSync(box.dir).sort()
    assert.equal(left.length, KEEP_BACKUPS)
    // 被删的是最旧的 5 份
    assert.deepEqual(left, names.slice(5).sort())
  } finally {
    box.cleanup()
  }
})

test('用户自己放的文件一个都不碰', () => {
  const box = sandbox()
  try {
    makeBackups(box.dir, KEEP_BACKUPS + 2)
    writeFileSync(join(box.dir, '我的手动备份.ssbak'), 'keep')
    writeFileSync(join(box.dir, 'readme.txt'), 'keep')
    pruneBackups(box.dir)
    assert.equal(readdirSync(box.dir).includes('我的手动备份.ssbak'), true)
    assert.equal(readdirSync(box.dir).includes('readme.txt'), true)
  } finally {
    box.cleanup()
  }
})

test('不超过上限时什么都不删', () => {
  const box = sandbox()
  try {
    makeBackups(box.dir, KEEP_BACKUPS)
    assert.equal(pruneBackups(box.dir), 0)
    assert.equal(readdirSync(box.dir).length, KEEP_BACKUPS)
  } finally {
    box.cleanup()
  }
})

test('盘点旧数据目录：报路径、大小、时间，但一个字节都不动', () => {
  const box = sandbox()
  try {
    const data = join(box.dir, 'data')
    mkdirSync(data)
    const keeper = join(box.dir, '.bak-2026-11-21T10-30-00-000Z')
    mkdirSync(keeper)
    mkdirSync(join(keeper, 'sub'))
    writeFileSync(join(keeper, 'profiles.json'), '12345')
    writeFileSync(join(keeper, 'sub', 'audit'), '123')

    const dirs = listKeptDirs(data)
    assert.equal(dirs.length, 1)
    assert.equal(dirs[0].path, keeper)
    // 只读盘点，不删
    assert.equal(readdirSync(box.dir).includes('.bak-2026-11-21T10-30-00-000Z'), true)
  } finally {
    box.cleanup()
  }
})

test('盘点时忽略普通目录（不是 .bak- 前缀的）', () => {
  const box = sandbox()
  try {
    const data = join(box.dir, 'data')
    mkdirSync(data)
    mkdirSync(join(box.dir, 'backups'))
    writeFileSync(join(box.dir, 'backups', 'x.ssbak'), 'x')
    assert.equal(listKeptDirs(data).length, 0)
  } finally {
    box.cleanup()
  }
})
