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
