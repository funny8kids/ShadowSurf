/**
 * 主进程入口。
 *
 * 职责只有三件：装配依赖、开控制台窗口、把生命周期管好。
 * 业务逻辑一律在 core / agent / store 里，这里不写。
 */

import { app, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'node:path'
import { CH } from '@shared/ipc'
import { getStores } from '@main/store'
import { WindowManager } from '@main/core/windows'
import { ProfileRuntime } from '@main/core/profiles'
import { registerHandlers } from '@main/ipc/handlers'

/** 只允许单实例：两个进程同时写 profiles.json 会互相覆盖 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let consoleWindow: BrowserWindow | null = null
let wm: WindowManager | null = null

function preloadPath(): string | undefined {
  const candidate = join(__dirname, '../preload/index.js')
  return candidate
}

function loadRenderer(win: BrowserWindow, query?: string): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const search = query ? `?${query}` : ''
  if (devUrl) {
    void win.loadURL(`${devUrl}${search}`)
    return
  }
  void win.loadFile(join(__dirname, '../renderer/index.html'), { search })
}

function createConsoleWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#F6F5F2',
    // 控制台保留系统标题栏：无边框窗口在 Windows 上会丢失窗口控制按钮，
    // 而控制台没有自绘的关闭/最大化，保留 frame 是最省事也最不容易出错的方案。
    frame: true,
    autoHideMenuBar: true,
    title: 'ShadowSurf',
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 需要 require('electron')，sandbox 会拦掉
      sandbox: false
    }
  })

  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    consoleWindow = null
  })
  loadRenderer(win)
  return win
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'light'

  const stores = getStores()

  wm = new WindowManager({
    getProfile: (id) => stores.profiles.get(id),
    // 状态只推给拥有这个窗口的那一个渲染进程，不做广播：
    // 否则控制台也会收到别人的标签页状态，跟着切成浏览器视图。
    onState: (state) => {
      const rec = wm?.getWindow(state.id)
      if (rec && !rec.win.isDestroyed()) {
        rec.win.webContents.send(CH.push.windowState, state)
      }
    },
    onProfileStopped: (profileId) => {
      const profile = stores.profiles.get(profileId)
      if (profile && profile.status !== 'idle') {
        stores.profiles.update(profileId, { status: 'idle' })
      }
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(CH.push.profileState, stores.profiles.list())
      }
    }
  })

  const runtime = new ProfileRuntime(wm)
  registerHandlers({ wm, runtime })

  consoleWindow = createConsoleWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      consoleWindow = createConsoleWindow()
    }
  })
})

app.on('second-instance', () => {
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    if (consoleWindow.isMinimized()) consoleWindow.restore()
    consoleWindow.focus()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // 网页视图是独立进程，不显式关会残留
  void wm?.closeAll()
})
