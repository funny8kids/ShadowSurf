/**
 * 应用根组件。
 *
 * 同一个 Electron 窗口里有两层界面：
 * - 控制台（workbench / tasks）：Sidebar + TopBar + 主内容区；
 * - 双轨窗口（browser）：全屏 BrowserShell，有自己的标签条与地址栏。
 *
 * 路由用 useState，不引入 react-router：只有三个互斥视图，用不上路由库。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@renderer/lib/i18n'
import type {
  MaskRow,
  Profile,
  Settings,
  TaskRecord,
  ThemeMode,
  WindowState
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/presets'
import { Sidebar } from '@renderer/components/Sidebar'
import type { NavKey } from '@renderer/components/Sidebar'
import { TopBar } from '@renderer/components/TopBar'
import { ProfileGrid } from '@renderer/components/ProfileGrid'
import type { BatchAction } from '@renderer/components/ProfileGrid'
import { FingerprintDrawer } from '@renderer/components/FingerprintDrawer'
import { BrowserShell } from '@renderer/components/BrowserShell'
import { TaskList } from '@renderer/components/TaskList'
import { ToastProvider, useToast } from '@renderer/components/ui'
import type { IconName } from '@renderer/components/ui'
import { CommandPalette } from '@renderer/components/CommandPalette'
import type { Command } from '@renderer/components/CommandPalette'
import { ProxyPanel } from '@renderer/components/tools/ProxyPanel'
import { TemplatePanel } from '@renderer/components/tools/TemplatePanel'
import { ScriptPanel } from '@renderer/components/tools/ScriptPanel'
import { ApiPanel } from '@renderer/components/tools/ApiPanel'
import { AuditPanel } from '@renderer/components/tools/AuditPanel'
import { DataPanel } from '@renderer/components/tools/DataPanel'
import { TeamPanel } from '@renderer/components/tools/TeamPanel'
import { ExtensionsPanel } from '@renderer/components/tools/ExtensionsPanel'
import { ProxyGroupsPanel } from '@renderer/components/tools/ProxyGroupsPanel'
import { SyncPanel } from '@renderer/components/tools/SyncPanel'
import { WebhooksPanel } from '@renderer/components/tools/WebhooksPanel'
import { StoreHealthBanner } from '@renderer/components/StoreHealthBanner'
import { OnboardingCard } from '@renderer/components/OnboardingCard'
import { bridge, errorMessage, hasBridge, onMaskState, onWindowState } from './lib/api'
import { parseProxy } from './lib/proxy-parse'
import { applyDensity, applyTheme, onSystemThemeChange, resolveTheme } from './lib/theme'
import type { DensityMode } from './lib/theme'

/**
 * 密度偏好落在 localStorage 的独立键下，不走 Settings/IPC：
 * 它不需要跨窗口同步、也不需要跟着 seed 迁移，塞进共享 Settings 契约
 * 只会白白拖过主进程校验，没有收益。主题走 IPC 是因为要在多窗口间同步，
 * 密度没有这个需求，所以各走各的存储。
 */
const DENSITY_KEY = 'ss:density'

/** 读密度偏好；任何异常（隐私模式 / 被篡改的脏值）都回落到舒适档 */
function loadDensity(): DensityMode {
  try {
    return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable'
  } catch {
    return 'comfortable'
  }
}

/**
 * 首屏快照的三态。原来只有一个 loading:boolean，catch 里弹个 toast 就把
 * loading 置 false —— 于是「读不到」和「读到但是空」在界面上长得一模一样，
 * 正好是 DESIGN.md 判定的那类缺陷。把三态做成联合类型，读失败态带原文，
 * 编译器就逼着渲染层必须给它单独一个分支；面板按结构类型接收同一形状。
 */
export type ConsoleLoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' }

/**
 * 剥掉 Electron 给 IPC 失败套的那层协议壳。
 * 原始消息形如 `Error invoking remote method 'ss:profiles:list': Error: EACCES: ...`，
 * 通道名对用户没意义，还把真正的原因挤出了屏幕。镜像 AuditPanel 的本地
 * cleanIpcMessage（不改那个文件）：这一层是所有 IPC 报错共有的噪音。
 */
function cleanIpcMessage(raw: string): string {
  const m = /Error invoking remote method '[^']*':\s*(?:Error:\s*)?([\s\S]*)$/.exec(raw)
  return (m?.[1] ?? raw).trim()
}

type View = NavKey | 'browser'

/**
 * 同一个 renderer 有两种角色：
 * - 控制台窗口：没有 query，显示环境列表 / 任务页；
 * - 双轨窗口：主进程用 ?role=browser&windowId=&profileId= 打开，直接进浏览器视图。
 * 不这么做的话，每个浏览器窗口都会先闪一下控制台再切过去。
 */
const bootParams = new URLSearchParams(window.location.search)
const isBrowserWindow = bootParams.get('role') === 'browser'
const bootProfileId = bootParams.get('profileId')
const bootWindowId = bootParams.get('windowId')

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  )
}

function Shell() {
  const toast = useToast()
  const { lang, setLang, t } = useI18n()

  const [view, setView] = useState<View>(isBrowserWindow ? 'browser' : 'workbench')
  /** 命令面板开关。面板本身完全受控，快捷键与焦点管理都在这一层。 */
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  /**
   * 首屏快照三态：loading / error(带原文) / ready。
   * 不再用 loading:boolean —— 那个布尔量把「读不到」和「读到但是空」压成了同一张脸。
   */
  const [load, setLoad] = useState<ConsoleLoadState>({ kind: 'loading' })
  /** 已选环境：Set 而不是数组（卡片里 has(id) 是 O(1)，批量栏不用 includes 扫描） */
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState('全部')
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [windowState, setWindowState] = useState<WindowState | null>(null)
  /** 密度偏好：舒适 / 紧凑两档，独立存 localStorage（见 DENSITY_KEY 注释） */
  const [density, setDensity] = useState<DensityMode>(loadDensity)
  /**
   * 每个窗口此刻的伪装读数（主进程用 `judgeMask` 判定后下发）。
   *
   * 存在这个 state 里而不是塞进 Profile：它是进程内实时量，跟落盘的
   * `Profile.maskLast`（上次会话的结论）不是一回事 —— 混在一起迟早有人
   * 拿上一次会话的结论去拦这一次的操作。
   */
  const [maskRows, setMaskRows] = useState<MaskRow[]>([])

  const bridgeOk = useMemo(() => hasBridge(), [])

  /**
   * 卸载哨兵。loadConsole 抽成回调后，alive 不能再用 effect 的局部变量
   * （每次渲染签名会变），改用一个跨渲染稳定的 ref：effect 挂载时置 true、
   * 卸载时置 false，异步续段和「重试」都靠它保证不给已卸载的组件 setState。
   */
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  /**
   * 一次读完整个「控制台快照」：环境 / 任务 / 设置 / 伪装读数四路一起取。
   *
   * 四条读取必须同进同退 —— 它们是一份快照，不是四个相互独立的事实。
   * 所以「重试」也走这整个函数，而不是只重读失败的那一两路：部分重试会
   * 让 profiles / tasks / settings / mask 彼此对不上（比如任务引用了还没读到的环境）。
   */
  const loadConsole = useCallback(async (): Promise<void> => {
    if (!hasBridge()) {
      // 主进程没注入 = 一样读不到，不能落到「空」。内联错误为准。
      if (aliveRef.current) setLoad({ kind: 'error', message: '主进程尚未就绪：window.ss 未注入' })
      return
    }
    if (aliveRef.current) setLoad({ kind: 'loading' })
    try {
      const [list, history, conf, masks] = await Promise.all([
        bridge().profiles.list(),
        bridge().tasks.list(),
        bridge().settings.get(),
        bridge().mask.list()
      ])
      if (!aliveRef.current) return
      setProfiles(list)
      setTasks(history)
      setSettings(conf)
      setMaskRows(masks)
      setLoad({ kind: 'ready' })
    } catch (err) {
      // 不再弹 toast：会消失的提示会把「读失败」又变回「空」。原文内联常驻，
      // 面板据此渲染琥珀色的读失败态并给出「重试」下一步。
      if (aliveRef.current) setLoad({ kind: 'error', message: cleanIpcMessage(errorMessage(err)) })
    }
  }, [])

  /* ── 首屏加载：重试按钮调用的也是上面同一个 loadConsole ── */
  useEffect(() => {
    void loadConsole()
  }, [loadConsole])

  /* ── 订阅窗口状态 ── */
  useEffect(() => {
    const off = onWindowState((next) => {
      setWindowState(next)
      // 只有浏览器窗口才需要切视图；控制台收到别人的状态不该跟着跳
      if (isBrowserWindow && next.tabs.length > 0) setView('browser')
    })
    return off
  }, [])

  /* ── 伪装状态推送：环境卡片上的状态点靠它更新 ── */
  useEffect(() => {
    const off = onMaskState((rows) => setMaskRows(rows))
    return off
  }, [])

  /* ── 环境列表推送 ──
   *
   * 定时任务启动环境、地理校准改时区、闸门豁免自动收回都发生在主进程，
   * 不经过本窗口的任何本地 setProfiles。没有这条订阅时，界面会一直停在
   * 上一次自行刷新的快照上。载荷是主进程写的完整列表，直接替换；
   * 本地新增路径（create / bulk）改成「按 id upsert」，避免与这条推送重复。
   *
   * 用 rAF 合并连续推送：主进程每次写环境都会广播完整列表，批量建 50 个
   * 环境就是 50 次广播 —— 不合并的话渲染层会重建 50 次大列表，期间滚动/
   * 动画全部卡住（审计里首次打开抽屉出现 888ms 长帧就是残留的批量更新）。
   * 一帧只应用最后一个快照，语义不变：快照本来就是全量、幂等的。 */
  useEffect(() => {
    if (!hasBridge()) return
    let pending: Profile[] | null = null
    let raf = 0
    const flush = (): void => {
      raf = 0
      if (pending !== null && aliveRef.current) {
        const next = pending
        pending = null
        setProfiles(next)
      }
    }
    const off = bridge().profiles.onState((list) => {
      pending = list
      if (raf === 0) raf = requestAnimationFrame(flush)
    })
    return () => {
      off()
      if (raf !== 0) cancelAnimationFrame(raf)
    }
  }, [])

  /* ── 主题 ──
   *
   * 三个来源，缺一个就会出现「某个窗口不跟着变」：
   *   1. 落盘的模式（settings.theme）—— 首帧与用户改设置后
   *   2. 主进程推送（settings.onTheme）—— 别的窗口改了设置时
   *   3. 系统偏好变化 —— 模式为 'system' 时
   *
   * 第 1 条不能省：推送只在变化时发，冷启动没有「变化」可言。
   * 第 2 条不能省：'system' 之外的显式模式下系统偏好不会变，
   * 媒体查询也不会动，别的窗口就永远收不到通知。
   */
  useEffect(() => {
    applyTheme(resolveTheme(settings.theme))
  }, [settings.theme])

  useEffect(() => {
    if (!hasBridge()) return
    const offPush = bridge().settings.onTheme((theme) => {
      applyTheme(theme)
      // 推送只带解析结果、不带模式，所以本地 settings.theme 可能是旧的
      // （别的窗口改了设置）。不刷新的话，下一次系统偏好变化会拿旧模式重算，
      // 把刚推来的主题又改回去。一次往返换一个不可能不一致的状态，值。
      void bridge()
        .settings.get()
        .then(setSettings)
        .catch(() => undefined)
    })
    const offSystem = onSystemThemeChange(() => applyTheme(resolveTheme(settings.theme)))
    return () => {
      offPush()
      offSystem()
    }
  }, [settings.theme])

  /* ── 密度 ──
   *
   * 和主题写 <html data-theme> 同一套思路，只是单独用 data-density，互不干扰。
   * 属性是整个文档的：浏览器窗口里的 BrowserShell 也靠 tokens.css 的 chrome 尺寸
   * 决定 stage 矩形，所以密度要挂到 documentElement，而不是某个组件根节点。
   * 持久化只在这里做一次，切换函数只管改 state —— 写入失败也不影响本次生效。
   */
  useEffect(() => {
    applyDensity(density)
    try {
      localStorage.setItem(DENSITY_KEY, density)
    } catch {
      // 存不了就算了（隐私模式 / 配额满），本次会话仍然生效
    }
  }, [density])

  const toggleDensity = useCallback((next: DensityMode): void => setDensity(next), [])

  /* ── 任务完成推送：控制台的统计与列表要跟着动 ── */
  useEffect(() => {
    if (!hasBridge()) return
    const off = bridge().tasks.onUpdate((task) => {
      setTasks((prev) => [task, ...prev.filter((t) => t.id !== task.id)])
    })
    return off
  }, [])

  /* ── Esc 逐层返回 ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (drawerId) {
        setDrawerId(null)
        return
      }
      if (view === 'browser') {
        // 浏览器窗口按 Esc 不退出到控制台（那会把整个窗口变成环境列表），
        // 交给标题栏的关闭按钮处理。
        if (!isBrowserWindow) setView('workbench')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerId, view])

  const drawerProfile = useMemo(
    () => profiles.find((p) => p.id === drawerId) ?? null,
    [profiles, drawerId]
  )

  const activeProfile = useMemo(
    () =>
      profiles.find((p) => p.id === (windowState?.profileId ?? bootProfileId)) ?? null,
    [profiles, windowState]
  )

  const browserTask = useMemo(() => {
    const profileId = windowState?.profileId ?? activeProfile?.id
    return (
      tasks.find((t) => t.status === 'running' && t.profileId === profileId) ??
      tasks.find((t) => t.status === 'running')
    )
  }, [tasks, windowState, activeProfile])

  const refreshProfiles = useCallback(async (): Promise<void> => {
    if (!hasBridge()) return
    try {
      setProfiles(await bridge().profiles.list())
    } catch {
      // 静默：主流程已经给过提示，这里再弹一次只会刷屏
    }
  }, [])

  const refreshTasks = useCallback(async (): Promise<void> => {
    if (!hasBridge()) return
    try {
      setTasks(await bridge().tasks.list())
    } catch {
      /* 同上 */
    }
  }, [])

  /** 导航统一入口：切视图时清掉勾选，避免从一个页面带到另一个页面 */
  const navigate = useCallback((key: NavKey) => {
    setView(key)
    setSelected(new Set())
  }, [])

  /* ── 主题切换 ── */
  const changeTheme = useCallback(
    async (mode: ThemeMode): Promise<void> => {
      // 先本地生效：主题是纯展示状态，等 IPC 回来再变色会让点击有明显迟滞
      setSettings((prev) => ({ ...prev, theme: mode }))
      if (!hasBridge()) return
      try {
        setSettings(await bridge().settings.set({ theme: mode }))
      } catch (err) {
        toast.push(errorMessage(err), 'err')
      }
    },
    [toast]
  )

  /* ── 打开 / 启动环境 ──
   *
   * 这些回调会一路传到被 memo 的 ProfileCard，必须保持引用稳定：
   * 每次渲染新建箭头函数会让整片环境网格的 memo 全部失效。
   */
  const openProfile = useCallback(
    async (id: string): Promise<void> => {
      try {
        // 环境在独立窗口里打开，控制台不切换视图——否则这里会变成一个没有
        // windowState 的空白浏览器壳。
        await bridge().profiles.launch(id)
        await refreshProfiles()
        if (isBrowserWindow) setView('browser')
      } catch (err) {
        toast.push(errorMessage(err), 'err')
      }
    },
    [refreshProfiles, toast]
  )

  const createProfile = useCallback(async (): Promise<void> => {
    try {
      const created = await bridge().profiles.create({})
      // 主进程已经广播了完整列表，这里按 id upsert：直接 prepend 会出现两张同名卡
      setProfiles((prev) => [created, ...prev.filter((p) => p.id !== created.id)])
      setDrawerId(created.id)
      toast.push('已创建环境，先核对指纹再启动', 'ok')
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    }
  }, [toast])

  /** 批量新建：商业指纹浏览器普遍提供 bulk create。
      主进程无批量接口，但创建是低频操作，N 次 IPC 可接受；
      失败逐个计数而不是整批中断（一个名字冲突不该让其余 9 个都没创建）。

      本地状态只在循环结束后合并一次：每个 IPC 同时会触发主进程的全量广播，
      逐个 setProfiles 会让 50 个环境重建 50 次列表 —— 用户在批量新建期间的
      滚动和动画会被这些重建拖住。 */
  const createProfiles = useCallback(
    async (count: number): Promise<void> => {
      const n = Math.max(1, Math.min(50, Math.floor(count)))
      let ok = 0
      let failed = 0
      const createdList: Profile[] = []
      for (let i = 0; i < n; i++) {
        try {
          createdList.push(await bridge().profiles.create({}))
          ok += 1
        } catch {
          failed += 1
        }
      }
      if (createdList.length > 0) {
        const ids = new Set(createdList.map((p) => p.id))
        setProfiles((prev) => [...createdList, ...prev.filter((p) => !ids.has(p.id))])
      }
      if (failed === 0) toast.push(t('profiles.bulk.created', { n: ok }), 'ok')
      else toast.push(t('profiles.bulk.createdPartial', { ok, failed }), 'err')
    },
    [toast, t]
  )

  const newProfile = useCallback((): void => {
    void createProfile()
  }, [createProfile])

  const toggleSelect = useCallback((id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectAll = useCallback((ids: string[]): void => {
    setSelected(new Set(ids))
  }, [])

  const clearSelection = useCallback((): void => {
    setSelected(new Set())
  }, [])

  const openConfig = useCallback((id: string): void => {
    setDrawerId(id)
  }, [])

  /**
   * 收藏 / 置顶。写的是 Profile.favorite，所以走 profiles.update 的显式白名单；
   * 成功后用主进程返回的那份覆盖本地，不做「先翻转再等结果」的乐观更新 ——
   * 星标是可见状态，写失败却先亮起来会让人以为已经存了。
   */
  const toggleFavorite = useCallback(
    async (id: string): Promise<void> => {
      const current = profiles.find((p) => p.id === id)
      if (!current) return
      try {
        const next = await bridge().profiles.update(id, {
          favorite: current.favorite !== true
        })
        setProfiles((prev) => prev.map((p) => (p.id === next.id ? next : p)))
      } catch (err) {
        toast.push(errorMessage(err), 'err')
      }
    },
    [profiles, toast]
  )

  const retryConsole = useCallback((): void => {
    void loadConsole()
  }, [loadConsole])

  const runBatch = useCallback(
    async (action: BatchAction, ids: string[], value?: string): Promise<void> => {
      if (ids.length === 0) return
      try {
        if (action === 'start') {
          await Promise.all(ids.map((id) => bridge().profiles.launch(id)))
          toast.push(`已启动 ${ids.length} 个环境`, 'ok')
        } else if (action === 'stop') {
          await Promise.all(ids.map((id) => bridge().profiles.stop(id)))
          toast.push(`已停止 ${ids.length} 个环境`, 'ok')
        } else if (action === 'move' && value) {
          // 走批量通道：一次 IPC + 一次落盘，而不是 N 次全量重写。
          const n = await bridge().profiles.batchUpdate(ids, { group: value })
          toast.push(`已移到分组「${value}」${n < ids.length ? `（${n}/${ids.length}）` : ''}`, 'ok')
        } else if (action === 'proxy' && value) {
          const proxy = parseProxy(value)
          const n = await bridge().profiles.batchUpdate(ids, { proxy })
          toast.push(proxy ? `已切换代理 ${proxy.host}:${proxy.port}` : '已改为直连', 'ok')
        } else if (action === 'remove') {
          await Promise.all(ids.map((id) => bridge().profiles.remove(id)))
          setSelected(new Set())
          toast.push(`已删除 ${ids.length} 个环境`, 'ok')
        }
        await refreshProfiles()
      } catch (err) {
        toast.push(errorMessage(err), 'err')
      }
    },
    [refreshProfiles, toast]
  )

  const runningCount = profiles.filter(
    (p) => p.status === 'running' || p.status === 'starting'
  ).length

  const hasRunningTask = tasks.some((t) => t.status === 'running')

  /* ── 命令面板 ──
   *
   * 导航命令直接复用 navigate（切视图时顺手清勾选），不引入路由。
   * 动作命令只放「真的有实现」的：设置目前只有占位提示，自检的处理函数
   * 封在 AuditPanel 内部、App 拿不到，所以这两项都不硬塞一个空壳。
   * 不显示快捷键：G E / G T 这类序列键本实现没做，显示了就是骗人。
   */
  const commands = useMemo<Command[]>(() => {
    const nav = (
      id: NavKey,
      label: string,
      hint: string,
      icon: IconName,
      keywords: string[]
    ): Command => ({
      id: `nav.${id}`,
      label,
      hint,
      icon,
      group: t('palette.group.nav'),
      keywords,
      run: () => navigate(id)
    })

    const themeLabel: Record<ThemeMode, string> = {
      system: t('theme.system'),
      light: t('theme.light'),
      dark: t('theme.dark')
    }
    const nextTheme: ThemeMode =
      settings.theme === 'system' ? 'light' : settings.theme === 'light' ? 'dark' : 'system'

    return [
      nav('workbench', t('nav.env'), t('navHint.env'), 'grid', ['env', 'profile', 'huanjing']),
      nav('tasks', t('nav.tasks'), t('navHint.tasks'), 'tasks', ['task', 'renwu']),
      nav('proxies', t('nav.proxies'), t('navHint.proxies'), 'globe', ['proxy', 'daili']),
      nav('scripts', t('nav.scripts'), t('navHint.scripts'), 'spark', ['script', 'zidonghua']),
      nav('templates', t('nav.templates'), t('navHint.templates'), 'folder', ['template', 'moban']),
      nav('data', t('nav.data'), t('navHint.data'), 'list', ['data', 'cookie', 'shuju']),
      nav('api', t('nav.api'), t('navHint.api'), 'external', ['api', 'bendi']),
      nav('audit', t('nav.audit'), t('navHint.audit'), 'shield', ['audit', 'shenji', 'selfcheck']),
      nav('sync', t('nav.sync'), t('crumb.sync.sub'), 'swap', ['sync', 'batch', 'tongbu']),
      nav('proxy-groups', t('nav.proxyGroups'), t('crumb.proxyGroups.sub'), 'globe', ['proxy-group', 'pool', 'dailizu']),
      nav('webhooks', t('nav.webhooks'), t('crumb.webhooks.sub'), 'send', ['webhook', 'hook', 'huijiao']),
      nav('team', t('nav.members'), t('palette.teamHint'), 'users', ['team', 'member', 'chengyuan', 'tuandui']),
      {
        id: 'action.new-profile',
        label: t('palette.newEnv'),
        hint: t('palette.newEnvHint'),
        icon: 'plus',
        group: t('palette.group.action'),
        keywords: ['new', 'create', 'xinjian'],
        run: () => void createProfile()
      },
      {
        id: 'action.toggle-theme',
        label: t('palette.toggleTheme'),
        hint: t('palette.themeNow', { theme: themeLabel[settings.theme] }),
        icon: settings.theme === 'dark' ? 'moon' : settings.theme === 'light' ? 'sun' : 'auto',
        group: t('palette.group.action'),
        keywords: ['theme', 'dark', 'light', 'zhuti'],
        run: () => void changeTheme(nextTheme)
      },
      {
        id: 'action.self-check',
        label: t('palette.selfCheck'),
        hint: t('palette.selfCheckHint'),
        icon: 'shield',
        group: t('palette.group.action'),
        keywords: ['selfcheck', 'check', 'zijian'],
        run: () => navigate('audit')
      }
    ]
  }, [navigate, settings.theme, createProfile, changeTheme, t])

  /* ── Ctrl/Cmd+K 切换命令面板 ──
   *
   * 只有组合键才拦，普通按键（含面板内的 Escape）一概不碰 ——
   * Escape 由面板自己在对话框内 stopPropagation 处理，这里不重复关一次。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app">
      <Sidebar
        view={view}
        profileCount={profiles.length}
        runningCount={runningCount}
        hasRunningTask={hasRunningTask}
        theme={settings.theme}
        onTheme={(mode: ThemeMode) => void changeTheme(mode)}
        density={density}
        onDensity={toggleDensity}
        onOpenPalette={() => setPaletteOpen(true)}
        onNavigate={navigate}
        onUnavailable={(label) => toast.push(t('app.moduleUnavailable', { label }), 'info')}
        lang={lang}
        onLang={setLang}
      />

      <div className="main">
        <TopBar
          view={view === 'browser' ? 'workbench' : view}
          query={query}
          onQuery={setQuery}
          runningCount={runningCount}
          onBell={() =>
            toast.push(
              runningCount > 0 ? `${runningCount} 个环境正在运行` : '暂时没有新的通知',
              'info'
            )
          }
          onNew={() => {
            if (view === 'tasks') {
              setView('browser')
              toast.push('请在影子面板里描述任务', 'info')
            } else {
              void createProfile()
            }
          }}
        />

        <div className="views-wrap">
          {/* 数据健康横幅：只在文件损坏 / 备份含明文 seed 时出现，正常状态不占位。
              挂在视图上方而不是某个面板里，因为数据坏了影响的是全部视图。 */}
          <StoreHealthBanner />
        {/* 首次上手引导：只在「一个环境都没有」时出现（组件自己判断 + localStorage）。
              放在视图区顶部而不是弹窗：新用户要能一边看引导一边点「新建环境」。 */}
        {view === 'workbench' ? (
          <OnboardingCard
            profiles={profiles}
            onCreate={() => void createProfile()}
            onOpenSettings={() => {
              setDrawerId(null)
              toast.push('模型设置在浏览器窗口右侧的「模型设置」里打开', 'info')
            }}
            onOpenDocs={() => {
              void bridge().system.openExternal('https://github.com/funny8kids/ShadowSurf#readme')
            }}
          />
        ) : null}
        <div className="views scroll-thin">
          {/* 两个面板的「重试」都指向 loadConsole（整个快照重读），不是单路重读：
              四个读取是一份逻辑快照，部分重试会让面板间数据对不上。 */}
          {view === 'tasks' ? (
              <TaskList
                tasks={tasks}
                profiles={profiles}
                loading={load.kind === 'loading'}
                loadState={load}
                onRetry={() => void loadConsole()}
                query={query}
                onNew={() => {
                  void refreshTasks()
                  toast.push('任务由影子面板发起：打开环境后在右侧输入指令', 'info')
                }}
                onOpenProfile={(profileId) => {
                  void openProfile(profileId)
                }}
              />
            ) : view === 'proxies' ? (
              <ProxyPanel profiles={profiles} />
            ) : view === 'templates' ? (
              <TemplatePanel profiles={profiles} />
            ) : view === 'scripts' ? (
              <ScriptPanel profiles={profiles} />
            ) : view === 'api' ? (
              <ApiPanel profiles={profiles} />
            ) : view === 'audit' ? (
              <AuditPanel profiles={profiles} />
            ) : view === 'data' ? (
              <DataPanel profiles={profiles} />
            ) : view === 'team' ? (
              <TeamPanel />
            ) : view === 'extensions' ? (
              <ExtensionsPanel />
            ) : view === 'proxy-groups' ? (
              <ProxyGroupsPanel />
            ) : view === 'sync' ? (
              <SyncPanel profiles={profiles} />
            ) : view === 'webhooks' ? (
              <WebhooksPanel />
            ) : (
              <ProfileGrid
                profiles={profiles}
                tasks={tasks}
                maskRows={maskRows}
                selected={selected}
                query={query}
                group={group}
                loading={load.kind === 'loading'}
                loadState={load}
                onRetry={retryConsole}
                bridgeOk={bridgeOk}
                onGroup={setGroup}
                onSelect={toggleSelect}
                onSelectAll={selectAll}
                onClearSelection={clearSelection}
                onOpen={openProfile}
                onConfig={openConfig}
                onToggleFavorite={toggleFavorite}
                onNew={newProfile}
                onBulkCreate={createProfiles}
                onBatch={runBatch}
              />
            )}
          </div>
        </div>
      </div>

      <FingerprintDrawer
        profile={drawerProfile}
        onClose={() => setDrawerId(null)}
        onSaved={(next) =>
          setProfiles((prev) => prev.map((p) => (p.id === next.id ? next : p)))
        }
        onLaunch={() => {
          setDrawerId(null)
          setView('browser')
          void refreshProfiles()
        }}
      />

      {view === 'browser' ? (
        <BrowserShell
          state={windowState}
          profile={activeProfile}
          task={browserTask}
          settings={settings}
          onClose={() => {
            // 浏览器窗口的关闭按钮 = 关掉这个窗口本身，不是切回控制台
            if (isBrowserWindow) window.close()
            else setView('workbench')
          }}
          onSettingsSaved={setSettings}
        />
      ) : null}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        placeholder={t('palette.placeholder')}
        emptyText={t('palette.empty')}
      />
    </div>
  )
}
