/**
 * seed 字段的落盘密封。
 *
 * ── 它到底防住了什么，不防什么 ──
 *
 * seed 是**运行时**的秘密：`dispatchScript(fingerprint, seed)` 用它决定 canvas / audio /
 * webgl 的每一处噪声，所以「拿到 seed」等于「拿到这个身份在所有站点上的完整指纹」。
 * 而 `fingerprint` 字段只是配置（os / uaVersion / 分辨率池），不含噪声本身。
 *
 * 密封之后，把数据目录整体拷走（备份盘、同步盘、换机迁移、别的系统账户）拿到的是一串
 * DPAPI 密文，解不开 → 身份不可复现。
 *
 * **不防**：同机同用户下的恶意进程。DPAPI 是按「当前登录用户」解密的，所以任何以该用户
 * 身份运行的代码都能调用同样的 API 解开。这条边界必须写清楚，否则「加密了」会被读成
 * 「安全了」—— 它挡的是**目录外流**，不是**本机提权**。
 *
 * ── 为什么用 safeStorage 而不是「AES + master.key 派生」 ──
 *
 * 后者看起来更「自洽」（钥匙已经在手上），但它会把 seed 的存活绑定到 master.key 上：
 * 今天 master.key 丢了只影响**新建/克隆/重掷**（老环境的 seed 是存在文件里的，照样能用），
 * 换成 master.key 派生之后，master.key 一丢 = 全部身份一起没，且无法恢复。
 * 用 DPAPI 则 master.key 与 seed 的存活互不牵连，失败面和 `settings.ts` 的 apiKey 完全一致
 * —— 那个面已经被产品接受了，这里不再新开一个。
 *
 * ── 为什么格式是 `enc:` + base64 ──
 *
 * 与 `settings.ts` 的 `ENC_PREFIX`、`json-file.ts` 的 `SEALED_SEED_RE`、
 * `tools/verify-seed-at-rest.mjs` 的 `SEALED_PREFIX` 三处共用同一个前缀。
 *
 * 常量本身定义在 `json-file.ts`（那个文件零依赖，测试能直接加载），这里 import 后
 * 转出。方向只能是「有依赖的引用无依赖的」—— 反过来会让 `json-file.ts` 拖进 electron，
 * 那套纯 Node 测试就再也跑不起来了。
 */

import { safeStorage } from 'electron'
import { SEALED_PREFIX, StoreCorruptError } from './json-file'

export { SEALED_PREFIX }

/** deriveSeed() 的产物形态。解开之后必须仍然满足它，否则等于解出了一段垃圾 */
const PLAIN_SEED_RE = /^[0-9a-f]{32}$/

/**
 * 这台机器现在能不能密封。
 *
 * Linux 上没有 keyring、或用 `--password-store=basic` 启动时会返回 false。
 * 此时**不迁移**（见 profiles.ts 的 targetSchema），而不是降级成明文 ——
 * 降级会把「已加密」这件事变成一个假象，比不加密更糟。
 */
export function sealAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * 明文 → 密文的记忆表。
 *
 * 为什么需要：`persist` 每次都会把**整个数组**重新序列化，而 profile 的
 * `status` 在每次启动/停止时都会变 —— 也就是说「启动一个环境」会触发一次
 * 全量重新密封。DPAPI 的 `encryptString` 是进程外调用，几十个环境就是几十次
 * 往返，落在 UI 的启动路径上。
 *
 * 记下来之后：seed 没变就不重新加密，密文逐字节稳定，写入也变成纯 IO。
 * 键是明文、值是其密文 —— 不引入任何新的暴露面（明文本来就在内存里）。
 * 两个环境共用同一个 seed（克隆时选「沿用身份」）会得到同一个密文，这是对的：
 * 它们本来就是同一个身份。
 *
 * 不做容量上限：条目数与环境数同阶，且每个值只有百来字节。
 */
const sealed = new Map<string, string>()

/**
 * 任意敏感字符串 → `enc:` blob。
 *
 * 与 `sealSeed` 共用同一套形态（`enc:` + base64 + safeStorage），因为
 * 「盘上有几种密封形态」这件事本身就是一个维护成本：多一种，门禁脚本、
 * 健康状态、恢复文档就都要多认一种。seed / 本地 API 令牌 / apiKey 用同一套。
 */
export function sealText(plain: string, where: string): string {
  if (!sealAvailable()) {
    throw new Error(`${where}：本机 safeStorage 不可用，拒绝以明文落盘`)
  }
  return SEALED_PREFIX + safeStorage.encryptString(plain).toString('base64')
}

/** 是不是密封形态。只判前缀，不判内容 —— 内容对不对要解开才知道 */
export function isSealed(value: string): boolean {
  return value.startsWith(SEALED_PREFIX)
}

/**
 * `enc:` blob → 原文。抛的是普通 Error，由调用方决定「解不开」意味着什么。
 *
 * 对 seed 来说解不开 = 数据不可用（走 quarantine）；对本地 API 令牌来说
 * 解不开 = 换个新令牌就行（用户重新复制一次）。同一个密码学失败，两种处置，
 * 所以这里**不替调用方决定**。
 */
export function openText(blob: string, where: string): string {
  if (!isSealed(blob)) throw new Error(`${where}：不是 ${SEALED_PREFIX} 形态`)
  try {
    return safeStorage.decryptString(Buffer.from(blob.slice(SEALED_PREFIX.length), 'base64'))
  } catch (err) {
    throw new Error(
      `${where}：无法解密（${err instanceof Error ? err.message : String(err)}）。` +
        'safeStorage 的密钥绑定当前系统用户与这台机器。'
    )
  }
}

/**
 * 明文 hex → `enc:` blob。
 *
 * 入参必须是 32 位小写 hex：**已经密封过的值再封一次是错误**，所以这里会抛。
 * 少了这条检查，「读出来是密文、写回去又封一层」会安静地把 seed 变成不可解的东西，
 * 而且要等到下次启动才暴露。
 */
export function sealSeed(plainHex: string, where: string): string {
  if (!PLAIN_SEED_RE.test(plainHex)) {
    throw new Error(`${where}：待密封的 seed 不是 32 位小写 hex（长度 ${String(plainHex.length)}）`)
  }
  const hit = sealed.get(plainHex)
  if (hit !== undefined) return hit
  const blob = sealText(plainHex, where)
  sealed.set(plainHex, blob)
  return blob
}

/**
 * `enc:` blob → 明文 hex。
 *
 * 解不开就抛 `StoreCorruptError('crypto')`（换机器 / 换系统账户 / 密文被截断），
 * **绝不返回空串或原值兜底** —— 返回垃圾会让 `dispatchScript` 拿到一个「看起来正常」
 * 的 seed，于是用户得到一个悄悄换掉的指纹，而不是一条明确的错误。
 *
 * 分类用 `crypto` 而不是 `shape`：文件一个字节都没坏，是钥匙换了。两者的补救动作
 * 完全不同（前者回原机器/原账户，后者修文件），日志里不能混成一句「数据损坏」。
 */
export function openSeed(blob: string, file: string, where: string): string {
  if (!isSealed(blob)) {
    throw new StoreCorruptError(
      'shape',
      file,
      `${where}：seed 不是 ${SEALED_PREFIX} 形态，无法按 schema 2 解封`
    )
  }
  let plain: string
  try {
    plain = openText(blob, where)
  } catch (err) {
    throw new StoreCorruptError(
      'crypto',
      file,
      `${where}：${err instanceof Error ? err.message : String(err)}` +
        '从别的机器/用户拷来的数据目录无法恢复原有指纹。'
    )
  }
  if (!PLAIN_SEED_RE.test(plain)) {
    throw new StoreCorruptError(
      'shape',
      file,
      `${where}：seed 解密结果不是 32 位小写 hex（长度 ${String(plain.length)}）`
    )
  }
  return plain
}
