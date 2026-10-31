/**
 * 风险分级。
 *
 * 判定发生在 **agent loop**（src/main/agent/loop.ts），不依赖模型自觉：
 * 模型可以自称「这是安全的」，但只要有不可逆语义命中，就一定要人在回路确认。
 *
 * 注意：本地 API（src/main/modules/localapi.ts）与脚本回放（src/main/modules/scripts.ts）
 * 不经过 loop，它们必须自己调 assessRisk 并把结论带进执行器 —— 这是 A14 要补的口子。
 *
 * L0 只读 / L1 可逆（改变页面状态但能退回）/ L2 不可逆（必须人工确认）
 */
import type { Action, RiskLevel, RiskVerdict } from '@shared/protocol'

interface RiskRule {
  /** 命中后用于生成具体理由 */
  category: 'pay' | 'order' | 'account' | 'delete' | 'publish' | 'send' | 'submit'
  re: RegExp
  reason: string
}

/**
 * 不可逆语义表。中文词 + 英文词双覆盖，顺序即优先级：
 * 先判钱，再判账号，再判删除，最后判「发出去就收不回」的发布/发送。
 */
const RULES: RiskRule[] = [
  {
    category: 'pay',
    // 左边界**故意不加**。我一度改成 `\bpay\b` 想修「Repay 被匹配成 pay」，
    // 那是错的：Repay（还款）/ Prepay（预付）/ Postpay（后付）本身就是支付动作，
    // 加了左边界它们会掉成 L1 自动执行 —— 用「诊断文案不精确」换「漏判扣款」。
    // 真正的缺陷只是 matched 报的是 "pay" 而不是 "Repay"，属显示问题，分级是对的。
    re: /支付|付款|付钱|转账|汇款|充值|打款|确认支付|立即支付|pay\b|payment|checkout|purchase|transfer|buy\s*now|place\s*order|confirm\s*pay/i,
    reason: '这一步会发起支付并产生扣款，确认后才会执行'
  },
  {
    category: 'order',
    re: /下单|提交订单|确认订单|购买|结算|立即购买|抢购|order\s*now|submit\s*order|checkout/i,
    reason: '这一步会提交订单，确认后才会执行'
  },
  {
    category: 'account',
    re: /注销|解绑|换绑|退出登录|退出帐号|删除账号|删除帐号|log\s*out|sign\s*out|deactivate|unlink|delete\s*account/i,
    reason: '这一步会改动账号绑定或登录状态，确认后才会执行'
  },
  {
    category: 'delete',
    re: /删除|清空|移除|销毁|格式化|退订|取消订单|delete|remove|destroy|unsubscribe|clear\s*all/i,
    reason: '这一步会删除数据且无法撤销，确认后才会执行'
  },
  {
    category: 'publish',
    re: /发布|发表|公开|上架|publish|post\s*publicly|go\s*live/i,
    reason: '这一步会把内容公开发布，确认后才会执行'
  },
  {
    category: 'send',
    // 「发送」= 消息已经送达对方、撤不回来。私信、群发、推送、通知都属此类。
    re: /发送|群发|推送|发消息|发私信|发送给|转发|broadcast|notify|send\b|\bforward\b/i,
    reason: '这一步会把内容发送给对方且无法撤回，确认后才会执行'
  },
  {
    category: 'submit',
    // 「提交」= 本端状态变更，多数可回退（搜索框提交、表单保存）。
    // 单独成类是为了和 send 分开：结账类按钮通常写作「提交订单」，
    // 那种会先命中上面的 order 规则，不会被这里放行。
    re: /提交表单|提交|submit/i,
    reason: '这一步会提交表单并改变页面状态，确认后才会执行'
  }
]

/**
 * 可逆的「清除」类动作。
 *
 * 「清空筛选」「移除筛选条件」命中的是 delete 规则里的「清空 / 移除」，
 * 但它只影响当前视图，不删任何数据 —— 每次都弹确认会把闸门变成噪音，
 * 而噪音化的闸门等于没有闸门：用户会条件反射地点「允许」。
 *
 * 要求动词后面**紧跟**筛选类宾语，所以「清空购物车」「移除成员」「取消订单」
 * 都不会命中。
 */
const REVERSIBLE_CLEAR =
  /(清空|清除|重置|移除|取消|关闭)\s*(筛选|过滤|条件|搜索|筛选器|过滤条件|筛选条件|搜索条件)|(clear|reset)\s+(filter|filters|search)/i

/**
 * 意图里出现这些词，说明用户只想看/取，不想要副作用 → L2 降 L1
 */
const READ_ONLY_HINTS = [
  '收集',
  '采集',
  '提取',
  '抓取',
  '统计',
  '看一下',
  '看看',
  '查看',
  '读取',
  '列出',
  '整理'
]

/**
 * 意图里的「写」信号。出现任意一个，就不再认为这是纯只读任务。
 *
 * 这是安全官在 A14 评审时点出来的洞：「清空搜索框，然后搜索」这种意图里
 * 含「清空」二字，命中 delete 规则；而意图又含「搜索」（只读提示词）——
 * 于是 delete 被降级成 L1 自动执行。用户本意是清空搜索框，模型却可能清掉别的东西。
 *
 * 只读豁免的前提应该是**意图里没有任何写动作**，而不是「碰巧含某个只读动词」。
 */
const WRITE_HINTS = [
  '清空',
  '清除',
  '删除',
  '移除',
  '提交',
  '保存',
  '发送',
  '发布',
  '下单',
  '购买',
  '支付',
  '付款',
  '填写',
  '填入',
  '输入',
  '点击',
  '勾选',
  '选择',
  '上传',
  '下载'
]

function hitReadOnlyIntent(intent: string): string | undefined {
  const hit = READ_ONLY_HINTS.find((w) => intent.includes(w))
  if (!hit) return undefined
  // 意图里同时出现写信号 → 不算纯只读
  const write = WRITE_HINTS.find((w) => intent.includes(w))
  return write ? undefined : hit
}

/** 把动作里所有可能承载语义的字段拼成一串，统一扫描 */
function haystackOf(action: Action, extra: string): string {
  // click 的元素名不在 Action 里（模型只给编号），所以调用方必须把目标元素的
  // 可读名传进来 —— 否则点「立即支付」时这里扫到的是空串，永远判不出 L2。
  return [action.text, action.url, action.query, action.summary, action.key, extra]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' ')
}

/**
 * 这几类即使意图是「采集 / 查看」也不降级。
 * 用户说「帮我采集这个页面的商品价格」，不代表允许模型顺手点掉「立即支付」，
 * 也不代表允许它把采集结果「发送」给某个联系人 —— 只读意图只能豁免
 * 搜索框提交这类本端可回退动作。
 *
 * send 单列进这里是安全官评审的结论：「发送」消息已送达对方、不可撤回；
 * 「提交」是本端状态变更、多数可回退。两者混在一条规则里，
 * 会导致「提交搜索表单」和「群发消息」被同等对待，只能二选一地错。
 */
const NEVER_DOWNGRADE = new Set<RiskRule['category']>([
  'pay',
  'order',
  'account',
  'delete',
  'publish',
  'send'
])

/**
 * 是否允许因为「用户只想采集」而把命中项降级。
 *
 * 判定只看**语义类别**，不看动作类型。早先这里写过「click 一律不降级」，
 * 那个版本被推翻了：它会连「在搜索框里点提交」都弹确认，实测体验不可用；
 * 而它想堵的洞（只读任务里顺手点掉支付）其实已经由 NEVER_DOWNGRADE
 * 里的 pay/order/account/delete 堵住了 —— 类别本身已经承载了不可逆性，
 * 再叠一层动作类型判断只是增加误伤。
 */
function canDowngrade(category: RiskRule['category']): boolean {
  return !NEVER_DOWNGRADE.has(category)
}

function levelOf(action: Action): RiskLevel {
  switch (action.type) {
    case 'extract':
    case 'done':
      return 'L0'
    default:
      return 'L1'
  }
}

/**
 * 评估一步动作的风险。
 * @param action 待执行动作
 * @param intent 用户的原始任务意图（用于判断是否只是采集/查看）
 * @param extra 目标元素的可读名与模型自述，click 这类只有编号的动作必须靠它提供语义
 */
export function assessRisk(action: Action, intent: string, extra = ''): RiskVerdict {
  // 只读动作没有副作用，先短路，避免 extract 的 query 里出现「价格统计」之类误伤
  if (action.type === 'extract' || action.type === 'done') {
    return {
      level: 'L0',
      reason: action.type === 'extract' ? '只记录取数指令，不操作页面' : '结束任务，无页面副作用'
    }
  }

  const hay = haystackOf(action, extra)
  for (const rule of RULES) {
    const m = rule.re.exec(hay)
    if (!m) {
      continue
    }
    // 「清空筛选」这类只豁免 delete 这一条，不能整体短路 ——
    // 否则「清空筛选并支付」会在 delete 处直接返回 L1，把扣款放过去。
    // 跳过 delete 后仍会继续走 publish / send / submit，都没命中才落到 L1。
    if (rule.category === 'delete' && REVERSIBLE_CLEAR.test(hay)) {
      continue
    }
    const matched = m[0]
    const readOnly = canDowngrade(rule.category) ? hitReadOnlyIntent(intent) : undefined
    if (readOnly) {
      return {
        level: 'L1',
        reason: `意图是「${readOnly}」，判定为只读取数，命中「${matched}」但允许自动执行`,
        matched
      }
    }
    return { level: 'L2', reason: rule.reason, matched }
  }

  // 没有不可逆语义，按动作类型兜底
  const level = levelOf(action)
  if (level === 'L1') {
    return { level, reason: '会改变页面状态，但可通过返回或刷新回退' }
  }
  return { level, reason: '只读动作' }
}
