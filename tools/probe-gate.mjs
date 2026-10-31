/**
 * 风险闸门行为验证（A14）。
 *
 * 为什么需要这个：`structure.test.ts` 只能断言「源码里出现过 assessRisk」，
 * 那是**形状**，不是**行为**。一个把 `assessRisk` 结果丢进 `void` 的调用点
 * 同样能让形状断言变绿。
 *
 * 这里直接调 `executeAction`，用一个「一碰就抛」的假 CDP 当探针：
 * 闸门拦下的动作**根本走不到 CDP**，所以「抛的是不是 ApprovalRequiredError」
 * 就能干净地区分「被闸门拦了」和「放过去撞上了假 CDP」。
 *
 * 用法：node tools/probe-gate.mjs
 * 退出码非 0 表示闸门失效。
 */

import { createServer } from 'vite'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  resolve: {
    alias: {
      '@shared': resolve(root, 'src/shared'),
      '@main': resolve(root, 'src/main'),
      electron: resolve(root, 'tools/stub-electron.mjs')
    }
  }
})

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
    }
  ],
  capturedAt: Date.now(),
  truncated: false
}

const click = { type: 'click', id: 'e1' }
const payClick = { type: 'click', id: 'e2' }

/**
 * @returns {'blocked'|'passed'} blocked = 抛了 ApprovalRequiredError
 */
async function probe(executeAction, ApprovalRequiredError, approval, action = click) {
  try {
    await executeAction(stubCdp, action, snapshot, approval)
    return 'passed'
  } catch (err) {
    if (err instanceof ApprovalRequiredError) return 'blocked'
    // 撞上假 CDP 说明闸门放行了 —— 对「应放行」的用例是预期结果
    if (String(err?.message ?? err).includes('STUB_CDP_TOUCHED')) return 'passed'
    if (String(err?.message ?? err).includes('执行失败')) return 'passed'
    throw err
  }
}

const cases = [
  {
    name: 'L2 + 无授权 → 拦下',
    approval: { approvedBy: 'none', extra: '立即支付' },
    want: 'blocked'
  },
  {
    name: 'L2 + user 授权 → 放行',
    approval: { approvedBy: 'user', extra: '立即支付' },
    want: 'passed'
  },
  {
    name: 'L2 + api 授权 → 放行',
    approval: { approvedBy: 'api', extra: '立即支付' },
    want: 'passed'
  },
  {
    // 注意不能用「提交」当例子：submit 在空意图下**本来就是 L2**，
    // 无授权就该拦。要验「L1 不被误拦」得挑一个不命中任何规则的标签。
    name: 'L1（无不可逆语义）+ 无授权 → 放行',
    approval: { approvedBy: 'none', extra: '下一页' },
    want: 'passed'
  },
  {
    // 调用方不传 extra，只给 action.id —— 本地 HTTP API 就是这种形状。
    // 执行器必须自己从快照取元素名，否则这条路径上的闸门等于没接。
    name: '元素名只来自快照 + 无授权 → 拦下',
    approval: { approvedBy: 'none' },
    action: payClick,
    want: 'blocked'
  },
  {
    name: 'L2 + 只读意图降级 + 无授权 → 放行',
    approval: { approvedBy: 'none', extra: '提交', intent: '采集这个页面的数据' },
    want: 'passed'
  },
  {
    name: 'L2（支付）+ 只读意图 + 无授权 → 拦下',
    approval: { approvedBy: 'none', extra: '立即支付', intent: '采集这个页面的数据' },
    want: 'blocked'
  },
  {
    // 「别做任何操作」比「不要点击」否定得更彻底，却被判得更松 —— 这是缺陷
    name: 'L2 + 否定式只读意图 + 无授权 → 拦下',
    approval: { approvedBy: 'none', extra: '提交', intent: '帮我看看这个页面，别做任何操作' },
    want: 'blocked'
  }
]

// 零条用例不能说成「行为正常」：那和「8 条全过」在终端里长得一样，
// 但一条都没跑的时候什么都没验证。同 verify-anticheat 里的 0/0 守卫。
if (cases.length === 0) {
  console.error('没有任何闸门用例 —— 这不是通过，是没验')
  process.exit(1)
}

let failed = 0
try {
  const actions = await server.ssrLoadModule('/src/main/agent/actions.ts')
  for (const c of cases) {
    const got = await probe(
      actions.executeAction,
      actions.ApprovalRequiredError,
      c.approval,
      c.action ?? click
    )
    const ok = got === c.want
    if (!ok) failed += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name} → ${got}（期望 ${c.want}）`)
  }
} finally {
  await server.close()
}

if (failed > 0) {
  console.error(`\n${failed} 条闸门用例未通过`)
  process.exit(1)
}
console.log('\n风险闸门行为正常')
