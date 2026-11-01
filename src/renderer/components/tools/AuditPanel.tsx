/**
 * 审计与自检面板。
 *
 * 上半部分是「现在到底像不像配置里那台机器」——自检结果来自主进程在页面里跑的真实探测；
 * 下半部分是「过去发生了什么」——哈希链只追加，可随时重算校验。
 * 两者放同一页，是因为自检本身也会写一条审计记录：跑一次自检就能看到链在增长。
 *
 * 归属：audit-agent
 * 样式只写同目录 audit.css，不动全局样式，避免并行开发时互相覆盖。
 *
 * ── 三态原则（改这个文件之前先读这一段）──────────────────────────
 *
 * 凡是「读不到」和「读到但是空」在界面上长得一样的地方，都是缺陷。
 * 原来这里只有一个 `loadingLog: boolean` 和一个 `entries: []`：
 * 读取失败被吞成一条 toast，`entries` 保持空数组，于是页面显示「还没有审计记录」——
 * 把一次 EACCES / EBUSY 说成了「什么都没发生」。这不是文案问题，是把三态
 * （加载中 / 失败 / 空）压成了两态，而压掉的那一态恰好是「不知道」。
 *
 * 所以这里的状态一律用联合类型，不用布尔量：
 *   LogState    = loading | error | ready
 *   VerifyState = idle | running | done | error
 * 编译器会逼着每个分支都回答「这一态画什么」。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AuditEntry,
  AuditVerifyKind,
  AuditVerifyResult,
  CheckSeverity,
  ConsistencyReport,
  Profile
} from '@shared/types'
import { Button, cx, useToast } from '@renderer/components/ui'
import { ACTION_LABEL, formatClock, formatDate } from '@renderer/lib/format'
import './audit.css'

export interface PanelProps {
  profiles: Profile[]
}

const SEVERITY_TEXT: Record<CheckSeverity, string> = {
  pass: '通过',
  warn: '注意',
  fail: '失败'
}

/** 一次最多拉多少条。超出的更早记录不显示，但「验证完整性」统计的是全量。 */
const LOG_LIMIT = 200

/**
 * 断链原因的界面表达。
 *
 * 取值以 `AuditVerifyKind` 为准（`types.ts`）。前四种是**结论**（链有问题，断在这里），
 * `unreadable` 是**不知道**（没读到内容，无从判断）——后者不能用红色，
 * 因为红色是在替系统下一个它下不了的判断。
 */
interface VerifyKindView {
  /** 徽章上的两三个字，回答「是哪一类」 */
  label: string
  /** 第二句：这意味着什么、以及本页能/不能为你做什么 */
  hint: string
  /** unreadable 是「不知道」，不是「坏了」——两者不能用同一个颜色 */
  tone: 'bad' | 'warn'
}

const VERIFY_KIND: Record<AuditVerifyKind, VerifyKindView> = {
  'head-truncated': {
    label: '链首缺失',
    hint: '最早的记录不在了。如果记录数没到 5000 条上限，说明链头被删过；校验只能定位到断点，无法还原被删的内容。',
    tone: 'bad'
  },
  'seq-gap': {
    label: '序号不连续',
    hint: '中间有记录被删除。校验能指出断在哪里，但无法还原被删的那几条。',
    tone: 'bad'
  },
  'prev-mismatch': {
    label: '前序被改动',
    hint: '这一条指向的上一条哈希对不上，说明它之前的内容被改过或删过。',
    tone: 'bad'
  },
  'content-mismatch': {
    label: '内容与哈希不符',
    hint: '这条记录的内容被改过，但没有重算哈希。这是本页确实能发现的那一类改动。',
    tone: 'bad'
  },
  unreadable: {
    label: '无法判断',
    hint: '没读到审计文件的内容，所以这次没能判断链是否完整。这不等于记录损坏，也不等于没有记录。',
    tone: 'warn'
  },
  'tail-truncated': {
    label: '尾部对不上',
    hint: '最后一条和「链头锚点」（记在设置文件里）对不上：可能最新几条被删了，也可能是上次写入中断留下的锚点落后 —— 后者下一次写入会自动对齐，前者不能。',
    tone: 'bad'
  },
  unanchored: {
    label: '锚点刚建立',
    hint: '这次之前还没有锚点（旧版本数据，或设置文件被删），所以没法判断尾部有没有被删。已按当前最后一条建立锚点，从下次校验起尾部可验证；此前的记录只能验证「内部是否自洽」。',
    tone: 'warn'
  }
}

type LogState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; entries: AuditEntry[] }

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; result: AuditVerifyResult }
  | { kind: 'error'; message: string }

/**
 * **只服务 schema 之前的老记录。** 新记录的「目标」列由写入侧直接产出中文
 * （`protocol.ts:98 describeAction`），不需要在这里翻译。
 *
 * 老记录的 target 是 `[action.type, '#id', url]` 拼出来的，里面有两样东西不能
 * 直接给用户看：
 *   - `action.type` 是协议里的动作名（navigate / click …），中文界面里不该出现英文
 *   - `#e12` 是当轮快照的元素编号，用户不知道 e12 是什么，也不该知道
 *
 * 这是**字符串解析**，而 `protocol.ts:105-111` 明确写着「不要用 message 的字符串来判」。
 * 之所以只能这么做：老记录里没有结构化的动作字段，动作类型只以 token 形式存在于
 * target 里。**删除条件**：等做过一次数据迁移，把 `audit.json` 里 schema 之前的
 * 记录清掉或改写掉，这个函数连同它的测试可以整个删掉。在那之前它必须留着——
 * 删了以后历史记录会重新露出 `navigate https://…` 和 `click #e7`。
 */
function formatAuditTarget(target?: string): string | null {
  const tokens = (target ?? '').trim().split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) return null

  const humanize = (token: string): string =>
    token.startsWith('#') ? '某个元素' : token

  const verb = ACTION_LABEL[tokens[0] as keyof typeof ACTION_LABEL]
  if (!verb) return tokens.map(humanize).join(' ')
  const rest = tokens.slice(1).map(humanize)
  if (rest.length === 0) return verb
  // 中文动词后面不空格；URL / 选择器前面留一个空格，否则会粘成一串
  return `${verb}${/^https?:/i.test(rest[0]) ? ' ' : ''}${rest.join(' ')}`
}

/** 90 分以上说明这套参数自洽；70 以下基本会被风控当成拼装环境 */
function scoreTone(score: number): 'ok' | 'warn' | 'bad' {
  if (score >= 90) return 'ok'
  if (score >= 70) return 'warn'
  return 'bad'
}

/**
 * 没有 `kind` 时（旧主进程）的兜底句。
 *
 * 原来这里是一句固定的「这次没能定位到具体是哪一条，只能确定校验没有通过」。
 * 但旧主进程是会给 `brokenAt` 的，那时徽章正写着「断在第 4 条」，两句话在
 * 同一屏上互相打脸——一句说「断在第 4 条」，一句说「没能定位到哪一条」。
 * 用户看到这种矛盾时不会觉得是文案 bug，他会怀疑整页的结论都不可信。
 *
 * 兜底句也必须读手里的字段，不能假设「没有 kind 就什么都没有」。
 */
function fallbackHint(r: AuditVerifyResult): string {
  if (r.brokenAt !== undefined) {
    // 只说「停在哪」，不说「前面都核对过了」——`brokenAt` 有八种产生方式
    // （`audit-chain.ts:108/143/159/168/179/195/206/217`），其中 `head-truncated`
    // 的断点指向的是「现存最早的一条」，它前面的记录压根不存在，说「逐条核对过」
    // 是在替不存在的记录背书。没有 kind 就分不清是哪一种，所以只能陈述最弱的事实。
    return `校验在第 ${r.brokenAt} 条停下；从这一条起的内容，这次没能证明是完好的。`
  }
  return '这次没有拿到断点位置，所以既不能说它是完整的，也不能说它断在某一条。'
}

function readError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 去掉 Electron 给 IPC 失败套的那层壳。
 *
 * 原始消息长这样：`Error invoking remote method 'ss:audit:list': Error: EACCES: ...`
 * 前半截是通道名，用户不需要知道，而且它会把真正的原因挤到屏幕外。
 * 这一层是所有 IPC 报错的共同噪音，不只是审计页——所以单独抽出来。
 */
function cleanIpcMessage(raw: string): string {
  const m = /Error invoking remote method '[^']*':\s*(?:Error:\s*)?([\s\S]*)$/.exec(raw)
  return (m?.[1] ?? raw).trim()
}

/**
 * 校验结论 → 徽章。
 *
 * 这里有一个反直觉的地方：`ok: true` 不等于「链路完整」。
 * `audit.ts:195-204` 的 message 已经写明理由——digest 是无密钥 sha256，
 * 拿到算法就能把整条链从任意一条开始重算，算出完全自洽的 hash 与 prev。
 * 所以已校验态只说「未发现不一致」，不说「完整」。
 *
 * 第二个地方：`ok: true` 且 `total === 0` 时**不给徽章**。
 * 空链没有任何东西可校验，此时点亮一个绿色或琥珀色徽章，都是在替
 * 「我们什么都没读到」这件事背书。空态自己会说「还没有闸门记录」。
 */
function verifyBadge(verify: VerifyState): { text: string; tone: 'bad' | 'warn' } | null {
  if (verify.kind === 'error') return { text: '无法判断', tone: 'warn' }
  if (verify.kind !== 'done') return null
  const r = verify.result
  if (r.consistent) {
    if (r.total === 0) return null
    return { text: '未发现不一致', tone: 'warn' }
  }
  // 没有 kind 说明主进程还是旧版本。有 brokenAt 才敢说「断在第几条」，
  // 否则只能是「不知道」——把「不知道」写成「断在第 ? 条」是在编一个断点。
  if (r.kind) return { text: VERIFY_KIND[r.kind].label, tone: VERIFY_KIND[r.kind].tone }
  if (r.brokenAt !== undefined) return { text: `断在第 ${r.brokenAt} 条`, tone: 'bad' }
  return { text: '无法判断', tone: 'warn' }
}

export function AuditPanel({ profiles }: PanelProps) {
  const toast = useToast()
  const [profileId, setProfileId] = useState<string>(profiles[0]?.id ?? '')
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<ConsistencyReport | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [log, setLog] = useState<LogState>({ kind: 'loading' })
  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' })

  // 环境列表是异步来的：首帧可能还是空的，等它到了再补一个默认选中
  useEffect(() => {
    if (profileId && profiles.some((p) => p.id === profileId)) return
    setProfileId(profiles[0]?.id ?? '')
  }, [profiles, profileId])

  const refreshLog = useCallback(async (): Promise<void> => {
    // 已经有数据时不退回「加载中」：刷新一次就让表格闪成骨架，比不刷新更难读。
    // 但失败必须覆盖成功的结果——继续显示旧数据等于谎报新鲜度。
    setLog((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
    try {
      setLog({ kind: 'ready', entries: await window.ss.audit.list(LOG_LIMIT) })
    } catch (err) {
      setLog({ kind: 'error', message: cleanIpcMessage(readError(err)) })
    }
  }, [])

  useEffect(() => {
    void refreshLog()
  }, [refreshLog])

  const active = profiles.find((p) => p.id === profileId) ?? null

  const summary = useMemo(() => {
    if (!report) return null
    const pass = report.items.filter((i) => i.severity === 'pass').length
    const warn = report.items.filter((i) => i.severity === 'warn').length
    const fail = report.items.filter((i) => i.severity === 'fail').length
    return { pass, warn, fail, total: report.items.length }
  }, [report])

  async function runCheck(): Promise<void> {
    if (!profileId) {
      toast.push('请先选择一个环境', 'info')
      return
    }
    setRunning(true)
    setCheckError(null)
    try {
      const next = await window.ss.selfcheck.run(profileId)
      setReport(next)
      // 自检会往链里追加一条，旧的校验结论立刻失效
      setVerify({ kind: 'idle' })
      await refreshLog()
    } catch (err) {
      // 不能只弹 toast：toast 会消失，消失之后面板会说「还没有自检结果」，
      // 把一次失败说成「没跑过」。失败要留在原地。
      setCheckError(cleanIpcMessage(readError(err)))
    } finally {
      setRunning(false)
    }
  }

  async function runVerify(): Promise<void> {
    setVerify({ kind: 'running' })
    try {
      const r: unknown = await window.ss.audit.verify()
      // 验形守卫。它防的是「返回体形状不对」，和下面的改名是**两件不同的事**，
      // 两个都要留着。
      //
      // 【历史】这个字段曾经叫 `ok`，和 `Result<T>` 包装的判别字段同名。同名时
      // 任何一环少包或多包一层，渲染层拿到的就是 `undefined`，面板里一次属性访问
      // 就抛、React 卸载整棵树 → 审计面板空白，用户连报错都看不到。
      // 改名成 `consistent` 之后这条路径不可能再被误判，但**守卫不能因此删掉**：
      // 它挡的是「传输层形状不对」，与字段叫什么名字无关。
      //
      // 只查一个字段是不够的：面板后面还要读 `total`、`kind`、`brokenAt`。
      // 实测过一种形状——`consistent` 在、`total` 不在——于是界面上直接印出
      // 「共 undefined 条」。验形要覆盖**这一层真正会读的每一个字段**，
      // 否则守卫只是把崩溃换成了协议噪音：崩溃至少是响的，`undefined`
      // 印在界面上是安静的，用户会以为数据就长这样。
      if (
        r === null ||
        typeof r !== 'object' ||
        typeof (r as AuditVerifyResult).consistent !== 'boolean' ||
        typeof (r as AuditVerifyResult).total !== 'number'
      ) {
        setVerify({ kind: 'error', message: '校验没有返回可读的结论（返回体形状不对）' })
        return
      }
      setVerify({ kind: 'done', result: r as AuditVerifyResult })
    } catch (err) {
      setVerify({ kind: 'error', message: cleanIpcMessage(readError(err)) })
    }
  }

  const entries = log.kind === 'ready' ? log.entries : []
  const verdict = verify.kind === 'done' ? verify.result : null
  const view = verdict && !verdict.consistent && verdict.kind ? VERIFY_KIND[verdict.kind] : null
  const badge = verifyBadge(verify)

  return (
    <div className="au">
      <div className="page-head">
        <div>
          <h2>审计与自检</h2>
          <p>在真实页面里核对指纹，并按哈希链校验每一条操作记录</p>
        </div>
      </div>

      <section className="au-sec">
        <div className="au-head">
          <div className="au-title">
            <h3>指纹一致性自检</h3>
            <span>对照环境配置与页面实际读数，逐项给结论</span>
          </div>
          <div className="au-pick">
            <select
              className="au-select"
              value={profileId}
              disabled={profiles.length === 0 || running}
              onChange={(e) => setProfileId(e.target.value)}
              aria-label="选择要自检的环境"
            >
              {profiles.length === 0 ? <option value="">暂无环境</option> : null}
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.status === 'running' ? '（运行中）' : ''}
                </option>
              ))}
            </select>
            <Button
              variant="primary"
              icon="shield"
              disabled={running || !profileId}
              onClick={() => void runCheck()}
            >
              {running ? '自检中…' : '开始自检'}
            </Button>
          </div>
        </div>

        {active && active.status !== 'running' ? (
          <p className="au-note">
            自检需要读取页面内的真实值，请先打开 <b>{active.name}</b> 的窗口再开始。
          </p>
        ) : null}

        {checkError ? (
          <p className="au-note bad">
            <b>这次自检没有跑完：</b>
            {checkError}
            <span className="au-note-sub">这不等于自检结果正常，也不等于没有自检过。</span>
          </p>
        ) : null}

        {report && summary ? (
          <>
            <div className="au-score">
              <div className={cx('au-score-v', scoreTone(report.score))}>
                {report.score}
                <small>分</small>
              </div>
              <div className="au-score-meta">
                <div className="au-score-t">
                  {report.profileName}
                  <span className={cx('au-pill', scoreTone(report.score))}>
                    {report.score >= 90 ? '参数自洽' : report.score >= 70 ? '存在疑点' : '容易被识破'}
                  </span>
                </div>
                <div className="au-score-d">
                  {formatDate(report.checkedAt)} {formatClock(report.checkedAt)} · 通过 {summary.pass} · 注意{' '}
                  {summary.warn} · 失败 {summary.fail} · 共 {summary.total} 项
                </div>
              </div>
            </div>

            <div className="au-table au-check">
              <div className="au-tr au-th">
                <span>检查项</span>
                <span>期望</span>
                <span>实际</span>
                <span>结果</span>
              </div>
              {report.items.map((i) => (
                <div key={i.key} className={cx('au-tr', i.severity)}>
                  <span className="au-k">
                    <b>{i.label}</b>
                    {i.hint ? <em>{i.hint}</em> : null}
                  </span>
                  <span className="au-mono" title={i.expected}>
                    {i.expected}
                  </span>
                  <span className="au-mono" title={i.actual}>
                    {i.actual}
                  </span>
                  <span className={cx('au-tag', i.severity)}>{SEVERITY_TEXT[i.severity]}</span>
                </div>
              ))}
            </div>
          </>
        ) : checkError ? null : (
          <div className="au-empty">
            <b>还没有自检结果</b>
            <p>
              选中一个已打开的环境并开始自检，会逐项比对 UA、时区、屏幕、WebGL、WebRTC、字体等读数，
              给出这套指纹是否自洽的分数。
            </p>
          </div>
        )}
      </section>

      <section className="au-sec">
        <div className="au-head">
          <div className="au-title">
            <h3>审计日志</h3>
            <span>按时间顺序追加，每条携带上一条的哈希</span>
          </div>
          <div className="au-pick">
            {badge ? (
              <span className={cx('au-verdict', badge.tone)} role="status">
                {badge.text}
              </span>
            ) : null}
            <Button
              variant="ghost"
              icon="lock"
              disabled={verify.kind === 'running'}
              onClick={() => void runVerify()}
            >
              {verify.kind === 'running' ? '校验中…' : '验证完整性'}
            </Button>
          </div>
        </div>

        {/* 范围：先说清这里记什么，后面的「还没有」才是一句可以相信的话 */}
        <p className="au-scope">
          <b>这里记录的是闸门判定与指纹自检</b>
          {'。环境的新建、修改、删除，普通页面操作，以及脚本回放的每一步，都不在这里。'}
        </p>

        {/* 免责常驻：不能只在「有数据」时才出现——用户第一次打开这页时它是空的，
            而那正是他形成印象的时刻 */}
        <p className="au-disclaim">
          <b>无法验证完整性</b>
          {/* 只陈述**永远成立**的事。原来这里还有半句「锚点缺失时核对不了，那种
              情况会单独报『锚点刚建立』而不是通过」——那半句是随状态变化的信息，
              而这段在加载中 / 失败 / 空 / 有数据四种状态下都常驻：用户读到它时屏幕上
              多半没有那个徽章，他会去找一个不存在的东西。该说的话由 unanchored 的
              hint 自己说（见上方 VERIFY_KIND），那里徽章和解释同时在场。 */}
          {'：摘要无密钥，整条链可被整体重算。本页能发现「改了内容但没有重算哈希」，以及「整份 / 尾部被删」——后者靠链头锚点（记在设置文件里）核对。'}
          {/* 数字不确定就不印。`共 undefined 条` 比不印更坏：它会让用户
              怀疑整页所有数字都是编的 */}
          {verdict && typeof verdict.total === 'number' ? `共 ${verdict.total} 条。` : ''}
        </p>

        {/* 校验没通过的详情。message 由主进程按 kind 写，这里只补「所以呢」——
            不自己拼原因，否则就是第三份文案 */}
        {verdict && !verdict.consistent ? (
          <p className={cx('au-note', view?.tone ?? 'warn')}>
            <b>{verdict.message}</b>
            <span className="au-note-sub">{view?.hint ?? fallbackHint(verdict)}</span>
          </p>
        ) : null}

        {verify.kind === 'error' ? (
          <p className="au-note warn">
            <b>这次校验没有跑完：</b>
            {verify.message}
            <span className="au-note-sub">
              没有拿到结论，所以现在既不能说它完整，也不能说它断了。可以再点一次「验证完整性」。
            </span>
          </p>
        ) : null}

        {log.kind === 'loading' ? (
          <div className="au-empty">
            <b>正在读取审计记录…</b>
          </div>
        ) : log.kind === 'error' ? (
          <div className="au-empty bad">
            <b>读不到审计记录</b>
            <p>{log.message}</p>
            <p className="au-empty-hint">
              这不等于「没有记录」。文件可能被杀毒软件或索引服务占用，也可能没有读权限。
            </p>
            <Button variant="ghost" onClick={() => void refreshLog()}>
              重新读取
            </Button>
          </div>
        ) : entries.length === 0 ? (
          <div className="au-empty">
            <b>还没有闸门记录</b>
            <p>
              这个环境还没触发过风险判定，也没跑过自检。跑一次自检，或者让影子执行一个动作，
              记录就会出现在这里。
            </p>
          </div>
        ) : (
          <>
            <div className="au-table au-log">
              <div className="au-tr au-th">
                <span>时间</span>
                <span>动作</span>
                <span>目标</span>
                <span>哈希</span>
              </div>
              {entries.map((e) => (
                <div key={e.id} className="au-tr">
                  <span className="au-mono au-time">
                    {formatDate(e.at)} {formatClock(e.at)}
                  </span>
                  <span className="au-act">{e.action}</span>
                  <span className="au-target" title={e.detail ?? formatAuditTarget(e.target) ?? ''}>
                    {formatAuditTarget(e.target) ?? '—'}
                    {e.detail ? <em>{e.detail}</em> : null}
                  </span>
                  <span className="au-mono au-hash" title={`${e.hash}\nprev ${e.prev}`}>
                    {e.hash.slice(0, 8)}
                    <i>#{e.seq}</i>
                  </span>
                </div>
              ))}
            </div>
            <p className="au-foot">
              最多显示最近 {LOG_LIMIT} 条；哈希显示前 8 位，悬停可看完整值与上一条哈希。
              {entries.length >= LOG_LIMIT
                ? `已到上限，更早的记录没有显示；「验证完整性」统计的是全量。`
                : ''}
            </p>
          </>
        )}
      </section>
    </div>
  )
}
