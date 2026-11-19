/**
 * 复现/验证双轨布局：DOM 占位与真实网页视图是否对齐。
 * 1) 首屏：影子轨应显示占位设计（徽标 + 骨架），而不是一块空白；
 * 2) 拖动分屏手柄后：DOM 的影子区与主进程的真实视图边界必须一致。
 */
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = process.cwd()
const OUT = join(ROOT, 'artifacts/browser-layout')
mkdirSync(OUT, { recursive: true })
const UD = mkdtempSync(join(tmpdir(), 'ss-blay-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

const prof = await w.evaluate(async () => {
  const p = await window.ss.profiles.create({ name: '主店 · 美国', platform: 'windows' })
  return await window.ss.profiles.update(p.id, { startUrl: 'https://example.com' })
})
await w.evaluate(async (id) => await window.ss.profiles.launch(id), prof.id)
await sleep(9000)

const browsers = app.windows().filter((p) => p.url().includes('role=browser'))
if (browsers.length === 0) {
  console.log('NO_BROWSER_WINDOW')
  await app.close()
  process.exit(2)
}
const bw = browsers[browsers.length - 1]

await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('role=browser'))
  if (win) win.setBounds({ x: 0, y: 0, width: 1280, height: 720 })
})
await sleep(3000)

// 只留浏览器窗口：控制台窗口不透明且叠在上面会把整屏截图搞脏
await app.evaluate(({ BrowserWindow }) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.getURL().includes('role=browser')) win.hide()
  }
})
await sleep(600)

const domRects = () =>
  bw.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) }
    }
    return {
      stage: pick('.stage'),
      shadowPane: pick('.shadow-pane'),
      badge: pick('.sp-badge'),
      skeleton: pick('.sp-page'),
      handle: pick('.split-handle')
    }
  })

const mainViews = () =>
  app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('role=browser'))
    if (!win) return []
    return win.contentView.children.map((c) => {
      const b = c.getBounds()
      return {
        url: c.webContents.getURL(),
        visible: c.getVisible(),
        x: Math.round(b.x),
        w: Math.round(b.width)
      }
    })
  })

const shot = async (name) => {
  const png = await app.evaluate(async ({ desktopCapturer }) => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    })
    const screen = sources.find((s) => s.id.startsWith('screen')) ?? sources[0]
    return screen?.thumbnail.toPNG().toString('base64') ?? ''
  })
  if (png) writeFileSync(join(OUT, name), Buffer.from(png, 'base64'))
}

const before = { dom: await domRects(), main: await mainViews() }
await shot('browser-1280x720.png')

/* 拖动分屏手柄：把影子轨从 43% 拖到 30% */
const handle = before.dom.handle
if (handle) {
  const startX = handle.x + 3
  const body = await bw.evaluate(() => {
    const r = document.querySelector('.bw-body').getBoundingClientRect()
    return { left: r.left, width: r.width }
  })
  await bw.mouse.move(startX, 300)
  await bw.mouse.down()
  await bw.mouse.move(body.left + body.width * 0.7, 300, { steps: 12 })
  await bw.mouse.up()
  await sleep(1200)
}
const after = { dom: await domRects(), main: await mainViews() }
await shot('browser-1280x720-dragged.png')

writeFileSync(join(OUT, 'layout.json'), JSON.stringify({ before, after }, null, 2))
console.log('BEFORE', JSON.stringify(before, null, 2))
console.log('AFTER', JSON.stringify(after, null, 2))

const domShadow = after.dom.shadowPane
const viewShadow = after.main.find((v) => v.url === 'about:blank') ?? after.main[1]
const domHuman = after.dom.stage
const viewHuman = after.main[0]
const humanView = after.main.find((v) => v.url !== 'about:blank') ?? after.main[0]
const expectHumanW = after.dom.stage && after.dom.shadowPane ? after.dom.stage.w - after.dom.shadowPane.w - 1 : null
console.log('human view w=', humanView && humanView.w, 'expected=', expectHumanW, 'delta=', expectHumanW !== null && humanView ? Math.abs(humanView.w - expectHumanW) : 'n/a')
console.log('shadow view visible=', after.main.find((v) => v.url === 'about:blank')?.visible, 'badge in DOM=', Boolean(after.dom.badge), 'skeleton=', Boolean(after.dom.skeleton))
await app.close()
rmSync(UD, { recursive: true, force: true })
console.log('DONE')
