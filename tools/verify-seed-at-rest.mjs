/**
 * 敏感字段落盘门禁（P0-3 的验收工具）。
 *
 * 检查两件事：
 *   1. 数据目录里不得有**明文**的 seed / token / 密钥
 *   2. `master.key` 不得是可被直接拿去做 HKDF 的裸密钥
 *
 * ── 判据的两层，以及它们为什么都要 ──
 *
 * 第一层：`master.key` 不能是裸密钥。
 *   seed 是**可重算的**：`deriveSeed(profileId)` 只依赖 master.key 和 profileId。
 *   只要裸密钥还在盘上，攻击者不需要读 seed —— 他重算一遍就有了。所以这一层是根。
 *
 * 第二层：`profiles.json` 里的 seed 不能是明文。
 *   （**这条前提在 master.key 被 safeStorage 封装之后才成立。** 之前的版本这里写着
 *   「把 seed 字段加密单独做没有意义，因为钥匙躺在同一个目录里」—— 那句话在当时
 *   是对的，现在过期了：DPAPI 封过的密钥拷到别的机器/别的系统账户解不开，
 *   「同一目录」不再等于「同一把钥匙」。保留旧结论会让人以为加密是白做的，
 *   进而把已经修好的东西又改回去。）
 *
 * 真正要回答的问题仍然只有一个：
 *   删掉 master.key、把目录搬到另一台机器，seed 还能不能重建？
 *   不能重建才算修好。第一层管「重算」，第二层管「直接读」。
 *
 * ── 输出纪律 ──
 *
 * **绝不打印命中的原文片段。** 一个「检查明文泄漏」的工具如果把明文打进
 * 日志/CI 输出/终端回滚缓冲，它自己就成了泄漏源。这里只输出
 * 「文件 + 字段名 + sha256 前 12 位 + 长度」，够定位，不够还原。
 *
 * ── 退出码 ──
 *   0  通过
 *   1  不通过（列出文件与字段，不含原文）
 *   3  **未测量**：数据目录不存在（CI 上正常），不等于通过
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve, sep } from 'node:path'
import { homedir, platform, tmpdir } from 'node:os'

/** 视为「凭据」的字段名。命中这些 key 的值必须是密封形态 */
const SENSITIVE_KEYS = ['seed', 'token', 'secret', 'password', 'passwd', 'apikey', 'apiKey', 'privateKey']

/** 密封形态前缀 —— 与 `json-file.ts` 的 SEALED_SEED_RE / `settings.ts` 的 ENC_PREFIX 对齐 */
const SEALED_PREFIX = 'enc:'

/** 看起来像凭据的值：长 hex、长 base64、或 URL-safe 长串 */
const CREDENTIAL_LIKE = /^(?:[0-9a-fA-F]{16,}|[A-Za-z0-9+/_-]{24,}={0,2})$/

/** 本机文件权限（POSIX 才有意义；Windows 上恒为 null） */
function fileMode(path) {
  if (platform() === 'win32') return null
  try {
    return (statSync(path).mode & 0o777).toString(8)
  } catch {
    return null
  }
}

function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function defaultDataDir() {
  if (process.env.SHADOWSURF_DATA_DIR) return process.env.SHADOWSURF_DATA_DIR
  const os = platform()
  if (os === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'ShadowSurf', 'data')
  }
  if (os === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'ShadowSurf', 'data')
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'ShadowSurf', 'data')
}

/**
 * 递归找 JSON 里所有敏感字段。
 * 返回 [{ path, value }]，path 形如 `profiles[2].seed`，便于定位不含原文。
 */
function collectSensitive(node, path, out) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectSensitive(v, `${path}[${i}]`, out))
    return
  }
  for (const [k, v] of Object.entries(node)) {
    const child = path === '' ? k : `${path}.${k}`
    if (SENSITIVE_KEYS.some((s) => s.toLowerCase() === k.toLowerCase())) {
      out.push({ path: child, value: v })
    } else {
      collectSensitive(v, child, out)
    }
  }
}

/* ────────────────────────── 反向验证（--self-test） ────────────────────────── */

/**
 * 自检的目标目录必须是临时目录。
 *
 * 为什么这条要写成运行期断言，而不是「相信 mk() 的返回值」：
 * 门禁的失败方向是不对称的。它漏报，用户下次跑真实门禁时还有机会发现；
 * 但它要是**把真实数据目录当成用例目录**，那一次自检动作就会去密封用户的
 * 生产数据 —— 一次「安全检查」改写生产数据，比它想防的问题严重得多。
 *
 * 而这个回落路径是真实存在的：`defaultDataDir()` 在 `SHADOWSURF_DATA_DIR`
 * 缺失时会返回 `%APPDATA%/ShadowSurf/data`。自检一旦有一条用例忘了显式传
 * 环境变量，走的正是这条回落。所以判据不能是「我传了」，只能是「传进来的
 * 那个路径解析后确实在 tmpdir 下」。
 */
function assertIsolated(dir) {
  let real
  try {
    real = realpathSync(dir)
  } catch {
    real = resolve(dir)
  }
  let tmp
  try {
    tmp = realpathSync(tmpdir())
  } catch {
    tmp = resolve(tmpdir())
  }
  if (real === tmp || real.startsWith(tmp + sep)) return
  throw new Error(
    '自检拒绝执行：用例目录不在临时目录下 —— ' + real + '\n' +
      '  这条断言存在的理由：自检会真的写文件并密封，落到真实数据目录就是改写生产数据。'
  )
}

/**
 * 「门禁现在是绿的」和「门禁能发现明文」是两句完全不同的话。
 *
 * 只有正向读数时，`exit 0` 也可能是因为扫描器压根没扫到东西（路径算错、字段名
 * 对不上、`CREDENTIAL_LIKE` 判据退化成恒假）。所以这里**主动造出违规**，
 * 断言它变红，再改回合规，断言它变绿。
 *
 * 每个用例都在独立临时目录里跑，并且是**真的 spawn 一次自己** —— 验的是 CLI 契约
 * （退出码 + 输出），不是内部函数。门禁的意义就在退出码上。
 *
 * 反向验证必须包含一个「本该绿」的用例（D）。只有红用例的反向验证，无法区分
 * 「门禁有鉴别力」和「门禁坏了，永远红」。
 */
function runSelfTest() {
  let bad = 0
  const say = (name, cond, detail) => {
    if (cond) console.log('ok  ' + name)
    else {
      bad += 1
      console.log('FAIL ' + name + (detail === undefined ? '' : ' —— ' + String(detail)))
    }
  }

  const run = (dir) => {
    // 每条用例都过这道断言，而不是只在 mk() 里断言一次：
    // 将来有人加一条「用现成目录」的用例时，这里是唯一的必经之路。
    assertIsolated(dir)
    const r = spawnSync(process.execPath, [import.meta.filename], {
      // 显式覆盖而不是「依赖继承」：父进程若已设置 SHADOWSURF_DATA_DIR，
      // 展开在前的 process.env 会被后面的显式值覆盖，顺序不能调换。
      env: { ...process.env, SHADOWSURF_DATA_DIR: dir },
      encoding: 'utf8'
    })
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
  }

  const seed = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
  const mk = (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-gate-selftest-'))
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, 'utf8')
    }
    return dir
  }
  const profile = (s) => JSON.stringify([{ id: 'prf_x', seed: s, fingerprint: { os: 'windows' } }], null, 2)

  // A. 明文 seed → 必须红，且要指出是哪一条
  {
    const dir = mk({ 'profiles.json': profile(seed) })
    const r = run(dir)
    say('A1 明文 seed：exit 1', r.code === 1, '实际 exit ' + String(r.code))
    say('A2 明文 seed：输出里点名了字段路径', r.out.includes('profiles.json :: [0].seed'), r.out.split('\n')[0])
    rmSync(dir, { recursive: true, force: true })
  }

  // B. 同一份数据，seed 改成 enc: 形态 → 必须绿
  {
    const dir = mk({ 'profiles.json': profile('enc:' + Buffer.from('x'.repeat(48)).toString('base64')) })
    const r = run(dir)
    say('B1 密封 seed：exit 0', r.code === 0, '实际 exit ' + String(r.code) + ' / ' + r.out.trim().split('\n').pop())
    rmSync(dir, { recursive: true, force: true })
  }

  // C. 裸主密钥 → 必须红
  {
    const dir = mk({ 'master.key': randomBytes(32) })
    const r = run(dir)
    say('C1 裸 master.key：exit 1', r.code === 1, '实际 exit ' + String(r.code))
    say('C2 裸 master.key：分类正确', r.out.includes('raw-master-key'), r.out.split('\n')[0])
    rmSync(dir, { recursive: true, force: true })
  }

  // D. 全合规 → 必须绿（否则 A/B/C 的红可能是「永远红」）
  {
    const dir = mk({
      'profiles.json': profile('enc:' + Buffer.from('y'.repeat(48)).toString('base64')),
      'master.key': 'SSKEYv1:' + Buffer.from('z'.repeat(96)).toString('base64')
    })
    const r = run(dir)
    say('D1 全合规：exit 0', r.code === 0, '实际 exit ' + String(r.code) + ' / ' + r.out.trim().split('\n').pop())
    rmSync(dir, { recursive: true, force: true })
  }

  // E. 隔离断言自己也要能红。
  //    一条从没红过的断言等于不存在：它可能恒真，也可能压根没被调用。
  //    这里拿「真实数据目录」当用例目录喂进去 —— 不实际执行，只要求它被拒。
  {
    const real = defaultDataDir()
    let caught = null
    try {
      run(real)
    } catch (err) {
      caught = err instanceof Error ? err.message : String(err)
    }
    say(
      'E1 真实数据目录被拒（不回落）',
      caught !== null && caught.includes('拒绝执行'),
      caught === null ? '没有抛 —— 隔离断言恒真，等于没有' : caught.split('\n')[0]
    )
    say('E2 报错里点名了那个目录', caught !== null && caught.includes(real), caught ?? '')
  }

  console.log(bad === 0 ? '\n反向验证全部通过' : '\n' + String(bad) + ' 条不通过')
  process.exit(bad === 0 ? 0 : 1)
}

if (process.argv.includes('--self-test')) runSelfTest()

const dataDir = defaultDataDir()

if (!existsSync(dataDir)) {
  console.log(`[未测量] 数据目录不存在：${dataDir}`)
  console.log('  这不是通过。要在真实用户目录上跑才有意义；CI 请显式设置 SHADOWSURF_DATA_DIR。')
  process.exit(3)
}

const problems = []
let scanned = 0
let sensitiveSeen = 0

for (const name of readdirSync(dataDir)) {
  const full = join(dataDir, name)
  let st
  try {
    st = statSync(full)
  } catch {
    continue
  }
  if (!st.isFile()) continue
  scanned++

  let text
  try {
    text = readFileSync(full, 'utf8')
  } catch {
    continue
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    continue // 非 JSON（含 master.key 这类二进制）交给后面的专门检查
  }

  const found = []
  collectSensitive(parsed, '', found)

  for (const { path, value } of found) {
    if (typeof value !== 'string' || value.length === 0) continue
    sensitiveSeen++
    if (value.startsWith(SEALED_PREFIX)) continue
    if (!CREDENTIAL_LIKE.test(value)) continue
    problems.push({
      file: name,
      field: path,
      kind: 'plaintext-credential',
      detail: `长度 ${String(value.length)}，sha256:${fingerprint(value)} —— 非 ${SEALED_PREFIX} 前缀`
    })
  }
}

/**
 * 主密钥判据：必须是「不能直接拿去跑 HKDF」的形态。
 *
 * 只看一件事：有没有版本前缀。刻意不判「熵够不够」——
 * 熵高恰恰是裸密钥的特征，判反了。
 *
 * Windows 上文件权限恒为 644 且 chmod 是空操作，所以权限**不是**这里的控制项；
 * 控制项只能是「密钥本身被 DPAPI 封过」。这也是为什么这条判据不看 mode。
 */
const keyPath = join(dataDir, 'master.key')
let keyMode = null
if (existsSync(keyPath)) {
  const raw = readFileSync(keyPath)
  keyMode = fileMode(keyPath)
  const head = raw.toString('utf8', 0, 16)
  const hasVersionTag = /^SSKEYv\d+:/.test(head)
  if (!hasVersionTag) {
    problems.push({
      file: 'master.key',
      field: '(whole file)',
      kind: 'raw-master-key',
      detail:
        `${String(raw.length)} 字节，无版本前缀 —— 可直接作为 HKDF ikm 使用，` +
        `等于所有 seed 的钥匙明文在盘` +
        (keyMode !== null ? `（mode ${keyMode}）` : '（Windows：文件权限不构成控制项）')
    })
  }
}

console.log(`扫描 ${dataDir}`)
console.log(`  文件 ${String(scanned)} 个，敏感字段 ${String(sensitiveSeen)} 处`)

if (problems.length === 0) {
  console.log('通过：无明文凭据，主密钥非裸密钥形态')
  process.exit(0)
}

console.error(`\n不通过，${String(problems.length)} 处：`)
for (const p of problems) {
  console.error(`  [${p.kind}] ${p.file} :: ${p.field} —— ${p.detail}`)
}
console.error(
  '\n验收口径：不是「密文可读性」，而是「删掉 master.key 并把目录搬到另一台机器，' +
    'seed 还能不能重建」。能重建 = 没修好。'
)
console.error('（本工具刻意不输出原文，只给字段名与 sha256 前缀。）')
process.exit(1)
