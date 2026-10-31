/**
 * 启动 Electron 跑一个脚本，并把 `ELECTRON_RUN_AS_NODE` 从环境里摘掉。
 *
 * 为什么需要这一层：本机（以及不少 CI 镜像）会把 `ELECTRON_RUN_AS_NODE=1` 写在环境里，
 * 此时 `npx electron x.cjs` 实际是用 Electron 自带的 Node 跑 x.cjs ——
 * `require('electron')` 返回的是可执行文件路径字符串，不是 API 对象，
 * 报错是 `Cannot read properties of undefined (reading 'disableHardwareAcceleration')`，
 * 看起来像代码写错了，其实只是环境变量没清。
 *
 * 用法：node tools/run-electron.mjs tools/probe-mask.cjs
 */

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const target = process.argv[2]
if (!target) {
  console.error('用法：node tools/run-electron.mjs <脚本路径>')
  process.exit(2)
}

const root = resolve(import.meta.dirname, '..')
const env = { ...process.env }
delete env['ELECTRON_RUN_AS_NODE']

// 直接找 electron 包暴露的可执行文件，绕开 npx 的解析
const electronBin = resolve(root, 'node_modules/electron/dist/electron.exe')
const isWin = process.platform === 'win32'
const bin = isWin ? electronBin : resolve(root, 'node_modules/electron/dist/electron')

const child = spawn(bin, [resolve(root, target)], {
  cwd: root,
  env,
  stdio: 'inherit'
})

child.on('exit', (code) => process.exit(code ?? 0))
