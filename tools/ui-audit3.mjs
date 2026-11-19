/**
 * UI 修复回归：截图 + 帧时间（含「顶栏毛玻璃 / 抽屉遮罩毛玻璃」的 A/B）。
 * 输出 artifacts/ui-audit3/。
 */
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = process.cwd()
const OUT = join(ROOT, 'artifacts/ui-audit3')
mkdirSync(OUT, { recursive: true })
const UD = mkdtempSync(join(tmpdir(), 'ss-uaudit3-'))
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

const COLORS = ['#0F766E', '#0EA5E9', '#8B5CF6', '#EC4899', '#F59E0B', '#10B981']
for (let i = 0; i < 12; i += 1) {
  await w.evaluate(async (p) => {
    const rec = await window.ss.profiles.create({ name: p.name, platform: p.platform })
    await window.ss.profiles.update(rec.id, { group: p.group, color: p.color, favorite: p.favorite })
  }, {
    name: i === 1 ? '美国主店 · 高客单价 · 黑五促销 · 备用账号 2026 春季' : `演示环境 ${i + 1}`,
    platform: i % 4 === 0 ? 'macos' : 'windows',
    group: i === 1 ? '长期测试分组名称很长很长很长' : ['店铺', '广告', '采集'][i % 3],
    color: COLORS[i % COLORS.length],
    favorite: i < 2
  })
}
for (const n of ['已删除 · 旧店', '已删除 · 测试']) {
  await w.evaluate(async (name) => {
    const p = await window.ss.profiles.create({ name, platform: 'windows' })
    await window.ss.profiles.remove(p.id)
  }, n)
}
await w.waitForTimeout(900)

const shot = async (n) => {
  await w.screenshot({ path: join(OUT, n + '.png') })
  console.log('shot', n)
}
const nav = async (label) => {
  const b = w.locator('aside.side button.nav-item', { hasText: label }).first()
  if (await b.count()) {
    await b.click()
    await w.waitForTimeout(550)
  }
}

async function sampleFrames(fn, ms = 2000) {
  const sampler = w.evaluate(
    (dur) =>
      new Promise((res) => {
        const t = []
        let last = performance.now()
        const t0 = last
        function tick(ts) {
          t.push(ts - last)
          last = ts
          if (ts - t0 < dur) requestAnimationFrame(tick)
          else res(t)
        }
        requestAnimationFrame(tick)
      }),
    ms
  )
  if (fn) await fn()
  const t = await sampler
  const s = [...t].sort((a, b) => a - b)
  return {
    frames: t.length,
    fps: +(1000 / (t.reduce((a, b) => a + b, 0) / t.length)).toFixed(1),
    p95: +s[Math.floor(s.length * 0.95)].toFixed(1),
    max: +s[s.length - 1].toFixed(1)
  }
}

/** 程序化滚动：不移动指针（避免 hover 切换干扰），统一速度 40px/帧 */
function scrollOnce() {
  return w.evaluate(
    () =>
      new Promise((res) => {
        const el = document.querySelector('.views')
        if (!el) return res([16])
        el.scrollTop = 0
        const t = []
        let last = performance.now()
        const t0 = last
        function step(ts) {
          t.push(ts - last)
          last = ts
          el.scrollTop += 40
          if (ts - t0 < 2200 && el.scrollTop + el.clientHeight < el.scrollHeight) {
            requestAnimationFrame(step)
          } else {
            res(t)
          }
        }
        requestAnimationFrame(step)
      })
  )
}

/* 1. 列表 / 回收站 / 任务空态 / 暗色 */
await nav('环境')
await shot('01-grid')
await w.locator('button[aria-label="列表视图"]').first().click()
await w.waitForTimeout(500)
await shot('02-list')
await w.locator('button[aria-label="网格视图"]').first().click()
await w.waitForTimeout(400)

const trash = w.locator('button', { hasText: '回收站' }).last()
await trash.click()
await w.waitForTimeout(700)
await shot('03-trash')
await nav('环境')
await w.waitForTimeout(500)

await nav('任务')
await shot('04-tasks-empty')
await nav('环境')

await w.evaluate(async () => await window.ss.settings.set({ theme: 'dark' }))
await w.waitForTimeout(800)
await nav('环境')
await w.locator('button[aria-label="列表视图"]').first().click()
await w.waitForTimeout(500)
await shot('05-list-dark')
await w.locator('button[aria-label="网格视图"]').first().click()
await w.waitForTimeout(400)
const trash2 = w.locator('button', { hasText: '回收站' }).last()
await trash2.click()
await w.waitForTimeout(650)
await shot('06-trash-dark')
const back = w.locator('button', { hasText: '返回环境' }).first()
if (await back.count()) { await back.click(); await w.waitForTimeout(600) }
await nav('环境')
await w.evaluate(async () => await window.ss.settings.set({ theme: 'light' }))
await w.waitForTimeout(700)

/* 2. 英文：侧栏 / 列表 / 命令面板 */
const en = w.locator('aside.side button', { hasText: 'English' }).first()
if (await en.count()) {
  await en.click()
  await w.waitForTimeout(600)
}
await shot('07-en-grid')
await w.locator('button[aria-label="List view"]').first().click()
await w.waitForTimeout(500)
await shot('08-en-list')
await w.keyboard.press('Control+k')
await w.waitForTimeout(650)
await shot('09-en-palette')
await w.keyboard.press('Escape')
await w.waitForTimeout(400)
await w.locator('button[aria-label="Grid view"]').first().click().catch(() => {})
await w.waitForTimeout(400)
const zh = w.locator('aside.side button', { hasText: '中文' }).first()
if (await zh.count()) {
  await zh.click()
  await w.waitForTimeout(600)
}

/* 3. 抽屉基础页（分组 chip + 扩展） */
const card = w.locator('article.env').first()
await card.hover()
await sleep(250)
const cfg = card.locator('button', { hasText: '配置' }).first()
if (await cfg.count()) {
  await cfg.click({ force: true })
  await w.waitForTimeout(650)
  await shot('10-drawer')
  await w.keyboard.press('Escape')
  await w.waitForTimeout(400)
}

/* 4. 性能：50+ 环境 */
for (let i = 0; i < 50; i += 1) {
  await w.evaluate(async (n) => {
    const p = await window.ss.profiles.create({ name: '压测环境 ' + n, platform: 'windows' })
    await window.ss.profiles.update(p.id, { group: '压测' })
  }, i)
}
await w.waitForTimeout(900)
await nav('环境')
await w.waitForTimeout(600)

perf.scroll50 = await sampleFrames(scrollOnce, 2400)
console.log('perf scroll50', perf.scroll50)

/* A/B：把顶栏毛玻璃加回去，再滚一遍（同一指针位置 / 同一速度） */
await w.addStyleTag({ content: '.topbar{backdrop-filter:saturate(140%) blur(12px)}' })
await w.waitForTimeout(300)
perf.scroll50WithTopbarBlur = await sampleFrames(scrollOnce, 2400)
console.log('perf scroll50 + topbar blur', perf.scroll50WithTopbarBlur)
await w.evaluate(() => {
  const tags = [...document.querySelectorAll('style')]
  const last = tags[tags.length - 1]
  if (last) last.remove()
})
await w.waitForTimeout(300)

const cc = w.locator('article.env').first()
await cc.hover()
await sleep(250)
perf.drawerOpen = await sampleFrames(async () => {
  const b = cc.locator('button', { hasText: '配置' }).first()
  if (await b.count()) await b.click({ force: true })
  await sleep(550)
}, 1400)
await w.keyboard.press('Escape')
await w.waitForTimeout(400)

/* A/B：抽屉遮罩加回 blur */
await w.evaluate(() => {
  const s = document.createElement('style')
  s.id = 'ab-mask'
  s.textContent = '.mask{backdrop-filter:blur(1.5px)}'
  document.head.appendChild(s)
})
const cc2 = w.locator('article.env').first()
await cc2.hover()
await sleep(250)
perf.drawerOpenWithMaskBlur = await sampleFrames(async () => {
  const b = cc2.locator('button', { hasText: '配置' }).first()
  if (await b.count()) await b.click({ force: true })
  await sleep(550)
}, 1400)
await w.keyboard.press('Escape')
await w.waitForTimeout(350)
await w.evaluate(() => document.getElementById('ab-mask')?.remove())

perf.paletteOpen = await sampleFrames(async () => {
  await w.keyboard.press('Control+k')
  await sleep(500)
}, 1400)
await w.keyboard.press('Escape')
await w.waitForTimeout(300)

perf.viewSwitch = await sampleFrames(async () => {
  await nav('代理')
  await sleep(300)
  await nav('环境')
  await sleep(300)
}, 1600)

writeFileSync(join(OUT, 'perf.json'), JSON.stringify(perf, null, 2))
await app.close()
rmSync(UD, { recursive: true, force: true })
console.log('PERF', JSON.stringify(perf))
console.log('DONE')
