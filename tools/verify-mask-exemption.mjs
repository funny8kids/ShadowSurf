/**
 * 「伪装闸门豁免」（`Profile.allowUnmaskedL2`）的运行时验收。
 *
 * 为什么必须真机跑：这条链上的四条保证**都不在类型里**。
 *   1. 默认关闭 —— 新建 / 导入 / 克隆都不能带出来；
 *   2. 只能从一条 IPC 开（`profiles.setExemption`），`update()` 改不动它；
 *   3. 开启必须手打环境名，且比对在主进程做；
 *   4. 伪装修好（maskState → ok）时自动收回，并留一条审计。
 *
 * 第 4 条尤其只能在这里验：它是「事件驱动的副作用」，单测里没有窗口、没有 mask 状态。
 *
 * 判据全部来自**运行时读数**（IPC 返回值 + 审计链），不读源码。
 *
 * 跑法：npm run verify:mask-exemption（先 electron-vite build）
 * 退出码：0 = 全部成立；1 = 有判据不成立；2 = 脚本自身崩了；3 = 读数没取到（未测量）
 */

import { _electron as electron } from 'playwright-core'
import { resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const ROOT = resolve(import.meta.dirname, '..')
const ART = resolve(ROOT, 'artifacts')

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE

const out = { at: null, steps: [], gates: [], notes: [], error: null }
const finish = (code, msg) => {
  if (msg) console.log('\n' + msg)
  out.at = new Date().toISOString()
  mkdirSync(ART, { recursive: true })
  writeFileSync(resolve(ART, 'mask-exemption.json'), JSON.stringify(out, null, 2), 'utf8')
  console.log('\n完整读数：artifacts/mask-exemption.json')
  process.exit(code)
}
const gate = (id, label, expected, actual, pass, note) => {
  out.gates.push({ id, label, expected, actual, pass, note: note || '' })
}

let app = null
try {
  app = await electron.launch({
    executablePath: resolve(ROOT, 'node_modules/electron/dist/electron.exe'),
    args: ['.', '--user-data-dir=' + resolve(ART, 'mask-exemption-ud')],
    cwd: ROOT,
    env,
    timeout: 40000
  })

  const main = await app.firstWindow({ timeout: 25000 })
  await main.waitForTimeout(1500)

  /* ── 1. 新建不带豁免 ──
   *
   * 先清掉上一次跑剩下的同名环境：探针复用同一个 user-data-dir，
   * 而「默认关闭」这条判据只有在**新建**出来的环境上才有意义。
   * 复用旧环境会让这条判据读到上一次留下的 true，看起来像「默认值错了」——
   * 那是探针自己制造的假红，比假绿好一点，但同样是错的。 */
  const created = await main.evaluate(async () => {
    const stale = (await window.ss.profiles.list()).filter((p) => p.name.startsWith('验收-豁免'))
    for (const p of stale) {
      try {
        await window.ss.profiles.remove(p.id)
      } catch (e) {
        /* 已经没了就忽略 */
      }
    }
    const p = await window.ss.profiles.create({ name: '验收-豁免', platform: 'windows' })
    return { removed: stale.length, profile: p }
  })
  out.steps.push({ step: 'create', ...created })
  gate(
    'create-default-off',
    '新建的环境默认不开豁免',
    false,
    created.profile.allowUnmaskedL2,
    created.profile.allowUnmaskedL2 === false,
    created.profile.allowUnmaskedL2 === false ? '' : '默认值不是 false —— 这是最危险的一种默认'
  )
  const id = created.profile.id
  const name = created.profile.name

  /* ── 2. `update()` 改不动它 ──
   *
   * 这是本项最关键的一条：`update` 的入参是 `Partial<Profile>`，渲染层被 XSS 之后
   * 发的是裸 JSON。如果它能写这个字段，「手打环境名」那道闸等于不存在。 */
  const viaUpdate = await main.evaluate(async (pid) => {
    let threw = null
    try {
      await window.ss.profiles.update(pid, { allowUnmaskedL2: true })
    } catch (e) {
      threw = String((e && e.message) || e)
    }
    const after = (await window.ss.profiles.list()).find((p) => p.id === pid)
    return { threw, value: after ? after.allowUnmaskedL2 : null }
  }, id)
  out.steps.push({ step: 'update-cannot-set', ...viaUpdate })
  gate(
    'update-cannot-set',
    'update({ allowUnmaskedL2: true }) 不能写这个字段',
    false,
    viaUpdate.value,
    viaUpdate.value === false,
    viaUpdate.value === false
      ? ''
      : 'update 把豁免写进去了 —— 渲染层一句裸 JSON 就能关掉闸门'
  )

  /* ── 3. create 里带 true 也不生效 ── */
  const viaCreate = await main.evaluate(async () => {
    const p = await window.ss.profiles.create({
      name: '验收-豁免-create',
      platform: 'windows',
      allowUnmaskedL2: true
    })
    await window.ss.profiles.remove(p.id)
    return p.allowUnmaskedL2
  })
  out.steps.push({ step: 'create-cannot-set', value: viaCreate })
  gate(
    'create-cannot-set',
    'create({ allowUnmaskedL2: true }) 不能带出豁免',
    false,
    viaCreate,
    viaCreate === false,
    viaCreate === false ? '' : 'create 接受了这个字段 —— 建一个环境就能绕过确认'
  )

  /* ── 4. 名字不对必须拒绝（且主进程拒，不是界面拦） ── */
  const wrong = await main.evaluate(async (a) => {
    let threw = null
    try {
      await window.ss.profiles.setExemption(a.id, true, '不存在的名字')
    } catch (e) {
      threw = String((e && e.message) || e)
    }
    const after = (await window.ss.profiles.list()).find((p) => p.id === a.id)
    return { threw, value: after ? after.allowUnmaskedL2 : null }
  }, { id })
  out.steps.push({ step: 'wrong-name-rejected', ...wrong })
  gate(
    'wrong-name-rejected',
    '环境名不对时拒绝开启，且状态不变',
    '抛错 + 仍为 false',
    { threw: wrong.threw !== null, value: wrong.value },
    wrong.threw !== null && wrong.value === false,
    wrong.threw !== null && wrong.value === false ? '' : '名字不对却开成功了 —— 确认这一步是假的'
  )

  /* ── 5. 名字对 → 开启 ── */
  const on = await main.evaluate(
    async (a) => await window.ss.profiles.setExemption(a.id, true, a.name),
    { id, name }
  )
  out.steps.push({ step: 'enable', value: on.allowUnmaskedL2 })
  gate('enable', '环境名对上时开启成功', true, on.allowUnmaskedL2, on.allowUnmaskedL2 === true,
    on.allowUnmaskedL2 === true ? '' : '名字对了却开不了')

  /* ── 6. 克隆不继承 ── */
  const cloned = await main.evaluate(async (pid) => {
    const c = await window.ss.profiles.clone(pid, { name: '验收-豁免-副本' })
    await window.ss.profiles.remove(c.id)
    return c.allowUnmaskedL2
  }, id)
  out.steps.push({ step: 'clone-resets', value: cloned })
  gate('clone-resets', '克隆不继承豁免', false, cloned, cloned === false,
    cloned === false ? '' : '副本继承了豁免 —— 等于没有确认就多了一个豁免环境')

  /* ── 7. 自动收回：伪装修好之后 ──
   *
   * 启动窗口 → 等 mask 状态变成 ok → 豁免应当被自动收回，并留一条审计。
   * 这条只能真机验：它是事件驱动的副作用。 */
  // 审计断言必须只看**本次**新增的记录：探针复用同一个 user-data-dir，
  // 上一次跑留下的那条会让这条判据恒绿（第一次反向验证时就这么骗过去了一格）。
  const auditMark = Date.now()
  await main.evaluate(async (pid) => await window.ss.profiles.launch(pid), id)

  let maskRows = []
  let revoked = null
  for (let i = 0; i < 40; i++) {
    await main.waitForTimeout(500)
    maskRows = await main.evaluate(async () => await window.ss.mask.list())
    const mine = Array.isArray(maskRows) ? maskRows.find((r) => r.profileId === id) : null
    if (mine && mine.state === 'ok') {
      // 状态到 ok 之后，主进程那条回调应该已经把豁免收回了。
      // 再等一小会儿让 update + 审计落盘。
      await main.waitForTimeout(600)
      revoked = await main.evaluate(
        async (pid2) => (await window.ss.profiles.list()).find((p) => p.id === pid2),
        id
      )
      break
    }
  }
  const maskState = (maskRows || []).find((r) => r.profileId === id)?.state ?? null
  out.steps.push({ step: 'auto-revoke', maskState, value: revoked ? revoked.allowUnmaskedL2 : null })

  if (maskState !== 'ok') {
    gate(
      'auto-revoke',
      '伪装修好后自动收回豁免',
      'maskState=ok 且 allowUnmaskedL2=false',
      { maskState, value: revoked ? revoked.allowUnmaskedL2 : null },
      null,
      '没等到 maskState=ok（读到 ' + String(maskState) + '），这条未测量 —— 不是通过'
    )
  } else {
    gate(
      'auto-revoke',
      '伪装修好后自动收回豁免',
      'allowUnmaskedL2=false',
      revoked ? revoked.allowUnmaskedL2 : null,
      revoked !== null && revoked.allowUnmaskedL2 === false,
      revoked !== null && revoked.allowUnmaskedL2 === false
        ? ''
        : '伪装已经 ok，豁免却还开着 —— 修好的环境继续留着安全洞'
    )
  }

  /* ── 8. 收回这件事必须留审计 ── */
  const audit = await main.evaluate(async () => await window.ss.audit.list())
  const lines = (Array.isArray(audit) ? audit : []).filter(
    (e) => Number(e.at) >= auditMark && String(e.detail || '').includes('allowUnmaskedL2')
  )
  out.steps.push({ step: 'audit', since: auditMark, count: lines.length, sample: lines.slice(-2) })
  gate(
    'audit-revoke',
    '自动收回要写进审计（否则「谁把闸门关回去的」查不到）',
    '本次运行内至少 1 条含 allowUnmaskedL2 的审计',
    lines.length,
    lines.length > 0,
    lines.length > 0
      ? ''
      : '收回没有留痕（只数本次运行之后的记录：复用 user-data-dir 时旧记录会让这条恒绿）'
  )

  /* ── 打印 ── */
  console.log('\n===== 伪装闸门豁免（allowUnmaskedL2）=====\n')
  console.log('环境：' + name + '（' + id + '）')
  console.log('\n[读数]')
  for (const s of out.steps) {
    const brief = Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'step'))
    console.log('  ' + String(s.step).padEnd(22) + JSON.stringify(brief).slice(0, 180))
  }
  console.log('\n[结论]')
  let bad = 0
  let unmeasured = 0
  for (const g of out.gates) {
    const tag = g.pass === null ? '未测量' : g.pass ? '成立' : '不成立'
    if (g.pass === false) bad += 1
    if (g.pass === null) unmeasured += 1
    console.log('  ' + tag.padEnd(4) + ' ' + g.label + '  期望 ' + JSON.stringify(g.expected) + ' 实得 ' + JSON.stringify(g.actual))
    if (g.pass !== true && g.note) console.log('        ↳ ' + g.note)
  }

  try { await app.close() } catch (e) {}
  finish(
    bad > 0 ? 1 : unmeasured > 0 ? 3 : 0,
    bad > 0
      ? `${out.gates.length - bad - unmeasured}/${out.gates.length} 成立，${bad} 条不成立`
      : unmeasured > 0
        ? `${out.gates.length - unmeasured}/${out.gates.length} 成立，${unmeasured} 条未测量`
        : `全部 ${out.gates.length} 条成立`
  )
} catch (err) {
  out.error = String((err && err.message) || err)
  if (app) { try { await app.close() } catch (e) {} }
  finish(2, '脚本自身异常：' + out.error)
}
