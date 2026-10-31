/**
 * 给 tools/check-injection.mjs 用的 electron 空壳。
 *
 * 目的只是让 fingerprint.ts → store/db.ts 这条 import 链在纯 Node 里能加载起来，
 * 好把 buildInjectionScript() 产出的字符串拿去 vm.Script 做语法分析。
 * 不执行任何真实逻辑，所有方法返回固定值。
 */

const noop = () => undefined

export const app = {
  getPath: () => process.cwd(),
  getName: () => 'shadowsurf-check',
  getVersion: () => '0.0.0',
  isPackaged: false,
  on: noop,
  whenReady: () => Promise.resolve()
}

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s) => Buffer.from(String(s)),
  decryptString: (b) => Buffer.from(b).toString()
}

export default { app, safeStorage }
