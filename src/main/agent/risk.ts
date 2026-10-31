/**
 * 风险分级。
 *
 * 判定发生在**执行器**，不依赖模型自觉：模型可以自称「这是安全的」，
 * 但只要有不可逆语义命中，就一定要人在回路确认。
 *
 * L0 只读 / L1 可逆（改变页面状态但能退回）/ L2 不可逆（必须人工确认）
 */
import type { Action, RiskLevel, RiskVerdict } from '@shared/protocol'

interface RiskRule {
  /** 命中后用于生成具体理由 */
  category: 'pay' | 'order' | 'account' | 'delete' | 'publish' | 'send'
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
    re: /发送|群发|推送|发消息|提交表单|send|submit|broadcast|notify/i,
    reason: '这一步会把内容发送出去，确认后才会执行'
  }
]

/** 意图里出现这些词，说明用户只想看/取，不想要副作用 → L2 降 L1 */
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

function hitReadOnlyIntent(intent: string): string | undefined {
  return READ_ONLY_HINTS.find((w) => intent.includes(w))
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
 * 用户说「帮我采集这个页面的商品价格」，不代表允许模型顺手点掉「立即支付」——
 * 只读意图只能豁免搜索表单提交这类可回退动作，不能豁免扣款、销号、删除。
 */
const NEVER_DOWNGRADE = new Set<RiskRule['category']>(['pay', 'order', 'account', 'delete'])

/**
 * 是否允许因为「用户只想采集」而把命中项降级。
 *
 * 判定原则：**点击就是提交**。type 只是往输入框里打字、navigate 只是换页面，
 * 两者本身不产生不可逆后果（搜索「删除教程」不该每次都弹确认）；
 * 但 click 一旦命中不可逆语义，无论用户原话是什么都要人确认。
 *
 * 这条规则同时堵死了「意图洗白」：模型只要在只读任务里顺手点掉支付按钮，
 * 以前会因为 intent 里有「采集」二字而被降级放行。
 */
function canDowngrade(action: Action, category: RiskRule['category']): boolean {
  if (action.type === 'click') return false
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
    const matched = m[0]
    const readOnly = NEVER_DOWNGRADE.has(rule.category) ? undefined : hitReadOnlyIntent(intent)
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
