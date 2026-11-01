/**
 * 审计文本的统一收口。
 *
 * 为什么单独成文件：这个函数是**纯函数、零依赖**，所以能直接在 Node 里测，
 * 不需要起 Electron、不需要造 Stores。而它守的东西恰好是「以后每加一个
 * 审计字段都会重犯」的那类缺陷 —— 只有测试能守住，测试就必须能便宜地跑。
 *
 * 缺陷形态（本轮实测）：
 *
 *   `audit.ts` 只对 `matched` 做了 `slice(0, 24)`，而 `reason` 是原样拼进
 *   `detail` 的。`reason` 由 `assessRisk()` 拼出，里面内嵌了**送给判定的那段
 *   语义串**。于是：
 *
 *     'log' + 5000 个空格 + 'out method'  → reason.length = 5045
 *     'log' + 20000 个空格 + 'out method' → reason.length = 20045
 *     'log\n\n\nout method'               → reason 里带 3 个换行
 *
 *   `log\s*out` 的 `\s*` 没有上界，所以长度由输入决定。
 *
 * ── 这段输入是谁写的：**模型**，不是页面 ──
 *
 * 这一点必须写清，因为第一版注释写反了（写成「页面可以写 10KB 的名字」）。
 * 真实链路是：
 *
 *   · 元素名由 `page-agent.ts` 的 `nameOf()` 取，**每一条来源都 `clip(v, 90)`**，
 *     页面写不出超过 90 字的元素名 —— 页面那一半是有界的；
 *   · 模型自述 `thought` 在 `loop.ts` 里只有 `.trim()`，**没有任何长度限制**；
 *   · `loop.ts:183` 把两者拼成同一段语义串：
 *       `semantic = [target?.name ?? '', thought].join(' ')`
 *     再送进 `assessRisk()`。于是 `thought` 里塞 10KB 就能让 `matched` 变成 10KB。
 *
 * 所以「要不要截输入」的答案是：**输入已经截了一半（页面那半），模型那半没人截。**
 * 收口是最后一道，不是唯一一道 —— 真正的修法是让 `matched` 在**产生处**
 * （`assessRisk` 返回前）就有界，否则每个消费者都得自己截，而 `consent.ts`
 * 那个消费者现在就没截。
 *
 * 为什么在 `appendAudit` 里收口，而不是在每个插值点各加一次 `slice`：
 * 每个插值点各加一次，等于每加一个新字段就多一个漏点，而这次已经证明了
 * 会漏（`target` 就是漏的第三个）。收口点只有一个，才谈得上「不会再漏」。
 *
 * 为什么截断必须**可见**：静默截断会让审计**声称**自己是完整的。
 * 读审计的人看到一条 400 字的记录，无法区分「原文就这么长」和
 * 「后面还有 9600 字被扔了」。加上 `…(截断，原长 N)` 之后，
 * 「这条记录不完整」这件事本身成为记录的一部分。
 */

/** 审计正文（`detail`）上限。够放下「授权来源 + 发起 + 理由 + 命中词」，远小于页面能写出的长度 */
export const DETAIL_CAP = 400

/** 审计列名（`target`）上限。它是列表里的一列，不是正文，所以更短 */
export const TARGET_CAP = 120

/**
 * 把页面/模型可控的文本压成「一行、可控长度」。
 *
 * 控制字符**全部**清零，不只是 `\n`：
 *   · `\n` 让一条记录在按行渲染/导出的视图里变成两条；
 *   · `\r` 让后续内容回到行首**覆盖**已显示的文字（终端和部分导出器会这样）；
 *   · `\t` 能伪造出与相邻记录对齐的缩进，看起来像另一列。
 * 三者都能让一条记录在观感上变成另一条，所以一起清。
 *
 * 截断长度记的是**归一化之后**的长度：`\r\n` 被压成一个空格之后，
 * 报原始长度会把「页面塞了多少空白」和「正文有多长」混为一谈。
 */
export function boundText(s: string | undefined, cap: number): string | undefined {
  if (s === undefined) return undefined
  const flat = s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (flat.length <= cap) return flat
  return `${flat.slice(0, cap)}…(截断，原长 ${flat.length})`
}

/** `detail` 专用：正文上限 */
export function boundDetail(s: string | undefined): string | undefined {
  return boundText(s, DETAIL_CAP)
}

/** `target` 专用：列名上限 */
export function boundTarget(s: string | undefined): string | undefined {
  return boundText(s, TARGET_CAP)
}

/** 命中词上限。它是**语义**截断（「命中了哪个词」看到词本身就够），与正文上限不是一回事 */
export const MATCHED_CAP = 24

/**
 * 命中词收口。
 *
 * 和 `boundText` 分开，因为语义不同：
 *   · `boundText` 防的是「页面撑爆审计」，所以压缩空白、清控制字符；
 *   · 这里防的是「命中词太长导致这一列不可读」，所以只截长度、不压空白。
 *
 * 截断同样必须可见：`'paypal' + 5000 空格 + 'checkout'` 能命中
 * `paypal\s*checkout`（`\s*` 无上界），实测 `matched.length = 5014`。
 * 静默截成 24 个字符会让读审计的人以为「命中的就是这 24 个字」。
 *
 * 这个长度的来源是模型的 `thought`（见文件头），不是页面 —— 页面那半被
 * `nameOf()` 的 `clip(v, 90)` 挡住了。
 */
export function boundMatched(s: string | undefined): string {
  if (!s) return ''
  return s.length > MATCHED_CAP ? `${s.slice(0, MATCHED_CAP)}…` : s
}
