const fs = require('fs')
const f = 'src/main/agent/risk.ts'
let s = fs.readFileSync(f, 'utf8')

// 用 String.raw 写锚点：源码里的正则转义是「两个反斜杠」，普通 JS 字符串会吃掉一个。
const orderAnchor = String.raw`    'order\s*now', 'submit\s*order', 'checkout',`
if (!s.includes(orderAnchor)) throw new Error('order anchor missing')
s = s.replace(
  orderAnchor,
  orderAnchor +
    '\n' +
    '    // 英文下单动作短语。原先只有 `!place\\s*order`，于是「Place your order」\n' +
    '    // 这类最常见的下单按钮（中间插一个限定词）直接漏判 L1 —— 无人值守时\n' +
    '    // 是不弹确认直接扣款。限定词一律可选：宁可多问一次。\n' +
    String.raw`    '!place\s+(?:your\s+|the\s+|my\s+|a\s+)?order',` + '\n' +
    String.raw`    '!confirm\s+(?:your\s+|the\s+|my\s+|a\s+)?order',` + '\n' +
    String.raw`    '!submit\s+(?:your\s+|the\s+|my\s+|a\s+)?order',` + '\n' +
    String.raw`    '!complete\s+(?:your\s+|the\s+|my\s+|a\s+)?order',` + '\n' +
    String.raw`    '!process\s+order',` + '\n' +
    '    // 裸 Buy 也要拦：商品页的「Buy」就是下单按钮，而中文「立即购买」本来就被拦。\n' +
    String.raw`    '!buy\b',`
)

const payAnchor = String.raw`    '!buy\s*now', '!buy\s+it\s+now',`
if (!s.includes(payAnchor)) throw new Error('pay anchor missing')
s = s.replace(
  payAnchor,
  payAnchor +
    '\n' +
    String.raw`    '!pay\s*now', '!complete\s+payment', '!process\s+payment',`
)

const deleteAnchor = String.raw`    'delete', 'remove', 'destroy', 'unsubscribe', 'clear\s*all',`
if (!s.includes(deleteAnchor)) throw new Error('delete anchor missing')
s = s.replace(
  deleteAnchor,
  deleteAnchor +
    '\n' +
    '    // 取消订单 / 退款：中文「取消订单」本来就在表里，英文缺失造成了中英不一致。\n' +
    String.raw`    '!cancel\s+(?:my\s+|the\s+|a\s+)?order',` + '\n' +
    String.raw`    '!refund', '!cancel\s+refund',`
)

fs.writeFileSync(f, s)
console.log('vocab extended ok')
