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
import { Button, Icon, Modal, cx, useToast } from '@renderer/components/ui'
import { bridge, errorMessage } from '@renderer/lib/api'
import { formatRelative } from '@renderer/lib/format'
import './proxy.css'

export interface PanelProps {
  profiles: Profile[]
}

const PROTOCOL_OPTIONS: Array<{ value: ProxyProtocol; label: string }> = [
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'socks5', label: 'SOCKS5' }
]

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

  const [records, setRecords] = useState<ProxyRecord[]>([])
  const [loading, setLoading] = useState(true)

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

  const reload = useCallback(async (): Promise<void> => {
    try {
      const list = await bridge().proxies.list()
      setRecords(list)
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setLoading(false)
    }
  }, [toast])

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
      toast.push('请填写代理主机', 'err')
      return
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast.push('端口必须是 1-65535 之间的整数', 'err')
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
        setRecords((prev) => prev.map((r) => (r.id === next.id ? next : r)))
        toast.push(`已保存「${next.name}」`, 'ok')
      } else {
        const created = await bridge().proxies.create(payload)
        setRecords((prev) => [...prev, created])
        toast.push(`已新增「${created.name}」`, 'ok')
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
      toast.push('先粘贴几行代理地址', 'err')
      return
    }
    setImporting(true)
    try {
      const result = await bridge().proxies.import(importText)
      setImportErrors(result.errors)
      await reload()
      toast.push(
        `导入完成：新增 ${result.added} 条，跳过 ${result.skipped} 条` +
          (result.errors.length > 0 ? `，${result.errors.length} 行有问题` : ''),
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
      setRecords((prev) => prev.map((r) => (r.id === record.id ? { ...r, lastCheck: result } : r)))
      if (result.ok) {
        toast.push(
          `「${record.name}」可用 · ${result.ip ?? '出口未知'} · ${result.latencyMs ?? 0}ms`,
          'ok'
        )
      } else {
        toast.push(`「${record.name}」检测失败：${result.error ?? '未知原因'}`, 'err')
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
      setRecords(list)
      const ok = list.filter((r) => r.lastCheck?.ok === true).length
      toast.push(`检测完成：${ok}/${list.length} 条可用`, ok === list.length ? 'ok' : 'info')
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
        toast.push(`「${profile.name}」已改为直连`, 'ok')
      } else if (record.lastCheck === null) {
        toast.push(`已挂载到「${profile.name}」，但该代理尚未检测，无法校验出口时区`, 'info')
      } else if (
        record.lastCheck.timezone !== undefined &&
        record.lastCheck.timezone !== profile.fingerprint.timezone
      ) {
        // 出口时区与指纹时区打架时，网站看到的是「时区在美国、IP 在日本」的矛盾身份
        toast.push(
          `已挂载到「${profile.name}」，但时区不一致：代理 ${record.lastCheck.timezone} ≠ 环境 ${profile.fingerprint.timezone}`,
          'info'
        )
      } else {
        toast.push(`已把「${record.name}」挂到「${profile.name}」`, 'ok')
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
      setRecords((prev) => prev.filter((r) => r.id !== pendingDelete.id))
      toast.push(`已删除「${pendingDelete.name}」，原挂载该代理的环境已改为直连`, 'ok')
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
          <h2>代理池</h2>
          <p>集中管理出口代理，真实探测出口 IP 与时区，再把代理挂到环境上。</p>
        </div>
        <div className="px-toolbar">
          <Button variant="ghost" icon="download" onClick={openImport}>
            粘贴导入
          </Button>
          <Button
            variant="ghost"
            icon="reload"
            onClick={() => void checkAll()}
            disabled={checkingAll || records.length === 0}
            title={records.length === 0 ? '先添加代理再检测' : '逐条串行检测全部代理'}
          >
            {checkingAll ? '检测中…' : '全部检测'}
          </Button>
          <Button variant="primary" icon="plus" onClick={openCreate}>
            新建代理
          </Button>
        </div>
      </header>

      <div className="tool-body">
        <div className="px-bar">
          <span className="px-count">
            共 <b>{stats.total}</b> 条
          </span>
          <span className="px-dot px-ok">可用 {stats.ok}</span>
          <span className="px-dot px-bad">异常 {stats.bad}</span>
          <span className="px-dot px-dim">未检测 {stats.unchecked}</span>
          <span className="px-spacer" />
          <span className="px-hint">检测走 CONNECT 隧道，只认真实出口，不伪造结果</span>
        </div>

        {loading ? (
          <div className="px-empty">正在读取代理…</div>
        ) : records.length === 0 ? (
          <div className="px-empty px-empty-guide">
            <div className="mark">
              <Icon name="globe" size={20} strokeWidth={2} />
            </div>
            <h3>还没有代理</h3>
            <p>
              一条代理对应一个出口身份。可以先建一条，也可以把商家给的地址整段粘进来：
              <br />
              <code>http://user:pass@1.2.3.4:8080</code> · <code>1.2.3.4:8080:user:pass</code> ·{' '}
              <code>1.2.3.4:8080</code>
            </p>
            <div className="px-empty-actions">
              <Button variant="ghost" icon="download" onClick={openImport}>
                粘贴导入
              </Button>
              <Button variant="primary" icon="plus" onClick={openCreate}>
                新建代理
              </Button>
            </div>
          </div>
        ) : (
          <div className="px-table">
            <div className="px-row px-head">
              <span>名称</span>
              <span>协议</span>
              <span>地址</span>
              <span>出口 IP</span>
              <span>时区</span>
              <span>延迟</span>
              <span>最近检测</span>
              <span className="px-ops">操作</span>
            </div>
            {records.map((record) => {
              const check = record.lastCheck
              return (
                <div className="px-row" key={record.id}>
                  <div className="px-name">
                    <span className="n">{record.name}</span>
                    <span className="px-tags">
                      {record.region ? <span className="px-tag">{record.region}</span> : null}
                      {record.username ? <span className="px-tag">认证</span> : null}
                    </span>
                  </div>
                  <span className={cx('px-proto', record.protocol)}>{record.protocol}</span>
                  <span className="px-mono">
                    {record.host}:{record.port}
                  </span>
                  <div className="px-exit">
                    {check === null ? (
                      <span className="px-dim">未检测</span>
                    ) : check.ok ? (
                      <>
                        <span className="px-mono px-ok">{check.ip ?? '—'}</span>
                        {check.country ? <span className="px-sub">{check.country}</span> : null}
                      </>
                    ) : (
                      <span className="px-bad px-ellipsis" title={check.error}>
                        {check.error ?? '检测失败'}
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
                    {check === null ? '未检测' : formatRelative(check.at)}
                  </span>
                  <div className="px-ops">
                    <button
                      type="button"
                      className="px-icon"
                      title="检测这条代理"
                      aria-label="检测这条代理"
                      disabled={checkingId === record.id}
                      onClick={() => void checkOne(record)}
                    >
                      <Icon name={checkingId === record.id ? 'reload' : 'shield'} size={13} />
                    </button>
                    <button
                      type="button"
                      className="px-icon"
                      title="挂载到环境"
                      aria-label="挂载到环境"
                      onClick={() => setMountTarget(record)}
                    >
                      <Icon name="swap" size={13} />
                    </button>
                    <button
                      type="button"
                      className="px-icon"
                      title="编辑"
                      aria-label="编辑"
                      onClick={() => openEdit(record)}
                    >
                      <Icon name="sliders" size={13} />
                    </button>
                    <button
                      type="button"
                      className="px-icon px-danger"
                      title="删除"
                      aria-label="删除"
                      onClick={() => setPendingDelete(record)}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 新建 / 编辑 */}
      <Modal
        open={formOpen}
        title={editing ? '编辑代理' : '新建代理'}
        icon={editing ? 'sliders' : 'plus'}
        tone="accent"
        align="left"
        maxWidth={420}
        onClose={() => setFormOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setFormOpen(false)}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void submitForm()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </>
        }
        note={editing ? '改了地址或凭证后，旧的检测结果会被清空' : '保存后建议立即检测一次，确认出口可用'}
      >
        <div className="px-form">
          <label className="px-field">
            <span>名称</span>
            <input
              value={form.name}
              placeholder="例如 美国住宅 01（留空则用地址）"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <div className="px-field-row">
            <label className="px-field">
              <span>协议</span>
              <select
                value={form.protocol}
                onChange={(e) => setForm({ ...form, protocol: e.target.value as ProxyProtocol })}
              >
                {PROTOCOL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="px-field">
              <span>端口</span>
              <input
                value={form.port}
                inputMode="numeric"
                placeholder="8080"
                onChange={(e) => setForm({ ...form, port: e.target.value.replace(/\D/g, '') })}
              />
            </label>
          </div>
          <label className="px-field">
            <span>主机</span>
            <input
              value={form.host}
              placeholder="1.2.3.4 或 proxy.example.com"
              onChange={(e) => setForm({ ...form, host: e.target.value })}
            />
          </label>
          <div className="px-field-row">
            <label className="px-field">
              <span>用户名</span>
              <input
                value={form.username}
                autoComplete="off"
                placeholder="可留空"
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </label>
            <label className="px-field">
              <span>密码</span>
              <input
                type="password"
                value={form.password}
                autoComplete="new-password"
                placeholder="可留空"
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </label>
          </div>
          <label className="px-field">
            <span>地区备注</span>
            <input
              value={form.region}
              placeholder="仅用于列表识别，例如 洛杉矶"
              onChange={(e) => setForm({ ...form, region: e.target.value })}
            />
          </label>
        </div>
      </Modal>

      {/* 粘贴导入 */}
      <Modal
        open={importOpen}
        title="粘贴导入"
        icon="download"
        tone="accent"
        align="left"
        maxWidth={460}
        onClose={() => setImportOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setImportOpen(false)}>
              关闭
            </Button>
            <Button variant="primary" onClick={() => void submitImport()} disabled={importing}>
              {importing ? '导入中…' : '开始导入'}
            </Button>
          </>
        }
        note="相同 host:port 视为重复，重复行会跳过而不是报错"
      >
        <div className="px-form">
          <label className="px-field">
            <span>每行一条，支持三种写法</span>
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
              <div className="h">以下行没有导入</div>
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
        title="挂载代理"
        icon="swap"
        tone="accent"
        align="left"
        maxWidth={460}
        onClose={() => setMountTarget(null)}
        footer={
          <Button variant="ghost" onClick={() => setMountTarget(null)}>
            取消
          </Button>
        }
        note="挂载只影响之后启动的窗口，正在运行的环境需要重启才换出口"
      >
        {mountTarget !== null ? (
          <div className="px-form">
            <p className="px-mount-note">
              把 <b>{mountTarget.name}</b>（{mountTarget.host}:{mountTarget.port}）挂到哪个环境？出口时区：
              {mountTarget.lastCheck?.timezone ?? '未检测'}
            </p>
            {profiles.length === 0 ? (
              <div className="px-mount-empty">还没有环境，先去环境页建一个再回来挂载。</div>
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
                        <span className="cur">{proxy ? `${proxy.host}:${proxy.port}` : '直连'}</span>
                      </button>
                      {alreadyHere ? (
                        <button
                          type="button"
                          className="unlink"
                          disabled={applyingId !== null}
                          title="把这个环境改回直连"
                          onClick={() => void applyTo(profile, null)}
                        >
                          直连
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
        title="删除代理"
        icon="alert"
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button variant="danger" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting ? '删除中…' : '删除'}
            </Button>
          </>
        }
        note="删除后无法恢复，重新导入需要原始地址与密码"
      >
        确定删除「{pendingDelete?.name ?? ''}」？挂载了这条代理的环境会一并改为直连。
      </Modal>
    </div>
  )
}
