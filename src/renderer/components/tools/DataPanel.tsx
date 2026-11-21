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
import type {
  BackupFile,
  CookieItem,
  DownloadItem,
  DownloadState,
  HistoryItem,
  Profile,
  WarmupReport
} from '@shared/types'
import { Button, Field, Icon, Modal, cx, useToast } from '@renderer/components/ui'
import { bridge, errorMessage, hasBridge } from '@renderer/lib/api'
import type { CookieExportFormat, CookieImportSummary } from '@shared/ipc'
import { formatBytes, formatDate, formatRelative, profileNo } from '@renderer/lib/format'
import { useI18n } from '@renderer/lib/i18n'
import './data.css'

export interface PanelProps {
  profiles: Profile[]
}

type Tab = 'cookies' | 'downloads' | 'history'

type Translate = (key: string, vars?: Record<string, string | number>) => string

const TAB_LABEL: Record<Tab, string> = {
  cookies: 'data.tab.cookies',
  downloads: 'data.tab.downloads',
  history: 'data.tab.history'
}

const DOWNLOAD_STATE: Record<DownloadState, { labelKey: string; tone: string }> = {
  progressing: { labelKey: 'data.download.state.progressing', tone: 'run' },
  completed: { labelKey: 'data.download.state.completed', tone: 'ok' },
  cancelled: { labelKey: 'data.download.state.cancelled', tone: 'idle' },
  interrupted: { labelKey: 'data.download.state.interrupted', tone: 'bad' }
}

/**
 * 列表首批渲染多少条 / 每次「加载更多」加多少条。
 *
 * 为什么不分页会卡：Cookie 没有上限、历史 2000 条、活动 2000 条，每行又是
 * 5~10 个 DOM 节点（域名、路径、明文值、Secure/HttpOnly 徽标、过期时间…）。
 * 几千行一次铺开就是上万个节点，React 的 diff、浏览器的布局与样式重算、
 * 滚动重绘会一起变慢 —— 打开面板那一下尤其明显。
 *
 * 注意这里**只控制渲染量**：数据仍然一次取全（IPC 不变），
 * 只是先把前 100 行画出来，剩下的等用户点「加载更多」。
 */
const PAGE_SIZE = 100
const PAGE_STEP = 200

/**
 * 每个标签页各自的读取状态。
 *
 * DESIGN.md #1「不可判读状态」：空 / 错 / 加载必须三态可分。
 * 旧实现里三个列表读失败都只发一个会消失的 toast，然后保持 []，
 * 于是「读不到」和「确实没有」画成同一张空状态——用户会以为这个环境真的没数据。
 * 这里按 Tab 分别记状态，三个视图互不串扰（后台预取下载不会把 Cookie 页改成「读取中」）。
 */
type TabReadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' }

const INITIAL_READ_STATE: Record<Tab, TabReadState> = {
  cookies: { kind: 'idle' },
  downloads: { kind: 'idle' },
  history: { kind: 'idle' }
}

/**
 * 去掉 Electron 套在 IPC 失败外的通道名前缀。
 *
 * 原始消息长这样：`Error invoking remote method 'ss:data:cookies': Error: EACCES: ...`
 * 前半截是通道名，用户不需要知道，而且会把真正的原因挤到屏幕外。
 * DESIGN.md 要求读失败必须「带错误原因原文」，所以这里只剥壳、不改写原因本身。
 */
function cleanIpcMessage(raw: string): string {
  const m = /Error invoking remote method '[^']*':\s*(?:Error:\s*)?([\s\S]*)$/.exec(raw)
  return (m?.[1] ?? raw).trim()
}

/**
 * 「一条都没解析出来」的判定。
 *
 * 全坏输入（或整份无法解析）时 `imported` 与 `failed` 都是 0，但 `errors` 非空。
 * 这时如果只看 `failed > 0`，文案会落到「全部成功」那一支，显示绿色的
 * 「已导入 0 条，全部成功」—— 与事实相反。所以这一支必须单独判、且不能用 ok 色。
 */
function importNoCookies(s: CookieImportSummary): boolean {
  return s.imported === 0 && s.failed === 0 && s.errors.length > 0
}

/** 导入结果的三分支文案（弹层内联展示用） */
function importSummaryText(s: CookieImportSummary, t: Translate): string {
  if (importNoCookies(s)) return t('data.import.summary.noCookies', { n: s.errors.length })
  if (s.failed > 0) {
    return t('data.import.summary.failed', { imported: s.imported, failed: s.failed })
  }
  return t('data.import.summary.ok', { n: s.imported })
}

export function DataPanel({ profiles }: PanelProps) {
  const toast = useToast()
  const { t } = useI18n()

  const [tab, setTab] = useState<Tab>('cookies')
  const [profileId, setProfileId] = useState('')
  const [cookies, setCookies] = useState<CookieItem[]>([])
  const [downloads, setDownloads] = useState<DownloadItem[]>([])
  const [history, setHistory] = useState<HistoryItem[]>([])
  /** 正在读取的是哪个视图；旧字段，保留给可能依赖它的代码，渲染一律改看 readState */
  const [loading, setLoading] = useState<Tab | null>(null)
  /** 每个标签页独立的读取状态：空 / 错 / 加载三态分列，读失败走内联琥珀而不是 toast */
  const [readState, setReadState] = useState<Record<Tab, TabReadState>>(INITIAL_READ_STATE)
  /** 展开明文的 Cookie，键是 domain+path+name —— 同名不同 path 的 Cookie 必须能区分 */
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [confirming, setConfirming] = useState<Tab | null>(null)
  /** 导入弹窗：text 是用户粘贴的原文，summary 是上一次导入的结果（含失败明细） */
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importSummary, setImportSummary] = useState<CookieImportSummary | null>(null)
  const [importing, setImporting] = useState(false)
  /**
   * Cookie 预热弹窗。
   *
   * `text` 是用户粘贴的 URL 列表，`report` 是上一次运行结果。刻意把 report 留在
   * 弹窗里而不是只发 toast：失败明细（非法协议、加载超时、被截断的条数）是
   * 用户下一次修改输入的依据，toast 会消失，弹窗不会。
   */
  const [warmupOpen, setWarmupOpen] = useState(false)
  const [warmupText, setWarmupText] = useState('')
  const [warmupReport, setWarmupReport] = useState<WarmupReport | null>(null)
  const [warmupRunning, setWarmupRunning] = useState(false)
  /**
   * 同步的运行锁。
   *
   * `warmupRunning` 是状态，要等下一次渲染才生效；两下极快的点击可能在同一次
   * 提交前都读到 false，于是发出两个 run。预热本身要求串行，这里用 ref 在
   * 事件处理里立刻占住，第二次点击直接返回。
   */
  const warmupBusy = useRef(false)

  /**
   * 整机备份 / 还原。
   *
   * 放在这个面板里而不是「设置」里，是因为它操作的就是**数据**，
   * 而这里是唯一一块讲数据的界面 —— 用户找数据相关操作时只会来这里。
   *
   * 还原是不可逆的（当前数据目录会被整体换掉），所以必须走二次确认，
   * 而且确认文案里要写清楚三件事：会关掉所有环境、旧数据保留在哪、不能反悔。
   */
  const [backups, setBackups] = useState<BackupFile[]>([])
  const [backingUp, setBackingUp] = useState(false)
  /** 正在等待确认还原的备份；null = 没有待确认的还原 */
  const [restoreTarget, setRestoreTarget] = useState<BackupFile | null>(null)
  const [restoring, setRestoring] = useState(false)
  /**
   * 备份/还原的同步锁。
   *
   * 还原会把数据目录整个换掉 —— 两下极快的点击会让第二次还原在第一次
   * 刚换完目录的瞬间开始，跑在一个已经被换掉的目录上。
   * 状态要等下一次渲染才生效，所以用 ref 在事件处理里立刻占住。
   */
  const backupBusy = useRef(false)

  const loadBackups = useCallback(async (): Promise<void> => {
    if (!hasBridge()) return
    try {
      setBackups(await bridge().data.backupList())
    } catch (err) {
      // 读不到备份列表不等于「没有备份」：界面必须说"读失败"，
      // 而不是画一个空的备份列表让人以为从没备份过。
      toast.push(errorMessage(err), 'err')
    }
  }, [toast])

  useEffect(() => {
    void loadBackups()
  }, [loadBackups])

  const doBackup = useCallback(async (): Promise<void> => {
    if (backupBusy.current || !hasBridge()) return
    backupBusy.current = true
    setBackingUp(true)
    try {
      const { path } = await bridge().data.backup()
      await loadBackups()
      toast.push(t('ws.backup.done', { path }), 'ok')
    } catch (err) {
      toast.push(t('ws.backup.failed', { reason: errorMessage(err) }), 'err')
    } finally {
      backupBusy.current = false
      setBackingUp(false)
    }
  }, [backups.length, loadBackups, t, toast])

  const doRestore = useCallback(async (): Promise<void> => {
    const target = restoreTarget
    setRestoreTarget(null)
    if (!target || backupBusy.current || !hasBridge()) return
    backupBusy.current = true
    setRestoring(true)
    try {
      const result = await bridge().data.restore(target.path)
      toast.push(
        t('ws.backup.restored', { n: result.fileCount, path: result.keeperPath }),
        'ok'
      )
      await loadBackups()
      // 整个工作区被换掉了：环境列表、设置、团队、脚本、代理全都变了。
      // 渲染层手里那些是**旧工作区**的快照 —— 不重载的话，
      // 界面上会继续显示已经不存在的环境，用户点下去才发现。
      // 延迟一点再重载，是为了让 toast 先被看见。
      toast.push(t('ws.backup.reloading'), 'info')
      setTimeout(() => window.location.reload(), 1200)
    } catch (err) {
      toast.push(t('ws.backup.restoreFailed', { reason: errorMessage(err) }), 'err')
    } finally {
      backupBusy.current = false
      setRestoring(false)
    }
  }, [loadBackups, restoreTarget, t, toast])

  /**
   * 每个列表当前渲染多少条（见 PAGE_SIZE 的注释）。
   * 按 Tab 分开记：Cookie 翻到第 500 行再切到历史，不该把 Cookie 的进度也清掉。
   */
  const [visibleCount, setVisibleCount] = useState<Record<Tab, number>>({
    cookies: PAGE_SIZE,
    downloads: PAGE_SIZE,
    history: PAGE_SIZE
  })

  const showMore = useCallback((which: Tab): void => {
    setVisibleCount((prev) => ({ ...prev, [which]: prev[which] + PAGE_STEP }))
  }, [])

  /** 换环境 / 重新读取后列表内容变了，已展开的条数没有意义，回到首批 */
  const resetVisible = useCallback((which: Tab): void => {
    setVisibleCount((prev) => (prev[which] === PAGE_SIZE ? prev : { ...prev, [which]: PAGE_SIZE }))
  }, [])

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
    // 换环境 = 换了一整份列表，之前展开的行数不该带过去
    resetVisible('cookies')
    resetVisible('history')
  }, [profileId, resetVisible])

  /* ── 读取 ── */

  const loadCookies = useCallback(
    async (id: string): Promise<void> => {
      const seq = ++cookieSeq.current
      if (!id || !hasBridge()) {
        setCookies([])
        setReadState((prev) => ({ ...prev, cookies: { kind: 'ready' } }))
        return
      }
      setLoading('cookies')
      setReadState((prev) => ({ ...prev, cookies: { kind: 'loading' } }))
      try {
        const list = await bridge().data.cookies(id)
        if (seq === cookieSeq.current) {
          setCookies(list)
          // 数据换了一批，展开条数回到首批（否则上一次点过 5 次「加载更多」后，
          // 新环境一进来就先铺 1100 行）
          resetVisible('cookies')
          setReadState((prev) => ({ ...prev, cookies: { kind: 'ready' } }))
        }
      } catch (err) {
        // 读失败 ≠ 没有 Cookie：写带原因的 error，内联展示并给重试，不再发会消失的 toast。
        if (seq === cookieSeq.current) {
          setReadState((prev) => ({
            ...prev,
            cookies: { kind: 'error', message: cleanIpcMessage(errorMessage(err)) }
          }))
        }
      } finally {
        if (seq === cookieSeq.current) setLoading(null)
      }
    },
    [resetVisible]
  )

  const loadHistory = useCallback(
    async (id: string): Promise<void> => {
      const seq = ++historySeq.current
      if (!id || !hasBridge()) {
        setHistory([])
        setReadState((prev) => ({ ...prev, history: { kind: 'ready' } }))
        return
      }
      setLoading('history')
      setReadState((prev) => ({ ...prev, history: { kind: 'loading' } }))
      try {
        const list = await bridge().data.history(id)
        if (seq === historySeq.current) {
          setHistory(list)
          resetVisible('history')
          setReadState((prev) => ({ ...prev, history: { kind: 'ready' } }))
        }
      } catch (err) {
        // 读失败 ≠ 没有历史：写带原因的 error，内联展示并给重试。
        if (seq === historySeq.current) {
          setReadState((prev) => ({
            ...prev,
            history: { kind: 'error', message: cleanIpcMessage(errorMessage(err)) }
          }))
        }
      } finally {
        if (seq === historySeq.current) setLoading(null)
      }
    },
    [resetVisible]
  )

  const loadDownloads = useCallback(async (): Promise<void> => {
    if (!hasBridge()) {
      setDownloads([])
      setReadState((prev) => ({ ...prev, downloads: { kind: 'ready' } }))
      return
    }
    setLoading('downloads')
    setReadState((prev) => ({ ...prev, downloads: { kind: 'loading' } }))
    try {
      setDownloads(await bridge().data.downloads())
      // 重新读到的整份列表与展开条数无关，回到首批
      resetVisible('downloads')
      setReadState((prev) => ({ ...prev, downloads: { kind: 'ready' } }))
    } catch (err) {
      // 读失败 ≠ 没有下载：写带原因的 error，内联展示并给重试。
      setReadState((prev) => ({
        ...prev,
        downloads: { kind: 'error', message: cleanIpcMessage(errorMessage(err)) }
      }))
    } finally {
      setLoading(null)
    }
  }, [resetVisible])

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
          removed > 0
            ? t('data.toast.clearedCookies', { n: removed })
            : t('data.toast.noCookiesToClear'),
          removed > 0 ? 'ok' : 'info'
        )
      } else if (which === 'downloads') {
        await bridge().data.clearDownloads()
        setDownloads([])
        toast.push(t('data.toast.clearedDownloads'), 'ok')
      } else {
        await bridge().data.clearHistory(profileId)
        setHistory([])
        toast.push(t('data.toast.clearedHistory'), 'ok')
      }
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    }
  }, [confirming, profileId, toast, t])

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === profileId) ?? null,
    [profiles, profileId]
  )

  /* ── Cookie 导入 / 导出 ──
   *
   * 导出走浏览器 Blob + <a download>，不新增 IPC：主进程只负责吐出文件内容，
   * 落到磁盘这一步交给浏览器自己的下载机制，省一条「选保存路径」的通道。
   * 文件名带环境名与日期：同一天多次导出、多个环境之间都不会互相覆盖。
   */
  const doExportCookies = useCallback(
    async (format: CookieExportFormat): Promise<void> => {
      if (!profileId || !hasBridge()) return
      try {
        const content = await bridge().data.exportCookies(profileId, format)
        const ext = format === 'json' ? 'json' : 'txt'
        const mime = format === 'json' ? 'application/json' : 'text/plain;charset=utf-8'
        const stamp = formatDate(Date.now()).replace(/[\\/:*?"<>|\s]/g, '-')
        const name = (activeProfile?.name ?? profileNo(profileId)).replace(/[\\/:*?"<>|]/g, '-')
        const url = URL.createObjectURL(new Blob([content], { type: mime }))
        const a = document.createElement('a')
        a.href = url
        a.download = `cookies-${name}-${stamp}.${ext}`
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
        toast.push(t('data.toast.exported', { format: format === 'json' ? 'JSON' : 'Netscape' }), 'ok')
      } catch (err) {
        toast.push(errorMessage(err), 'err')
      }
    },
    [profileId, activeProfile, toast, t]
  )

  const openImport = useCallback((): void => {
    setImportText('')
    setImportSummary(null)
    setImportOpen(true)
  }, [])

  const doImportCookies = useCallback(async (): Promise<void> => {
    if (!profileId || !hasBridge()) return
    setImporting(true)
    try {
      const result = await bridge().data.importCookies(profileId, importText)
      setImportSummary(result)
      // 失败绝不能只留在详情里：toast 也要说清有多少条没进去。
      // 「一条都没进来」必须单独判：failed 为 0 但 errors 非空时（全坏/整份无法解析），
      // 落到下面「全部成功」那支会变成 ok 色，等于给全失败盖了绿灯。
      const noCookies = importNoCookies(result)
      toast.push(
        noCookies
          ? t('data.toast.importNoCookies', { n: result.errors.length })
          : result.failed > 0
            ? t('data.toast.importFailed', {
                imported: result.imported,
                failed: result.failed
              })
            : t('data.toast.imported', { imported: result.imported }),
        noCookies ? 'err' : result.failed > 0 ? 'info' : 'ok'
      )
      void loadCookies(profileId)
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setImporting(false)
    }
  }, [profileId, importText, loadCookies, toast, t])

  /* ── Cookie 预热 ──
   *
   * 预热是主进程里的后台行为：它按顺序访问 URL、随机停留，把 Cookie / Storage
   * 写进当前环境的分区。界面只做两件事 —— 收集 URL、把逐条失败原因留在弹窗里。
   */
  const openWarmup = useCallback((): void => {
    setWarmupText('')
    setWarmupReport(null)
    setWarmupOpen(true)
  }, [])

  const doWarmup = useCallback(async (): Promise<void> => {
    // 运行期间把环境 id 固定下来：这次预热从头到尾只属于开始时那个环境，
    // 即使背后的选择器在别处被改了也不跟着漂。
    const targetId = profileId
    if (!targetId || !hasBridge() || warmupBusy.current) return

    const urls = warmupText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')

    warmupBusy.current = true
    setWarmupRunning(true)
    setWarmupReport(null)
    try {
      const report = await bridge().warmup.run(targetId, urls)
      setWarmupReport(report)
      const allOk = report.okCount === report.total
      toast.push(
        t('data.warmup.done', { ok: report.okCount, total: report.total }),
        allOk ? 'ok' : report.okCount === 0 ? 'err' : 'info'
      )
      // 预热的目的就是让 Cookie 出现；不重读的话用户看到的还是运行前的列表。
      void loadCookies(targetId)
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      warmupBusy.current = false
      setWarmupRunning(false)
    }
  }, [profileId, warmupText, loadCookies, toast, t])

  /** 失败明细：非法协议、加载失败、超时、被截断的条数都在 steps 里，统一列出 */
  const warmupFailures = useMemo(
    () => (warmupReport ? warmupReport.steps.filter((step) => !step.ok) : []),
    [warmupReport]
  )

  /* ── 派生 ── */

  const counts: Record<Tab, number> = {
    cookies: cookies.length,
    downloads: downloads.length,
    history: history.length
  }

  const needProfile = tab !== 'downloads'
  const noProfile = needProfile && profiles.length === 0
  const currentEmpty = tab === 'cookies' ? cookies.length === 0 : tab === 'downloads' ? downloads.length === 0 : history.length === 0
  const activeRead = readState[tab]

  // 内联错误里的「重试」：只对当前标签页重新拉一次，不改其他页的状态。
  function retryActive(): void {
    if (tab === 'cookies') void loadCookies(profileId)
    else if (tab === 'history') void loadHistory(profileId)
    else void loadDownloads()
  }

  const clearLabel =
    tab === 'cookies'
      ? t('data.clear.cookies')
      : tab === 'downloads'
        ? t('data.clear.downloads')
        : t('data.clear.history')

  return (
    <div className="dp">
      <header className="dp-head">
        <div>
          <h2>{t('data.title')}</h2>
          <p>{t('data.subtitle')}</p>
        </div>
        <div className="dp-head-side">
          <span className="dp-scope">
            {tab === 'downloads'
              ? t('data.scope.global')
              : activeProfile
                ? t('data.scope.isolated')
                : t('data.scope.noProfile')}
          </span>
          {tab === 'downloads' ? null : (
            <label className={cx('dp-select', profiles.length === 0 && 'off')}>
              <Icon name="grid" size={12} />
              <select
                value={profileId}
                disabled={profiles.length === 0}
                onChange={(e) => setProfileId(e.target.value)}
                aria-label={t('data.selectProfile')}
              >
                {profiles.length === 0 ? <option value="">{t('data.noProfiles')}</option> : null}
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

      {/* 整机备份 / 还原：工作区级别（不按环境隔离），所以放在环境选择器这一层之外 */}
      <section className="dp-backup">
        <div className="dp-backup-main">
          <div className="dp-backup-text">
            <h3>{t('ws.backup.title')}</h3>
            <p>{t('ws.backup.desc')}</p>
          </div>
          <Button
            size="sm"
            variant="primary"
            icon="shield"
            onClick={() => void doBackup()}
            disabled={backingUp || restoring}
          >
            {backingUp ? t('ws.backup.creating') : t('ws.backup.create')}
          </Button>
        </div>
        {backups.length === 0 ? (
          <p className="dp-backup-empty">{t('ws.backup.empty')}</p>
        ) : (
          <ul className="dp-backup-list">
            {backups.slice(0, 5).map((b) => (
              <li key={b.path}>
                <span className="dp-backup-name" title={b.path}>
                  {t('ws.backup.item', { name: b.name, size: formatBytes(b.size) })}
                </span>
                <span className="dp-backup-time">{formatDate(b.createdAt)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="swap"
                  onClick={() => setRestoreTarget(b)}
                  disabled={restoring || backingUp}
                >
                  {t('ws.backup.restore')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="dp-tabs" role="tablist" aria-label={t('data.tabsAria')}>
        {(Object.keys(TAB_LABEL) as Tab[]).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={cx('dp-tab', tab === key && 'on')}
            onClick={() => setTab(key)}
          >
            {t(TAB_LABEL[key])}
            <span className="n">{counts[key]}</span>
          </button>
        ))}
        <span className="dp-tabs-spacer" />
        {tab === 'cookies' ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              icon="download"
              onClick={() => void doExportCookies('netscape')}
              disabled={!profileId}
              title={t('data.export.netscapeTitle')}
            >
              {t('data.export.netscape')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon="download"
              onClick={() => void doExportCookies('json')}
              disabled={!profileId}
              title={t('data.export.jsonTitle')}
            >
              {t('data.export.json')}
            </Button>
            <Button
              size="sm"
              variant="quiet"
              icon="swap"
              onClick={openImport}
              disabled={!profileId}
              title={t('data.import.openTitle')}
            >
              {t('data.import.open')}
            </Button>
            <Button
              size="sm"
              variant="quiet"
              icon="spark"
              onClick={openWarmup}
              disabled={!profileId}
              title={profileId ? t('data.warmup.button') : t('data.warmup.noProfile')}
            >
              {t('data.warmup.button')}
            </Button>
          </>
        ) : null}
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
          {t('common.refresh')}
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

      {tab === 'cookies' ? (
        <p>
          {t('data.note.cookies', {
            name: activeProfile?.name ?? t('data.scope.noProfileShort')
          })}
        </p>
      ) : null}

      <div className="dp-body scroll-thin">
        {noProfile ? (
          <EmptyState
            icon="grid"
            title={t('data.empty.noProfile.title')}
            desc={t('data.empty.noProfile.desc')}
          />
        ) : activeRead.kind === 'idle' || activeRead.kind === 'loading' ? (
          <div className="dp-loading">
            {t(
              tab === 'downloads'
                ? 'data.loading.downloads'
                : tab === 'cookies'
                  ? 'data.loading.cookies'
                  : 'data.loading.history'
            )}
          </div>
        ) : activeRead.kind === 'error' ? (
          <div className="dp-err">
            <b>
              {t(
                tab === 'downloads'
                  ? 'data.error.downloads'
                  : tab === 'cookies'
                    ? 'data.error.cookies'
                    : 'data.error.history'
              )}
            </b>
            <p className="dp-err-reason">{activeRead.message}</p>
            {/* DESIGN.md：读不到 ≠ 没有数据。现在既不能说有也不能说没有，所以停下别动、重试一次。 */}
            <p className="dp-err-hint">
              {t(
                tab === 'downloads'
                  ? 'data.errHint.downloads'
                  : tab === 'cookies'
                    ? 'data.errHint.cookies'
                    : 'data.errHint.history'
              )}
            </p>
            <Button size="sm" variant="ghost" icon="reload" onClick={retryActive}>
              {t('common.retry')}
            </Button>
          </div>
        ) : currentEmpty ? (
          tab === 'cookies' ? (
            <EmptyState
              icon="shield"
              title={t('data.empty.cookies.title')}
              desc={t('data.empty.cookies.desc')}
            />
          ) : tab === 'downloads' ? (
            <EmptyState
              icon="download"
              title={t('data.empty.downloads.title')}
              desc={t('data.empty.downloads.desc')}
            />
          ) : (
            <EmptyState
              icon="list"
              title={t('data.empty.history.title')}
              desc={t('data.empty.history.desc')}
            />
          )
        ) : tab === 'cookies' ? (
          <div className="dp-table">
            <div className="dp-tr dp-th">
              <span>{t('data.table.domain')}</span>
              <span>{t('common.name')}</span>
              <span>{t('data.table.value')}</span>
              <span>{t('data.table.flags')}</span>
              <span>{t('data.table.expires')}</span>
            </div>
            {cookies.slice(0, visibleCount.cookies).map((c) => {
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
                    title={shown ? t('data.reveal.hide') : t('data.reveal.show')}
                    onClick={() => setRevealed((prev) => ({ ...prev, [key]: !shown }))}
                  >
                    <span className="dp-val-txt">
                      {shown ? c.value || t('data.value.empty') : '••••••••'}
                    </span>
                    <Icon name={shown ? 'eyeOff' : 'eye'} size={11} />
                  </button>
                  <span className="dp-flags">
                    {c.secure ? <i className="dp-flag sec">Secure</i> : null}
                    {c.httpOnly ? <i className="dp-flag http">HttpOnly</i> : null}
                    {c.session ? <i className="dp-flag sess">{t('data.flag.session')}</i> : null}
                    {!c.secure && !c.httpOnly && !c.session ? <i className="dp-flag none">—</i> : null}
                  </span>
                  <span className="dp-exp">
                    {c.session || !c.expires ? t('data.sessionEnd') : formatDate(c.expires)}
                  </span>
                </div>
              )
            })}
            <LoadMore
              shown={Math.min(visibleCount.cookies, cookies.length)}
              total={cookies.length}
              onMore={() => showMore('cookies')}
            />
          </div>
        ) : tab === 'downloads' ? (
          <div className="dp-list">
            {downloads.slice(0, visibleCount.downloads).map((d) => {
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
                        {d.filename || t('data.download.unnamed')}
                      </span>
                      <span className={cx('dp-state', meta.tone)}>{t(meta.labelKey)}</span>
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
            <LoadMore
              shown={Math.min(visibleCount.downloads, downloads.length)}
              total={downloads.length}
              onMore={() => showMore('downloads')}
            />
          </div>
        ) : (
          <div className="dp-list">
            {history.slice(0, visibleCount.history).map((h) => (
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
            <LoadMore
              shown={Math.min(visibleCount.history, history.length)}
              total={history.length}
              onMore={() => showMore('history')}
            />
          </div>
        )}
      </div>

      <Modal
        open={confirming !== null}
        title={
          confirming === 'cookies'
            ? t('data.clearModal.cookies.title')
            : confirming === 'downloads'
              ? t('data.clearModal.downloads.title')
              : t('data.clearModal.history.title')
        }
        icon="trash"
        tone="danger"
        onClose={() => setConfirming(null)}
        note={
          confirming === 'cookies'
            ? t('data.clearModal.cookies.note')
            : confirming === 'downloads'
              ? t('data.clearModal.downloads.note')
              : t('data.clearModal.history.note')
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" icon="trash" onClick={() => void doClear()}>
              {t('data.clearModal.confirm')}
            </Button>
          </>
        }
      >
        <p>
          {confirming === 'downloads'
            ? t('data.clearModal.downloads.body', { n: downloads.length })
            : confirming === 'cookies'
              ? t('data.clearModal.cookies.body', {
                  name: activeProfile?.name ?? t('data.scope.noProfileShort'),
                  n: cookies.length
                })
              : t('data.clearModal.history.body', {
                  name: activeProfile?.name ?? t('data.scope.noProfileShort'),
                  n: history.length
                })}
        </p>
      </Modal>

      <Modal
        open={importOpen}
        title={t('data.import.title')}
        icon="swap"
        tone="accent"
        align="left"
        maxWidth={560}
        onClose={() => setImportOpen(false)}
        note={t('data.import.note')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setImportOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              icon="check"
              disabled={importing || importText.trim() === ''}
              onClick={() => void doImportCookies()}
            >
              {importing ? t('data.import.importing') : t('data.import.submit')}
            </Button>
          </>
        }
      >
        <Field label={t('data.import.contentLabel')} hint={t('data.import.contentHint')}>
          <textarea
            rows={9}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder={'# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t...'}
            spellCheck={false}
          />
        </Field>
        {importSummary ? (
          <p
            style={importNoCookies(importSummary) ? { color: 'var(--amber)' } : undefined}
          >
            {importSummaryText(importSummary, t)}
          </p>
        ) : null}
        {importSummary && importSummary.errors.length > 0 ? (
          <details>
            <summary>
              {t('data.import.errors', { n: importSummary.errors.length })}
            </summary>
            <ul>
              {importSummary.errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </Modal>

      <Modal
        open={warmupOpen}
        title={t('data.warmup.title')}
        icon="spark"
        tone="accent"
        align="left"
        maxWidth={560}
        onClose={() => {
          // 运行中不关窗：预热没有取消通道，关掉只会让用户以为它停了，
          // 而主进程仍在访问后面的页面。等这一批跑完再允许关闭。
          if (!warmupRunning) setWarmupOpen(false)
        }}
        note={t('data.warmup.desc')}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setWarmupOpen(false)}
              disabled={warmupRunning}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              icon="spark"
              disabled={warmupRunning || warmupText.trim() === '' || !profileId}
              onClick={() => void doWarmup()}
            >
              {warmupRunning ? t('data.warmup.running') : t('data.warmup.run')}
            </Button>
          </>
        }
      >
        <Field label={t('data.warmup.urls')}>
          <textarea
            rows={8}
            value={warmupText}
            onChange={(e) => {
              setWarmupText(e.target.value)
              // 输入一改，上一次的失败明细就过期了；留着会让人以为新列表也有这些错。
              if (warmupReport !== null) setWarmupReport(null)
            }}
            placeholder={t('data.warmup.urlsPlaceholder')}
            disabled={warmupRunning}
            spellCheck={false}
          />
        </Field>
        {warmupReport ? (
          <p>{t('data.warmup.done', { ok: warmupReport.okCount, total: warmupReport.total })}</p>
        ) : null}
        {warmupFailures.length > 0 ? (
          <details>
            <summary>{t('data.warmup.failedDetail', { n: warmupFailures.length })}</summary>
            <ul>
              {warmupFailures.map((step, i) => (
                <li key={i}>
                  {step.url}
                  {step.error ? ` — ${step.error}` : ''}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Modal>

      {/* 还原确认：不可逆操作，确认框必须把「会发生什么」讲清楚 */}
      <Modal
        open={restoreTarget !== null}
        title={t('ws.backup.title')}
        icon="shield"
        tone="danger"
        onClose={() => setRestoreTarget(null)}
        note={t('ws.backup.restoreConfirm')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRestoreTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" icon="swap" onClick={() => void doRestore()}>
              {restoring ? t('ws.backup.restoring') : t('ws.backup.restore')}
            </Button>
          </>
        }
      >
        <p className="dp-backup-target">{restoreTarget?.name ?? ''}</p>
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

/**
 * 「加载更多」。
 *
 * 分批渲染是纯展示层的事：数据已经全在内存里（IPC 一次取全），
 * 这里只决定一次画多少行。放在列表末尾而不是顶部工具栏 ——
 * 用户滚到底自然看到它，不用回头找。
 */
function LoadMore({
  shown,
  total,
  onMore
}: {
  shown: number
  total: number
  onMore: () => void
}) {
  const { t } = useI18n()
  if (shown >= total) return null
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0' }}>
      <Button size="sm" variant="ghost" onClick={onMore}>
        {t('common.loadMore', { n: total - shown })}
      </Button>
    </div>
  )
}
