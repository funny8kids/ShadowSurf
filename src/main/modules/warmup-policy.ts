/**
 * Cookie 预热的**纯策略**：把渲染层发来的裸数组整理成「可以访问的 URL 清单」。
 *
 * 这个文件刻意不 import electron / store / 网络：它是整套预热里唯一能脱离
 * Electron 运行时验证的部分，`tests/warmup.test.ts` 用 node:test 直接跑。
 * 真正创建隐藏窗口、逐条 loadURL 的编排在 `./warmup.ts`。
 */

/** 单次预热最多访问多少个页面。 */
export const WARMUP_MAX_URLS = 30

export interface WarmupUrlPlan {
  /** 按输入顺序保留、已去重、最多 WARMUP_MAX_URLS 条的可访问 URL */
  urls: string[]
  /**
   * 非法项原文（已 trim）。
   *
   * 只收「非空且不是合法 http/https URL」的项：空白行是粘贴时带进来的噪声，
   * 直接忽略；重复项是合法 URL，只是不再访问，也不进这里。
   */
  rejected: string[]
  /**
   * 合法且去重后，因超过上限被截掉的条数。
   *
   * 单独给这个数是因为 `WarmupReport` 里没有「截断」字段。调用方把它变成
   * 一行失败明细（见 warmup.ts），用户才能知道「我贴了 35 条，怎么只跑了 30 条」。
   */
  truncated: number
}

/**
 * 把任意输入整理成可执行的 URL 清单。
 *
 * 规则（与 IPC 边界上的裸 JSON 对齐）：
 * 1. 非数组 → 空计划。调用方负责报「urls 必须是数组」；纯函数不抛。
 * 2. 每项先 `String()` 再 `trim()`。渲染层理论上只发字符串，但 IPC 另一端
 *    可能是任何 JSON 值，这里统一收口，避免 `url.trim is not a function`。
 * 3. 只保留 `http:` / `https:`。用 `new URL` 解析而不是 `startsWith('http')`：
 *    后者会把 `httpfoo://…`、`https ://…` 这种畸形串也放进来，错误会推迟到
 *    `loadURL` 才暴露，且报错更难解释。
 * 4. 按解析后的 `href` 去重，保留**首次出现**的原文。这样
 *    `http://a.com` 与 `http://a.com/`（浏览器视为同一个地址）只访问一次；
 *    路径 / 查询 / 片段不同的仍算不同页面。
 * 5. 空白项忽略；其余非法项原文进 `rejected`。
 * 6. 超过 WARMUP_MAX_URLS 的合法项截掉，条数记进 `truncated`。
 *
 * 为什么不在纯函数里抛错：`rejected` 本身就是给用户看的失败明细，
 * 整批输入里有一条坏的就让整个操作失败，等于把其他能跑的 URL 一起丢掉。
 */
export function normalizeWarmupUrls(input: unknown): WarmupUrlPlan {
  if (!Array.isArray(input)) return { urls: [], rejected: [], truncated: 0 }

  const urls: string[] = []
  const rejected: string[] = []
  const seen = new Set<string>()
  let accepted = 0

  for (const item of input) {
    let text: string
    try {
      text = String(item).trim()
    } catch {
      // 理论上只可能来自非 IPC 的直接调用（structured clone 过来的值都能转字符串）。
      // 不能静默吞掉：它确实是一项没被执行的输入。
      rejected.push('(无法转换为字符串的项)')
      continue
    }

    // 粘贴文本里的空行不是「错误输入」，只是分隔噪声。
    if (text === '') continue

    let parsed: URL
    try {
      parsed = new URL(text)
    } catch {
      rejected.push(text)
      continue
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      rejected.push(text)
      continue
    }

    const key = parsed.href
    if (seen.has(key)) continue
    seen.add(key)

    accepted += 1
    if (urls.length < WARMUP_MAX_URLS) urls.push(text)
  }

  return {
    urls,
    rejected,
    truncated: Math.max(0, accepted - urls.length)
  }
}
