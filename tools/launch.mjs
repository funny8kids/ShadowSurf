/**
 * Electron 启动器。
 *
 * 存在的唯一原因：有些宿主环境（比如各种 Electron 套壳 IDE）会全局设置
 * `ELECTRON_RUN_AS_NODE=1`。带着这个变量启动 electron.exe，它会退化成
 * 纯 Node 跑主进程——`app` 直接是 undefined，报一个和真实原因无关的错。
 *
 * 这里在 spawn 之前把它删掉，让 `npm run dev` / `npm start` 在任何环境下行为一致。
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const mode = process.argv[2] ?? 'dev'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const bin = join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite'
)

const child = spawn(bin, [mode], { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' })

child.on('exit', (code) => process.exit(code ?? 0))
