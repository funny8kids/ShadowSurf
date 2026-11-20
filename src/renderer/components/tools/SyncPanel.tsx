/**
 * 动作同步器：把一条脚本在多个环境里依次回放。
 *
 * 与脚本面板的「单环境回放」分开：这里的产物不是「一个环境跑完没有」，
 * 而是「这批环境里哪几个没跟上」。所以结果区按环境逐条列出，不埋一个总数了事。
 *
 * 含 L2 的步骤仍由主进程逐环境弹系统确认窗 —— 一次确认只放行一个环境。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AutomationScript, Profile, ScriptBatchResult } from '@shared/types'
import { Button, Icon, cx, useToast } from '@renderer/components/ui'
import { bridge, errorMessage } from '@renderer/lib/api'
import { useI18n } from '@renderer/lib/i18n'
import './sync.css'

interface Props {
  profiles: Profile[]
}

export function SyncPanel({ profiles }: Props) {
  const { t } = useI18n()
  const toast = useToast()
  /**
   * 脚本列表的读取状态：三态必须可分。
   *
   * 原先这里把读取失败吞成空数组，于是「读不到」与「真的没有脚本」
   * 在界面上完全同脸（都是下拉框里一个「—」）。磁盘被占用、权限被改、
   * 主进程还没起来 —— 用户看到的是「我没有脚本」，于是去重建数据，
   * 而真实情况是旧数据还在但读不出来。DESIGN.md 早就把这条列为必须分开的
   * 三态，这里是新面板把它重新引了回来。
   */
  const [scripts, setScripts] = useState<AutomationScript[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scriptId, setScriptId] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<ScriptBatchResult | null>(null)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    void reloadScripts()
  }, [])

  /** 读取脚本列表；失败时把错误原文带出来，不吞成空列表 */
  const reloadScripts = useCallback(async (): Promise<void> => {
    try {
      const list = await bridge().scripts.list()
      setScripts(list)
      setLoadError(null)
      setScriptId((prev) => prev || list[0]?.id || '')
    } catch (err) {
      setScripts(null)
      setLoadError(errorMessage(err))
    }
  }, [])

  const activeScript = useMemo(
    () => (scripts ?? []).find((s) => s.id === scriptId) ?? null,
    [scripts, scriptId]
  )

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const run = async (): Promise<void> => {
    if (!scriptId) {
      toast.push(t('sync.noSelection'), 'err')
      return
    }
    if (selected.size === 0) {
      toast.push(t('sync.noSelection'), 'err')
      return
    }
    setRunning(true)
    setResult(null)
    try {
      const res = await bridge().scripts.runBatch(scriptId, [...selected])
      setResult(res)
      if (res.confirmCount > 0) {
        toast.push(t('sync.partial', {
          ok: res.okCount,
          failed: res.failedCount,
          confirm: res.confirmCount
        }), 'info')
      } else if (res.failedCount > 0) {
        toast.push(t('sync.partial', {
          ok: res.okCount,
          failed: res.failedCount,
          confirm: 0
        }), 'err')
      } else {
        toast.push(t('sync.ok', { n: res.okCount }), 'ok')
      }
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="tool-panel sync-panel">
      <header className="tool-head">
        <div>
          <h2>{t('sync.title')}</h2>
          <p>{t('sync.hint')}</p>
        </div>
        <Button
          variant="primary"
          icon="play"
          disabled={running || !scriptId || selected.size === 0}
          onClick={() => void run()}
        >
          {running ? t('sync.running') : t('sync.run')}
        </Button>
      </header>

      <div className="tool-body sync-body">
        <section className="sync-section">
          <h3>{t('sync.title')} · 1</h3>
          <div className="sync-field">
            <label>{t('script.library')}</label>
            {loadError !== null ? (
              /* 读失败：琥珀块 + 原文 + 重试。与「还没有脚本」的空态一眼可分。 */
              <div className="load-error">
                <div className="le-mark">
                  <Icon name="alert" size={20} strokeWidth={2.2} />
                </div>
                <h3>{t('common.readFailed')}</h3>
                <p className="le-reason">{loadError}</p>
                <p className="le-hint">{t('common.readFailedHint')}</p>
                <Button variant="ghost" icon="reload" onClick={() => void reloadScripts()}>
                  {t('common.retryRead')}
                </Button>
              </div>
            ) : scripts === null ? (
              <span className="sync-dim">{t('common.loading')}</span>
            ) : (
              <select value={scriptId} onChange={(e) => setScriptId(e.target.value)}>
                {scripts.length === 0 ? <option value="">—</option> : null}
                {scripts.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.name}（{s.steps.length} 步）
                  </option>
                ))}
              </select>
            )}
          </div>
          {activeScript ? (
            <p className="sync-hint">{activeScript.description || activeScript.name}</p>
          ) : null}
        </section>

        <section className="sync-section">
          <h3>{t('sync.pick')} · 2</h3>
          <p className="sync-hint">{t('sync.pickHint')}</p>
          <div className="sync-grid">
            {profiles.length === 0 ? (
              <span className="sync-dim">—</span>
            ) : (
              profiles.map((p) => (
                <label
                  key={p.id}
                  className={cx('sync-item', selected.has(p.id) && 'on')}
                  title={p.name}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(p.id)}
                    onChange={() => toggle(p.id)}
                  />
                  <span className="sync-dot" style={{ background: p.color }} />
                  <span className="sync-name">{p.name}</span>
                </label>
              ))
            )}
          </div>
        </section>

        {result ? (
          <section className="sync-section">
            <h3>{t('sync.result')}</h3>
            <div className="sync-results">
              {result.items.map((item) => (
                <div className="sync-result" key={item.profileId}>
                  <span
                    className={cx(
                      'sync-badge',
                      item.ok ? 'ok' : item.needsConfirm ? 'warn' : 'bad'
                    )}
                  >
                    {item.ok
                      ? t('sync.done')
                      : item.needsConfirm
                        ? t('sync.needsConfirm')
                        : t('sync.failed')}
                  </span>
                  <span className="sync-result-name">{item.profileName}</span>
                  <span className="sync-steps">
                    {item.executed}/{item.total}
                  </span>
                  {item.error ? (
                    <span className="sync-error" title={item.error}>
                      {item.error}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}
