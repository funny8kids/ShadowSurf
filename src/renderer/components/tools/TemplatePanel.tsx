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

import { useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { FingerprintTemplate, OSKind, Profile } from '@shared/types'
import { Button, Icon, Modal, cx, useToast } from '@renderer/components/ui'
import { bridge, errorMessage, hasBridge } from '@renderer/lib/api'
import './template.css'

export interface PanelProps {
  profiles: Profile[]
}

const OS_LABEL: Record<OSKind, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux'
}

/** 卡片摘要：只挑「一眼能看出两台机器像不像」的四个参数 */
function summarize(template: FingerprintTemplate): Array<{ k: string; v: string }> {
  const fp = template.fingerprint
  const chrome = /Chrome\/(\d+)/.exec(fp.userAgent)
  return [
    { k: 'Chrome', v: chrome ? chrome[1] : fp.uaVersion.split('.')[0] },
    { k: '时区', v: fp.timezone },
    { k: '分辨率', v: `${fp.screen.width}×${fp.screen.height}` },
    { k: 'CPU', v: `${fp.hardware.cpuCores} 核 / ${fp.hardware.memoryGB}G` }
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

  const [templates, setTemplates] = useState<FingerprintTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

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

  useEffect(() => {
    setLocalProfiles(profiles)
  }, [profiles])

  useEffect(() => {
    let alive = true
    if (!hasBridge()) {
      setLoading(false)
      return
    }
    void (async () => {
      try {
        const list = await bridge().templates.list()
        if (alive) setTemplates(list)
      } catch (err) {
        if (alive) toast.push(errorMessage(err), 'err')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [toast])

  const sorted = useMemo(
    () =>
      [...templates].sort((a, b) => {
        // 内置模板永远排前面：它们是「基准」，自定义模板是自己的实验记录
        if (a.builtin !== b.builtin) return a.builtin ? -1 : 1
        return b.createdAt - a.createdAt
      }),
    [templates]
  )

  const customCount = templates.filter((t) => !t.builtin).length

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
      toast.push('请先选择要应用到的环境', 'info')
      return
    }
    const targetName = localProfiles.find((p) => p.id === targetId)?.name ?? targetId
    setBusy(`apply:${template.id}`)
    try {
      await bridge().templates.apply(template.id, targetId)
      await refreshProfiles()
      toast.push(`已把「${template.name}」的指纹应用到「${targetName}」`, 'ok')
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
      setTemplates((prev) => prev.filter((t) => t.id !== target.id))
      toast.push(`已删除模板「${target.name}」`, 'ok')
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
      toast.push('请先选择来源环境', 'info')
      return
    }
    if (!name) {
      toast.push('请填写模板名称', 'info')
      return
    }
    setBusy('save')
    try {
      const created = await bridge().templates.save(
        saveFromId,
        name,
        saveDesc.trim() || undefined
      )
      setTemplates((prev) => [...prev, created])
      setSaveName('')
      setSaveDesc('')
      toast.push(`已保存模板「${created.name}」`, 'ok')
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setBusy(null)
    }
  }

  async function exportSelected(): Promise<void> {
    if (exportIds.length === 0) {
      toast.push('请先勾选要导出的环境', 'info')
      return
    }
    setBusy('export')
    try {
      const json = await bridge().migration.export(exportIds)
      downloadJson(json, `shadowsurf-${dateStamp()}.json`)
      toast.push(`已导出 ${exportIds.length} 个环境（代理密码留空）`, 'ok')
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setBusy(null)
    }
  }

  async function runImport(text: string): Promise<void> {
    const payload = text.trim()
    if (!payload) {
      toast.push('请粘贴迁移包 JSON 或选择文件', 'info')
      return
    }
    setBusy('import')
    try {
      const result = await bridge().migration.import(payload)
      await refreshProfiles()
      setImportText('')
      toast.push(`导入完成：环境 ${result.profiles} 个，代理 ${result.proxies} 个`, 'ok')
    } catch (err) {
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
      if (profile) setSaveName(`${profile.name} 模板`)
    }
  }

  function toggleExport(id: string): void {
    setExportIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  return (
    <div className="tool-panel">
      <header className="tool-head">
        <div>
          <h2>指纹模板与迁移</h2>
          <p>
            把一套指纹参数存成模板反复使用，或打包成迁移包搬到另一台机器。
            应用模板等于克隆同一身份，需要新身份请回环境页重掷指纹。
          </p>
        </div>
        <div className="tpl-count">
          内置 {templates.length - customCount} · 自定义 {customCount}
        </div>
      </header>

      <div className="tool-body">
        {/* ── 模板库 ── */}
        <section className="tpl-sec">
          <div className="tpl-sec-head">
            <h3>模板库</h3>
            <span className="tpl-sec-hint">内置模板只读，自定义模板可随时删除</span>
          </div>

          {loading ? (
            <div className="tpl-empty">正在读取模板…</div>
          ) : sorted.length === 0 ? (
            <div className="tpl-empty">
              还没有任何模板。先在下方向「从环境保存为模板」里挑一个环境，
              它的 UA、时区、分辨率、字体清单会被整份存下来。
            </div>
          ) : (
            <div className="tpl-grid">
              {sorted.map((template) => {
                const target = targets[template.id] ?? ''
                const applying = busy === `apply:${template.id}`
                return (
                  <article className="tpl-card" key={template.id}>
                    <div className="tpl-card-top">
                      <span className="tpl-os">{OS_LABEL[template.os]}</span>
                      {template.builtin ? <span className="tpl-badge">内置</span> : null}
                    </div>

                    <h4 className="tpl-name">{template.name}</h4>
                    {template.description ? (
                      <p className="tpl-desc">{template.description}</p>
                    ) : null}

                    <div className="tpl-meta">
                      {summarize(template).map((item) => (
                        <div key={item.k}>
                          <span>{item.k}</span>
                          <b title={item.v}>{item.v}</b>
                        </div>
                      ))}
                    </div>

                    <div className="tpl-foot">
                      <select
                        className="tpl-select"
                        aria-label={`把 ${template.name} 应用到环境`}
                        value={target}
                        onChange={(e) =>
                          setTargets((prev) => ({ ...prev, [template.id]: e.target.value }))
                        }
                      >
                        <option value="">选择环境…</option>
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
                        {applying ? '应用中' : '应用'}
                      </Button>
                      <button
                        type="button"
                        className="tpl-del"
                        title={template.builtin ? '内置模板不可删除' : '删除模板'}
                        aria-label={`删除模板 ${template.name}`}
                        disabled={template.builtin || busy === `remove:${template.id}`}
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
            <h3>从环境保存为模板</h3>
            <span className="tpl-sec-hint">存的是当前指纹快照，之后改环境不会影响模板</span>
          </div>
          <div className="tpl-form">
            <label className="tpl-field">
              <span>来源环境</span>
              <select value={saveFromId} onChange={(e) => pickSaveSource(e.target.value)}>
                <option value="">选择环境…</option>
                {localProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="tpl-field">
              <span>模板名称</span>
              <input
                value={saveName}
                placeholder="例：美国站 · 常用配置"
                onChange={(e) => setSaveName(e.target.value)}
              />
            </label>
            <label className="tpl-field">
              <span>描述（可选）</span>
              <input
                value={saveDesc}
                placeholder="备注这套参数适合什么场景"
                onChange={(e) => setSaveDesc(e.target.value)}
              />
            </label>
            <Button
              variant="primary"
              icon="plus"
              disabled={busy === 'save'}
              onClick={() => void saveTemplate()}
            >
              {busy === 'save' ? '保存中' : '保存为模板'}
            </Button>
          </div>
        </section>

        {/* ── 迁移包 ── */}
        <section className="tpl-sec">
          <div className="tpl-sec-head">
            <h3>迁移包</h3>
            <span className="tpl-sec-hint">
              只带走名称、平台、备注与指纹；代理密码留空，导入后需自行补齐
            </span>
          </div>

          <div className="tpl-mig">
            <div className="tpl-col">
              <div className="tpl-col-head">
                <h4>导出</h4>
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
                    ? '清空'
                    : '全选'}
                </button>
                <span className="tpl-col-meta">已选 {exportIds.length}</span>
              </div>

              {localProfiles.length === 0 ? (
                <div className="tpl-empty tpl-empty-sm">
                  还没有环境可导出。先到环境页新建一个，或在右侧直接导入别人的迁移包。
                </div>
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

              <div className="tpl-actions">
                <Button
                  variant="ghost"
                  icon="download"
                  disabled={busy === 'export' || exportIds.length === 0}
                  onClick={() => void exportSelected()}
                >
                  {busy === 'export' ? '导出中' : `导出 ${exportIds.length} 个环境`}
                </Button>
                <span className="tpl-col-meta">文件名 shadowsurf-{dateStamp()}.json</span>
              </div>
            </div>

            <div className="tpl-col">
              <div className="tpl-col-head">
                <h4>导入</h4>
                <span className="tpl-col-meta">版本 1 · 重名环境自动加「副本」后缀</span>
              </div>

              <textarea
                className="tpl-json"
                value={importText}
                spellCheck={false}
                placeholder={'把迁移包 JSON 粘贴到这里，或选择文件…'}
                onChange={(e) => setImportText(e.target.value)}
              />

              <div className="tpl-actions">
                <Button
                  variant="primary"
                  icon="swap"
                  disabled={busy === 'import'}
                  onClick={() => void runImport(importText)}
                >
                  {busy === 'import' ? '导入中' : '导入'}
                </Button>
                <label className="tpl-file">
                  <input type="file" accept=".json,application/json" onChange={onPickFile} />
                  <Icon name="folder" size={12} />
                  选择 JSON 文件
                </label>
                {importText ? (
                  <button type="button" className="tpl-link" onClick={() => setImportText('')}>
                    清空
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </section>
      </div>

      <Modal
        open={pendingDelete !== null}
        title="删除模板"
        icon="trash"
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              icon="trash"
              disabled={busy === `remove:${pendingDelete?.id ?? ''}`}
              onClick={() => void confirmDelete()}
            >
              删除
            </Button>
          </>
        }
      >
        <p>
          确定删除模板「{pendingDelete?.name ?? ''}」？已经应用到环境的指纹不会回滚，
          只是这份快照以后不能再用了。
        </p>
      </Modal>
    </div>
  )
}
