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
  {
    skip:
      '实测判 L1。根因是词表不对称：delete 规则有 删除|清空|移除|销毁|格式化|退订|取消订单，' +
      '**没有「清除」**；而筛选豁免里用了「清除」。于是「清除全部记录」「清除历史」「清除缓存」' +
      '两头都匹配不上，直接落到兜底的 L1 —— 这是不可逆的数据删除，必须拦。' +
      '修法：delete 规则补「清除」，同时确认豁免的「清除」只对筛选类宾语生效（豁免在前，能挡住）。' +
      '取消 skip 的条件：这三条回到 L2，且「清除筛选」仍是 L1。'
  },
  () => {
    assert.equal(click('清除全部记录').level, 'L2')
    assert.equal(click('清除历史').level, 'L2')
    assert.equal(click('清除缓存').level, 'L2')
    assert.equal(click('清除筛选').level, 'L1')
  }
)
