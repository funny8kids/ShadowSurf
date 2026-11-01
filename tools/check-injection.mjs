/**
 * 注入脚本语法自检。
 *
 * 为什么需要这个：`buildInjectionScript()` 产出的是**字符串**，它不会被 TypeScript
 * 编译，也不会被任何静态检查覆盖。一旦里面有一个语法错误，整段脚本会在页面里
 * 直接抛 SyntaxError —— 而调用方外面套着 `try { ... } catch (e) {}`，
 * 于是**一声不响地全部失效**：指纹不伪造、反检测不生效，但界面一切正常。
 *
 * 所以每次改 fingerprint.ts 的脚本模板，都要跑这个。
 *
 * 用法：node tools/check-injection.mjs
 * 退出码非 0 表示生成的脚本无法解析。
 */

import { createServer } from 'vite'
import { Script } from 'node:vm'
import { resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const root = resolve(import.meta.dirname, '..')

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  resolve: {
    alias: {
      '@shared': resolve(root, 'src/shared'),
      '@main': resolve(root, 'src/main'),
      // fingerprint.ts 会经 store/db.ts 间接 import electron。纯 Node 里没有这个模块，
      // 换成空壳即可 —— 我们只要 buildInjectionScript() 的返回值，不需要任何真实能力。
      electron: resolve(root, 'tools/stub-electron.mjs')
    }
  }
})

let failed = false
try {
  const fpMod = await server.ssrLoadModule('/src/main/core/fingerprint.ts')
  const presets = await server.ssrLoadModule('/src/shared/presets.ts')

  const seed = 'a'.repeat(64)
  const cases = ['windows', 'macos', 'linux']

  // page 与 worker 是两套完全不同的注入源（Worker 里没有 Navigator/document），
  // 必须分别解析。早先只检查 page 那份，于是 worker 脚本哪怕有语法错误也一路绿。
  const targets = ['page', 'worker']

  for (const os of cases) {
    const cfg = presets.resolveFingerprint(os, seed)

    for (const target of targets) {
      const src = fpMod.buildInjectionScript(cfg, seed, target)

      try {
        // 只解析不执行：vm.Script 的构造期就会跑完整的语法分析
        new Script(src, { filename: `injection-${target}-${os}.js` })
        console.log(`ok   ${os.padEnd(8)} ${target.padEnd(6)} ${src.length} 字节`)
        // 落盘给 tools/probe-mask.cjs / tools/probe-worker.cjs 用 ——
        // 那两个要在真 Chromium 里各跑一遍
        if (os === 'windows') {
          mkdirSync(resolve(root, 'artifacts'), { recursive: true })
          writeFileSync(resolve(root, `artifacts/injection-${target}-windows.js`), src, 'utf8')
          // `tools/probe-mask.cjs` 读的是这个不带 target 的名字，保持兼容。
          // 改文件名会让那条探针静默变成「读不到文件 → exit 2」，
          // 而 exit 2 很容易被当成「环境没装好」而不是「产物名改了」。
          if (target === 'page') {
            writeFileSync(resolve(root, 'artifacts/injection-windows.js'), src, 'utf8')
          }
        }
      } catch (err) {
        failed = true
        console.error(`FAIL ${os}/${target}：${err.message}`)
        // 把出错行附近打出来，否则只给一句 "Unexpected token" 没法定位
        const line = /:(\d+)$/.exec(err.stack ?? '')?.[1]
        if (line) {
          const lines = src.split('\n')
          const n = Number(line)
          for (let i = Math.max(0, n - 3); i < Math.min(lines.length, n + 2); i++) {
            console.error(`  ${String(i + 1).padStart(4)} | ${lines[i]}`)
          }
        }
      }
    }
  }
} finally {
  await server.close()
}

if (failed) {
  console.error('\n注入脚本存在语法错误 —— 页面里会静默失效，必须修')
  process.exit(1)
}
console.log('\n注入脚本语法正常')
