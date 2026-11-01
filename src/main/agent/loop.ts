/**
 * Agent 主循环：observe → decide → act → verify。
 *
 * 三条不可动摇的设计：
 * 1. **每轮都重新抓快照**。页面是活的，缓存的元素编号可能已经指向另一个东西，
 *    宁可多抓一次也不要在旧快照上执行动作（幻觉点错就是这个原因）。
 * 2. **失败不中断**。点击落空是常态（元素被遮挡、懒加载未完成），
 *    下一轮快照会自愈；只有「页面关闭 / 模型连续输出非 JSON」才终止。
 * 3. **风险判定在循环外**。L2 动作一律走系统原生确认框，绝不靠模型自觉。
 */

import type { CdpBridge } from '@main/core/cdp'
import type {
  ActionResult,
  Action,
  AgentEvent,
  AgentStep,
  ModelDecision,
  PageSnapshot,
  RunRequest
} from '@shared/protocol'
import type { Settings, TaskRecord } from '@shared/types'
import { actionSemantic, describeAction } from '@shared/protocol'

import { captureSnapshot } from '@main/agent/snapshot'
import { executeAction } from '@main/agent/actions'
import { assessRisk } from '@main/agent/risk'
import { requestConsent, type ConsentOutcome } from '@main/agent/consent'
import { auditGate } from '@main/modules/audit'
import { getStores } from '@main/store'
import { chat, parseJSONLoose, type ChatMessage } from '@main/agent/llm'
import { SYSTEM_PROMPT, buildUserMessage } from '@main/agent/prompt'

export interface LoopDeps {
  /** 取当前标签页的 CDP 桥；返回 null 表示页面已关闭 */
  getCdp: () => CdpBridge | null
  settings: Settings
  emit: (e: AgentEvent) => void
  /**
   * 发起这次 run 的渲染层 webContents id，绑到同意凭证上。
   *
   * 注意这里**没有** `askConfirm`：同意不再由渲染层回答。
   * 原先的 `askConfirm` 等的是渲染层回一个 boolean，而渲染层正是可能被 XSS 的那一层 ——
   * 把「要不要执行不可逆动作」的答案交给它，等于把闸门建在被攻破的一侧。
   */
  senderId?: number
}

/** 步数上限的硬边界：太小做不成事，太大就是烧钱且容易在同一个坑里打转 */
const MIN_STEPS = 1
const MAX_STEPS_LIMIT = 30
/** 跳转后给页面留一点时间发起请求，否则下一轮抓到的还是旧页面 */
const NAVIGATE_SETTLE_MS = 900

/**
 * 「没拿到票」的四种原因，分别怎么讲给模型听。
 *
 * 不能合成一句话：用户点了取消（别再来烦我）、120 秒没人理（人可能不在）、
 * 窗口弹不出来（环境有问题）、任务被停止（用户要走）—— 模型对这四种的
 * 正确反应完全不同，混成「用户拒绝了」会让它在人不在的时候反复重试。
 */
const CONSENT_REFUSAL: Record<ConsentOutcome['kind'], string> = {
  granted: '已获授权',
  denied: '用户在系统确认窗口中点了「取消」',
  timeout: '系统确认窗口 120 秒内无人确认，按拒绝处理',
  unavailable: '系统确认窗口无法弹出，按拒绝处理'
}

export async function runAgent(
  req: RunRequest,
  deps: LoopDeps,
  signal: AbortSignal
): Promise<TaskRecord> {
  const startedAt = Date.now()
  const task: TaskRecord = {
    id: `tsk_${Math.random().toString(36).slice(2, 10)}`,
    profileId: req.profileId,
    intent: req.intent,
    status: 'running',
    plan: [],
    steps: [],
    summary: '',
    startedAt,
    finishedAt: null,
    tokens: 0
  }

  deps.emit({ type: 'started', taskId: task.id, at: startedAt })

  const maxSteps = clampInt(deps.settings.maxSteps, MIN_STEPS, MAX_STEPS_LIMIT)

  try {
    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
      if (signal.aborted) {
        task.status = 'stopped'
        task.summary = '已被用户停止'
        deps.emit({ type: 'stopped' })
        return task
      }

      const cdp = deps.getCdp()
      if (!cdp) throw new Error('目标页面已关闭')

      const snapshot = await captureSnapshot(cdp)
      deps.emit({ type: 'thinking', index: stepIndex })

      // ── decide ──────────────────────────────────────────────
      let decision: ModelDecision
      try {
        decision = await decide({
          settings: deps.settings,
          snapshot,
          intent: req.intent,
          history: task.steps,
          stepIndex,
          maxSteps,
          signal,
          // 边聊边记账：解析失败时 token 也已经花掉了，不能因为抛错就不计成本
          onTokens: (n) => {
            task.tokens += n
          }
        })
      } catch (err) {
        // 两次都拿不到合法 JSON，说明模型或服务商不给力，继续跑只会烧 token。
        // 记一步 failed 让 UI 看得见，再交给外层统一 emit error。
        const message = err instanceof Error ? err.message : String(err)
        const failed: AgentStep = {
          index: stepIndex,
          plan: '',
          thought: '',
          action: { type: 'done' },
          status: 'failed',
          result: message,
          label: '模型输出解析失败',
          at: Date.now(),
          durationMs: 0
        }
        task.steps.push(failed)
        deps.emit({ type: 'step', step: { ...failed } })
        throw new Error(message)
      }

      const action = decision.action
      const plan = (decision.plan ?? '').trim()
      const thought = (decision.thought ?? '').trim()

      // 计划只在变化时推送，否则 UI 每轮都会闪一下
      const planList = splitPlan(plan)
      if (planList.length > 0 && planList.join('\u0000') !== task.plan.join('\u0000')) {
        task.plan = planList
        deps.emit({ type: 'plan', plan: planList })
      }

      // ── done ────────────────────────────────────────────────
      if (action.type === 'done') {
        const summary = (action.summary ?? '').trim() || '任务完成'
        const step: AgentStep = {
          index: stepIndex,
          plan,
          thought,
          action,
          status: 'ok',
          result: summary,
          label: describeAction(action, snapshot),
          at: Date.now(),
          durationMs: 0
        }
        task.steps.push(step)
        deps.emit({ type: 'step', step: { ...step } })
        task.status = 'done'
        task.summary = summary
        deps.emit({ type: 'done', summary, data: action.data, steps: task.steps, tokens: task.tokens })
        return task
      }

      // ── risk gate ───────────────────────────────────────────
      // click 动作里只有元素编号，光看 action 扫不出「立即支付」这种语义，
      // 必须把目标元素的可读名和模型自述一起送进判定。
      //
      // 闸门与执行器必须看到**同一段文本**，否则会出现「闸门判 L1、执行器判 L2」：
      // 不弹确认框 → 没有票 → 动作被拦 → 用户从未被问过 → 模型重试到步数耗尽。
      //
      // 这个 bug 真发生过：两边各自拼串，而抑制规则看的是「命中词紧邻的右文」，
      // 元素名拼两次就把那段右文换掉了，抑制随之失效。现在拼接收敛到
      // `actionSemantic`（`@shared/protocol`）—— 元素名由它自己从快照取，
      // 调用方只能传 `note`，「拼两次」在结构上写不出来。
      //
      // 送给执行器的 `note` 只放**模型自述**，元素名由执行器自己取
      // （本地 HTTP API 手里只有 action.id，拿不到元素名，靠调用方传就漏了那条路径）。
      const verdict = assessRisk(action, req.intent, actionSemantic(action, snapshot, thought))
      // 凭证默认没有。它不是「我判定这是 L2」推出来的，而是 requestConsent
      // 真的返回了一张票 —— 也就是有人在系统窗口上点了「允许执行」。
      // 这里刻意不写成 `verdict.level === 'L2' ? 'user' : 'none'`：
      // 那等于把「我判定这是 L2」当成「用户批准过」，用结论代替证据。
      let ticket: string | undefined
      if (verdict.level === 'L2') {
        // 这个事件现在只是**展示**：让界面能显示「等待你在系统窗口中确认」。
        // 它不再承载决策，渲染层回什么都不影响下面这一步。
        deps.emit({ type: 'need-confirm', reason: verdict.reason, action, stepIndex })
        const outcome = await raceAbort(
          requestConsent(
            {
              action,
              level: 'L2',
              reason: verdict.reason,
              matched: verdict.matched,
              target: describeAction(action, snapshot),
              origin: 'loop'
            },
            deps.senderId
          ),
          signal
        )
        if (!outcome || outcome.kind !== 'granted') {
          // 拒绝原因必须留在历史里，否则模型下一轮还会提同样的动作（死循环的头号来源）。
          // 四种「没拿到票」的原因分开写：模型据此决定换方案还是直接结束，
          // 而「超时」和「用户点了取消」对它的含义完全不同。
          const rejected: AgentStep = {
            index: stepIndex,
            plan,
            thought,
            action,
            status: 'rejected',
            result: `${CONSENT_REFUSAL[outcome?.kind ?? 'denied']}（${verdict.reason}），换一个方案或结束`,
            label: describeAction(action, snapshot),
            at: Date.now(),
            durationMs: 0
          }
          task.steps.push(rejected)
          deps.emit({ type: 'step', step: { ...rejected } })
          continue
        }
        ticket = outcome.ticket
      }

      // ── act ─────────────────────────────────────────────────
      const step: AgentStep = {
        index: stepIndex,
        plan,
        thought,
        action,
        status: 'running',
        label: describeAction(action, snapshot),
        at: Date.now()
      }
      deps.emit({ type: 'step', step: { ...step } })

      let outcome: ActionResult
      try {
        outcome = await executeAction(cdp, action, snapshot, {
          // 只有 requestConsent 真的返回了票才会有值。L1（含只读意图降级）
          // 不预支授权：那种情况下执行器用同一份 intent 重算出来也是 L1，
          // 根本走不到判断上；万一两份结论不一致，没有票会让执行器抛错，
          // 把不一致暴露出来而不是悄悄放行。
          ...(ticket !== undefined ? { ticket } : {}),
          origin: 'agent',
          intent: req.intent,
          note: thought,
          ...(deps.senderId !== undefined ? { senderId: deps.senderId } : {}),
          // 闸门事件落到同一条审计链：原先 agent 这条路径跑 40 步一个字节都不留，
          // 事后完全无法回答「它到底点过什么」。
          onGate: (event) => auditGate(getStores(), event)
        })
      } catch (err) {
        // 执行器抛错（元素消失、CDP 断开）不该毁掉整个任务：
        // 记成 failed，下一轮快照会看到真实页面状态。
        outcome = {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          failure: 'exec'
        }
      }

      step.status = outcome.ok ? 'ok' : 'failed'
      step.result = outcome.message
      // 分类跟着走：界面用它选文案，不再去猜 message 里的措辞
      if (outcome.failure) step.failure = outcome.failure
      step.durationMs = Date.now() - step.at
      task.steps.push(step)
      deps.emit({ type: 'step', step: { ...step } })

      if (action.type === 'navigate') await sleep(NAVIGATE_SETTLE_MS, signal)
    }

    // 步数耗尽：不是异常，是任务太大
    task.status = 'failed'
    task.summary = `已执行 ${maxSteps} 步仍未完成，建议把任务拆小`
    deps.emit({ type: 'error', message: task.summary })
    return task
  } catch (err) {
    // 用户主动停止时，中断信号会让 chat 抛错，这时应记 stopped 而不是 failed
    if (signal.aborted) {
      task.status = 'stopped'
      task.summary = '已被用户停止'
      deps.emit({ type: 'stopped' })
      return task
    }
    const message = err instanceof Error ? err.message : String(err)
    task.status = 'failed'
    task.summary = message
    // 不吞异常：错误既写进 TaskRecord.summary 落库，也通过事件推给 UI
    deps.emit({ type: 'error', message })
    return task
  } finally {
    // 无论从哪条路径返回，finishedAt 都必须有值，否则任务列表会永远显示「进行中」
    task.finishedAt = Date.now()
  }
}

/* ────────────────────────────── 决策 ────────────────────────────── */

async function decide(args: {
  settings: Settings
  snapshot: PageSnapshot
  intent: string
  history: AgentStep[]
  stepIndex: number
  maxSteps: number
  signal: AbortSignal
  onTokens: (n: number) => void
}): Promise<ModelDecision> {
  const base: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: buildUserMessage({
        snapshot: args.snapshot,
        intent: args.intent,
        history: args.history,
        stepIndex: args.stepIndex,
        maxSteps: args.maxSteps
      })
    }
  ]

  const first = await chat({
    settings: args.settings,
    messages: base,
    jsonMode: true,
    signal: args.signal
  })
  args.onTokens(first.tokens)

  try {
    return normalize(parseJSONLoose<ModelDecision | null>(first.content))
  } catch {
    // 部分兼容服务无视 response_format，仍会夹带解释文字。
    // 与其直接失败，不如把「你上次输出的不是 JSON」明确回喂一次，成功率很高。
    const retry = await chat({
      settings: args.settings,
      messages: [
        ...base,
        { role: 'assistant', content: first.content },
        { role: 'user', content: '上次输出不是合法 JSON，只输出 JSON，不要解释，不要代码块围栏。' }
      ],
      jsonMode: true,
      signal: args.signal
    })
    args.onTokens(retry.tokens)
    return normalize(parseJSONLoose<ModelDecision | null>(retry.content))
  }
}

/**
 * 运行时兜底：JSON 合法不代表字段齐全。
 * 模型偶尔会输出 {"thought":...} 漏掉 action，直接访问会抛 TypeError，
 * 在这里折成可读错误，才能走「解析失败」那条重试/终止路径。
 */
function normalize(raw: ModelDecision | null): ModelDecision {
  if (!raw || typeof raw !== 'object') throw new Error('模型输出不是对象')
  const action = raw.action
  if (!action || typeof action.type !== 'string') throw new Error('模型输出缺少 action 字段')
  return {
    plan: typeof raw.plan === 'string' ? raw.plan : '',
    thought: typeof raw.thought === 'string' ? raw.thought : '',
    action
  }
}

/* ────────────────────────────── 小工具 ────────────────────────────── */

/** plan 是一句话，但 UI 需要列表；按句号/分号/换行切，避免出现「一条超长计划」 */
function splitPlan(plan: string): string[] {
  if (!plan) return []
  return plan
    .split(/[。；;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 8)
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** 可被 abort 打断的等待：用户点停止时不该再白等 900ms */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    if (signal.aborted) {
      done()
      return
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * 等一个「人可能永远不会回答」的 promise，但用户点停止时立刻放行。
 *
 * 没有这层的话，对话框开着时点「停止」会看起来毫无反应 —— 主循环卡在
 * 一个最长 120 秒的等待里，停止按钮形同虚设。被放弃的那个 promise
 * 仍然会在用户之后点「允许」时铸出一张票，但没人会去消费它，
 * 下次发券时被 sweep 清掉。
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise<T | null>((resolve) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      resolve(null)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve(null)
      }
    )
  })
}
