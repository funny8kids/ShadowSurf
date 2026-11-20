/**
 * 指纹模板与迁移面板。
 *
 * 两件事放在同一页，因为它们服务同一个目的：让一套身份可以复用、可以搬家。
 * 上半部分是模板库（保存 / 应用 / 删除），下半部分是迁移包（导出 / 导入）。
 *
 * 归属：template-agent
 * 本文件的样式写在同目录 template.css，不要往全局 app.css 里加，
 * 否则多个模块并行开发时会互相覆盖。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { FingerprintTemplate, OSKind, Profile } from '@shared/types'
import type { MigrationAdoptReport } from '@shared/ipc'
import { Button, Icon, Modal, cx, useToast } from '@renderer/components/ui'
import { bridge, errorMessage, hasBridge } from '@renderer/lib/api'
import { useI18n } from '@renderer/lib/i18n'
import './template.css'

export interface PanelProps {
  profiles: Profile[]
}

/**
 * 模板列表读取的三态（DESIGN.md §不可判读状态）。
 * 「读失败」和「确实为空」不能共用 loading=false + 空数组这一个组合，
 * 用联合类型逼每一态都必须回答「画什么」。
 */
type TemplateListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; templates: FingerprintTemplate[] }

/**
 * 剥掉 Electron 给 IPC 失败套的通道名外壳。
 * DESIGN.md「错误原文不要带协议噪音」：原始消息形如
 * `Error invoking remote method 'ss:templates:list': Error: EACCES: ...`。
 * AuditPanel 内有一份同样的正则但没导出；按同口径内联，不为此新建共享文件。
 */
function cleanIpcMessage(raw: string): string {
  const m = /Error invoking remote method '[^']*':\s*(?:Error:\s*)?([\s\S]*)$/.exec(raw)
  return (m?.[1] ?? raw).trim()
}

const OS_LABEL: Record<OSKind, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux'
}

/**
 * 口令下限，与 main 侧 `MIN_PASSWORD_LENGTH` 同值。
 *
 * 这里再写一遍不是重复校验（main 仍然会拒），而是**为了在输入时就拦住**：
 * 用户点「导出」之后才被拒，他会以为是自己操作错了；输入框旁边写着下限，
 * 他才知道这是产品要求。两边一旦漂移，最坏结果也只是多一次往返 ——
 * 判定权始终在 main，渲染层这句话不影响任何决策。
 */
const MIN_PASS = 8

/** 卡片摘要：只挑「一眼能看出两台机器像不像」的四个参数 */
function summarize(
  template: FingerprintTemplate,
  t: (key: string, vars?: Record<string, string | number>) => string
): Array<{ k: string; v: string }> {
  const fp = template.fingerprint
  const chrome = /Chrome\/(\d+)/.exec(fp.userAgent)
  return [
    { k: 'Chrome', v: chrome ? chrome[1] : fp.uaVersion.split('.')[0] },
    { k: t('template.summary.timezone'), v: fp.timezone },
    { k: t('template.summary.screen'), v: `${fp.screen.width}×${fp.screen.height}` },
    {
      k: t('template.summary.cpu'),
      v: t('template.summary.cpuValue', {
        cores: fp.hardware.cpuCores,
        mem: fp.hardware.memoryGB
      })
    }
  ]
}

function dateStamp(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Blob + a.download 是渲染层唯一能稳定触发「另存为」的方式。
 * URL 不能立刻 revoke：Chromium 要等到下载真正开始才去读数据，
 * 提前回收会得到一个空文件。
 */
function downloadJson(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function TemplatePanel({ profiles }: PanelProps) {
  const toast = useToast()
  const { t } = useI18n()

  const [list, setList] = useState<TemplateListState>({ kind: 'loading' })
  // 读不到时按「没有」处理，所有读 templates 的地方（计数、排序）照旧，
  // 但「画什么」由下面的 list.kind 三态分支决定。
  const templates = list.kind === 'ready' ? list.templates : []
  const [busy, setBusy] = useState<string | null>(null)

  // 无桥接时主进程根本没起来，和「读失败」一样是「不知道」，落到 error 态而不是空态
  const reload = useCallback(async (): Promise<void> => {
    if (!hasBridge()) {
      setList({ kind: 'error', message: t('template.error.noBridge') })
      return
    }
    setList({ kind: 'loading' })
    try {
      const loaded = await bridge().templates.list()
      setList({ kind: 'ready', templates: loaded })
    } catch (err) {
      // 读失败是权威结论，留在原地；不弹会消失的 toast，否则又退化成「空」
      setList({ kind: 'error', message: cleanIpcMessage(errorMessage(err)) })
    }
  }, [t])

  useEffect(() => {
    void reload()
  }, [reload])

  /**
   * 变更成功后就地回填列表。
   * 不退回 loading：逐条回填才不会让正在看的卡片跳位。
   * 非 ready 态里成功变更也算「列表现在可读了」，直接落到 ready，行为和改造前一致。
   */
  function updateTemplates(fn: (prev: FingerprintTemplate[]) => FingerprintTemplate[]): void {
    setList((prev) => ({ kind: 'ready', templates: fn(prev.kind === 'ready' ? prev.templates : []) }))
  }

  // 面板内的环境列表独立维护一份：应用模板 / 导入迁移包之后需要立刻看到新指纹，
  // 而父组件的列表只在首屏和批量操作时刷新，等它自己更新会滞后。
  const [localProfiles, setLocalProfiles] = useState<Profile[]>(profiles)
  const [targets, setTargets] = useState<Record<string, string>>({})
  const [pendingDelete, setPendingDelete] = useState<FingerprintTemplate | null>(null)

  const [saveFromId, setSaveFromId] = useState('')
  const [saveName, setSaveName] = useState('')
  const [saveDesc, setSaveDesc] = useState('')

  const [exportIds, setExportIds] = useState<string[]>([])
  const [importText, setImportText] = useState('')
  const [importPreview, setImportPreview] = useState<{
    version: number
    entries: number
    proxies: number
  } | null>(null)

  // 口令。导出要两次（打错一个字符 = 这个包永远打不开，且不可逆 ——
  // 包里只有密文，没有任何地方能找回口令）。导入只要一次。
  const [exportPass, setExportPass] = useState('')
  const [exportPass2, setExportPass2] = useState('')
  const [importPass, setImportPass] = useState('')

  /**
   * v1 包缺身份时的待确认态。
   *
   * 不把它做成 Toast：Toast 会自己消失，而「导入后不是同一个身份」这件事
   * 需要用户看清楚再决定。所以留在面板上，直到他确认或取消。
   * `json` 一并存着 —— 确认时要拿**同一份文本**重发，而不是让用户再粘一次。
   */
  const [legacyLoss, setLegacyLoss] = useState<{ lostFields: string[]; json: string } | null>(null)

  /** 最近一次导入的身份核对结果。这是「导进来了」和「身份对了」的区别 */
  const [adopted, setAdopted] = useState<MigrationAdoptReport[] | null>(null)

  useEffect(() => {
    setLocalProfiles(profiles)
  }, [profiles])

  const sorted = useMemo(
    () => [...templates].sort((a, b) => b.createdAt - a.createdAt),
    [templates]
  )

  async function refreshProfiles(): Promise<void> {
    if (!hasBridge()) return
    try {
      setLocalProfiles(await bridge().profiles.list())
    } catch {
      // 面板内的刷新失败不打断主流程，主操作已经给过 Toast
    }
  }

  async function apply(template: FingerprintTemplate): Promise<void> {
    const targetId = targets[template.id]
    if (!targetId) {
      toast.push(t('template.err.needProfile'), 'info')
      return
    }
    const targetName = localProfiles.find((p) => p.id === targetId)?.name ?? targetId
    setBusy(`apply:${template.id}`)
    try {
      await bridge().templates.apply(template.id, targetId)
      await refreshProfiles()
      toast.push(t('template.toast.applied', { template: template.name, profile: targetName }), 'ok')
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setBusy(null)
    }
  }

  async function confirmDelete(): Promise<void> {
    if (pendingDelete === null) return
    const target = pendingDelete
    setBusy(`remove:${target.id}`)
    try {
      await bridge().templates.remove(target.id)
      updateTemplates((prev) => prev.filter((t) => t.id !== target.id))
      toast.push(t('template.toast.deleted', { name: target.name }), 'ok')
      setPendingDelete(null)
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setBusy(null)
    }
  }

  async function saveTemplate(): Promise<void> {
    const name = saveName.trim()
    if (!saveFromId) {
      toast.push(t('template.err.needSource'), 'info')
      return
    }
    if (!name) {
      toast.push(t('template.err.needName'), 'info')
      return
    }
    setBusy('save')
    try {
      const created = await bridge().templates.save(
        saveFromId,
        name,
        saveDesc.trim() || undefined
      )
      updateTemplates((prev) => [...prev, created])
      setSaveName('')
      setSaveDesc('')
      toast.push(t('template.toast.saved', { name: created.name }), 'ok')
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setBusy(null)
    }
  }

  async function exportSelected(): Promise<void> {
    if (exportIds.length === 0) {
      toast.push(t('template.err.needSelection'), 'info')
      return
    }
    // 口令在渲染层先自检一遍：不是为了安全（main 才是判定的地方），
    // 是为了不在用户点完之后才告诉他「少了一个字符」。
    if (exportPass.length < MIN_PASS) {
      toast.push(t('template.err.passShort', { n: MIN_PASS }), 'info')
      return
    }
    if (exportPass !== exportPass2) {
      toast.push(t('template.err.passMismatch'), 'err')
      return
    }
    setBusy('export')
    try {
      const json = await bridge().migration.export(exportIds, exportPass)
      downloadJson(json, `shadowsurf-${dateStamp()}.json`)
      toast.push(t('template.toast.exported', { n: exportIds.length }), 'ok')
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setBusy(null)
    }
  }

  /**
   * 导入。
   *
   * `accept` 只在「用户看过 lostFields 并点了继续」时为 true。默认 false 是
   * 必须的：v1 包不含身份，静默导入会让用户以为搬过来的还是同一台设备，
   * 而站点看到的是一个全新指纹 —— 这类错误事后无法从界面上看出来。
   */
  /**
   * 导入前预览（dry-run）：只解析 JSON 的**明文外壳**，不解密、不写盘。
   *
   * 为什么要它：导入按钮会把整包写进库，用户点下去之前唯一能看的是一大段
   * JSON 文本。商业产品的导入向导都会先说「这会导入 N 个环境，其中 M 个会
   * 丢身份」。这里用同一份包给出这些数字，措辞不替用户做决定。
   */
  function previewImport(): void {
    const raw = importText.trim()
    if (!raw) {
      toast.push(t('template.err.needPayload'), 'info')
      return
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const version = typeof parsed.version === 'number' ? parsed.version : 1
      const entries = Array.isArray(parsed.entries) ? parsed.entries.length : 0
      const proxies = Array.isArray(parsed.proxies) ? parsed.proxies.length : 0
      setImportPreview({ version, entries, proxies })
    } catch {
      toast.push(t('template.preview.invalid'), 'err')
    }
  }

  async function runImport(text: string, accept = false): Promise<void> {
    const payload = text.trim()
    if (!payload) {
      toast.push(t('template.err.needPayload'), 'info')
      return
    }
    if (importPass.length < MIN_PASS) {
      toast.push(t('template.err.passShort', { n: MIN_PASS }), 'info')
      return
    }
    setBusy('import')
    try {
      const result = await bridge().migration.import(
        payload,
        importPass,
        accept ? true : undefined
      )
      await refreshProfiles()
      setImportText('')
      setImportPass('')
      setLegacyLoss(null)
      setAdopted(result.adopted)
      const bad = result.adopted.filter((a) => !a.ok).length
      // 「写了几行」和「身份对不对」是两件事，所以分成两句说。
      toast.push(
        bad === 0
          ? t('template.toast.importOk', {
              profiles: result.profiles,
              proxies: result.proxies
            })
          : t('template.toast.importMismatch', { profiles: result.profiles, bad }),
        bad === 0 ? 'ok' : 'err'
      )
    } catch (err) {
      // v1 包缺身份不是「失败」，是「需要你确认」。它带 code 与结构化字段，
      // 所以能被单独识别出来 —— 其余错误照旧走 Toast。
      const lost = (err as { lostFields?: unknown }).lostFields
      if (Array.isArray(lost) && lost.length > 0 && lost.every((v) => typeof v === 'string')) {
        setLegacyLoss({ lostFields: lost as string[], json: payload })
        return
      }
      toast.push(errorMessage(err), 'err')
    } finally {
      setBusy(null)
    }
  }

  async function onPickFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    // 清空 value：同一个文件连续导入两次也要能触发 change
    event.target.value = ''
    if (!file) return
    try {
      const text = await file.text()
      setImportText(text)
      await runImport(text)
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    }
  }

  function pickSaveSource(id: string): void {
    setSaveFromId(id)
    // 名字留空时用「环境名 + 模板」预填，用户直接点保存也有意义的名字
    if (saveName.trim() === '') {
      const profile = localProfiles.find((p) => p.id === id)
      if (profile) setSaveName(t('template.save.defaultName', { name: profile.name }))
    }
  }

  function toggleExport(id: string): void {
    setExportIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  return (
    <div className="tool-panel">
      <header className="tool-head">
        <div>
          <h2>{t('template.title')}</h2>
          <p>{t('template.subtitle')}</p>
        </div>
        <div className="tpl-count">
          {t('template.count', { n: templates.length })}
        </div>
      </header>

      <div className="tool-body">
        {/* ── 模板库 ── */}
        <section className="tpl-sec">
          <div className="tpl-sec-head">
            <h3>{t('template.library')}</h3>
            <span className="tpl-sec-hint">{t('template.library.hint')}</span>
          </div>

          {list.kind === 'loading' ? (
            <div className="tpl-empty">{t('template.loading')}</div>
          ) : list.kind === 'error' ? (
            /* 读不到 ≠ 没有模板。琥珀态 + 重试入口，和空态一眼可分。
               用 warn 不用 red：读不到是「不知道」，不是确认坏了（DESIGN.md §不可判读状态）。 */
            <div className="tpl-err">
              <b>{t('template.error.title')}</b>
              <p>{t('template.error.reason', { message: list.message })}</p>
              <p className="tpl-err-hint">{t('template.error.hint')}</p>
              <Button variant="ghost" icon="reload" onClick={() => void reload()}>
                {t('common.retry')}
              </Button>
            </div>
          ) : sorted.length === 0 ? (
            <div className="tpl-empty">{t('template.empty')}</div>
          ) : (
            <div className="tpl-grid">
              {sorted.map((template) => {
                const target = targets[template.id] ?? ''
                const applying = busy === `apply:${template.id}`
                return (
                  <article className="tpl-card" key={template.id}>
                    <div className="tpl-card-top">
                      <span className="tpl-os">{OS_LABEL[template.os]}</span>
                    </div>

                    <h4 className="tpl-name">{template.name}</h4>
                    {template.description ? (
                      <p className="tpl-desc">{template.description}</p>
                    ) : null}

                    <div className="tpl-meta">
                      {summarize(template, t).map((item) => (
                        <div key={item.k}>
                          <span>{item.k}</span>
                          <b title={item.v}>{item.v}</b>
                        </div>
                      ))}
                    </div>

                    <div className="tpl-foot">
                      <select
                        className="tpl-select"
                        aria-label={t('template.apply.aria', { name: template.name })}
                        value={target}
                        onChange={(e) =>
                          setTargets((prev) => ({ ...prev, [template.id]: e.target.value }))
                        }
                      >
                        <option value="">{t('template.selectProfile')}</option>
                        {localProfiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name}
                          </option>
                        ))}
                      </select>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!target || applying}
                        onClick={() => void apply(template)}
                      >
                        {applying ? t('template.applying') : t('template.apply')}
                      </Button>
                      <button
                        type="button"
                        className="tpl-del"
                        title={t('template.delete.title')}
                        aria-label={t('template.delete.aria', { name: template.name })}
                        disabled={busy === `remove:${template.id}`}
                        onClick={() => setPendingDelete(template)}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </section>

        {/* ── 从环境保存 ── */}
        <section className="tpl-sec">
          <div className="tpl-sec-head">
            <h3>{t('template.save.title')}</h3>
            <span className="tpl-sec-hint">{t('template.save.hint')}</span>
          </div>
          <div className="tpl-form">
            <label className="tpl-field">
              <span>{t('template.save.source')}</span>
              <select value={saveFromId} onChange={(e) => pickSaveSource(e.target.value)}>
                <option value="">{t('template.selectProfile')}</option>
                {localProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="tpl-field">
              <span>{t('template.save.name')}</span>
              <input
                value={saveName}
                placeholder={t('template.save.namePlaceholder')}
                onChange={(e) => setSaveName(e.target.value)}
              />
            </label>
            <label className="tpl-field">
              <span>{t('template.save.desc')}</span>
              <input
                value={saveDesc}
                placeholder={t('template.save.descPlaceholder')}
                onChange={(e) => setSaveDesc(e.target.value)}
              />
            </label>
            <Button
              variant="primary"
              icon="plus"
              disabled={busy === 'save'}
              onClick={() => void saveTemplate()}
            >
              {busy === 'save' ? t('template.save.saving') : t('template.save.submit')}
            </Button>
          </div>
        </section>

        {/* ── 迁移包 ── */}
        <section className="tpl-sec">
          <div className="tpl-sec-head">
            <h3>{t('template.mig.title')}</h3>
            <span className="tpl-sec-hint">{t('template.mig.hint')}</span>
          </div>

          <div className="tpl-mig">
            <div className="tpl-col">
              <div className="tpl-col-head">
                <h4>{t('template.export.title')}</h4>
                <button
                  type="button"
                  className="tpl-link"
                  onClick={() =>
                    setExportIds(
                      exportIds.length === localProfiles.length
                        ? []
                        : localProfiles.map((p) => p.id)
                    )
                  }
                >
                  {exportIds.length === localProfiles.length && localProfiles.length > 0
                    ? t('template.export.clear')
                    : t('template.export.selectAll')}
                </button>
                <span className="tpl-col-meta">
                  {t('template.export.selected', { n: exportIds.length })}
                </span>
              </div>

              {localProfiles.length === 0 ? (
                <div className="tpl-empty tpl-empty-sm">{t('template.export.empty')}</div>
              ) : (
                <div className="tpl-pick scroll-thin">
                  {localProfiles.map((profile) => {
                    const on = exportIds.includes(profile.id)
                    return (
                      <label key={profile.id} className={cx('tpl-pick-row', on && 'on')}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleExport(profile.id)}
                        />
                        <span className="tpl-pick-name">{profile.name}</span>
                        <span className="tpl-pick-os">{OS_LABEL[profile.platform]}</span>
                      </label>
                    )
                  })}
                </div>
              )}

              {/* 口令不是可选项：包里的 seed / 指纹 / 代理 key 都用它派生的密钥封着，
                  没有口令就没有包。两次输入是为了防手误 —— 打错一个字符，
                  这个包就永远打不开了，而包里只有密文，没有任何找回途径。 */}
              <div className="tpl-form tpl-pass">
                <label className="tpl-field">
                  <span>{t('template.export.passLabel', { n: MIN_PASS })}</span>
                  <input
                    type="password"
                    value={exportPass}
                    autoComplete="new-password"
                    spellCheck={false}
                    placeholder={t('template.export.passPlaceholder')}
                    onChange={(e) => setExportPass(e.target.value)}
                  />
                </label>
                <label className="tpl-field">
                  <span>{t('template.export.passRepeat')}</span>
                  <input
                    type="password"
                    value={exportPass2}
                    autoComplete="new-password"
                    spellCheck={false}
                    placeholder={t('template.export.passRepeatPlaceholder')}
                    onChange={(e) => setExportPass2(e.target.value)}
                  />
                </label>
              </div>

              <div className="tpl-actions">
                <Button
                  variant="ghost"
                  icon="download"
                  disabled={busy === 'export' || exportIds.length === 0}
                  onClick={() => void exportSelected()}
                >
                  {busy === 'export'
                    ? t('template.export.exporting')
                    : t('template.export.button', { n: exportIds.length })}
                </Button>
                <span className="tpl-col-meta">
                  {t('template.export.fileName', { file: `shadowsurf-${dateStamp()}.json` })}
                </span>
              </div>
            </div>

            <div className="tpl-col">
              <div className="tpl-col-head">
                <h4>{t('template.import.title')}</h4>
                <span className="tpl-col-meta">{t('template.import.colHint')}</span>
              </div>

              <div className="tpl-form tpl-pass">
                <label className="tpl-field">
                  <span>{t('template.import.passLabel')}</span>
                  <input
                    type="password"
                    value={importPass}
                    autoComplete="current-password"
                    spellCheck={false}
                    placeholder={t('template.import.passPlaceholder')}
                    onChange={(e) => setImportPass(e.target.value)}
                  />
                </label>
              </div>

              <textarea
                className="tpl-json"
                value={importText}
                spellCheck={false}
                placeholder={t('template.import.jsonPlaceholder')}
                onChange={(e) => {
                  setImportText(e.target.value)
                  setImportPreview(null)
                }}
              />

              {importPreview !== null ? (
                <div className="tpl-preview" role="status">
                  <b>{t('template.preview.title')}</b>
                  <span>{t('template.preview.version', { n: importPreview.version })}</span>
                  <span>{t('template.preview.entries', { n: importPreview.entries })}</span>
                  <span>{t('template.preview.proxies', { n: importPreview.proxies })}</span>
                  {importPreview.version === 1 ? (
                    <em>{t('template.preview.legacy')}</em>
                  ) : null}
                </div>
              ) : null}

              <div className="tpl-actions">
                <Button
                  variant="ghost"
                  icon="eye"
                  disabled={busy === 'import'}
                  onClick={previewImport}
                >
                  {t('template.preview.button')}
                </Button>
                <Button
                  variant="primary"
                  icon="swap"
                  disabled={busy === 'import'}
                  onClick={() => void runImport(importText)}
                >
                  {busy === 'import'
                    ? t('template.import.importing')
                    : t('template.import.submit')}
                </Button>
                <label className="tpl-file">
                  <input type="file" accept=".json,application/json" onChange={onPickFile} />
                  <Icon name="folder" size={12} />
                  {t('template.import.chooseFile')}
                </label>
                {importText ? (
                  <button type="button" className="tpl-link" onClick={() => setImportText('')}>
                    {t('template.export.clear')}
                  </button>
                ) : null}
              </div>

              {/* 「导进来了」与「身份对了」是两件事。这里只显示后者 ——
                  profiles 计数已经在 Toast 里说过，再列一遍只是噪音。 */}
              {adopted !== null && adopted.length > 0 ? (
                <div className="tpl-adopt">
                  {adopted.map((a) => (
                    <div key={a.name} className={cx('tpl-adopt-row', a.ok ? 'ok' : 'bad')}>
                      <Icon name={a.ok ? 'check' : 'alert'} size={12} />
                      <span className="tpl-adopt-name">{a.name}</span>
                      <span className="tpl-adopt-verdict">
                        {a.ok
                          ? t('template.adopt.ok', { n: a.compared.length })
                          : t('template.adopt.bad', {
                              fields:
                                a.compared
                                  .filter((c) => c.from !== c.to)
                                  .map((c) => c.field)
                                  .join(t('template.adopt.separator')) ||
                                t('template.adopt.unknownField')
                            })}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </section>
      </div>

      <Modal
        open={pendingDelete !== null}
        title={t('template.delete.title')}
        icon="trash"
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              icon="trash"
              disabled={busy === `remove:${pendingDelete?.id ?? ''}`}
              onClick={() => void confirmDelete()}
            >
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <p>{t('template.delete.confirm', { name: pendingDelete?.name ?? '' })}</p>
      </Modal>

      {/* v1 包缺身份的确认框。
          措辞刻意不用「警告」而用事实陈述：用户需要理解的是「搬过来的不是同一台设备」，
          而不是被吓一跳。列出具体字段，是因为「身份」这个词太抽象，
          而「canvas / webgl / audio 会变」是可核对的具体后果。 */}
      <Modal
        open={legacyLoss !== null}
        title={t('template.legacy.title')}
        icon="alert"
        onClose={() => setLegacyLoss(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setLegacyLoss(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              icon="swap"
              disabled={busy === 'import'}
              onClick={() => {
                if (legacyLoss === null) return
                const { json } = legacyLoss
                setLegacyLoss(null)
                void runImport(json, true)
              }}
            >
              {t('template.legacy.importAnyway')}
            </Button>
          </>
        }
      >
        <p>{t('template.legacy.body')}</p>
        <p className="tpl-loss-fields">
          {t('template.legacy.fields')}
          {legacyLoss?.lostFields.map((f) => (
            <code key={f}>{f}</code>
          ))}
        </p>
        <p className="tpl-loss-note">{t('template.legacy.note')}</p>
      </Modal>
    </div>
  )
}
