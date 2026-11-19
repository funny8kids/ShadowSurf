/**
 * UI 审计第二轮：1280 宽度、英文、长文本、焦点、toast，以及抽屉/面板/命令面板帧时间。
 * 依赖已有构建；输出 artifacts/ui-audit2/。
 */
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = process.cwd()
const OUT = join(ROOT, 'artifacts/ui-audit2')
mkdirSync(OUT, { recursive: true })
const UD = mkdtempSync(join(tmpdir(), 'ss-uaudit2-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const perf = {}

const app = await electron.launch({
  executablePath: resolve(ROOT, 'node_modules/electron/dist/electron'),
  args: ['.', '--user-data-dir=' + UD, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  cwd: ROOT,
  env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
  timeout: 60000
})
const w = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1600, height: 1000 }))
await w.waitForTimeout(1600)

/* 数据：一个正常环境 + 一个超长名称/分组 */
const normal = await w.evaluate(async () => {
  const p = await window.ss.profiles.create({ name: '主店 · 美国', platform: 'windows' })
  return await window.ss.profiles.update(p.id, { group: '店铺', color: '#0F766E', favorite: true })
})
const long = await w.evaluate(async () => {
  const p = await window.ss.profiles.create({ name: '美国主店 · 高客单价 · 黑五促销 · 备用账号 2026 春季', platform: 'macos' })
  return await window.ss.profiles.update(p.id, {
    group: '长期测试分组名称很长很长很长',
    color: '#8B5CF6',
    note: '这段备注很长，用来测试卡片与列表在极端长度下的截断行为，不应把布局撑开。'
  })
})
await w.waitForTimeout(700)

const shot = async (n) => {
  await w.screenshot({ path: join(OUT, n + '.png') })
  console.log('shot', n)
}
const nav = async (label) => {
  const b = w.locator('aside.side button.nav-item', { hasText: label }).first()
  if (await b.count()) {
    await b.click()
    await w.waitForTimeout(550)
    return true
  }
  return false
}
async function sample(action, ms = 1600) {
  const sampler = w.evaluate(
    (dur) =>
      new Promise((res) => {
        const times = []
        let last = performance.now()
        const t0 = last
        function tick(t) {
          times.push(t - last)
          last = t
          if (t - t0 < dur) requestAnimationFrame(tick)
          else res(times)
        }
        requestAnimationFrame(tick)
      }),
    ms
  )
  await action()
  const times = await sampler
  const sorted = [...times].sort((a, b) => a - b)
  return {
    frames: times.length,
    fps: +(1000 / (times.reduce((a, b) => a + b, 0) / times.length)).toFixed(1),
    p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1),
    max: +sorted[sorted.length - 1].toFixed(1)
  }
}

/* 1. 1600 长文本 */
await nav('环境')
await shot('01-longtext-grid')
await w.locator('button[aria-label="列表视图"]').first().click()
await w.waitForTimeout(500)
await shot('02-longtext-list')
await w.locator('button[aria-label="网格视图"]').first().click()
await w.waitForTimeout(400)

/* 2. 焦点环：Tab 到第一张卡，再聚焦侧栏导航 */
await w.keyboard.press('Tab')
await w.keyboard.press('Tab')
await w.waitForTimeout(300)
await shot('03-focus-tab')
perf.focus = await w.evaluate(() => {
  const el = document.activeElement
  return el ? { tag: el.tagName, cls: el.className, outline: getComputedStyle(el).outline } : null
})

/* 3. toast：抽屉代理页触发地理校准（无代理，必然失败） */
const card = w.locator('article.env').first()
await card.hover()
await sleep(250)
const cfg = card.locator('button', { hasText: '配置' }).first()
if (await cfg.count()) {
  await cfg.click({ force: true })
  await w.waitForTimeout(600)
  const proxyTab = w.locator('.drawer button.dtab', { hasText: '代理' }).first()
  if (await proxyTab.count()) await proxyTab.click()
  await w.waitForTimeout(350)
  const geo = w.locator('.drawer button', { hasText: '按代理出口校准' }).first()
  if (await geo.count()) {
    await geo.click({ force: true })
    await w.waitForTimeout(900)
    await shot('04-toast')
  }
  await w.keyboard.press('Escape')
  await w.waitForTimeout(450)
}

/* 4. 1280×800 */
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1280, height: 800 }))
await w.waitForTimeout(600)
await shot('05-1280-grid')
await w.locator('button[aria-label="列表视图"]').first().click()
await w.waitForTimeout(500)
await shot('06-1280-list')
await w.locator('button[aria-label="网格视图"]').first().click()
await w.waitForTimeout(400)
const c2 = w.locator('article.env').first()
await c2.hover()
await sleep(250)
const cfg2 = c2.locator('button', { hasText: '配置' }).first()
if (await cfg2.count()) {
  await cfg2.click({ force: true })
  await w.waitForTimeout(650)
  await shot('07-1280-drawer')
  await w.keyboard.press('Escape')
  await w.waitForTimeout(450)
}
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1600, height: 1000 }))
await w.waitForTimeout(500)

/* 5. 英文界面 */
const en = w.locator('aside.side button', { hasText: 'English' }).first()
if (await en.count()) {
  await en.click()
  await w.waitForTimeout(600)
}
await shot('08-en-grid')
await w.locator('button[aria-label="List view"]').first().click().catch(() => {})
await w.waitForTimeout(500)
await shot('09-en-list')
await w.locator('button[aria-label="Grid view"]').first().click().catch(() => {})
await w.waitForTimeout(400)
const c3 = w.locator('article.env').first()
await c3.hover()
await sleep(250)
const cfg3 = c3.locator('button', { hasText: 'Configure' }).first()
if (await cfg3.count()) {
  await cfg3.click({ force: true })
  await w.waitForTimeout(650)
  await shot('10-en-drawer')
  await w.keyboard.press('Escape')
  await w.waitForTimeout(400)
}
await w.keyboard.press('Control+k')
await w.waitForTimeout(600)
await shot('11-en-palette')
await w.keyboard.press('Escape')
await w.waitForTimeout(400)
const zh = w.locator('aside.side button', { hasText: '中文' }).first()
if (await zh.count()) {
  await zh.click()
  await w.waitForTimeout(600)
}

/* 6. 帧时间：抽屉 / 命令面板 / 视图切换 */
const cc = w.locator('article.env').first()
await cc.hover()
await sleep(250)
perf.drawerOpen = await sample(async () => {
  const b = cc.locator('button', { hasText: '配置' }).first()
  if (await b.count()) await b.click({ force: true })
  await sleep(500)
}, 1200)
await w.keyboard.press('Escape')
await w.waitForTimeout(400)
perf.paletteOpen = await sample(async () => {
  await w.keyboard.press('Control+k')
  await sleep(450)
}, 1200)
await w.keyboard.press('Escape')
await w.waitForTimeout(300)
perf.viewSwitch = await sample(async () => {
  await nav('代理')
  await sleep(350)
  await nav('环境')
  await sleep(350)
}, 1600)

/* 7. 长列表滚动帧时间 */
for (let i = 0; i < 50; i++) {
  await w.evaluate(async (n) => {
    const p = await window.ss.profiles.create({ name: '压测环境 ' + n, platform: 'windows' })
    await window.ss.profiles.update(p.id, { group: '压测' })
  }, i)
}
await w.waitForTimeout(900)
perf.scrollGrid = await sample(async () => {
  await w.mouse.move(850, 620)
  for (let i = 0; i < 36; i++) {
    await w.mouse.wheel(0, 280)
    await sleep(50)
  }
}, 2200)

writeFileSync(join(OUT, 'perf.json'), JSON.stringify(perf, null, 2))
await app.close()
rmSync(UD, { recursive: true, force: true })
console.log('perf', JSON.stringify(perf))
console.log('DONE')
