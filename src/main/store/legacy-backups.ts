/**
 * 历史备份的「原地密封」。
 *
 * ── 它解决什么问题 ──
 *
 * 旧版本每次迁移都会留一份 `profiles.json.schema<N>-<时间戳>` 的**字节副本**，
 * 里面是明文 seed。新版本不再产生这种文件，但**已经产生的不会被自动清掉** ——
 * 于是「profiles.json 看起来是密文，明文躺在旁边」，而且没有任何信号。
 *
 * ── 为什么是「密封」而不是「删除」 ──
 *
 * 那份文件里是真实身份。删掉等于替用户做了一个不可逆的决定，而用户从没同意过。
 * 密封则两头都满足：数据仍在（同一个文件、仍能被本版本读出来）、盘上不留明文。
 *
 * ── 为什么不是「让用户自己去删」 ──
 *
 * 一个只有读了发行说明才成立的修复，等于没修。绝大多数用户不会读。
 *
 * ── 安全顺序（任何一步失败就保持原样）──
 *
 *   读原文件 → 解析 → 找明文 seed → 按源版本校验形状 → 密封 → 写 tmp
 *   → **把 tmp 读回来逐条解封比对** → 通过才 rename
 *
 * 验证对象是**已落盘的那一份**，不是内存里的值；rename 是最后一步，所以
 * 「验不过」时原文件一个字节都没动。
 *
 * 这一点必须写清楚，因为它决定了 `verifyRoundTrip` 的全部价值：如果验证的是
 * 内存里的对象，那它只能证明「我构造的对象自洽」，证明不了「写出去的那份能读回来」。
 * 把 rename 提前、或者把验证挪到写之前，它就退化成装饰。
 *
 * 中间任何一步失败：原文件一个字节都没动，错误记进返回值由上层标红。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { Profile } from '@shared/types'
import {
  SCHEMA_CURRENT,
  SCHEMA_LEGACY,
  SCHEMA_SEALED,
  StoreCorruptError,
  encodeEnvelope,
  isValidSeed,
  validateProfiles
} from './json-file'
import { openSeed, sealAvailable, sealSeed } from './seed-seal'

/** 只有以主数据文件名开头的才可能是 profiles 的备份；别的 store 没有 seed */
const BACKUP_SUFFIX_MARKERS = ['.schema', '.preupgrade', '.corrupt-']

export interface LegacySealResult {
  /** 扫到的候选备份数 */
  scanned: number
  /** 本次真正被密封重写的文件名 */
  sealed: string[]
  /** 不含明文 seed，没动 */
  skipped: string[]
  /** 失败的文件与原因。原文件保持原样 */
  failed: Array<{ file: string; reason: string }>
}

/**
 * 判断一个文件名是不是「主数据文件的备份」。
 *
 * 刻意不用通配：`profiles.json` 本身、`profiles.json.tmp`、以及 `profiles.json`
 * 之外的任何东西都不在这个函数的返回值里。少了这层限制，一次误写就会把主文件
 * 当成备份重写一遍 —— 而重写主文件的路径上没有任何「用户是否同意」的检查。
 */
function isBackupOf(name: string, mainName: string): boolean {
  if (name === mainName) return false
  if (!name.startsWith(mainName + '.')) return false
  if (name.endsWith('.tmp')) return false
  const rest = name.slice(mainName.length + 1)
  return BACKUP_SUFFIX_MARKERS.some((marker) => rest.startsWith(marker.slice(1)))
}

/** 把盘上读到的东西拆成「声明的版本 + 条目」，与 json-file.ts 的 decodeEnvelope 同义 */
function decode(raw: unknown): { schema: number; list: Profile[] } {
  if (Array.isArray(raw)) {
    // 裸数组 = 旧格式（schema 0）。这是历史备份最常见的样子。
    return { schema: SCHEMA_LEGACY, list: validateProfiles(raw, SCHEMA_LEGACY, '(备份)') }
  }
  if (raw !== null && typeof raw === 'object' && typeof (raw as { schema?: unknown }).schema === 'number') {
    const env = raw as { schema: number; data: unknown }
    return { schema: env.schema, list: validateProfiles(env.data, env.schema, '(备份)') }
  }
  throw new StoreCorruptError('shape', '(备份)', '既不是数组，也不是带 schema 的信封')
}

/** 有没有需要处理的明文 seed。已密封的备份返回 false，从而被跳过 */
function hasPlainSeed(list: Profile[]): boolean {
  return list.some((p) => isValidSeed(p.seed, SCHEMA_CURRENT))
}

/**
 * 扫描目录里的历史备份，把含明文 seed 的原地密封。
 *
 * 不做递归：数据目录是平的，递归会让「清理」这个动作有可能波及到用户自己放进来的
 * 子目录。范围越小越不容易误伤。
 */
export function sealLegacyBackups(dir: string, mainName = 'profiles.json'): LegacySealResult {
  const result: LegacySealResult = { scanned: 0, sealed: [], skipped: [], failed: [] }

  // 本机封不了（Linux 无 keyring）就整体不做：逐条试只会得到一堆「safeStorage 不可用」
  // 的失败记录，把真正需要关注的问题淹掉。这一条不算失败，交给门禁去报明文。
  if (!sealAvailable()) return result

  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch (err) {
    result.failed.push({ file: dir, reason: '目录读不到：' + describe(err) })
    return result
  }

  for (const name of names) {
    if (!isBackupOf(name, mainName)) continue
    result.scanned += 1

    const full = path.join(dir, name)
    try {
      if (!fs.statSync(full).isFile()) {
        result.skipped.push(name)
        continue
      }
    } catch (err) {
      result.failed.push({ file: name, reason: '取文件状态失败：' + describe(err) })
      continue
    }

    try {
      const before = fs.readFileSync(full, 'utf8')
      const { list } = decode(JSON.parse(before))
      if (!hasPlainSeed(list)) {
        result.skipped.push(name)
        continue
      }

      // 密封 → 写 tmp → 读回校验 → 原子替换
      const sealedList = list.map((p, i) => ({
        ...p,
        seed: sealSeed(p.seed, `${name} 第 ${String(i + 1)} 条（id=${p.id}）`)
      }))
      const tmp = full + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(encodeEnvelope(SCHEMA_SEALED, sealedList), null, 2), 'utf8')

      verifyRoundTrip(tmp, list)
      fs.renameSync(tmp, full)
      result.sealed.push(name)
    } catch (err) {
      // 收尾：删掉可能残留的 tmp，原文件不动
      try {
        fs.unlinkSync(full + '.tmp')
      } catch {
        /* 没建成或删不掉，都不影响原文件 */
      }
      result.failed.push({ file: name, reason: describe(err) })
    }
  }

  return result
}

/**
 * 把刚写出的 tmp 读回来，逐条解封并与原值比对。
 *
 * 这是「密封」这个动作唯一的正确性证据：写出去的是密文，能不能解回**原来那条** seed。
 * 少了它，一个把 seed 写错位的 bug 会安静地把用户的身份换掉，而且要等到某天
 * 用户发现「指纹变了」才暴露。
 */
function verifyRoundTrip(tmp: string, original: Profile[]): void {
  const raw: unknown = JSON.parse(fs.readFileSync(tmp, 'utf8'))
  const env = raw as { schema: number; data: unknown }
  if (env.schema !== SCHEMA_SEALED) {
    throw new Error(`校验失败：写出的备份 schema=${String(env.schema)}，期望 ${String(SCHEMA_SEALED)}`)
  }
  const back = validateProfiles(env.data, SCHEMA_SEALED, tmp)
  if (back.length !== original.length) {
    throw new Error(`校验失败：条目数 ${String(back.length)} ≠ ${String(original.length)}`)
  }
  back.forEach((p, i) => {
    const got = openSeed(p.seed, tmp, `第 ${String(i + 1)} 条`)
    if (got !== original[i].seed) {
      throw new Error(`校验失败：第 ${String(i + 1)} 条解封后与原文不一致`)
    }
  })
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
