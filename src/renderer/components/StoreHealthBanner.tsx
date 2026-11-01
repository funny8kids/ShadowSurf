/**
 * 数据健康横幅。
 *
 * 存在的理由：`json-file.ts` 在文件损坏时会把原文件复制成 `.corrupt-<ts>`，
 * 迁移前会留 `.preupgrade<N>-<ts>`，但在此之前**全仓没有任何地方读它们**。
 * 于是用户看到的是「环境列表空了」，而盘上躺着一堆没人会打开的文件，
 * 唯一能说明原因的日志在控制台里。这个组件就是那些文件的消费方。
 *
 * 三条刻意的设计：
 *
 * 1. **只在有问题时出现。** 正常状态下不占一行像素 —— 一个永远在的「一切正常」
 *    横幅会训练用户忽略它，等到真出问题时就没人看了。
 * 2. **不提供「修复」按钮。** 损坏文件是证据，含明文 seed 的备份可能是唯一的
 *    已知良好快照。一键「清理」等于一键销毁证据。所以只显示路径，让人自己去处理。
 * 3. **区分「坏了」和「读不到」。** 前者要恢复，后者关掉占用文件的程序就好；
 *    说混了会把人引去做无效操作。文案由主进程的 `health.ts` 按 kind 生成，
 *    这里只负责展示，不自己拼 —— 否则同一件事会有两套说法。
 */

import { useCallback, useEffect, useState } from 'react'
import type { StoreHealth } from '@shared/types'
import { bridge, errorMessage, hasBridge } from '@renderer/lib/api'
import './store-health.css'

const ORIGIN_LABEL: Record<string, string> = {
  corrupt: '损坏副本',
  preupgrade: '迁移前快照',
  schema: '旧命名迁移快照'
}

function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 验形。
 *
 * 这不是「防御性编程」的泛泛之谈，是针对一类具体故障：`StoreHealth` 要穿过
 * preload 的 `Result<T>` 拆包（`preload/index.ts` 用「返回体里有没有 `ok`」判断
 * 该不该拆）。任何一环少包 / 多包一层，渲染层拿到的就是一个形状不对的对象 ——
 * 而 `notes.map(...)` 一抛，React 卸载整棵树，**整个应用白屏**，
 * 用户连「健康检查失败了」都看不到。
 *
 * 判据覆盖**这一层真正会读的每一个字段**，不是只查一个用来判别类型的字段。
 * 只查「`notes` 是数组」而放过 `bytes`，表格里就会印出「NaN KB」——
 * 崩溃至少是响的，协议噪音是安静的，用户会以为数据就长这样。
 *
 * 形状不对 → 当作「**没拿到结论**」，把原因显示出来；绝不当作「一切正常」。
 * 后者更坏：它会让人以为检查过了。
 */
function sanitize(raw: unknown): StoreHealth | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  if (typeof r['dataDir'] !== 'string') return null
  if (typeof r['degraded'] !== 'boolean') return null
  // headline 合法取值只有「字符串」和「null」两种，undefined 不合法 ——
  // 那说明字段根本没过来，而 `undefined ?? null` 会被误当成「一切正常」。
  const headline = r['headline']
  if (headline !== null && typeof headline !== 'string') return null

  const notes = r['notes']
  if (!Array.isArray(notes) || notes.some((n) => typeof n !== 'string')) return null
  if (!Array.isArray(r['stores'])) return null

  const backups = r['backups']
  if (!Array.isArray(backups)) return null
  for (const item of backups) {
    if (item === null || typeof item !== 'object') return null
    const b = item as Record<string, unknown>
    // 这四个是表格里真正会被读的字段。少一个就会印出空白单元格或 NaN，
    // 而空白单元格看起来像「这个备份没问题」。
    if (typeof b['path'] !== 'string' || typeof b['name'] !== 'string') return null
    if (typeof b['origin'] !== 'string') return null
    if (typeof b['bytes'] !== 'number' || !Number.isFinite(b['bytes'])) return null
    if (typeof b['plaintextSeeds'] !== 'number') return null
  }

  return raw as StoreHealth
}

export function StoreHealthBanner(): React.JSX.Element | null {
  const [health, setHealth] = useState<StoreHealth | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  /** 用户手动关掉之后，同一次会话里不要再弹回来烦他 */
  const [dismissed, setDismissed] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (!hasBridge()) return
    try {
      const clean = sanitize(await bridge().system.storeHealth())
      if (clean === null) {
        // 形状不对 ≠ 一切正常。见 sanitize() 的注释：把它当成正常，
        // 就等于替一次没做成的检查背书。
        setHealth(null)
        setError('数据健康检查返回了无法识别的结果（这不等于「一切正常」，请重试或查看日志）')
        return
      }
      setHealth(clean)
      setError(null)
    } catch (err) {
      // 连健康检查本身都失败了：这本身就是该报的信息，不能静默吞掉
      setError(`无法读取数据健康状态：${errorMessage(err)}`)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const headline = error ?? health?.headline ?? null
  // 正常状态下不占一行像素
  if (headline === null) return null
  if (dismissed) return null

  const degraded = error !== null || health?.degraded === true
  const notes = health?.notes ?? []
  const backups = health?.backups ?? []

  return (
    <div className={degraded ? 'sh-banner sh-bad' : 'sh-banner sh-warn'} role="status">
      <div className="sh-row">
        <span className="sh-dot" aria-hidden="true" />
        <span className="sh-headline">{headline}</span>
        {notes.length > 0 ? (
          <button type="button" className="sh-link" onClick={() => setOpen((v) => !v)}>
            {open ? '收起' : `详情（${String(notes.length)}）`}
          </button>
        ) : null}
        <button
          type="button"
          className="sh-close"
          onClick={() => setDismissed(true)}
          title="本次会话不再提示（问题本身没有被修复）"
        >
          ×
        </button>
      </div>

      {open ? (
        <div className="sh-detail">
          {notes.map((note, i) => (
            <p key={`note-${String(i)}`} className="sh-note">
              {note}
            </p>
          ))}

          {backups.length > 0 ? (
            <table className="sh-table">
              <thead>
                <tr>
                  <th>备份文件</th>
                  <th>来源</th>
                  <th>大小</th>
                  <th>明文 seed</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <tr key={b.path} className={b.plaintextSeeds > 0 ? 'sh-leak' : undefined}>
                    <td className="sh-mono" title={b.path}>
                      {b.name}
                    </td>
                    <td>{ORIGIN_LABEL[b.origin] ?? b.origin}</td>
                    <td>{formatBytes(b.bytes)}</td>
                    <td>{b.plaintextSeeds > 0 ? `${String(b.plaintextSeeds)} 条（明文）` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          <p className="sh-foot">
            这些文件不会被自动清理：损坏文件是排查依据，含明文 seed 的备份可能仍是唯一的已知良好快照。
            数据目录：<span className="sh-mono">{health?.dataDir ?? '未知'}</span>
          </p>
          <button type="button" className="sh-link" onClick={() => void load()}>
            重新检查
          </button>
        </div>
      ) : null}
    </div>
  )
}
