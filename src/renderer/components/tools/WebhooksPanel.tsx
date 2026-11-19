/**
 * Webhook 面板：任务 / 定时结果回调管理。
 *
 * 安全边界（见 modules/webhooks.ts）：只从本机发到用户填的地址，无中转；
 * 不重试；失败只写审计。这里只做 CRUD 与「测试」按钮，投递语义全在主进程。
 */

import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { WebhookEvent, WebhookRecord } from '@shared/types'
import { Button, Icon, Modal, cx, useToast } from '@renderer/components/ui'
import { bridge, errorMessage } from '@renderer/lib/api'
import { useI18n } from '@renderer/lib/i18n'
import './webhooks.css'

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; hooks: WebhookRecord[] }

const EVENTS: WebhookEvent[] = ['task.done', 'task.failed', 'schedule.done']

/** 事件值（带点）→ 文案键（camelCase） */
const EVENT_LABEL: Record<WebhookEvent, string> = {
  'task.done': 'wh.event.taskDone',
  'task.failed': 'wh.event.taskFailed',
  'schedule.done': 'wh.event.scheduleDone'
}

export function WebhooksPanel() {
  const { t } = useI18n()
  const toast = useToast()
  const [state, setState] = useState<ListState>({ kind: 'loading' })
  const [formOpen, setFormOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<WebhookEvent[]>([])
  const [enabled, setEnabled] = useState(true)
  const [editing, setEditing] = useState<WebhookRecord | null>(null)
  const [pendingDelete, setPendingDelete] = useState<WebhookRecord | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      setState({ kind: 'ready', hooks: await bridge().webhooks.list() })
    } catch (err) {
      setState({ kind: 'error', message: errorMessage(err) })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openForm = (hook: WebhookRecord | null): void => {
    setEditing(hook)
    setUrl(hook?.url ?? '')
    setEvents(hook?.events ?? [])
    setEnabled(hook?.enabled ?? true)
    setFormOpen(true)
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    try {
      if (editing) {
        await bridge().webhooks.update(editing.id, { url, events, enabled })
      } else {
        await bridge().webhooks.create({ url, events, enabled })
        toast.push(t('wh.created'), 'ok')
      }
      setFormOpen(false)
      await load()
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setBusy(false)
    }
  }

  const test = async (hook: WebhookRecord): Promise<void> => {
    setBusy(true)
    try {
      const res = await bridge().webhooks.test(hook.id)
      toast.push(
        res.ok
          ? t('wh.testOk', { status: res.status })
          : t('wh.testFailed', { error: res.error ?? `HTTP ${res.status}` }),
        res.ok ? 'ok' : 'err'
      )
    } catch (err) {
      toast.push(t('wh.testFailed', { error: errorMessage(err) }), 'err')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!pendingDelete) return
    setBusy(true)
    try {
      await bridge().webhooks.remove(pendingDelete.id)
      toast.push(t('wh.removed'), 'ok')
      setPendingDelete(null)
      await load()
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setBusy(false)
    }
  }

  const toggleEvent = (event: WebhookEvent): void => {
    setEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]
    )
  }

  return (
    <div className="tool-panel wh-panel">
      <header className="tool-head">
        <div>
          <h2>{t('wh.title')}</h2>
          <p>{t('wh.subtitle')}</p>
        </div>
        <Button variant="primary" icon="plus" onClick={() => openForm(null)}>
          {t('wh.add')}
        </Button>
      </header>

      <div className="tool-body">
        {state.kind === 'loading' ? (
          <div className="wh-empty">{t('common.loading')}</div>
        ) : state.kind === 'error' ? (
          <div className="wh-error">
            <Icon name="alert" size={20} />
            <p>{state.message}</p>
            <Button variant="ghost" icon="reload" onClick={() => void load()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : state.hooks.length === 0 ? (
          <div className="wh-empty">
            <div className="mark">
              <Icon name="send" size={22} />
            </div>
            <h3>{t('wh.empty')}</h3>
            <p>{t('wh.emptyHint')}</p>
          </div>
        ) : (
          <div className="wh-list">
            {state.hooks.map((hook) => (
              <div className="wh-card" key={hook.id}>
                <div className="wh-card-main">
                  <span className={cx('wh-status', hook.enabled ? 'on' : '')} />
                  <div>
                    <div className="wh-url">{hook.url}</div>
                    <div className="wh-events">
                      {hook.events.length === 0
                        ? t('wh.eventsHint')
                        : hook.events.map((e) => (
                            <span className="wh-tag" key={e}>
                              {t(EVENT_LABEL[e])}
                            </span>
                          ))}
                    </div>
                  </div>
                </div>
                <div className="wh-card-ops">
                  <Button size="sm" variant="ghost" onClick={() => openForm(hook)}>
                    {t('common.edit')}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void test(hook)}>
                    {t('wh.test')}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setPendingDelete(hook)}>
                    {t('wh.remove')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal
        open={formOpen}
        title={editing ? t('common.edit') : t('wh.add')}
        icon="send"
        tone="accent"
        maxWidth={460}
        onClose={() => setFormOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setFormOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void submit(new Event('submit') as unknown as FormEvent)}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <form className="wh-form" onSubmit={(e) => void submit(e)}>
          <label className="wh-field">
            <span>{t('wh.url')}</span>
            <input
              value={url}
              placeholder={t('wh.urlPlaceholder')}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <div className="wh-field">
            <span>{t('wh.events')}</span>
            <small>{t('wh.eventsHint')}</small>
            <div className="wh-event-grid">
              {EVENTS.map((event) => (
                <label key={event} className={cx('wh-event', events.includes(event) && 'on')}>
                  <input
                    type="checkbox"
                    checked={events.includes(event)}
                    onChange={() => toggleEvent(event)}
                  />
                  {t(EVENT_LABEL[event])}
                </label>
              ))}
            </div>
          </div>
        </form>
      </Modal>

      <Modal
        open={pendingDelete !== null}
        title={t('wh.remove')}
        icon="alert"
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {pendingDelete?.url ?? ''}
      </Modal>
    </div>
  )
}
