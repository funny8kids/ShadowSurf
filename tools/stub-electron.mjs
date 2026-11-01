/**
 * 给 tools/check-injection.mjs 与 tools/probe-gate.mjs 用的 electron 空壳。
 *
 * 目的有两个：
 * 1. 让 fingerprint.ts → store/db.ts 这条 import 链在纯 Node 里能加载起来，
 *    好把 buildInjectionScript() 产出的字符串拿去 vm.Script 做语法分析；
 * 2. 让 consent.ts 在探针里能跑 —— 它是「同意」的唯一来源，如果探针加载不了它，
 *    就只能靠读代码「证明」闸门有效，那不是验证。
 *
 * `dialog.showMessageBox` 在这里被换成一个可编程的假窗口：
 *   SS_STUB_DIALOG_RESPONSE   1 = 用户点了「允许执行」，0 = 取消（默认 1）
 *   SS_STUB_DIALOG_DELAY_MS   延迟多少毫秒才「点」（用于验证超时后不铸票）
 *
 * 这只是**测试替身**，只影响被 vite 别名替换掉 electron 的那个进程。
 * 真实应用里 consent.ts import 的是真 electron，弹的是真的 OS 窗口。
 *
 * 注意：不要在 src/ 里为测试加任何后门。这个文件不在 src/ 下，也不会被打进构建产物。
 */

const noop = () => undefined

export const app = {
  /**
   * `__SS_STUB_USER_DATA__` 可以把这个路径指到临时目录。
   *
   * 少了它，`store/db.ts` 的 `dataDir()` 会退到 `process.cwd()/data` ——
   * 也就是往**仓库目录**里写数据文件。探针跑一次就在源码树里留下一份
   * profiles.json，而且是带着真 seed 的那种。
   */
  getPath: (name) => {
    const dir = globalThis.__SS_STUB_USER_DATA__
    if (name === 'userData' && typeof dir === 'string') return dir
    return process.cwd()
  },
  getName: () => 'shadowsurf-check',
  getVersion: () => '0.0.0',
  isPackaged: false,
  on: noop,
  whenReady: () => Promise.resolve()
}

/**
 * safeStorage 桩。
 *
 * **默认行为刻意是「不可用 + 恒等变换」**，和它出现之前完全一样 ——
 * 现有探针（consent / gate / check-injection）依赖这个默认值，改掉会连带改它们的世界。
 *
 * 需要真加密语义的探针（seed 密封）通过 `globalThis.__SS_STUB_SAFE_STORAGE__` 注入
 * 一个有状态的替身：
 *
 *   { available: boolean, encrypt(plain: string): Buffer, decrypt(buf: Buffer): string }
 *
 * 这样「换一台机器」在探针里只是一个不同的 machineKey，而不是改生产代码。
 */
export const safeStorage = {
  isEncryptionAvailable: () => {
    const cfg = globalThis.__SS_STUB_SAFE_STORAGE__
    if (cfg === undefined) return false
    return cfg.available !== false
  },
  encryptString: (s) => {
    const cfg = globalThis.__SS_STUB_SAFE_STORAGE__
    if (cfg === undefined) return Buffer.from(String(s))
    return cfg.encrypt(String(s))
  },
  decryptString: (b) => {
    const cfg = globalThis.__SS_STUB_SAFE_STORAGE__
    if (cfg === undefined) return Buffer.from(b).toString()
    return cfg.decrypt(Buffer.from(b))
  }
}

/** 记录每次「弹窗」的参数，探针据此断言默认按钮是取消、按钮文案没变过 */
function record(options) {
  const log = globalThis.__SS_STUB_DIALOG_LOG__
  if (Array.isArray(log)) {
    log.push({
      type: options?.type,
      message: options?.message,
      detail: options?.detail,
      buttons: options?.buttons,
      defaultId: options?.defaultId,
      cancelId: options?.cancelId,
      noLink: options?.noLink
    })
  }
}

export const dialog = {
  /** 两种调用形状都支持：showMessageBox(opts) / showMessageBox(win, opts) */
  showMessageBox: (...args) => {
    const options = args.length >= 2 ? args[1] : args[0]
    record(options)
    // 模拟「窗口根本弹不出来」：用来验证 unavailable 这条路径
    if (process.env.SS_STUB_DIALOG_THROW === '1') {
      throw new Error('SS_STUB_DIALOG_THROW')
    }
    const response = Number(process.env.SS_STUB_DIALOG_RESPONSE ?? '1')
    const delay = Number(process.env.SS_STUB_DIALOG_DELAY_MS ?? '0')
    const reply = { response: Number.isFinite(response) ? response : 1, checkboxChecked: false }
    if (Number.isFinite(delay) && delay > 0) {
      return new Promise((resolve) => setTimeout(() => resolve(reply), delay))
    }
    return Promise.resolve(reply)
  }
}

export const BrowserWindow = {
  fromWebContents: () => null,
  getAllWindows: () => []
}

export const webContents = {
  fromId: () => null
}

/**
 * IPC 桩：把通道名和回调记进 globalThis.__SS_IPC__，探针据此直接调用真实处理器。
 * 不做任何参数校验 —— 校验在 src 里，桩要是也校验一遍，探针验的就是桩了。
 */
export const ipcMain = {
  handle: (channel, fn) => {
    const map = globalThis.__SS_IPC__
    if (map instanceof Map) map.set(channel, fn)
  },
  on: (channel, fn) => {
    const map = globalThis.__SS_IPC__
    if (map instanceof Map) map.set(channel, fn)
  },
  removeHandler: noop
}

export const shell = {
  openExternal: async () => undefined
}

export const session = {
  fromPartition: () => ({}),
  defaultSession: {}
}

export const clipboard = {
  writeText: (text) => {
    // 探针要能验证「令牌确实被写进了剪贴板」而不必读系统剪贴板
    globalThis.__SS_STUB_CLIPBOARD__ = String(text)
  },
  readText: () => String(globalThis.__SS_STUB_CLIPBOARD__ ?? '')
}

export default {
  app,
  safeStorage,
  dialog,
  BrowserWindow,
  webContents,
  ipcMain,
  shell,
  session,
  clipboard
}

