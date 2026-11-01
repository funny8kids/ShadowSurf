/**
 * 主题的唯一解析点。
 *
 * 为什么要单独一个模块：`nativeTheme.themeSource` 必须**只有一处**被写。
 * 之前 `main/index.ts` 里硬写着 `themeSource = 'light'`，而窗口的
 * `backgroundColor` 又各自硬写着亮色 —— 两处都"看起来对"，但谁也管不到谁。
 * 一旦有人只改了其中一处，症状是「界面变暗了，但拖动窗口时边缘还在闪白」，
 * 而且很难联想到是两处不一致造成的。
 *
 * 分工：
 *   - 主进程：把 `ThemeMode` 交给 `nativeTheme`，并把解析结果推给渲染层
 *   - 渲染层：只消费 `'light' | 'dark'`，自己不再判一次
 */

import { BrowserWindow, nativeTheme } from 'electron'
import { CH } from '@shared/ipc'
import type { ThemeMode } from '@shared/types'

export type ResolvedTheme = 'light' | 'dark'

/**
 * 窗口底色。必须与渲染层的 `--bg` 逐字一致
 * （tokens.css: `--bg: #f6f5f2` / `[data-theme='dark'] --bg: #0a0c0f`）。
 *
 * 不一致的后果不是"颜色略差"：窗口拉伸 / 首帧渲染时露出的就是这块底色，
 * 差一档就变成一条可见的亮边。
 */
export const WINDOW_BG: Record<ResolvedTheme, string> = {
  light: '#f6f5f2',
  dark: '#0a0c0f'
}

/** 当前实际生效的亮/暗 */
export function resolvedTheme(): ResolvedTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/**
 * 把当前主题铺到所有窗口：底色 + 推送。
 *
 * 底色和推送一起做，是因为它们解决的是同一件事的两个面：
 * `setBackgroundColor` 管窗口还没画出来的那部分（拉伸、首帧），
 * `CH.push.theme` 管已经画出来的那部分（渲染层换令牌）。
 */
export function applyThemeToWindows(): void {
  const theme = resolvedTheme()
  const bg = WINDOW_BG[theme]
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.setBackgroundColor(bg)
    win.webContents.send(CH.push.theme, theme)
  }
}

/**
 * 应用主题模式。`ThemeMode` 的三个取值与 `nativeTheme.themeSource` 的定义域完全一致，
 * 所以这里是直接赋值而不是映射 —— 多一层映射只会多一处可能写错的地方。
 *
 * 设完立刻铺一遍，不等 `updated` 事件：那个事件只在 `shouldUseDarkColors`
 * **真的变了**才发，而「从 light 改成 dark 再改回 light」中间的推送如果靠事件，
 * 顺序没有保证。显式铺一次是幂等的。
 */
export function applyThemeMode(mode: ThemeMode): ResolvedTheme {
  nativeTheme.themeSource = mode
  applyThemeToWindows()
  return resolvedTheme()
}

/** 新建窗口时用的底色 */
export function windowBackground(): string {
  return WINDOW_BG[resolvedTheme()]
}
