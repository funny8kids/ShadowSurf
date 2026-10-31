/**
 * 构建产物新鲜度检查。
 *
 * 为什么需要：`tools/verify-anticheat.mjs` 跑的是 `out/` 里的打包产物，而它
 * **不会自己构建**。改了 `src/` 却没 build，门禁就会拿着旧包测，然后把结论
 * 写进 JSON —— 报告上标着当前 commit，内容却来自上一个版本。
 *
 * 这一轮已经因为同一个病根出过两次事故：
 *   1. 有人拿「工作区代码」当 HEAD 去量，得出「locale 出口零处理」的错误结论；
 *   2. 反检测门禁读旧包，把已修好的 Intl 判成红的。
 * 两次都是「测量对象不是声称的那个对象」。
 *
 * 用法：node tools/check-build-fresh.mjs
 * 退出码非 0 表示 out/ 比 src/ 旧，必须先 npm run build。
 */

import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/** 递归取目录里最新的 mtime；目录不存在返回 0 */
function newest(dir) {
  let max = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      max = Math.max(max, newest(p))
    } else {
      try {
        max = Math.max(max, statSync(p).mtimeMs)
      } catch {
        // 单个文件读不到不影响整体判断
      }
    }
  }
  return max
}

const srcAt = newest(join(root, 'src'))
const outAt = newest(join(root, 'out'))

if (outAt === 0) {
  console.error('out/ 不存在 —— 先跑 npm run build')
  process.exit(1)
}

if (srcAt > outAt) {
  const gap = Math.round((srcAt - outAt) / 1000)
  console.error(
    `out/ 比 src/ 旧 ${gap} 秒，门禁会拿旧包测出新结论。\n` +
      `  源码最新改动：${new Date(srcAt).toLocaleString()}\n` +
      `  产物最新时间：${new Date(outAt).toLocaleString()}\n` +
      `先跑 npm run build 再测。`
  )
  process.exit(1)
}

console.log(`构建产物是新的（产物 ${new Date(outAt).toLocaleString()}）`)
