/**
 * 审计链校验的回归测试。
 *
 * 背景：`verifyAudit()` 原先在链为空时返回 `ok: true`。而 `list()` 在文件不存在
 * 时返回空数组（首次运行）、在文件损坏时也降级成空数组 —— 两种都被读成
 * 「链路为空，没问题」。于是**最省事的销毁痕迹不是改记录，是删文件**：
 * `rm data/audit.json` 之后点「验证完整性」，界面显示绿灯。
 *
 * 更隐蔽的一类：删掉**尾部**若干条。剩下的 1..n-k 序号连续、prev 全对、
 * 每条 hash 都能重算对上 —— 链内校验一条都发现不了，因为剩下的部分完全自洽。
 *
 * 修法是把「最后一条是什么」记到日志**外面**（settings.json 里的链头锚点），
 * 校验时多比一次。这个测试钉的就是那次比对，以及「锚点缺失不能当通过」。
 *
 * `audit-chain.ts` 零依赖（只 import type），所以能直接在 Node 里跑，不需要 Electron。
 *
 * 跑法：node --experimental-strip-types --test tests/audit-chain.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  digest,
  verifyChain,
  ZERO_HASH,
  type ChainEntry,
  type ChainHead
} from '../src/main/modules/audit-chain.ts'
import {
  boundDetail,
  boundMatched,
  boundTarget,
  DETAIL_CAP,
  MATCHED_CAP,
  TARGET_CAP
} from '../src/main/modules/audit-bound.ts'

/** 仓库根目录：`tests/` 的上一级 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 造一条自洽的链。`from` 用来模拟「头部已被 5000 条上限裁掉」 */
function build(count: number, from = 1): ChainEntry[] {
  const out: ChainEntry[] = []
  let prev = from === 1 ? ZERO_HASH : '裁掉的记录留下的哈希'.padEnd(64, '0')
  for (let i = 0; i < count; i += 1) {
    const seq = from + i
    const at = 1_700_000_000_000 + seq
    const action = `动作 ${seq}`
    out.push({ seq, at, actor: 'local', action, prev, hash: digest(prev, seq, at, 'local', action, '', '') })
    prev = out[out.length - 1].hash
  }
  return out
}

function headOf(entries: ChainEntry[]): ChainHead {
  const last = entries[entries.length - 1]
  return { seq: last.seq, hash: last.hash }
}

/** 重算整条链的 hash（模拟「改完内容顺手重算」，这是无密钥摘要挡不住的那类） */
function reseal(entries: ChainEntry[]): ChainEntry[] {
  let prev = entries[0].prev
  return entries.map((e) => {
    const hash = digest(prev, e.seq, e.at, e.actor, e.action, e.target ?? '', e.detail ?? '')
    const next = { ...e, prev, hash }
    prev = hash
    return next
  })
}

test('自洽的链 + 匹配的锚点 → 通过', () => {
  const entries = build(5)
  const v = verifyChain(entries, headOf(entries))
  assert.equal(v.consistent, true)
  assert.equal(v.total, 5)
  assert.match(v.message, /尾部已与链头锚点核对/)
})

test('空链 + 没有锚点 → 通过（确实还没写过记录）', () => {
  const v = verifyChain([], null)
  assert.equal(v.consistent, true)
  assert.equal(v.total, 0)
})

test('空链 + 有锚点 → 整份日志被删，必须报断链', () => {
  // 这条就是 `rm data/audit.json` 的回归：修之前这里返回 ok:true
  const v = verifyChain([], { seq: 42, hash: 'a'.repeat(64) })
  assert.equal(v.consistent, false)
  assert.equal(v.kind, 'tail-truncated')
  assert.equal(v.brokenAt, 42)
  assert.match(v.message, /整份审计日志已被删除/)
})

test('有链 + 没有锚点 → 未锚定，不能当通过，并给出应建立的锚点', () => {
  // 升级上来的旧数据走这条；「删掉 settings.json」也走这条 ——
  // 后者如果返回 ok，就等于把绕过路径从 audit.json 换到了 settings.json。
  const entries = build(3)
  const v = verifyChain(entries, null)
  assert.equal(v.consistent, false)
  assert.equal(v.kind, 'unanchored')
  assert.deepEqual(v.adoptHead, headOf(entries))
  assert.match(v.message, /无法验证尾部/)
})

test('删掉尾部一条 → 尾部对不上，断点指向第一条缺失的记录', () => {
  const full = build(5)
  const head = headOf(full)
  const v = verifyChain(full.slice(0, 4), head)
  assert.equal(v.consistent, false)
  assert.equal(v.kind, 'tail-truncated')
  assert.equal(v.brokenAt, 5)
  assert.match(v.message, /少了 1 条/)
})

test('删掉尾部之后链内完全自洽 —— 证明锚点是唯一防线', () => {
  // 这是本文件最重要的一条：把锚点换成「删完之后的尾部」，
  // 同一份数据立刻变成 ok:true。也就是说，没有日志外的锚点，
  // 链内校验对尾部删除**一条都发现不了**，不是「发现得少」，是结构上看不见。
  const full = build(5)
  const truncated = full.slice(0, 3)
  assert.equal(verifyChain(truncated, headOf(full)).consistent, false)
  assert.equal(verifyChain(truncated, headOf(truncated)).consistent, true)
})

test('尾部被替换并重算哈希 → 同序号不同哈希，必须报出来', () => {
  const full = build(5)
  const head = headOf(full)
  const tampered = full.slice()
  const last = tampered[tampered.length - 1]
  tampered[tampered.length - 1] = {
    ...last,
    action: '动作 5（改过）',
    hash: digest(last.prev, last.seq, last.at, last.actor, '动作 5（改过）', '', '')
  }
  const v = verifyChain(tampered, head)
  assert.equal(v.consistent, false)
  assert.equal(v.kind, 'tail-truncated')
  assert.equal(v.brokenAt, 5)
  assert.match(v.message, /被替换或重算过/)
})

test('锚点落后于日志（追加后、写锚点前中断）→ 不通过但语义是「可自愈」', () => {
  const entries = build(6)
  const v = verifyChain(entries, { seq: 5, hash: entries[4].hash })
  assert.equal(v.consistent, false)
  assert.equal(v.kind, 'tail-truncated')
  assert.match(v.message, /锚点落后/)
  // 不能写成「被删除」：那会把一次写入中断说成一次篡改
  assert.doesNotMatch(v.message, /被删除/)
})

test('中间删一条 → 序号不连续', () => {
  const entries = build(5)
  const head = headOf(entries)
  const v = verifyChain([entries[0], entries[1], entries[3], entries[4]], head)
  assert.equal(v.consistent, false)
  assert.equal(v.kind, 'seq-gap')
  assert.equal(v.brokenAt, 4)
})

test('改内容但没重算哈希 → 内容与哈希不符', () => {
  const entries = build(3)
  const head = headOf(entries)
  const tampered = entries.slice()
  tampered[1] = { ...tampered[1], action: '动作 2（改过）' }
  const v = verifyChain(tampered, head)
  assert.equal(v.consistent, false)
  assert.equal(v.kind, 'content-mismatch')
  assert.equal(v.brokenAt, 2)
})

test('删掉链首 → 链首缺失', () => {
  const entries = build(5)
  const head = headOf(entries)
  const v = verifyChain(entries.slice(2), head)
  assert.equal(v.consistent, false)
  assert.equal(v.kind, 'head-truncated')
  assert.equal(v.brokenAt, 3)
})

test('顶到 5000 条上限后的头部裁剪不算断链', () => {
  const entries = build(5000, 3)
  const v = verifyChain(entries, headOf(entries))
  assert.equal(v.consistent, true)
  assert.match(v.message, /头部 2 条已按上限裁剪/)
})

test('整链重算可以自洽 —— 这条是已知边界，结论里必须写明', () => {
  // 摘要没有密钥，所以「改了内容并且整链重算」是挡不住的。
  // 测试把这件事写成断言，是为了防止有人某天把结论改成「链路完整」这种全称说法。
  const entries = build(4)
  const forged = reseal(entries.map((e) => ({ ...e, action: '伪造的动作' })))
  const v = verifyChain(forged, headOf(forged))
  assert.equal(v.consistent, true)
  assert.match(v.message, /摘要无密钥，可被整体重算/)
})

/* ────────── 12. 审计文本收口：页面写的文本不得决定记录的长度与行数 ────────── */

/**
 * 这一节的缺陷形态（实测，不是推的）：
 *
 * `audit.ts` 只对 `matched` 做了 `slice(0, 24)`，而 `reason` 与 `target` 是
 * **原样**拼进 `detail` 的。`reason` 由 `assessRisk()` 拼出，里面内嵌元素可读名，
 * 而元素名由页面写。于是：
 *
 *   元素名 'log' + 5000 个空格 + 'out method'  → reason.length = 5045
 *   元素名 'log' + 20000 个空格 + 'out method' → reason.length = 20045
 *   元素名 'log\n\n\nout method'               → reason 里带 3 个换行
 *
 * `log\s*out` 的 `\s*` 没有上界，长度由页面决定。前门（`matched`）挡住了，
 * 同一段文字从侧门（`reason`）进去了。
 *
 * 这条缺陷的性质是「以后每加一个审计字段都会重犯」，所以光改不够，必须钉住。
 * 钉的方式有两层：
 *   ① 纯函数层 —— `boundText` 的行为（下面的用例）；
 *   ② 接线层 —— `appendAudit` 里确实调用了它（最后一条用例）。
 * 只做 ① 不够：函数写对了但没接上，缺陷照旧，而测试全绿。
 */

test('detail：10000 字被压到上限内，且截断标记里写的是真实原长', () => {
  const raw = 'A'.repeat(10000)
  const out = boundDetail(raw)!
  // ① 长度有界
  assert.ok(out.length <= DETAIL_CAP + 32, `收口后长度 ${out.length} 超出上限 ${DETAIL_CAP}+32`)
  // ② 前缀是原文，不是别的东西
  assert.equal(out.slice(0, DETAIL_CAP), 'A'.repeat(DETAIL_CAP))
  // ③ 截断可见，且原长等于实际输入长度
  const m = out.match(/…\(截断，原长 (\d+)\)$/)
  assert.ok(m, `结尾没有截断标记：${JSON.stringify(out.slice(-40))}`)
  assert.equal(Number(m![1]), 10000)
})

test('detail：换行注入 —— 落盘里不得有换行，界面只能显示一行', () => {
  // 页面可以把元素名写成这样，于是 `reason` 里带换行，`detail` 也带换行。
  // 按行渲染/导出时，一条记录会被读成两条 —— 这是审计伪造，不是排版问题。
  const raw = '第一行\n2026-01-01 00:00 已获授权'
  const out = boundDetail(raw)!
  assert.equal(out.split('\n').length, 1, '收口后仍然含换行')
  assert.doesNotMatch(out, /[\r\n\t]/, '收口后仍含 \\r / \\n / \\t')
  // 内容不能被吃掉：换行变空格，两段都还在
  assert.match(out, /第一行/)
  assert.match(out, /已获授权/)
})

test('detail：回车也能伪造「覆盖」，同样必须清掉', () => {
  // `\r` 让后续内容回到行首重写已显示的文字。终端和部分导出器会这样处理，
  // 于是「已获授权」四个字可以被视觉上覆盖成别的内容。
  const out = boundDetail('拒绝\r已获授权')!
  assert.doesNotMatch(out, /\r/)
  assert.equal(out, '拒绝 已获授权')
})

test('detail：控制字符全部清零，不只是 \\n / \\r / \\t', () => {
  const out = boundDetail('a\u0000b\u001fc\u007fd')!
  assert.equal(out, 'a b c d')
})

test('target：5000 字被截到列名上限（它同样是页面写的）', () => {
  const out = boundTarget('B'.repeat(5000))!
  assert.ok(out.length <= TARGET_CAP + 32, `target 收口后长度 ${out.length} 超出上限`)
  assert.equal(out.slice(0, TARGET_CAP), 'B'.repeat(TARGET_CAP))
  const m = out.match(/…\(截断，原长 (\d+)\)$/)
  assert.ok(m, 'target 结尾没有截断标记')
  assert.equal(Number(m![1]), 5000)
})

test('未超限的文本原样保留 —— 收口不能改变正常记录', () => {
  const s = '本次执行已获授权（票据消费成功）；发起=agent；这一步会发起支付并产生扣款'
  assert.equal(boundDetail(s), s)
  assert.equal(boundTarget('立即支付'), '立即支付')
})

test('matched：5014 字的命中词被截到 24，且带可见标记', () => {
  // `paypal\s*checkout` 的 `\s*` 无上界，所以命中词长度由**输入**决定。
  // 输入里无界的那一半是模型的 `thought`（`loop.ts` 只有 `.trim()`）；
  // 页面那半被 `page-agent.ts` 的 `nameOf()` 截到 90，写不出 5014 字。
  // 静默截断会让读审计的人以为「命中的就是这 24 个字」。
  const out = boundMatched('paypal' + ' '.repeat(5000) + 'checkout')
  assert.equal(out.length, MATCHED_CAP + 1, '截断后应恰好是上限 + 一个省略号')
  assert.equal(out, 'paypal'.padEnd(MATCHED_CAP, ' ') + '…')
  assert.match(out, /…$/, '截断没有标记')
  // 短命中词不加标记：标记本身是信息，不该出现在没截断的记录上
  assert.equal(boundMatched('立即支付'), '立即支付')
  assert.equal(boundMatched(undefined), '')
})

test('undefined 保持 undefined —— 不把「没传」变成空串', () => {
  // `appendAudit` 的哈希里对 undefined 走 `?? ''`，但存储字段要保持 undefined，
  // 否则「没传 target」和「传了空 target」在落盘上不可区分。
  assert.equal(boundDetail(undefined), undefined)
  assert.equal(boundTarget(undefined), undefined)
})

/** 取 `name(` 的括号内文本（带括号配对），找不到返回 null */
function callArgs(src: string, name: string): string | null {
  const at = src.indexOf(`${name}(`)
  if (at < 0) return null
  let i = at + name.length
  let depth = 0
  for (; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1
    else if (src[i] === ')') {
      depth -= 1
      if (depth === 0) return src.slice(at + name.length + 1, i)
    }
  }
  return null
}

test('接线：appendAudit 把 target / detail 都过收口，且哈希不含未收口的值', () => {
  // 纯函数写对但没接上，缺陷照旧、测试全绿 —— 这条钉的就是那个缝。
  //
  // 判据故意不钉变量名（不写 `boundTarget(target)`、不写 `safeTarget`）：
  // 那样改个名字就红，而重命名不是这条要守的性质。要守的是两件事：
  //   ① 收口函数确实被调用了；
  //   ② 进 `digest()` 的参数里没有裸的 `target` / `detail`。
  // ② 用 `\btarget\b` 判断：`safeTarget` 里是 `Target`（大写 T），不会误中。
  const src = readFileSync(join(ROOT, 'src/main/modules/audit.ts'), 'utf8')
  const start = src.indexOf('export function appendAudit(')
  assert.ok(start > 0, '找不到 appendAudit 定义')
  const body = src.slice(start, src.indexOf('\n}', start))

  assert.match(body, /boundTarget\(/, 'appendAudit 没有对 target 收口')
  assert.match(body, /boundDetail\(/, 'appendAudit 没有对 detail 收口')

  const args = callArgs(body, 'digest')
  assert.ok(args !== null, 'appendAudit 里找不到 digest( 调用')
  assert.doesNotMatch(args!, /\btarget\b/, '哈希参数里出现了未收口的 target')
  assert.doesNotMatch(args!, /\bdetail\b/, '哈希参数里出现了未收口的 detail')
})

test('校验侧不得再施加收口 —— 否则盘上旧记录会集体报篡改', () => {
  // 收口只发生在**写入时**，是单向的。
  // 旧记录写入时 hash 覆盖的是它当时的原始值，`verifyChain` 重算也用同一份
  // 存储值，仍然自洽。谁要是「顺手统一一下」在校验侧也调 `boundDetail`，
  // 盘上所有超过 400 字的历史记录会集体报篡改 —— 一条修 bug 的改动
  // 制造一整批假警报。
  const src = readFileSync(join(ROOT, 'src/main/modules/audit-chain.ts'), 'utf8')
  assert.doesNotMatch(src, /boundDetail|boundTarget|boundMatched/, 'audit-chain.ts 引入了收口函数')
  assert.doesNotMatch(src, /DETAIL_CAP|TARGET_CAP|MATCHED_CAP/, 'audit-chain.ts 引用了收口常量')
})


