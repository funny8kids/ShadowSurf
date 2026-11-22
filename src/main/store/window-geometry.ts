/**
 * 控制台窗口的几何状态（位置 / 尺寸 / 最大化）。
 *
 * ── 为什么单独一个文件，不塞进 Settings ──
 * Settings 是"应用配置"，有严格字段白名单、schema、审计与密封；
 * 窗口几何只是纯展示偏好，用户拖一下窗口就写一次 ——
 * 把它塞进 Settings 会让每次窗口移动都触发一次完整配置落盘（含 apiKey 密封往返），
 * 而且一个损坏的 geometry 值会把整个 Settings 判成损坏，代价完全不对等。
 *
 * 所以独立成 `window-state.json`：**读不到 / 写不进去就忽略**，
 * 用户最多回到默认尺寸，不会丢任何真正的配置。
 *
 * ── 写盘节流 ──
 * 拖动窗口时 resize 事件一秒能来几十次，每次都写盘没必要。
 * 由调用方在 close 时写一次即可（见 index.ts），不做实时持久化。
 *
 * 归属：windows-agent
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

export interface WindowGeometry {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

const FILE = 'window-state.json'

/** 合理范围：小于 400×300 或坐标离谱的，当作没写过（多显示器拔掉后的残留） */
function plausible(g: WindowGeometry): boolean {
  return (
    Number.isFinite(g.x) &&
    Number.isFinite(g.y) &&
    Number.isFinite(g.width) &&
    Number.isFinite(g.height) &&
    g.width >= 400 &&
    g.height >= 300 &&
    g.width <= 10000 &&
    g.height <= 10000 &&
    Math.abs(g.x) <= 20000 &&
    Math.abs(g.y) <= 20000
  )
}

/** 读取：任何异常都当作"没写过"，绝不因一个展示偏好把启动搞挂 */
export function readWindowGeometry(dataDir: string): WindowGeometry | null {
  try {
    const p = join(dirname(dataDir), FILE)
    if (!existsSync(p)) return null
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<WindowGeometry>
    const g: WindowGeometry = {
      x: Number(raw.x),
      y: Number(raw.y),
      width: Number(raw.width),
      height: Number(raw.height),
      maximized: raw.maximized === true
    }
    return plausible(g) ? g : null
  } catch {
    return null
  }
}

/** 写入：失败不抛（盘满 / 只读），用户只是下次回到默认尺寸 */
export function writeWindowGeometry(dataDir: string, g: WindowGeometry): void {
  if (!plausible(g)) return
  try {
    const p = join(dirname(dataDir), FILE)
    writeFileSync(p, JSON.stringify(g), 'utf8')
  } catch (err) {
    console.warn(
      '[window] 窗口几何保存失败（下次用默认尺寸）：' +
        (err instanceof Error ? err.message : String(err))
    )
  }
}
