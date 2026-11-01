/**
 * 在**真 Electron** 里跑一遍主密钥封装（P0-3 的收尾验收）。
 *
 * 为什么不能用假的 safeStorage 代替：要证的是「这台机器上、这个 Windows 账户下，
 * DPAPI 真的能把裸密钥换成解不走的密文，而且换完之后派生出的 seed 一个都没漂」。
 * 假后端能证明逻辑对，证明不了 DPAPI 真的可用 —— 而后者才是用户会遇到的现实。
 *
 * 所以这个脚本**故意不别名 electron**，`fingerprint.ts` 拿到的就是真模块。
 *
 * 两次 `ssrLoadModule` 用两个独立的 vite server，是为了拿到两份**互不共享模块作用域**
 * 的 `fingerprint.ts` —— 模块里的 `cachedMaster` 是模块级变量，不换模块图就等于
 * 「同一个进程读两次缓存」，证明不了「重启后还能解开」。
 *
 * 用法：node tools/run-electron.mjs tools/probe-wrap-master-key.mjs
 *
 * 副作用：会**原地改写真实数据目录里的 master.key**（裸 32 字节 → SSKEYv1:）。
 * 这正是应用下次启动会做的事，且下面逐条断言「改写前后是同一把密钥」。
 */

import { createServer } from 'vite'
import { app, safeStorage } from 'electron'
import { resolve, join } from 'node:path'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'

const root = resolve(import.meta.dirname, '..')
const PREFIX = 'SSKEYv1:'

/**
 * 裸脚本跑起来时 `app.getName()` 是 "Electron"，于是 userData 会落到
 * `%APPDATA%/Electron` —— 那是另一个目录，探针会对着一个空目录断言成功，
 * 而真实数据一个字节都没动。所以必须显式指到应用真正的目录。
 */
function realUserData() {
  if (process.env.SHADOWSURF_USER_DATA) return process.env.SHADOWSURF_USER_DATA
  const os = platform()
  if (os === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'ShadowSurf')
  }
  if (os === 'darwin') return join(homedir(), 'Library', 'Application Support', 'ShadowSurf')
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'ShadowSurf')
}
app.setPath('userData', realUserData())

let failed = 0
function ok(name, cond, detail) {
  if (cond) console.log('ok  ' + name)
  else {
    failed += 1
    console.log('FAIL ' + name + (detail === undefined ? '' : ' —— ' + String(detail)))
  }
}

async function loadFingerprint() {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, watch: null, ws: false },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: {
      alias: [
        // 必须是**真** electron 的 ESM 转出（见该文件头部的说明）。
        // 换成 stub-electron.mjs 就变成「用假 DPAPI 证明真 DPAPI 可用」，没有意义。
        { find: 'electron', replacement: resolve(root, 'tools/probe-stubs/electron-real.mjs') },
        { find: '@shared', replacement: resolve(root, 'src/shared') },
        { find: '@main', replacement: resolve(root, 'src/main') }
      ]
    }
  })
  const mod = await server.ssrLoadModule('/src/main/core/fingerprint.ts')
  return { mod, server }
}

async function main() {
  await app.whenReady()

  const dataDir = join(app.getPath('userData'), 'data')
  const keyPath = join(dataDir, 'master.key')

  ok('safeStorage 在本机可用', safeStorage.isEncryptionAvailable())
  ok('master.key 存在', existsSync(keyPath), keyPath)

  const before = readFileSync(keyPath)
  const wasRaw = before.length >= 32 && !before.toString('utf8').startsWith(PREFIX)
  console.log(
    `     读到的形态：${wasRaw ? '裸密钥' : '已封装'}，${String(before.length)} 字节`
  )

  // 第一次「启动」
  const first = await loadFingerprint()
  const keyA = first.mod.masterKey()
  const seedA = first.mod.deriveSeed('prf_probe-fixed-id')
  await first.server.close()

  const after = readFileSync(keyPath)
  const text = after.toString('utf8')

  ok('封装后文件带 SSKEYv1: 前缀', text.startsWith(PREFIX), JSON.stringify(text.slice(0, 12)))
  ok('文件里不再出现裸密钥字节', !after.equals(before) || !wasRaw)
  ok('没有留下 .tmp 中间文件', !readdirSync(dataDir).some((n) => n.endsWith('.tmp')))

  // 解回来必须逐位相同 —— 这是「同一把密钥，只是换了外壳」的直接证据
  let roundTrip = null
  try {
    roundTrip = Buffer.from(safeStorage.decryptString(Buffer.from(text.slice(PREFIX.length), 'base64')), 'hex')
  } catch (err) {
    roundTrip = err
  }
  ok(
    '用 DPAPI 解回来与内存里的密钥逐位相同',
    Buffer.isBuffer(roundTrip) && roundTrip.equals(keyA),
    Buffer.isBuffer(roundTrip) ? '长度不同' : String(roundTrip)
  )
  if (wasRaw) {
    ok('封装没有换密钥（仍是原来那 32 字节）', keyA.equals(before.subarray(0, 32)))
  }

  // 第二次「启动」：全新模块图，从盘上重新解
  const second = await loadFingerprint()
  const keyB = second.mod.masterKey()
  const seedB = second.mod.deriveSeed('prf_probe-fixed-id')
  await second.server.close()

  ok('重启后能解出同一把密钥', keyA.equals(keyB))
  ok(
    '重启后派生的 seed 逐位相同（所有环境的指纹都不会漂）',
    seedA === seedB,
    seedA + ' vs ' + seedB
  )

  // 第三次：故意破坏密文，必须抛错而不是静默换新密钥
  console.log('\n（跳过破坏性用例：真实数据目录不拿来试「解不开」）')

  console.log(failed === 0 ? '\n全部通过' : `\n${String(failed)} 条不通过`)
  app.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[probe] 失败：' + (err instanceof Error ? err.stack : String(err)))
  app.exit(2)
})
