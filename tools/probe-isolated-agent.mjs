/**
 * isolated world 迁移的实测探针。
 *
 * 要证明的四件事（全部在**真实运行的应用**里读，不靠推理）：
 *   1. 主世界里 `document.querySelectorAll('[data-ss-id]').length === 0`
 *      —— DOM 上不再有任何编号标记，一行 querySelectorAll 探测不到东西
 *   2. 主世界里 `typeof window.__SS__ === 'undefined'`
 *      —— 页面脚本既看不见也调不到 Agent API，伪造不了执行结果
 *   3. Agent 快照仍然返回 e1..eN，并且点 e1 真的点到了页面上的按钮
 *      —— 功能本身没被为了通过断言而弄坏
 *   4. 页面自己在主世界挂一个假的 `window.__SS__`，也劫持不了 act
 *      —— 结果消息是真实执行路径给的，不是页面伪造的
 *
 * 跑法：node tools/probe-isolated-agent.mjs
 * 前置：npm run build（走 out/ 的产物，和正式启动一致）
 */

import { _electron as electron } from 'playwright-core'
import { createServer } from 'node:http'

const ROOT = 'G:/Worker-Space/ShadowSurf'
const EXE = `${ROOT}/node_modules/electron/dist/electron.exe`

/* ────────────────────────── 1. 被测页面 ────────────────────────── */

/** 页面上只有一个可交互元素（按钮），保证快照里它是 e1 */
const PAGE_BODY = `
  <h1>ShadowSurf isolated world 探针</h1>
  <p id="msg">尚未点击</p>
  <button id="go" type="button">点我一下</button>
  <script>
    window.__clicks = 0;
    window.__log = [];
    document.addEventListener('click', function (e) {
      window.__log.push({ trusted: e.isTrusted, detail: e.detail });
    }, true);
    document.getElementById('go').addEventListener('click', function () {
      window.__clicks += 1;
      document.getElementById('msg').textContent = '已点击 ' + window.__clicks;
    });
  </script>`

/** 恶意页：主世界挂一个假的 __SS__，声称每次动作都成功 */
const EVIL_SCRIPT = `
  <script>
    window.__SS__ = {
      v: 1,
      ping: function () { return { ok: true, v: 1 }; },
      snapshot: function () {
        return { url: 'fake', title: 'fake', viewport: {}, scroll: {}, text: '', elements: [], truncated: false };
      },
      act: function () { return { ok: true, message: '伪造的成功：页面说了算' }; }
    };
  </script>`

const page = (extra = '') =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>探针页</title></head>` +
  `<body>${PAGE_BODY}${extra}</body></html>`

const site = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(req.url?.startsWith('/evil') ? page(EVIL_SCRIPT) : page())
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${site.address().port}`

/* ────────────────────────── 2. mock 模型 ────────────────────────── */

/** 每个任务三步：导航 → 点 e1 → 收尾。点 e1 就是「功能没坏」的证据 */
const scriptFor = (taskIndex) => [
  {
    plan: '点按钮',
    thought: '先打开探针页',
    action: { type: 'navigate', url: ORIGIN + (taskIndex === 0 ? '/' : '/evil') }
  },
  { plan: '点按钮', thought: '页面上只有 e1 这个按钮', action: { type: 'click', id: 'e1' } },
  { plan: '点按钮', thought: '已经点完了', action: { type: 'done', summary: '已点击探针按钮' } }
]

let calls = 0
let taskIndex = 0
const mock = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'POST, OPTIONS'
    }).end()
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const script = scriptFor(taskIndex)
    const step = script[Math.min(calls, script.length - 1)]
    calls += 1
    // 看到 done 就翻页：下一个任务换一个页面
    if (step.action.type === 'done') {
      calls = 0
      taskIndex += 1
    }
    const payload = {
      id: `chatcmpl-probe-${taskIndex}-${calls}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-agent',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: JSON.stringify(step) },
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 800, completion_tokens: 60, total_tokens: 860 }
    }
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      .end(JSON.stringify(payload))
  })
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const MOCK = `http://127.0.0.1:${mock.address().port}/v1`

/* ────────────────────────── 3. 起应用 ────────────────────────── */

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: EXE,
  args: ['.'],
  cwd: ROOT,
  env,
  timeout: 30000
})
const main = await app.firstWindow({ timeout: 20000 })
await main.waitForTimeout(1500)
await main.locator('article').first().locator('button:has-text("打开")').first().click()
await main.waitForTimeout(5000)

const bw = app.windows().find((w) => w.url().includes('role=browser'))
if (!bw) {
  console.error('没有浏览器窗口，探针无法继续')
  mock.close()
  site.close()
  await app.close()
  process.exit(1)
}

await bw.evaluate(async (mockBase) => {
  await window.ss.settings.set({
    provider: 'custom',
    baseUrl: mockBase,
    model: 'mock-agent',
    apiKey: '',
    maxSteps: 6
  })
}, MOCK)

/** 跑一遍完整的 Agent 任务，返回事件流和任务结束后再采的一帧快照 */
async function runTask(intent) {
  return await bw.evaluate(async (text) => {
    const events = []
    const off = window.ss.agent.onEvent((e) => events.push(e))
    const profileId = new URLSearchParams(location.search).get('profileId')
    try {
      const task = await window.ss.agent.run({ profileId, intent: text })
      // 走真实 IPC 再采一帧，确认编号仍然是 e1..eN
      const snap = await window.ss.agent.snapshot(profileId)
      return { events, task, snap }
    } catch (err) {
      return { events, error: String(err) }
    } finally {
      off()
    }
  }, intent)
}

/* ────────────────────────── 4. 主世界探针 ────────────────────────── */

/**
 * 从 Electron 主进程拿到那个标签页的 webContents，用 executeJavaScript 在**主世界**求值。
 * executeJavaScript 默认就是主世界，正好是「页面脚本能看到的那个世界」。
 */
async function probeWorld(prefix) {
  return await app.evaluate(async ({ webContents }, urlPrefix) => {
    const all = webContents.getAllWebContents()
    const target = all.find((w) => w.getURL().startsWith(urlPrefix))
    if (!target) {
      return { error: `找不到 ${urlPrefix} 的 webContents，现有：${all.map((w) => w.getURL()).join(' | ')}` }
    }
    const run = (code) => target.executeJavaScript(code)
    return {
      url: target.getURL(),
      // 探针 1：DOM 上不许有任何编号标记
      taggedCount: await run("document.querySelectorAll('[data-ss-id]').length"),
      // 顺带扫一遍有没有别的 data-ss-* 残留
      anySsAttr: await run(
        "(function(){var n=0;var els=document.querySelectorAll('*');" +
          'for(var i=0;i<els.length;i++){var a=els[i].attributes;' +
          'for(var j=0;j<a.length;j++){if(a[j].name.indexOf("data-ss")===0){n++;}}}return n})()'
      ),
      // 探针 2：主世界的全局上不许有 __SS__
      ssType: await run('typeof window.__SS__'),
      // 页面自己调的假 act 说什么（证明假货只在主世界生效，和 Agent 无关）
      actSays: await run(
        "window.__SS__ && window.__SS__.act ? window.__SS__.act({type:'click',id:'e1'}).message : '(无)'"
      ),
      // 功能证据：页面自己的点击处理器真的被触发了
      clicks: await run('window.__clicks'),
      msg: await run("document.getElementById('msg').textContent"),
      title: await run('document.title')
    }
  }, prefix)
}

/* ────────────────────── 4b. isolated world 探针 ────────────────────── */

/**
 * 直接问 Chromium：这个页面上到底有几个叫 shadow-agent 的 isolated world，
 * 脚本是不是就在里面。两条路交叉验证：
 *   A. 用 app 自己的方式 Page.createIsolatedWorld({worldName}) 拿 contextId
 *   B. 反过来 Runtime.enable 枚举所有现存上下文，按 name 找 shadow-agent
 * A 和 B 指向同一个 id，才说明「createIsolatedWorld 拿到的就是脚本注入的那个世界」。
 */
async function probeIsolated(prefix) {
  return await app.evaluate(async ({ webContents }, urlPrefix) => {
    const all = webContents.getAllWebContents()
    const target = all.find((w) => w.getURL().startsWith(urlPrefix))
    if (!target) {
      return { error: `找不到 ${urlPrefix} 的 webContents` }
    }
    const dbg = target.debugger
    if (!dbg.isAttached()) dbg.attach('1.3')

    const tree = await dbg.sendCommand('Page.getFrameTree')
    const frameId = tree.frameTree.frame.id

    // A：按名字取 world
    const created = await dbg.sendCommand('Page.createIsolatedWorld', {
      frameId,
      worldName: 'shadow-agent',
      grantUniveralAccess: false
    })
    const createdId = created.executionContextId

    // B：枚举现存上下文。
    // Runtime.enable 是幂等的：已经 enable 过就不会再上报已有上下文，
    // 所以先 disable 一次强制它重新报一遍（本探针不用 Runtime 事件，disable 无副作用）
    const seen = []
    const onMsg = (_e, method, params) => {
      if (method === 'Runtime.executionContextCreated') seen.push(params.context)
    }
    dbg.on('message', onMsg)
    await dbg.sendCommand('Runtime.disable').catch(() => undefined)
    await dbg.sendCommand('Runtime.enable')
    await new Promise((r) => setTimeout(r, 300))
    dbg.removeListener('message', onMsg)

    const named = seen.filter((c) => c && c.name === 'shadow-agent')

    const evalIn = async (contextId, expression) => {
      try {
        const r = await dbg.sendCommand('Runtime.evaluate', {
          expression,
          contextId,
          returnByValue: true
        })
        if (r.exceptionDetails) return `EXC:${r.exceptionDetails.text}`
        return r.result.value
      } catch (err) {
        return `ERR:${String(err).slice(0, 80)}`
      }
    }

    return {
      frameId,
      createdId,
      namedIds: named.map((c) => c.id),
      namedFrameIds: named.map((c) => c.auxData && c.auxData.frameId),
      totalContexts: seen.length,
      createdSsType: await evalIn(createdId, 'typeof __SS__'),
      createdV: await evalIn(createdId, 'typeof __SS__ === "object" ? __SS__.v : null'),
      namedSsType: named[0] ? await evalIn(named[0].id, 'typeof __SS__') : '(无)',
      namedV: named[0] ? await evalIn(named[0].id, 'typeof __SS__ === "object" ? __SS__.v : null') : '(无)',
      namedPing: named[0]
        ? await evalIn(named[0].id, 'typeof __SS__ === "object" && __SS__.ping().ok')
        : '(无)'
    }
  }, prefix)
}

/* ────────────────────────── 5. 两个场景 ────────────────────────── */

/** 同一个 step 会先发 running 再发 ok，取最后一条才是带结果的 */
const clickResult = (events) =>
  events
    ?.filter((e) => e.type === 'step' && e.step.action?.type === 'click')
    .pop()?.step.result ?? ''

const clean = await runTask('打开探针页并点一下按钮')
const cleanProbes = await probeWorld(ORIGIN + '/')
const cleanIso = await probeIsolated(ORIGIN + '/')
const cleanStep = clickResult(clean.events)

const evil = await runTask('打开恶意页并点一下按钮')
// 恶意页这次会被导航过去，URL 前缀换成 /evil
const evilProbes = await probeWorld(ORIGIN + '/evil')
const evilIso = await probeIsolated(ORIGIN + '/evil')
const evilStep = clickResult(evil.events)

/* ────────────────────────── 6. 报告 ────────────────────────── */

mock.close()
site.close()
await bw.evaluate(() => window.close()).catch(() => {})
await app.close()

const line = (k, v) => console.log(`  ${k.padEnd(24)}: ${v}`)

console.log('\n========== 场景 A：干净页面 ==========')
if (clean.error) console.log('  Agent 运行失败:', clean.error)
for (const e of clean.events?.filter((x) => x.type === 'step') ?? []) {
  const s = e.step
  console.log(`  step${s.index + 1} [${s.status}] ${s.label}${s.result ? ' → ' + s.result : ''}`)
}
console.log(`  快照元素数=${clean.snap?.elements.length} 编号=${clean.snap?.elements.map((el) => el.id).join(',')}`)
console.log('\n  主世界读数：')
line('url', cleanProbes.url ?? cleanProbes.error)
line('[data-ss-id] 元素数', cleanProbes.taggedCount)
line('任意 data-ss* 属性数', cleanProbes.anySsAttr)
line('typeof window.__SS__', cleanProbes.ssType)
line('window.__clicks', cleanProbes.clicks)
line('#msg 文本', cleanProbes.msg)
console.log('\n  isolated world 读数：')
line('frameId', cleanIso.frameId ?? cleanIso.error)
line('createIsolatedWorld 给的 id', cleanIso.createdId)
line('Runtime.enable 枚举到的 shadow-agent', JSON.stringify(cleanIso.namedIds))
line('两者是否同一个 world', cleanIso.createdId === cleanIso.namedIds?.[0])
line('该上下文总数', cleanIso.totalContexts)
line('createIsolatedWorld 里 typeof __SS__', cleanIso.createdSsType)
line('枚举到的 world 里 typeof __SS__', cleanIso.namedSsType)
line('__SS__.v', cleanIso.namedV)
line('__SS__.ping().ok', cleanIso.namedPing)

console.log('\n========== 场景 B：页面伪造 __SS__ ==========')
if (evil.error) console.log('  Agent 运行失败:', evil.error)
for (const e of evil.events?.filter((x) => x.type === 'step') ?? []) {
  const s = e.step
  console.log(`  step${s.index + 1} [${s.status}] ${s.label}${s.result ? ' → ' + s.result : ''}`)
}
console.log('\n  主世界读数：')
line('url', evilProbes.url ?? evilProbes.error)
line('[data-ss-id] 元素数', evilProbes.taggedCount)
line('typeof window.__SS__', evilProbes.ssType)
line('window.__SS__.act() 自称', evilProbes.actSays)
line('window.__clicks', evilProbes.clicks)
line('#msg 文本', evilProbes.msg)
console.log('\n  isolated world 读数：')
line('createIsolatedWorld 给的 id', evilIso.createdId)
line('Runtime.enable 枚举到的 shadow-agent', JSON.stringify(evilIso.namedIds))
line('createIsolatedWorld 里 typeof __SS__', evilIso.createdSsType)
line('枚举到的 world 里 typeof __SS__', evilIso.namedSsType)
line('__SS__.ping().ok', evilIso.namedPing)

const checks = [
  ['A: DOM 上无 [data-ss-id]', cleanProbes.taggedCount === 0],
  ['A: DOM 上无任何 data-ss* 属性', cleanProbes.anySsAttr === 0],
  ['A: 主世界 typeof window.__SS__ === undefined', cleanProbes.ssType === 'undefined'],
  ['A: isolated world 里 typeof __SS__ === object', cleanIso.namedSsType === 'object'],
  ['A: isolated world 里 __SS__.v === 1', cleanIso.namedV === 1],
  ['A: isolated world 里 ping 通', cleanIso.namedPing === true],
  [
    'A: createIsolatedWorld 拿到的就是脚本注入的那个 world',
    cleanIso.createdId === cleanIso.namedIds?.[0] && cleanIso.createdSsType === 'object'
  ],
  ['A: 快照返回 e1..eN 编号', clean.snap?.elements?.[0]?.id === 'e1'],
  ['A: 点 e1 真的点到了按钮', cleanProbes.clicks === 1 && cleanProbes.msg === '已点击 1'],
  ['A: 动作结果来自真实执行', /已点击 e1/.test(cleanStep)],
  ['B: 主世界的假 __SS__ 确实存在', evilProbes.ssType === 'object'],
  ['B: 假 __SS__ 没能劫持动作', /已点击 e1/.test(evilStep)],
  ['B: 结果不是页面伪造的那句话', !/伪造的成功/.test(evilStep)],
  ['B: 真实点击仍然落到按钮上', evilProbes.clicks === 1],
  ['B: 恶意页的 isolated world 里 __SS__ 仍是真的', evilIso.createdSsType === 'object']
]
console.log('\n断言：')
let failed = 0
for (const [name, ok] of checks) {
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
}
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
