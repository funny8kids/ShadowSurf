/**
 * 扩展管理面板。
 *
 * 只做「登记 / 开关 / 删除登记」三件事：路径由用户手填，不做文件选择器
 * （Electron 的 dialog 需要主进程新开一条通道，不在本模块范围内）。
 * 真正把扩展装进环境的是主进程的环境启动流程，界面不碰 Session。
 *
 * 列表读取按 DESIGN.md 的「不可判读状态」拆成三态：loading / error / ready。
 * 读失败不能被画成「还没有登记任何扩展」—— 那会让用户以为登记丢了，
 * 然后重复添加同一个目录。
 *
 * 归属：extensions-agent
 * 样式写在同目录 extensions.css，类名统一 ext- 前缀。
 */

import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { ExtensionRecord } from '@shared/types'
import {
  Badge,
  Button,
  Field,
  Icon,
  EmptyState,
  Modal,
  Toggle,
  cx,
  useToast
} from '@renderer/components/ui'
import { bridge, errorMessage } from '@renderer/lib/api'
import { useI18n } from '@renderer/lib/i18n'
import './extensions.css'

/**
 * 列表读取的三态。
 *
 * 用联合类型而不是 `{ loading, error, records }` 三个并列状态：后者允许
 * 「加载中 + 有错误 + 有数据」这种合法组合，每个渲染点都得自己决定信谁。
 */
type ExtensionListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; records: ExtensionRecord[] }

/**
 * 剥掉 Electron 套在 IPC 失败外的通道名。
 * 原始消息形如 `Error invoking remote method 'ss:extensions:list': Error: ENOENT ...`，
 * 前半截会把真正的原因挤出屏幕。
 */
function cleanIpcMessage(raw: string): string {
  const m = /Error invoking remote method '[^']*':\s*(?:Error:\s*)?([\s\S]*)$/.exec(raw)
  return (m?.[1] ?? raw).trim()
}

/** 最新登记的在前；主进程已排过，这里对本地回填也保持同一顺序 */
function sortExtensions(records: ExtensionRecord[]): ExtensionRecord[] {
  return [...records].sort((a, b) => b.createdAt - a.createdAt)
}

/** 主进程的「没有 manifest.json」错误是固定文案，英文界面下换成对应译文 */
function isManifestError(message: string): boolean {
  return /manifest\.json/i.test(message)
}

export function ExtensionsPanel() {
  const toast = useToast()
  const { t } = useI18n()

  const [list, setList] = useState<ExtensionListState>({ kind: 'loading' })
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [adding, setAdding] = useState(false)
  /** 正在切换开关的记录 id；只锁那一行，不锁整张表 */
  const [busyId, setBusyId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ExtensionRecord | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setList({ kind: 'loading' })
    try {
      const records = await bridge().extensions.list()
      setList({ kind: 'ready', records: sortExtensions(records) })
    } catch (err) {
      // 读失败是权威结论，留在页面上等用户重试；不用会自己消失的 toast
      setList({ kind: 'error', message: cleanIpcMessage(errorMessage(err)) })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const records = list.kind === 'ready' ? list.records : []

  /* ────────────────────────────── 新增 ────────────────────────────── */

  async function addExtension(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const trimmedName = name.trim()
    const trimmedPath = path.trim()
    if (adding || trimmedName === '' || trimmedPath === '') return

    setAdding(true)
    try {
      // 主进程仍会重新校验名称 / 路径 / manifest / 重复登记 —— 这里的非空判断
      // 只是省掉一次注定失败的往返，不是把校验搬到渲染层。
      await bridge().extensions.create({
        name: trimmedName,
        path: trimmedPath,
        enabled: true
      })
      setName('')
      setPath('')
      toast.push(t('ext.added'), 'ok')
      // 重新读一遍而不是把返回值直接插进本地数组：登记表是唯一事实来源，
      // 排序、去重都以主进程这次读到的为准。
      await load()
    } catch (err) {
      const message = cleanIpcMessage(errorMessage(err))
      toast.push(isManifestError(message) ? t('ext.noManifest') : message, 'err')
    } finally {
      setAdding(false)
    }
  }

  /* ────────────────────────────── 开关 ────────────────────────────── */

  async function toggleExtension(record: ExtensionRecord): Promise<void> {
    if (busyId !== null) return
    setBusyId(record.id)
    try {
      const updated = await bridge().extensions.update(record.id, { enabled: !record.enabled })
      setList((prev) =>
        prev.kind === 'ready'
          ? {
              kind: 'ready',
              records: prev.records.map((item) => (item.id === updated.id ? updated : item))
            }
          : prev
      )
    } catch (err) {
      toast.push(cleanIpcMessage(errorMessage(err)), 'err')
    } finally {
      setBusyId(null)
    }
  }

  /* ────────────────────────────── 删除登记 ────────────────────────────── */

  async function confirmDelete(): Promise<void> {
    const target = pendingDelete
    if (target === null || deleting) return

    setDeleting(true)
    try {
      await bridge().extensions.remove(target.id)
      setList((prev) =>
        prev.kind === 'ready'
          ? { kind: 'ready', records: prev.records.filter((item) => item.id !== target.id) }
          : prev
      )
      setPendingDelete(null)
      toast.push(t('ext.removed'), 'ok')
    } catch (err) {
      toast.push(cleanIpcMessage(errorMessage(err)), 'err')
    } finally {
      setDeleting(false)
    }
  }

  /* ────────────────────────────── 渲染 ────────────────────────────── */

  return (
    <div className="tool-panel ext-panel">
      <header className="tool-head ext-head">
        <div>
          <h2>{t('ext.title')}</h2>
          <p>{t('ext.subtitle')}</p>
        </div>
        {list.kind === 'ready' ? (
          <span className="ext-count">{list.records.length}</span>
        ) : null}
      </header>

      <div className="tool-body">
        <form className="ext-form" onSubmit={(event) => void addExtension(event)}>
          <div className="ext-form-fields">
            <Field label={t('ext.name')}>
              <input
                className="ui-input"
                value={name}
                maxLength={60}
                placeholder={t('ext.namePlaceholder')}
                disabled={adding}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label={t('ext.path')} hint={t('ext.pathHint')}>
              <input
                className="ui-input ext-path-input"
                value={path}
                placeholder={t('ext.pathPlaceholder')}
                disabled={adding}
                spellCheck={false}
                onChange={(event) => setPath(event.target.value)}
              />
            </Field>
          </div>
          <Button
            type="submit"
            variant="primary"
            icon="plus"
            disabled={adding || name.trim() === '' || path.trim() === ''}
          >
            {t('ext.add')}
          </Button>
        </form>

        {list.kind === 'loading' ? (
          <div className="ext-loading">{t('common.loading')}</div>
        ) : list.kind === 'error' ? (
          /* 读不到 ≠ 没有登记。用琥珀态 + 重试入口，和空态的虚线引导一眼可分 */
          <div className="ext-error" role="alert">
            <b>{t('ext.readFailed')}</b>
            <p className="ext-error-reason">{list.message}</p>
            <Button variant="ghost" icon="reload" onClick={() => void load()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : records.length === 0 ? (
          <EmptyState icon="folder" title={t('ext.empty')} desc={t('ext.emptyHint')} />
        ) : (
          <div className="ext-list">
            {records.map((record) => {
              const statusLabel = record.enabled ? t('ext.enabled') : t('ext.disabled')
              return (
                <div className={cx('ext-row', !record.enabled && 'off')} key={record.id}>
                  <div className="ext-main">
                    <div className="ext-name-row">
                      <span className="ext-name" title={record.name}>
                        {record.name}
                      </span>
                      <Badge tone={record.enabled ? 'ok' : 'neutral'}>{statusLabel}</Badge>
                    </div>
                    <span className="ext-path" title={record.path}>
                      {record.path}
                    </span>
                  </div>
                  <div className="ext-ops">
                    <Toggle
                      checked={record.enabled}
                      disabled={busyId === record.id}
                      label={`${record.name} · ${statusLabel}`}
                      onChange={() => void toggleExtension(record)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      title={t('ext.remove')}
                      ariaLabel={`${t('ext.remove')} ${record.name}`}
                      onClick={() => setPendingDelete(record)}
                    >
                      {t('ext.remove')}
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <Modal
        open={pendingDelete !== null}
        title={t('ext.remove')}
        icon="trash"
        onClose={() => {
          if (!deleting) setPendingDelete(null)
        }}
        footer={
          <>
            <Button onClick={() => setPendingDelete(null)} disabled={deleting}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={() => void confirmDelete()} disabled={deleting}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {t('ext.removeConfirm', { name: pendingDelete?.name ?? '' })}
      </Modal>
    </div>
  )
}
