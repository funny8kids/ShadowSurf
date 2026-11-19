/**
 * 代理组面板：把多条代理编成一个出口池，按轮询 / 随机 / 粘性策略轮换。
 *
 * 与代理池面板分开：代理池管「单条出口」，这里管「一组出口怎么被环境使用」。
 * 分开的第二个理由是故障转移语义 —— 组全挂时环境起不来，绝不退回直连，
 * 这条规则值得一个独立的、能完整说清楚的空间。
 *
 * 三态读取沿用 DESIGN.md：loading / error / ready 必须可分，读失败不能画成空。
 */

import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { ProxyGroup, ProxyGroupStrategy, ProxyRecord } from '@shared/types'
import { Button, Icon, Modal, Toggle, cx, useToast } from '@renderer/components/ui'
import { bridge, errorMessage } from '@renderer/lib/api'
import { useI18n } from '@renderer/lib/i18n'
import './proxy-groups.css'

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; groups: ProxyGroup[]; proxies: ProxyRecord[] }

const STRATEGIES: ProxyGroupStrategy[] = ['round-robin', 'random', 'sticky']

/** 存储值（kebab-case）→ 文案键（camelCase） */
const STRATEGY_LABEL: Record<ProxyGroupStrategy, string> = {
  'round-robin': 'pg.strategy.roundRobin',
  random: 'pg.strategy.random',
  sticky: 'pg.strategy.sticky'
}

export function ProxyGroupsPanel() {
  const { t } = useI18n()
  const toast = useToast()
  const [state, setState] = useState<ListState>({ kind: 'loading' })
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ProxyGroup | null>(null)
  const [name, setName] = useState('')
  const [strategy, setStrategy] = useState<ProxyGroupStrategy>('round-robin')
  const [failover, setFailover] = useState(true)
  const [selected, setSelected] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<ProxyGroup | null>(null)

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const [groups, proxies] = await Promise.all([
        bridge().proxyGroups.list(),
        bridge().proxies.list()
      ])
      setState({ kind: 'ready', groups, proxies })
    } catch (err) {
      setState({ kind: 'error', message: errorMessage(err) })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openForm = (group: ProxyGroup | null): void => {
    setEditing(group)
    setName(group?.name ?? '')
    setStrategy(group?.strategy ?? 'round-robin')
    setFailover(group?.failover ?? true)
    setSelected(group?.proxyIds ?? [])
    setFormOpen(true)
  }

  const toggleMember = (id: string): void => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    try {
      if (editing) {
        await bridge().proxyGroups.update(editing.id, {
          name,
          strategy,
          failover,
          proxyIds: selected
        })
      } else {
        const created = await bridge().proxyGroups.create({
          name,
          strategy,
          failover,
          proxyIds: selected
        })
        toast.push(t('pg.created', { name: created.name }), 'ok')
      }
      setFormOpen(false)
      await load()
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!pendingDelete) return
    setSaving(true)
    try {
      await bridge().proxyGroups.remove(pendingDelete.id)
      toast.push(t('pg.removed', { name: pendingDelete.name }), 'ok')
      setPendingDelete(null)
      await load()
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setSaving(false)
    }
  }

  const proxies = state.kind === 'ready' ? state.proxies : []
  const nameOf = (id: string): string => proxies.find((p) => p.id === id)?.name ?? id

  return (
    <div className="tool-panel pg-panel">
      <header className="tool-head">
        <div>
          <h2>{t('pg.title')}</h2>
          <p>{t('pg.subtitle')}</p>
        </div>
        <Button variant="primary" icon="plus" onClick={() => openForm(null)}>
          {t('pg.create')}
        </Button>
      </header>

      <div className="tool-body">
        {state.kind === 'loading' ? (
          <div className="pg-empty">{t('common.loading')}</div>
        ) : state.kind === 'error' ? (
          <div className="pg-error">
            <Icon name="alert" size={20} />
            <p>{state.message}</p>
            <Button variant="ghost" icon="reload" onClick={() => void load()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : state.groups.length === 0 ? (
          <div className="pg-empty">
            <div className="mark">
              <Icon name="globe" size={22} />
            </div>
            <h3>{t('pg.empty')}</h3>
            <p>{t('pg.emptyHint')}</p>
          </div>
        ) : (
          <div className="pg-list">
            {state.groups.map((g) => (
              <div className="pg-card" key={g.id}>
                <div className="pg-card-head">
                  <div>
                    <h3>{g.name}</h3>
                    <span className="pg-count">{t('pg.count', { n: g.proxyIds.length })}</span>
                  </div>
                  <div className="pg-card-ops">
                    <Button size="sm" variant="ghost" onClick={() => openForm(g)}>
                      {t('profiles.configure')}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setPendingDelete(g)}>
                      {t('pg.remove')}
                    </Button>
                  </div>
                </div>
                <div className="pg-card-meta">
                  <span className="pg-tag">
                    {t('pg.strategy')}: {t(STRATEGY_LABEL[g.strategy])}
                  </span>
                  <span className={cx('pg-tag', g.failover ? 'on' : '')}>
                    {t('pg.failover')}: {g.failover ? t('common.yes') : t('common.no')}
                  </span>
                </div>
                <div className="pg-members">
                  {g.proxyIds.length === 0 ? (
                    <span className="pg-dim">—</span>
                  ) : (
                    g.proxyIds.map((id) => (
                      <span className="pg-member" key={id} title={id}>
                        {nameOf(id)}
                      </span>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal
        open={formOpen}
        title={editing ? t('profiles.configure') : t('pg.create')}
        icon="sliders"
        tone="accent"
        maxWidth={480}
        onClose={() => setFormOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setFormOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={saving || selected.length === 0}
              onClick={() => void submit(new Event('submit') as unknown as FormEvent)}
            >
              {saving ? t('proxy.form.saving') : t('common.save')}
            </Button>
          </>
        }
      >
        <form className="pg-form" onSubmit={(e) => void submit(e)}>
          <label className="pg-field">
            <span>{t('pg.name')}</span>
            <input
              value={name}
              placeholder={t('pg.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="pg-field">
            <span>{t('pg.strategy')}</span>
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as ProxyGroupStrategy)}
            >
              {STRATEGIES.map((s) => (
                <option value={s} key={s}>
                  {t(STRATEGY_LABEL[s])}
                </option>
              ))}
            </select>
          </label>
          <div className="pg-failover">
            <Toggle
              checked={failover}
              onChange={setFailover}
              label={t('pg.failover')}
            />
            <p>{t('pg.failoverHint')}</p>
          </div>
          <div className="pg-member-pick">
            <div className="pg-member-title">
              <span>{t('pg.members')}</span>
              <small>{t('pg.membersHint')}</small>
            </div>
            {proxies.length === 0 ? (
              <p className="pg-dim">{t('pg.membersEmpty')}</p>
            ) : (
              <div className="pg-member-grid">
                {proxies.map((p) => (
                  <label
                    key={p.id}
                    className={cx('pg-member-item', selected.includes(p.id) && 'on')}
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(p.id)}
                      onChange={() => toggleMember(p.id)}
                    />
                    <span>{p.name}</span>
                    <small>{p.host}:{p.port}</small>
                  </label>
                ))}
              </div>
            )}
          </div>
        </form>
      </Modal>

      <Modal
        open={pendingDelete !== null}
        title={t('pg.remove')}
        icon="alert"
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" disabled={saving} onClick={() => void remove()}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {t('pg.removeConfirm', { name: pendingDelete?.name ?? '' })}
      </Modal>
    </div>
  )
}
