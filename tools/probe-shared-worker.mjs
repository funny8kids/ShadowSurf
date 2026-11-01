/**
 * shared_worker 覆盖情况 + Worker 里 WebRTC 存在性 —— 纯测量，不改产品代码。
 *
 * ── 为什么要有这个探针 ──
 *
 * `src/main/core/windows.ts` 里有一段注释断言：
 *   「shared_worker 更进一步：它根本不会走到这里 —— 实测 Target.setAutoAttach
 *     不覆盖它（Target.getTargets 里 attached:false），需要额外走
 *     Target.attachToTarget 才能拿到 session，本项目暂未实现。」
 *
 * 但 `probe-tmp/` 里没有任何 shared_worker 的读数，仓库里也没有 artifact。
 * 按本轮定下的规矩，**没有 artifact 的结论不能当前提**。这个探针就是补那份 artifact。
 *
 * 同时测第二件事：Worker 里 `typeof RTCPeerConnection`。B3 要把 WebRTC 候选过滤
 * 下沉到 worker，前提是「worker 里真有这个接口」。没有就先测，别先改。
 *
 * ── 结论（2026-11-01，Electron 45.2.1 / Chromium 156，读数见 artifacts/probe-shared-worker.json）──
 *
 *   1. 上面那段注释**成立**。手动 attach 之前的 `attachedToTarget` 里只有 `worker`；
 *      `shared_worker` 的那一条在 `Target.attachToTarget` 发出后 1ms 才出现 ——
 *      它是**手动 attach 的回声**，不是 setAutoAttach 的投递。
 *   2. 手动 attach 拿到的 session **可用**：`Runtime.evaluate` 正常回值。
 *      也就是说 shared_worker 事后注入可行（顶层已跑完，补不回 install/顶层）。
 *   3. `RTCPeerConnection` / `RTCRtpSender` / `RTCRtpReceiver` 在 dedicated 和
 *      shared worker 里**都是 undefined**，页面自己报回来的读数一致。
 *      → B3「把 WebRTC 候选过滤下沉到 worker」的前提不成立，worker 里没有可过滤的接口。
 *
 * ── 这份探针自己踩过的坑（留着当教训）──
 *
 * `out.attachedToTarget` 是活数组，手动 attach 会往里追加。第一版在 attach 之后才写
 * artifact，于是「手动 attach 引起的回声」被读成了「autoAttach 覆盖了 shared_worker」——
 * 差点据此把一段**正确**的注释改错。现在改成 attach 前后各拍一张快照，并记下每条事件的
 * 到达时刻（`events[].t`）与检查点时刻（`marks[]`）。
 * 教训：**读数必须能回答「谁引起的」**，否则顺序一乱就得出反的结论。
 *
 * ── 测什么 ──
 *
 *   1. `Target.setDiscoverTargets` 之后，`Target.targetCreated` 里会不会出现
 *      `shared_worker`？`Target.getTargets` 里它是什么状态（attached?）？
 *   2. `Target.setAutoAttach({waitForDebuggerOnStart:true})` 之后，
 *      `Target.attachedToTarget` 会不会为 `shared_worker` 触发？
 *      （dedicated worker 作为对照组：它必须触发，否则探针本身没跑对）
 *   3. 手动 `Target.attachToTarget({targetId, flatten:true})` 能不能拿到 session？
 *      拿到之后 `Runtime.evaluate` 能不能跑？
 *   4. 在 dedicated worker session 和 shared worker session 里分别求值
 *      `typeof RTCPeerConnection` / `typeof RTCRtpSender` / `navigator.userAgent`。
 *
 * ── 页面 ──
 *
 * 用 127.0.0.1 上的临时 HTTP 服务，不用 file:// —— shared worker 要求同源，
 * 而 file:// 的 origin 是 opaque，`new SharedWorker()` 会直接抛。
 * 127.0.0.1 同时算安全上下文，避免 `[SecureContext]` 属性缺失造成假阴性。
 *
 * 跑法：node tools/run-electron.mjs tools/probe-shared-worker.mjs
 * 退出码：0 = 测量完成；2 = 探针自身崩了（**测量结果本身不判合格与否**）
 */

import { app, BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const ART = resolve(ROOT, 'artifacts')

app.disableHardwareAcceleration()

/* ────────────────────────────── 页面与 worker 脚本 ────────────────────────────── */

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>shared-worker-probe</title></head>
<body>
<div id="log"></div>
<script>
  window.__probe = { dedicated: null, shared: null, errors: [] };
  try {
    var dw = new Worker('/dw.js');
    dw.onmessage = function (e) { window.__probe.dedicated = e.data; };
    dw.onerror = function (e) { window.__probe.errors.push('dedicated: ' + (e.message || 'error')); };
    dw.postMessage('go');
  } catch (e) { window.__probe.errors.push('dedicated: ' + String(e)); }

  try {
    var sw = new SharedWorker('/sw.js');
    sw.port.onmessage = function (e) { window.__probe.shared = e.data; };
    sw.port.onerror = function (e) { window.__probe.errors.push('shared: ' + String(e)); };
    sw.port.start();
  } catch (e) { window.__probe.errors.push('shared: ' + String(e)); }
</script>
</body></html>`

const DW_JS = `
self.onmessage = function () {
  self.postMessage({
    kind: 'dedicated',
    rtc: typeof RTCPeerConnection,
    rtpSender: typeof RTCRtpSender,
    rtpReceiver: typeof RTCRtpReceiver,
    ua: (typeof navigator !== 'undefined' ? navigator.userAgent : null),
    hasNavigator: typeof navigator !== 'undefined'
  });
};
`

const SW_JS = `
self.onconnect = function (ev) {
  var port = ev.ports[0];
  port.postMessage({
    kind: 'shared',
    rtc: typeof RTCPeerConnection,
    rtpSender: typeof RTCRtpSender,
    rtpReceiver: typeof RTCRtpReceiver,
    ua: (typeof navigator !== 'undefined' ? navigator.userAgent : null),
    hasNavigator: typeof navigator !== 'undefined'
  });
};
`

/* ────────────────────────────── 收集 ────────────────────────────── */

const out = {
  at: null,
  targets: { created: [], getTargets: [] },
  attachedToTarget: [],
  /** 事件到达时刻（ms，自探针起跑算）与各检查点时刻。**顺序**是这份读数的关键：
   *  「autoAttach 覆盖了 shared_worker」和「resume 循环时它已经在表里」是两件事，
   *  不带时刻的读数分不出后者，会把「晚到」误读成「没到」。 */
  events: [],
  marks: [],
  manualAttach: null,
  /** 手动 attach 前/后的快照。分界点是「谁引起的这条 attachedToTarget」 */
  beforeManualAttach: null,
  afterManualAttach: null,
  /** autoAttach 给过的 session：type → sessionId。留档是为了让「哪一格没测」可判 */
  autoSessionIds: {},
  /** 等 shared_worker 的 session 出现等了多久（-1 = 等到超时也没出现） */
  sharedSessionWaitMs: null,
  evaluate: {
    dedicated: null,
    sharedAuto: null,
    /** autoAttach session 上的原始回包。`sharedAuto=null` 有两种可能（没测 / 测了但回包空），
     *  只留 null 分不清，必须把回包和「有没有真的发出去」一起留档。 */
    sharedAutoRaw: null,
    sharedAutoTried: false,
    shared: null
  },
  pageReadings: null,
  failures: []
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const T0 = Date.now()
const mark = (label) => out.marks.push({ t: Date.now() - T0, label })

/** 轮询等某个条件成立。返回等待毫秒数；超时返回 -1。
 *  用它替代固定 sleep：固定 sleep 是「猜它什么时候到」，猜短了就会把
 *  「还没到」写成「没来」—— 上一版就是这么把 shared_worker 的 session 漏掉的。 */
async function waitFor(pred, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return Date.now() - start
    await sleep(50)
  }
  return -1
}

/** 事件按到达顺序记下来：`attachedToTarget` 有没有为 shared_worker 触发，就是看这张表 */
const events = []
/** targetId → type，供 attach 之后回头对类型 */
const typeById = new Map()
/** 已从 autoAttach 拿到的 session：type → sessionId */
const autoSessions = new Map()

let server = null
let base = ''

function startServer() {
  return new Promise((done) => {
    server = createServer((req, res) => {
      const url = (req.url || '/').split('?')[0]
      const body = url === '/dw.js' ? DW_JS : url === '/sw.js' ? SW_JS : PAGE_HTML
      const type = url.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8'
      res.writeHead(200, {
        'content-type': type,
        // SharedWorker 需要同源；不加 CORS 头，确保只有本页能连
        'cache-control': 'no-store'
      })
      res.end(body)
    })
    server.listen(0, '127.0.0.1', () => {
      base = 'http://127.0.0.1:' + String(server.address().port)
      done()
    })
  })
}

app.whenReady().then(async () => {
  try {
    await startServer()
    const win = new BrowserWindow({ show: false, width: 900, height: 600 })
    const wc = win.webContents
    wc.debugger.attach('1.3')

    const send = (method, params, sessionId) =>
      sessionId === undefined
        ? wc.debugger.sendCommand(method, params ?? {})
        : wc.debugger.sendCommand(method, params ?? {}, sessionId)

    wc.debugger.on('message', (_event, method, params, sessionId) => {
      if (method === 'Target.targetCreated') {
        const info = params.targetInfo ?? {}
        typeById.set(info.targetId, info.type)
        events.push({ method, type: info.type, targetId: info.targetId, url: info.url })
        out.targets.created.push({
          type: info.type,
          url: info.url,
          attached: info.attached === true
        })
      } else if (method === 'Target.attachedToTarget') {
        const info = params.targetInfo ?? {}
        typeById.set(info.targetId, info.type)
        events.push({ method, type: info.type, sessionId: params.sessionId, waiting: params.waitingForDebugger })
        out.events.push({
          t: Date.now() - T0,
          method,
          type: info.type,
          sessionId: typeof params.sessionId === 'string' ? params.sessionId : null,
          waiting: params.waitingForDebugger === true
        })
        out.attachedToTarget.push({
          type: info.type,
          url: info.url,
          sessionId: params.sessionId,
          waitingForDebugger: params.waitingForDebugger === true
        })
        if (typeof params.sessionId === 'string' && params.sessionId !== '') {
          autoSessions.set(info.type, params.sessionId)
        }
      } else if (method === 'Target.targetDestroyed') {
        events.push({ method, targetId: params.targetId })
      } else if (method === 'Target.detachedFromTarget') {
        events.push({ method, sessionId: params.sessionId })
      }
    })

    // 先发现、再自动附着，顺序反了会漏掉第一个 target
    await send('Target.setDiscoverTargets', { discover: true })
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    mark('setAutoAttach 完成')

    await wc.loadURL(base + '/')
    // worker 的 spawn 是异步的，给它足够时间把两个 target 都建出来
    await sleep(2500)
    mark('loadURL + 2500ms')

    /* autoAttach 挂住 worker 时页面会卡住（这是设计），必须放行。
     * 这里逐条 resume —— 同时也是「autoAttach 真的挂住了」的证据。 */
    out.marks.push({ t: Date.now() - T0, label: 'resume 循环开始', sessions: Object.fromEntries(autoSessions) })
    for (const [type, sessionId] of autoSessions) {
      try {
        await send('Runtime.runIfWaitingForDebugger', {}, sessionId)
      } catch (err) {
        out.failures.push(`resume ${type} 失败：${String((err && err.message) || err)}`)
      }
    }
    await sleep(600)

    /* ── 1. Target.getTargets 全量 ── */
    try {
      const res = await send('Target.getTargets')
      out.targets.getTargets = (res.targetInfos ?? []).map((t) => ({
        type: t.type,
        url: t.url,
        attached: t.attached === true
      }))
    } catch (err) {
      out.failures.push('Target.getTargets 失败：' + String((err && err.message) || err))
    }

    /* ── 2. dedicated worker：autoAttach 拿到的 session 里求值（对照组） ── */
    const dwSession = autoSessions.get('worker')
    if (dwSession) {
      try {
        const r = await send(
          'Runtime.evaluate',
          {
            expression:
              'JSON.stringify({rtc: typeof RTCPeerConnection, sender: typeof RTCRtpSender, receiver: typeof RTCRtpReceiver, ua: typeof navigator !== "undefined" ? navigator.userAgent : null})',
            returnByValue: true
          },
          dwSession
        )
        out.evaluate.dedicated = r.result ? r.result.value : null
      } catch (err) {
        out.failures.push('dedicated worker 求值失败：' + String((err && err.message) || err))
      }
    } else {
      out.failures.push('autoAttach 没有为 dedicated worker 触发 —— 探针前提不成立，后面的 shared 读数不可信')
    }

    /* ── 2b. shared_worker：autoAttach 给的 session 能不能用？ ──
     *
     * 这一格决定「事后注入」可不可行：如果 auto session 能 evaluate，
     * 那即便它没被暂停（注入赶不上顶层），至少还能在事后把接口补上。
     * 如果连 evaluate 都不行，那 shared_worker 就是彻底不可达。 */
    const swAuto = autoSessions.get('shared_worker')
    if (swAuto === undefined) {
      /* 上一版这里是固定 sleep 之后直接读 Map，读到了 undefined，
       * 于是把「shared_worker 没 session」写进了 artifact —— 而同一份 artifact 的
       * attachedToTarget 里明明有它的 sessionId。真因是**事件晚到**，不是没到。
       * 现在改成等到它出现（最多 8s），并把等了多久记下来。 */
      out.sharedSessionWaitMs = await waitFor(() => autoSessions.has('shared_worker'), 8000)
      mark('等 shared_worker session 结束（' + String(out.sharedSessionWaitMs) + 'ms）')
    } else {
      out.sharedSessionWaitMs = 0
    }
    out.autoSessionIds = Object.fromEntries(autoSessions)
    const swAutoNow = autoSessions.get('shared_worker')
    /* 晚到的 target 如果恰好处于暂停态，resume 循环已经过去了，必须补一次，
     * 否则 worker 会一直挂着（这正是 service_worker 上踩过的坑）。 */
    const swWaiting = out.events.some(
      (e) => e.method === 'Target.attachedToTarget' && e.type === 'shared_worker' && e.waiting === true
    )
    if (swAutoNow !== undefined && swWaiting) {
      try {
        await send('Runtime.runIfWaitingForDebugger', {}, swAutoNow)
        mark('补 resume 晚到的 shared_worker')
      } catch (err) {
        out.failures.push('补 resume shared_worker 失败：' + String((err && err.message) || err))
      }
    }
    if (swAutoNow !== undefined) {
      out.evaluate.sharedAutoTried = true
      try {
        const r = await send(
          'Runtime.evaluate',
          {
            expression:
              'JSON.stringify({rtc: typeof RTCPeerConnection, ua: typeof navigator !== "undefined" ? navigator.userAgent : null})',
            returnByValue: true
          },
          swAutoNow
        )
        out.evaluate.sharedAutoRaw = JSON.stringify(r ?? null)
        out.evaluate.sharedAuto = r && r.result ? r.result.value : null
      } catch (err) {
        out.evaluate.sharedAuto = 'ERROR: ' + String((err && err.message) || err)
      }
    }

    /* ── 3. shared_worker：手动 attachToTarget ──
     *
     * 动手之前先给 `attachedToTarget` 拍一张快照。这一步是这份探针的命门：
     * `out.attachedToTarget` 是**活的**，后面手动 attach 也会往里追加一条，
     * 于是「手动 attach 之后才出现的那条」会被当成「autoAttach 覆盖了它」。
     * 上一版就是这么读错的 —— 快照把「谁引起的」钉死。 */
    out.beforeManualAttach = {
      t: Date.now() - T0,
      attachedToTarget: out.attachedToTarget.map((x) => ({ ...x })),
      sessionIds: Object.fromEntries(autoSessions)
    }
    mark('手动 attach 之前的快照')

    const swTarget = out.targets.getTargets.find((t) => t.type === 'shared_worker')
    if (swTarget === undefined) {
      out.manualAttach = { found: false }
    } else {
      const targetId = [...typeById.entries()].find(([, t]) => t === 'shared_worker')
      try {
        const res = await send('Target.attachToTarget', { targetId: targetId[0], flatten: true })
        const sid = res.sessionId
        out.manualAttach = { found: true, targetId: targetId[0], sessionId: sid, attached: true }
        // 手动 attach 的 target 也可能处于暂停态
        try {
          await send('Runtime.runIfWaitingForDebugger', {}, sid)
        } catch {
          /* 没暂停就忽略 */
        }
        const r = await send(
          'Runtime.evaluate',
          {
            expression:
              'JSON.stringify({rtc: typeof RTCPeerConnection, sender: typeof RTCRtpSender, receiver: typeof RTCRtpReceiver, ua: typeof navigator !== "undefined" ? navigator.userAgent : null})',
            returnByValue: true
          },
          sid
        )
        out.evaluate.shared = r.result ? r.result.value : null
      } catch (err) {
        out.manualAttach = {
          found: true,
          attached: false,
          error: String((err && err.message) || err)
        }
      }
    }

    /* ── 4. 页面里两个 worker 自己报回来的读数（不经过 CDP） ── */
    try {
      out.pageReadings = await wc.executeJavaScript('JSON.stringify(window.__probe)')
    } catch (err) {
      out.failures.push('页面读数取不到：' + String((err && err.message) || err))
    }

    /* 手动 attach 之后的样子，用来和 beforeManualAttach 对比 */
    out.afterManualAttach = {
      t: Date.now() - T0,
      attachedToTarget: out.attachedToTarget.map((x) => ({ ...x })),
      sessionIds: Object.fromEntries(autoSessions)
    }
    mark('手动 attach 之后的快照')

    wc.debugger.detach()
    win.destroy()
  } catch (err) {
    out.failures.push('脚本自身异常：' + String((err && err.message) || err))
  } finally {
    try {
      if (server !== null) server.close()
    } catch {
      /* ignore */
    }
    out.at = new Date().toISOString()
    mkdirSync(ART, { recursive: true })
    writeFileSync(resolve(ART, 'probe-shared-worker.json'), JSON.stringify(out, null, 2), 'utf8')
    printReport()
    process.exit(out.failures.length > 0 ? 2 : 0)
  }
})

/* ────────────────────────────── 打印 ────────────────────────────── */

function printReport() {
  const count = (arr, type) => arr.filter((x) => x.type === type).length

  console.log('\n===== shared_worker 覆盖 + Worker 内 WebRTC 存在性 =====\n')

  console.log('[1] Target.targetCreated 收到的事件')
  const types = [...new Set(out.targets.created.map((t) => t.type))]
  for (const t of types) console.log('      ' + String(t).padEnd(16) + count(out.targets.created, t) + ' 个')
  console.log('      shared_worker 出现过吗 = ' + String(types.includes('shared_worker')))

  console.log('[2] Target.attachedToTarget —— 按「手动 attach 之前/之后」分开数')
  const before = out.beforeManualAttach === null ? [] : out.beforeManualAttach.attachedToTarget
  const after = out.afterManualAttach === null ? [] : out.afterManualAttach.attachedToTarget
  const bt = [...new Set(before.map((x) => x.type))]
  const at = [...new Set(after.map((x) => x.type))]
  console.log('      手动 attach 之前：' + (bt.length === 0 ? '（空）' : bt.join(', ')))
  for (const t of bt) {
    const rows = before.filter((x) => x.type === t)
    console.log('          ' + String(t).padEnd(14) + rows.length + ' 个，waitingForDebugger=' + String(rows[0].waitingForDebugger))
  }
  console.log('      手动 attach 之后：' + (at.length === 0 ? '（空）' : at.join(', ')))
  for (const t of at) {
    if (bt.includes(t)) continue
    const rows = after.filter((x) => x.type === t)
    console.log('          ' + String(t).padEnd(14) + rows.length + ' 个（新增），waitingForDebugger=' + String(rows[0].waitingForDebugger))
  }
  console.log(
    '      结论：shared_worker 是否被 setAutoAttach 覆盖 = ' + String(bt.includes('shared_worker'))
  )

  console.log('\n[2b] 时序（ms，自起跑算）—— 「晚到」和「没到」必须分得开')
  for (const m of out.marks) console.log('      ' + String(m.t).padStart(6) + '  ' + m.label)
  console.log(
    '      shared_worker session 等了 ' +
      (out.sharedSessionWaitMs === -1 ? '超时也没出现' : String(out.sharedSessionWaitMs) + 'ms')
  )

  console.log('\n[3] Target.getTargets（根 session 视角）')
  for (const t of out.targets.getTargets) {
    console.log('      ' + String(t.type).padEnd(16) + 'attached=' + String(t.attached) + '  ' + String(t.url).slice(0, 60))
  }

  console.log('\n[4] 手动 Target.attachToTarget(shared_worker)')
  if (out.manualAttach === null) {
    console.log('      没有 shared_worker target，跳过')
  } else if (out.manualAttach.found === false) {
    console.log('      getTargets 里找不到 shared_worker —— 连 target 都没暴露')
  } else if (out.manualAttach.attached === false) {
    console.log('      失败：' + String(out.manualAttach.error))
  } else {
    console.log('      成功：sessionId=' + String(out.manualAttach.sessionId).slice(0, 16) + '…')
  }

  console.log('\n[5] 各上下文里的 WebRTC 接口')
  console.log('      dedicated worker（autoAttach）  ' + String(out.evaluate.dedicated))
  console.log('      shared worker（autoAttach）     ' + String(out.evaluate.sharedAuto))
  if (!out.evaluate.sharedAutoTried) {
    console.log('                                      ↑ 没发出去：autoAttach 没给 shared_worker 的 session')
  } else if (out.evaluate.sharedAuto === null) {
    console.log('                                      ↑ 发出去了但回包没有 result，原始回包：' + String(out.evaluate.sharedAutoRaw))
  }
  console.log('      shared worker（手动 attach）    ' + String(out.evaluate.shared))
  console.log('      页面自己报回来的                ' + String(out.pageReadings))

  if (out.failures.length > 0) {
    console.log('\n探针自身的问题：')
    for (const f of out.failures) console.log('  ✗ ' + f)
  }
  console.log('\n完整读数：artifacts/probe-shared-worker.json')
}
