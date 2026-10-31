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

import { assessRisk } from '../src/main/agent/risk.ts'

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
/** 去掉注释再匹配：说明「为什么不再用 data-ss-id」的注释不该被判成违规 */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

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

test('元素编号不得写进主世界 DOM，且 __SS__ 必须跑在 isolated world', () => {
  const pageAgent = read('src/main/agent/page-agent.ts')
  assert.ok(
    !/setAttribute\(\s*['"]data-ss-id['"]/.test(pageAgent),
    'page-agent.ts 仍把编号写进页面 DOM，任何页面脚本都能读写并篡改闸门输入'
  )

  // 全仓库都不该再出现这个属性名 —— 换个属性名绕过等于没修
  const attrLeak = sources()
    .filter((file) => /data-ss-id/.test(stripComments(readFileSync(file, 'utf8'))))
    .map(rel)
  assert.deepEqual(attrLeak, [], `仍有文件在代码里使用 data-ss-id：${attrLeak.join(', ')}`)

  const offenders = sources()
    .filter((file) => !file.endsWith('page-agent.ts'))
    .filter((file) => /window\.__SS__\s*=/.test(readFileSync(file, 'utf8')))
    .map(rel)
  assert.deepEqual(offenders, [], `__SS__ 只应存在于 page-agent.ts，但也在：${offenders.join(', ')}`)

  // 只把脚本挪进函数不够：注入和求值两边都必须带 worldName，
  // 少一边就会出现「写进隔离世界、却从主世界读」的诡异不一致
  const snapshot = read('src/main/agent/snapshot.ts')
  assert.ok(/const WORLD_NAME = '[^']+'/.test(snapshot), 'snapshot.ts 未定义 WORLD_NAME')
  const worldHits = [...snapshot.matchAll(/worldName:\s*WORLD_NAME/g)].length
  assert.ok(
    worldHits >= 2,
    `worldName 只出现 ${worldHits} 次；addScriptToEvaluateOnNewDocument 与 Runtime.evaluate 都必须带`
  )
})

/* ────────────────────────── 2b. toString 伪装（债务，最高杠杆） ────────────────────────── */

test(
  '注入脚本必须伪装 Function.prototype.toString',
  () => {
    const fp = read('src/main/core/fingerprint.ts')
    assert.ok(
      /Function\.prototype\.toString/.test(fp),
      'fingerprint.ts 未伪装 Function.prototype.toString，所有 patch 过的 getter/函数都可被 toString 枚举'
    )
  }
)

/**
 * 这条原来断言的是「不得出现 `X.prototype = Native.prototype`」。
 * 实现方选了另一条同样成立的路线：保留复用，但紧跟一句
 * `defineProperty(Native.prototype, "constructor", { value: 包装器 })`。
 * 所以断言要跟着改成**不变量**（每处复用都得有对应修复），
 * 而不是钉住某一种写法 —— 否则修好了测试还红，测试就从护栏变成噪音。
 *
 * 注意：结构断言只能看「有没有写那句话」，看不到「运行时是否真的指对了」。
 * 后者由 tools/verify-anticheat.mjs 的 AC-08 在真实 Chromium 里验。
 */
test('复用原生 prototype 时必须把 constructor 指回包装器', () => {
  const fp = read('src/main/core/fingerprint.ts')
  const reused = [...fp.matchAll(/\b(\w+)\.prototype\s*=\s*(\w+)\.prototype/g)].length
  const repaired = [...fp.matchAll(/Object\.defineProperty\(\s*\w+\.prototype,\s*"constructor"/g)].length
  assert.ok(
    repaired >= reused,
    `有 ${reused} 处复用原生 prototype，但只有 ${repaired} 处修了 constructor —— ` +
      '未修的那些会把原生构造器泄漏出去，页面一次 `new (X.prototype.constructor)()` 就绕过全部包装'
  )
})

/**
 * 覆盖性断言：比逐条断言更抗未来改动。
 *
 * 逐条断言只能证明「我想到的那几个是对的」，覆盖性断言能证明
 * 「不存在我没想到的」。上一轮实际漏登记过 4 处（Geolocation 两个方法、
 * AnalyserNode、RTCPeerConnection），逐条断言全部漏过，就是这条会抓到。
 */
test('每个被替换的原型方法都必须登记进伪装台账', () => {
  const fp = read('src/main/core/fingerprint.ts')

  // 别名表：var C2D = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype
  const alias = new Map<string, string>()
  for (const m of fp.matchAll(/var\s+(\w+)\s*=\s*[^\n]*?\b(\w+)\.prototype\b/g)) alias.set(m[1], m[2])

  // 被替换的原型成员：X.prototype.p = ... / ALIAS.p = ...
  // 只认「绑定到某个 .prototype 的别名」，页面局部对象（out / pc / fonts）不算
  const replaced = new Set<string>()
  for (const m of fp.matchAll(/\w+\.prototype\.(\w+)\s*=\s*(?:function|_)/g)) replaced.add(m[1])
  for (const m of fp.matchAll(/\b(\w+)\.(\w+)\s*=\s*(?:function|_)/g)) {
    if (alias.has(m[1])) replaced.add(m[2])
  }

  // 台账：_MASK_TABLE 里的名字数组 + _maskAt / _maskOne 的字符串参数。
  // 台账已从「逐个 _maskAll 调用」收敛成一张 _MASK_TABLE 表（快照与登记共用），
  // 所以这里要按表解析 —— 否则登记全在表里、断言却还在找逐个调用，会误报全红。
  const registered = new Set<string>()
  for (const m of fp.matchAll(/_MASK_TABLE[\s\S]*?\n  L\.push\('    \];'\)/g)) {
    for (const s of m[0].matchAll(/"([^"]+)"/g)) registered.add(s[1])
  }
  for (const m of fp.matchAll(/_maskAll\([^,]+,\s*\[([\s\S]*?)\]/g)) {
    for (const s of m[1].matchAll(/"([^"]+)"/g)) registered.add(s[1])
  }
  for (const m of fp.matchAll(/_maskAt\([^,]+,\s*"([^"]+)"/g)) registered.add(m[1])
  for (const m of fp.matchAll(/_maskOne\([^,]+,\s*"([^"]+)"/g)) registered.add(m[1])

  assert.ok(replaced.size > 10, `只解析出 ${replaced.size} 个替换点，正则可能已失效`)

  const missing = [...replaced].filter((p) => !registered.has(p)).sort()
  assert.deepEqual(
    missing,
    [],
    `这些成员被替换了但没登记进台账，toString() 会吐出真实源码：${missing.join(', ')}`
  )
})

test('伪装台账 _masked / _fakeSrc / _maskOne 只能声明一次', () => {
  // 曾经踩过：顶部新增了一份声明、底部遗留一份没删。
  // var 是函数作用域提升，底部那次赋值会把数组重置为空，
  // 于是 toString 收口只遍历到 _patched 自己，所有中途 patch 的函数仍吐真实源码 ——
  // 「看起来修好了，功能全失效」，且人工 review 看不出来。
  // 同理重复赋值 _maskOne 会让底部 2 参数版本覆盖顶部 3 参数版本、丢掉 length 校正。
  const fp = read('src/main/core/fingerprint.ts')
  for (const name of ['_masked', '_fakeSrc', '_maskOne']) {
    const hits = [...fp.matchAll(new RegExp(`var ${name}\\b`, 'g'))].length
    assert.ok(hits <= 1, `${name} 被声明了 ${hits} 次；重复声明会重置状态或覆盖前一个实现`)
  }
})

/* ────────────────────────── 3. 导航守卫（已修复，护栏） ────────────────────────── */

test('两个窗口都必须有 will-navigate 守卫', () => {
  for (const file of ['src/main/index.ts', 'src/main/core/windows.ts']) {
    assert.ok(
      /guardShellNavigation/.test(read(file)),
      `${file} 未挂壳层导航守卫（两个窗口都要，别只加一个）`
    )
  }
  // 守卫本体必须真的监听 will-navigate，不能只是挂了个名字
  assert.ok(/will-navigate/.test(read('src/main/core/windows.ts')), '守卫未监听 will-navigate')
})

/* ────────────────────────── 4. send / submit 拆分（已修复，护栏） ────────────────────────── */

test('「发送」类动作不可被只读意图降级', () => {
  const verdict = assessRisk({ type: 'click', id: 'e5' }, '采集这个页面的商品价格', '发送私信')
  assert.equal(verdict.level, 'L2', '对外发送不可撤回，不得因「采集」意图降级为自动执行')
  assert.equal(verdict.matched, '发送')
})

test('「提交表单」仍可被只读意图降级（拆分的另一半）', () => {
  const verdict = assessRisk({ type: 'click', id: 'e2' }, '采集这个页面的商品价格', '提交表单')
  assert.equal(verdict.level, 'L1', '搜索框提交是本端可回退动作，不该每次弹确认')
})

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

/* ────────────────── 7. 降级路径的输入来源（安全轴） ────────────────── */

/**
 * 这一轮定死了一条轴：**抬风险可以吃页面文本，降风险只能吃用户输入。**
 *
 * 起因是一个被否掉的压噪方案——「元素 role 是 menuitem/link 且位于导航区时，
 * 把『退出登录』降为 L1」。role 和位置都是页面自己写的，而 account 在
 * NEVER_DOWNGRADE 里，等于给页面一个**确定性的降级开关**：
 * 把按钮塞进 <nav>、role 设成 menuitem，一个本该永不可降级的账号动作就自动执行了。
 *
 * 不加语境判断时页面无法影响判定；加了反而把开关交出去。所以这里钉住的是
 * 「降级函数的实参只能是 intent」，而不是某个具体规则的写法。
 */
test('降级判断只允许吃用户意图，不得吃页面可控输入', () => {
  const risk = read('src/main/agent/risk.ts')
  // 排除函数声明本身（形参是 `intent: string`），只看调用点
  const calls = [...risk.matchAll(/(function\s+)?hitReadOnlyIntent\(\s*([^)]*?)\s*\)/g)].filter(
    (m) => !m[1]
  )
  assert.ok(calls.length > 0, '找不到 hitReadOnlyIntent 调用点，正则可能已失效')
  for (const m of calls) {
    assert.equal(
      m[2],
      'intent',
      `降级判断吃了「${m[2]}」而不是 intent —— 页面可控文本一旦能影响降级，就等于把闸门开关交给页面`
    )
  }
})

/* ────────────────── 8. 全局 toString patch（债务，架构级） ────────────────── */

test(
  '注入脚本不得改写 Function.prototype.toString（应改用 Proxy 包装）',
  {
    skip:
      '当前仍执行 `Function.prototype.toString = _patched`。实测代价：原生 toString 抛 TypeError 时' +
      '栈里没有 JS 帧，patch 之后多出 `at toString` 一帧 —— 检测方一行 ' +
      '`try{Function.prototype.toString.call(1)}catch(e){e.stack}` 就能判定「被插桩」，不需要任何前提。' +
      '这是目前最便宜的 tell，比 `\'prototype\' in fn` 更普适（后者要先怀疑才去遍历）。' +
      '改用 `new Proxy(原生函数, { apply })` 后 toString 自动转发到 target，' +
      '台账 / _fakeSrc / _maskOne 的 name+length 校正全部不再需要。' +
      '取消 skip 的条件：源码中不再出现对 Function.prototype.toString 的赋值，' +
      '且 verify-anticheat 的 AC-11 读数从 has-own-frame 变为 clean。'
  },
  () => {
    const fp = read('src/main/core/fingerprint.ts')
    assert.ok(
      !/Function\.prototype\.toString\s*=/.test(fp),
      '注入脚本改写了 Function.prototype.toString，异常栈会多出一帧（最便宜的插桩检测信号）'
    )
  }
)

/* ────────────── 9. 页面可控文本影响判定的「例外」必须计数 ────────────── */

/**
 * 这一轮立了一条轴：**页面可控文本只能抬风险，不能降风险**。
 *
 * 但已经出现了一个合法的例外：`REVERSIBLE_CLEAR` —— 命中筛选类宾语时跳过 delete 规则。
 * 它读的是 `hay`（含页面写的元素名），确实是在降风险。
 *
 * 严重度要诚实：**边际可利用性接近零**。页面本来就能把「清空购物车」写成「继续」，
 * 那样任何规则都不命中，同样 L1 —— 这个例外没有给页面新增能力。
 *
 * 真正的问题是**先例**：下一个人会拿它当理由去加一个更大的例外。
 * 所以这条断言不阻止这个例外，而是把例外数量**钉死为 1**：
 * 将来谁加第二个，测试直接红，必须解释为什么。
 */
test('页面文本跳过规则的例外只允许有一个', () => {
  const risk = read('src/main/agent/risk.ts')
  const skips = [...risk.matchAll(/\.test\(\s*hay\s*\)[\s\S]{0,120}?continue/g)]
  assert.equal(
    skips.length,
    1,
    `出现了 ${skips.length} 处「页面文本跳过规则」的分支。每加一个都是在降风险侧开一个页面可写的输入，` +
      '必须评审：它给页面新增了什么能力？如果答案是「没有」，说明这个例外不必要；' +
      '如果答案是「有」，那就是一个洞。'
  )
})

/* ────────────── 10. `instanceof` 的收窄依赖「值导入」 ────────────── */

/**
 * `catch (err) { if (err instanceof ApprovalRequiredError) ... }` 能把 `err` 从
 * `unknown` 收窄，前提是 `ApprovalRequiredError` 是**值导入**。
 *
 * 一旦有人为了「只用于类型判断」把它改成 `import type`：
 *   - typecheck 报 TS18046（`err` 仍是 unknown），
 *   - **运行时完全无感地更糟**：`instanceof undefined` 抛 TypeError，
 *     而那个 TypeError 会被外层 catch 当成「动作失败」吞掉。
 *
 * 形状刻意写成「只要出现 instanceof，就必须存在同名值导入」而不是点名文件 ——
 * 将来在新模块里加 instanceof 也自动被覆盖，不需要有人记得来改这条。
 */
test('凡是用 instanceof ApprovalRequiredError 的地方，必须是值导入', () => {
  const files = walk(join(ROOT, 'src/main'))
  const offenders: string[] = []

  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'))
    if (!/instanceof\s+ApprovalRequiredError\b/.test(code)) continue

    // 值导入的两种写法都认：`import { X } from`、`import { X as Y } from`（别名也算值导入）
    const valueImport = /import\s+(?!type\s)[^;]*?\{[^}]*\bApprovalRequiredError\b[^}]*\}\s*from/.test(code)
    if (!valueImport) offenders.push(relative(ROOT, file))
  }

  assert.deepEqual(
    offenders,
    [],
    '这些文件里 `instanceof ApprovalRequiredError` 收窄不到类型（缺值导入）：' +
      offenders.join(', ') +
      '。把 `import type { ApprovalRequiredError }` 改成 `import { ApprovalRequiredError }`。'
  )
})
