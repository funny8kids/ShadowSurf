/**
 * Cookie 预热（cookie robot）。
 *
 * 对一个环境按用户给的 URL 列表**串行**访问并随机停留，让站点把 Cookie、
 * localStorage 与浏览历史写进该环境自己的 `persist:ss_<id>` 分区。
 *
 * ── 为什么用独立的隐藏窗口，而不是复用现有标签页 ──
 * 预热会连续导航几十次。借用用户正在看的 WebContentsView 会把它顶走、
 * 污染回退栈，还会和 Agent 的操作互相打断。隐藏窗口有自己的 WebContents，
 * 导航互不影响，但共享同一个 Session —— 这正是「Cookie 写进这个环境」的
 * 实现方式。
 *
 * ── 已知边界 ──
 * 1. 同一环境此刻若有可见窗口，两个窗口共享同一份 Cookie / Storage。预热的
 *    写入用户看不见，用户的登录 / 购物车操作也会被预热页面观察到。所以界面
 *    必须提示「预热期间不要手动操作该环境」。这里不锁死环境：锁住已启动的
 *    环境会让「先开窗看效果、再预热」这个最常见的用法直接不可用。
 * 2. 刻意不挂 CDP 指纹注入。注入要先 attach 每个 target、再跑整套回读校验，
 *    成本高；而预热页不是用户要工作的页面，不参与后续门禁判定。预热只复用
 *    partition，不主动重配 Session（UA / 代理）。如果环境已启动，那些设置
 *    由窗口应用过、这里自然继承；重新 setProxy / setUserAgent 反而会改到
 *    用户正在用的那条连接上。
 * 3. 串行执行，不并发。并发访问同一环境会同时写同一批 Cookie，哪个请求先落
 *    取决于网络时序，结果不可复现；而且「同一瞬间打开十个页面」本身就是比
 *    真人更像机器人的行为特征。
 */

import { BrowserWindow, session } from 'electron'
import { CH } from '@shared/ipc'
import type { WarmupReport, WarmupStepResult } from '@shared/types'
import { partitionFor } from '@main/core/session'
import { appendAudit } from './audit'
import type { ModuleContext } from './context'
import { WARMUP_MAX_URLS, normalizeWarmupUrls } from './warmup-policy'

/** 单页加载上限。超时记为失败并继续下一页，不让一个卡死的站点拖住整批。 */
const WARMUP_LOAD_TIMEOUT_MS = 20_000

/**
 * 每页停留 1.5–3 秒，**每次重新随机**。
 *
 * 固定值（例如统一 2000ms）本身就是一种行为特征：真实用户不会对每个页面
 * 精确停留同样长。这里的目的不是欺骗人类，而是给页面自己的脚本（埋点、
 * 懒加载、服务端下发的 Cookie）留出执行与回写的时间，同时避免整齐的节拍。
 */
const WARMUP_DWELL_MIN_MS = 1_500
const WARMUP_DWELL_MAX_MS = 3_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nextDwellMs(): number {
  // 闭区间 [1500, 3000]；Math.random() 取不到 1，所以 +1 让上限也可能被选中
  return (
    WARMUP_DWELL_MIN_MS +
    Math.floor(Math.random() * (WARMUP_DWELL_MAX_MS - WARMUP_DWELL_MIN_MS + 1))
  )
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 失败原因原文最多保留 200 字：页面/网络错误的原文可能很长，报告只留能定位的部分 */
function clip(text: string): string {
  return text.length <= 200 ? text : text.slice(0, 200)
}

/**
 * `loadURL` + 超时。
 *
 * `Promise.race` 只能让调用方先走，**不会取消**底层导航；紧接着的下一页
 * `loadURL` 会由 Chromium 中止上一次导航，最后 `win.destroy()` 兜底。
 * race 已经给原 Promise 挂了处理器，所以超时后它再 reject 也不会变成
 * unhandledRejection。
 */
function loadWithTimeout(win: BrowserWindow, url: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`加载超时（${WARMUP_LOAD_TIMEOUT_MS / 1000} 秒）`)),
      WARMUP_LOAD_TIMEOUT_MS
    )
  })

  return Promise.race([win.loadURL(url), timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer)
  })
}

export function registerWarmupModule(ctx: ModuleContext): void {
  ctx.handle(CH.warmup.run, async (_event, rawProfileId, rawUrls): Promise<WarmupReport> => {
    /* ── 1. 入参校验 ── */

    if (typeof rawProfileId !== 'string' || rawProfileId.trim() === '') {
      throw new Error('环境 id 必须是非空字符串')
    }
    const profileId = rawProfileId.trim()

    if (!Array.isArray(rawUrls)) {
      throw new Error('urls 必须是数组')
    }

    /* ── 2. 环境必须真实存在且不在回收站 ── */

    const profile = ctx.stores.profiles.get(profileId)
    if (profile === null) {
      throw new Error('环境不存在：' + profileId)
    }
    // 软删除的环境仍带着完整分区。预热它既没有产品意义（用户已经不要它了），
    // 又会在回收站里制造「刚访问过」的假痕迹，所以直接拒绝。
    if (profile.deletedAt !== null && profile.deletedAt !== undefined) {
      throw new Error('环境在回收站里，不能预热')
    }

    /* ── 3. 整理 URL 清单 ── */

    const plan = normalizeWarmupUrls(rawUrls)
    const startedAt = Date.now()
    const steps: WarmupStepResult[] = []
    let okCount = 0

    /* ── 4. 逐条访问 ── */

    if (plan.urls.length > 0) {
      // 显式取一次这个环境的 Session：BrowserWindow 下面直接传同一个对象，
      // 保证预热写入的就是 `persist:ss_<profileId>`，而不是别的分区。
      const ses = session.fromPartition(partitionFor(profileId))
      let win: BrowserWindow | null = null

      try {
        win = new BrowserWindow({
          // 必须隐藏：预热是后台行为，不能把窗口弹到用户脸上。
          show: false,
          // 给一个常见桌面尺寸：纯隐藏窗口也能布局，0×0 会让部分站点走
          // 完全不同的响应式分支，写下来的 Cookie 也就不是那个环境的常态。
          width: 1280,
          height: 800,
          webPreferences: {
            // 与标签页视图保持同一组安全选项。不传 preload —— 预热页拿不到
            // window.ss，也不需要任何应用能力。
            session: ses,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webviewTag: false,
            // 隐藏窗口默认会被 Chromium 降频，定时器可能被压到 1Hz。
            // 预热恰恰要靠页面自己的脚本写 Cookie / Storage，降频会让停留失去意义。
            backgroundThrottling: false
          }
        })

        // 预热只访问给定 URL。页面自己 window.open 出来的窗口没人负责销毁，
        // 也会绕开「最多 30 条」的约束，一律拒绝。
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        // 隐藏窗口不是「无声」的：页面里的音视频照样会从用户音箱放出来。
        // 预热是后台行为，静音避免突然出声。
        win.webContents.setAudioMuted(true)

        for (const url of plan.urls) {
          let stepOk = true
          let failReason: string | undefined

          try {
            await loadWithTimeout(win, url)
          } catch (err) {
            // 单页失败不终止整批：列表里后面的页面仍然值得访问。
            stepOk = false
            failReason = clip(errorText(err))
          }

          // 只有加载成功才停留。失败页停留没有意义，还会白占时间。
          let dwellMs = 0
          if (stepOk) {
            dwellMs = nextDwellMs()
            await sleep(dwellMs)
            okCount += 1
          }

          steps.push(
            failReason === undefined
              ? { url, ok: stepOk, dwellMs }
              : { url, ok: stepOk, error: failReason, dwellMs }
          )
        }
      } finally {
        // destroy 而不是 close：close 会跑页面的 beforeunload，可能被一个
        // 恶意/卡死的页面无限拖延；destroy 立即拆掉渲染进程和隐藏窗口。
        if (win !== null && !win.isDestroyed()) win.destroy()
      }
    }

    /* ── 5. 未执行的项也要出现在结果里，不能静默丢掉 ── */

    /*
     * 只接受 http/https。file: / data: / javascript: 等协议是本地内容或脚本
     * 伪协议：它们不会向任何站点写 Cookie，预热没有产品意义；而把它们交给
     * `loadURL` 还会扩大攻击面（本地文件读取、在特权上下文里执行脚本）。
     * 所以直接跳过，并把原文记进失败明细，让用户知道为什么这些行没跑。
     */
    for (const raw of plan.rejected) {
      steps.push({ url: raw, ok: false, error: '不是 http/https URL，已跳过', dwellMs: 0 })
    }

    if (plan.truncated > 0) {
      steps.push({
        url: `（另有 ${plan.truncated} 条 URL 未访问）`,
        ok: false,
        error: `单次最多预热 ${WARMUP_MAX_URLS} 条，超出部分已截断`,
        dwellMs: 0
      })
    }

    // 空数组 / 全是空白行：没有任何页面可访问，也拿不到失败明细，直接报错。
    if (steps.length === 0) throw new Error('没有可预热的 URL')

    /* ── 6. 审计与返回 ── */

    appendAudit(
      ctx.stores,
      '环境·Cookie 预热',
      profile.name,
      `访问 ${plan.urls.length} 个页面，成功 ${okCount}`
    )

    return {
      profileId,
      startedAt,
      finishedAt: Date.now(),
      steps,
      okCount,
      // total 是「结果行数」而不是「成功访问的页数」：非法协议与截断也算一行，
      // 界面上的 `ok / total` 才不会把没执行的项藏在总数之外。
      total: steps.length
    }
  })
}
