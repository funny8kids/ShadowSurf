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
    // 第三条通道：DOM 布局宽度。它走排版，**不经过 measureText** ——
    // 所以 measureText 包得再干净，这条路照样能量出宿主字体。
    var layout = function (fam) {
      var span = document.createElement('span');
      span.style.position = 'absolute';
      span.style.left = '-9999px';
      span.style.top = '0';
      span.style.fontSize = '72px';
      span.style.whiteSpace = 'nowrap';
      span.style.fontFamily = REF;
      span.textContent = 'mmmmmmmmmmlli';
      document.body.appendChild(span);
      var base = span.offsetWidth;
      span.style.fontFamily = '"' + fam + '", ' + REF;
      var w = span.offsetWidth;
      document.body.removeChild(span);
      return Math.abs(w - base) > 0.5;
    };
    var c2d = document.createElement('canvas').getContext('2d');
    var off = (typeof OffscreenCanvas === 'function') ? new OffscreenCanvas(1, 1).getContext('2d') : null;
    var out = { hasOffscreenCtx: !!off, rows: [] };
    for (var i = 0; i < FONTS.length; i++) {
      out.rows.push({
        font: FONTS[i],
        canvas2d: measure(c2d, FONTS[i]),
        offscreen: off ? measure(off, FONTS[i]) : null,
        layout: layout(FONTS[i])
      });
    }
    out.diff = out.rows.filter(function (r) { return r.offscreen !== null && r.canvas2d !== r.offscreen });
    return out;
  })()`
  try { return await wc.executeJavaScript(script) } catch (e) { return { error: String((e && e.message) || e) } }
})

console.log('\n字体                  Canvas2D    OffscreenCanvas  DOM 布局')
for (const row of (r.rows || [])) {
  console.log('  ' + String(row.font).padEnd(20) + String(row.canvas2d).padEnd(12) + String(row.offscreen).padEnd(14) + String(row.layout))
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

/* ── 第三条通道：DOM 布局，**不判**，只写读数 ──
 *
 * 它走排版引擎，不经过 `measureText` —— 上面两条包得再干净，这条路照样能量出宿主字体
 * （实测四个 Windows 字体在 c2d/offscreen 都是 false，只有 layout 是 true）。
 *
 * 为什么不升成门禁：修它要动**引擎级字体配置**（按环境换 fallback 字体表），
 * Electron 没有按 partition 暴露这个能力。一条注定红的断言只会变成背景噪音 ——
 * 和本轮 §6 第 10 类同一个道理。所以这里是读数，且必须每次都打出来：
 * 「我们只挡住了两条通道」这句话，不能只写在注释里。 */
const layoutLeaks = rows.filter((x) => HOST_ONLY.includes(x.font) && x.layout === true)
console.log('\n[第三条通道] DOM 布局宽度（不判，读数）')
console.log('  宿主字体在布局通道上仍读得到：' + (layoutLeaks.length ? JSON.stringify(layoutLeaks.map((x) => x.font)) : '无'))
console.log('  → 这条要修得动引擎级字体 fallback 配置；包 offsetWidth 是更大的面，且自带 tell。')
console.log('    所以 creepjs 的 `platform hints` 仍会报宿主字体 —— 这是已知边界，不是漏了 hook。')

try { await app.close() } catch (e) {}
console.log(bad > 0 ? `\n${gates.length - bad}/${gates.length} 成立，${bad} 条不成立` : `\n全部 ${gates.length} 条成立`)
process.exit(bad > 0 ? 1 : 0)
