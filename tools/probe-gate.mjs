/**
 * 风险闸门行为验证（A14 + 同意凭证）。
 *
 * 为什么需要这个：`structure.test.ts` 只能断言「源码里出现过 assessRisk」，
 * 那是**形状**，不是**行为**。一个把 `assessRisk` 结果丢进 `void` 的调用点
 * 同样能让形状断言变绿。
 *
 * 这里直接调 `executeAction`，用一个「一碰就抛」的假 CDP 当探针：
 * 闸门拦下的动作**根本走不到 CDP**，所以「抛的是不是 ApprovalRequiredError」
 * 就能干净地区分「被闸门拦了」和「放过去撞上了假 CDP」。
 *
 * ── 契约变了一次，用例跟着改 ──────────────────────────────
 * 旧契约是「调用方声明 `approvedBy: 'user' | 'api'` 就放行」。那正是漏洞本身：
 * 被 XSS 的渲染层只要发一条 `ss:agent:confirm(true)`、或者 POST 一个
 * `{"confirm":true}`，就等于用户点了同意。旧用例里有两条（`user 授权 → 放行`
 * `api 授权 → 放行`）**测的正是这个漏洞**，它们现在必须红 —— 所以被换成了
 * 「伪造 ticket → 拦下」。
 *
 * 新契约：授权只能来自 `requestConsent` 铸出的一张一次性凭证，而它只有一个来源 ——
 * 主进程弹出的系统原生对话框。探针里的对话框由 `tools/stub-electron.mjs` 提供
 * （vite 把 `electron` 别名指过去），所以这里**不需要任何测试后门**：
 * 生产代码里没有「测试模式跳过确认」的分支，探针只是把 OS 窗口换成了一个假窗口。
 *
 * 用法：node tools/probe-gate.mjs
 * 退出码非 0 表示闸门失效。
 */

import { createServer } from 'vite'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/** 每次「弹窗」的参数会记在这里，用来断言默认按钮是取消 */
globalThis.__SS_STUB_DIALOG_LOG__ = []

async function loadModules() {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    // 两个实例（默认 TTL / 缩短 TTL）会各起一套内部服务，
    // 关掉 watch 与 ws 免得第二个实例撞上第一个的端口，刷一行无关的报错
    server: { middlewareMode: true, hmr: false, watch: null, ws: false },
    appType: 'custom',
    // 这个探针只加载主进程的两个模块，不做浏览器侧打包；
    // 关掉依赖预扫描，免得 vite 去解析渲染层的 @renderer/* 别名并刷一屏「找不到依赖」
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: {
      alias: {
        '@shared': resolve(root, 'src/shared'),
        '@main': resolve(root, 'src/main'),
        '@renderer': resolve(root, 'src/renderer'),
        electron: resolve(root, 'tools/stub-electron.mjs')
      }
    }
  })
  const consent = await server.ssrLoadModule('/src/main/agent/consent.ts')
  const actions = await server.ssrLoadModule('/src/main/agent/actions.ts')
  // 这个探针验的是「风险闸门 + 票据」，不是「伪装闸门」——两者是两道独立的门。
  // 伪装状态默认按 ok 注入，否则每一条 L2 用例都会先撞上伪装闸门，
  // 这里就变成了「只测了伪装闸门，风险闸门一条都没走到」。
  // 伪装闸门自己那两格在下面单独列（会临时替换这个读数）。
  actions.setMaskStateLookup(() => ({
    webContentsId: 1,
    profileId: 'prf_probe',
    state: 'ok',
    failed: [],
    at: Date.now()
  }))
  return { server, consent, actions }
}

/** 任何一次 send 都抛：用来证明「执行器真的往下走了」而不是「被闸门拦了」 */
const stubCdp = {
  send: async () => {
    throw new Error('STUB_CDP_TOUCHED')
  },
  on: () => undefined,
  once: () => undefined,
  off: () => undefined
}

const snapshot = {
  url: 'https://example.com/',
  title: 'probe',
  viewport: { width: 1280, height: 800 },
  scroll: { y: 0, maxY: 0 },
  text: '',
  elements: [
    {
      id: 'e1',
      tag: 'a',
      role: 'link',
      name: '下一页',
      disabled: false,
      inViewport: true,
      box: { x: 0, y: 0, w: 10, h: 10 }
    },
    {
      // 名字本身带不可逆语义，调用方**不需要**把它传进来 —— 执行器自己从快照取。
      // 本地 HTTP API 只有 action.id，拿不到元素名，靠的就是这条。
      id: 'e2',
      tag: 'button',
      role: 'button',
      name: '立即支付',
      disabled: false,
      inViewport: true,
      box: { x: 0, y: 0, w: 10, h: 10 }
    },
    {
      id: 'e3',
      tag: 'button',
      role: 'button',
      name: '删除全部',
      disabled: false,
      inViewport: true,
      box: { x: 0, y: 0, w: 10, h: 10 }
    }
  ],
  capturedAt: Date.now(),
  truncated: false
}

const click = { type: 'click', id: 'e1' }
const payClick = { type: 'click', id: 'e2' }
const deleteClick = { type: 'click', id: 'e3' }

/** 伪造一张「看起来对」的票：64 hex，长度与真票一致 */
function fakeTicket() {
  return randomBytes(32).toString('hex')
}

/**
 * @returns {'blocked'|'mask-blocked'|'passed'}
 *   blocked      = 抛了 ApprovalRequiredError（风险闸门：补一次确认就能过）
 *   mask-blocked = 抛了 MaskIncompleteError（伪装闸门：补确认也没用，要等伪装装上）
 * 两者分开报，否则「闸门拦下了」这句话会把两种完全不同的补救动作混成一种。
 */
async function probe(actions, approval, action = click) {
  try {
    await actions.executeAction(stubCdp, action, snapshot, approval)
    return 'passed'
  } catch (err) {
    if (err instanceof actions.ApprovalRequiredError) return 'blocked'
    if (err instanceof actions.MaskIncompleteError) return 'mask-blocked'
    // 撞上假 CDP 说明闸门放行了 —— 对「应放行」的用例是预期结果
    if (String(err?.message ?? err).includes('STUB_CDP_TOUCHED')) return 'passed'
    if (String(err?.message ?? err).includes('执行失败')) return 'passed'
    throw err
  }
}

/** 走真实入口要票：requestConsent → （假）系统窗口 → ticket */
async function mint(consent, action, senderId) {
  const outcome = await consent.requestConsent(
    {
      action,
      level: 'L2',
      reason: '探针：这一步会发起支付并产生扣款',
      matched: '支付',
      target: '点击「立即支付」',
      origin: 'loop'
    },
    senderId
  )
  return outcome.kind === 'granted' ? outcome.ticket : null
}

const origin = 'agent'

function buildCases(mods) {
  const { consent, actions } = mods
  const run = (approval, action = payClick) => probe(actions, approval, action)

  return [
    {
      // 伪装闸门：脚本已下发但没有任何回读 → 不可逆动作不执行。
      // 这条和「风险闸门拦下」必须分开报：补确认对这条无效。
      name: 'L2 + 伪装未测量（unknown）+ 有效 ticket → 拦下',
      want: 'mask-blocked',
      run: async () => {
        actions.setMaskStateLookup(() => ({
          webContentsId: 1,
          profileId: 'prf_probe',
          state: 'unknown',
          failed: [],
          at: Date.now()
        }))
        try {
          return await run({ ticket: await mint(consent, payClick), origin })
        } finally {
          actions.setMaskStateLookup(() => ({
            webContentsId: 1,
            profileId: 'prf_probe',
            state: 'ok',
            failed: [],
            at: Date.now()
          }))
        }
      }
    },
    {
      // page 侧不完整 → 拦；worker 侧不完整 → 不拦（另有一格，见 mask-gate 的单测）。
      name: 'L2 + 伪装 page 侧不完整 + 有效 ticket → 拦下',
      want: 'mask-blocked',
      run: async () => {
        actions.setMaskStateLookup(() => ({
          webContentsId: 1,
          profileId: 'prf_probe',
          state: 'degraded',
          failed: [{ attr: 'webgl', reason: 'Illegal invocation', source: 'page' }],
          at: Date.now()
        }))
        try {
          return await run({ ticket: await mint(consent, payClick), origin })
        } finally {
          actions.setMaskStateLookup(() => ({
            webContentsId: 1,
            profileId: 'prf_probe',
            state: 'ok',
            failed: [],
            at: Date.now()
          }))
        }
      }
    },
    {
      // 查不到状态（窗口已销毁 / 这条路径没有 sender）也拦：
      // 「没测量」不是「没问题」。
      name: 'L2 + 伪装状态查不到 + 有效 ticket → 拦下',
      want: 'mask-blocked',
      run: async () => {
        actions.setMaskStateLookup(() => null)
        try {
          return await run({ ticket: await mint(consent, payClick), origin })
        } finally {
          actions.setMaskStateLookup(() => ({
            webContentsId: 1,
            profileId: 'prf_probe',
            state: 'ok',
            failed: [],
            at: Date.now()
          }))
        }
      }
    },
    {
      name: 'L2 + 无 ticket → 拦下',
      want: 'blocked',
      run: () => run({ origin })
    },
    {
      // 这是整轮修复的根因回归：旧契约里调用方写一句 `approvedBy: 'user'`
      // 就能过闸门，而那正是三条旁路共同的前提。
      name: 'L2 + 调用方自称 approvedBy:"user"（旧契约）→ 拦下',
      want: 'blocked',
      run: () => run({ origin, approvedBy: 'user' })
    },
    {
      name: 'L2 + 调用方自称 approvedBy:"api"（旧契约）→ 拦下',
      want: 'blocked',
      run: () => run({ origin, approvedBy: 'api' })
    },
    {
      name: 'L2 + 伪造 ticket（随机 64 hex）→ 拦下',
      want: 'blocked',
      run: () => run({ ticket: fakeTicket(), origin })
    },
    {
      name: 'L2 + 有效 ticket → 放行',
      want: 'passed',
      run: async () => run({ ticket: await mint(consent, payClick), origin })
    },
    {
      // 用户批准的是「点击立即支付」，这张票不能拿去删库
      name: 'L2 + 有效 ticket 但换一个动作（摘要不匹配）→ 拦下',
      want: 'blocked',
      run: async () => run({ ticket: await mint(consent, payClick), origin }, deleteClick)
    },
    {
      name: 'L2 + 有效 ticket 重复使用（第二次）→ 拦下',
      want: 'blocked',
      run: async () => {
        const ticket = await mint(consent, payClick)
        const first = await run({ ticket, origin })
        if (first !== 'passed') return `第一次就${first}`
        return run({ ticket, origin })
      }
    },
    {
      name: 'L1（无不可逆语义）+ 无 ticket → 放行',
      want: 'passed',
      run: () => run({ origin }, click)
    },
    {
      // L1 不该因为「票是假的」被拦：L1 根本不看票
      name: 'L1 + 伪造 ticket → 仍然放行（L1 不看票）',
      want: 'passed',
      run: () => run({ ticket: fakeTicket(), origin }, click)
    },
    {
      name: 'L2 + 有效 ticket 但 senderId 不匹配 → 拦下',
      want: 'blocked',
      run: async () => run({ ticket: await mint(consent, payClick, 7), origin, senderId: 9 })
    },
    {
      name: 'L2 + 有效 ticket 且 senderId 一致 → 放行',
      want: 'passed',
      run: async () => run({ ticket: await mint(consent, payClick, 7), origin, senderId: 7 })
    },
    {
      // 元素名只来自快照：本地 HTTP API 手里只有 action.id
      name: '元素名只来自快照 + 无 ticket → 拦下',
      want: 'blocked',
      run: () => run({ origin })
    },
    {
      name: 'L2 + 只读意图降级 + 无 ticket → 放行',
      want: 'passed',
      run: () => run({ origin, note: '提交', intent: '采集这个页面的数据' }, click)
    },
    {
      // 「别做任何操作」比「不要点击」否定得更彻底，却被判得更松 —— 这是缺陷
      name: 'L2 + 否定式只读意图 + 无 ticket → 拦下',
      want: 'blocked',
      run: () => run({ origin, note: '提交', intent: '帮我看看这个页面，别做任何操作' }, click)
    },
    {
      name: '用户在系统窗口点「取消」→ 拿不到票，L2 被拦',
      want: 'blocked',
      run: async () => {
        process.env.SS_STUB_DIALOG_RESPONSE = '0'
        try {
          const ticket = await mint(consent, payClick)
          if (ticket !== null) return '取消后仍然铸出了票'
          return await run({ origin })
        } finally {
          process.env.SS_STUB_DIALOG_RESPONSE = '1'
        }
      }
    },
    {
      name: '对话框默认按钮是「取消」且按钮文案正确',
      want: 'ok',
      run: () => {
        const last = globalThis.__SS_STUB_DIALOG_LOG__.at(-1)
        if (!last) return '没有记录到任何对话框'
        const problems = []
        if (last.type !== 'warning') problems.push(`type=${last.type}`)
        if (last.defaultId !== 0) problems.push(`defaultId=${last.defaultId}`)
        if (last.cancelId !== 0) problems.push(`cancelId=${last.cancelId}`)
        if (last.noLink !== true) problems.push(`noLink=${last.noLink}`)
        if (JSON.stringify(last.buttons) !== JSON.stringify(['取消', '允许执行'])) {
          problems.push(`buttons=${JSON.stringify(last.buttons)}`)
        }
        return problems.length === 0 ? 'ok' : problems.join(' ')
      }
    }
  ]
}

// 零条用例不能说成「行为正常」：那和「全过」在终端里长得一样，
// 但一条都没跑的时候什么都没验证。
const mainMods = await loadModules()
const main = buildCases(mainMods)
if (main.length === 0) {
  await mainMods.server.close()
  console.error('没有任何闸门用例 —— 这不是通过，是没验')
  process.exit(1)
}

let failed = 0
const report = (ok, name, got, want) => {
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} → ${got}（期望 ${want}）`)
}

try {
  for (const c of main) {
    const got = await c.run()
    report(got === c.want, c.name, got, c.want)
  }

  /* ── 过期票：需要一个新的模块实例，TTL 在模块加载时就被固化 ──
     `SS_CONSENT_TTL_MS` 只能**缩短**不能延长（consent.ts 里做了 Math.min），
     所以这个开关不可能被用来放宽闸门，只够让「过期」这件事在毫秒级可测。 */
  process.env.SS_CONSENT_TTL_MS = '40'
  const shortMods = await loadModules()
  try {
    const { consent, actions } = shortMods

    const ticket = await mint(consent, payClick)
    const fresh = await probe(actions, { ticket, origin }, payClick)
    report(fresh === 'passed', 'TTL=40ms 时新票立即使用 → 放行', fresh, 'passed')

    const stale = await mint(consent, payClick)
    await new Promise((r) => setTimeout(r, 80))
    const expired = await probe(actions, { ticket: stale, origin }, payClick)
    report(expired === 'blocked', 'L2 + 过期 ticket → 拦下', expired, 'blocked')

    // 超时之后用户才点「允许」：对话框已经放弃，不能凭空铸出一张票
    process.env.SS_STUB_DIALOG_DELAY_MS = '120'
    const late = await consent.requestConsent(
      {
        action: payClick,
        level: 'L2',
        reason: '探针：超时后点允许',
        target: '点击「立即支付」',
        origin: 'loop'
      },
      undefined
    )
    delete process.env.SS_STUB_DIALOG_DELAY_MS
    report(
      late.kind === 'timeout',
      '对话框在超时后才被点「允许」→ 结果是 timeout 且不铸票',
      late.kind,
      'timeout'
    )
  } finally {
    await shortMods.server.close()
  }
} finally {
  delete process.env.SS_CONSENT_TTL_MS
  await mainMods.server.close()
}

if (failed > 0) {
  console.error(`\n${failed} 条闸门用例未通过`)
  process.exit(1)
}
console.log('\n风险闸门行为正常：授权只能来自系统原生确认窗口')
