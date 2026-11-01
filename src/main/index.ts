/**
 * 主进程入口。
 *
 * 职责只有三件：装配依赖、开控制台窗口、把生命周期管好。
 * 业务逻辑一律在 core / agent / store 里，这里不写。
 */

import { app, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'node:path'
import { CH } from '@shared/ipc'
import { getStores, dataDir, sealLegacyBackups, GATE_ACTION_PREFIX } from '@main/store'
import { masterKey } from '@main/core/fingerprint'
import { WindowManager, guardShellNavigation } from '@main/core/windows'
import { ProfileRuntime } from '@main/core/profiles'
import { registerHandlers } from '@main/ipc/handlers'
import { setMaskStateLookup } from '@main/agent/actions'
import { maskRowOf } from '@main/core/mask-gate'
import { appendAudit } from '@main/modules/audit'

/** 只允许单实例：两个进程同时写 profiles.json 会互相覆盖 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let consoleWindow: BrowserWindow | null = null
let wm: WindowManager | null = null

/**
 * 把「所有窗口的伪装状态」推给每个渲染进程。
 *
 * 走 `maskRowOf` 而不是直接发 `MaskStateRecord`：行里的 allow/kind/reason
 * 是 `judgeMask` 算的，与拦 L2 同一个函数。渲染层拿到的是**结论**，
 * 它没有机会自己判一遍然后跟门禁分家。
 *
 * 两个触发点：
 *   1. `onMaskState` —— 某个窗口的读数变了
 *   2. `onProfileStopped` —— 窗口关了，`maskStates` 里那一条被删掉，
 *      界面必须跟着消失；否则关掉环境之后那个红点会永远留在卡片上
 */
function pushMaskRows(): void {
  const rows = wm === null ? [] : wm.listMaskStates().map(maskRowOf)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(CH.push.maskState, rows)
  }
}

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
  // 控制台窗口同样挂着完整 preload，同样不能被顶层导航劫持
  guardShellNavigation(win)
  win.on('closed', () => {
    consoleWindow = null
  })
  loadRenderer(win)
  return win
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'light'

  /**
   * 启动时就把主密钥封装一次。
   *
   * 为什么不放在「用到时再封」：`masterKey()` 只被 `deriveSeed()` 调用，而
   * `deriveSeed()` 只在新建 / 克隆 / 重掷时调用。于是一个**只浏览、不新建环境**的
   * 用户，`master.key` 会一直保持裸 32 字节 —— 「拿到数据目录就能重算全部指纹」
   * 这个前提对他永远不解除，而且没有任何信号。
   *
   * 放在 app ready 之后而不是模块加载期：safeStorage 在 Linux 上要等 keyring
   * 后端初始化，早调只会拿到 false。
   *
   * 失败不阻断启动：解不开（换了机器/账户）时如实记一条，让用户从健康横幅看到
   * 原因，而不是应用直接起不来。后续 deriveSeed 会再抛一次，那时才有上下文。
   */
  try {
    masterKey()
  } catch (err) {
    console.error(
      '[boot] 主密钥不可用，指纹派生会失败：' + (err instanceof Error ? err.message : String(err))
    )
  }

  const stores = getStores()

  /**
   * 历史备份原地密封。
   *
   * 旧版本每次迁移都留一份 `profiles.json.schema<N>-*` 的字节副本，里面是明文 seed。
   * 新版本不再产生这种文件，但已经产生的不会自己消失 —— 于是「主文件是密文、
   * 明文躺在旁边」。这里把它们就地封起来：数据仍在、同一个文件、仍能读回来，
   * 但盘上不再有明文。
   *
   * 放在 `getStores()` 之后：先让主数据文件完成它自己的迁移，再来收拾历史残留。
   * 失败不阻断启动 —— 用户的环境列表比这更重要，失败会进健康状态。
   */
  try {
    const legacy = sealLegacyBackups(dataDir())
    if (legacy.sealed.length > 0) {
      console.log(
        `[boot] 已密封 ${String(legacy.sealed.length)} 份含明文 seed 的历史备份：` +
          legacy.sealed.join(', ')
      )
    }
    if (legacy.failed.length > 0) {
      console.error(
        '[boot] 有历史备份未能密封（原文件未被改动）：\n' +
          legacy.failed.map((f) => `  ${f.file} —— ${f.reason}`).join('\n')
      )
    }
  } catch (err) {
    console.error(
      '[boot] 历史备份密封任务整体失败：' + (err instanceof Error ? err.message : String(err))
    )
  }

  wm = new WindowManager({
    getProfile: (id) => stores.profiles.getStored(id),
    // 状态只推给拥有这个窗口的那一个渲染进程，不做广播：
    // 否则控制台也会收到别人的标签页状态，跟着切成浏览器视图。
    onState: (state) => {
      const rec = wm?.getWindow(state.id)
      if (rec && !rec.win.isDestroyed()) {
        rec.win.webContents.send(CH.push.windowState, state)
      }
    },
    /**
     * 伪装状态变化 → 落盘 + 审计。
     *
     * 落盘只写 `Profile.maskLast`（上一次会话的结论），**门禁不读它**：
     * 重启后窗口重新测量，盘上那条必然是旧的，拿它拒绝合法操作比漏判更难查。
     * 门禁读的是进程内实时状态，见下面的 `setMaskStateLookup`。
     *
     * 为什么放在组合根而不是 windows.ts 里直接写 store：`windows.ts` 被
     * `probe-mask.cjs` 在纯 electron 脚本里加载，让它 import store 会把整条
     * 磁盘链拖进去，探针就跑不起来了 —— 与 `consent.ts` 的审计注入同一个理由。
     */
    onMaskState: (record) => {
      const { webContentsId, ...persisted } = record
      try {
        stores.profiles.setMaskLast(record.profileId, persisted)
      } catch (err) {
        // 写盘失败不能让注入流程跟着失败：状态本身已经在内存里，门禁照样拦得住。
        // 但必须喊出来 —— 否则「界面上的上次会话状态」会永久停更而无人知道。
        console.error('[boot] 伪装状态落盘失败 profile=' + record.profileId, err)
      }

      // 界面上的状态点要跟着动。放在审计判据**之前**：
      // 下面的 `if (!worth) return` 会把常态（unknown / worker 停用）挡掉，
      // 而那些恰恰是界面最该显示的 —— 拦在审计前面就等于「界面只在坏事时更新」。
      pushMaskRows()

      // ── 审计只记「值得事后追责」的那两类 ──
      //
      // 闸门前缀的记录**永不淘汰**（`AUDIT_RETAIN`），所以这里每写一条就是永久占一行。
      // 而 `'unknown'`（每次导航都会置一次）和「worker 注入停用」（每个 worker 都报）
      // 是**常态**，不是事件 —— 把它们写进永不淘汰的链，5000 条窗口很快被日常操作填满，
      // 而真正要看的「页面侧破了」被埋在里面。
      //
      // 这条判据和门禁的拦截判据是同一个：**只看 page 侧**。
      // 两处用同一个条件，才不会出现「拦了但没记」或「记了但没拦」。
      const pageBroken = record.failed.filter((f) => f.source === 'page')
      const worth = record.state === 'rolled-back' || pageBroken.length > 0
      if (!worth) return
      const attrs = pageBroken.map((f) => `${f.attr}（${f.reason}）`).join('、')
      appendAudit(
        stores,
        GATE_ACTION_PREFIX + '伪装',
        `环境 ${record.profileId}`,
        `状态=${record.state}；窗口=${String(webContentsId)}` +
          (attrs.length > 0 ? `；页面侧失败=${attrs}` : '') +
          '；不可逆动作已禁用'
      )
    },
    onProfileStopped: (profileId) => {
      const profile = stores.profiles.get(profileId)
      if (profile && profile.status !== 'idle') {
        stores.profiles.update(profileId, { status: 'idle' })
      }
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(CH.push.profileState, stores.profiles.list())
      }
      // 窗口销毁时 `WindowManager.maskStates` 里那一条已经被删了，
      // 不推一次的话界面上的红点会一直挂在这个环境上
      pushMaskRows()
    }
  })

  const runtime = new ProfileRuntime(wm)
  registerHandlers({ wm, runtime })

  // 门禁的伪装读数入口。注入而不是让 `actions.ts` 直接 import `windows.ts`：
  // 执行器要被 `tools/probe-gate.mjs` 在纯 Node 里加载，拖进 electron 就加载不了。
  //
  // 用 `wm.maskStateOf`（单个、可为 null）而不是 `listMaskStates`（数组）：
  // 数组的「空」既可能是没窗口，也可能是编号传错，调用方分不出来，
  // 而分不出来就会把「缺失」当成「没问题」。
  setMaskStateLookup((webContentsId) => wm?.maskStateOf(webContentsId) ?? null)

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
