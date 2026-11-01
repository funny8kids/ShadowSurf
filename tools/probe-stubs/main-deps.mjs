/**
 * 主进程依赖的测试替身：只给 tools/probe-consent.mjs 用。
 *
 * 存在的理由：`modules/scripts.ts` 与 `modules/localapi.ts` 会 import 真正的
 * store / cdp / snapshot，那三样都要 Electron 与磁盘。探针要验的是「闸门认不认
 * 调用方那句自称同意」，不是页面执行细节，所以把这三样换成可控的假实现。
 *
 * 注意：这些文件不在 src/ 下，也不会被打进构建产物。生产代码里没有
 * 「测试模式」分支 —— 探针替换的是依赖，不是行为。
 */

/* ── @main/store/seed-seal ── */

/**
 * 字段级加密的替身：**只做前缀标记，不做加密**。
 *
 * 为什么可以直接替：探针要证的是「令牌会不会从 IPC 漏给渲染层」，而不是
 * 「密文写盘对不对」—— 后者是 seed-at-rest 那条线的事，有自己的门禁。
 *
 * 但它必须**真的记住自己封过**（而不是恒等变换）：恒等的话，`localapi` 每次
 * 启动都会判定「盘上还是明文」并再密封一遍，日志里反复出现一句
 * 「已把盘上的明文令牌就地密封」—— 一句在探针里没发生的事。替身可以简化实现，
 * 但不能伪造事实，否则读日志的人会得出错误结论。
 */
export const SEALED_PREFIX = 'ss-sealed:v1:'

export function sealAvailable() {
  return false
}

export function sealText(plain) {
  return SEALED_PREFIX + Buffer.from(String(plain), 'utf8').toString('base64')
}

export function isSealed(value) {
  return typeof value === 'string' && value.startsWith(SEALED_PREFIX)
}

export function openText(blob) {
  if (!isSealed(blob)) return blob
  return Buffer.from(blob.slice(SEALED_PREFIX.length), 'base64').toString('utf8')
}

export function sealSeed(plain) {
  return sealText(plain)
}

export function openSeed(blob) {
  return openText(blob)
}

/* ── @main/store ── */

export const GATE_ACTION_PREFIX = '闸门·'

export function dataDir() {
  return globalThis.__SS_STUB_DATA_DIR__
}

export function getStores() {
  return globalThis.__SS_STUB_STORES__
}

export class CollectionStore {
  static newId(prefix) {
    return `${prefix}_stub_${Math.random().toString(36).slice(2, 8)}`
  }
  list() {
    return []
  }
  add(entry) {
    return entry
  }
}

/* ── @main/core/cdp ── */

export function bridgeFor() {
  return globalThis.__SS_STUB_CDP__
}

/* ── @main/agent/snapshot ── */

export function captureSnapshot() {
  return globalThis.__SS_STUB_SNAPSHOT__
}

/**
 * 页面侧执行。
 *
 * 记下每一次真的被调用到的动作：闸门拦下的动作**不会**出现在这里，
 * 于是「日志长度变没变」就是「闸门放没放行」的干净判据，
 * 不必从异常文案里猜。
 */
export async function runInAgentWorld(cdp, expression) {
  globalThis.__SS_STUB_ACTIONS__.push(expression)
  return { ok: true, message: 'stub-ok' }
}
