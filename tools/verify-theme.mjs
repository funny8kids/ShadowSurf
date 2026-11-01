/**
 * 主题的运行时验收。
 *
 * ── 为什么不能只靠截图 ──
 *
 * 截图能看出「大概变暗了」，看不出「某一处文字和它的背景同色」。
 * 暗色主题最典型的失败不是整体不生效，而是**个别元素**忘了换令牌：
 * 白底深字在暗色下变成「深底深字」，肉眼看截图只觉得那块"有点糊"。
 *
 * 所以这个脚本测三样东西，都是渲染后的实际读数：
 *
 *   A. 令牌真的换了 —— `data-theme` 属性 + `body` 的计算背景色 + `--ink`/`--bg` 计算值
 *   B. 主进程的 themeSource 真的到了渲染层 —— 渲染层读 `prefers-color-scheme`，
 *      它必须和选中的模式一致。这一条防的是「只改了属性、没改 nativeTheme」，
 *      症状是系统对话框 / 原生滚动条还是另一个颜色。
 *   C. 对比度 —— 遍历所有可见的叶子文本节点，合成出实际背景色，算 WCAG 对比度。
 *      低于 3.0 判失败（那是 UI 组件的可读下限，低于它属于客观不可读，不是审美问题）。
 *      渐变背景无法解析，记为「未测量」而不是「通过」。
 *
 * 跑法：npm run verify:theme（需要先 npm run build）
 * 退出码：0 成立 / 1 不成立 / 3 未测量（拿不到读数，不算通过）
 */

import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SHOTS = resolve(ROOT, 'artifacts/theme')
mkdirSync(SHOTS, { recursive: true })

const EXPECT = {
  light: { bg: 'rgb(246, 245, 242)', ink: 'rgb(17, 20, 23)' },
  dark: { bg: 'rgb(10, 12, 15)', ink: 'rgb(232, 236, 240)' }
}

const steps = []
const failures = []
const step = (id, label, data) => steps.push({ id, label, ...data })
const fail = (msg) => failures.push(msg)

/* ── 页面内执行的对比度审计 ── */
const AUDIT = () => {
  const parse = (c) => {
    const m = String(c).match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)/)
    if (!m) return null
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] }
  }
  const lum = (c) => {
    const f = (v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }
  const ratio = (a, b) => {
    const l1 = lum(a)
    const l2 = lum(b)
    const hi = Math.max(l1, l2)
    const lo = Math.min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)
  }

  // 从元素向上合成出实际背景色；遇到渐变返回 null（不可解析）
  const bgOf = (el) => {
    const stack = []
    let cur = el
    while (cur) {
      const cs = getComputedStyle(cur)
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null
      const c = parse(cs.backgroundColor)
      if (c && c.a > 0) {
        stack.push(c)
        if (c.a >= 1) break
      }
      cur = cur.parentElement
    }
    if (stack.length === 0) return null
    let out = stack[stack.length - 1]
    if (out.a < 1) return null
    for (let i = stack.length - 2; i >= 0; i--) {
      const t = stack[i]
      out = {
        r: t.r * t.a + out.r * (1 - t.a),
        g: t.g * t.a + out.g * (1 - t.a),
        b: t.b * t.a + out.b * (1 - t.a),
        a: 1
      }
    }
    return out
  }

  const label = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
    const txt = (el.textContent || '').trim().slice(0, 18)
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} 「${txt}」`
  }

  const rows = []
  let skippedGradient = 0
  // 纯装饰字符（分隔点、面包屑斜杠）。WCAG 1.4.3 对「纯装饰」文本不设对比度要求，
  // 它们不承载信息 —— 去掉之后语义完全不变。仍然测、仍然报，只是不判失败。
  const DECORATIVE = new Set(['·', '/', '|', '—', '-', '›', '•'])
  for (const el of document.querySelectorAll('body *')) {
    if (el.childElementCount > 0) continue
    const text = (el.textContent || '').trim()
    if (text.length === 0) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    if (Number(cs.opacity) < 0.5) continue
    if (parseFloat(cs.fontSize) < 9) continue
    const rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) continue

    const fg = parse(cs.color)
    if (!fg || fg.a === 0) continue
    const bg = bgOf(el)
    if (bg === null) {
      skippedGradient++
      continue
    }
    const fgOver = {
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a)
    }
    rows.push({
      what: label(el),
      ratio: Math.round(ratio(fgOver, bg) * 100) / 100,
      color: cs.color,
      bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
      size: cs.fontSize,
      weight: cs.fontWeight,
      decorative: DECORATIVE.has(text)
    })
  }
  rows.sort((a, b) => a.ratio - b.ratio)
  // 失败集从全量取，不从 worst 里取 —— worst 只有 8 条，第 9 条开始的不达标会被漏掉
  const offenders = rows.filter((r) => !r.decorative && r.ratio < 3)
  return {
    measured: rows.length,
    skippedGradient,
    worst: rows.slice(0, 8),
    offenders
  }
}

/* ── 启动 ── */
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: resolve(ROOT, 'node_modules/electron/dist/electron.exe'),
  args: ['.'],
  cwd: ROOT,
  env,
  timeout: 30000
})

const win = await app.firstWindow({ timeout: 20000 })
await win.waitForTimeout(2500)

/** 读渲染层此刻的令牌计算值 + 媒体查询 */
const readState = () =>
  win.evaluate(() => {
    const cs = getComputedStyle(document.documentElement)
    const body = getComputedStyle(document.body)
    return {
      attr: document.documentElement.dataset.theme ?? null,
      bgToken: cs.getPropertyValue('--bg').trim(),
      inkToken: cs.getPropertyValue('--ink').trim(),
      bodyBg: body.backgroundColor,
      bodyInk: body.color,
      prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
      colorScheme: cs.getPropertyValue('color-scheme').trim()
    }
  })

/** 通过界面按钮切主题（走真实交互，不直接改属性），并等到颜色真的落定 */
async function pick(mode) {
  const label = mode === 'system' ? '跟随系统' : mode === 'light' ? '亮色' : '暗色'
  await win.locator(`button[aria-label="${label}"]`).first().click()
  // 不能只 sleep：颜色过渡会让审计抓到中间态，把「正在变」读成「变错了」。
  // 等到 body 背景等于目标值为止，超时就交给后面的 A 段断言报错。
  const want = mode === 'system' ? null : EXPECT[mode].bg
  await win
    .waitForFunction(
      (target) => {
        const bg = getComputedStyle(document.body).backgroundColor
        if (target === null) return true
        return bg === target
      },
      want,
      { timeout: 4000 }
    )
    .catch(() => undefined)
  await win.waitForTimeout(260)
}

const readStored = () =>
  win.evaluate(async () => {
    const s = await window.ss.settings.get()
    return s.theme
  })

/** 主进程侧的 nativeTheme 状态：用来区分「没设置」和「设了但没透到渲染层」 */
const readNative = () =>
  app.evaluate(({ nativeTheme }) => ({
    source: nativeTheme.themeSource,
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors
  }))

/**
 * 对照窗口：一个没有任何 CSS 的空页面，读它的 prefers-color-scheme。
 *
 * 用来区分两种完全不同的情况：
 *   - 空页面读 true 而应用页面读 false  → 应用这边有东西挡住了，是缺陷
 *   - 空页面也读 false                  → 这个 Electron 版本根本不把 themeSource 透到页面
 *
 * 后者对本应用是**好事**：ShadowSurf 是浏览器，如果应用主题能改写网页看到的
 * prefers-color-scheme，那就等于把「用户偏好深色」泄露给每个网站，而且会和
 * 伪装指纹里的其它字段对不上。所以这里只要求「应用窗口与空窗口一致」。
 */
const probePagePrefersDark = () =>
  app.evaluate(async ({ BrowserWindow }) => {
    const w = new BrowserWindow({ show: false, width: 120, height: 120 })
    try {
      await w.loadURL('data:text/html,<html><body>probe</body></html>')
      return await w.webContents.executeJavaScript(
        "window.matchMedia('(prefers-color-scheme: dark)').matches"
      )
    } finally {
      w.destroy()
    }
  })

/* ── A + B：两种显式模式 ── */
for (const mode of ['light', 'dark']) {
  await pick(mode)
  const st = await readState()
  const stored = await readStored()
  const native = await readNative()
  const probeDark = await probePagePrefersDark()

  const want = EXPECT[mode]
  const okAttr = st.attr === mode
  const okBg = st.bodyBg === want.bg
  const okInk = st.bodyInk === want.ink
  const okToken = st.bgToken.toLowerCase() === (mode === 'light' ? '#f6f5f2' : '#0a0c0f')
  const okStored = stored === mode
  const okNativeSource = native.source === mode
  const okNativeDark = native.shouldUseDarkColors === (mode === 'dark')

  step(`A:${mode}`, `切到 ${mode}`, {
    attr: st.attr,
    bodyBg: st.bodyBg,
    bodyInk: st.bodyInk,
    bgToken: st.bgToken,
    colorScheme: st.colorScheme,
    stored
  })
  step(`B:${mode}`, `nativeTheme（主进程）→ 渲染层媒体查询`, {
    'nativeTheme.themeSource': native.source,
    'nativeTheme.shouldUseDarkColors': native.shouldUseDarkColors,
    '应用窗口 prefers-color-scheme: dark': st.prefersDark,
    '空页面 prefers-color-scheme: dark': probeDark
  })

  if (!okAttr) fail(`${mode}: html[data-theme] 是 ${st.attr}，不是 ${mode}`)
  if (!okBg) fail(`${mode}: body 背景是 ${st.bodyBg}，期望 ${want.bg}（令牌没生效）`)
  if (!okInk) fail(`${mode}: body 前景是 ${st.bodyInk}，期望 ${want.ink}（令牌没生效）`)
  if (!okToken) fail(`${mode}: --bg 计算值是 ${st.bgToken}`)
  if (!okStored) fail(`${mode}: 落盘的 theme 是 ${stored}，不是 ${mode}`)
  if (!okNativeSource) fail(`${mode}: 主进程 themeSource 是 ${native.source}`)
  if (!okNativeDark) fail(`${mode}: 主进程 shouldUseDarkColors=${native.shouldUseDarkColors}`)

  // 切换器本身必须反映状态：恰好一个 aria-pressed=true，且是当前模式那个
  const pressed = await win.evaluate(() =>
    [...document.querySelectorAll('.theme-opt')].map((b) => ({
      label: b.getAttribute('aria-label'),
      pressed: b.getAttribute('aria-pressed')
    }))
  )
  const active = pressed.filter((p) => p.pressed === 'true')
  const wantLabel = mode === 'system' ? '跟随系统' : mode === 'light' ? '亮色' : '暗色'
  if (active.length !== 1 || active[0].label !== wantLabel) {
    fail(`${mode}: 切换器高亮是 ${JSON.stringify(active)}，期望恰好一个「${wantLabel}」`)
  }
  step(`A2:${mode}`, '切换器状态', { pressed })

  // 媒体查询这一条：只要求「应用窗口和空页面读到的值一致」。
  // 如果 themeSource 会透到页面，那应用窗口也必须跟着透（不一致 = 应用里有东西挡住了）；
  // 如果不会透，两边都读系统真实偏好，也一致。两种平台行为都算通过，不一致才算失败。
  if (st.prefersDark !== probeDark) {
    fail(
      `${mode}: 应用窗口读到 prefers-color-scheme dark=${st.prefersDark}，` +
        `空页面读到 ${probeDark} —— 两边不一致，说明应用里有东西改写了媒体查询`
    )
  }
  // themeSource 会透到页面时，它必须和模式对得上（否则等于「设了但没生效」）
  if (probeDark === true && st.prefersDark !== (mode === 'dark')) {
    fail(`${mode}: themeSource 会透到页面，但页面读到的不是 ${mode === 'dark'}`)
  }

  await win.screenshot({ path: resolve(SHOTS, `app-${mode}.png`) })
}

/* ── C：对比度审计（两种模式各一次） ── */
for (const mode of ['light', 'dark']) {
  await pick(mode)
  const audit = await win.evaluate(AUDIT)
  step(`C:${mode}`, `${mode} 对比度审计`, {
    measured: audit.measured,
    skippedGradient: audit.skippedGradient,
    offenders: audit.offenders.length,
    worst: audit.worst
  })

  // 空页面会让审计真空通过，所以设一个下限
  if (audit.measured < 20) fail(`${mode}: 只测到 ${audit.measured} 组文本/背景，读数不足（不算通过）`)
  if (audit.offenders.length > 0) {
    fail(
      `${mode}: ${audit.offenders.length} 处非装饰文本对比度低于 3.0 → ` +
        audit.offenders.map((b) => `${b.what} ${b.ratio} (${b.color} on ${b.bg})`).join(' / ')
    )
  }
}

/* ── E：双轨浏览器窗口（另一半界面，控制台截图看不到） ──
 *
 * 这一段同时验跨窗口推送：主题是在**控制台窗口**里点的，
 * 双轨窗口必须跟着变。只验单窗口的话，「主进程广播」这条路径完全没被测到，
 * 而它恰恰是唯一能让多个窗口保持一致的东西。
 */
let browserWin = null
const cardCount = await win.locator('article').count()
if (cardCount === 0) {
  step('E:skip', '双轨窗口', { skipped: '本地没有环境，无法开窗（不计为通过，也不计为失败）' })
  console.log('  ! 没有环境可打开，跳过双轨窗口审计')
} else {
  await win.locator('article').first().locator('button:has-text("打开")').first().click()
  for (let i = 0; i < 40 && browserWin === null; i++) {
    await win.waitForTimeout(300)
    browserWin = app.windows().find((w) => w.url().includes('role=browser')) ?? null
  }

  if (browserWin === null) {
    fail('E: 点了「打开」但没等到 role=browser 的窗口')
  } else {
    for (const mode of ['light', 'dark']) {
      await pick(mode) // 在控制台窗口切换
      await browserWin.waitForTimeout(700)

      const st = await browserWin.evaluate(() => ({
        attr: document.documentElement.dataset.theme ?? null,
        bodyBg: getComputedStyle(document.body).backgroundColor
      }))
      const audit = await browserWin.evaluate(AUDIT)
      await browserWin.screenshot({ path: resolve(SHOTS, `browser-${mode}.png`) })

      step(`E:${mode}`, `双轨窗口（控制台切到 ${mode}）`, {
        attr: st.attr,
        bodyBg: st.bodyBg,
        measured: audit.measured,
        skippedGradient: audit.skippedGradient,
        offenders: audit.offenders.length,
        worst: audit.worst
      })

      if (st.attr !== mode) fail(`E:${mode}: 双轨窗口 data-theme=${st.attr}（跨窗口推送没生效）`)
      if (st.bodyBg !== EXPECT[mode].bg) fail(`E:${mode}: 双轨窗口 body 背景是 ${st.bodyBg}`)
      if (audit.measured < 20) fail(`E:${mode}: 只测到 ${audit.measured} 组，读数不足`)
      if (audit.offenders.length > 0) {
        fail(
          `E:${mode}: ${audit.offenders.length} 处对比度低于 3.0 → ` +
            audit.offenders.map((b) => `${b.what} ${b.ratio} (${b.color} on ${b.bg})`).join(' / ')
        )
      }
    }
  }
}

/* ── 跟随系统：切到 system 后应落到当前系统偏好 ── */
await pick('system')
const sys = await readState()
const sysStored = await readStored()
step('D:system', '切回跟随系统', { attr: sys.attr, stored: sysStored, prefersDark: sys.prefersDark })
if (sysStored !== 'system') fail(`跟随系统: 落盘是 ${sysStored}，不是 system`)
if (sys.attr !== (sys.prefersDark ? 'dark' : 'light')) {
  fail(`跟随系统: data-theme=${sys.attr}，但系统偏好是 ${sys.prefersDark ? 'dark' : 'light'}`)
}
await win.screenshot({ path: resolve(SHOTS, 'app-system.png') })

/* ── 收尾 ── */
await app.close()

console.log('\n=== 读数 ===')
for (const s of steps) {
  console.log(`\n[${s.id}] ${s.label}`)
  for (const [k, v] of Object.entries(s)) {
    if (k === 'id' || k === 'label') continue
    console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v, null, 2).replace(/\n/g, '\n  ') : v}`)
  }
}

if (steps.length === 0) {
  console.error('\n没有拿到任何读数 —— 未测量，不算通过')
  process.exit(3)
}

if (failures.length > 0) {
  console.error('\n=== 失败 ===')
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}

console.log(`\n✓ 主题验收通过：${steps.length} 组读数，截图在 artifacts/theme/`)
