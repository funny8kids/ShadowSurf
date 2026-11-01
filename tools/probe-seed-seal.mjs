/**
 * seed 落盘密封的验收探针（P0-3）。
 *
 * 要证的不是「代码里出现了 safeStorage」，而是**跑完之后盘上到底有什么**：
 * 明文 seed 还在不在、换一台机器还读不读得回来、迁移会不会把自己隔离掉。
 *
 * 所以这个探针真的读盘、真的走一遍 schema 1 → 2 的迁移，用可编程的假 DPAPI
 * 当加密后端（`tools/stub-electron.mjs` 的 `__SS_STUB_SAFE_STORAGE__`）。
 * 生产代码里没有任何测试后门 —— 假后端只存在于被 vite 别名替换掉的 electron。
 *
 * 七个断言组：
 *   A 读路径：schema 1 的明文 seed → 内存明文、盘上密封、信封升到 2
 *   B 数据目录里**没有任何文件**含明文 seed（含 .preupgrade 备份）
 *   C 迁移备份本身也是密封形态（不是「密文旁边躺明文」）
 *   D 重新实例化（等价于重启）：seed 解回来与原来逐位相同
 *   E 写入路径：update 之后仍然是 schema 2 + 密封
 *   F 换机器：读不到 → 空列表 + corruption.kind === 'crypto'（不是 shape）
 *   G 加密后端不可用：**不迁移**、留在 schema 1、写入照常（不破坏功能）
 *   H 反例：迁移只换信封不换 seed → verify 挡住，文件停在 schema 1，不写坏
 *
 * 用法：node tools/probe-seed-seal.mjs
 */

import { createServer } from 'vite'
import { resolve, join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dirname, '..')

/* ────────────────────────────── 断言 ────────────────────────────── */

let failed = 0
function ok(name, cond, detail) {
  if (cond) {
    console.log('ok  ' + name)
  } else {
    failed += 1
    console.log('FAIL ' + name + (detail === undefined ? '' : ' —— ' + String(detail)))
  }
}

/* ────────────────────── 假 DPAPI：按 machineKey 加密 ────────────────────── */

function makeDpapi(machineKey) {
  return {
    available: true,
    encrypt(plain) {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', machineKey, iv)
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
      return Buffer.concat([iv, c.getAuthTag(), ct])
    },
    decrypt(buf) {
      if (buf.length < 28) throw new Error('密文太短')
      const iv = buf.subarray(0, 12)
      const tag = buf.subarray(12, 28)
      const ct = buf.subarray(28)
      const d = createDecipheriv('aes-256-gcm', machineKey, iv)
      d.setAuthTag(tag)
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
    }
  }
}

const MACHINE_A = makeDpapi(randomBytes(32))
const MACHINE_B = makeDpapi(randomBytes(32))

/* ────────────────────────────── 假世界 ────────────────────────────── */

const userData = mkdtempSync(join(tmpdir(), 'ss-probe-seal-'))
const dataDir = join(userData, 'data')
mkdirSync(dataDir, { recursive: true })

globalThis.__SS_STUB_USER_DATA__ = userData
globalThis.__SS_STUB_SAFE_STORAGE__ = MACHINE_A

const SEEDS = [
  'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  '0123456789abcdef0123456789abcdef',
  'ffffffffffffffffffffffffffffffff'
]

function profileAt(i) {
  return {
    id: 'prf_' + String(i),
    name: '环境 ' + String(i),
    group: '默认',
    color: '#4f8cff',
    status: 'idle',
    platform: 'windows',
    browserVersion: '120.0.0.0',
    seed: SEEDS[i],
    fingerprint: { os: 'windows', uaVersion: '120.0.0.0' },
    proxy: null,
    tags: [],
    note: '',
    createdAt: 1000 + i,
    updatedAt: 1000 + i,
    lastUsedAt: null
  }
}

const profilesFile = join(dataDir, 'profiles.json')
function writeSchema1() {
  writeFileSync(profilesFile, JSON.stringify({ schema: 1, data: [0, 1, 2].map(profileAt) }, null, 2))
}
writeSchema1()

/* ────────────────────────────── 加载 ────────────────────────────── */

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, watch: null, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
  resolve: {
    alias: [
      { find: '@shared', replacement: resolve(root, 'src/shared') },
      { find: '@main', replacement: resolve(root, 'src/main') },
      { find: 'electron', replacement: resolve(root, 'tools/stub-electron.mjs') }
    ]
  }
})

const profilesMod = await server.ssrLoadModule('/src/main/store/profiles.ts')
const jsonFileMod = await server.ssrLoadModule('/src/main/store/json-file.ts')

/* ───────────────────── A. 读路径 + 迁移 ───────────────────── */

const s1 = new profilesMod.ProfileStore()
const list1 = s1.list()
const byId = (list, id) => list.find((p) => p.id === id)

ok('A1 三个环境都读出来了', list1.length === 3, list1.length)
ok(
  'A2 内存里 seed 是明文 hex（可直接喂 dispatchScript）',
  [0, 1, 2].every((i) => byId(list1, 'prf_' + String(i))?.seed === SEEDS[i])
)

const raw1 = JSON.parse(readFileSync(profilesFile, 'utf8'))
ok('A3 落盘已升到 schema 2', raw1.schema === 2, raw1.schema)
ok(
  'A4 落盘 seed 全部是 enc: 形态',
  Array.isArray(raw1.data) &&
    raw1.data.length === 3 &&
    raw1.data.every((p) => /^enc:[A-Za-z0-9+/]+={0,2}$/.test(p.seed)),
  JSON.stringify(raw1.data?.map((p) => String(p.seed).slice(0, 8)))
)

/* ───────────────── B/C. 目录里还有没有明文 ───────────────── */

const files = readdirSync(dataDir).filter((f) => statSync(join(dataDir, f)).isFile())
const leaking = []
for (const f of files) {
  const bytes = readFileSync(join(dataDir, f))
  for (const seed of SEEDS) {
    if (bytes.includes(seed)) leaking.push(f + ' :: ' + seed.slice(0, 6) + '…')
  }
}
ok('B1 数据目录里没有任何文件含明文 seed（含备份）', leaking.length === 0, leaking.join(' | '))

const backups = files.filter((f) => f.startsWith('profiles.json.preupgrade'))
ok('C1 迁移备份存在（回退点没丢）', backups.length === 1, backups.length)
const backup = backups.length === 1 ? JSON.parse(readFileSync(join(dataDir, backups[0]), 'utf8')) : null
ok(
  'C2 备份是 schema 2 且 seed 已密封（不是「密文旁边躺明文」）',
  backup !== null && backup.schema === 2 && backup.data.every((p) => String(p.seed).startsWith('enc:'))
)

/* ───────────────── D. 重启后解回来一模一样 ───────────────── */

const s2 = new profilesMod.ProfileStore()
const list2 = s2.list()
ok(
  'D1 重新读盘：seed 解回与原来逐位相同（身份没漂）',
  list2.length === 3 && [0, 1, 2].every((i) => byId(list2, 'prf_' + String(i))?.seed === SEEDS[i])
)

/* ───────────────── E. 写入路径仍然密封 ───────────────── */

s2.update('prf_1', { name: '改过的名字' })
const raw2 = JSON.parse(readFileSync(profilesFile, 'utf8'))
ok('E1 update 之后仍是 schema 2', raw2.schema === 2, raw2.schema)
ok(
  'E2 update 之后 seed 仍是 enc:（没被明文写回）',
  raw2.data.every((p) => String(p.seed).startsWith('enc:'))
)
ok('E3 update 确实生效', raw2.data.find((p) => p.id === 'prf_1')?.name === '改过的名字')

// 每次启动/停止环境都会触发一次全量 persist。如果每次都重新加密，几十个环境就是
// 几十次 DPAPI 往返，落在 UI 的启动路径上。所以未改动的 seed 必须逐字节稳定。
const encBefore = new Map(raw2.data.map((p) => [p.id, p.seed]))
s2.update('prf_2', { name: '第二次改' })
const raw2b = JSON.parse(readFileSync(profilesFile, 'utf8'))
ok(
  'E4 未改动环境的密文逐字节稳定（没有每次重加密）',
  raw2b.data.every((p) => p.seed === encBefore.get(p.id)),
  raw2b.data.map((p) => (p.seed === encBefore.get(p.id) ? '同' : '变了')).join(',')
)

/* ───────────────── F. 换一台机器 ───────────────── */

globalThis.__SS_STUB_SAFE_STORAGE__ = MACHINE_B
const s3 = new profilesMod.ProfileStore()
const list3 = s3.list()
ok('F1 换机器：解不开 → 读不到任何环境（不会静默换身份）', list3.length === 0, list3.length)
ok(
  'F2 换机器：分类是 crypto（钥匙换了），不是 shape（文件坏了）',
  s3.corruption?.kind === 'crypto',
  s3.corruption?.kind
)

/* ───────────────── G. 加密后端不可用 ───────────────── */

globalThis.__SS_STUB_SAFE_STORAGE__ = {
  available: false,
  encrypt() {
    throw new Error('不可用')
  },
  decrypt() {
    throw new Error('不可用')
  }
}
writeSchema1()
const s4 = new profilesMod.ProfileStore()
const list4 = s4.list()
ok('G1 后端不可用：明文数据照常读出来', list4.length === 3, list4.length)
ok('G2 后端不可用：**不迁移**，文件停在 schema 1', JSON.parse(readFileSync(profilesFile, 'utf8')).schema === 1)
s4.update('prf_2', { name: '离线改' })
ok(
  'G3 后端不可用：写入仍然可用（功能不被安全措施打断）',
  JSON.parse(readFileSync(profilesFile, 'utf8')).data.find((p) => p.id === 'prf_2')?.name === '离线改'
)

/* ───────────────── H. 反例：迁移只换信封不换 seed ───────────────── */

globalThis.__SS_STUB_SAFE_STORAGE__ = MACHINE_A
const trapDir = mkdtempSync(join(tmpdir(), 'ss-probe-seal-trap-'))
const trapFile = join(trapDir, 'profiles.json')
writeFileSync(trapFile, JSON.stringify({ schema: 1, data: [0, 1, 2].map(profileAt) }, null, 2))

const trap = new jsonFileMod.JsonStore(trapFile, () => [], (data, schema, file) => jsonFileMod.validateProfiles(data, schema, file), {
  schema: jsonFileMod.SCHEMA_SEALED,
  // 刻意不传 serialize：模拟「迁移只把信封升到 2、seed 还是明文」这个错误
  verify: jsonFileMod.validateProfiles
})
const got = trap.readResult()
ok('H1 反例：没有把「版本号说 2、seed 还是明文」写出去', JSON.parse(readFileSync(trapFile, 'utf8')).schema === 1)
ok('H2 反例：读路径仍返回数据（只在内存里升级，数据没丢）', got.ok === true && got.value.length === 3)
ok('H3 反例：失败后不留下来路不明的备份', readdirSync(trapDir).length === 1, readdirSync(trapDir).join(','))

/* ────────────────────────────── 收尾 ────────────────────────────── */

await server.close()

if (failed > 0) {
  console.error('\n' + String(failed) + ' 条不通过')
  process.exit(1)
}
console.log('\n全部通过（数据目录：' + dataDir + '）')
