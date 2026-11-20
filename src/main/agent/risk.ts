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
  /** 全部词合成的一条（用于显示与兼容），判定不用它 */
  re: RegExp
  /** 动作短语（VOCAB 里带 `!` 前缀的那些），命中即 L2，不做宾语抑制 */
  strongRe: RegExp | null
  /** 名词词根，命中后还要过宾语抑制才作数 */
  weakRe: RegExp
  reason: string
}

/**
 * 宾语抑制：命中的名词词根**后面紧跟名词性后缀**时，说明这是「设置项 / 导航项」，
 * 不是动作。
 *
 * 为什么必须有这张表：`支払`、`注文`、`決済`、`결제`、`заказ`、`pedido` 这些
 * 既是动词词根，也是名词词根。而设置页里「支払い方法」「注文履歴」「결제수단」
 * 「Способы оплаты」全是**名词复合词**，词根后面直接接名词 —— 于是每个导航链接
 * 都会弹一次确认。实测 12 个真实导航元素 12/12 判 L2，闸门在非中文站点上等于
 * 不存在，而且失效方式是最坏的那种：不报错、不告警，只是让用户学会无脑点「同意」。
 *
 * 为什么是「后缀」而不是「词表拆成动词表」：拆词表需要给 14 种语言各标一次词性，
 * 标错一个就漏判扣款；而名词性后缀是一个**封闭且稳定**的集合 —— 设置页的措辞
 * 十年不变，动作按钮的措辞天天在变。用稳定集合去约束易变集合，方向才对。
 *
 * 判定边界（每条都有实测样本，见 tests/risk.test.ts 的对照组）：
 *   支払い方法 → 抑制（名词复合）
 *   支払いへ進む → 不抑制（`へ進む` 是方向，不是名词）
 *   注文履歴 → 抑制
 *   注文を確定する → 不抑制（`を` 是宾格助词，说明前面是被操作对象，后面是动词）
 */
const CJK_NOUN_TAIL =
  /^\s*[ぃいう]?(?:方法|情報|履歴|番号|内容|手段|明細|一覧|設定|画面|ページ|照会|状況|状態|条件|수단|내역|번호|조회|설정|정보|목록|상태|方式|渠道|通道|记录|明细|编号|信息|设置|页面|列表|选项|成功|完成|完了|已完成|完毕|失败|状态|结果|记录)/

/**
 * 拉丁 / 西里尔的名词后缀。
 *
 * 西里尔只收 `ы|ов|ев`，**刻意不收 `и`**：`оплатить`（支付，动词）的尾部也是 `и`
 * 开头，收了它会把「Оплатить」这个最该拦的按钮抑制掉。`ы` 不是任何动词词尾，
 * 所以 `Способы оплаты`（支付方式）能被安全抑制。
 *
 * 注意 `i` 标志：没有它，「Purchase History」判 L2 而「Purchase history」判 L1
 * —— 同一个词因为大小写不同给出两种结论，这在英文界面上是肉眼可见的不一致。
 */
const LATIN_NOUN_TAIL =
  /^\s*(?:(?:method|methods|history|number|details?|settings?|options?|info|limit|cards?|accounts?|address|page|summary|list|status|records?|success|successful|completed?|done|failed|result)\b|s\b|es\b)/i

const CYRILLIC_NOUN_TAIL = /^\s*(?:ы|ов|ев)/

/**
 * **左侧**名词短语：词根前面有冠词 / 物主代词 / 名词修饰语时，它处在宾语位置，
 * 不是谓语。
 *
 * 为什么必须有这一侧：只看右文会漏掉「名词前置」的语言。西班牙语
 * 「Estado del pedido」（订单状态）、俄语「Мои заказы」（我的订单）里，
 * 名词词根都在**末尾**，右文是空串 —— 只做右侧抑制的话它们照样判 L2。
 * 这是「查了一遍方向」的典型漏：抑制规则写了一个方向，样本也只测了一个方向。
 */
const LEFT_NOUN_PHRASE =
  /(?:^|[\s(（])(?:el|la|los|las|un|una|mi|mis|tu|tus|su|sus|del|de|estado|estatus|historial|lista|detalle|n[uú]mero|modo|forma|m[eé]todo|мои|моя|мой|моё|ваши|ваш|способы|способ|история|статус|номер|детали|настройки)\s+$/i

/**
 * 俄语的完成态回执：「Оплата выполнена」（支付已完成）—— 词根在句首，
 * 右文是「-а выполнена」。这不是动作，是状态陈述。
 */
const CYRILLIC_COMPLETION =
  /^[а-я]?\s*(?:выполнена|выполнен|завершена|завершён|отменена|прошла|успешно|не\s+удалась)/i

/** 词根命中后，前后文是否表明它是名词短语 / 完成态，而不是动作 */
function followedByObjectNoun(rest: string, before: string): boolean {
  return (
    CJK_NOUN_TAIL.test(rest) ||
    LATIN_NOUN_TAIL.test(rest) ||
    CYRILLIC_NOUN_TAIL.test(rest) ||
    CYRILLIC_COMPLETION.test(rest) ||
    LEFT_NOUN_PHRASE.test(before)
  )
}

/**
 * 不可逆语义词表，按类别分组。
 *
 * 为什么是数据而不是正则字面量：原先每条规则是一个写死的中英正则，
 * 于是「支持中文」实际上等于「只认中文 + 少量英文」。实测 14 种语言的
 * 「购买 / 删除 / 发送」按钮**全部判 L1 自动执行**：
 *
 *   購入する / 삭제 / Оплатить / Jetzt kaufen / Acheter / Comprar / Acquista …
 *
 * 对一个给跨境用户用的浏览器来说，这不是精度问题，是闸门对非中文用户不存在。
 *
 * 按类别拆开之后，补一门语言就是往数组里加几行，不用碰判定逻辑，
 * 也不会出现「中文加了、英文忘了」这种漂移。
 *
 * ── 条目两种形态 ──
 *   普通条目 = 名词词根。命中后还要过 `followedByObjectNoun()` 的宾语抑制。
 *   `!` 开头 = 动作短语（祈使/动宾结构）。命中即 L2，不参与抑制。
 *
 * 为什么必须区分：同一个词根在「动作」和「对象」两个句法位置上都出现，
 * 词表层面分不开。实测最小对 10 组只分对 3 组，而分对的 3 组恰好是本表
 * 里**唯一已经在用动作短语的两处**（`提交订单` / `place\s*order`）——
 * 裸的「订单」「order」根本不在表里。所以这不是新主张，是本文件早就
 * 做对过两次、另外八处没照做。
 */
const VOCAB: Record<RiskRule['category'], string[]> = {
  pay: [
    // 中文。左边界**故意不加**：Repay（还款）/ Prepay（预付）/ Postpay（后付）
    // 本身就是支付动作，加了左边界它们会掉成 L1 —— 用「诊断文案不精确」换「漏判扣款」。
    '支付', '付款', '付钱', '转账', '汇款', '充值', '打款',
    '!确认支付', '!立即支付', '!马上支付', '!去支付',
    'pay\\b', 'payment', 'checkout', 'purchase', 'transfer',
    '!buy\\s*now', '!buy\\s+it\\s+now',
    '!pay\\s*now', '!complete\\s+payment', '!process\\s+payment',
    '!place\\s*order', '!confirm\\s*pay', '!continue\\s*with\\s*paypal',
    '!pay\\s*with\\s*paypal', '!paypal\\s*checkout',
    // 日
    '支払', '購入', '決済', '払う',
    // 韩
    '결제', '지불', '구매', '송금',
    // 俄
    'оплат', 'платеж', 'платёж', 'купить', 'перевод',
    // 德
    // `zahlen` 单独一条**不能收**：它和德语名词「Zahlen」（数字）同形，
    // 词表层面无法区分，收进来等于给每个分页器都弹确认。只收带上下文的动作形态。
    'bezahl', 'kaufen', 'überweis', 'ueberweis',
    '!jetzt zahlen', '!zu zahlen', '!zahlen sie', '!zur\\s+kasse',
    // 法
    'payer', 'acheter', 'régler', 'regler',
    // 西 / 葡
    'pagar', 'comprar', 'transferir',
    // 意
    'paga\\b', 'acquista', 'compra'
  ],
  order: [
    '下单', '结算', '购买', '抢购',
    '!提交订单', '!确认订单', '!立即购买',
    'order\\s*now', 'submit\\s*order', 'checkout',
    // 英文下单动作短语。原先只有 `!place\\s*order`，于是「Place your order」
    // 这类最常见的下单按钮（中间插一个限定词）直接漏判 L1 —— 无人值守时
    // 是不弹确认直接扣款。限定词一律可选：宁可多问一次。
    '!place\\s+(?:your\\s+|the\\s+|my\\s+|a\\s+)?order',
    '!confirm\\s+(?:your\\s+|the\\s+|my\\s+|a\\s+)?order',
    '!submit\\s+(?:your\\s+|the\\s+|my\\s+|a\\s+)?order',
    '!complete\\s+(?:your\\s+|the\\s+|my\\s+|a\\s+)?order',
    '!process\\s+order',
    // 裸 Buy 也要拦：商品页的「Buy」就是下单按钮，而中文「立即购买」本来就被拦。
    '!buy\\b',
    '注文', '購入手続き',
    '주문',
    'заказ', 'оформить',
    'bestellen',
    // 法语「下单」是**动宾短语**，动词在前、宾语在后。所以这里收的是
    // 「动词 + (冠词/物主) + commande」这个句式，不是 `commande` 这个词 ——
    // 收裸 `commande` 会让「Ma commande」（我的订单）也弹确认。
    '!(?:passer|valider|finaliser|confirmer)\\s+(?:la\\s+|votre\\s+|ma\\s+)?commande',
    'commander\\b',
    'pedido',
    'ordina'
  ],
  account: [
    '注销', '解绑', '换绑', '退出登录', '退出帐号', '删除账号', '删除帐号',
    'log\\s*out', 'sign\\s*out', 'deactivate', 'unlink', 'delete\\s*account',
    'ログアウト', '退会', 'アカウント削除', '解除',
    '로그아웃', '탈퇴', '계정 삭제',
    'выйти', 'удалить аккаунт', 'отвязать',
    'abmelden', 'konto löschen', 'trennen',
    'déconnexion', 'deconnexion', 'supprimer le compte',
    'cerrar sesión', 'cerrar sesion', 'eliminar cuenta',
    'sair', 'excluir conta',
    'disconnetti', 'elimina account'
  ],
  delete: [
    // 「清除」原来漏了：词表里有 删除/清空/移除，唯独没有 清除，
    // 而筛选豁免里用了「清除」。于是「清除全部记录」两头都匹配不上，
    // 落到兜底 L1 自动执行 —— 那是不可逆的数据删除。
    // 补进来之后「清除筛选」仍走豁免，因为豁免判定在规则命中之后、返回之前。
    '删除', '清空', '移除', '销毁', '格式化', '退订', '取消订单', '清除',
    'delete', 'remove', 'destroy', 'unsubscribe', 'clear\\s*all',
    // 取消订单 / 退款：中文「取消订单」本来就在表里，英文缺失造成了中英不一致。
    '!cancel\\s+(?:my\\s+|the\\s+|a\\s+)?order',
    '!refund', '!cancel\\s+refund',
    '削除', '消去', '破棄',
    '삭제', '지우기', '비우기',
    'удал', 'очист',
    'löschen', 'loeschen', 'entfern', 'leeren',
    'supprimer', 'effacer', 'vider',
    'eliminar', 'borrar', 'vaciar',
    'excluir', 'apagar', 'limpar',
    'elimina', 'cancella', 'svuota'
  ],
  publish: [
    '发布', '发表', '公开', '上架', 'publish', 'post\\s*publicly', 'go\\s*live',
    '公開', '投稿', '掲載',
    '게시', '공개', '발행',
    'опубликов', 'разместить',
    'veröffentlich', 'veroeffentlich', 'publizieren',
    'publier',
    'publicar',
    'pubblica'
  ],
  send: [
    // 「发送」= 消息已经送达对方、撤不回来。私信、群发、推送、通知都属此类。
    '发送', '群发', '推送', '发消息', '发私信', '发送给', '转发',
    'broadcast', 'notify', 'send\\b', '\\bforward\\b',
    '送信', '送る', '転送', '通知',
    '보내기', '전송', '공유',
    'отправить', 'переслать',
    'senden', 'schicken', 'weiterleiten',
    'envoyer', 'partager',
    'enviar', 'compartir', 'compartilhar',
    'invia', 'condividi'
  ],
  submit: [
    // 「提交」= 本端状态变更，多数可回退（搜索框提交、表单保存）。
    // 单独成类是为了和 send 分开：结账类按钮通常写作「提交订单」，
    // 那种会先命中上面的 order 规则，不会被这里放行。
    '提交表单', '提交', 'submit',
    '確定', '保存',
    '제출', '저장',
    'сохранить',
    'absenden', 'speichern',
    'enregistrer',
    'guardar', 'salvar',
    'salva'
  ]
}

/** 把词表拼成正则。长的排前面，让「立即购买」优先于「购买」被匹配到 */
function buildRule(category: RiskRule['category'], reason: string): RiskRule {
  const strong: string[] = []
  const weak: string[] = []
  for (const entry of VOCAB[category]) {
    if (entry.startsWith('!')) strong.push(entry.slice(1))
    else weak.push(entry)
  }
  const byLen = (a: string, b: string): number => b.length - a.length
  strong.sort(byLen)
  weak.sort(byLen)
  return {
    category,
    // 合成的那条只用于显示（`matched` 取值来自命中它的那条），判定走下面两条
    re: new RegExp([...strong, ...weak].join('|'), 'i'),
    strongRe: strong.length > 0 ? new RegExp(strong.join('|'), 'i') : null,
    weakRe: new RegExp(weak.join('|'), 'i'),
    reason
  }
}

/**
 * 不可逆语义表。顺序即优先级：
 * 先判钱，再判账号，再判删除，最后判「发出去就收不回」的发布/发送。
 */
const RULES: RiskRule[] = [
  buildRule('pay', '这一步会发起支付并产生扣款，确认后才会执行'),
  buildRule('order', '这一步会提交订单，确认后才会执行'),
  buildRule('account', '这一步会改动账号绑定或登录状态，确认后才会执行'),
  buildRule('delete', '这一步会删除数据且无法撤销，确认后才会执行'),
  buildRule('publish', '这一步会把内容公开发布，确认后才会执行'),
  buildRule('send', '这一步会把内容发送给对方且无法撤回，确认后才会执行'),
  buildRule('submit', '这一步会提交表单并改变页面状态，确认后才会执行')
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
 * 英文侧同样要能识别「可逆的清除」。
 *
 * 中文「移除筛选」被豁免，英文「Remove filter」却命中 delete 规则弹确认 ——
 * 同一件事两种语言两种待遇，用户切到英文界面就突然被噪音淹没。
 */
const REVERSIBLE_CLEAR_EN =
  /(?:clear|reset|remove|delete)\s+(?:the\s+)?(?:filter|filters|search|searches|query)/i

/**
 * 泛化确认词：字面上不含任何不可逆语义，但在支付页上它就是扣款按钮。
 *
 * 「确定」「确认」「OK」「Continue」「Submit」这些词在任何普通页面上都不该弹确认
 * （弹了就是噪音，噪音化的闸门等于没有闸门）；但在收银台页上，同一个「确认」
 * 背后就是一次扣款。**单看按钮文案区分不出来，必须看页面语境。**
 */
const GENERIC_CONFIRM =
  /^(?:确定|确认|好|好的|是的|行|继续|下一步|提交|完成|接受|ok|okay|yes|yeah|confirm|continue|next|submit|complete|accept|proceed|go|done|buy)$/i

/**
 * 支付 / 下单语境词。
 *
 * 收紧到「确实在收钱」的词：普通页面（博客、后台、文档）几乎不会出现这些词，
 * 而支付页一定会出现。所以「泛化确认词 + 支付语境」的组合误判面很小。
 */
const PAYMENT_CONTEXT =
  /(?:支付|付款|下单|订单|结算|收银|结账|购物车|金额|银行卡|信用卡|有效期|安全码|立即购买|确认订单)|\b(?:pay(?:ment|now)?|checkout|purchase|order|cart|subtotal|billing|cvv|expiry)\b/i

/**
 * 判定上下文。
 *
 * 只有页面正文摘要，没有别的：判定必须能在一屏文字里完成，
 * 拿不到整页 DOM 也不该判不出 L2。
 */
export interface RiskContext {
  /** 页面正文摘要（快照里的 text） */
  pageText?: string
}

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

/**
 * 意图里的否定词 + 动作词。
 *
 * 「帮我看看这个页面，别做任何操作」—— 句子里有一个只读动词「看看」，
 * 语义却恰恰是「不要动」。只按「含只读动词」放行，等于把最强烈的不许动
 * 读成了自动放行。而「不要点击」因为碰巧含「点击」（在 WRITE_HINTS 里）
 * 反而被判得更严 —— 同一件事，否定得越彻底判得越松，这是反的。
 *
 * 刻意收窄到「否定词 + 动作词」的组合，不收单字「别」：
 * 「特别看看」「区别」「告别」里都有「别」，那会把正常只读意图也判成写，
 * 于是每次搜索框提交都弹确认，闸门噪音化。
 */
const NEGATED_ACTION =
  /不要|勿|禁止|严禁|不可|不能|切勿|无需|不必|别(?:做|点|动|乱|碰|操|再|改|删|填)/

function hitReadOnlyIntent(intent: string): string | undefined {
  // 意图里出现「别动」类说法时，不认任何只读豁免。
  if (NEGATED_ACTION.test(intent)) return undefined
  const hit = READ_ONLY_HINTS.find((w) => intent.includes(w))
  if (!hit) return undefined
  // 意图里同时出现写信号 → 不算纯只读
  const write = WRITE_HINTS.find((w) => intent.includes(w))
  return write ? undefined : hit
}

/**
 * 一个字段 + 它的来源。
 *
 * `source` 决定「哪些类别的规则可以看它」：
 * - `content`：流经页面的**内容**（type 的 text、navigate 的 url、extract 的 query）。
 *   在这些字段里出现「支付」「删除」只说明用户/模型在谈论这些词，
 *   不说明这个动作会执行它们。所以只有**结果不可逆**的类别（pay / order /
 *   account）才允许从内容里判定；delete / send / publish 不看内容——
 *   否则「在搜索框里打『删除旧邮件』」会被判成删除（实测原实现就是这样）。
 * - `element`：被操作的元素名 / 按键名，永远参与判定。
 */
interface FieldSpec {
  value: string
  source: 'content' | 'element'
}

/** 允许从「内容字段」判定的不可逆类别 */
const CONTENT_CATEGORIES: ReadonlySet<RiskRule['category']> = new Set(['pay', 'order', 'account'])

/**
 * navigate 只取路径，丢掉查询串与 hash。
 *
 * `https://x.com/search?q=delete` 是一次 GET，不是删除；
 * 而 `https://x.com/checkout` 的路径本身就说明这是收银台 —— 保留。
 */
function pathOfUrl(url: string): string {
  const q = url.search(/[?#]/)
  return q >= 0 ? url.slice(0, q) : url
}

/**
 * 把动作里所有可能承载语义的字段拆成数组，**不 join**。
 *
 * ── 为什么内容字段不能对所有类别生效 ──
 * 原实现让 `action.text` / `action.url` 无条件参与语义扫描，于是**任何按
 * 关键词检索的任务都会弹确认框**：在搜索框里输入「删除旧邮件」判 L2、
 * 打开 `/search?q=delete` 判 L2。闸门一旦噪音化，用户就会学会无脑点
 * 「允许执行」—— 那比没有闸门更危险。
 *
 * 但**不能一刀切把内容字段全删掉**：在搜索框里输入「确认支付」确实值得警惕
 * （可能是支付页的表单填写），tests/risk.test.ts 也有这条断言。
 * 所以按类别区分：pay / order / account 可以从内容判定，其余不行。
 */
function fieldsOf(action: Action, extra: string): FieldSpec[] {
  const out: FieldSpec[] = []

  if (action.type === 'type') {
    if (typeof action.text === 'string' && action.text.length > 0) {
      out.push({ value: action.text, source: 'content' })
    }
  } else if (action.type === 'navigate') {
    if (typeof action.url === 'string' && action.url.length > 0) {
      out.push({ value: pathOfUrl(action.url), source: 'content' })
    }
  } else {
    // click / press / scroll / extract：动作参数是「页面内容」而不是「被点元素」
    for (const v of [action.text, action.url, action.query, action.summary]) {
      if (typeof v === 'string' && v.length > 0) out.push({ value: v, source: 'content' })
    }
    if (typeof action.url === 'string' && action.url.length > 0) {
      // navigate 之外的 url 也按路径判定（避免查询串里的词误伤）
      out.push({ value: pathOfUrl(action.url), source: 'content' })
    }
  }

  // 按键名与元素名是「这次动作的宾语」，永远参与判定。
  // click 的元素名不在 Action 里（模型只给编号），所以调用方必须把目标元素的
  // 可读名传进来 —— 否则点「立即支付」时这里扫到的是空串，永远判不出 L2。
  if (typeof action.key === 'string' && action.key.length > 0) {
    out.push({ value: action.key, source: 'element' })
  }
  if (extra.length > 0) out.push({ value: extra, source: 'element' })

  return out
}

/** 只用于那些**需要跨字段看**的判定（例如「清空筛选并支付」） */
function haystackOf(action: Action, extra: string): string {
  return fieldsOf(action, extra)
    .map((f) => f.value)
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

/**
 * 非短路动作的兜底等级。
 *
 * 为什么没有 L0 分支：`extract` / `done` 在 `assessRisk` 入口就短路返回 L0，
 * 永远走不到这里。原 `levelOf` 写 `case 'extract'/'done': return 'L0'` 是
 * **不可达代码** —— 它让读者以为有一条「只读」路径会走到末尾，而实际上末尾
 * 只可能是 L1。不可达代码比没有更糟：它会误导下一次改动的人。
 */
function levelOf(_action: Action): RiskLevel {
  return 'L1'
}

/**
 * 输出串的长度上限。
 *
 * 为什么在**产生处**截，而不是等消费者各截一次：
 *   `matched` 和 `reason` 会进三个地方 —— 系统确认对话框、审计记录、渲染层列表。
 *   实测 `'log' + 5000 个空格 + 'out method'` 能命中 `log\s*out`（`\s*` 没有上界），
 *   于是 `matched.length = 5014`、`reason.length = 5045`，对话框正文直接变成 5KB。
 *   让每个消费者自己截，等于每加一个消费者就多一个漏点 —— 而 `consent.ts`
 *   那个消费者当时就没截。
 *
 * 为什么**不截输入**：`extra` 里藏着模型自述，截掉尾部等于给模型一条旁路 ——
 * 先写 3000 个无害字，再在截断点之后写「删除全部订单」，判定就看不见了。
 * 判定必须看到全文，只有**往外说的话**需要有界。
 *
 * 截断必须可见：`…(截断，原长 N)`。静默截断会让读者以为命中的就是这几个字。
 */
const MATCHED_CAP = 24
const REASON_CAP = 300

function clipOut(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}…(截断，原长 ${s.length})` : s
}

/**
 * 评估一步动作的风险。
 * @param action 待执行动作
 * @param intent 用户的原始任务意图（用于判断是否只是采集/查看）
 * @param extra 目标元素的可读名与模型自述，click 这类只有编号的动作必须靠它提供语义
 */
export function assessRisk(
  action: Action,
  intent: string,
  extra = '',
  context?: RiskContext
): RiskVerdict {
  // 只读动作没有副作用，先短路，避免 extract 的 query 里出现「价格统计」之类误伤
  if (action.type === 'extract' || action.type === 'done') {
    return {
      level: 'L0',
      reason: action.type === 'extract' ? '只记录取数指令，不操作页面' : '结束任务，无页面副作用'
    }
  }

  const hay = haystackOf(action, extra)
  /** 命中过词表但被抑制掉的词根，用于区分「没命中」与「命中后被抑制」 */
  const suppressed: string[] = []
  for (const rule of RULES) {
    // 内容字段只对「结果不可逆」的类别可见（pay / order / account）。
    // 理由见 `fieldsOf`：在搜索框里打「删除旧邮件」不是删除，
    // 打开 `/search?q=delete` 也不是 —— 但「确认支付」确实该拦。
    const fields = fieldsOf(action, extra)
      .filter((f) => f.source === 'element' || CONTENT_CATEGORIES.has(rule.category))
      .map((f) => f.value)
    // **逐字段**扫描，不跨字段拼接。
    //
    // 为什么必须逐字段：抑制规则要看词根**前后文**，而拼接之后左窗会跨进上一个
    // 字段。实测反例：`{text:'Оформить', query:'Мои заказы'}` 拼成
    // `Оформить Мои заказы`，`заказ` 的左窗看到 `Мои ` → 判「名词短语」→ 抑制 →
    // 整条掉成 L1，而 `Оформить`（下单）就在隔壁字段。两个字段各自都是确定的语义，
    // 拼起来却产生了任何单一字段都不成立的「名词短语」。
    //
    // 拼接还有一个更隐蔽的代价：`join(' ')` 会**凭空造出词边界**。
    // 原本 `Оформить\nзаказы` 里 `ь` 与 `з` 相邻不构成 `\b`，join 之后变成
    // `Оформить заказы`，`\b` 成立、`заказ` 命中。也就是说判定结果取决于
    // 「这些字段有没有被拼过」，而不是取决于内容。
    //
    // 只让**需要跨字段看**的判定（REVERSIBLE_CLEAR）用拼接串，语义扫描一律逐字段。
    let m: RegExpExecArray | null = null
    const strong = rule.strongRe
    if (strong) {
      for (const f of fields) {
        const r = strong.exec(f)
        if (r) {
          m = r
          break
        }
      }
    }
    if (!m) {
      for (const f of fields) {
        const w = rule.weakRe.exec(f)
        if (!w) continue
        if (
          followedByObjectNoun(
            f.slice(w.index + w[0].length),
            f.slice(Math.max(0, w.index - 24), w.index)
          )
        ) {
          // 入栈就截：suppressed 会原样进 reason 与审计，一条 5013 字的命中词
          // 足以把「命中后判定为名词」这条证据变成不可读的噪声。
          suppressed.push(clipOut(w[0], MATCHED_CAP))
          continue
        }
        m = w
        break
      }
    }
    if (!m) {
      continue
    }
    // 「清空筛选」这类只豁免 delete 这一条，不能整体短路 ——
    // 否则「清空筛选并支付」会在 delete 处直接返回 L1，把扣款放过去。
    // 跳过 delete 后仍会继续走 publish / send / submit，都没命中才落到 L1。
    if (rule.category === 'delete' && (REVERSIBLE_CLEAR.test(hay) || REVERSIBLE_CLEAR_EN.test(hay))) {
      suppressed.push(clipOut(m[0], MATCHED_CAP))
      continue
    }
    const matched = clipOut(m[0], MATCHED_CAP)
    const readOnly = canDowngrade(rule.category) ? hitReadOnlyIntent(intent) : undefined
    if (readOnly) {
      return {
        level: 'L1',
        reason: clipOut(
          `意图是「${readOnly}」，判定为只读取数，命中「${matched}」但允许自动执行`,
          REASON_CAP
        ),
        matched,
        ...(suppressed.length > 0 ? { suppressed: [...suppressed] } : {})
      }
    }
    return { level: 'L2', reason: clipOut(rule.reason, REASON_CAP), matched }
  }

  // ── 上下文升级：泛化确认词 + 支付语境 = 极可能是扣款按钮 ──
  //
  // 词表查不到「确定」「OK」这类词，因为它们本身不含不可逆语义；
  // 但收银台页上的「确认」背后就是一次扣款。**单看按钮文案区分不出来，
  // 必须看页面语境** —— 这也是商业产品的做法（上下文相关的破坏性动作识别）。
  //
  // 放在词表之后：词表已经命中并判 L2 的走不到这里；词表命中但被抑制的
  // （例如「Payment History」被判成名词）仍会走到这里并被语境救回来。
  if (
    action.type === 'click' &&
    extra.trim() !== '' &&
    GENERIC_CONFIRM.test(extra.trim()) &&
    context?.pageText !== undefined &&
    PAYMENT_CONTEXT.test(context.pageText)
  ) {
    return {
      level: 'L2',
      reason: clipOut(
        '泛化确认词出现在支付 / 下单语境中，可能是扣款按钮，确认后才会执行',
        REASON_CAP
      ),
      matched: clipOut(extra, MATCHED_CAP)
    }
  }

  // 没有不可逆语义，按动作类型兜底。
  //
  // 注意 `suppressed` 必须在这里也带出去：走到这一行有两种情况 ——
  //   1. 整句没有任何词表命中
  //   2. **命中了，但被抑制规则吃掉了**
  // 两者都返回 L1，如果不带证据，审计里只能看到「可回退」，看不到
  // 「其实命中了支付词根、是被判定为名词才放行的」。后者恰恰是最需要留痕的：
  // 抑制规则一旦写宽，所有真动作都会静默变成 L1，而记录里一片正常。
  const level = levelOf(action)
  const suppressedEvidence = suppressed.length > 0 ? { suppressed: [...suppressed] } : {}
  // level 只可能是 L1（L0 已短路、L2 由规则判定后提前返回），所以这里直接返回 L1。
  // 原末尾的 `return { level, reason:'只读动作' }` 不可达，已删除 —— 它会让读者
  // 以为存在一条「只读」路径走到这里，而实际上走不到。
  return {
    level,
    reason: clipOut(
      suppressed.length > 0
        ? `会改变页面状态，但可通过返回或刷新回退（命中「${suppressed.join('」「')}」后判定为名词，未升级为不可逆）`
        : '会改变页面状态，但可通过返回或刷新回退',
      REASON_CAP
    ),
    ...suppressedEvidence
  }
}
