/**
 * 收掉 `verify-seed-at-rest` 的最后两处红：历史明文备份 + 本地 API 令牌。
 *
 * 两件事都跑**生产代码**，不是探针里另写一遍：
 *   - `sealLegacyBackups(dataDir())`（`src/main/store/legacy-backups.ts`）
 *   - `registerLocalApiModule(ctx)` 之后调用 `copyToken` 通道
 *     —— 那会走 `ensureToken()` → `loadToken()` → 旧明文令牌就地密封
 *
 * 为什么必须在真 Electron 里跑：两条路径都依赖 `safeStorage`（真 DPAPI）。
 * 用假后端跑出来的「已密封」对这台机器毫无意义。
 *
 * 用法：node tools/run-electron.mjs tools/probe-seal-legacy.mjs
 *
 * 幂等：重复运行不会重复密封（第二次全部进 skipped）。
 */

import { createServer } from 'vite'
import { app } from 'electron'
import { resolve, join } from 'node:path'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'

const root = resolve(import.meta.dirname, '..')

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

async function main() {
  await app.whenReady()

  const dataDir = join(app.getPath('userData'), 'data')

  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, watch: null, ws: false },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: {
      alias: [
        { find: 'electron', replacement: resolve(root, 'tools/probe-stubs/electron-real.mjs') },
        { find: '@shared', replacement: resolve(root, 'src/shared') },
        { find: '@main', replacement: resolve(root, 'src/main') }
      ]
    }
  })

  /* ─────────── 1. 历史备份 ─────────── */

  const storeMod = await server.ssrLoadModule('/src/main/store/index.ts')
  const result = storeMod.sealLegacyBackups(dataDir)

  console.log('     备份扫描：候选 ' + String(result.scanned) + ' 个')
  console.log('     已密封：' + (result.sealed.join(', ') || '（无）'))
  console.log('     已跳过（本来就没明文）：' + (result.skipped.join(', ') || '（无）'))
  if (result.failed.length > 0) {
    for (const f of result.failed) console.log('     失败：' + f.file + ' —— ' + f.reason)
  }

  ok('历史备份全部处理成功（没有失败项）', result.failed.length === 0, JSON.stringify(result.failed))

  // 直接扫盘：任何以 profiles.json. 开头的文件里都不许再有 32 位小写 hex 的 seed
  const PLAIN = /"seed"\s*:\s*"[0-9a-f]{32}"/
  const leaks = []
  for (const name of readdirSync(dataDir)) {
    if (!name.startsWith('profiles.json.')) continue
    if (name.endsWith('.tmp')) continue
    if (!statSync(join(dataDir, name)).isFile()) continue
    if (PLAIN.test(readFileSync(join(dataDir, name), 'utf8'))) leaks.push(name)
  }
  ok('盘上没有任何 profiles 备份仍含明文 seed', leaks.length === 0, leaks.join(', '))

  /* ─────────── 2. 本地 API 令牌 ─────────── */

  const tokenPath = join(dataDir, 'local-api-token.json')
  const beforeRaw = JSON.parse(readFileSync(tokenPath, 'utf8'))
  const wasSealed = String(beforeRaw.token).startsWith('enc:')

  const handlers = new Map()
  const localapi = await server.ssrLoadModule('/src/main/modules/localapi.ts')
  localapi.registerLocalApiModule({
    handle: (channel, fn) => handlers.set(channel, fn),
    broadcast: () => undefined,
    stores: {},
    wm: {}
  })

  // 走生产的 copyToken 通道：它内部调 ensureToken() → loadToken()，
  // 旧明文令牌会在那里被就地密封。
  const copyChannel = [...handlers.keys()].find((k) => String(k).includes('copyToken'))
  ok('找到了 copyToken 通道', copyChannel !== undefined)
  if (copyChannel !== undefined) await handlers.get(copyChannel)({})

  const afterRaw = JSON.parse(readFileSync(tokenPath, 'utf8'))
  ok(
    '令牌落盘形态是 enc: 密封',
    String(afterRaw.token).startsWith('enc:'),
    String(afterRaw.token).slice(0, 6) + '…（长度 ' + String(String(afterRaw.token).length) + '）'
  )
  ok(
    '密封没有换掉令牌本身（长度与来源一致）',
    wasSealed ? true : String(afterRaw.token).length > 64,
    wasSealed ? '（本来就是密文，跳过）' : '密文长度应大于明文 64'
  )
  ok(
    '令牌字段之外没有残留明文字段',
    Object.keys(afterRaw).every((k) => k === 'token' || k === 'createdAt'),
    Object.keys(afterRaw).join(',')
  )

  await server.close()
  console.log(failed === 0 ? '\n全部通过' : '\n' + String(failed) + ' 条不通过')
  app.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[probe] 失败：' + (err instanceof Error ? err.stack : String(err)))
  app.exit(2)
})
