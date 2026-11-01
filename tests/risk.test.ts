/**
 * 风险闸门的回归测试。
 *
 * 用 Node 22 自带的 node:test + 类型擦除，不引入任何测试框架。
 * risk.ts 只有 type-only import，擦除后可以直接被 Node 加载。
 *
 * 背景：这一层是「模型可以乱点、但执行器必须拦住」的最后一道闸。
 * 之前 click 动作因为只带元素编号，语义扫描拿到空串，点「立即支付」
 * 会被判成 L1 直接执行 —— 这些用例就是钉住这个行为。
 *
 * 跑法：node --experimental-strip-types --test tests/risk.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assessRisk } from '../src/main/agent/risk.ts'

test('点击「立即支付」必须判 L2', () => {
  const verdict = assessRisk({ type: 'click', id: 'e3' }, '帮我买那个最便宜的键盘', '立即支付')
  assert.equal(verdict.level, 'L2')
  assert.equal(verdict.matched, '立即支付')
})

test('点击「删除订单」必须判 L2', () => {
  const verdict = assessRisk({ type: 'click', id: 'e9' }, '清理一下', '删除订单')
  assert.equal(verdict.level, 'L2')
})

test('只读意图不能豁免扣款：说「采集」也拦得住支付', () => {
  // 这是修复前的第二个洞：readOnly 降级对所有规则生效，
  // 用户说「采集商品价格」，模型顺手点掉「立即支付」也不会被拦。
  const verdict = assessRisk({ type: 'click', id: 'e3' }, '采集这个页面的商品价格', '确认支付')
  assert.equal(verdict.level, 'L2', '只读意图不得把支付降级为 L1')
})

test('只读意图不能豁免删除', () => {
  const verdict = assessRisk({ type: 'click', id: 'e4' }, '查看一下列表', '清空购物车')
  assert.equal(verdict.level, 'L2')
})

test('只读意图可以豁免搜索表单提交，避免误伤', () => {
  const verdict = assessRisk({ type: 'click', id: 'e2' }, '采集这个页面的商品价格', '提交表单')
  assert.equal(verdict.level, 'L1', '搜索框提交不该每次都弹确认')
})

test('普通可逆点击是 L1', () => {
  const verdict = assessRisk({ type: 'click', id: 'e1' }, '打开设置页', '设置')
  assert.equal(verdict.level, 'L1')
})

test('extract / done 是 L0，不进闸门', () => {
  assert.equal(assessRisk({ type: 'extract', query: '价格' }, '采集价格').level, 'L0')
  assert.equal(assessRisk({ type: 'done', summary: '完成' }, '采集价格').level, 'L0')
})

test('输入框里写入含支付语义的文本也要拦', () => {
  // type 动作的 text 会进语义扫描，这是原有的正确行为，别被后续改动破坏
  const verdict = assessRisk({ type: 'type', id: 'e2', text: '确认支付' }, '填个备注')
  assert.equal(verdict.level, 'L2')
})

test('navigate 到支付页要拦', () => {
  const verdict = assessRisk({ type: 'navigate', url: 'https://example.com/checkout' }, '去看看')
  assert.equal(verdict.level, 'L2')
})

/* ------------------------------------------------------------------ *
 * send / submit 拆分
 *
 * 安全官评审结论：「发送」消息已送达对方、不可撤回；「提交」是本端状态
 * 变更、多数可回退。原先两条合并在一条规则里，只读意图会把两者一起放行，
 * 等于「帮我采集这个页面」顺手就能把采集结果群发出去。
 * ------------------------------------------------------------------ */

test('只读意图不能豁免「发送」：说「采集」也拦得住群发', () => {
  const verdict = assessRisk({ type: 'click', id: 'e7' }, '采集这个页面的商品价格', '发送')
  assert.equal(verdict.level, 'L2', 'send 已进 NEVER_DOWNGRADE')
  assert.equal(verdict.matched, '发送')
})

test('只读意图不能豁免「群发消息」', () => {
  const verdict = assessRisk({ type: 'click', id: 'e8' }, '整理一下联系人', '群发消息')
  assert.equal(verdict.level, 'L2')
})

test('提交订单仍按 order 判，不会被 submit 规则抢先放行', () => {
  // 规则表顺序即优先级：order 在 submit 之前，所以「提交订单」必须命中 order
  const verdict = assessRisk({ type: 'click', id: 'e5' }, '采集价格', '提交订单')
  assert.equal(verdict.level, 'L2')
  assert.equal(verdict.matched, '提交订单')
})

test('提交表单在只读意图下仍是 L1（拆分的另一半不能误伤搜索）', () => {
  const verdict = assessRisk({ type: 'click', id: 'e2' }, '采集这个页面的商品价格', '提交')
  assert.equal(verdict.level, 'L1')
  assert.equal(verdict.matched, '提交')
})

test('提交表单在非只读意图下是 L2（自己就是个需要确认的动作）', () => {
  const verdict = assessRisk({ type: 'click', id: 'e2' }, '帮我把这个表单填了', '提交表单')
  assert.equal(verdict.level, 'L2')
})

test('输入框里写「发送给张三」也要拦', () => {
  const verdict = assessRisk({ type: 'type', id: 'e2', text: '发送给张三' }, '填个备注')
  assert.equal(verdict.level, 'L2')
})

/* ──────────────── 对照集：闸门真正的分界线是「元素可读名」 ──────────────── */

/**
 * 下面两组是「应弹 / 不应弹」的对照，不是随便挑的例子。
 *
 * 起因：闸门改为把目标元素的可读名送进 haystack 之后，L2 弹窗频次会显著上升。
 * 这是正确方向的代价，但**代价有多大必须量化**，否则「修复」和「体验不可用」
 * 会被混为一谈。所以这里钉住两侧的边界，谁改规则谁先看这两组。
 *
 * 所有预期值都是**实测得到的**，不是按直觉写的 —— 边界词（加入购物车 / 立即购买 /
 * 清空筛选）按直觉猜十次错九次。
 */

const click = (name: string) => assessRisk({ type: 'click', id: 'e1' }, '采集这个页面的商品价格', name)

test('正常浏览操作不得触发确认', () => {
  // 这些是「采集商品价格」这类任务里最高频的点击，一次都不该弹
  const safe = ['搜索', '下一页', '查看更多', '加入购物车', '加入收藏', '重置', '下载图片']
  for (const name of safe) {
    assert.equal(click(name).level, 'L1', `点「${name}」不该要求确认`)
  }
})

test('英文正常操作不得触发确认', () => {
  // 特别注意 Sender name：send\b 不能匹配到 sender 里面去
  const safe = ['Search', 'Next page', 'Add to cart', 'Sign in', 'Log in', 'Clear filters', 'Sender name']
  for (const name of safe) {
    assert.equal(click(name).level, 'L1', `点「${name}」不该要求确认`)
  }
})

test('不可逆操作必须触发确认', () => {
  const risky: Array<[string, string]> = [
    ['立即购买', 'order'],
    ['结算', 'order'],
    ['提交订单', 'order'],
    ['删除', 'delete'],
    ['退订', 'delete'],
    ['退出登录', 'account'],
    ['发表评论', 'publish'],
    ['发送', 'send'],
    ['Checkout', 'pay'],
    ['Buy now', 'pay'],
    ['Place order', 'pay'],
    ['Send', 'send']
  ]
  for (const [name, category] of risky) {
    const v = click(name)
    assert.equal(v.level, 'L2', `点「${name}」必须要求确认（应命中 ${category}）`)
  }
})

/* ──────────────── 误伤修复后的回归护栏（曾经是 skip 债务） ──────────────── */

/**
 * 这三条原来是 skip，现在实现已经修好，转成永久护栏。
 *
 * 修法是给 delete 加了一条「动词必须紧跟筛选类宾语」的豁免：
 * `(清空|清除|重置|移除|取消|关闭)\s*(筛选|过滤|条件|搜索|…)`。
 * 关键是它**只豁免 delete 这一条**，不能整体短路——否则「清空筛选并支付」
 * 会在 delete 处直接返回 L1，把扣款放过去。
 *
 * 所以护栏必须两侧都钉：豁免生效的一侧 + 豁免不能溢出的一侧。
 */
test('筛选类操作已豁免，但同类动词的其他宾语仍必须拦', () => {
  assert.equal(click('清空筛选').level, 'L1')
  assert.equal(click('移除筛选条件').level, 'L1')

  // 豁免不能溢出：同样是「清空 / 移除」，宾语换成数据就必须拦
  for (const name of ['清空购物车', '移除成员', '取消订单', '清空', '移除']) {
    assert.equal(click(name).level, 'L2', `点「${name}」必须要求确认，豁免只针对筛选类宾语`)
  }
})

test('「转发」已并入 send 规则', () => {
  assert.equal(click('转发').level, 'L2')
  assert.equal(click('转发').matched, '转发')
  // 不能因为加词误伤正常浏览
  for (const name of ['下一页', '搜索', '查看更多']) {
    assert.equal(click(name).level, 'L1', `点「${name}」不该被 send 规则误伤`)
  }
})

/**
 * 这条是**反向**的：我原来提「`/pay\b/` 缺左边界，Repay 被判成 pay」，
 * 实现方否掉了，理由成立 ——
 *
 *   Repay（还款）/ Prepay（预付）/ Postpay（后付）本身就是支付动作。
 *   加左边界会让它们掉成 L1 自动执行，等于用「matched 文案更精确」
 *   换「漏判扣款」。分级是对的，不精确的只是 matched 的取值，属显示问题。
 *
 * 所以断言要写成「必须判 L2」，锁住这个判断，防止将来有人只看 matched
 * 不精确就顺手把左边界加上去。
 */
test('Repay / Prepay / Postpay 必须判 L2（不加左边界是有意的）', () => {
  for (const name of ['Repay', 'Prepay', 'Postpay', 'pay']) {
    const v = click(name)
    assert.equal(v.level, 'L2', `「${name}」是支付动作，判 L1 等于漏判扣款`)
  }
})

/* ──────────────── 仍然存在的缺口（债务） ──────────────── */

test(
  '「清除全部记录」必须判 L2',
  () => {
    assert.equal(click('清除全部记录').level, 'L2')
    assert.equal(click('清除历史').level, 'L2')
    assert.equal(click('清除缓存').level, 'L2')
    assert.equal(click('清除筛选').level, 'L1')
  }
)

test('同一意图连续评估两次，结果必须完全相同', () => {
  // 兜住 RegExp.lastIndex 残留这类跨调用状态：只要有人给规则加了 /g，
  // 第二次 exec 就会从上次位置继续，判定随调用次数漂移。
  const intent = '采集这个页面的商品价格'
  const a = assessRisk({ type: 'click', id: 'e1' }, intent, '删除')
  const b = assessRisk({ type: 'click', id: 'e1' }, intent, '删除')
  const c = assessRisk({ type: 'click', id: 'e1' }, intent, '删除')
  assert.deepEqual(a, b)
  assert.deepEqual(b, c)

  const d = assessRisk({ type: 'click', id: 'e2' }, intent, '下一页')
  const e = assessRisk({ type: 'click', id: 'e2' }, intent, '下一页')
  assert.deepEqual(d, e)
})

test(
  '「Continue with PayPal」必须判 L2',
  () => {
    assert.equal(click('Continue with PayPal').level, 'L2')
    // 防回退：补词不能把这两条改坏
    assert.equal(click('Repay').level, 'L2')
    assert.equal(click('Pay with PayPal').level, 'L2')
  }
)

test(
  '否定但未点名动作时不得降级',
  () => {
    assert.equal(assessRisk({ type: 'click', id: 'e1' }, '看看页面，别做任何操作', '提交').level, 'L2')
    assert.equal(assessRisk({ type: 'click', id: 'e1' }, '看看页面，别点任何按钮', '提交').level, 'L2')
    // 防回退：正常只读意图仍要能降级
    assert.equal(assessRisk({ type: 'click', id: 'e1' }, '采集商品价格', '提交').level, 'L1')
  }
)

/* ────────────── 10. 非拉丁语种：漏判方向与误伤方向必须分开测 ────────────── */

/**
 * 这一组是调查员实测后交过来的，我在 `risk.ts` 上逐条复跑过。
 *
 * 关键方法论点：**同一个词表的漏判和误伤是两个方向，不能用一个数字概括。**
 * 只看「覆盖率上升」会漏掉「噪音也上升」——本轮就发生了：补完非拉丁词表后，
 * 12 个正向样本里 11 个判了 L2（好转），但 12 个导航/设置类负样本**全部**被判 L2。
 *
 * 验收按不对称标准（这是安全侧的结论，我采纳）：
 *   pay / order  漏判 = 钱出去了；误伤 = 多点一次确认  → 允许误伤率上升
 *   delete / send / publish  反过来                    → 不允许
 * 所以这两条不能合并成一条「准确率」断言。
 */
test(
  '非拉丁语种的支付/下单按钮必须判 L2（漏判方向）',
  () => {
    const click = (name: string) => assessRisk({ type: 'click', id: 'e1' }, '帮我买这本书', name)
    const mustBeL2 = [
      '購入手続きへ',
      '注文を確定する',
      '支払いへ進む',
      '결제하기',
      'Zahlungspflichtig bestellen',
      'Passer la commande',
      'Realizar pedido',
      'Оформить заказ',
      '送信',
      '削除',
      '立即支付',
      'Place Order'
    ]
    // 断言等级而不是 matched：matched 为空才是当前表现，写成非空会在补词后依然过
    const stillL1 = mustBeL2.filter((n) => click(n).level !== 'L2')
    assert.deepEqual(stillL1, [], '这些按钮没判 L2：' + stillL1.join(' / '))
  }
)

test('导航/设置类非拉丁文本不得判 L2（误伤方向）', () => {
  const click = (name: string) => assessRisk({ type: 'click', id: 'e1' }, '采集这个页面的商品价格', name)

  /* ── 为什么必须成对断言，而不是只断言 L1 ──
     只断言「这些设置项是 L1」有一个致命弱点：**把词表删空，它们依然全绿**，
     而闸门对这门语言已经不存在了 —— 那是空对，绿得没有意义。
     所以对每个「有动词形态可对照」的词根，同时断言：
       宾语/设置形态 → L1      动作/祈使形态 → L2
     两者一起才证明「词根在表里，区分靠形态」。任何一边塌了都会红：
       词表删空     → 动作形态掉成 L1 → 红
       抑制被拆掉   → 设置形态升成 L2 → 红

     为什么不断言 `suppressed` 字段：那是实现细节。当前实现是在**匹配之前**就把
     设置形态滤掉了（`matched` 为空、`suppressed` 也为空），字段名和填充时机都可能再变。
     成对断言的判据是行为，实现换法不影响它。 */
  const paired: Array<{ root: string; objectForm: string[]; actionForm: string }> = [
    { root: '支払', objectForm: ['支払い方法', '支払い情報'], actionForm: '支払いへ進む' },
    { root: '注文', objectForm: ['注文履歴', '注文番号', 'ご注文内容の確認'], actionForm: '注文を確定する' },
    { root: '결제', objectForm: ['결제수단'], actionForm: '결제하기' },
    { root: 'pedido', objectForm: ['Mis pedidos'], actionForm: 'Realizar pedido' }
  ]
  for (const { root, objectForm, actionForm } of paired) {
    assert.equal(click(actionForm).level, 'L2', `「${actionForm}」是下单动作，必须 L2（这是对照组）`)
    for (const name of objectForm) {
      assert.equal(
        click(name).level,
        'L1',
        `「${name}」是设置/导航项，不该要求确认（同词根 ${root}，对照「${actionForm}」为 L2）`
      )
    }
  }

  /* ── 无法配对的一组：只证明「不误伤」，不证明「已覆盖」 ──
     这几个词根在正向样本里没有对应的动作形态，所以成对断言做不出来。
     它们的真实状态是「当前判 L1」，但 L1 可能来自抑制，也可能来自词表里根本没有这个词根。
     两种都不误伤，但只有前者说明闸门认识这门语言。
     **要升级这组，需要先补正向样本**，而不是把这里的断言改强 —— 那会变成用一个猜测去验另一个猜测。 */
  const unpaired = ['주문내역', '주문 조회', 'Мои заказы', 'Способы оплаты']
  const wrong = unpaired.filter((n) => click(n).level === 'L2')
  assert.deepEqual(wrong, [], '这些设置/导航文本被判成 L2（误伤）：' + wrong.join(' / '))

  /* ── 刻意不在词表里的词 ──
     Zahlen 是德语「数字」，与购物无关；它与动词 zahlen（支付）同形，词表层面无法区分，
     收进来等于给每个分页器弹确认。所以正确状态是「零命中」，
     而不是「命中后被抑制」—— 这两者的断言必须不同，否则改坏了也看不出来。 */
  const zahlen = click('Zahlen')
  assert.equal(zahlen.level, 'L1')
  assert.equal(zahlen.matched, undefined, 'Zahlen 不该命中任何规则')
  assert.equal(zahlen.suppressed, undefined, 'Zahlen 是词表外词，不是被抑制的')
})

test('只读意图下的中文导航/搜索类不得误伤（防止用放宽豁免来修上面那条）', () => {
  // 这条现在是绿的，作用是把「修误伤」这件事钉在正确方向上：
  // 如果有人靠扩大 READ_ONLY_HINTS 或 REVERSIBLE_CLEAR 来让非拉丁负样本变绿，
  // 中文这一组会先红 —— 而中文这组是已经调好的基线，不能为了修外语而回退。
  const click = (name: string) => assessRisk({ type: 'click', id: 'e1' }, '采集这个页面的商品价格', name)
  const mustBeL1 = [
    '搜索',
    '提交搜索',
    '下一页',
    '查看更多',
    '筛选',
    '排序',
    '清空筛选',
    '立即搜索',
    '按价格排序',
    '展开全部',
    '加载更多',
    '返回顶部'
  ]
  const wrong = mustBeL1.filter((n) => click(n).level === 'L2')
  assert.deepEqual(wrong, [], '中文只读导航类出现误伤（这是回归，不是新缺口）：' + wrong.join(' / '))
})

/* ────────────── 11. 空跑检测：L1 不等于「测过了」 ────────────── */

/**
 * 这一条守的也是测量的有效性，和上一条是同一族的两个面：
 *   #12 同源：绿来自「测试和实现共谋」（样本被抄进词表）
 *   #11 空跑：绿来自「规则压根没碰到样本」
 *
 * 为什么必须单独一条：负样本的判据是 `level === 'L1'`，而 **L1 有两个来源**——
 * 「命中后被抑制」和「一条规则都没碰到」。后者加多少词都不会变，总数照样好看。
 * 调查员在他那份 22 条留出集上量到 9 条空跑，就是这个问题。
 *
 * 为什么不用 `suppressed` 字段当判据：当前实现里它只在「命中后按只读意图降级」
 * 那条路径上赋值，名词抑制路径上压根没有这个字段。实测 15 条负样本
 * `suppressed` 全是 `undefined` —— 拿它当判据会造出一批恒假的断言。
 * 这是第二次踩同一个坑（第一次是拿 `matched === undefined` 当「被抑制」）。
 *
 * 所以判据改成**机械的**：把 VOCAB 里的正则逐条编译，看样本到底能不能被任何
 * 一条碰到。用词表（数据）判，不用判定逻辑（实现）判 —— 不引入同源。
 *
 * 实测（`risk.ts` mtime 01:26:06，样本 23 条）：
 *   能碰到 + 判 L1   14 条  ← 真抑制
 *   碰不到 + 判 L1    9 条  ← 空跑，全部记在 KNOWN_IDLE 里
 */
test('每条非拉丁负样本都必须被某条规则碰到过（防空跑）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/main/agent/risk.ts', import.meta.url), 'utf8')
  const start = src.indexOf('const VOCAB')
  const end = src.indexOf('function buildRule')
  assert.ok(start > 0 && end > start, 'VOCAB 段落定位失败 —— 改结构时请同步更新本测试')
  const vocabBlock = src.slice(start, end)

  // 手写扫描，理由同第 12 条：正则字面量里的引号会让类型擦除器误判成
  // 「未闭合的正则」（ERR_INVALID_TYPESCRIPT_SYNTAX）
  const QUOTE = String.fromCharCode(39)
  const BACKSLASH = String.fromCharCode(92)
  const entries: string[] = []
  let i = 0
  while (i < vocabBlock.length) {
    if (vocabBlock[i] !== QUOTE) {
      i++
      continue
    }
    let j = i + 1
    let buf = ''
    while (j < vocabBlock.length) {
      const ch = vocabBlock[j]
      if (ch === BACKSLASH) {
        buf += ch + (vocabBlock[j + 1] ?? '')
        j += 2
        continue
      }
      if (ch === QUOTE) break
      buf += ch
      j++
    }
    if (buf.length > 1) entries.push(buf)
    i = j + 1
  }

  /* 条目是**正则源码**（`buildRule` 直接 new RegExp 拼起来），不是字面子串。
     判「规则碰不碰得到」必须编译后再测。用 includes 会漏掉
     `passer\s+la\s+commande` 这种句式条目 —— 我第一版就是这么做，
     把 `Passer la commande` 判成了空跑，而它明明判 L2。 */
  const rules: RegExp[] = []
  for (const entry of entries) {
    const source = (entry.startsWith('!') ? entry.slice(1) : entry)
      .split(BACKSLASH + BACKSLASH)
      .join(BACKSLASH)
    if (source.length < 2) continue
    try {
      rules.push(new RegExp(source, 'i'))
    } catch {
      /* 不是合法正则的条目跳过 */
    }
  }
  // 双侧自检：解析失败时 `rules` 为空，于是「每条样本都没被碰到」——
  // 那会把 16 条全报成空跑。这个不对称在第 5 条结构断言里已经害过我一次。
  // 阈值贴着实测值（210 条）取，不留 4 倍余量 —— 留太宽等于没自检。
  assert.ok(
    rules.length > 150,
    `只编译出 ${rules.length} 条词表规则（实测应为 210 上下）—— 这是解析失败，` +
      '不是「全部空跑」。检查 VOCAB 的定位锚点或条目写法是否变了'
  )

  const samples = [
    // 有对照动作形态的宾语/设置形态
    '支払い方法', '支払い情報', '注文履歴', '注文番号', 'ご注文内容の確認', '결제수단', 'Mis pedidos',
    // 无法配对的设置/导航形态
    '주문내역', '주문 조회', 'Мои заказы', 'Способы оплаты',
    // 调查员留出集里点名的「名词前置」形态
    'Estado del pedido', 'Оплата выполнена', '支払い完了', '주문 상태', 'Historique des commandes',
    // 设置页 / 状态页措辞（德法西英中各一条）
    'Zahlungsmethode', 'Bestellstatus', 'Zahlung erfolgreich',
    'Paiement effectué', 'Pago realizado', 'Order status',
    /* 中文这一组是**内部不对称**的对照组，不是凑数：
       pay 侧有裸词根「支付」→ `支付方式` 命中后被抑制（真在测抑制机制）；
       order 侧只有「!提交订单」「!确认订单」这类短语，没有裸「订单」→
       `订单查询` / `订单历史` / `订单状态` 压根碰不到规则（空跑）。
       两条都显示 L1、都 PASS，但只有前者能捕捉「抑制机制坏了」。 */
    '支付方式', '订单查询', '订单历史', '订单状态',
    // 刻意留在词表外
    'Zahlen'
  ]

  /* ── 已知空跑台账 ──
     只有「刻意为之」和「已确认的缺口」两种可以留在这里，且每条要写清是哪一种。
     修好之后从台账删掉，这条断言会告诉你（见下面的 stale）。 */
  const KNOWN_IDLE = [
    // 刻意：与德语动词 zahlen（支付）同形，收进词表等于给每个分页器弹确认
    'Zahlen',
    /* 缺口（结构性的）：词表是按**动作动词**建的，而设置页 / 状态页的措辞是
       名词复合、没有动词。所以这一类**天然碰不到规则**，空跑率会一直是 100%。
       调查员在 20 条留出集里量到 8 条属这一类，集中在德法西俄四门语言。
       注意中文也在里面（`订单查询`）—— 不是「外语没覆盖」，是「这类文本没覆盖」。
       要修不能靠加词：加 `Zahlungsmethode` 只会让下一个 `Zahlungsart` 继续空跑。
       得先决定「设置页文本要不要进闸门」—— 那是产品口径，不是词表问题。 */
    'Zahlungsmethode',
    'Bestellstatus',
    'Zahlung erfolgreich',
    'Paiement effectué',
    'Pago realizado',
    'Order status',
    /* 中文 order 侧的缺口 —— 但**不是**「order 整类没覆盖」，这一点要说准：
       order 机制本身有活样本：`注文履歴`（日，抑制 `注文`）、`Mis pedidos`（西，抑制 `pedido`）。
       缺的是**中文**的裸词根：中文 order 侧只有「!提交订单」「!确认订单」这类短语，
       没有裸「订单」，所以这三条压根碰不到规则。
       按机制分组会把它读成「order 有覆盖」，按语言×机制分组才看得见这个洞。
       修法很便宜：补一个裸 `订单` 词根 + 让名词后缀抑制生效，不需要改架构。 */
    '订单查询',
    '订单历史',
    '订单状态',
    // 缺口：法语只有「动词 + commande」句式，没有裸名词条目，所以名词形态
    // 连规则都碰不到。要修得先补 `commande` 的名词形态 + 抑制规则。
    'Historique des commandes'
  ]

  const idle = samples.filter((s) => !rules.some((r) => r.test(s)))
  const unexpected = idle.filter((s) => !KNOWN_IDLE.includes(s))
  const stale = KNOWN_IDLE.filter((s) => !idle.includes(s))

  assert.deepEqual(
    { unexpected, stale },
    { unexpected: [], stale: [] },
    '空跑检测。\n' +
      `unexpected（这些样本一条规则都没碰到，它们的 L1 是空跑，不是「抑制成功」）：${unexpected.join(' / ') || '无'}\n` +
      `stale（已知缺口里这些现在能被规则碰到了，请从 KNOWN_IDLE 删掉）：${stale.join(' / ') || '无'}`
  )

  /* ── 两条独立判据必须给同一个答案 ──
     上面那条是**机械判据**：词表里有没有一条正则在样本上匹配到。
     这一条是**行为判据**：`assessRisk` 有没有留下「我碰到过它」的痕迹。

     为什么两条都要：
       只有机械判据 → 词表解析错了会给出「全部空跑」，看起来像产品缺陷；
       只有行为判据 → 实现一改（比如不再填 `suppressed`）就全部变「空跑」，
                     而产品其实没变 —— 判据在测实现形状，不是测被测对象。

     实测（risk.ts mtime 01:58:10）两条完全一致：
       碰到规则的 14 条都带 `suppressed: ["<词根>"]`
       空跑的 9 条 `suppressed` / `matched` 都是 undefined
     所以「不一致」在这个时点一定是某一边坏了，值得红一次。

     注意：这条**不能**当成「suppressed 是可靠接口」来用。它只在
     「命中后被抑制」这条路径上填；`REVERSIBLE_CLEAR` 与末尾兜底 return 都可能丢。
     这里只用它做**交叉校验**，不用它当主判据。 */
  const click = (name: string): { level: string; matched?: string; suppressed?: string | string[] } =>
    assessRisk({ type: 'click', id: 'e1' }, '采集这个页面的商品价格', name) as {
      level: string
      matched?: string
      suppressed?: string | string[]
    }
  const behaviorallyIdle = samples.filter((s) => {
    const v = click(s)
    return v.matched === undefined && v.suppressed === undefined
  })
  assert.deepEqual(
    behaviorallyIdle.slice().sort(),
    idle.slice().sort(),
    '两条判据对「哪些样本是空跑」给出了不同答案 —— 必有一边坏了。\n' +
      `机械判据（词表正则）判空跑：${idle.join(' / ') || '无'}\n` +
      `行为判据（matched/suppressed 都没填）判空跑：${behaviorallyIdle.join(' / ') || '无'}\n` +
      '若机械判据说「碰到了」而行为判据说「没碰到」→ 抑制路径不再留痕，审计会退回兜底文案；\n' +
      '若反过来 → 词表解析失效，上面的空跑名单不可信。'
  )
})



/**
 * 这一条守的不是行为，是**测量的有效性**。
 *
 * 本轮真实发生过：修「非拉丁语种误伤」时，我把调查员给的 12 条正向样本里
 * 的 6 条**原样抄进了 VOCAB**（`支払いへ進む` / `注文を確定する` / `결제하기` /
 * `realizar pedido` / `去结算` / `valider la commande`）。于是那 6 条立刻变绿，
 * 而它们变绿的原因不是闸门学会了判定，是我把答案写进了规则。
 *
 * 这比假绿更坏：假绿是「没测到却报通过」，这是「用被测对象的副本去测被测对象」，
 * 换个人来看代码是看不出问题的 —— 词表里多一条日文短语，看起来完全合理。
 *
 * 所以这里做机械检查：**任何测试样本只要在 VOCAB 里逐字出现，就判这条样本失效。**
 * 合法的样本只有两种形态：
 *   1. 词根 + 后缀（`支払い方法` = `支払` + `い方法`）—— 考的是抑制规则
 *   2. 词表外的短语（`Zahlen`）—— 考的是「不该命中」
 * 逐字复制不在这两种里。
 */
/* ────────────── 12. 同源检测：样本不得是词表条目的复制 ────────────── */

test('测试样本不得是词表条目的逐字复制（同源检测）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/main/agent/risk.ts', import.meta.url), 'utf8')

  // 取出 VOCAB 对象那一整段，再从里面抽所有字符串字面量
  const start = src.indexOf('const VOCAB')
  const end = src.indexOf('function buildRule')
  assert.ok(start > 0 && end > start, 'VOCAB 段落定位失败 —— 改结构时请同步更新本测试')
  const vocabBlock = src.slice(start, end)
  const entries = new Set<string>()
  // 手写扫描而不是正则：正则字面量里带引号会让 Node 的类型擦除器误判成
  // 「未闭合的正则」（ERR_INVALID_TYPESCRIPT_SYNTAX），这是工具链的坑不是逻辑的坑。
  const QUOTE = String.fromCharCode(39)
  const BACKSLASH = String.fromCharCode(92)
  let i = 0
  while (i < vocabBlock.length) {
    if (vocabBlock[i] !== QUOTE) {
      i++
      continue
    }
    let j = i + 1
    let buf = ''
    while (j < vocabBlock.length) {
      const ch = vocabBlock[j]
      if (ch === BACKSLASH) {
        buf += ch + (vocabBlock[j + 1] ?? '')
        j += 2
        continue
      }
      if (ch === QUOTE) break
      buf += ch
      j++
    }
    if (buf.length > 0) entries.add(buf)
    i = j + 1
  }
  assert.ok(entries.size > 50, `词表条目只抽到 ${entries.size} 条，抽取逻辑可能失效`)

  // 只检查**泛化类**样本 —— 也就是本轮为了修「非拉丁语种」而新增的那些。
  //
  // 为什么不检查全部样本：`删除` / `发送` / `提交` 这类基础词，在词表里逐字存在
  // 是**正确的** —— 测它们等于测「词表有没有接上判定路径」，那是表覆盖测试，
  // 不是泛化测试。把两者混在一起，要么这个检查被噪声压死，要么为了让它变绿
  // 把基础词从词表里删掉。两种都是把测量工具的问题变成产品的问题。
  //
  // 真正要防的是另一种：新增样本 → 样本不通过 → 把样本抄进词表 → 通过。
  // 这只可能发生在泛化类样本上。
  const samples = [
    '購入手続きへ', '注文を確定する', '支払いへ進む', '결제하기',
    'Zahlungspflichtig bestellen', 'Passer la commande', 'Realizar pedido', 'Оформить заказ',
    '支払い方法', '支払い情報', '注文履歴', '注文番号', 'ご注文内容の確認',
    '결제수단', '주문내역', '주문 조회', 'Zahlen', 'Mis pedidos', 'Мои заказы', 'Способы оплаты',
    '清除全部记录', '清除历史', '清除缓存', '清除筛选',
    'Continue with PayPal', 'Pay with PayPal'
  ]

  const copied = samples.filter((s) => entries.has(s))
  assert.deepEqual(
    copied,
    [],
    '这些样本在 VOCAB 里逐字存在，测它们等于测「词表里有没有这个词」：' +
      copied.join(' / ') +
      '。要么换样本，要么把词表条目改成词根 + 抑制规则。'
  )
})

/* ─────────────────── 输出长度：对话框与审计必须扛得住 ─────────────────── */

test('命中词与理由必须有界（模型自述可写 10KB）', () => {
  // `log\s*out` 的 `\s*` 没有上界，所以这一串会整段成为 `matched`。
  // 实测：matched.length = 5014、reason.length = 5045，系统对话框正文变成 5KB。
  // 不带宾语：'out method' 会被名词抑制规则吃成 L1，那样测不到 L2 分支
  const padded = 'log' + ' '.repeat(5000) + 'out'
  const verdict = assessRisk({ type: 'click', id: 'e1' }, '', padded)

  assert.equal(verdict.level, 'L2', '这仍然是不可逆动作，截断不许改判定')
  const matched = verdict.matched ?? ''
  assert.ok(
    matched.length <= 60,
    `matched 没被截：长度 ${String(matched.length)}，值 ${JSON.stringify(matched.slice(0, 80))}`
  )
  assert.match(matched, /截断/, '截断必须可见，否则读者会以为命中的就是这几个字')
  assert.ok(verdict.reason.length <= 340, `reason 没被截：长度 ${String(verdict.reason.length)}`)
})

test('截的是输出，不是输入（否则尾部危险词就成了旁路）', () => {
  // 这是上一条的**反向**：如果有人把修法写成「先把 extra 截到 2000 字再判定」，
  // 模型只要先写 4000 个无害字符，把危险词挤到截断点之后就能绕过闸门。
  // 判定必须看到全文，只有往外说的话需要有界。
  const tail = 'x'.repeat(4000) + ' 删除全部订单'
  const verdict = assessRisk({ type: 'click', id: 'e1' }, '', tail)
  assert.equal(verdict.level, 'L2', '尾部 4000 字之后的危险词仍必须命中')
})
