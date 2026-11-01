/**
 * 构建产物新鲜度检查。
 *
 * 为什么需要：`tools/verify-anticheat.mjs` 跑的是 `out/` 里的打包产物，而它
 * **不会自己构建**。改了 `src/` 却没 build，门禁就会拿着旧包测，然后把结论
 * 写进 JSON —— 报告上标着当前 commit，内容却来自上一个版本。
 *
 * ── 历史事故（顺序很重要，别写反） ──
 *
 *   1. 反检测门禁读旧包，把**已经修好的** Intl 判成红的 —— 误报（红，但其实没问题）。
 *   2. 同一份旧包上的另外 16 条是**绿的** —— 那 16 条的覆盖面是旧掩码表，
 *      不是当时那张 57 项的新表。这是假绿（绿，但其实没测到）。
 *
 * 两次方向相反，病根相同：**测量对象不是声称的那个对象**。
 * 所以这个脚本的职责只有一件事 —— 保证「测的那个包」就是「src 现在的样子」。
 *
 * ── 退出码三态，不要合并 ──
 *
 *   0   新鲜，可以测
 *    3  **未测量**：产物比源码旧，测了也不是现在这份代码
 *   1   检查本身跑不动（out/ 不存在、读目录失败）
 *
 * 3 与 1 分开是刻意的：把「没测」和「测了没过」混成
 * 同一个非零码，上层脚本与看板就无法区分「门禁失败」和「门禁没跑」——
 * 而这正是上面两次事故的同一种错，只是换了个位置犯。
 *
 * ── 本脚本管不到的两件事，别指望它 ──
 *
 *   1. **产物完整性**。它只比 mtime，不比「三件产物是否都在」。
 *      `electron-vite build` 的 `prepareOutDir` 会先 `emptyDir(out/)`，这一步在
 *      Windows 上可能失败（实测 `[safe-delete] 操作失败 … trash operation aborted`），
 *      而失败发生在**清空之后、重建之前** —— 于是 `out/` 会停在
 *      「main 建好、preload 没了」的残缺状态，而 mtime 是新的，本脚本照样判新鲜。
 *      完整性由 `tools/verify-anticheat.mjs` 在跑任何 AC 之前自检，缺失即 exit 2。
 *
 *   2. **并发构建会互相破坏**。两个人同时 `electron-vite build`，两个 `prepareOutDir`
 *      会互相清掉对方刚写好的产物，最后 `out/` 是哪一份取决于谁后结束。
 *      症状就是上面那条残缺，或者「产物是新的但内容是别人的」。
 *      → `out/` 同一时刻只能有一个写者。跑门禁前确认没有别人在 build。
 *
 * 用法：
 *   node tools/check-build-fresh.mjs               # CI：陈旧即拒
 *   node tools/check-build-fresh.mjs --allow-stale # 本地：陈旧则警告并继续（退出 0）
 */

import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const allowStale = process.argv.includes('--allow-stale')

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

if (!existsSync(join(root, 'out')) || outAt === 0) {
  console.error('out/ 不存在 —— 先跑 npm run build')
  process.exit(1)
}

if (srcAt > outAt) {
  const gap = Math.round((srcAt - outAt) / 1000)
  const detail =
    `out/ 比 src/ 旧 ${gap} 秒，门禁会拿旧包测出新结论。\n` +
    `  源码最新改动：${new Date(srcAt).toLocaleString()}\n` +
    `  产物最新时间：${new Date(outAt).toLocaleString()}\n`
  if (allowStale) {
    console.warn(`[stale] ${detail}本次带 --allow-stale，继续执行 —— 结论只能算参考。`)
    process.exit(0)
  }
  console.error(`${detail}先跑 npm run build 再测。`)
  // 3 = 未测量：与 verify-anticheat 的 1（断言失败）、2（脚本崩溃）区分开。
  process.exit(3)
}

console.log(`构建产物是新的（产物 ${new Date(outAt).toLocaleString()}）`)
