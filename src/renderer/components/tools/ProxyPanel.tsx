/**
 * 代理池面板。
 *
 * 代理记录的增删改查、批量导入、真实连通性检测，以及挂载到环境时的一致性提示。
 *
 * 归属：proxy-agent
 * 本文件的样式写在同目录 proxy.css，不要往全局 app.css 里加，
 * 否则多个模块并行开发时会互相覆盖。
 *
 * 数据流是「调用 → 主进程 → 回填」：这里不做乐观更新，
 * 因为检测结果、删除后的挂载关系都由主进程说了算，本地先改会和落盘状态打架。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Profile, ProxyConfig, ProxyInput, ProxyProtocol, ProxyRecord } from '@shared/types'
import { Button, EmptyState, Icon, Modal, cx, useToast } from '@renderer/components/ui'
import { bridge, errorMessage } from '@renderer/lib/api'
import { formatRelative } from '@renderer/lib/format'
import { useI18n } from '@renderer/lib/i18n'
import './proxy.css'

export interface PanelProps {
  profiles: Profile[]
}

/**
 * 列表读取的三态（DESIGN.md §不可判读状态）。
 * 用两个布尔量表达时，「读完了但没读到」和「读失败」会共用同一个合法组合，
 * 歧义从类型里就进来了；联合类型逼每一态都必须回答「画什么」。
 */
type ProxyListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; records: ProxyRecord[] }

/**
 * 剥掉 Electron 给 IPC 失败套的通道名外壳。
 * DESIGN.md「错误原文不要带协议噪音」：原始消息形如
 * `Error invoking remote method 'ss:proxies:list': Error: EACCES: ...`，
 * 前半截会把真正原因挤出屏幕。AuditPanel 用的是同一条正则，但它在那个文件里
 * 没有导出；这里按同样的口径内联一份，不为此新建共享文件。
 */
function cleanIpcMessage(raw: string): string {
  const m = /Error invoking remote method '[^']*':\s*(?:Error:\s*)?([\s\S]*)$/.exec(raw)
  return (m?.[1] ?? raw).trim()
}

const PROTOCOL_OPTIONS: Array<{ value: ProxyProtocol; labelKey: string }> = [
  { value: 'http', labelKey: 'proxy.protocol.http' },
  { value: 'https', labelKey: 'proxy.protocol.https' },
  { value: 'socks5', labelKey: 'proxy.protocol.socks5' },
  { value: 'socks5h', labelKey: 'proxy.protocol.socks5h' }
]

/**
 * 表格首批渲染多少条 / 每次「加载更多」加多少条。
 *
 * 为什么不全量渲染：代理池没有条数上限，商家一次给几百条很常见，
 * 每行 8 列（名称、协议、地址、出口 IP、时区、延迟、检测时间、4 个操作按钮）
 * 就是十几个 DOM 节点。几百行铺开时滚动、以及每次检测回填触发的整表 diff
 * 都会明显掉帧。数据仍一次取全，这里只控制「一次画多少行」。
 */
const PROXY_PAGE = 100
const PROXY_STEP = 200

interface FormState {
  name: string
  protocol: ProxyProtocol
  host: string
  port: string
  username: string
  password: string
  region: string
}

const EMPTY_FORM: FormState = {
  name: '',
  protocol: 'http',
  host: '',
  port: '',
  username: '',
  password: '',
  region: ''
}

/** 延迟分档：代理的正常区间比本地 API 宽，400ms 内都算顺畅 */
function latencyClass(ms: number | undefined): string {
  if (typeof ms !== 'number') return 'px-dim'
  if (ms <= 400) return 'px-ok'
  if (ms <= 1200) return 'px-warn'
  return 'px-bad'
}

function checkTone(record: ProxyRecord): string {
  if (record.lastCheck === null) return 'px-dim'
  return record.lastCheck.ok ? 'px-ok' : 'px-bad'
}

export function ProxyPanel({ profiles }: PanelProps) {
  const toast = useToast()
  const { t } = useI18n()

  const [list, setList] = useState<ProxyListState>({ kind: 'loading' })
  // 读不到时列表按「没有」处理，所有读 records 的地方（统计、工具栏守卫）照旧，
  // 但「画什么」由下面的 list.kind 三态分支决定，不再由一个布尔量说了算。
  const records = list.kind === 'ready' ? list.records : []

  // 挂载成功后 App 持有的 profiles 不会自动刷新，这里记下本次会话里改过的值，
  // 保证挂载弹层里显示的是「刚挂上去的那条」，而不是刷新前的旧值
  const [applied, setApplied] = useState<Record<string, ProxyConfig | null>>({})

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ProxyRecord | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importErrors, setImportErrors] = useState<string[]>([])
  const [importing, setImporting] = useState(false)

  const [mountTarget, setMountTarget] = useState<ProxyRecord | null>(null)
  const [applyingId, setApplyingId] = useState<string | null>(null)

  const [pendingDelete, setPendingDelete] = useState<ProxyRecord | null>(null)
  const [deleting, setDeleting] = useState(false)

  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [checkingAll, setCheckingAll] = useState(false)
  /** 表格当前渲染多少条（见 PROXY_PAGE 的注释） */
  const [visibleCount, setVisibleCount] = useState(PROXY_PAGE)

  const reload = useCallback(async (): Promise<void> => {
    setList({ kind: 'loading' })
    // 重新读到的是另一份数据，已展开的条数回到首批
    setVisibleCount(PROXY_PAGE)
    try {
      const list = await bridge().proxies.list()
      setList({ kind: 'ready', records: list })
    } catch (err) {
      // 读失败是权威结论，留在原地；不再弹会消失的 toast，否则又退化成「空」
      setList({ kind: 'error', message: cleanIpcMessage(errorMessage(err)) })
    }
  }, [])

  /**
   * 变更成功后就地回填列表。
   * 不退回 loading：逐条回填才不会让正在看的那一行跳位（见 checkOne 的注释）。
   * 非 ready 态（读失败/加载中）里成功变更也算「列表现在可读了」，直接落到 ready，
   * 这样用户新建/删除后能看到结果，行为和改造前一致。
   */
  const updateRecords = (fn: (prev: ProxyRecord[]) => ProxyRecord[]): void => {
    setList((prev) => ({ kind: 'ready', records: fn(prev.kind === 'ready' ? prev.records : []) }))
  }

  useEffect(() => {
    void reload()
  }, [reload])

  const stats = useMemo(() => {
    const ok = records.filter((r) => r.lastCheck?.ok === true).length
    const bad = records.filter((r) => r.lastCheck !== null && r.lastCheck.ok === false).length
    return { total: records.length, ok, bad, unchecked: records.length - ok - bad }
  }, [records])

  const currentProxy = (profile: Profile): ProxyConfig | null =>
    profile.id in applied ? applied[profile.id] : profile.proxy

  /* ────────────────────────────── 新建 / 编辑 ────────────────────────────── */

  const openCreate = (): void => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setFormOpen(true)
  }

  const openEdit = (record: ProxyRecord): void => {
    setEditing(record)
    setForm({
      name: record.name,
      protocol: record.protocol,
      host: record.host,
      port: String(record.port),
      username: record.username ?? '',
      password: record.password ?? '',
      region: record.region ?? ''
    })
    setFormOpen(true)
  }

  const submitForm = async (): Promise<void> => {
    const host = form.host.trim()
    const port = Number(form.port)
    if (!host) {
      toast.push(t('proxy.err.hostRequired'), 'err')
      return
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast.push(t('proxy.err.portInvalid'), 'err')
      return
    }

    // 空字符串照样传：编辑时清空用户名/密码/地区要靠它把旧值抹掉
    const payload: ProxyInput = {
      name: form.name.trim(),
      protocol: form.protocol,
      host,
      port,
      username: form.username.trim(),
      password: form.password,
      region: form.region.trim()
    }

    setSaving(true)
    try {
      if (editing) {
        const next = await bridge().proxies.update(editing.id, payload)
        updateRecords((prev) => prev.map((r) => (r.id === next.id ? next : r)))
        toast.push(t('proxy.toast.saved', { name: next.name }), 'ok')
      } else {
        const created = await bridge().proxies.create(payload)
        updateRecords((prev) => [...prev, created])
        toast.push(t('proxy.toast.created', { name: created.name }), 'ok')
      }
      setFormOpen(false)
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setSaving(false)
    }
  }

  /* ────────────────────────────── 导入 ────────────────────────────── */

  const openImport = (): void => {
    setImportText('')
    setImportErrors([])
    setImportOpen(true)
  }

  const submitImport = async (): Promise<void> => {
    if (!importText.trim()) {
      toast.push(t('proxy.err.pasteFirst'), 'err')
      return
    }
    setImporting(true)
    try {
      const result = await bridge().proxies.import(importText)
      setImportErrors(result.errors)
      await reload()
      toast.push(
        t('proxy.toast.importDone', { added: result.added, skipped: result.skipped }) +
          (result.errors.length > 0 ? t('proxy.toast.importErrorLines', { n: result.errors.length }) : ''),
        result.added > 0 ? 'ok' : 'info'
      )
      // 有错误就留在弹层里让人逐行看，没错才关掉
      if (result.errors.length === 0) setImportOpen(false)
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setImporting(false)
    }
  }

  /* ────────────────────────────── 检测 ────────────────────────────── */

  const checkOne = async (record: ProxyRecord): Promise<void> => {
    setCheckingId(record.id)
    try {
      const result = await bridge().proxies.check(record.id)
      // 只回填这一行：整表重排会让用户正在看的行跳位置
      updateRecords((prev) => prev.map((r) => (r.id === record.id ? { ...r, lastCheck: result } : r)))
      if (result.ok) {
        toast.push(
          t('proxy.toast.checkOk', {
            name: record.name,
            ip: result.ip ?? t('proxy.unknownExit'),
            ms: result.latencyMs ?? 0
          }),
          'ok'
        )
      } else {
        toast.push(
          t('proxy.toast.checkFail', {
            name: record.name,
            reason: result.error ?? t('proxy.unknownReason')
          }),
          'err'
        )
      }
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setCheckingId(null)
    }
  }

  const checkAll = async (): Promise<void> => {
    setCheckingAll(true)
    try {
      const list = await bridge().proxies.checkAll()
      updateRecords(() => list)
      const ok = list.filter((r) => r.lastCheck?.ok === true).length
      toast.push(
        t('proxy.toast.checkAllDone', { ok, total: list.length }),
        ok === list.length ? 'ok' : 'info'
      )
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setCheckingAll(false)
    }
  }

  /* ────────────────────────────── 挂载 / 删除 ────────────────────────────── */

  const applyTo = async (profile: Profile, record: ProxyRecord | null): Promise<void> => {
    setApplyingId(profile.id)
    try {
      const updated = await bridge().proxies.apply(profile.id, record ? record.id : null)
      setApplied((prev) => ({ ...prev, [profile.id]: updated.proxy }))

      if (record === null) {
        toast.push(t('proxy.toast.direct', { name: profile.name }), 'ok')
      } else if (record.lastCheck === null) {
        toast.push(t('proxy.toast.mountedUnchecked', { name: profile.name }), 'info')
      } else if (
        record.lastCheck.timezone !== undefined &&
        record.lastCheck.timezone !== profile.fingerprint.timezone
      ) {
        // 出口时区与指纹时区打架时，网站看到的是「时区在美国、IP 在日本」的矛盾身份
        toast.push(
          t('proxy.toast.mountedTzMismatch', {
            name: profile.name,
            proxyTz: record.lastCheck.timezone,
            envTz: profile.fingerprint.timezone
          }),
          'info'
        )
      } else {
        toast.push(
          t('proxy.toast.mounted', { proxy: record.name, profile: profile.name }),
          'ok'
        )
      }
      setMountTarget(null)
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setApplyingId(null)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (pendingDelete === null) return
    setDeleting(true)
    try {
      await bridge().proxies.remove(pendingDelete.id)
      updateRecords((prev) => prev.filter((r) => r.id !== pendingDelete.id))
      toast.push(t('proxy.toast.deleted', { name: pendingDelete.name }), 'ok')
      setPendingDelete(null)
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setDeleting(false)
    }
  }

  /* ────────────────────────────── 渲染 ────────────────────────────── */

  return (
    <div className="tool-panel">
      <header className="tool-head px-headbar">
        <div>
          <h2>{t('proxy.title')}</h2>
          <p>{t('proxy.subtitle')}</p>
        </div>
        <div className="px-toolbar">
          <Button variant="ghost" icon="download" onClick={openImport}>
            {t('proxy.import.paste')}
          </Button>
          <Button
            variant="ghost"
            icon="reload"
            onClick={() => void checkAll()}
            disabled={checkingAll || records.length === 0}
            title={records.length === 0 ? t('proxy.checkAll.titleEmpty') : t('proxy.checkAll.title')}
          >
            {checkingAll ? t('proxy.checking') : t('proxy.checkAll')}
          </Button>
          <Button variant="primary" icon="plus" onClick={openCreate}>
            {t('proxy.create')}
          </Button>
        </div>
      </header>

      <div className="tool-body">
        <div className="px-bar">
          <span className="px-count">
            {t('proxy.count.prefix')}
            <b>{stats.total}</b>
            {t('proxy.count.suffix')}
          </span>
          <span className="px-dot px-ok">{t('proxy.stat.ok', { n: stats.ok })}</span>
          <span className="px-dot px-bad">{t('proxy.stat.bad', { n: stats.bad })}</span>
          <span className="px-dot px-dim">{t('proxy.stat.unchecked', { n: stats.unchecked })}</span>
          <span className="px-spacer" />
          <span className="px-hint">{t('proxy.hint')}</span>
        </div>

        {list.kind === 'loading' ? (
          <div className="px-empty">{t('proxy.loading')}</div>
        ) : list.kind === 'error' ? (
          /* 读不到 ≠ 没有代理。琥珀态 + 重试入口，和空态的虚线框/引导动作一眼可分。
             用 warn 不用 red：读不到是「不知道」，不是确认数据坏了（DESIGN.md §不可判读状态）。 */
          <div className="px-err">
            <b>{t('proxy.error.title')}</b>
            <p>{t('proxy.error.reason', { message: list.message })}</p>
            <p className="px-err-hint">{t('proxy.error.hint')}</p>
            <Button variant="ghost" icon="reload" onClick={() => void reload()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : records.length === 0 ? (
          <EmptyState
            icon="globe"
            title={t('proxy.empty.title')}
            desc={
              <>
                {t('proxy.empty.body')}
                <br />
                <code>http://user:pass@1.2.3.4:8080</code> · <code>1.2.3.4:8080:user:pass</code> ·{' '}
                <code>1.2.3.4:8080</code>
              </>
            }
            action={
              <>
                <Button variant="ghost" icon="download" onClick={openImport}>
                  {t('proxy.import.paste')}
                </Button>
                <Button variant="primary" icon="plus" onClick={openCreate}>
                  {t('proxy.create')}
                </Button>
              </>
            }
          />
        ) : (
          <div className="px-table">
            <div className="px-row px-head">
              <span>{t('common.name')}</span>
              <span>{t('proxy.table.protocol')}</span>
              <span>{t('proxy.table.address')}</span>
              <span>{t('proxy.table.exitIp')}</span>
              <span>{t('proxy.table.timezone')}</span>
              <span>{t('proxy.table.latency')}</span>
              <span>{t('proxy.table.lastCheck')}</span>
              <span className="px-ops">{t('common.actions')}</span>
            </div>
            {records.slice(0, visibleCount).map((record) => {
              const check = record.lastCheck
              return (
                <div className="px-row" key={record.id}>
                  <div className="px-name">
                    <span className="n">{record.name}</span>
                    <span className="px-tags">
                      {record.region ? <span className="px-tag">{record.region}</span> : null}
                      {record.username ? <span className="px-tag">{t('proxy.tag.auth')}</span> : null}
                    </span>
                  </div>
                  <span className={cx('px-proto', record.protocol)}>{record.protocol}</span>
                  <span className="px-mono">
                    {record.host}:{record.port}
                  </span>
                  <div className="px-exit">
                    {check === null ? (
                      <span className="px-dim">{t('proxy.unchecked')}</span>
                    ) : check.ok ? (
                      <>
                        <span className="px-mono px-ok">{check.ip ?? '—'}</span>
                        {check.country ? <span className="px-sub">{check.country}</span> : null}
                      </>
                    ) : (
                      <span className="px-bad px-ellipsis" title={check.error}>
                        {check.error ?? t('proxy.checkFailed')}
                      </span>
                    )}
                  </div>
                  <span className={cx('px-mono', check?.ok ? 'px-ink' : 'px-dim')}>
                    {check?.timezone ?? '—'}
                  </span>
                  <span className={cx('px-lat', latencyClass(check?.ok ? check.latencyMs : undefined))}>
                    {check?.ok && typeof check.latencyMs === 'number' ? `${check.latencyMs} ms` : '—'}
                  </span>
                  <span className={cx('px-time', checkTone(record))}>
                    {check === null ? t('proxy.unchecked') : formatRelative(check.at)}
                  </span>
                  <div className="px-ops">
                    <button
                      type="button"
                      className="px-icon"
                      title={t('proxy.action.check')}
                      aria-label={t('proxy.action.check')}
                      disabled={checkingId === record.id}
                      onClick={() => void checkOne(record)}
                    >
                      <Icon name={checkingId === record.id ? 'reload' : 'shield'} size={13} />
                    </button>
                    <button
                      type="button"
                      className="px-icon"
                      title={t('proxy.action.mount')}
                      aria-label={t('proxy.action.mount')}
                      onClick={() => setMountTarget(record)}
                    >
                      <Icon name="swap" size={13} />
                    </button>
                    <button
                      type="button"
                      className="px-icon"
                      title={t('common.edit')}
                      aria-label={t('common.edit')}
                      onClick={() => openEdit(record)}
                    >
                      <Icon name="sliders" size={13} />
                    </button>
                    <button
                      type="button"
                      className="px-icon px-danger"
                      title={t('common.delete')}
                      aria-label={t('common.delete')}
                      onClick={() => setPendingDelete(record)}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                </div>
              )
            })}
            {visibleCount < records.length ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0' }}>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setVisibleCount((n) => n + PROXY_STEP)}
                >
                  {t('common.loadMore', { n: records.length - visibleCount })}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* 新建 / 编辑 */}
      <Modal
        open={formOpen}
        title={editing ? t('proxy.form.editTitle') : t('proxy.create')}
        icon={editing ? 'sliders' : 'plus'}
        tone="accent"
        align="left"
        maxWidth={420}
        onClose={() => setFormOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setFormOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void submitForm()} disabled={saving}>
              {saving ? t('proxy.form.saving') : t('common.save')}
            </Button>
          </>
        }
        note={editing ? t('proxy.form.noteEdit') : t('proxy.form.noteCreate')}
      >
        <div className="px-form">
          <label className="px-field">
            <span>{t('common.name')}</span>
            <input
              value={form.name}
              placeholder={t('proxy.form.namePlaceholder')}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <div className="px-field-row">
            <label className="px-field">
              <span>{t('proxy.form.protocol')}</span>
              <select
                value={form.protocol}
                onChange={(e) => setForm({ ...form, protocol: e.target.value as ProxyProtocol })}
              >
                {PROTOCOL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {t(opt.labelKey)}
                  </option>
                ))}
              </select>
            </label>
            <label className="px-field">
              <span>{t('proxy.form.port')}</span>
              <input
                value={form.port}
                inputMode="numeric"
                placeholder="8080"
                onChange={(e) => setForm({ ...form, port: e.target.value.replace(/\D/g, '') })}
              />
            </label>
          </div>
          <label className="px-field">
            <span>{t('proxy.form.host')}</span>
            <input
              value={form.host}
              placeholder={t('proxy.form.hostPlaceholder')}
              onChange={(e) => setForm({ ...form, host: e.target.value })}
            />
          </label>
          <div className="px-field-row">
            <label className="px-field">
              <span>{t('proxy.form.username')}</span>
              <input
                value={form.username}
                autoComplete="off"
                placeholder={t('proxy.form.optional')}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </label>
            <label className="px-field">
              <span>{t('proxy.form.password')}</span>
              <input
                type="password"
                value={form.password}
                autoComplete="new-password"
                placeholder={t('proxy.form.optional')}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </label>
          </div>
          <label className="px-field">
            <span>{t('proxy.form.region')}</span>
            <input
              value={form.region}
              placeholder={t('proxy.form.regionPlaceholder')}
              onChange={(e) => setForm({ ...form, region: e.target.value })}
            />
          </label>
        </div>
      </Modal>

      {/* 粘贴导入 */}
      <Modal
        open={importOpen}
        title={t('proxy.import.paste')}
        icon="download"
        tone="accent"
        align="left"
        maxWidth={460}
        onClose={() => setImportOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setImportOpen(false)}>
              {t('common.close')}
            </Button>
            <Button variant="primary" onClick={() => void submitImport()} disabled={importing}>
              {importing ? t('proxy.import.importing') : t('proxy.import.start')}
            </Button>
          </>
        }
        note={t('proxy.import.note')}
      >
        <div className="px-form">
          <label className="px-field">
            <span>{t('proxy.import.label')}</span>
            <textarea
              className="px-textarea"
              value={importText}
              spellCheck={false}
              placeholder={'http://user:pass@1.2.3.4:8080\n1.2.3.4:8080:user:pass\n1.2.3.4:8080'}
              onChange={(e) => setImportText(e.target.value)}
            />
          </label>
          {importErrors.length > 0 ? (
            <div className="px-errors">
              <div className="h">{t('proxy.import.errorsTitle')}</div>
              <ul>
                {importErrors.map((err) => (
                  <li key={err}>{err}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Modal>

      {/* 挂载到环境 */}
      <Modal
        open={mountTarget !== null}
        title={t('proxy.mount.title')}
        icon="swap"
        tone="accent"
        align="left"
        maxWidth={460}
        onClose={() => setMountTarget(null)}
        footer={
          <Button variant="ghost" onClick={() => setMountTarget(null)}>
            {t('common.cancel')}
          </Button>
        }
        note={t('proxy.mount.note')}
      >
        {mountTarget !== null ? (
          <div className="px-form">
            <p className="px-mount-note">
              {t('proxy.mount.promptBefore')}
              <b>{mountTarget.name}</b>
              {t('proxy.mount.promptAfter', {
                host: mountTarget.host,
                port: mountTarget.port,
                tz: mountTarget.lastCheck?.timezone ?? t('proxy.unchecked')
              })}
            </p>
            {profiles.length === 0 ? (
              <div className="px-mount-empty">{t('proxy.mount.noProfiles')}</div>
            ) : (
              <div className="px-envlist">
                {profiles.map((profile) => {
                  const proxy = currentProxy(profile)
                  const mismatch =
                    mountTarget.lastCheck?.timezone !== undefined &&
                    mountTarget.lastCheck.timezone !== profile.fingerprint.timezone
                  const alreadyHere =
                    proxy !== null &&
                    proxy.host === mountTarget.host &&
                    proxy.port === mountTarget.port
                  return (
                    <div className="px-envrow" key={profile.id}>
                      <button
                        type="button"
                        className="pick"
                        disabled={applyingId !== null}
                        onClick={() => void applyTo(profile, mountTarget)}
                      >
                        <span className="n">{profile.name}</span>
                        <span className={cx('tz', mismatch && 'px-warn')}>
                          {profile.fingerprint.timezone}
                        </span>
                        <span className="cur">
                          {proxy ? `${proxy.host}:${proxy.port}` : t('proxy.direct')}
                        </span>
                      </button>
                      {alreadyHere ? (
                        <button
                          type="button"
                          className="unlink"
                          disabled={applyingId !== null}
                          title={t('proxy.action.direct')}
                          onClick={() => void applyTo(profile, null)}
                        >
                          {t('proxy.direct')}
                        </button>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        ) : null}
      </Modal>

      {/* 删除确认 */}
      <Modal
        open={pendingDelete !== null}
        title={t('proxy.delete.title')}
        icon="alert"
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting ? t('proxy.delete.deleting') : t('common.delete')}
            </Button>
          </>
        }
        note={t('proxy.delete.note')}
      >
        {t('proxy.delete.confirm', { name: pendingDelete?.name ?? '' })}
      </Modal>
    </div>
  )
}
