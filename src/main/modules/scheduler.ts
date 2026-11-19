/**
 * 定时任务模块（主进程）。
 *
 * 两条职责，刻意放在同一个文件里：
 * - 注册 CRUD / 手动触发的 IPC（`registerSchedulerModule`）；
 * - 提供 30 秒扫描一次的调度循环（`startScheduler`），按
 *   `schedule-policy.ts` 的结论执行「启动环境 / 运行脚本」。
 *
 * 为什么规则不在这里：`nextRunAt` / `isDue` 一旦和 Electron、存储混在一起，
 * 就再也没法用 node:test 验证「跨天、disabled、两种模式互斥」这些边界。
 * 这里只做 IO 和记账。
 *
 * 归属：scheduler
 */

import { CH } from '@shared/ipc'
import type { ScheduleKind, ScheduleRecord } from '@shared/types'
import { CollectionStore } from '@main/store'
import { appendAudit } from './audit'
import { runScript } from './scripts'
import type { ModuleContext } from './context'
import { isDue, nextRunAt, validateSchedule } from './schedule-policy'
import { emitWebhook } from './webhooks'

/** 30 秒扫一次：对「每日 HH:MM」足够准，也不会把事件循环占满 */
const SCAN_INTERVAL_MS = 30_000

interface ExecutionOutcome {
  ok: boolean
  /** 给用户看的结果描述，同时写进 lastResult */
  message: string
  /** 审计「目标」列：优先用人可读的环境名 / 脚本名 */
  target: string
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 真正执行一次动作，并返回结果描述。
 *
 * 所有失败都折算成 `{ok:false, message}`，不向外抛：定时任务失败是
 * 常态（环境被删、脚本被删），它应该变成一条「上一次结果」而不是
 * 让整轮调度停摆。
 */
async function performSchedule(
  ctx: ModuleContext,
  rec: ScheduleRecord
): Promise<ExecutionOutcome> {
  if (rec.kind === 'launch') {
    const profile = ctx.stores.profiles.get(rec.targetId)
    if (!profile) {
      // 环境可能已被删除（含回收站），这里不尝试「猜一个最像的」。
      return {
        ok: false,
        message: `启动失败：环境不存在（${rec.targetId}）`,
        target: rec.targetId
      }
    }
    try {
      await ctx.runtime.launch(rec.targetId)
      return { ok: true, message: `已启动 ${profile.name}`, target: profile.name }
    } catch (err) {
      return {
        ok: false,
        message: `启动「${profile.name}」失败：${errorText(err)}`,
        target: profile.name
      }
    }
  }

  if (rec.kind === 'script') {
    // 脚本必须指定「在哪个环境里跑」：AutomationScript.profileId 只是录制来源，
    // 语义上不能当运行环境（用户可能想在同一脚本上换环境重放）。
    // 缺环境时如实报错，不猜一个最像的。
    const script = ctx.stores.scripts.get(rec.targetId)
    if (!script) {
      return { ok: false, message: `脚本不存在（${rec.targetId}）`, target: rec.targetId }
    }
    const runProfileId = rec.profileId
    if (!runProfileId) {
      return { ok: false, message: '未指定运行环境，无法执行脚本', target: script.name }
    }
    const runProfile = ctx.stores.profiles.get(runProfileId)
    if (!runProfile) {
      return { ok: false, message: `运行环境不存在（${runProfileId}）`, target: script.name }
    }
    try {
      // 复用 scripts.ts 的 runScript：L2 风险闸门、伪装闸门、凭证校验全部照旧。
      // senderId 传 undefined（定时触发没有发起方窗口），同意票不绑定渲染进程，
      // 但确认窗仍然弹 —— 闸门不会被绕过。
      const result = await runScript(ctx, rec.targetId, runProfileId, undefined, undefined)
      return {
        ok: true,
        message: `已运行「${script.name}」：${result.executed}/${result.total} 步`,
        target: `${script.name} @ ${runProfile.name}`
      }
    } catch (err) {
      return {
        ok: false,
        message: `运行「${script.name}」失败：${errorText(err)}`,
        target: `${script.name} @ ${runProfile.name}`
      }
    }
  }

  return {
    ok: false,
    message: `未知的动作类型：${String(rec.kind)}`,
    target: rec.targetId
  }
}

/** 记账：失败也推进 lastRunAt，否则 isDue 恒真、每 30 秒重试一次 */
function recordLastRun(ctx: ModuleContext, rec: ScheduleRecord, message: string): void {
  try {
    // 用完成时刻而不是开始时刻：一次启动/回放如果比周期还长，
    // 用开始时刻会让下一轮扫描立刻再次判定到期。
    ctx.stores.schedules.update(rec.id, {
      lastRunAt: Date.now(),
      lastResult: message
    })
  } catch {
    // 记录可能在执行期间被用户删掉。动作已经发生，记账失败不该
    // 把它报成一次执行失败，也不该让调度循环停下来。
  }
}

/**
 * 审计写入失败不能反过来改写执行结果。
 *
 * 动作已经发生（窗口已经打开），把 lastResult 改成「审计失败」会让用户
 * 以为启动没成功；这与 consent.ts 对审计失败的处置一致：留主进程日志。
 */
function auditExecution(ctx: ModuleContext, outcome: ExecutionOutcome): void {
  try {
    appendAudit(ctx.stores, '定时·执行', outcome.target, outcome.message)
  } catch (err) {
    console.error('[scheduler] 审计写入失败', err)
  }
}

/**
 * 执行一次并返回结果描述。**只给自动调度用**。
 *
 * 手动 runNow 不走这里：它不能推进 lastRunAt（见 runNow 的注释）。
 */
export async function executeSchedule(
  ctx: ModuleContext,
  rec: ScheduleRecord
): Promise<string> {
  const outcome = await performSchedule(ctx, rec)
  recordLastRun(ctx, rec, outcome.message)
  auditExecution(ctx, outcome)
  // 定时结果回调：不阻塞、不重试，失败只进审计（见 webhooks.ts）
  void emitWebhook(ctx.stores, 'schedule.done', {
    scheduleId: rec.id,
    kind: rec.kind,
    targetId: rec.targetId,
    ok: outcome.ok,
    message: outcome.message
  })
  return outcome.message
}

/* ────────────────────────────── 注册 ────────────────────────────── */

export function registerSchedulerModule(ctx: ModuleContext): void {
  const schedules = ctx.stores.schedules

  ctx.handle(CH.schedules.list, () =>
    // createdAt 降序：最近建的在最上面，和脚本库/代理池的列表习惯一致
    schedules.list().sort((a, b) => b.createdAt - a.createdAt)
  )

  ctx.handle(CH.schedules.create, (_event, input) => {
    const raw = (input !== null && typeof input === 'object' ? input : {}) as {
      kind?: unknown
      targetId?: unknown
      profileId?: unknown
      everyMinutes?: unknown
      dailyAt?: unknown
      enabled?: unknown
    }

    const kind = typeof raw.kind === 'string' ? raw.kind : ''
    const targetId = typeof raw.targetId === 'string' ? raw.targetId.trim() : ''
    // 间隔按原值交给校验：字符串 / 小数 / 0 都应该得到明确的「不合法」，
    // 不能在这里被悄悄当成「没填」，否则用户看到的是「需要间隔或每日时间之一」。
    const everyMinutes = raw.everyMinutes as number | undefined
    // 空串按没填处理：表单清空后常见 `dailyAt: ''`，存进去只会变成脏数据
    const dailyAtText = typeof raw.dailyAt === 'string' ? raw.dailyAt.trim() : ''
    const dailyAt = dailyAtText === '' ? undefined : dailyAtText

    const profileIdText = typeof raw.profileId === 'string' ? raw.profileId.trim() : ''
    const profileId = profileIdText === '' ? undefined : profileIdText
    const error = validateSchedule({ kind, targetId, profileId, everyMinutes, dailyAt })
    if (error) throw new Error(error)

    const record: ScheduleRecord = {
      id: CollectionStore.newId('sch'),
      kind: kind as ScheduleKind,
      targetId,
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
      lastRunAt: null,
      createdAt: Date.now()
    }
    if (profileId !== undefined) record.profileId = profileId
    if (typeof everyMinutes === 'number') record.everyMinutes = everyMinutes
    if (dailyAt !== undefined) record.dailyAt = dailyAt
    return schedules.add(record)
  })

  ctx.handle(CH.schedules.update, (_event, id, patch) => {
    const key = String(id)
    const existing = schedules.get(key)
    if (!existing) throw new Error('定时任务不存在，可能已被删除')

    const raw = (patch !== null && typeof patch === 'object' ? patch : {}) as Partial<ScheduleRecord>
    // 只合并用户可改的字段：lastRunAt / lastResult / createdAt 是调度器的账本，
    // 从渲染层传进来等于让界面改写「下一次何时触发」。
    const merged: ScheduleRecord = {
      ...existing,
      kind: typeof raw.kind === 'string' ? (raw.kind as ScheduleKind) : existing.kind,
      targetId: typeof raw.targetId === 'string' ? raw.targetId.trim() : existing.targetId,
      profileId:
        typeof raw.profileId === 'string'
          ? raw.profileId.trim() || undefined
          : existing.profileId,
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : existing.enabled,
      // 用 `in` 而不是 `??`：界面从「间隔」切到「每日」时会显式传
      // `everyMinutes: undefined` 来清空另一边，`??` 会把它当成「不改」，
      // 合并后两种模式同时存在 → 校验失败 → 用户永远切不过去。
      everyMinutes:
        'everyMinutes' in raw
          ? (raw.everyMinutes as number | undefined)
          : existing.everyMinutes,
      dailyAt:
        'dailyAt' in raw
          ? typeof raw.dailyAt === 'string'
            ? raw.dailyAt.trim() || undefined
            : undefined
          : existing.dailyAt
    }

    const error = validateSchedule({
      kind: merged.kind,
      targetId: merged.targetId,
      everyMinutes: merged.everyMinutes,
      dailyAt: merged.dailyAt
    })
    if (error) throw new Error(error)

    return schedules.update(key, merged)
  })

  ctx.handle(CH.schedules.remove, (_event, id) => {
    schedules.remove(String(id))
  })

  ctx.handle(CH.schedules.runNow, async (_event, id) => {
    const rec = schedules.get(String(id))
    if (!rec) throw new Error('定时任务不存在，可能已被删除')

    const outcome = await performSchedule(ctx, rec)
    // **不写 lastRunAt**：手动触发是用户在计划之外插的一脚。如果也推进它，
    // 下一次自动触发会被整体推后一个周期；每日模式下等于直接跳过今天。
    // lastResult 仍然要回写，否则界面上「立即执行」的结果无处可见。
    try {
      schedules.update(rec.id, { lastResult: outcome.message })
    } catch {
      // 记录在动作执行期间被删：动作已发生，不把记账失败报成执行失败
    }
    auditExecution(ctx, outcome)
    return { ok: outcome.ok, message: outcome.message }
  })

  // 刻意不在这里调用 startScheduler：注册只接 IPC。什么时候开始计时
  // 由组合根决定（handlers.ts / index.ts），否则单次注册会凭空起一个
  // 永不停歇的 30 秒 interval。
}

/* ────────────────────────────── 调度循环 ────────────────────────────── */

/**
 * 启动调度循环，返回 `stop()`。
 *
 * ── 边界（不假装成系统级 cron）──
 * 这是应用进程内的 `setInterval`：应用关闭时循环随之停止，关机期间
 * 不会有任何东西替你触发。重启后第一轮扫描会按 `isDue` 把当前已到期的
 * 任务各补跑一次（间隔模式立即到期、每日模式当天已过点且没跑过也会到期），
 * 但**不会补齐中间错过的每一次**。真正的系统级定时需要注册 OS 计划任务，
 * 那超出了本模块的承诺范围。
 *
 * ── 串行 ──
 * 同一轮里逐条 `await`，并用 `running` 防止上一轮没跑完时下一轮又进来：
 * 同时启动多个环境会把窗口管理器和审计写盘一起压满，也会让「上一次结果」
 * 互相覆盖。
 */
export function startScheduler(ctx: ModuleContext): () => void {
  let stopped = false
  let running = false

  async function tick(): Promise<void> {
    if (stopped || running) return
    running = true
    try {
      const now = Date.now()
      // 同一轮里先跑最早到期的；配置非法（nextRunAt 为 null）的排最后，
      // 不过它们本来就被 isDue 过滤掉了，这里只是给排序一个稳定兜底。
      const due = ctx.stores.schedules
        .list()
        .filter((rec) => rec.enabled && isDue(rec, now))
        .sort(
          (a, b) =>
            (nextRunAt(a, now) ?? Number.MAX_SAFE_INTEGER) -
            (nextRunAt(b, now) ?? Number.MAX_SAFE_INTEGER)
        )

      for (const rec of due) {
        if (stopped) break
        // 扫描期间用户可能已经删除 / 停用这条：重新读一次，不拿旧快照执行。
        const fresh = ctx.stores.schedules.get(rec.id)
        if (!fresh || !fresh.enabled) continue
        try {
          await executeSchedule(ctx, fresh)
        } catch (err) {
          // 单条异常不该带走整轮。把失败写回记录，下一轮仍按 isDue 正常判断；
          // 这里也写 lastRunAt，避免「执行器一直抛错 + 每 30 秒重试」的刷屏。
          const message = `执行异常：${errorText(err)}`
          try {
            ctx.stores.schedules.update(fresh.id, {
              lastRunAt: Date.now(),
              lastResult: message
            })
          } catch {
            // 记录已被删除
          }
          console.error('[scheduler]', message)
        }
      }
    } catch (err) {
      // list() 读盘失败等全局问题：本轮作废，30 秒后重试。
      console.error('[scheduler] 扫描失败：', err)
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, SCAN_INTERVAL_MS)

  // 启动时先扫一次：应用刚打开时已经到点的任务不该再干等 30 秒。
  void tick()

  return () => {
    stopped = true
    clearInterval(timer)
  }
}
