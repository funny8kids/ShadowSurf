/**
 * 结构断言：钉住「闸门覆盖」与「反检测面」这两类已经发生过两次的错误。
 *
 * 这些不是行为测试，是源码约束检查 —— 不需要 Electron，和 risk.test.ts 一个量级。
 *
 * 关于 skip：本文件里带 skip 的用例，描述的是**修复完成后的期望状态**，
 * 不是当前状态。当前它们是红的，所以先 skip，避免 `npm test` 长期带红。
 * 每条 skip 的 reason 里写清了「什么条件下可以取消 skip」——
 * 修复落地后把 skip 去掉，这组就从「债务清单」变成「回归护栏」。
 *
 * 跑法：node --experimental-strip-types --test tests/structure.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

/** 递归收集 src/ 下所有 ts/tsx 源文件 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

const sources = (): string[] => walk(join(ROOT, 'src'))
const rel = (file: string): string => relative(ROOT, file).replace(/\\/g, '/')
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8')

/* ────────────────────────── 1. 闸门覆盖（债务） ────────────────────────── */

test(
  '每个 executeAction 调用点都必须过风险闸门',
  {
    skip:
      '当前 localapi.ts:416 与 scripts.ts:313 未调用 assessRisk。' +
      '修复方式：executeAction 增加必填参数 gate: RiskVerdict，三个调用点各自处理 L2。' +
      '该修复落地后本用例应改为「断言 executeAction 签名含必填 gate」，或直接删除（由 TS 编译器接管）。'
  },
  () => {
    const offenders: string[] = []
    for (const file of sources()) {
      const text = readFileSync(file, 'utf8')
      // 只关心「调用」，跳过定义处本身
      if (!/executeAction\s*\(/.test(text)) continue
      if (/export\s+async\s+function\s+executeAction/.test(text)) continue
      if (!/assessRisk/.test(text)) offenders.push(rel(file))
    }
    assert.deepEqual(
      offenders,
      [],
      `以下文件调用了 executeAction 但完全没过闸门：${offenders.join(', ')}`
    )
  }
)

/* ────────────────────────── 2. 反检测面（债务） ────────────────────────── */

test(
  '元素编号不得写进主世界 DOM，且 __SS__ 不得挂主世界',
  {
    skip:
      '当前 page-agent.ts:225 用 setAttribute(\'data-ss-id\') 把编号写进 DOM，:454 把 window.__SS__ 挂主世界。' +
      '修复方式：编号改 isolated world 内的 WeakMap<Element,string>；脚本经 ' +
      'Page.addScriptToEvaluateOnNewDocument({ worldName }) 注入，Runtime.evaluate 带 contextId。' +
      '注意 isolated world 与主世界共享 DOM，只做 isolated world 不够，WeakMap 是必须的。'
  },
  () => {
    const pageAgent = read('src/main/agent/page-agent.ts')
    assert.ok(
      !/setAttribute\(\s*['"]data-ss-id['"]/.test(pageAgent),
      'page-agent.ts 仍把编号写进页面 DOM，任何页面脚本都能读写并篡改闸门输入'
    )

    const offenders = sources()
      .filter((file) => !file.endsWith('page-agent.ts'))
      .filter((file) => /window\.__SS__\s*=/.test(readFileSync(file, 'utf8')))
      .map(rel)
    assert.deepEqual(offenders, [], `__SS__ 只应存在于 page-agent.ts，但也在：${offenders.join(', ')}`)
  }
)

/* ────────────────────────── 3. 导航守卫（债务） ────────────────────────── */

test(
  '两个窗口都必须有 will-navigate 守卫',
  {
    skip:
      '当前 src/ 全项目 will-navigate 零命中，setWindowOpenHandler 只拦 window.open / target=_blank，' +
      '拦不住顶层导航。壳层窗口 sandbox:false 且 preload 注入完整 window.ss，' +
      '一次顶层跳转即可把 migration.import / scripts.save / localApi.start 交给远程源。'
  },
  () => {
    for (const file of ['src/main/index.ts', 'src/main/core/windows.ts']) {
      assert.ok(
        /will-navigate/.test(read(file)),
        `${file} 缺少 will-navigate 守卫（两个窗口都要，别只加一个）`
      )
    }
  }
)

/* ────────────────────────── 4. send / submit 拆分（债务） ────────────────────────── */

test(
  '「发送」类动作不可被只读意图降级',
  {
    skip:
      '当前 risk.ts 的 send 规则把「发送」与「提交表单|submit」合并成同一类，且不在 NEVER_DOWNGRADE 里，' +
      '于是「采集这个页面并发送私信」会把发送降级为 L1 自动执行。' +
      '修复方式：submit 摘出来单列一类（保持可降级），send 收窄为真正的对外发送并加入 NEVER_DOWNGRADE。' +
      '落地后本用例转绿；tests/risk.test.ts 里「提交表单 → L1」那条不受影响。'
  },
  () => {
    // 需要 risk.ts 导出分类信息才能直接断言；此处用行为断言更稳
    const verdict = assessRiskForTest('发送私信', '采集这个页面的商品价格')
    assert.equal(verdict, 'L2', '对外发送不可撤回，不得因「采集」意图降级为自动执行')
  }
)

/** 惰性引入，避免未修复时模块加载期就抛错影响其它用例 */
function assessRiskForTest(extra: string, intent: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../src/main/agent/risk.ts') as {
    assessRisk: (a: unknown, i: string, e?: string) => { level: string }
  }
  return mod.assessRisk({ type: 'click', id: 'e5' }, intent, extra).level
}

/* ────────────────────────── 5. 字段搬运完整性（当前通过） ────────────────────────── */

/**
 * 这条现在是绿的，而且挡的是一个具体的坑：
 * scripts.ts 的 sanitizeSteps 逐字段白名单收敛，任何 ScriptStep 新增字段
 * 如果忘了在 sanitizeSteps 里搬运，就会在保存时被**静默丢弃** ——
 * 类型上编译通过、运行时永远拿不到值。
 *
 * 安全同事的方案要给 ScriptStep 加 confirmed: true，正好踩这个坑。
 * 有了这条断言，加字段的人会立刻被测试拦下，而不是等回放时才发现确认标记没存上。
 */
test('ScriptStep 的每个字段都必须被 sanitizeSteps 搬运', () => {
  const types = read('src/shared/types.ts')
  const block = /export interface ScriptStep \{([\s\S]*?)\n\}/.exec(types)
  assert.ok(block, '找不到 ScriptStep 接口定义')

  const fields = block[1]
    .split('\n')
    .map((line) => /^\s*(\w+)\??\s*:/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1])

  assert.ok(fields.length > 0, 'ScriptStep 字段解析为空，正则可能已失效')

  const scripts = read('src/main/modules/scripts.ts')
  const dropped = fields.filter((field) => !scripts.includes(`step.${field}`))
  assert.deepEqual(
    dropped,
    [],
    `这些 ScriptStep 字段没有在 sanitizeSteps 里被搬运，保存时会被静默丢弃：${dropped.join(', ')}`
  )
})

/* ────────────────────────── 6. API 契约漂移（债务） ────────────────────────── */

test(
  '本地 API 的动作类型枚举必须与 openapi 契约一致',
  {
    skip:
      '当前实现 localapi.ts 的 ACTION_TYPES 是 [click,type,press,scroll,navigate,extract,done]，' +
      '而 docs/api/openapi.yaml 的枚举是 [navigate,click,type,scroll,extract,screenshot,wait,submit]。' +
      '实现有 press/done、契约没有；契约有 screenshot/wait/submit、实现没有。' +
      '两边都改或择一为准后取消 skip —— 契约与实现对不上，外部 SDK 必然踩空。'
  },
  () => {
    const impl = read('src/main/modules/localapi.ts')
    const implTypes = /const ACTION_TYPES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(impl)
    assert.ok(implTypes, '找不到 ACTION_TYPES 定义')
    const implSet = [...implTypes[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort()

    const spec = read('docs/api/openapi.yaml')
    const enumMatch = /enum:\s*\[([^\]]*screenshot[^\]]*)\]/.exec(spec)
    assert.ok(enumMatch, '找不到 openapi 里的动作枚举')
    const specSet = enumMatch[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort()

    assert.deepEqual(implSet, specSet, '实现与 openapi 契约的动作类型不一致')
  }
)
