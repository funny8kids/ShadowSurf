/**
 * 第三方交叉验证：用 creepjs 跑一遍。
 *
 * 自建探针只能证明「我们改的地方确实改了」，证明不了「改得像不像」。
 * creepjs 会主动找矛盾（UA 说 macOS 却装 Windows 字体、时区与语言对不上、
 * 引擎版本与 UA 不符……），并把它们标成 lie / unlike。它给的 trust score
 * 才是外部视角的评分。
 *
 * ── 第一版的问题（这一版修的） ──
 *
 * 第一版用 `[class*="lie"]` 抓 lies，抓到的是 `lies hash :: f5f4aa2f` ——
 * **只有 hash，没有内容**。于是「11 条 lies」这个数字能拿到，但一条都说不清是什么，
 * 而「说不清」和「没有」在报告里长得一样。这一版改成：
 *
 *   1. 先点开所有 details 折叠面板（creepjs 默认收起，收起时 innerText 里没有细节）；
 *   2. dump **完整** innerText（第一版截到 5000 字，后面的段落全丢了）；
 *   3. 同时把 localStorage / sessionStorage 全量导出来 —— 用来回答
 *      「两个环境的 FP ID 相同」到底是共用存储，还是 FP ID 只由某个相同子集算出。
 *
 * ── 用法 ──
 *   node tools/audit-creepjs.mjs            # 两个环境各跑一遍，打印摘要
 *   node tools/audit-creepjs.mjs --full     # 额外把完整文本落到 artifacts/
 *
 * 这不是门禁：creepjs 是外部站点，会改版、会抽风，把它放进 verify:all
 * 等于让第三方决定我们的 CI 红绿。它只出读数。
 */
import { _electron as electron } from 'playwright-core'
import { resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const ROOT = resolve(import.meta.dirname, '..')
const ART = resolve(ROOT, 'artifacts')
const FULL = process.argv.includes('--full')
const CREEP_URL = 'https://abrahamjuliot.github.io/creepjs/'

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE

/* 打开每一个 details 弹窗，把「新增的文本」单独取出来。
 *
 * 第一版在这里错了两次，都值得记：
 *   ① 选择器要求 `children.length === 0` —— 而开关是
 *      `<label class="modal-open-btn"><input…>details</label>`，带子元素，
 *      于是**一个都没点到**，而脚本报告「展开 0 个」之后继续往下跑，
 *      看起来像「creepjs 没有细节可看」。
 *   ② 上一版用 `[class*="lie"]` 抓 lies，抓到 11 条 `lies hash :: xxxxxxxx`。
 *      那不是 11 条 lie —— `lies hash` 是**每个分段自己的 class 名**，
 *      一个分段一个，正好 11 段。「11 条 lies」这个数字从头到尾是假的。
 *
 * 现在的做法：点开 → 取 body.innerText → 和基线求差集 → 关掉 → 下一个。
 * 差集才是弹窗里的内容，不会把整页文本重复四遍。 */
const MODALS = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const labels = [...document.querySelectorAll('label.modal-open-btn')];
  const out = [];
  for (let i = 0; i < labels.length; i++) {
    try { labels[i].click() } catch (e) {}
    await sleep(700);
    // 直接读 modal 容器，不求差集 —— 差集在「没关掉」时会重复前一条
    const boxes = [...document.querySelectorAll('[class*=\"modal\"]')]
      .filter((e) => e.innerText && e.innerText.trim().length > 0)
      .map((e) => ({ cls: String(e.className), text: e.innerText.trim().slice(0, 4000) }));
    out.push({ i, label: (labels[i].textContent || '').trim().slice(0, 40), boxes });
    try { const c = document.querySelector('.modal-close-btn'); if (c) c.click() } catch (e) {}
    await sleep(350);
  }
  return out;
})()`

const DUMP = `(() => {
  const text = document.body.innerText || '';
  const grab = (re) => { const m = text.match(re); return m ? m[1] : null };
  const dumpStorage = (s) => {
    const out = {};
    try {
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        out[k] = String(s.getItem(k)).slice(0, 400);
      }
    } catch (e) { return { error: String(e) } }
    return out;
  };
  return {
    fpId: grab(/FP ID:\\s*([0-9a-f]+)/i),
    fuzzy: grab(/Fuzzy:\\s*([0-9a-f]+)/i),
    trust: grab(/trust score:\\s*([0-9.]+%)/i),
    sectionHashes: (text.match(/^[A-Za-z][A-Za-z \\/]{2,30}?[0-9a-f]{8}$/gm) || []).slice(0, 60),
    localStorage: dumpStorage(localStorage),
    sessionStorage: dumpStorage(sessionStorage),
    /* DOM 结构探测：第一版 EXPAND 点不到任何面板（展开数为 0），
       说明「details」不是纯文本 span。这里把候选连同 tag/class 一起带出来，
       下次跑就能按实际结构改选择器，而不是继续猜。 */
    domProbe: (() => {
      const cand = [];
      for (const e of document.querySelectorAll('*')) {
        const t = (e.textContent || '').trim().toLowerCase();
        if (e.children.length === 0 && t && t.length <= 12 &&
            /detail|more|show|see|expand|hash|lie|trust/.test(t)) {
          cand.push(e.tagName + '.' + String(e.className || '') + ' :: ' + t);
        }
        if (cand.length > 60) break;
      }
      const classes = [...new Set([...document.querySelectorAll('*')]
        .map((e) => String(e.className || ''))
        .filter((c) => c && /lie|trust|detail|hash|score/i.test(c)))].slice(0, 40);
      return { cand, classes };
    })(),
    text
  };
})()`

const app = await electron.launch({
  executablePath: resolve(ROOT, 'node_modules/electron/dist/electron.exe'),
  args: ['.', '--user-data-dir=' + resolve(ART, 'creepjs-ud')],
  cwd: ROOT,
  env,
  timeout: 40000
})
const main = await app.firstWindow({ timeout: 25000 })
await main.waitForTimeout(1600)

const ids = await main.evaluate(async () => {
  const list = await window.ss.profiles.list()
  const pick = (pf) => {
    const hit = (list || []).find((p) => p.platform === pf)
    return hit ? { id: hit.id, name: hit.name } : null
  }
  const out = { win: pick('windows'), mac: pick('macos') }
  // 没有就建：这个脚本用独立 user-data-dir，第一次跑必然为空。
  // 不建的话下面会静默什么都不跑 —— 「零条检查」伪装成「跑过了」。
  if (!out.win) out.win = await window.ss.profiles.create({ name: '审计-creepjs-win', platform: 'windows' })
  if (!out.mac) out.mac = await window.ss.profiles.create({ name: '审计-creepjs-mac', platform: 'macos' })
  return {
    win: out.win ? { id: out.win.id, name: out.win.name } : null,
    mac: out.mac ? { id: out.mac.id, name: out.mac.name } : null
  }
})

if (!ids.win || !ids.mac) {
  console.log('建环境失败，什么都没测 —— 这是「未测量」，不是「通过」')
  await app.close()
  process.exit(3)
}

async function run(profile, label) {
  await main.evaluate(async (id) => await window.ss.profiles.launch(id), profile.id)
  await main.waitForTimeout(5000)

  const opened = await app.evaluate(
    async ({ BrowserWindow }, args) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const findWin = () =>
        BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('role=browser'))
      const win = findWin()
      if (!win) return { error: '窗口未打开' }
      const wc = win.contentView.children[0].webContents
      try { wc.stop() } catch (e) {}
      await sleep(400)
      for (let i = 0; i < 3; i++) {
        try { await wc.loadURL(args.url) } catch (e) {}
        if (wc.getURL().includes('creepjs')) break
        await sleep(700)
      }
      return { ok: true, url: wc.getURL() }
    },
    { url: CREEP_URL }
  )
  if (opened.error) return { label, error: opened.error }

  // creepjs 要跑一轮 worker + 指纹采集
  await main.waitForTimeout(14000)

  const modals = await app.evaluate(async ({ BrowserWindow }, script) => {
    const win = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('role=browser'))
    if (!win) return []
    try { return await win.contentView.children[0].webContents.executeJavaScript(script) } catch (e) { return [] }
  }, MODALS)

  const data = await app.evaluate(async ({ BrowserWindow }, script) => {
    const win = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('role=browser'))
    if (!win) return { error: '窗口消失' }
    try { return await win.contentView.children[0].webContents.executeJavaScript(script) } catch (e) {
      return { error: String((e && e.message) || e) }
    }
  }, DUMP)

  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('role=browser'))
    if (win) win.close()
  })
  await main.waitForTimeout(1200)

  return { label, profileId: profile.id, modals, data }
}

const out = []
if (ids.win) out.push(await run(ids.win, 'Windows 11'))
if (ids.mac) out.push(await run(ids.mac, 'macOS 15'))

/* ── 摘要 ── */
console.log('\n===== creepjs 交叉验证 =====\n')
for (const r of out) {
  if (r.error) { console.log('[' + r.label + '] 失败：' + r.error); continue }
  const d = r.data || {}
  console.log('[' + r.label + ']  FP ID=' + String(d.fpId) + '  Fuzzy=' + String(d.fuzzy) +
    '  trust=' + String(d.trust) + '  弹窗 ' + String((r.modals||[]).length) + ' 个')
}

/* 关键判定：两个环境是不是同一个 FP ID */
if (out.length === 2 && out[0].data && out[1].data) {
  const same = out[0].data.fpId === out[1].data.fpId
  console.log('\n[FP ID 对比] ' + (same ? '**相同**' : '不同'))
  if (same) {
    const a = new Set(out[0].data.sectionHashes || [])
    const b = new Set(out[1].data.sectionHashes || [])
    const common = [...a].filter((x) => b.has(x))
    console.log('  分段 hash 共有的：' + JSON.stringify(common))
    console.log('  → 若 FP ID 相同而分段 hash 大量不同，说明 FP ID 不是由这些分段算出来的；')
    console.log('     若两边的 localStorage 也不同，则不是共用存储 —— 要去看 creepjs 的算法。')
  }
  const la = out[0].data.localStorage || {}
  const lb = out[1].data.localStorage || {}
  const sharedKeys = Object.keys(la).filter((k) => k in lb && String(la[k]) === String(lb[k]))
  console.log('  localStorage 键：A=' + JSON.stringify(Object.keys(la)) + '  B=' + JSON.stringify(Object.keys(lb)))
  console.log('  两边同键同值的：' + JSON.stringify(sharedKeys))
}

/* ── 命中了什么 ──
 *
 * creepjs 的每个 details 面板是一串 `key: value`。真正要紧的不是「有多少条 lie」，
 * 而是**哪些 key 是 true** —— 那些就是它判定「这台不像真浏览器」的依据。
 *
 * 第一版数的是 `[class*="lie"]` 的元素，而 `lies hash` 是**每个分段自己的 class 名**，
 * 正好 11 段 —— 于是「11 条 lies」这个数字从头到尾是假的：它数的是分段数，
 * 不是 lie 数。这类错误的形状值得记：**选择器命中的是标签，不是事实**。
 */
const flagOf = (r) => {
  const set = new Set()
  const seen = new Set()
  for (const m of r.modals || []) {
    for (const b of m.boxes || []) {
      if (String(b.cls).indexOf('container') < 0) continue
      const key = b.text.slice(0, 60)
      if (seen.has(key)) continue
      seen.add(key)
      for (const line of b.text.split('\n')) {
        const mm = /^\s*([A-Za-z][\w.]*)\s*:\s*true\s*$/.exec(line)
        if (mm) set.add(mm[1])
      }
    }
  }
  return set
}

console.log('\n[检测项命中] 下面这些 key 为 true —— 每一个都是 creepjs 判定「不像真浏览器」的依据')
const flags = out.map((r) => ({ label: r.label, set: flagOf(r) }))
const allKeys = [...new Set(flags.flatMap((f) => [...f.set]))].sort()
for (const k of allKeys) {
  const who = flags.filter((f) => f.set.has(k)).map((f) => f.label).join(' + ')
  console.log('  ' + k.padEnd(26) + who)
}
if (allKeys.length === 0) {
  console.log('  （没有 —— 但先确认面板真的被打开了，别把「没展开」读成「没问题」）')
}

if (FULL) {
  mkdirSync(ART, { recursive: true })
  const p = resolve(ART, 'creepjs-full.json')
  writeFileSync(p, JSON.stringify(out, null, 2), 'utf8')
  console.log('\n完整读数：' + p)
}

await app.close()
