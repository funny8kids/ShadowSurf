/**
 * 当前语言的模块级快照。
 *
 * 为什么需要它：`lib/format.ts` 里的 `formatRelative` / `countryLabel` /
 * `stepResultText` 有 20+ 个调用点，而且多数在纯函数或常量表里，拿不到 React
 * context。让每个调用点都多传一个 lang 参数，改动面大且容易漏。
 *
 * 由 `I18nProvider` 在语言变化时写入；`format.ts` 读取它作为默认语言。
 * 只在渲染层使用 —— 主进程有自己的一份（不 import 本文件），
 * 所以审计记录等主进程产物的措辞不受界面语言影响。
 */

import type { Lang } from './index'

let current: Lang = 'zh'

export function setCurrentLang(next: Lang): void {
  current = next
}

export function currentLang(): Lang {
  return current
}
