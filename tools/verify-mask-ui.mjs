/**
 * 「伪装状态点」的运行时验收。
 *
 * ── 为什么必须有这一条 ──
 *
 * `tests/mask-gate.test.ts` 能证明「判定表每一行的色调对得上」，
 * 但它证明不了**过 IPC 的那份载荷**里带着门禁结论。中间还隔着一层
 * `maskRowOf()`：如果它哪天把 `allow` 写成常量、或者把 `kind` 丢了，
 * 判定表测试照样全绿，而界面上那个点会变成一句永远为真的谎话。
 *
 * 所以分两段跑：
 *
 *   A. 纯 Node：判定表 10 行逐行过 `maskRowOf` → `maskToneOf`，色调必须等于
 *      表里写死的 tone 列；截断规则、`kind`/`reason` 的空值约定也在这里钉住。
 *   B. 真 Electron：`window.ss.mask.list()` 拿到的每一行，(allow, kind) 必须
 *      是判定表里**真实存在的一格**。这条防的是「界面自己判了一个表外的组合」，
 *      比如 allow=true 却带着 kind='page-degraded' —— 那种组合不可能来自
 *      judgeMask，只可能来自某处手写。
 *
 * 跑法：npm run verify:mask-ui（B 段需要先 npm run build）
 * 退出码：0 成立 / 1 不成立 / 2 脚本自身崩了
 */

import { resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const ROOT = resolve(import.meta.dirname, '..')

const out = { steps: [], failures: [] }
const step = (id, label, data) => out.steps.push({ id, label, ...data })
const fail = (msg) => out.failures.push(msg)

const { judgeMask, maskRowOf, MASK_DECISION_TABLE } = await import(
  '../src/main/core/mask-gate.ts'
)
const { maskToneOf } = await import('../src/shared/mask-ui.ts')

const rec = (state, failed = []) => ({
  webContentsId: 7,
  profileId: 'prf_probe',
  state,
  failed,
  at: 1761926400000
})

/* ────────────── A. 载荷构造器与判定表逐行一致 ────────────── */

try {
  const rows = []
  for (const row of MASK_DECISION_TABLE) {
    const record =
      row.input === 'missing'
        ? null
        : rec(
            row.input,
            row.input === 'degraded'
              ? [{ attr: 'canvas', reason: '注入失败', source: row.source }]
              : []
          )
    const verdict = judgeMask(record)
    // 没有 record 时没有「行」可发，用 verdict 直接看色调
    const tone =
      record === null ? maskToneOf(verdict, true) : maskToneOf(maskRowOf(record), true)
    rows.push({
      input: row.input,
      source: row.source,
      allow: verdict.allow,
      kind: verdict.allow ? null : verdict.kind,
      tone,
      expected: row.tone,
      ok: tone === row.tone
    })
    if (tone !== row.tone) {
      fail(`${row.input} × ${row.source}：门禁给 ${tone}，表里写的是 ${row.tone}`)
    }
  }
  step('table', '判定表 10 行 → 载荷 → 色调', { rows })
} catch (err) {
  fail('A 段异常：' + String((err && err.message) || err))
}

/* ────────────── A2. 载荷形态：截断与空值约定 ────────────── */

try {
  const okRow = maskRowOf(rec('ok'))
  step('row-ok', '状态 ok 的载荷', {
    allow: okRow.allow,
    kind: okRow.kind,
    reason: okRow.reason,
    hasWebContentsId: 'webContentsId' in okRow
  })
  if (okRow.allow !== true) fail('ok 状态必须放行')
  if (okRow.kind !== null) fail('放行时 kind 必须是 null，否则界面会拿它选颜色')
  if (okRow.reason !== '') fail('放行时 reason 必须是空串（界面回落到固定文案）')
  if ('webContentsId' in okRow) fail('载荷里带了 webContentsId：渲染层不该知道进程内编号')

  const longAttr = 'a'.repeat(200)
  const longReason = 'b'.repeat(500)
  const broken = maskRowOf(
    rec('degraded', [{ attr: longAttr, reason: longReason, source: 'page' }])
  )
  const f = broken.failed[0]
  step('row-truncate', '超长 attr / reason 必须截断', {
    attrLen: f.attr.length,
    reasonLen: f.reason.length,
    allow: broken.allow,
    kind: broken.kind
  })
  if (f.attr.length > 40) fail(`attr 未截断到 40：${String(f.attr.length)}`)
  if (f.reason.length > 120) fail(`reason 未截断到 120：${String(f.reason.length)}`)
  if (broken.allow !== false) fail('page 侧失败必须拦，否则界面画绿而门禁在拦')
  if (broken.kind !== 'page-degraded') fail(`page 侧失败 kind 应为 page-degraded，实际 ${String(broken.kind)}`)

  // 放行但降级（只有子目标失败）→ 必须是 warn，不能是 ok
  const warn = maskRowOf(rec('degraded', [{ attr: 'worker', reason: '注入已停用', source: 'worker' }]))
  step('row-warn', '只有子目标失败时的载荷', {
    allow: warn.allow,
    kind: warn.kind,
    tone: maskToneOf(warn, true)
  })
  if (warn.allow !== true) fail('worker 侧失败不该拦 L2（会把所有 L2 拦死）')
  if (maskToneOf(warn, true) !== 'warn') fail('放行但降级必须画黄，画绿等于把降级抹掉')
} catch (err) {
  fail('A2 段异常：' + String((err && err.message) || err))
}

/* ────────────── B. 真 Electron：IPC 载荷的每一格必须在表内 ────────────── */

/**
 * 判定表里的合法组合。
 *
 * 表里放行行的 `kind` 写的是 `'—'`（占位），而载荷里放行行的 `kind` 是 `null`
 * —— 两边必须先归一化再比，否则这一条会对着正确的实现报假红。
 */
const legal = new Set(
  MASK_DECISION_TABLE.map((r) => `${String(r.allow)}|${String(r.allow ? null : r.kind)}`)
)

let app = null
try {
  const { _electron: electron } = await import('playwright-core')
  const env = { ...process.env, NODE_ENV: 'production' }
  delete env.ELECTRON_RUN_AS_NODE

  app = await electron.launch({
    executablePath: resolve(ROOT, 'node_modules/electron/dist/electron.exe'),
    args: ['.', '--user-data-dir=' + resolve(ROOT, 'artifacts/mask-ui-ud')],
    cwd: ROOT,
    env,
    timeout: 40000
  })

  const main = await app.firstWindow({ timeout: 25000 })
  await main.waitForTimeout(1500)

  // 至少一个环境，然后打开它 —— 没有窗口就没有读数，这一条是「有没有接上」的前提
  let list = await main.evaluate(async () => await window.ss.profiles.list())
  if (!Array.isArray(list) || list.length === 0) {
    await main.evaluate(
      async () =>
        await window.ss.profiles.create({
          name: '验收-mask-ui',
          platform: 'windows',
          fingerprint: null
        })
    )
    list = await main.evaluate(async () => await window.ss.profiles.list())
  }
  if (!Array.isArray(list) || list.length === 0) throw new Error('建不出环境，无法继续')
  const target = list[0]

  await main.evaluate(async (id) => await window.ss.profiles.launch(id), target.id)

  // 等第一条读数到达：注入是异步的，立刻查必然空
  let rows = []
  for (let i = 0; i < 40; i += 1) {
    rows = await main.evaluate(async () => await window.ss.mask.list())
    if (Array.isArray(rows) && rows.length > 0) break
    await main.waitForTimeout(250)
  }

  const snapshot = (rs) =>
    Array.isArray(rs)
      ? rs.map((r) => ({ state: r.state, allow: r.allow, kind: r.kind, failed: r.failed.length }))
      : null

  step('ipc', 'mask.list() 首条读数', {
    count: Array.isArray(rows) ? rows.length : -1,
    rows: snapshot(rows)
  })

  /* 再等一轮：`unknown` 是「脚本下发了、还没回读」，
   * 只有台账回读之后才会变 ok/degraded。两条读数一起记，
   * 才能说清「这个点是刚打开时的样子，还是稳定后的样子」。 */
  await main.waitForTimeout(6000)
  const settled = await main.evaluate(async () => await window.ss.mask.list())
  step('ipc-settled', 'mask.list() 等 6 秒后', {
    count: Array.isArray(settled) ? settled.length : -1,
    rows: snapshot(settled)
  })

  if (!Array.isArray(rows)) {
    fail('mask.list() 没有返回数组 —— 通道没接上')
  } else if (rows.length === 0) {
    fail('打开了环境却没有任何读数 —— listMaskStates 或 pushMaskRows 没接上')
  } else {
    for (const r of [...rows, ...(Array.isArray(settled) ? settled : [])]) {
      if ('webContentsId' in r) fail('载荷里带了 webContentsId')
      const key = `${String(r.allow)}|${String(r.allow ? null : r.kind)}`
      if (!legal.has(key)) {
        fail(`表外组合 allow=${String(r.allow)} kind=${String(r.kind)}：这不可能是 judgeMask 算出来的`)
      }
      if (r.allow === true && r.reason !== '') fail('放行时 reason 必须是空串')
      if (r.allow === false && (typeof r.reason !== 'string' || r.reason === '')) {
        fail('拒绝时必须带 reason，否则界面没有 tooltip 可显示')
      }
    }
  }
} catch (err) {
  fail('B 段异常：' + String((err && err.message) || err))
} finally {
  try {
    if (app !== null) await app.close()
  } catch {
    /* 关不掉不影响读数 */
  }
}

mkdirSync(resolve(ROOT, 'artifacts'), { recursive: true })
writeFileSync(resolve(ROOT, 'artifacts/mask-ui.json'), JSON.stringify(out, null, 2), 'utf8')

console.log('\n===== 伪装状态点 —— 运行时验收 =====\n')
for (const s of out.steps) {
  const { id, label, ...rest } = s
  console.log('[' + id + '] ' + label)
  for (const [k, v] of Object.entries(rest)) console.log('      ' + k + ' = ' + JSON.stringify(v))
  console.log('')
}

if (out.failures.length > 0) {
  console.log('不成立：')
  for (const f of out.failures) console.log('  ✗ ' + f)
  console.log('\n完整读数：artifacts/mask-ui.json')
  process.exit(1)
}
console.log('成立：判定表 10 行的色调逐行一致，载荷截断与空值约定成立，IPC 上没有表外组合')
console.log('完整读数：artifacts/mask-ui.json')
