/**
 * Worker 注入运行时探针（真 Chromium，不是 mock）。
 *
 * 为什么需要这个：`tools/check-injection.mjs` 只能证明 worker 脚本**能解析**。
 * Worker 环境跟 page 差得很远 —— 没有 `Navigator`（只有 `WorkerNavigator`）、
 * 没有 `document` / `window` / `HTMLCanvasElement`。任何一处写错都是 ReferenceError，
 * 而脚本外层套着 try/catch，于是「一声不响地全部失效」：指纹不伪造、界面一切正常。
 *
 * 更坏的一种：脚本**跑完了但中途有一个属性失败**，整体回滚生效 —— 表现和「没注入」
 * 完全一样。本探针就是为这两种情况准备的：
 *   1. 直接读 Worker 里的实际值，跟 profile 比对（不看页面自报的任何台账）；
 *   2. 覆盖「一行就能查」的形状类断言（getter 的 toString / prototype / 方法 arity）。
 *
 * ── 为什么先 resume 再注入 ──
 * 真实链路（`windows.ts`）要在 worker 跑自己脚本**之前**注入，顺序是
 * `Runtime.evaluate` → `Runtime.runIfWaitingForDebugger`。
 * 但本机 Electron 45 上，对一个**挂起中**的 worker session 做一次 ~12KB 的
 * `Runtime.evaluate` 会让主进程直接死掉（无异常、无 `exit` 钩子、exit code 1）——
 * 是原生层崩溃，不是协议错误。所以本探针只验「脚本在真 Worker 里能不能正确跑」，
 * **不验时序**；时序属于 `cdp.ts` / `windows.ts` 那条链路，要单独验。
 *
 * ── sessionId 怎么传 ──
 * `webContents.debugger.on('message', (e, method, params, sessionId))` 的第 4 个实参
 * 实测是**空字符串**，真正的 sessionId 在 `params.sessionId` 里。
 * 且 flatten 模式下只能用 `sendCommand(method, params, sessionId)` 第三参路由 ——
 * 用 `Target.sendMessageToTarget` 会抛
 * "When using flat protocol, messages are routed to the target via the sessionId attribute"。
 *
 * 用法：
 *   node tools/check-injection.mjs                 # 先产出 artifacts/injection-windows.js
 *   node tools/probe-worker.cjs                    # 再真跑一遍
 * 退出码非 0 表示有断言不成立。
 */

const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { resolve } = require('node:path')

const ROOT = resolve(__dirname, '..')
const ART = resolve(ROOT, 'artifacts')
const PAGE_SRC_FILE = resolve(ART, 'injection-windows.js')
const WORKER_SRC_FILE = resolve(ART, 'injection-worker-windows.js')
const PAGE_FILE = resolve(ART, 'probe-worker-page.html')

/**
 * 探针只从**脚本自身**推导期望值，不另外抄一份 profile。
 *
 * 抄一份必然漂移，而漂移的结果正是「某处静默没被检查」——
 * `probe-mask.cjs` 的 `_MASK_TABLE` 抽取用的是同一个原则。
 */
function extractConfig(src) {
  const m = /var C = (\{[\s\S]*?\});/.exec(src)
  if (!m) { return null }
  try { return JSON.parse(m[1]) } catch { return null }
}

/**
 * `ctl` 是**未注入**的对照 worker 读到的「哪些属性原生存在」。
 *
 * 为什么需要它：`WorkerNavigator` 和 `Navigator` 的属性集**不一样** ——
 * 实测 `vendor` / `webdriver` 在 worker 里原生就不存在。早先的脚本对它们
 * 一律 `defineProperty`，等于**凭空造出两个原生没有的属性** —— 属性**存在性**
 * 是比属性值更硬的指纹（一个本该没有 `webdriver` 的 worker 有了它，比值为 false 更容易判定）。
 *
 * 所以期望值不能写死，必须「原生有的才要求等于 profile，原生没有的必须仍然没有」。
 * 对照 worker 与注入 worker 是同一轮、同一 Electron 实例建的，不存在跨环境差异。
 */
function probes(C, ctl) {
  const has = (n) => ctl.indexOf(n) >= 0
  return [
    { id: 'w-userAgent', want: C.ua, expr: 'self.navigator.userAgent' },
    { id: 'w-platform', want: C.platform, expr: 'self.navigator.platform' },
    { id: 'w-appVersion', want: has('appVersion') ? C.appVersion : undefined, expr: 'self.navigator.appVersion' },
    { id: 'w-vendor', want: has('vendor') ? C.vendor : undefined, expr: 'self.navigator.vendor' },
    { id: 'w-hardwareConcurrency', want: C.cores, expr: 'self.navigator.hardwareConcurrency' },
    { id: 'w-deviceMemory', want: has('deviceMemory') ? C.memory : undefined, expr: 'self.navigator.deviceMemory' },
    { id: 'w-language', want: C.languages[0], expr: 'self.navigator.language' },
    {
      id: 'w-languages',
      want: C.languages,
      expr: 'Array.prototype.slice.call(self.navigator.languages)'
    },
    { id: 'w-webdriver', want: has('webdriver') ? false : undefined, expr: 'self.navigator.webdriver' },
    {
      // getter 的 toString 必须是 "function get x() { [native code] }"。
      // 少一个 "get" 就是裸函数，一行可查。
      id: 'w-getter-toString',
      want: 'function get hardwareConcurrency() { [native code] }',
      expr: 'Object.getOwnPropertyDescriptor(Object.getPrototypeOf(self.navigator), "hardwareConcurrency").get.toString()'
    },
    {
      // 原生 getter 是 concise method，没有 prototype。裸函数有。
      id: 'w-getter-no-prototype',
      want: false,
      expr: '"prototype" in Object.getOwnPropertyDescriptor(Object.getPrototypeOf(self.navigator), "hardwareConcurrency").get'
    },
    {
      // 原生方法的 length 是外部事实，换掉之后必须还原。
      id: 'w-method-arity',
      want: [],
      expr: `(function () {
        var bad = [];
        var pairs = [
          [Date.prototype, 'getTimezoneOffset', 0],
          [Date.prototype, 'toTimeString', 0],
          [Date.prototype, 'getHours', 0]
        ];
        for (var i = 0; i < pairs.length; i++) {
          var d = Object.getOwnPropertyDescriptor(pairs[i][0], pairs[i][1]);
          if (!d || typeof d.value !== 'function') { bad.push(pairs[i][1] + ':missing'); continue; }
          if (d.value.length !== pairs[i][2]) { bad.push(pairs[i][1] + ':' + d.value.length + '!=' + pairs[i][2]); }
        }
        return bad;
      })()`
    },
    {
      // 方法不能是 accessor：`"prototype" in Date.prototype.getHours` 原生为 false，
      // 而且读值（不调用）不该抛错。
      id: 'w-method-shape',
      want: [],
      expr: `(function () {
        var bad = [];
        var names = ['getTimezoneOffset', 'toTimeString', 'toString', 'toLocaleString', 'getHours'];
        for (var i = 0; i < names.length; i++) {
          var d = null;
          try { d = Object.getOwnPropertyDescriptor(Date.prototype, names[i]); } catch (e) { bad.push(names[i] + ':throw'); continue; }
          if (!d) { bad.push(names[i] + ':missing'); continue; }
          if (typeof d.get === 'function') { bad.push(names[i] + ':accessor'); }
          if (typeof d.value !== 'function') { bad.push(names[i] + ':not-function'); continue; }
          if ('prototype' in d.value) { bad.push(names[i] + ':has-prototype'); }
        }
        return bad;
      })()`
    },
    { id: 'w-tz-resolved', want: C.tz, expr: 'new Intl.DateTimeFormat().resolvedOptions().timeZone' },
    {
      // 自洽判据：getHours() 必须等于 Intl 在 profile 时区里报的小时。
      // 不依赖参照值，也不依赖 profile 是哪个 locale —— 偏移反解坏掉时必红。
      id: 'w-tz-consistent',
      want: [],
      expr: `(function () {
        var bad = [];
        var tz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
        var f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit' });
        var pts = [Date.UTC(2024, 0, 15, 20, 0, 0), Date.UTC(2024, 6, 15, 20, 0, 0)];
        for (var i = 0; i < pts.length; i++) {
          var d = new Date(pts[i]);
          var want = parseInt(f.format(d), 10) % 24;
          if (d.getHours() !== want) { bad.push(i + ':' + d.getHours() + '!=' + want); }
        }
        return bad;
      })()`
    },
    {
      id: 'w-intl-ctor-chain',
      want: [],
      expr: `(function () {
        var bad = [], keys = Object.getOwnPropertyNames(Intl);
        for (var i = 0; i < keys.length; i++) {
          var K = null;
          try { K = Intl[keys[i]]; } catch (e) { continue; }
          if (typeof K !== 'function' || typeof K.supportedLocalesOf !== 'function') { continue; }
          if (K.prototype.constructor !== K) { bad.push(keys[i]); }
        }
        return bad;
      })()`
    },
    {
      // Worker 里 OffscreenCanvas + WebGL 可用（[Exposed=(Window,Worker)]），
      // 不接管就是真显卡 —— 跨上下文一对读即可判定。
      id: 'w-webgl-renderer',
      want: C.glRenderer,
      expr: `(function () {
        try {
          if (typeof OffscreenCanvas !== 'function') { return 'no-OffscreenCanvas'; }
          var gl = new OffscreenCanvas(64, 64).getContext('webgl');
          if (!gl) { return 'no-webgl'; }
          var ext = gl.getExtension('WEBGL_debug_renderer_info');
          if (!ext) { return 'no-debug-renderer-info'; }
          return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
        } catch (e) { return '<throw> ' + e.message; }
      })()`
    },
    { id: 'w-webgl-vendor', want: C.glVendor, expr: `(function () {
        try {
          var gl = new OffscreenCanvas(64, 64).getContext('webgl');
          var ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
          return ext ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) : 'no-ext';
        } catch (e) { return '<throw> ' + e.message; }
      })()` },
    // 这两个是「脚本被 page 版顶替」的守卫：Worker 里不该有 document / window。
    { id: 'w-no-document', want: false, expr: '"document" in self' },
    { id: 'w-no-window', want: false, expr: '"window" in self' },
    // 不留任何诊断全局 —— 这条同时也是「脚本没被改回带台账版本」的守卫。
    { id: 'w-no-diag-global', want: 'undefined', expr: 'typeof self.__SS_DIAG__' }
  ]
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  let pageSrc, workerSrc
  try {
    pageSrc = readFileSync(PAGE_SRC_FILE, 'utf8')
  } catch {
    console.error(`读不到 ${PAGE_SRC_FILE}\n先跑：node tools/check-injection.mjs`)
    app.exit(2)
    return
  }
  try {
    workerSrc = readFileSync(WORKER_SRC_FILE, 'utf8')
  } catch {
    console.error(
      `读不到 ${WORKER_SRC_FILE}\n` +
        '这是 worker 注入源。tools/check-injection.mjs 目前只落盘 page 那份，' +
        '需要它同时落盘 `buildInjectionScript(cfg, seed, "worker")`。'
    )
    app.exit(2)
    return
  }

  const C = extractConfig(workerSrc)
  if (!C) {
    console.error('worker 脚本里找不到 `var C = {...};` —— 期望值无从推导，拒绝瞎猜')
    app.exit(2)
    return
  }

  mkdirSync(ART, { recursive: true })
  writeFileSync(
    PAGE_FILE,
    '<!doctype html><html><head><meta charset="utf-8"></head><body>w</body></html>',
    'utf8'
  )
  const pageUrl = 'file:///' + PAGE_FILE.replace(/\\/g, '/')

  const win = new BrowserWindow({ show: false, width: 800, height: 600 })
  const wc = win.webContents
  await wc.loadURL(pageUrl)
  wc.debugger.attach('1.3')
  await wc.debugger.sendCommand('Page.enable')
  await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: pageSrc })
  await wc.loadURL(pageUrl)

  const failures = []
  let rows = 0
  let workerSession = null

  // 每次建 worker 前压一个 resolver，attachedToTarget 来了就配给它。
  // 用队列而不是单个 Promise：本探针要建三个 worker（主用例 / 强制失败 / 属性缺失）。
  const pending = []
  wc.debugger.on('message', async (_e, method, params, sessionArg) => {
    if (method !== 'Target.attachedToTarget') { return }
    const type = params.targetInfo && params.targetInfo.type
    if (type !== 'worker') { return }
    const waiter = pending.shift()
    if (!waiter) { return }
    // 第 4 个实参实测是空字符串，真 sessionId 在 params.sessionId（见文件头）
    const sid = params.sessionId || sessionArg || null
    if (!sid) { waiter.rej(new Error('attachedToTarget 没有带 sessionId')); return }
    try {
      await wc.debugger.sendCommand('Runtime.enable', {}, sid)
      await wc.debugger.sendCommand('Runtime.runIfWaitingForDebugger', {}, sid)
      waiter.res(sid)
    } catch (err) {
      waiter.rej(err)
    }
  })

  /** 在页面里造一个 blob worker，等它被 autoAttach 捕获并 resume，返回 sessionId */
  function makeWorker(wc, tag) {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`30s 内没有 worker target 附着（${tag}）`)), 30000)
      pending.push({
        res: (sid) => { clearTimeout(timer); res(sid) },
        rej: (e) => { clearTimeout(timer); rej(e) }
      })
      evaluate(
        wc,
        `(function () {
          var url = URL.createObjectURL(new Blob(['self.postMessage("up")'], { type: 'text/javascript' }));
          self['__w_${tag}'] = new Worker(url);
          self['__w_${tag}'].onmessage = function () { self['__wmsg_${tag}'] = 'up'; };
          return 'created';
        })()`
      ).then((r) => {
        if (r !== 'created') { rej(new Error('创建 worker 失败（' + tag + '）：' + r)) }
      })
    })
  }

  /** 等 worker 里那个 postMessage 真的到过，说明它已经在跑 */
  async function waitUp(wc, tag) {
    for (let i = 0; i < 50; i++) {
      if ((await evaluate(wc, `self['__wmsg_${tag}'] || ""`)) === 'up') { return true }
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  }

  try {
    await wc.debugger.sendCommand('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true
    })

    // ── 先建一个**不注入**的对照 worker，读原生的属性集 ──
    // 期望值不能写死：WorkerNavigator 和 Navigator 的属性集不同，
    // 写死会让我们把「凭空造属性」当成通过（这正是 `vendor` / `webdriver` 上发生过的）。
    const ctlSession = await makeWorker(wc, 'ctl')
    await waitUp(wc, 'ctl')
    const ctlNames = await evaluateIn(
      wc,
      ctlSession,
      'Object.getOwnPropertyNames(Object.getPrototypeOf(self.navigator))'
    )
    if (!Array.isArray(ctlNames)) {
      throw new Error('对照 worker 读不到原生属性集：' + JSON.stringify(ctlNames))
    }
    console.log(`\n【对照 worker（未注入）】WorkerNavigator 自有属性 ${ctlNames.length} 个`)
    for (const n of ['vendor', 'webdriver', 'deviceMemory', 'appVersion']) {
      console.log(`  原生 ${n.padEnd(14)} ${ctlNames.indexOf(n) >= 0 ? '存在' : '不存在'}`)
    }

    workerSession = await makeWorker(wc, 'main')
    await waitUp(wc, 'main')
    console.log(`\n【worker 脚本级】附着到 target type=worker`)


    const inj = await wc.debugger.sendCommand(
      'Runtime.evaluate',
      { expression: workerSrc, returnByValue: true },
      workerSession
    )
    if (inj && inj.exceptionDetails) {
      const d = inj.exceptionDetails.exception?.description ?? inj.exceptionDetails.text
      throw new Error('worker 注入脚本抛错：' + d)
    }
    console.log(`注入完成（${workerSrc.length} chars）\n`)

    for (const p of probes(C, ctlNames)) {
      const actual = await evaluateIn(wc, workerSession, p.expr)
      const pass = JSON.stringify(actual) === JSON.stringify(p.want)
      console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${p.id.padEnd(24)} ${JSON.stringify(actual)}`)
      rows++
      if (!pass) { failures.push(`${p.id}（期望 ${JSON.stringify(p.want)}）`) }
    }

    // ── 反向自检：强制一个属性失败，验证「不回滚 + 抛错带台账」──
    //
    // 只做「全绿」是不够的：分不清「真的装上了」和「比了但比不出东西」。
    // 这里先把它弄坏，看脚本会不会如实说出来。
    //
    // 做法：换一个新 worker，先把 `hardwareConcurrency` 钉成不可配置，
    // 再注入 —— `defGet` 里的 `defineProperty` 必然抛，进 `_failed`。
    // 期望：抛错且错误串以 `[ss-mask]` 开头、带 `failed=`；
    //       且**其它属性仍然装上**（`navigator.platform` 是伪装值，证明没回滚）。
    console.log('\n【反向自检】钉死 hardwareConcurrency 后注入')
    const bad = await makeWorker(wc, 'bad')
    await waitUp(wc, 'bad')
    const froze = await evaluateIn(
      wc,
      bad,
      `(function () {
         try {
           Object.defineProperty(Object.getPrototypeOf(self.navigator), 'hardwareConcurrency',
             { value: 99, writable: false, enumerable: true, configurable: false });
           return 'frozen';
         } catch (e) { return 'freeze-failed:' + e.message; }
       })()`
    )
    if (froze !== 'frozen') { throw new Error('反向自检前置失败：' + froze) }
    // 这一步**期望**抛错，所以必须单独 catch —— 让 CDP 层的 reject 走通用 catch
    // 会把「预期的失败」记成 `<probe-error>`，看起来像探针自己坏了。
    let badDesc = '<没抛错>'
    try {
      const badInj = await wc.debugger.sendCommand(
        'Runtime.evaluate',
        { expression: workerSrc, returnByValue: true },
        bad
      )
      if (badInj && badInj.exceptionDetails) {
        badDesc =
          badInj.exceptionDetails.exception?.description ?? badInj.exceptionDetails.text
      }
    } catch (e) {
      badDesc = 'CDP-reject: ' + e.message
    }
    const threw = /\[ss-mask\]/.test(badDesc) && /failed=/.test(badDesc)
    console.log(`  ${threw ? 'ok  ' : 'FAIL'} ${'w-forced-fail-throws'.padEnd(24)} ${JSON.stringify(String(badDesc).split('\n')[0])}`)
    rows++
    if (!threw) { failures.push('w-forced-fail-throws（期望抛 [ss-mask] 且带 failed=）') }

    // 不回滚的证据：别的属性仍是伪装值，而不是退回宿主
    const survived = await evaluateIn(wc, bad, 'self.navigator.platform')
    const survivedOk = survived === C.platform
    console.log(`  ${survivedOk ? 'ok  ' : 'FAIL'} ${'w-partial-kept'.padEnd(24)} ${JSON.stringify(survived)}`)
    rows++
    if (!survivedOk) { failures.push('w-partial-kept（期望部分伪装保留，实际 ' + JSON.stringify(survived) + '）') }

    // 跳过（原生不存在）不该被算成失败 —— 删掉一个**原生存在**的属性再注入。
    // 用 `deviceMemory` 而不是 `vendor`：后者原生就不存在，删它是空操作，
    // 断言会退化成「不存在仍然不存在」，测不到「不新建」这条。
    console.log('\n【反向自检】删掉 deviceMemory 后注入（应 skipped 而非 failed）')
    const gone = await makeWorker(wc, 'gone')
    await waitUp(wc, 'gone')
    const deleted = await evaluateIn(
      wc,
      gone,
      `(function () {
         var p = Object.getPrototypeOf(self.navigator);
         var had = 'deviceMemory' in p;
         var ok = delete p.deviceMemory;
         return { had: had, deleted: ok, still: 'deviceMemory' in p };
       })()`
    )
    let goneThrew = false
    try {
      const goneInj = await wc.debugger.sendCommand(
        'Runtime.evaluate',
        { expression: workerSrc, returnByValue: true },
        gone
      )
      goneThrew = Boolean(goneInj && goneInj.exceptionDetails)
    } catch {
      goneThrew = true
    }
    const created = await evaluateIn(wc, gone, `'deviceMemory' in Object.getPrototypeOf(self.navigator)`)
    // 期望：不抛错（跳过不算失败），且属性**没有被凭空造出来**
    const goneOk = !goneThrew && created === false
    console.log(`  ${goneOk ? 'ok  ' : 'FAIL'} ${'w-absent-not-created'.padEnd(24)} ${JSON.stringify({ delete: deleted, threw: goneThrew, created })}`)
    rows++
    if (!goneOk) { failures.push('w-absent-not-created（期望不抛错且不新建属性）') }
  } catch (err) {
    console.error('\n探针失败：' + err.message)
    failures.push('<probe-error>')
  } finally {
    try { wc.debugger.detach() } catch { /* 忽略 */ }
    win.destroy()
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} 条不成立：\n  ` + failures.join('\n  '))
    app.exit(1)
    return
  }
  // 收尾口径必须写死「脚本级」。
  //
  // 本探针**先 resume 再注入**（原因见文件头），所以它证明的是
  // 「worker 变体脚本在真实 DedicatedWorker 里装得上、读得对」，
  // **不证明** `windows.ts` 那条链路能把它装上去 —— 那条链路由
  // `npm run verify:worker`（tools/verify-worker-inject.mjs）单独验：
  // 它让 worker 自己建 OffscreenCanvas GL 上下文并读 37445/37446。
  // 两件事必须分开说，一行「全部成立」会被读成「worker 注入可用」，那是发合格证。
  console.log(
    `\nworker 脚本级 ${rows} 条全部成立（注入链路另见 npm run verify:worker）`
  )
  app.exit(0)
})

async function evaluate(wc, expression) {
  const res = await wc.debugger.sendCommand('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (res.exceptionDetails) {
    const t = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text
    return `<throw> ${t}`
  }
  return res.result.value
}

async function evaluateIn(wc, sessionId, expression) {
  const res = await wc.debugger.sendCommand(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId
  )
  if (res.exceptionDetails) {
    const t = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text
    return `<throw> ${t}`
  }
  return res.result.value
}
