/**
 * 主题：渲染层这一侧。
 *
 * 只做三件事 —— 把 `ThemeMode` 解析成 `'light' | 'dark'`、写 `<html data-theme>`、
 * 监听系统偏好变化。CSS 只认 `data-theme` 一个开关，不做 `@media (prefers-color-scheme)`：
 * 两套机制并存时，「用户手动选亮色 + 系统是深色」会同时命中两个分支，
 * 最后谁赢取决于样式表顺序，这种 bug 没法靠读代码看出来。
 *
 * 解析规则刻意不依赖 `nativeTheme.themeSource` 会改写媒体查询这一行为：
 * 显式模式（light / dark）直接返回模式本身，只有 'system' 才去读媒体查询。
 * 这样即使某个 Electron 版本没有把 themeSource 透到媒体查询，显式模式仍然正确。
 */

import type { ThemeMode } from '@shared/types'

export type ResolvedTheme = 'light' | 'dark'

const DARK_QUERY = '(prefers-color-scheme: dark)'

function darkQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(DARK_QUERY)
}

/** ThemeMode → 实际生效的亮/暗 */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'light' || mode === 'dark') return mode
  const mq = darkQuery()
  return mq !== null && mq.matches ? 'dark' : 'light'
}

/** 唯一的写入点。组件里不要自己碰 document.documentElement */
export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset['theme'] = theme
}

/**
 * 系统偏好变化时回调。返回取消函数，React 的 useEffect 可以直接 return。
 *
 * 只在模式为 'system' 时才有意义 —— 调用方负责判断，这里不判断：
 * 这个函数不知道用户选了什么模式，硬塞一个判断进去会让它变成
 * 「有时回调有时不回调」，反而更难用。
 */
export function onSystemThemeChange(cb: () => void): () => void {
  const mq = darkQuery()
  if (mq === null) return () => undefined
  const handler = (): void => cb()
  mq.addEventListener('change', handler)
  return () => mq.removeEventListener('change', handler)
}
