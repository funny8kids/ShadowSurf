/**
 * 一次性诊断：字体探测走 Canvas2D 与走 OffscreenCanvas 是否给出同一个答案。
 *
 * 假设：注入只挂了 `CanvasRenderingContext2D.prototype.measureText`，
 * 没挂 `OffscreenCanvasRenderingContext2D.prototype.measureText`。
 * 若成立，macOS 环境里用 OffscreenCanvas 量 Windows 专属字体（Microsoft YaHei UI）
 * 会「量得出来」，而 Canvas2D 量不出来 —— 两条路给出两个答案，
 * 后者才是 creepjs 的 `platform hints: Arial,"Microsoft YaHei UI"` 的来源。
 *
 * 这不是 gate，是**测量**：读数目前是红的（OffscreenCanvas 那条路漏），
 * 所以不进 verify:all —— 一条注定红的断言只会变成背景噪音。
 * 修好之后再把两条读数升成 gate。
 *
 * 跑法：npm run probe:fonts
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

try { await app.close() } catch (e) {}
process.exit(0)
