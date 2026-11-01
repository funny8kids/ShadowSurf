/**
 * 一次性诊断：字体探测走 Canvas2D 与走 OffscreenCanvas 是否给出同一个答案。
 *
 * 假设：注入只挂了 `CanvasRenderingContext2D.prototype.measureText`，
 * 没挂 `OffscreenCanvasRenderingContext2D.prototype.measureText`。
 * 若成立，macOS 环境里用 OffscreenCanvas 量 Windows 专属字体（Microsoft YaHei UI）
 * 会「量得出来」，而 Canvas2D 量不出来 —— 两条路给出两个答案，
 * 后者才是 creepjs 的 `platform hints: Arial,"Microsoft YaHei UI"` 的来源。
 *
 * 修好之后已经升成门禁（两条判据，见文件末尾），并进了 verify:all。
 *
 * 跑法：npm run verify:fonts（先 electron-vite build）
 */
import { _electron as electron } from 'playwright-core'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: resolve(ROOT, 'node_modules/electron/dist/electron.exe'),
  args: ['.', '--user-data-dir=' + resolve(ROOT, 'artifacts', 'font-channels-ud')],
  cwd: ROOT,
  env,
  timeout: 40000
})
const main = await app.firstWindow({ timeout: 25000 })
await main.waitForTimeout(1500)

const list = await main.evaluate(async () => await window.ss.profiles.list())
let prof = (Array.isArray(list) ? list : []).find((p) => p.platform === 'macos')
if (!prof) prof = await main.evaluate(async () => await window.ss.profiles.create({ name: '诊断-字体', platform: 'macos' }))
if (!prof || !prof.id) { console.log('建环境失败'); await app.close(); process.exit(2) }
console.log('环境：' + prof.name + '（platform=' + prof.platform + '），宿主 = Windows')

await main.evaluate(async (id) => await window.ss.profiles.launch(id), prof.id)
await main.waitForTimeout(5000)

const r = await app.evaluate(async ({ BrowserWindow }) => {
  const sleep = (ms) => new Promise((x) => setTimeout(x, ms))
  const find = () => {
    const win = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('role=browser'))
    return win ? win.contentView.children[0].webContents : null
  }
  let wc = find()
  if (!wc) return { error: '没窗口' }
  try { await wc.loadURL('data:text/html,<html><body>font</body></html>') } catch (e) {}
  await sleep(800)
  const script = `(() => {
    var FONTS = ['Microsoft YaHei UI', 'Segoe UI Emoji', 'Cambria Math', 'Ink Free', 'Helvetica Neue', 'Geneva'];
    var REF = 'monospace';
    var measure = function (ctx, fam) {
      ctx.font = '72px ' + REF;
      var base = ctx.measureText('mmmmmmmmmmlli').width;
      ctx.font = '72px "' + fam + '", ' + REF;
      var w = ctx.measureText('mmmmmmmmmmlli').width;
      return Math.abs(w - base) > 0.5;
    };
    var c2d = document.createElement('canvas').getContext('2d');
    var off = (typeof OffscreenCanvas === 'function') ? new OffscreenCanvas(1, 1).getContext('2d') : null;
    var out = { hasOffscreenCtx: !!off, rows: [] };
    for (var i = 0; i < FONTS.length; i++) {
      out.rows.push({
        font: FONTS[i],
        canvas2d: measure(c2d, FONTS[i]),
        offscreen: off ? measure(off, FONTS[i]) : null
      });
    }
    out.diff = out.rows.filter(function (r) { return r.offscreen !== null && r.canvas2d !== r.offscreen });
    return out;
  })()`
  try { return await wc.executeJavaScript(script) } catch (e) { return { error: String((e && e.message) || e) } }
})

console.log('\n字体                  Canvas2D    OffscreenCanvas')
for (const row of (r.rows || [])) {
  console.log('  ' + String(row.font).padEnd(20) + String(row.canvas2d).padEnd(12) + String(row.offscreen))
}
console.log('\n两条路答案不同的字体：' + JSON.stringify((r.diff || []).map((x) => x.font)))
if (r.error) console.log('错误：' + r.error)

/* ── 门禁 ──
 *
 * 两条判据，各自防一种失败方式：
 *
 * ① **两条通道必须给同一个答案**。只判「宿主字体读不到」是不够的：
 *    将来有人把 Canvas2D 那条包坏了、两条都读不到，判据照样绿，
 *    但真实浏览器里 Arial 是存在的 —— 那就从「泄漏」变成「缺字体」，同样可判定。
 * ② **宿主专属字体必须读不到**。这是这次要修的那条。
 *
 * 刻意**不判**「macOS 字体必须读得到」：那需要真的字体文件，宿主没有就是没有，
 * 靠偏移量假装是另一个问题（见 fingerprint.ts 里的 `_miss` 分支）。
 * 判了就是一条永远红的断言。 */
const HOST_ONLY = ['Microsoft YaHei UI', 'Segoe UI Emoji', 'Cambria Math', 'Ink Free']
const rows = r.rows || []
const leaks = rows.filter((x) => HOST_ONLY.includes(x.font) && (x.canvas2d === true || x.offscreen === true))
const diff = r.diff || []

const gates = [
  {
    label: '两条测量通道必须给同一个答案（Canvas2D vs OffscreenCanvas）',
    expected: [],
    actual: diff.map((x) => x.font),
    pass: diff.length === 0,
    note: '两条路不一致 = 只包了其中一条。OffscreenCanvas 是独立原型，不受 CanvasRenderingContext2D 影响'
  },
  {
    label: '宿主专属字体在两条通道上都必须读不到',
    expected: [],
    actual: leaks.map((x) => x.font + '(c2d=' + x.canvas2d + ',off=' + x.offscreen + ')'),
    pass: leaks.length === 0,
    note: '读得到 = 宿主字体表泄漏，macOS 环境里能量出 Windows 字体'
  }
]

console.log('\n[结论]')
let bad = 0
for (const g of gates) {
  if (!g.pass) bad += 1
  console.log('  ' + (g.pass ? '成立' : '不成立').padEnd(4) + ' ' + g.label +
    '  期望 ' + JSON.stringify(g.expected) + ' 实得 ' + JSON.stringify(g.actual))
  if (!g.pass && g.note) console.log('        ↳ ' + g.note)
}
if (!rows.length) {
  bad += 1
  console.log('  不成立 没读到任何字体读数（未测量，不是通过）')
}

try { await app.close() } catch (e) {}
console.log(bad > 0 ? `\n${gates.length - bad}/${gates.length} 成立，${bad} 条不成立` : `\n全部 ${gates.length} 条成立`)
process.exit(bad > 0 ? 1 : 0)
