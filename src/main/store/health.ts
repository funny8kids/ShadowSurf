/**
 * 数据健康快照。
 *
 * 存在的理由只有一条：**「备份物证存在但无消费方」等于没有物证。**
 *
 * `json-file.ts` 在损坏时会把原文件复制成 `.corrupt-<ts>`，迁移前会留一份
 * `.preupgrade<N>-<ts>`。这些东西写出来之后全仓没有任何地方读它们 ——
 * 用户看到的是空列表，盘上躺着一堆没人会打开的文件，日志在控制台里。
 * 这个模块就是那个消费方：把「哪些文件坏了、哪些备份还在、哪些备份里还有
 * 明文 seed」变成一份能穿过 IPC 到界面的结构化数据。
 *
 * 两条刻意的设计：
 *
 * 1. **只报告，不修。** 这里绝不改写、绝不删除任何文件。损坏文件是证据，
 *    自动「修复」等于销毁证据；含明文 seed 的备份同理 —— 它可能仍是唯一的
 *    已知良好快照，删不删该由人决定。
 * 2. **报真实路径，不报命名规则。** 数据目录里 `profiles.json` 和 `audit`
 *    是混着的（历史包袱），改名会让已有用户的数据变成孤儿。所以这里把每个
 *    文件的绝对路径原样带出去，让备份脚本按路径枚举，而不是去猜后缀。
 *
 * 零相对依赖（只 `node:fs` / `node:path` + 一个 type-only import），
 * 所以 `tests/` 能直接加载它跑真实文件系统。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type {
  StoreBackupHealth,
  StoreCorruptionInfo,
  StoreFileHealth,
  StoreHealth
} from '@shared/types'

/** 一个 store 对外声明自己「落盘在哪、什么版本、坏没坏」 */
export interface HealthStoreRef {
  name: string
  file: string
  schemaVersion: number
  corruption: StoreCorruptionInfo | null
}

/** 明文 seed 的判定：只有「seed 字段 = 32 位小写 hex」才算，别用裸 hex 去扫 */
const PLAINTEXT_SEED_RE = /"seed"\s*:\s*"[0-9a-f]{32}"/g

function statQuietly(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

/**
 * 备份文件的来源分类。
 *
 * 三种来源，**判据不同、补救动作也不同**，所以必须分开报而不是笼统说「有备份」：
 *
 *   `.corrupt-*`   损坏时的字节副本。文件解析不了，所以只能是字节复制 ——
 *                  「重新序列化一份损坏文件」只会造出一份看起来正常、内容却错的文件。
 *   `.preupgrade*` 迁移前的备份，**分两段**：先字节复制（独立于迁移代码的退路），
 *                  迁移成功且读回验证通过后，若目标涉及密封再按密封格式重写。
 *                  所以它**可能**含明文 seed —— 迁移失败、或目标版本本来就不密封时
 *                  就是明文的。含不含只能扫内容，不能靠命名推断。
 *   `.schema*`     旧命名（那时无条件原字节复制），明文 seed 的重灾区。不改名、不删除：
 *                  改了会让老用户盘上的这些文件失去解释，删了可能删掉唯一的快照。
 */
function originOf(name: string): StoreBackupHealth['origin'] | null {
  if (name.includes('.corrupt-')) return 'corrupt'
  if (name.includes('.preupgrade')) return 'preupgrade'
  if (/\.schema\d+-/.test(name)) return 'schema'
  return null
}

/** 数一份备份里有多少条明文 seed。读不了就当 0（宁可漏报，不要谎报） */
function countPlaintextSeeds(file: string): number {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return 0
  }
  const hits = text.match(PLAINTEXT_SEED_RE)
  return hits === null ? 0 : hits.length
}

function scanBackups(dir: string): StoreBackupHealth[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }

  const out: StoreBackupHealth[] = []
  for (const name of names) {
    const origin = originOf(name)
    if (origin === null) continue
    const full = path.join(dir, name)
    const st = statQuietly(full)
    // 只认文件：目录名恰好含 `.corrupt-` 这种可能性不高，但认错了会去读目录
    if (st === null || !st.isFile()) continue

    out.push({
      path: full,
      name,
      bytes: st.size,
      at: st.mtimeMs,
      origin,
      plaintextSeeds: countPlaintextSeeds(full)
    })
  }

  // 最新在前：用户最先关心的是刚才那次
  out.sort((a, b) => b.at - a.at)
  return out
}

/**
 * 汇总健康状态。
 *
 * `dir` 显式传入而不是内部调 `dataDir()`：`dataDir()` 依赖 electron，
 * 传进来才能用临时目录测。handlers 那边传 `dataDir()` 即可。
 */
export function collectStoreHealth(dir: string, refs: HealthStoreRef[]): StoreHealth {
  const stores: StoreFileHealth[] = refs.map((ref) => {
    const st = statQuietly(ref.file)
    return {
      name: ref.name,
      file: ref.file,
      exists: st !== null && st.isFile(),
      schemaVersion: ref.schemaVersion,
      corruption: ref.corruption,
      degraded: ref.corruption !== null
    }
  })

  const backups = scanBackups(dir)
  const broken = stores.filter((s) => s.corruption !== null)
  const leaky = backups.filter((b) => b.plaintextSeeds > 0)

  const notes: string[] = []

  for (const s of broken) {
    const c = s.corruption
    if (c === null) continue
    // 文案按 kind 分支。三种「不可用」的补救动作完全不同，说混了会把人引去做
    // 无效甚至有害的操作：
    //   io     → 关掉占用文件的程序（数据很可能完好）
    //   crypto → 密钥对不上了（换了机器/账户），文件也没坏
    //   其余   → 内容确实坏了，原文件保留待人工处理
    const what =
      c.kind === 'io'
        ? '文件读不到（被占用或没有权限），数据本身可能没问题 —— 关掉可能占用它的程序后重启即可'
        : c.kind === 'crypto'
          ? '内容读得出来但解不开（密钥对不上，通常是换了机器或系统账户）—— 文件没有损坏'
          : '文件内容已损坏，原文件没有被改动'
    notes.push(`${s.name}：${what}。路径：${c.file}`)
    notes.push(`  为避免覆盖数据，对 ${s.name} 的所有写入已被拒绝；界面上看不到的数据仍在盘上。`)
    if (c.backupPath !== null) {
      notes.push(`  损坏前的字节副本：${c.backupPath}`)
    } else {
      notes.push('  未能生成字节副本（原文件同样没被改动）。')
    }
  }

  if (leaky.length > 0) {
    const total = leaky.reduce((sum, b) => sum + b.plaintextSeeds, 0)
    notes.push(
      `有 ${String(leaky.length)} 份备份里还留着 ${String(total)} 条明文 seed。` +
        'seed 是身份派生根，明文留在盘上等于把身份交出去。' +
        '这些备份不会被自动删除（它们可能仍是唯一的已知良好快照），确认数据正常后请自行清理：'
    )
    for (const b of leaky) {
      notes.push(`  ${b.path}（${String(b.plaintextSeeds)} 条）`)
    }
    // 区分「本该擦掉但没擦掉」和「按设计就该是明文」——否则用户会以为所有明文备份
    // 都是 bug，然后去删掉唯一能退回旧版的那一份。
    const pending = leaky.filter((b) => b.origin === 'preupgrade')
    if (pending.length > 0) {
      notes.push(
        `  其中 ${String(pending.length)} 份是迁移前的备份（.preupgrade*）。` +
          '迁移失败、或迁移目标本来就不要求密封时，它们按设计保持明文 —— ' +
          '那是可由**本版本**直接读回的备份，**不要删**。' +
          '（注意：它们已经不是「能被旧版本应用读取的旧文件」了 —— ' +
          '密封上线那一刻，退回旧版这条路就已经断了，与这次重封无关。）' +
          '迁移成功且目标要求密封时，同一份文件会被自动按密封格式重写，不会再出现在这个列表里。'
      )
    }
  }

  // 旧命名只说明**来源**，推断不出**内容**。
  //
  // `legacy-backups.ts` 会在启动时把含明文 seed 的旧备份**就地密封**（文件名不变），
  // 所以盘上一份 `.schema0-*` 可能是「裸数组 + 明文 seed」，也可能是
  // 「schema 2 信封 + 密文」—— 两种都见过。这里只陈述文件名能证明的事，
  // 内容形态一律交给上面的按内容扫描。
  //
  // 用文件名推断内容，正是这一轮反复踩的那个坑（`.corrupt-` 被当成「坏文件副本」
  // 而实际是唯一完好的一份）。同一条错误不该在健康报告里再犯一次。
  const legacy = backups.filter((b) => b.origin === 'schema')
  if (legacy.length > 0) {
    notes.push(
      `有 ${String(legacy.length)} 份旧命名迁移备份（.schema<N>-）。` +
        '它们是旧实现原字节复制留下的，记录的是迁移前的完整内容。' +
        '含明文 seed 的会在启动时被就地密封（文件名不变），' +
        '所以「里面还有没有明文」以上面按内容扫出来的结果为准，不要看文件名。'
    )
  }

  const headline =
    broken.length > 0
      ? `有 ${String(broken.length)} 个数据文件不可用，相关功能已进入只读降级`
      : leaky.length > 0
        ? `数据文件正常，但有 ${String(leaky.length)} 份备份含明文 seed`
        : null

  return {
    dataDir: dir,
    stores,
    backups,
    degraded: broken.length > 0,
    headline,
    notes
  }
}
