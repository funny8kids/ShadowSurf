/**
 * 应用根组件。
 *
 * 同一个 Electron 窗口里有两层界面：
 * - 控制台（workbench / tasks）：Sidebar + TopBar + 主内容区；
 * - 双轨窗口（browser）：全屏 BrowserShell，有自己的标签条与地址栏。
 *
 * 路由用 useState，不引入 react-router：只有三个互斥视图，用不上路由库。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MaskRow, Profile, ProxyConfig, Settings, TaskRecord, WindowState } from '@shared/types'
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
import { ProxyPanel } from '@renderer/components/tools/ProxyPanel'
import { TemplatePanel } from '@renderer/components/tools/TemplatePanel'
import { ScriptPanel } from '@renderer/components/tools/ScriptPanel'
import { ApiPanel } from '@renderer/components/tools/ApiPanel'
import { AuditPanel } from '@renderer/components/tools/AuditPanel'
import { DataPanel } from '@renderer/components/tools/DataPanel'
import { StoreHealthBanner } from '@renderer/components/StoreHealthBanner'
import { bridge, errorMessage, hasBridge, onMaskState, onWindowState } from './lib/api'

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

  const [view, setView] = useState<View>(isBrowserWindow ? 'browser' : 'workbench')
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState('全部')
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [windowState, setWindowState] = useState<WindowState | null>(null)
  /**
   * 每个窗口此刻的伪装读数（主进程用 `judgeMask` 判定后下发）。
   *
   * 存在这个 state 里而不是塞进 Profile：它是进程内实时量，跟落盘的
   * `Profile.maskLast`（上次会话的结论）不是一回事 —— 混在一起迟早有人
   * 拿上一次会话的结论去拦这一次的操作。
   */
  const [maskRows, setMaskRows] = useState<MaskRow[]>([])

  const bridgeOk = useMemo(() => hasBridge(), [])

  /* ── 首屏加载 ── */
  useEffect(() => {
    let alive = true
    if (!hasBridge()) {
      setLoading(false)
      return
    }
    void (async () => {
      try {
        const [list, history, conf, masks] = await Promise.all([
          bridge().profiles.list(),
          bridge().tasks.list(),
          bridge().settings.get(),
          bridge().mask.list()
        ])
        if (!alive) return
        setProfiles(list)
        setTasks(history)
        setSettings(conf)
        setMaskRows(masks)
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

  /* ── 打开 / 启动环境 ── */
  async function openProfile(id: string): Promise<void> {
    try {
      // 环境在独立窗口里打开，控制台不切换视图——否则这里会变成一个没有
      // windowState 的空白浏览器壳。
      await bridge().profiles.launch(id)
      await refreshProfiles()
      if (isBrowserWindow) setView('browser')
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    }
  }

  async function createProfile(): Promise<void> {
    try {
      const created = await bridge().profiles.create({})
      setProfiles((prev) => [created, ...prev])
      setDrawerId(created.id)
      toast.push('已创建环境，先核对指纹再启动', 'ok')
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    }
  }

  function toggleSelect(id: string): void {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  function selectAll(ids: string[]): void {
    setSelected(ids)
  }

  async function runBatch(action: BatchAction, ids: string[], value?: string): Promise<void> {
    if (ids.length === 0) return
    try {
      if (action === 'start') {
        await Promise.all(ids.map((id) => bridge().profiles.launch(id)))
        toast.push(`已启动 ${ids.length} 个环境`, 'ok')
      } else if (action === 'stop') {
        await Promise.all(ids.map((id) => bridge().profiles.stop(id)))
        toast.push(`已停止 ${ids.length} 个环境`, 'ok')
      } else if (action === 'move' && value) {
        await Promise.all(ids.map((id) => bridge().profiles.update(id, { group: value })))
        toast.push(`已移到分组「${value}」`, 'ok')
      } else if (action === 'proxy' && value) {
        const proxy = parseProxy(value)
        await Promise.all(ids.map((id) => bridge().profiles.update(id, { proxy })))
        toast.push(proxy ? `已切换代理 ${proxy.host}:${proxy.port}` : '已改为直连', 'ok')
      } else if (action === 'remove') {
        await Promise.all(ids.map((id) => bridge().profiles.remove(id)))
        setSelected([])
        toast.push(`已删除 ${ids.length} 个环境`, 'ok')
      }
      await refreshProfiles()
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    }
  }

  const runningCount = profiles.filter(
    (p) => p.status === 'running' || p.status === 'starting'
  ).length

  const hasRunningTask = tasks.some((t) => t.status === 'running')

  return (
    <div className="app">
      <Sidebar
        view={view}
        profileCount={profiles.length}
        runningCount={runningCount}
        hasRunningTask={hasRunningTask}
        onNavigate={(key: NavKey) => {
          setView(key)
          setSelected([])
        }}
        onUnavailable={(label) => toast.push(`${label}模块尚未接入`, 'info')}
      />

      <div className="main">
        <TopBar
          view={view === 'tasks' ? 'tasks' : 'workbench'}
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
          <div className="views scroll-thin">
            {view === 'tasks' ? (
              <TaskList
                tasks={tasks}
                profiles={profiles}
                loading={loading}
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
            ) : (
              <ProfileGrid
                profiles={profiles}
                tasks={tasks}
                maskRows={maskRows}
                selected={selected}
                query={query}
                group={group}
                loading={loading}
                bridgeOk={bridgeOk}
                onGroup={setGroup}
                onSelect={toggleSelect}
                onSelectAll={selectAll}
                onClearSelection={() => setSelected([])}
                onOpen={(id) => void openProfile(id)}
                onConfig={(id) => setDrawerId(id)}
                onNew={() => void createProfile()}
                onBatch={(action, ids, value) => void runBatch(action, ids, value)}
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
    </div>
  )
}

/** host:port 或完整 URL → ProxyConfig；空串表示改为直连 */
function parseProxy(raw: string): ProxyConfig | null {
  const value = raw.trim()
  if (!value) return null
  const cleaned = value.replace(/^[a-z0-9+]+:\/\//i, '')
  const [hostPart, portPart] = cleaned.split(':')
  const port = Number(portPart)
  return {
    type: 'http',
    host: hostPart,
    port: Number.isFinite(port) && port > 0 ? port : 8080
  }
}
