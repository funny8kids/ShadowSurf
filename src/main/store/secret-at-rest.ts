/**
 * 「盘上的旧明文凭据 → 就地密封」的通用实现。
 *
 * ── 为什么单独成文件 ──
 *
 * 同一件事在本仓库已经出现过三次：
 *   1. `master.key` 裸 32 字节（`fingerprint.ts`，只在 `deriveSeed()` 时才封装）
 *   2. `local-api-token.json` 的 64 位 hex 令牌（只在启用本地 API / 复制令牌时才密封）
 *   3. `profiles.json.schema<N>-*` 里的明文 seed（`legacy-backups.ts`，已在启动时处理）
 *
 * 前两个的共同失败模式是：**迁移只写在「用到它」的路径上**。于是从不使用该功能的用户，
 * 明文会一直躺在盘上 —— 而门禁（`tools/verify-seed-at-rest.mjs`）扫的是磁盘状态，
 * 不是「用起来之后的状态」。一个只有用起来才会修好的迁移，对绝大多数用户等于没修。
 *
 * 所以第三次不该再各写一遍。这个文件只做一件事：把「读 → 判断 → 密封 → 原子写」
 * 收成一处，判据和动作放在一起，谁调用都不会漂。
 *
 * ── 为什么零相对依赖 ──
 *
 * 只 `node:fs`。`localapi.ts` 静态 import 了 electron，`node --test` 里加载不了；
 * 把逻辑留在那边就只能「读代码证明它对」，那不是验证。密封函数由调用方注入
 * （`sealText`），这个文件不碰 electron —— 和 `evict.ts` / `json-file.ts` 同一条规则。
 *
 * ── 这个文件最危险的失败模式 ──
 *
 * 不是「没修好」，是「**动手了但动错了**」。凭据被换掉 = 所有在用客户端集体 401，
 * 而用户完全不知道发生了什么。所以每一条「不动」的分支都是**主语**，不是兜底：
 * 文件不存在不创建、形状不合法不猜、密封失败不改原文件。
 */

import * as fs from 'node:fs'

/** 一次就地密封的结果。前六种都是「原文件一个字节都没动」 */
export type SecretMigrateOutcome =
  /** 文件不存在。**不创建** —— 为没用过这项功能的人凭空生成凭据是扩大攻击面 */
  | 'missing'
  /** 读不了（权限 / 被占用 / 句柄耗尽）。不猜，不动 */
  | 'unreadable'
  /** 不是 JSON。不动 —— 它可能是别的程序的东西，也可能已经坏了 */
  | 'not-json'
  /** 字段缺失或空串。不动 */
  | 'empty'
  /** 已经是密封形态。不动（重复密封会把凭据变成解不开的东西） */
  | 'already-sealed'
  /** 形状不合法。**不动，也不重新生成** —— 在这里猜「那它大概是什么」只会把坏文件改得更坏 */
  | 'bad-shape'
  /** 已就地密封。凭据值本身没变，只换了落盘形态 */
  | 'resealed'
  /** 密封或写盘失败。原文件未改动，理由在 `reason` 里 */
  | 'failed'

export interface SecretAtRestSpec {
  /** 目标文件绝对路径 */
  file: string
  /** 日志与错误信息里怎么称呼这份凭据，例如「本地 API 令牌」 */
  label: string
  /** 从解析后的 JSON 里取凭据。取不到返回 undefined */
  pick: (raw: unknown) => string | undefined
  /** 是不是密封形态（只判前缀，不判内容） */
  isSealed: (value: string) => boolean
  /** 形状是否合法（例如 `^[0-9a-f]{64}$`）。不合法就整条跳过 */
  isWellFormed: (value: string) => boolean
  /** 明文 → 密封形态。不可用时应当抛，由本函数兜成 `failed` */
  seal: (plain: string, where: string) => string
  /**
   * 密封值 + 原对象 → 新文件的完整内容。
   *
   * 传原对象是为了让调用方能保留 `createdAt` 之类的旁支字段 ——
   * 迁移只该换凭据的形态，不该顺手把别的字段抹掉。
   */
  render: (sealed: string, previous: Record<string, unknown>) => string
}

export interface SecretMigrateResult {
  outcome: SecretMigrateOutcome
  file: string
  reason?: string
}

/**
 * 原子写：tmp → rename。
 *
 * 为什么不直接 `writeFileSync(target)`：这条路径动的是**已有**凭据。写到一半
 * 断电 / 磁盘满会留下一个**截断的文件**，而读取方的处置通常是「读不出就重新生成」——
 * 于是一次磁盘抖动变成「所有在用客户端集体 401」。
 *
 * 失败时删掉 tmp 并抛出，目标文件保持原样。
 */
export function writeFileAtomic(file: string, text: string, mode = 0o600): void {
  const tmp = file + '.tmp'
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode })
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 没建成或删不掉，都不影响原文件 */
    }
    throw err
  }
}

/**
 * 把盘上的明文凭据就地密封。
 *
 * 顺序刻意是「读 → 判断 → 密封 → 写」，任何一步失败都停在原地：
 * 没有「先写再验」的窗口，因为写坏了才发现就已经晚了。
 */
export function migrateSecretAtRest(spec: SecretAtRestSpec): SecretMigrateResult {
  const at = (outcome: SecretMigrateOutcome, reason?: string): SecretMigrateResult =>
    reason === undefined ? { outcome, file: spec.file } : { outcome, file: spec.file, reason }

  let text: string
  try {
    text = fs.readFileSync(spec.file, 'utf8')
  } catch (err) {
    // ENOENT 与 EACCES/EBUSY 都归到「没读到」，但两者原因不同，所以 reason 要分开写：
    // 「文件不存在」不该被读成「权限有问题」，否则用户会去改 ACL。
    return isMissing(err)
      ? at('missing')
      : at('unreadable', describe(err))
  }

  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch (err) {
    return at('not-json', describe(err))
  }

  const previous = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
  const current = spec.pick(raw)

  if (typeof current !== 'string' || current.length === 0) return at('empty')
  if (spec.isSealed(current)) return at('already-sealed')
  // 形状不合法：**不猜**。交给读取方的「读不出来就重新生成」去处置，
  // 那一步有明确语义；在这里改会把一份可能是别人写的文件改坏。
  if (!spec.isWellFormed(current)) return at('bad-shape')

  let sealed: string
  try {
    sealed = spec.seal(current, spec.label)
  } catch (err) {
    // 典型原因：safeStorage 不可用（Linux 无 keyring）。这时保持明文是**正确**的降级 ——
    // 门禁会如实报红，而不是让它看起来已经修好。
    return at('failed', describe(err))
  }

  try {
    writeFileAtomic(spec.file, spec.render(sealed, previous))
  } catch (err) {
    return at('failed', describe(err))
  }

  return at('resealed')
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT'
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
