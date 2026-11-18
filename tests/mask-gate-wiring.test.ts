/**
 * 伪装闸门「接线」测试 —— 钉的是**编号空间**，不是判定表本身。
 *
 * 背景（P0）：`Approval.senderId` 是**控制台窗口 renderer** 的 webContents id，
 * 而伪装状态按**标签页**的 webContents 存（`WindowManager.maskStates` 的键是
 * `tab.wc.id`）。两者是完全不同的编号空间，于是门禁每次拿控制台的编号去查
 * 标签页的状态，永远拿到 `null` → `judgeMask(null)` = `{allow:false, kind:'missing'}`
 * → 所有 L2 动作被永久拦下；连「环境级豁免」也救不了（`decideMaskGate` 要求
 * record 非空才能豁免）。界面读的却是 `handle.wc.id`，于是「界面绿、门禁红」。
 *
 * 修法是给 `Approval` 加 `maskWebContentsId`（标签页 wc.id），三条调用路径
 * （handlers 的 agent.run、scripts 的回放、localapi 的 /act）各自传自己那个标签页的
 * wc.id，执行器优先用它查、缺省才回退到 `senderId`。
 *
 * 这个文件钉三件事：
 *   1. `Approval.maskWebContentsId` 存在、是 `number | undefined`，且执行器真的用它查；
 *   2. 三条调用路径都把**标签页的** wc.id 传了下去（不是 senderId、不是忘了传）；
 *   3. 接线方向：同一个 `maskLookup` 里，`tab.wc.id` 查到 `ok` 放行，
 *      控制台 renderer 的 id 查不到 → `missing` → 拦下。
 *
 * `actions.ts` 的判定逻辑本身由 `tests/mask-gate.test.ts` 覆盖，这里不重复。
 *
 * 跑法：node --experimental-strip-types --test tests/mask-gate-wiring.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decideMaskGate, judgeMask } from '../src/main/core/mask-gate.ts'
import type { MaskStateRecord } from '../src/shared/types.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/** 去掉注释再匹配：说明「为什么不能再用 senderId 查伪装」的注释不该被判成违规 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/* ────────────────────── 1. 类型：字段存在且是 number | undefined ────────────────────── */

test('Approval 有 maskWebContentsId?: number', () => {
  const actions = stripComments(read('src/main/agent/actions.ts'))
  const approval = /export type Approval = \{[\s\S]*?\n\}/.exec(actions)
  assert.ok(approval, '找不到 Approval 类型定义')
  const body = approval[0]

  assert.match(
    body,
    /\bmaskWebContentsId\?\s*:\s*number\b/,
    'Approval 缺 `maskWebContentsId?: number`：三条路径没法告诉执行器该查哪个窗口的伪装状态'
  )
})

/* ────────────────────── 2. 执行器：优先 maskWebContentsId，缺省回退 senderId ────────────────────── */

test('执行器用 maskWebContentsId 查伪装状态，缺省才回退 senderId', () => {
  const actions = stripComments(read('src/main/agent/actions.ts'))
  assert.match(
    actions,
    /maskLookup\(\s*approval\.maskWebContentsId\s*\?\?\s*approval\.senderId\s*\)/,
    'actions.ts 没有用 `approval.maskWebContentsId ?? approval.senderId` 查伪装状态：' +
      '只用 senderId 会让 agent 路径永远查到 null（那是控制台窗口的编号）'
  )
  // 反向：不能出现「仍然只查 senderId」的旧写法
  assert.doesNotMatch(
    actions,
    /maskLookup\(\s*approval\.senderId\s*\)/,
    'actions.ts 仍在只查 senderId —— 这正是 P0 的根因'
  )
})

/* ────────────────────── 3. 三条调用路径各自传标签页的 wc.id ────────────────────── */

/** 取 `executeAction(` 调用括号里的那一段参数（700 字符足够，且不会跨到下一个调用） */
function executeActionArgs(text: string): string[] {
  const src = stripComments(text)
  const out: string[] = []
  let from = 0
  for (;;) {
    const at = src.indexOf('executeAction(', from)
    if (at < 0) break
    from = at + 1
    out.push(src.slice(at, at + 700))
  }
  return out
}

test('agent 路径（handlers.ts）把 tab.wc.id 传成 maskWebContentsId', () => {
  const src = stripComments(read('src/main/ipc/handlers.ts'))
  const handlerAt = src.indexOf('CH.agent.run')
  assert.ok(handlerAt >= 0, 'handlers.ts 里找不到 CH.agent.run')
  const callAt = src.indexOf('runAgent(', handlerAt)
  assert.ok(callAt > handlerAt, 'agent.run 里没有调用 runAgent')
  // 只看 runAgent(...) 的参数：window/task 那些 handler 不该被算进来
  const call = src.slice(callAt, callAt + 1500)
  assert.match(
    call,
    /\bmaskWebContentsId\s*:\s*tab\.wc\.id\b/,
    'agent.run 没有把本次操作标签页的 wc.id 作为 maskWebContentsId 传下去：' +
      'agent 路径会用控制台窗口的 senderId 去查伪装状态，L2 被永久拦下'
  )
})

test('脚本回放路径（scripts.ts）把 handle.wc.id 传成 maskWebContentsId', () => {
  const args = executeActionArgs(read('src/main/modules/scripts.ts'))
  assert.ok(args.length > 0, 'scripts.ts 里找不到 executeAction 调用')
  assert.ok(
    args.some((a) => /\bmaskWebContentsId\s*:\s*handle\.wc\.id\b/.test(a)),
    'scripts.ts 的 executeAction 没有传 `maskWebContentsId: handle.wc.id`：' +
      '回放会拿不到状态记录，L2 被伪装闸门拦下'
  )
})

test('本地 HTTP API 路径（localapi.ts）把 tab.wc.id 传成 maskWebContentsId', () => {
  const args = executeActionArgs(read('src/main/modules/localapi.ts'))
  assert.ok(args.length > 0, 'localapi.ts 里找不到 executeAction 调用')
  assert.ok(
    args.some((a) => /\bmaskWebContentsId\s*:\s*tab\.wc\.id\b/.test(a)),
    'localapi.ts 的 executeAction 没有传 `maskWebContentsId: tab.wc.id`：' +
      '/act 的 L2 会被伪装闸门拦下（这条路径没有 senderId 可回退）'
  )
})

/* ────────────────────── 4. 接线方向（纯逻辑，不碰 Electron） ────────────────────── */

test('同一个 maskLookup：tab wc.id 查到 ok 放行，控制台 id 查不到就拦下', () => {
  const tabWcId = 4242
  const consoleWcId = 17

  // 模拟 `index.ts` 的注入：`wm.maskStateOf(id)` —— 状态表的键是标签页的 wc.id
  const records = new Map<number, MaskStateRecord>([
    [tabWcId, { webContentsId: tabWcId, profileId: 'prf_1', state: 'ok', failed: [], at: 1 }]
  ])
  const maskLookup = (id?: number): MaskStateRecord | null =>
    typeof id === 'number' ? records.get(id) ?? null : null

  // 修好的方向：传标签页 wc.id
  const record = maskLookup(tabWcId)
  assert.ok(record, '标签页 wc.id 必须查得到状态记录')
  assert.equal(judgeMask(record).allow, true, 'state=ok 必须放行')
  assert.equal(decideMaskGate(record, false).allow, true, 'judgeMask 之后仍应放行')

  // 坏的方向：传控制台 renderer 的 id（修复前的实际行为）
  const wrong = maskLookup(consoleWcId)
  assert.equal(wrong, null, '控制台窗口的 id 不是状态表的键，必然查不到')
  const verdict = judgeMask(wrong)
  assert.equal(verdict.allow, false, '查不到就是 missing，必须拦下')
  assert.equal(verdict.kind, 'missing', 'kind 必须是 missing（补救方式是修接线，不是等人点确认）')
  assert.equal(
    decideMaskGate(wrong, true).allow,
    false,
    'missing 连环境级豁免都救不了：豁免要求 record 非空，否则「查不到」会变成默认放行'
  )
})

/* ────────────────────── 5. 单实例锁：没拿到锁就完全不初始化 ────────────────────── */

test('单实例锁：整块 whenReady 初始化在 else 分支里，第二个进程只 quit()', () => {
  const src = stripComments(read('src/main/index.ts'))

  assert.match(
    src,
    /const gotLock\s*=\s*app\.requestSingleInstanceLock\(\)/,
    'index.ts 应该把 `requestSingleInstanceLock()` 的结果存下来，才能决定要不要初始化'
  )
  assert.doesNotMatch(
    src,
    /if\s*\(!\s*app\.requestSingleInstanceLock\(\)\s*\)/,
    'index.ts 还是「没拿到锁只 quit() 不 return」的写法：`app.quit()` 是异步的，' +
      '第二个进程会继续跑 whenReady —— 两个进程同时写同一批 JSON，数据静默丢失'
  )

  // 结构性检查：whenReady 必须在 `if (gotLock) {` 与 `} else` 之间，
  // 而 `app.quit()` 必须在 `} else` 之后。
  const ifAt = src.indexOf('if (gotLock)')
  const elseAt = src.indexOf('} else {', ifAt)
  const readyAt = src.indexOf('app.whenReady()', ifAt)
  const quitAt = src.indexOf('app.quit()', elseAt)
  assert.ok(ifAt >= 0 && elseAt > ifAt, 'index.ts 没有 `if (gotLock) { … } else { … }` 结构')
  assert.ok(readyAt > ifAt && readyAt < elseAt, 'app.whenReady() 必须在拿到锁的分支里')
  assert.ok(
    quitAt > elseAt,
    '没拿到锁的分支必须调用 app.quit()，且排在 else 之后（不能只剩一个裸 quit() 然后继续执行）'
  )

  // 不能用 process.exit 掩盖：那会跳过 Electron 的收尾
  assert.doesNotMatch(src, /\bprocess\.exit\s*\(/, 'index.ts 不该用 process.exit() 处理第二实例')

  // 第二实例的行为：把已存在的控制台窗口带到前台，且只注册在持有锁的进程里
  const secondAt = src.indexOf("app.on('second-instance'")
  assert.ok(secondAt > ifAt && secondAt < elseAt, 'second-instance 必须在持有锁的分支里注册')
})