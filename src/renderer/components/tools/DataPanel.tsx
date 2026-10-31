/**
 * 浏览数据面板。
 *
 * 三个视图共用一个环境选择器：Cookie 与历史按环境隔离，下载是全局的
 * （下载监听挂在各环境的 session 上，但用户关心的是「我一共下了什么」）。
 *
 * 归属：data-agent
 * 样式写在同目录 data.css，类名统一 dp- 前缀，避免和其他工具面板的全局样式撞车。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CookieItem, DownloadItem, DownloadState, HistoryItem, Profile } from '@shared/types'
import { Button, Icon, Modal, cx, useToast } from '@renderer/components/ui'
import { bridge, errorMessage, hasBridge } from '@renderer/lib/api'
import { formatBytes, formatDate, formatRelative, profileNo } from '@renderer/lib/format'
import './data.css'

export interface PanelProps {
  profiles: Profile[]
}

type Tab = 'cookies' | 'downloads' | 'history'

const TAB_LABEL: Record<Tab, string> = {
  cookies: 'Cookie',
  downloads: '下载',
  history: '历史'
}

const DOWNLOAD_STATE: Record<DownloadState, { label: string; tone: string }> = {
  progressing: { label: '下载中', tone: 'run' },
  completed: { label: '已完成', tone: 'ok' },
  cancelled: { label: '已取消', tone: 'idle' },
  interrupted: { label: '已中断', tone: 'bad' }
}

export function DataPanel({ profiles }: PanelProps) {
  const toast = useToast()

  const [tab, setTab] = useState<Tab>('cookies')
  const [profileId, setProfileId] = useState('')
  const [cookies, setCookies] = useState<CookieItem[]>([])
  const [downloads, setDownloads] = useState<DownloadItem[]>([])
  const [history, setHistory] = useState<HistoryItem[]>([])
  /** 正在读取的是哪个视图；用它而不是布尔值，避免后台预取下载时把 Cookie 页显示成「读取中」 */
  const [loading, setLoading] = useState<Tab | null>(null)
  /** 展开明文的 Cookie，键是 domain+path+name —— 同名不同 path 的 Cookie 必须能区分 */
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [confirming, setConfirming] = useState<Tab | null>(null)

  // 切换环境时请求会乱序返回，用序号把过期响应丢掉，否则会看到上一个环境的 Cookie
  const cookieSeq = useRef(0)
  const historySeq = useRef(0)

  /* ── 环境选择：环境被删掉后自动落到第一个可用环境 ── */
  useEffect(() => {
    if (profiles.length === 0) {
      if (profileId !== '') setProfileId('')
      return
    }
    if (!profiles.some((p) => p.id === profileId)) setProfileId(profiles[0].id)
  }, [profiles, profileId])

  useEffect(() => {
    setRevealed({})
  }, [profileId])

  /* ── 读取 ── */

  const loadCookies = useCallback(
    async (id: string): Promise<void> => {
      const seq = ++cookieSeq.current
      if (!id || !hasBridge()) {
        setCookies([])
        return
      }
      setLoading('cookies')
      try {
        const list = await bridge().data.cookies(id)
        if (seq === cookieSeq.current) setCookies(list)
      } catch (err) {
        if (seq === cookieSeq.current) toast.push(errorMessage(err), 'err')
      } finally {
        if (seq === cookieSeq.current) setLoading(null)
      }
    },
    [toast]
  )

  const loadHistory = useCallback(
    async (id: string): Promise<void> => {
      const seq = ++historySeq.current
      if (!id || !hasBridge()) {
        setHistory([])
        return
      }
      setLoading('history')
      try {
        const list = await bridge().data.history(id)
        if (seq === historySeq.current) setHistory(list)
      } catch (err) {
        if (seq === historySeq.current) toast.push(errorMessage(err), 'err')
      } finally {
        if (seq === historySeq.current) setLoading(null)
      }
    },
    [toast]
  )

  const loadDownloads = useCallback(async (): Promise<void> => {
    if (!hasBridge()) {
      setDownloads([])
      return
    }
    setLoading('downloads')
    try {
      setDownloads(await bridge().data.downloads())
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setLoading(null)
    }
  }, [toast])

  /* ── 切 tab / 切环境时拉数据 ── */
  useEffect(() => {
    if (tab === 'cookies') void loadCookies(profileId)
    else if (tab === 'history') void loadHistory(profileId)
    else void loadDownloads()
  }, [tab, profileId, loadCookies, loadHistory, loadDownloads])

  /* 下载是全局数据，进面板就先读一次，否则标签上的条数会一直是 0 */
  useEffect(() => {
    void loadDownloads()
  }, [loadDownloads])

  /* ── 下载进度推送：按 id 原地替换，未见过的新记录插到最前 ── */
  useEffect(() => {
    if (!hasBridge()) return
    const off = bridge().data.onDownload((item) => {
      setDownloads((prev) => {
        const index = prev.findIndex((d) => d.id === item.id)
        if (index < 0) return [item, ...prev]
        const next = prev.slice()
        next[index] = item
        return next
      })
    })
    return off
  }, [])

  /* ── 清空 ── */

  const doClear = useCallback(async (): Promise<void> => {
    const which = confirming
    setConfirming(null)
    if (!which || !hasBridge()) return
    try {
      if (which === 'cookies') {
        const removed = await bridge().data.clearCookies(profileId)
        setCookies([])
        toast.push(
          removed > 0 ? `已清空 ${removed} 条 Cookie` : '该环境没有可清理的 Cookie',
          removed > 0 ? 'ok' : 'info'
        )
      } else if (which === 'downloads') {
        await bridge().data.clearDownloads()
        setDownloads([])
        toast.push('已清空下载记录', 'ok')
      } else {
        await bridge().data.clearHistory(profileId)
        setHistory([])
        toast.push('已清空该环境的历史记录', 'ok')
      }
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    }
  }, [confirming, profileId, toast])

  /* ── 派生 ── */

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === profileId) ?? null,
    [profiles, profileId]
  )

  const counts: Record<Tab, number> = {
    cookies: cookies.length,
    downloads: downloads.length,
    history: history.length
  }

  const needProfile = tab !== 'downloads'
  const noProfile = needProfile && profiles.length === 0
  const currentEmpty = tab === 'cookies' ? cookies.length === 0 : tab === 'downloads' ? downloads.length === 0 : history.length === 0

  const clearLabel =
    tab === 'cookies' ? '清空该环境 Cookie' : tab === 'downloads' ? '清空下载记录' : '清空该环境历史'

  return (
    <div className="dp">
      <header className="dp-head">
        <div>
          <h2>浏览数据</h2>
          <p>Cookie 与历史按环境独立存放，下载记录为全局视图，清空只影响当前所选环境。</p>
        </div>
        <div className="dp-head-side">
          <span className="dp-scope">
            {tab === 'downloads' ? '全局' : activeProfile ? activeProfile.name : '未选择环境'}
          </span>
          {tab === 'downloads' ? null : (
            <label className={cx('dp-select', profiles.length === 0 && 'off')}>
              <Icon name="grid" size={12} />
              <select
                value={profileId}
                disabled={profiles.length === 0}
                onChange={(e) => setProfileId(e.target.value)}
                aria-label="选择环境"
              >
                {profiles.length === 0 ? <option value="">暂无环境</option> : null}
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {profileNo(p.id)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </header>

      <div className="dp-tabs" role="tablist" aria-label="浏览数据类型">
        {(Object.keys(TAB_LABEL) as Tab[]).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={cx('dp-tab', tab === key && 'on')}
            onClick={() => setTab(key)}
          >
            {TAB_LABEL[key]}
            <span className="n">{counts[key]}</span>
          </button>
        ))}
        <span className="dp-tabs-spacer" />
        <Button
          size="sm"
          variant="quiet"
          icon="reload"
          onClick={() => {
            if (tab === 'cookies') void loadCookies(profileId)
            else if (tab === 'history') void loadHistory(profileId)
            else void loadDownloads()
          }}
          disabled={needProfile && !profileId}
        >
          刷新
        </Button>
        <Button
          size="sm"
          variant="danger"
          icon="trash"
          onClick={() => setConfirming(tab)}
          disabled={noProfile || (needProfile && !profileId) || currentEmpty}
        >
          {clearLabel}
        </Button>
      </div>

      <div className="dp-body scroll-thin">
        {noProfile ? (
          <EmptyState
            icon="grid"
            title="还没有可用的环境"
            desc="Cookie 与历史跟着环境走。先在环境页创建一个身份，再回来查看它留下的痕迹。"
          />
        ) : loading === tab && currentEmpty ? (
          <div className="dp-loading">正在读取{tab === 'downloads' ? '下载记录' : tab === 'cookies' ? ' Cookie' : '历史'}…</div>
        ) : currentEmpty ? (
          tab === 'cookies' ? (
            <EmptyState
              icon="shield"
              title="这个环境还没有 Cookie"
              desc="用该环境打开任意站点登录一次，Cookie 会写进它自己的存储分区，其他环境看不到。"
            />
          ) : tab === 'downloads' ? (
            <EmptyState
              icon="download"
              title="还没有下载记录"
              desc="在任意环境里下载文件，进度会实时出现在这里；记录只保留在本次运行期间。"
            />
          ) : (
            <EmptyState
              icon="list"
              title="这个环境还没有历史记录"
              desc="环境内的整页跳转会写进这里，站内单页路由（pushState）不计入。"
            />
          )
        ) : tab === 'cookies' ? (
          <div className="dp-table">
            <div className="dp-tr dp-th">
              <span>域名</span>
              <span>名称</span>
              <span>值</span>
              <span>属性</span>
              <span>过期</span>
            </div>
            {cookies.map((c) => {
              const key = `${c.domain}${c.path}${c.name}`
              const shown = revealed[key] === true
              return (
                <div className="dp-tr" key={key}>
                  <span className="dp-domain" title={`${c.domain}${c.path}`}>
                    {c.domain}
                    <i className="dp-path">{c.path}</i>
                  </span>
                  <span className="dp-name" title={c.name}>
                    {c.name}
                  </span>
                  <button
                    type="button"
                    className={cx('dp-val', shown && 'on')}
                    title={shown ? '点击隐藏' : '点击显示明文'}
                    onClick={() => setRevealed((prev) => ({ ...prev, [key]: !shown }))}
                  >
                    <span className="dp-val-txt">{shown ? c.value || '(空)' : '••••••••'}</span>
                    <Icon name={shown ? 'eyeOff' : 'eye'} size={11} />
                  </button>
                  <span className="dp-flags">
                    {c.secure ? <i className="dp-flag sec">Secure</i> : null}
                    {c.httpOnly ? <i className="dp-flag http">HttpOnly</i> : null}
                    {c.session ? <i className="dp-flag sess">会话</i> : null}
                    {!c.secure && !c.httpOnly && !c.session ? <i className="dp-flag none">—</i> : null}
                  </span>
                  <span className="dp-exp">
                    {c.session || !c.expires ? '会话结束' : formatDate(c.expires)}
                  </span>
                </div>
              )
            })}
          </div>
        ) : tab === 'downloads' ? (
          <div className="dp-list">
            {downloads.map((d) => {
              const meta = DOWNLOAD_STATE[d.state] ?? DOWNLOAD_STATE.progressing
              const pct =
                d.state === 'completed'
                  ? 100
                  : d.total > 0
                    ? Math.min(100, Math.round((d.received / d.total) * 100))
                    : 0
              const env = profiles.find((p) => p.id === d.profileId)
              return (
                <div className="dp-dl" key={d.id}>
                  <div className="dp-dl-main">
                    <div className="dp-dl-r1">
                      <span className="dp-dl-name" title={d.savePath || d.filename}>
                        {d.filename || '未命名文件'}
                      </span>
                      <span className={cx('dp-state', meta.tone)}>{meta.label}</span>
                      <span className="dp-dl-time">{formatRelative(d.startedAt)}</span>
                    </div>
                    <div className="dp-dl-url" title={d.url}>
                      {d.url}
                    </div>
                    <div className="dp-dl-prog">
                      <div className={cx('dp-bar', d.state)}>
                        <i style={{ width: `${pct}%` }} />
                      </div>
                      <span className="dp-dl-bytes">
                        {formatBytes(d.received)}
                        {d.total > 0 ? ` / ${formatBytes(d.total)}` : ''}
                      </span>
                    </div>
                  </div>
                  <span className="dp-dl-env" title={d.profileId}>
                    {env?.name ?? profileNo(d.profileId)}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="dp-list">
            {history.map((h) => (
              <div className="dp-hi" key={h.id}>
                <span className="dp-hi-dot" />
                <div className="dp-hi-main">
                  <div className="dp-hi-title" title={h.title || h.url}>
                    {h.title || h.url}
                  </div>
                  <div className="dp-hi-url" title={h.url}>
                    {h.url}
                  </div>
                </div>
                <span className="dp-hi-time">{formatRelative(h.at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal
        open={confirming !== null}
        title={confirming === 'cookies' ? '清空该环境的 Cookie' : confirming === 'downloads' ? '清空下载记录' : '清空该环境的历史记录'}
        icon="trash"
        tone="danger"
        onClose={() => setConfirming(null)}
        note={
          confirming === 'cookies'
            ? '清空后该环境的所有站点都会回到未登录状态，其他环境不受影响。'
            : confirming === 'downloads'
              ? '只清空这份列表，正在进行中的下载不会被取消。'
              : '只删除该环境的浏览记录，其他环境的历史保持原样。'
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              取消
            </Button>
            <Button variant="danger" icon="trash" onClick={() => void doClear()}>
              确认清空
            </Button>
          </>
        }
      >
        <p>
          {confirming === 'downloads'
            ? `将清空 ${downloads.length} 条下载记录。`
            : confirming === 'cookies'
              ? `将清空环境「${activeProfile?.name ?? '未选择'}」的 ${cookies.length} 条 Cookie。`
              : `将删除环境「${activeProfile?.name ?? '未选择'}」的 ${history.length} 条历史记录。`}
        </p>
      </Modal>
    </div>
  )
}

function EmptyState({
  icon,
  title,
  desc
}: {
  icon: 'grid' | 'shield' | 'download' | 'list'
  title: string
  desc: string
}) {
  return (
    <div className="dp-empty">
      <div className="mark">
        <Icon name={icon} size={18} strokeWidth={2} />
      </div>
      <h3>{title}</h3>
      <p>{desc}</p>
    </div>
  )
}
