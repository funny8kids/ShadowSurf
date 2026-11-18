/**
 * 跨平台可执行文件定位。
 *
 * 为什么需要这一层：Electron 的 npm 包在 Windows 上把二进制放在
 * `dist/electron.exe`，在 Linux / macOS 上叫 `dist/electron`。
 * 验证脚本里写死 `.exe` 时，Windows 全绿但 Linux 上 Playwright 报
 * `spawn ... electron.exe ENOENT` —— 那不是功能坏了，是测试 harness 假设了平台。
 *
 * 同一个理由适用于系统的 Chrome：找不到时调用方应明确跳过并说明原因，
 * 而不是把「没测到」记成「通过」。
 */

import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '..')

/** Electron 可执行文件（Windows = electron.exe，其他 = electron）。找不到返回 null。 */
export function electronExecutable(root = ROOT) {
  for (const name of ['electron.exe', 'electron']) {
    const path = resolve(root, 'node_modules/electron/dist', name)
    if (existsSync(path)) return path
  }
  return null
}

/**
 * 系统 Chrome（仅用于交叉对照；没有就返回 null，由调用方决定是否跳过）。
 *
 * Linux 上除了发行版路径，还要看 Chrome for Testing / 用户自建 toolchain：
 * 云端 arm64 节点常装不了发行版 Chrome（glibc / snap 沙箱限制），
 * 只能放一份官方 chrome-linux-arm64。写死 /usr/bin/google-chrome 会让
 * 「明明装了浏览器」被判成「没装」，把一次真实的交叉对照误记成跳过。
 * 环境变量 SS_CHROME 优先级最高，供 CI 显式指定。
 */
export function systemChrome() {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const candidates =
    process.platform === 'win32'
      ? [
          process.env.SS_CHROME,
          'C:/Program Files/Google/Chrome/Application/chrome.exe',
          'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
          resolve(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')
        ]
      : process.platform === 'darwin'
        ? [
            process.env.SS_CHROME,
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          ]
        : [
            process.env.SS_CHROME,
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            // 本次 Spark 节点：Chrome for Testing arm64 装在 ~/toolchain
            home && resolve(home, 'toolchain/chrome-linux-arm64/chrome'),
            '/home/Developer/toolchain/chrome-linux-arm64/chrome'
          ]
  for (const path of candidates) {
    if (path && existsSync(path)) return path
  }
  return null
}
