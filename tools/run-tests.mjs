/**
 * 测试入口（跨平台设置环境变量）。
 *
 * 为什么需要这个包装：`SS_REQUIRE_FRESH_BUILD=1 node --test ...` 这种写法只在
 * POSIX shell 里成立。Windows 上 npm 默认走 cmd.exe，`VAR=1 cmd` 会被当成命令名
 * 直接失败。而 CI 与本地可能不是同一个平台 —— 一条「在开发机上永远 skip」的断言，
 * 就是恒真断言的另一种形态。
 *
 * 两种模式：
 *   默认        `node tools/run-tests.mjs`          → 日常 check，构建产物旧就 skip
 *   门禁        `node tools/run-tests.mjs --gate`   → 构建产物旧就 fail
 *
 * 为什么门禁模式必须存在：`npm run check` 不 build，所以「诊断通道不得进产物」
 * 这条断言在标准流程下**恒为 skip**。一条永远 skip 的断言不是覆盖，是占位。
 * 门禁与日常必须是两个明确不同的入口，而不是同一个入口靠人记得加参数。
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const gate = process.argv.includes('--gate')

const env = { ...process.env }
if (gate) env.SS_REQUIRE_FRESH_BUILD = '1'
else delete env.SS_REQUIRE_FRESH_BUILD

const args = ['--experimental-strip-types', '--test']

// 允许透传额外的 node:test 参数（例如指定单个文件）
const passthrough = process.argv.slice(2).filter((a) => a !== '--gate')
args.push(...(passthrough.length > 0 ? passthrough : ['tests/*.test.ts']))

const r = spawnSync(process.execPath, args, {
  cwd: resolve(import.meta.dirname, '..'),
  env,
  stdio: 'inherit',
  // Windows 上 `tests/*.test.ts` 由 node 自己展开，不经过 shell，所以不需要 glob 支持
  shell: false
})

if (r.error) {
  console.error('[run-tests] 启动失败：' + r.error.message)
  process.exit(2)
}
process.exit(r.status ?? 2)
