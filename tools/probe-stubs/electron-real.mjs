/**
 * 把**真的** electron 包成 ESM 命名导出，给 `tools/probe-wrap-master-key.mjs` 用。
 *
 * 为什么需要这一层：vite 的 SSR module runner 把 `electron` 当成 CommonJS，
 * 于是 `import { safeStorage } from 'electron'` 会报
 * 「Named export 'safeStorage' not found」。而生产代码（`fingerprint.ts`）用的就是
 * 命名导入 —— 改生产代码去迁就测试工具是本末倒置。
 *
 * 这个 shim 只做转出，**不替换任何实现**：`require('electron')` 在 Electron 主进程里
 * 拿到的就是真 API 对象，所以 `safeStorage` 背后仍然是这台机器上的真 DPAPI。
 * 与 `tools/stub-electron.mjs`（假实现）是两回事，别混用。
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electron = require('electron')

export const app = electron.app
export const safeStorage = electron.safeStorage
export const dialog = electron.dialog
export const BrowserWindow = electron.BrowserWindow
export const webContents = electron.webContents
export const ipcMain = electron.ipcMain
export const shell = electron.shell
export const session = electron.session
export const clipboard = electron.clipboard
export const nativeTheme = electron.nativeTheme

export default electron
