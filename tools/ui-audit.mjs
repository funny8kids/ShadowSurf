/**
 * UI 审计采集：截图 + 可量化指标（启动、滚动帧时间、抽屉/命令面板打开帧时间、CLS）。
 *
 * 输出：
 *   artifacts/ui-audit/*.png —— 各页面亮/暗/紧凑
 *   artifacts/ui-audit/perf.json —— 指标原始值
 *
 * 跑法（远程 Xvfb）：DISPLAY=:99 node tools/ui-audit.mjs
 */
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = process.cwd()
const OUT = join(ROOT, 'artifacts/ui-audit')
mkdirSync(OUT, { recursive: true })
const UD = mkdtempSync(join(tmpdir(), 'ss-uaudit-'))
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
await app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1600, height: 1000 })
})
await w.waitForTimeout(1600)

/* ── 造数据：14 个环境（分组 / 颜色 / 收藏 / 备注），另有 2 个进回收站 ── */
const COLORS = ['#0F766E', '#0EA5E9', '#8B5CF6', '#EC4899', '#F59E0B', '#10B981']
const groups = ['店铺', '广告', '采集', '测试']
const NAMES = [
  '主店 · 美国', '广告投放 · 英国', '数据采集 · 日本', '备用 · 德国',
  '主店 · 加拿大', '选品 · 新加坡', '广告 B · 澳洲', '客服 · 法国',
  '采集 B · 韩国', '测试 · 荷兰', '主店 · 墨西哥', '备用 B · 西班牙',
  '投放 C · 意大利', '采集 C · 巴西'
]
for (let i = 0; i < NAMES.length; i++) {
  await w.evaluate(async (p) => {
    const rec = await window.ss.profiles.create({ name: p.name, platform: 'windows' })
    return await window.ss.profiles.update(rec.id, {
      group: p.group,
      color: p.color,
      favorite: p.favorite,
      note: p.note
    })
  }, {
    name: NAMES[i],
    group: groups[i % groups.length],
    color: COLORS[i % COLORS.length],
    favorite: i < 2,
    note: i % 3 === 0 ? '主账号，卡尾号 4021' : ''
  })
}
for (const name of ['已删除 · 旧店', '已删除 · 测试']) {
  await w.evaluate(async (n) => {
    const rec = await window.ss.profiles.create({ name: n, platform: 'windows' })
    await window.ss.profiles.remove(rec.id)
  }, name)
}
await w.waitForTimeout(900)

const shots = async (name) => {
  await w.screenshot({ path: join(OUT, name + '.png') })
  console.log('shot', name)
}
const nav = async (label) => {
  const b = w.locator('aside.side button.nav-item', { hasText: label }).first()
  if (await b.count()) {
    await b.click()
    await w.waitForTimeout(650)
    return true
  }
  console.log('nav miss', label)
  return false
}

/* ── 帧采样：action 期间连续收集 rAF 间隔 ── */
async function sample(action, ms = 2200) {
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
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  return {
    frames: times.length,
    fps: +(1000 / avg).toFixed(1),
    p50: +sorted[Math.floor(sorted.length * 0.5)].toFixed(1),
    p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1),
    max: +sorted[sorted.length - 1].toFixed(1)
  }
}

/* ── 1. 控制台：亮色 网格 / 列表 / 抽屉四页 ── */
await nav('环境')
await shots('01-workbench-grid-light')

const listBtn = w.locator('button[aria-label="列表视图"]').first()
if (await listBtn.count()) {
  await listBtn.click()
  await w.waitForTimeout(600)
  await shots('02-workbench-list-light')
  const gridBtn = w.locator('button[aria-label="网格视图"]').first()
  if (await gridBtn.count()) await gridBtn.click()
  await w.waitForTimeout(500)
}

/* 抽屉四页 */
const card = w.locator('article.env').first()
await card.hover()
await sleep(300)
const cfg = card.locator('button', { hasText: '配置' }).first()
if (await cfg.count()) {
  await cfg.click({ force: true })
  await w.waitForTimeout(700)
  for (const [tab, name] of [
    ['基础', '03-drawer-basic'],
    ['指纹', '04-drawer-fingerprint'],
    ['代理', '05-drawer-proxy'],
    ['影子', '06-drawer-shadow']
  ]) {
    const t = w.locator('.drawer button.dtab', { hasText: tab }).first()
    if (await t.count()) await t.click()
    await w.waitForTimeout(450)
    await shots(name)
  }
  await w.keyboard.press('Escape')
  await w.waitForTimeout(500)
}

/* ── 2. 各工具面板 ── */
for (const [label, name] of [
  ['代理', '07-proxies'],
  ['自动化', '08-scripts'],
  ['模板', '09-templates'],
  ['数据', '10-data'],
  ['本地 API', '11-api'],
  ['审计', '12-audit'],
  ['扩展', '13-extensions'],
  ['团队', '14-team'],
  ['成员', '15-members'],
  ['任务', '16-tasks']
]) {
  await nav(label)
  await shots(name)
}

/* ── 3. 命令面板 / 批量新建 / 回收站 ── */
await nav('环境')
await w.keyboard.press('Control+k')
await w.waitForTimeout(700)
await shots('17-palette')
await w.keyboard.press('Escape')
await w.waitForTimeout(400)

const bulk = w.locator('button', { hasText: '批量新建' }).first()
if (await bulk.count()) {
  await bulk.click()
  await w.waitForTimeout(600)
  await shots('18-bulk-modal')
  await w.keyboard.press('Escape')
  await w.waitForTimeout(400)
}

const trashBtn = w.locator('button', { hasText: '回收站' }).first()
if (await trashBtn.count()) {
  await trashBtn.click()
  await w.waitForTimeout(700)
  await shots('19-trash')
  await trashBtn.click()
  await w.waitForTimeout(500)
}

/* ── 4. 暗色 + 紧凑 ── */
await w.evaluate(async () => await window.ss.settings.set({ theme: 'dark' }))
await w.waitForTimeout(800)
await shots('20-workbench-dark')
await w.keyboard.press('Control+k')
await w.waitForTimeout(650)
await shots('21-palette-dark')
await w.keyboard.press('Escape')
await w.waitForTimeout(400)

const compact = w.locator('button', { hasText: '紧凑' }).first()
if (await compact.count()) {
  await compact.click()
  await w.waitForTimeout(600)
  await shots('22-workbench-dark-compact')
  const comfy = w.locator('button', { hasText: '舒适' }).first()
  if (await comfy.count()) await comfy.click()
  await w.waitForTimeout(400)
}
await w.evaluate(async () => await window.ss.settings.set({ theme: 'light' }))
await w.waitForTimeout(700)

/* ── 5. 性能：滚动 / 抽屉 / 命令面板 ── */
perf.scrollGrid = await sample(async () => {
  await w.mouse.move(820, 620)
  for (let i = 0; i < 34; i++) {
    await w.mouse.wheel(0, 260)
    await sleep(55)
  }
})
console.log('perf scrollGrid', perf.scrollGrid)

const card2 = w.locator('article.env').first()
await card2.hover()
await sleep(250)
perf.drawerOpen = await sample(async () => {
  const c = card2.locator('button', { hasText: '配置' }).first()
  if (await c.count()) await c.click({ force: true })
  await sleep(700)
}, 1400)
console.log('perf drawerOpen', perf.drawerOpen)
await w.keyboard.press('Escape')
await w.waitForTimeout(500)

perf.paletteOpen = await sample(async () => {
  await w.keyboard.press('Control+k')
  await sleep(600)
}, 1400)
console.log('perf paletteOpen', perf.paletteOpen)
await w.keyboard.press('Escape')
await w.waitForTimeout(300)

/* ── 6. 启动：注入 CLS 观察器后 reload，量首卡可见耗时 ── */
await w.addInitScript(() => {
  window.__cls = 0
  window.__lt = 0
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (!e.hadRecentInput) window.__cls += e.value
    }
  }).observe({ type: 'layout-shift', buffered: true })
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__lt = Math.max(window.__lt, e.duration)
  }).observe({ type: 'longtask', buffered: true })
})
const t0 = Date.now()
await w.reload()
await w.waitForSelector('article.env', { timeout: 20000 })
perf.startupToFirstCardMs = Date.now() - t0
await w.waitForTimeout(1200)
perf.cls = await w.evaluate(() => +(window.__cls ?? 0).toFixed(4))
perf.longTaskMaxMs = await w.evaluate(() => +(window.__lt ?? 0).toFixed(1))
perf.paint = await w.evaluate(() =>
  Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]))
)
console.log('perf startup', perf.startupToFirstCardMs, 'cls', perf.cls, 'lt', perf.longTaskMaxMs)

/* ── 7. 尺寸信息 ── */
perf.bundle = await w.evaluate(() => {
  const s = [...document.styleSheets].reduce((n, sh) => {
    try {
      return n + [...sh.cssRules].length
    } catch {
      return n
    }
  }, 0)
  return {
    cssRules: s,
    domNodes: document.querySelectorAll('*').length,
    scrollHeight: document.documentElement.scrollHeight
  }
})

writeFileSync(join(OUT, 'perf.json'), JSON.stringify(perf, null, 2))
await app.close()
rmSync(UD, { recursive: true, force: true })
console.log('DONE')
