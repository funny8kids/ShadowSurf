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

test('executeAction 必须自己判等级，调用点不得传等级或授权结论', () => {
  // 这条原先是个 skip（债务）：localapi / scripts 两个调用点没调 assessRisk，
  // 闸门只活在 agent loop 里，另外两条路径整个绕过去。
  //
  // 修复方式最后选的不是「让调用点各自补一次 assessRisk」—— 那还是靠人记得。
  // 现在等级由 executeAction 自己算，`Approval` 里**没有** level / approvedBy 两个字段，
  // 所以「调用方声明几级」和「调用方声明已授权」在类型上就写不出来。
  // 于是这条断言的形态也随之改变：不再数谁漏了 assessRisk，而是钉住那个结构。
  const actions = stripComments(read('src/main/agent/actions.ts'))

  // 1) 执行器内部必须真的算等级
  assert.match(actions, /assessRisk\s*\(/, 'executeAction 内部必须调用 assessRisk')

  // 2) Approval 类型不得重新长出「调用方说了算」的字段
  const approval = /export type Approval = \{[\s\S]*?\n\}/.exec(actions)
  assert.ok(approval, '找不到 Approval 类型定义')
  const body = approval[0]
  for (const forbidden of ['level', 'approvedBy']) {
    assert.doesNotMatch(
      body,
      new RegExp(`\\b${forbidden}\\s*\\??:`),
      `Approval 不得包含 ${forbidden}：那等于让调用方声明结论，闸门强度就变成「调用方有没有老实」`
    )
  }

  // 3) 调用点不得把等级塞进 Approval。
  //    注意不能全文匹配 `level:` —— 调用点算等级是允许的（要决定弹不弹框），
  //    `requestConsent({ level: 'L2' })` 里的那个 level 就是合法用法。
  //    所以只看 executeAction 调用括号内那一段。
  const offenders: string[] = []
  for (const file of sources()) {
    const text = stripComments(readFileSync(file, 'utf8'))
    if (/export\s+async\s+function\s+executeAction/.test(text)) continue
    let from = 0
    for (;;) {
      const at = text.indexOf('executeAction(', from)
      if (at < 0) break
      from = at + 1
      const args = text.slice(at, at + 700)
      if (/\blevel\s*:/.test(args)) offenders.push(`${rel(file)}@${String(at)}`)
    }
  }
  assert.deepEqual(offenders, [], `以下调用点把等级传给了执行器：${offenders.join(', ')}`)
})

test('闸门与执行器的语义拼接只允许有一份实现', () => {
  // 这个 bug 真实发生过：loop 拼 `name+thought`、执行器又拼了一次 `name`，
  // 而抑制规则看的是「命中词紧邻的右文」—— 元素名出现两次就把那段右文换掉了。
  // 结果闸门判 L1（不弹框）、执行器判 L2（抛错），动作被拦而用户从未被问过。
  //
  // 修法不是「三处都记得只拼一次」，而是让「拼两次」在结构上写不出来：
  // 元素名由 `actionSemantic` 自己从快照取，调用方只能传 note。
  // 所以这里断言的是「除了 protocol.ts，没有任何地方手拼 name+note」。
  const offenders: string[] = []
  for (const file of sources()) {
    const name = rel(file)
    if (name === 'src/shared/protocol.ts') continue
    const text = stripComments(readFileSync(file, 'utf8'))
    // 手拼的特征：把 target?.name / el?.name 和别的东西 join 到一起
    const joinsName = /\.name\s*\?\?\s*''[\s\S]{0,80}?\.join\(\s*'\s'\s*\)/.test(text)
    const pushesName = /\[\s*(?:target|el|element)\?\.name[^\]]*\]\s*\.filter/.test(text)
    if (joinsName || pushesName) offenders.push(name)
  }
  assert.deepEqual(
    offenders,
    [],
    `以下文件在手工拼接元素名（应改用 actionSemantic）：${offenders.join(', ')}`
  )

  // 反向自检：这套正则必须真的能抓到旧写法，否则上面那个空数组毫无意义
  const oldLoop = "const extra = [target?.name ?? '', thought].filter((v) => v.length > 0).join(' ')"
  assert.match(
    oldLoop,
    /\.name\s*\?\?\s*''[\s\S]{0,80}?\.join\(\s*'\s'\s*\)/,
    '正则抓不到旧写法 —— 这条断言会变成恒真'
  )
})

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
  /* 先剥注释再数。
     这条门禁原来直接在原文上数，于是**一句解释性注释就能把它弄红**：
     有人写了「`W.prototype = Orig.prototype` 是共享同一个 prototype 对象」，
     `reused` 从 2 变 3、`repaired` 还是 2，断言红 —— 而代码是对的。
     下一个人遇到这种红，只会做两件事：删注释，或者改代码。两个方向都错。
     **能被注释弄红的门禁，和能被注释弄绿的门禁一样不可信。** */
  const fp = stripComments(read('src/main/core/fingerprint.ts'))
  const reused = [...fp.matchAll(/\b(\w+)\.prototype\s*=\s*(\w+)\.prototype/g)].length
  const repaired = [...fp.matchAll(/Object\.defineProperty\(\s*\w+\.prototype,\s*"constructor"/g)].length
  // 解析自检：两个数都是 0 时 `repaired >= reused` 恒成立 —— 那会变成空断言
  assert.ok(
    reused > 0 && repaired > 0,
    `数出 reused=${String(reused)} / repaired=${String(repaired)} —— 两侧都得非零，` +
      '否则「修复覆盖」这条判据是恒真的。检查正则是否已失效'
  )
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
  // 锚点必须落在**声明处**，不能落在第一次出现处 —— 文件里 `_MASK_TABLE` 会先出现在
  // 注释里，从注释起做非贪婪匹配会停在表格之前的某个 `L.push('    ];')`，
  // 结果 registered 几乎是空的，然后报「全部没登记」。那不是泄漏，是解析器指错了地方。
  // （这条断言重构后确实这么误报过一次：15 项全红，而台账其实一个字没少。）
  for (const m of fp.matchAll(/_MASK_TABLE\s*=\s*\[[\s\S]*?L\.push\('\s*\];'\)/g)) {
    for (const s of m[0].matchAll(/"([^"]+)"/g)) registered.add(s[1])
  }
  for (const m of fp.matchAll(/_maskAll\([^,]+,\s*\[([\s\S]*?)\]/g)) {
    for (const s of m[1].matchAll(/"([^"]+)"/g)) registered.add(s[1])
  }
  for (const m of fp.matchAll(/_maskAt\([^,]+,\s*"([^"]+)"/g)) registered.add(m[1])
  for (const m of fp.matchAll(/_maskOne\([^,]+,\s*"([^"]+)"/g)) registered.add(m[1])

  // ── 两侧都要有「解析自检」，否则空集合会被当成「全部违规」 ──
  // 这条曾经的不对称导致过一次误报：registered 解析出 0 项，于是 15 项全被报成「没登记」，
  // 而真相是「我一项都没解析到」。**「没解析到」和「解析到但违规」必须区分。**
  assert.ok(replaced.size > 10, `只解析出 ${replaced.size} 个替换点，正则可能已失效`)
  assert.ok(
    registered.size > 20,
    `只解析出 ${registered.size} 项台账 —— 这是解析失败，不是「全部没登记」。` +
      '先修正则锚点（要从 `_MASK_TABLE = [` 的声明处起匹配，不能从第一次出现处起，' +
      '文件里它第一次出现在注释里）。'
  )

  const missing = [...replaced].filter((p) => !registered.has(p)).sort()
  assert.deepEqual(
    missing,
    [],
    `这些成员被替换了但没登记进台账，toString() 会吐出真实源码：${missing.join(', ')}`
  )
})

test('伪装台账 _masked / _fakeSrc / _maskOne 在同一段代码里只能声明一次', () => {
  // 曾经踩过：顶部新增了一份声明、底部遗留一份没删。
  // var 是函数作用域提升，底部那次赋值会把数组重置为空，
  // 于是 toString 收口只遍历到 _patched 自己，所有中途 patch 的函数仍吐真实源码 ——
  // 「看起来修好了，功能全失效」，且人工 review 看不出来。
  // 同理重复赋值 _maskOne 会让底部 2 参数版本覆盖顶部 3 参数版本、丢掉 length 校正。
  //
  // 判据为什么是「同一段代码里」而不是「整个文件一次」：
  // 文件里现在有多个生成器（page / worker / iframe 各生成一份独立脚本），
  // 每个函数里的 var 是各自的作用域，各声明一次是**正确**的。
  // 按整文件计数会把正确实现判成红 —— 断言太严和太松是同一个成本。
  // 真正的危险是「同一个函数里声明两次」，所以判据取「相邻两次声明之间必须有函数边界」。
  const fp = read('src/main/core/fingerprint.ts')
  for (const name of ['_masked', '_fakeSrc', '_maskOne']) {
    // 不用正则：`` 写在模板字符串里会被解释成退格字符（U+0008），
    // 正则变成 `var _masked<BS>`，永远匹配不到 —— 而失败信息是「完全没有声明」，
    // 看起来像源码问题，其实是测试自己的转义错。这条断言踩过这个坑一次，
    // 所以改成 indexOf 扫描，不给转义留余地。
    const pos: number[] = []
    for (let at = fp.indexOf('var ' + name); at !== -1; at = fp.indexOf('var ' + name, at + 1)) {
      const after = fp[at + 4 + name.length]
      if (after === undefined || !/[\w$]/.test(after)) pos.push(at)
    }
    assert.ok(pos.length >= 1, `${name} 完全没有声明 —— 收口机制不存在`)
    for (let i = 1; i < pos.length; i++) {
      const between = fp.slice(pos[i - 1], pos[i])
      assert.ok(
        /(?:^|\n)(?:export )?function\b/.test(between),
        `${name} 在同一段代码里被声明了两次（第 ${i} 次与第 ${i + 1} 次之间没有函数边界）—— ` +
          'var 是函数作用域提升，后一次赋值会重置状态或覆盖前一个实现'
      )
    }
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

/* ────────────────────────── 6. API 契约漂移 ────────────────────────── */

/**
 * 这条原先带着 skip，因为两边真的对不上：
 *
 *   实现 localapi.ts  [click,type,press,scroll,navigate,extract,done]
 *   契约 openapi.yaml [navigate,click,type,scroll,extract,screenshot,wait,submit]
 *
 * 实现有 press/done、契约没有；契约有 screenshot/wait/submit、实现没有。
 * 契约比实现多一个类型，外部 SDK 会写出一调用就 400 的代码；少一个，则新能力
 * 对 SDK 不可见 —— 两种都是「照着文档写必然踩空」。
 *
 * 取消 skip 的条件是「两边一致」，现在把三方一起对齐了：
 *
 *   protocol.ts 的 ActionType 联合类型  ←  唯一来源
 *        ↓ 实现必须覆盖
 *   localapi.ts 的 ACTION_TYPES          ←  运行时白名单
 *        ↓ 文档必须一致
 *   openapi.yaml 的 ActionType.enum      ←  对外契约
 *
 * 所以这里不只比两边，而是比三方：只比两边的话，实现和文档可以一起漂到
 * 一个协议层根本不存在的类型上，而那条路径永远不会被走到 —— 测试全绿，
 * 调用方全红。
 */
test('动作类型：协议 / 实现白名单 / openapi 契约三方必须一致', () => {
  const protocol = read('src/shared/protocol.ts')
  const union = /export type ActionType =([\s\S]*?)\n\n/.exec(protocol)
  assert.ok(union, '找不到 protocol.ts 里的 ActionType 联合类型')
  const protocolSet = [...union[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort()
  assert.ok(protocolSet.length > 0, 'ActionType 解析为空，正则可能已失效')

  const impl = read('src/main/modules/localapi.ts')
  const implTypes = /const ACTION_TYPES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(impl)
  assert.ok(implTypes, '找不到 ACTION_TYPES 定义')
  const implSet = [...implTypes[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort()

  // 用「从 ActionType: 到下一个 schema」截取，而不是找「含 screenshot 的那一行」：
  // 原先的正则绑在一个即将被删掉的取值上，删掉它测试就找不到枚举了 ——
  // 那种测试会在「修好」的那一刻变红。
  const spec = read('docs/api/openapi.yaml')
  const specBlock = /^    ActionType:[\s\S]*?\n    Action:/m.exec(spec)
  assert.ok(specBlock, '找不到 openapi 里的 ActionType schema')
  const specEnum = /enum:\s*\[([^\]]*)\]/.exec(specBlock[0])
  assert.ok(specEnum, 'ActionType schema 里没有 enum')
  const specSet = specEnum[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()

  assert.deepEqual(implSet, protocolSet, 'localapi.ts 的 ACTION_TYPES 与 protocol.ts 的 ActionType 不一致')
  assert.deepEqual(specSet, protocolSet, 'openapi.yaml 的 ActionType.enum 与 protocol.ts 的 ActionType 不一致')
})

/**
 * 同一个漂移的另一半：`confirm` 这条旧契约不许回来。
 *
 * 文档里曾经有 `POST /v1/tasks/{id}/confirm` 和审计字段
 * `policy_decision: confirmed_by_user` —— 前者让「同意」变成一个可以调用的
 * HTTP 端点，后者让「用户确认过」变成调用方写的一句话。两样都不是笔误，
 * 是同一个设计错误的两面：同意可以由发起方声明。
 *
 * 所以这条钉住的不是某个字段名，而是「文档里不能再出现一条批准通道」。
 */
test('文档里不得再出现「请求体/端点即可批准」的旧契约', () => {
  const yaml = read('docs/api/openapi.yaml')
  const html = read('docs/api.html')

  assert.ok(!/\/confirm\b/.test(yaml), 'openapi.yaml 里又出现了 /confirm 端点')
  assert.ok(!/policy_decision/.test(yaml), 'openapi.yaml 里又出现了 policy_decision 字段')
  assert.ok(!/confirmed_by_user/.test(yaml), 'openapi.yaml 里又出现了 confirmed_by_user')
  assert.ok(!/\/confirm\b/.test(html), 'api.html 里又出现了 /confirm 端点')
  assert.ok(!/policy_decision|confirmed_by_user/.test(html), 'api.html 里又出现了 policy_decision / confirmed_by_user')

  // 三态必须写进文档：只写 409 不写码，调用方只能一律重试，
  // 而「一律重试」对着一个明确拒绝的动作就是在骚扰机器前的人。
  for (const code of ['E_CONSENT_DENIED', 'E_CONSENT_TIMEOUT', 'E_CONSENT_UNAVAILABLE']) {
    assert.ok(yaml.includes(code), `openapi.yaml 缺少同意失败的错误码 ${code}`)
    assert.ok(html.includes(code), `api.html 缺少同意失败的错误码 ${code}`)
  }
})

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

/* ────────── 11. 闸门前缀：写入方与淘汰策略必须共用一个常量 ────────── */

/**
 * `闸门·` 这个前缀有两个消费者：写入方（`modules/audit.ts` 决定 action 叫什么）
 * 和淘汰策略（`store/index.ts` 决定谁不被裁）。
 *
 * 两边各写一份字面量的后果是**静默的**：改了一边，记录照旧在写、审计链照旧通过，
 * 只是这批记录不再受保护了 —— 等真出事了才发现窗口里一条闸门记录都没有。
 * 所以这里断言：字面量只能出现在定义它的那个文件里，其余地方必须用常量。
 */
test('闸门前缀字面量只能出现在定义处，其他文件必须用 GATE_ACTION_PREFIX', () => {
  const DEFINITION = 'src/main/store/index.ts'
  const offenders: string[] = []

  for (const file of walk(join(ROOT, 'src/main'))) {
    const path = rel(file)
    if (path === DEFINITION) continue
    if (stripComments(readFileSync(file, 'utf8')).includes('闸门·')) offenders.push(path)
  }

  assert.deepEqual(
    offenders,
    [],
    '这些文件里直接写了「闸门·」字面量：' +
      offenders.join(', ') +
      '。改用 `import { GATE_ACTION_PREFIX } from "@main/store"` —— ' +
      '字面量写死的另一边会和淘汰策略对不上，而且不会报错。'
  )
})

/* ────────── 12. 失败分类必须覆盖每个失败返回 ────────── */

/**
 * `ActionResult.failure` 是界面选文案的依据。漏一处的后果不是崩溃，是那句
 * 写给模型的话原样漏到界面上 —— 「模型引用了不存在的元素 e3」。
 *
 * 形状断言而不是逐行点名：将来新增失败分支自动被覆盖，不需要有人记得来改这条。
 *
 * 一个必须排除的情况：注入到页面的那段脚本字符串里也有 `{ok:false,...}`，
 * 那是**页面侧**的返回值，由 `toActionResult` 统一补分类，不在这里管。
 * 用「位置落在单引号字符串里就跳过」来排除 —— 单引号奇偶性是粗判，
 * 但本文件里没有嵌套引号的写法，够用且不会随格式化失效。
 */
function inStringLiteral(text: string, at: number): boolean {
  let singles = 0
  for (let i = 0; i < at; i += 1) {
    if (text[i] === "'" && text[i - 1] !== '\\') singles += 1
  }
  return singles % 2 === 1
}

test('actions.ts 里每个失败返回都必须带 failure 分类', () => {
  const code = stripComments(read('src/main/agent/actions.ts'))
  const offenders: string[] = []

  for (const m of code.matchAll(/ok:\s*false/g)) {
    const at = m.index ?? 0
    if (inStringLiteral(code, at)) continue
    // 窗口取到对象字面量结束：正常写法是 { ok: false, message: ..., failure: 'x' }
    const window = code.slice(at, at + 200)
    if (!/failure:\s*'(?:not-found|exec)'/.test(window)) {
      offenders.push(code.slice(Math.max(0, at - 60), at + 60).replace(/\s+/g, ' '))
    }
  }

  assert.deepEqual(
    offenders,
    [],
    '这些 `ok: false` 没带 failure 分类：\n' +
      offenders.join('\n') +
      "\n改成 `{ ok: false, message: '…', failure: 'not-found' | 'exec' }`。"
  )
})

/* ────────────── 11. dev-only 诊断通道不得漏进构建产物 ────────────── */

/**
 * 这条断言读的是**构建产物**，不是源码 —— 所以它自带一个「测的产物是不是现在的源码」
 * 的前置判断。没有这个前置判断，它会以两种方式骗人：
 *
 *   1. 有人往源码里加了 `__SS_DIAG__` 但没 build → `out/` 里还是旧的、没有那个字符串
 *      → **断言通过**。这就是「让 AC-16 红了整整一轮」的那个原因，只是换了个位置。
 *   2. `out/` 不存在 → 如果静默 return，就是「没验」伪装成「通过」。
 *
 * 两种都必须走 skip，**不能走 pass** —— 过期和空是同一类：**没验，不是没问题**。
 * （同 `7d8fd63`：零条检查不打印「通过」。那次修的是「零条命中」，这次是「零条比对」。）
 *
 * ── 「现在还没有、将来会有」的断言，注释必须写清三件事 ──
 *   ① 现状：本断言当前是空的（源码里还没有这个通道）
 *   ② 生命周期：它会在通道落地那一刻自动生效，不需要有人记得回来加
 *   ③ 判据选择：为什么断「产物里没有」而不是「运行期没执行」——
 *      前者证明**不存在**，后者只证明**这次没走**
 * ① 是最重要的：**空断言只要自己承认是空的，就不是假绿。** 它和「看起来通过但没测到」
 * 的区别，只在于有没有这一行注释。
 *
 * ── 给实现侧的要求（这条断言检查不了，只能靠评审） ──
 *   · 必须用构建期常量（`define: { __SS_DEV__ }`）包住。运行期 `process.env.NODE_ENV`
 *     判断不行：打包后 `NODE_ENV` 常常是 undefined，不只是「分支还在包里」，是**可能误开**。
 *   · 通道内容不要放 `keys`（宿主 Intl 成员全名），用 `keysLength` 代替。
 *     `included` / `threw` 才是诊断需要的 —— 主动挂上 `keys` 等于留了「这里有人动过」的标记。
 */
test('dev-only 诊断通道不得出现在构建产物里', (t) => {
  /* ── 三态在「开发流程」和「发布门禁」下必须不同 ──
     默认（本地 / `npm run check`）：未测量 = skip。这是对的 —— 开发中不 build 是常态，
     为了这条断言强迫每次 `npm test` 都构建，代价远大于收益。
     但发布门禁不能这么算：一条**永远 skip** 的断言在门禁里等于不存在，
     而它在报告里看起来像「有一条覆盖」。所以门禁模式（`SS_REQUIRE_FRESH_BUILD=1`）
     下把「未测量」判成失败，逼流程先 build。

     这不是把 skip 改成 fail —— 是承认这两种场景对「未测量」的容忍度不一样。 */
  const REQUIRE_FRESH = process.env['SS_REQUIRE_FRESH_BUILD'] === '1'
  const notMeasured = (why: string): void => {
    if (REQUIRE_FRESH) {
      assert.fail(
        why +
          ' —— 门禁模式（SS_REQUIRE_FRESH_BUILD=1）下「未测量」按失败计：' +
          '发布门禁不能拿一条永远 skip 的断言充覆盖。先 npm run build 再跑。'
      )
    }
    t.skip(why)
  }

  const outPath = join(ROOT, 'out/main/index.js')
  let out: string
  try {
    out = readFileSync(outPath, 'utf8')
  } catch {
    notMeasured('没有 out/main/index.js —— 没验，不是没问题')
    return
  }

  // 前置：产物必须是现在的源码构建出来的。语义与 tools/check-build-fresh.mjs 保持一致
  // （那里是整个 out/ 对 src/ 取最新 mtime）。故意内联而不 import：
  // 这条断言的有效性不该悄悄依赖另一个脚本的当前实现。
  const newest = (dir: string): number => {
    let max = 0
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      try {
        const st = statSync(full)
        max = Math.max(max, st.isDirectory() ? newest(full) : st.mtimeMs)
      } catch {
        // 单个文件读不到不影响整体判断
      }
    }
    return max
  }
  let srcAt = 0
  let outAt = 0
  try {
    /* 新鲜度的比较范围收窄到「真的会进 out/main/index.js 的那几个目录」。
       原来对整个 src/ 取最新 mtime，于是**任何人改一行 renderer 都会让这条断言变成 skip** ——
       8 个人同时在改，实测这条几乎永远是 skip，也就是名义上覆盖、实际从未生效。
       判据的正确边界：这条断言只读 out/main/index.js，而只有 src/main 与 src/shared
       会进这个产物；renderer 里加 `__SS_DIAG__` 根本到不了这里，拿它判新鲜度是错配。 */
    srcAt = Math.max(newest(join(ROOT, 'src/main')), newest(join(ROOT, 'src/shared')))
    outAt = newest(join(ROOT, 'out'))
  } catch {
    notMeasured('src/ 或 out/ 不可读 —— 没验，不是没问题')
    return
  }
  if (srcAt > outAt) {
    notMeasured(
      `产物比源码旧 ${Math.round((srcAt - outAt) / 1000)} 秒，本断言未生效。` +
        '先 npm run build —— 否则源码里的 __SS_DIAG__ 不会出现在 out/ 里，断言会假绿。'
    )
    return
  }

  /* 判据：**代码里**不得出现，注释里可以出现。
     第一版直接在原文上搜，结果被一段解释性 JSDoc 判红 —— 那段注释写的正是
     「早先这里有 `__SS_DIAG__`，被这条断言挡下了」，而主进程产物**不压缩**，
     注释原样进 out/main/index.js。于是：

       想让它变绿，最直接的动作是删掉那段注释。

     那是把「记录为什么删掉这个通道」的说明删掉，只留下代码 —— 下一轮有人想加回来
     时看不到任何理由。**一条让注释成为违规的门禁，会主动销毁自己依赖的知识。**
     所以先剥注释再搜：符号出现在字符串字面量或标识符位置仍然会被抓到。 */
  const codeOnly = stripComments(out)
  assert.equal(
    /__SS_DIAG__/.test(codeOnly),
    false,
    '构建产物里出现了 __SS_DIAG__（代码位置，不是注释）。这个通道会暴露' +
      '「哪些 Intl 构造器被接管了」，跟着生产包发出去就是一个我们自己造的指纹。' +
      '用构建期常量把它从产物里消掉，不要靠运行期判断。'
  )
  // 自检：剥注释不能把整份产物剥没了，否则上面那条恒真
  assert.ok(
    codeOnly.length > out.length * 0.5,
    `剥注释后只剩 ${codeOnly.length} / ${out.length} 字节 —— 剥多了，上面的断言不可信`
  )
})

/* ─────────────────── seed 不得跨 IPC（类型 + 出口双重） ─────────────────── */

test('StoredProfile 只允许出现在 src/main/ 内', () => {
  // 这条守的是「seed 不出主进程」。
  //
  // 类型系统只做了一半：`Profile` 里没有 seed，所以读 `profile.seed` 会编译失败。
  // 但 TS 对**多字段是宽容的** —— 把 StoredProfile 直接 return 给声明为 Profile
  // 的位置，编译器不报错。所以还要有一条结构断言：这个类型名不许出现在
  // 共享层、preload、渲染层。出现在那里就意味着有人把明文种子带出了主进程。
  const offenders: string[] = []
  for (const file of sources()) {
    const name = rel(file)
    if (name.startsWith('src/main/')) continue
    // types.ts 里是定义处，允许
    if (name === 'src/shared/types.ts') continue
    const text = stripComments(readFileSync(file, 'utf8'))
    if (/\bStoredProfile\b/.test(text)) offenders.push(name)
  }
  assert.deepEqual(
    offenders,
    [],
    `以下文件引用了 StoredProfile（明文 seed 的内部形态）：${offenders.join(', ')}`
  )
})

test('Profile 类型不得包含 seed 字段', () => {
  const types = stripComments(read('src/shared/types.ts'))
  const decl = /export interface Profile \{[\s\S]*?\n\}/.exec(types)
  assert.ok(decl, '找不到 Profile 接口')
  assert.doesNotMatch(
    decl[0],
    /^\s*seed\s*\??:/m,
    'Profile 不得有 seed：它会被 profiles.list() 原样送到渲染层'
  )
  assert.match(decl[0], /^\s*seedHint\s*:/m, 'Profile 必须有 seedHint（界面对种子做等值比较要靠它）')
})

test('IPC 通道不得出现 preview 之外的种子计算入口', () => {
  // `profiles.preview` 是唯一允许「用种子算东西」的通道，且它只接受 platform。
  // 一旦有人加个 `preview(id, { screen, hardware })`，渲染层就获得了一个
  // 「按任意参数试探指纹」的接口 —— 那比泄漏种子更容易被滥用（不需要种子本身）。
  const handlers = stripComments(read('src/main/ipc/handlers.ts'))
  const block = /handle\(CH\.profiles\.preview[\s\S]*?\n  \}\)/.exec(handlers)
  assert.ok(block, '找不到 profiles.preview 的处理器')
  const fields = block[0].match(/\b(platform|screen|hardware|webgl|fonts|languages|timezone)\b/g) ?? []
  const extra = Array.from(new Set(fields)).filter((f) => f !== 'platform')
  assert.deepEqual(extra, [], `preview 只允许接受 platform，实际还读了：${extra.join(', ')}`)
})

/* ────────────────── 伪装状态点：界面不得自己判 ────────────────── */

/**
 * 为什么这条是结构断言而不是行为断言：
 *
 * 「界面画绿、门禁在拦」不会让任何测试变红 —— 两边各自都对，只是不一致。
 * 而它的后果是用户按界面去把整套机制关掉，因为它看起来在骗人。
 *
 * 所以从两个方向钉住：
 *   1. 渲染层不许碰门禁模块，也不许自己写 kind / 状态字面量；
 *   2. 那个点必须真的用 `maskToneOf` 上色，不能是硬编码的 class。
 */
test('渲染层不得自己判伪装严重度', () => {
  const offenders: string[] = []
  for (const file of sources()) {
    const name = rel(file)
    if (!name.startsWith('src/renderer/')) continue
    const text = stripComments(readFileSync(file, 'utf8'))
    if (/mask-gate/.test(text)) offenders.push(`${name}：import 了主进程判定模块`)
    // 只钉「伪装独有的词」和「拿 mask 行的 state/kind 去比对」两种。
    //
    // 不把 'degraded' / 'unknown' / 'missing' 一律封杀：`StoreHealthBanner`
    // 就有一个 `health.degraded`（存储降级），`latencyTier` 有 `'unknown'`。
    // 一条会误报的断言最后一定被加 skip，等于没有 —— 所以宁可窄。
    if (/'page-degraded'|"page-degraded"|'rolled-back'|"rolled-back"/.test(text)) {
      offenders.push(`${name}：自己写了伪装状态字面量（这是门禁独有的词）`)
    }
    if (/\bmask\w*\.(?:state|kind)\s*===|\brow\.(?:state|kind)\s*===/.test(text)) {
      offenders.push(`${name}：拿 mask 行的 state/kind 自己比对，应该用 maskToneOf`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `渲染层不得复写严重度判断（allow/kind/reason 一律由主进程的 judgeMask 给出）：${offenders.join('；')}`
  )
})

test('环境卡片的状态点必须由 maskToneOf 上色', () => {
  const card = read('src/renderer/components/ProfileCard.tsx')
  assert.match(card, /maskToneOf\s*\(/, 'ProfileCard 没用 maskToneOf：颜色就成了硬编码，跟门禁分家')
  assert.match(
    card,
    /mask-dot \$\{maskTone\}/,
    'ProfileCard 的 class 必须由 maskTone 拼出来，否则 CSS 里的 .ok/.warn/.block 和判定表无关'
  )
})

/**
 * 有读者才算接上了。这条防的是「加了 IPC 通道、界面没调」——
 * 那种情况下 `listMaskStates` 又变回零调用方，而注释里还写着已接。
 */
test('mask.list 必须有渲染层调用方', () => {
  const app = stripComments(read('src/renderer/App.tsx'))
  assert.match(app, /bridge\(\)\.mask\.list\(\)/, 'App.tsx 没调 mask.list()，状态点永远是空的')
  assert.match(app, /onMaskState\(/, 'App.tsx 没订阅伪装状态推送，点会停在首屏那一刻')
})
