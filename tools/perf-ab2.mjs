/** 微性能 A/B：抽屉 will-change、命令面板模糊半径。输出 artifacts/perf-ab.json */
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = process.cwd()
const OUT = join(ROOT, 'artifacts')
mkdirSync(OUT, { recursive: true })
const UD = mkdtempSync(join(tmpdir(), 'ss-pab-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = {}

const app = await electron.launch({
  executablePath: resolve(ROOT, 'node_modules/electron/dist/electron'),
  args: ['.', '--user-data-dir=' + UD, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  cwd: ROOT,
  env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
  timeout: 60000
})
const w = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1600, height: 1000 }))
await w.waitForTimeout(1500)
for (let i = 0; i < 60; i++) {
  await w.evaluate(async (n) => {
    const p = await window.ss.profiles.create({ name: '压测环境 ' + n, platform: 'windows' })
    await window.ss.profiles.update(p.id, { group: '压测' })
  }, i)
}
await w.waitForTimeout(900)

async function sample(fn, ms = 1200) {
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
  await fn()
  const t = await sampler
  const s = [...t].sort((a, b) => a - b)
  return {
    frames: t.length,
    fps: +(1000 / (t.reduce((a, b) => a + b, 0) / t.length)).toFixed(1),
    p95: +s[Math.floor(s.length * 0.95)].toFixed(1),
    max: +s[s.length - 1].toFixed(1)
  }
}

const openDrawer = async () => {
  const card = w.locator('article.env').first()
  await card.hover()
  await sleep(200)
  const b = card.locator('button', { hasText: '配置' }).first()
  if (await b.count()) await b.click({ force: true })
  await sleep(550)
}
const closeDrawer = async () => {
  await w.keyboard.press('Escape')
  await w.waitForTimeout(350)
}
const style = async (id, css) => {
  await w.evaluate(
    ({ id, css }) => {
      document.getElementById(id)?.remove()
      if (css) {
        const s = document.createElement('style')
        s.id = id
        s.textContent = css
        document.head.appendChild(s)
      }
    },
    { id, css }
  )
}

out.drawerBase = await sample(openDrawer)
await closeDrawer()
await style('ab', '.drawer{will-change:transform}')
out.drawerWillChange = await sample(openDrawer)
await closeDrawer()
await w.evaluate(() => document.getElementById('ab')?.remove())

const openPalette = async () => {
  await w.keyboard.press('Control+k')
  await sleep(450)
}
const closePalette = async () => {
  await w.keyboard.press('Escape')
  await w.waitForTimeout(300)
}
out.paletteBase = await sample(openPalette)
await closePalette()
await style('ab', '.cp-mask{backdrop-filter:blur(6px) saturate(120%)}')
out.paletteBlur6 = await sample(openPalette)
await closePalette()
await style('ab', '.cp-dialog{will-change:transform,opacity}')
out.paletteWillChange = await sample(openPalette)
await closePalette()
await w.evaluate(() => document.getElementById('ab')?.remove())

writeFileSync(join(OUT, 'perf-ab.json'), JSON.stringify(out, null, 2))
await app.close()
rmSync(UD, { recursive: true, force: true })
console.log(JSON.stringify(out, null, 2))
