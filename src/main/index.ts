/**
 * 主进程入口。
 *
 * 职责只有三件：装配依赖、开控制台窗口、把生命周期管好。
 * 业务逻辑一律在 core / agent / store 里，这里不写。
 */

import { app, BrowserWindow, nativeTheme, dialog, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { CH } from '@shared/ipc'
import { getStores, dataDir, sealLegacyBackups, GATE_ACTION_PREFIX } from '@main/store'
import { readWindowGeometry, writeWindowGeometry } from '@main/store/window-geometry'
import { masterKey } from '@main/core/fingerprint'
import { WindowManager, guardShellNavigation } from '@main/core/windows'
import { applyThemeMode, applyThemeToWindows, windowBackground } from '@main/core/theme'
import { ProfileRuntime } from '@main/core/profiles'
import { registerHandlers } from '@main/ipc/handlers'
import { setMaskStateLookup, setMaskExemptionLookup } from '@main/agent/actions'
import { maskRowOf } from '@main/core/mask-gate'
import { appendAudit } from '@main/modules/audit'
import { applyExtensionsToSession } from '@main/modules/extensions'
import { resolveForProfile } from '@main/modules/proxy-groups'

/**
 * 只允许单实例：两个进程同时写 profiles.json 会互相覆盖。
 *
 * ── 为什么整段初始化必须挂在 `else` 里 ──
 *
 * 这里原来是
 *
 *   if (!app.requestSingleInstanceLock()) { app.quit() }
 *
 * 之后**没有 else**，代码继续往下走：`app.whenReady().then(...)` 照样注册、
 * 照样执行。`app.quit()` 是「请求退出」，是**异步**的 —— 第二个进程会在这之前
 * 把主密钥、历史备份密封、`WindowManager`、IPC 注册、开窗全部跑一遍。
 *
 * 于是两个进程同时对同一批 JSON 做 read-modify-atomic-rename：最后写回的那个
 * 覆盖掉另一个的修改，而两边都认为自己成功了。表现出来不是崩溃，是
 * **环境 / 审计 / 设置静默丢失** —— 最难查的那一类。
 *
 * 第二个实例唯一的职责是把已经存在的控制台窗口带到前台（`second-instance`），
 * 其余一概不做。不能用 `process.exit()` 掩盖：那会跳过 Electron 的收尾
 * （单实例锁、临时目录、子进程），换成另一种「退出得不干净」。
 */
const gotLock = app.requestSingleInstanceLock()

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
  /**
   * 恢复上次的窗口几何。
   *
   * 读不到 / 损坏 / 显示器拔掉导致坐标离谱，都回退到默认值 ——
   * 这是纯展示偏好，绝不能因为它把启动搞挂（见 window-geometry.ts 的说明）。
   */
  const saved = readWindowGeometry(dataDir())
  const win = new BrowserWindow({
    x: saved?.x,
    y: saved?.y,
    width: saved?.width ?? 1360,
    height: saved?.height ?? 900,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: windowBackground(),
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

  win.once('ready-to-show', () => {
    // 最大化要等窗口显示后再设：创建时设 maximized 在部分平台上会被 show() 覆盖
    if (saved?.maximized) win.maximize()
    win.show()
  })
  // 控制台窗口同样挂着完整 preload，同样不能被顶层导航劫持
  guardShellNavigation(win)
  win.on('close', () => {
    // 关窗时记一次几何（不是 resize 时记几十次）。
    // isMaximized 时保存的 bounds 是全屏尺寸，恢复时靠 maximized 标志处理。
    try {
      const bounds = win.getBounds()
      writeWindowGeometry(dataDir(), { ...bounds, maximized: win.isMaximized() })
    } catch {
      /* 拿不到就跳过展示偏好 */
    }
  })
  win.on('closed', () => {
    consoleWindow = null
  })
  loadRenderer(win)
  return win
}

if (gotLock) {
  /* ── 只有拿到锁的进程才注册这些生命周期 ──
   *
   * `second-instance` 必须由**持有锁的那个进程**处理（它把控制台窗口带到前台），
   * 第二个进程在 `else` 里直接退出，不需要也不应该注册这些。 */

  /**
   * 自建应用菜单。
   *
   * 不建菜单 = 用 Electron 的**默认菜单**，而默认菜单的加速键是 App 全局的：
   *   - Ctrl+W（窗口→关闭）关掉的是**整个环境窗口**，不是当前标签页；
   *   - Ctrl+R（视图→重新加载）重载的是**整个界面**，不是当前网页；
   *   - Ctrl+Shift+I（视图→开发者工具）能在**网页视图**上打开 DevTools，
   *     把注入脚本与伪装台账一览无余。
   *
   * 菜单栏虽然 `autoHideMenuBar` 藏起来了，但加速键照样生效 ——
   * 这正是"界面看着没有菜单，行为却像个普通 Electron 应用"的原因。
   *
   * 所以这里显式建一个**只有编辑与开发者工具**的菜单：
   * 撤销/重做/剪切/复制/粘贴/全选留着（浏览器里到处要用），
   * 冲突的加速键一个不留。
   */
  const menuTemplate: MenuItemConstructorOptions[] = []
  if (process.platform === 'darwin') {
    // macOS 的应用菜单（关于/退出/服务）不能丢，那是系统约定
    menuTemplate.push({ role: 'appMenu' })
  }
  menuTemplate.push({
    label: '编辑',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' }
    ]
  })
  menuTemplate.push({
    label: '开发者工具',
    submenu: [{ role: 'toggleDevTools', accelerator: 'F12' }]
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate))

  app.on('second-instance', () => {
    if (consoleWindow && !consoleWindow.isDestroyed()) {
      if (consoleWindow.isMinimized()) consoleWindow.restore()
      consoleWindow.focus()
      return
    }
    // 控制台已经不在了 → **重建**它。
    //
    // 原先这里是空的 if，什么也不做：控制台窗口被用户关掉之后，
    // 再双击 exe 也开不回来（Windows 上 app.on('activate') 根本不触发），
    // 而环境窗口还开着 → `window-all-closed` 不触发 → App 成了一个
    // "有浏览器、没控制台、也回不去"的孤儿，只能任务管理器杀进程。
    consoleWindow = createConsoleWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    // 网页视图是独立进程，不显式关会残留
    void wm?.closeAll()
  })

  void app.whenReady().then(() => {
    // 主题必须在开窗之前定下来：开窗后再设 themeSource，首帧已经用错底色画完了
    applyThemeMode(getStores().settings.get().theme)
    // 系统偏好变化（且模式是 'system'）时，Electron 会发这条事件
    nativeTheme.on('updated', applyThemeToWindows)

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
        '[boot] 主密钥不可用，指纹派生会失败：' +
          (err instanceof Error ? err.message : String(err))
      )
    }

    const stores = getStores()

    /**
     * 启动时校验「当前操作者」。
     *
     * activeMemberId 可能指向一个**不存在或已禁用**的成员：
     * 手工改过 settings.json、从旧版本数据迁上来、或还原了一份成员列表
     * 与设置不一致的备份。而 resolveActor() 对这种情况是抛错的（fail-closed，
     * 正确），于是所有走 ACL 的操作全部失效，用户看到的只是莫名其妙的报错。
     *
     * 复位到空 = 本机所有者（全权限），与"删/禁成员时复位"同一条规则。
     */
    try {
      const active = stores.settings.get().activeMemberId
      if (active !== undefined && active !== '') {
        const member = stores.members.list().find((m) => m.id === active)
        if (member === undefined || member.disabled) {
          stores.settings.set({ activeMemberId: '' })
          console.warn(`[boot] 当前操作者 ${active} 已不存在或已禁用，已复位为所有者`)
        }
      }
    } catch (err) {
      // 校验失败不阻断启动：成员/设置文件读不出来时后续路径会各自报错
      console.error(
        '[boot] 当前操作者校验失败：' + (err instanceof Error ? err.message : String(err))
      )
    }

    /**
     * 启动时把残留的「运行中」归零。
     *
     * 进程刚起来时不可能有环境在跑（窗口都还没建），
     * 所以盘上任何 `status: 'running'` 都只可能是上一次异常退出留下的。
     * 不清掉的话，控制台会显示一个根本不存在的"运行中"环境，
     * 而且用户点「停止」也消不掉（运行时内存里没有它的记录）。
     */
    try {
      const reset = stores.profiles.resetRunningToIdle()
      if (reset > 0) {
        console.warn(`[boot] 已把 ${String(reset)} 个残留的"运行中"状态归零（上次异常退出）`)
      }
    } catch (err) {
      // 归零失败不阻断启动：profiles.json 读不出来时下面的读路径会降级，
      // 这里再抛一次只会让应用起不来
      console.error(
        '[boot] 归零残留状态失败：' + (err instanceof Error ? err.message : String(err))
      )
    }

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
      // 扩展在环境启动时装载到该环境的 session 上。放在组合根注入：
      // windows.ts 不认识 store，也不该认识 —— 它要能被纯 electron 探针单独加载。
      applyExtensions: (ses, profile) => applyExtensionsToSession(ses, stores, profile),
      // 代理组出口解析：每次开窗都重新按策略选一条，结果只用于这次 session，不落盘。
      // 组内全不通时直接抛错 -> 环境起不来，绝不退回直连（见 proxy-groups.ts）。
      resolveProxyGroup: (profile) => resolveForProfile(profile, stores),
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

        /* ── 伪装修好了就自动收回豁免 ──
         *
         * `allowUnmaskedL2` 是给「修不好但必须跑」的流水线用的，不是常开开关。
         * 一旦这个环境的伪装回到 `ok`，继续保留豁免就只是留了一个没人再看的安全洞。
         *
         * 收回要留痕：`revokeExemption` 返回「是否真的收回了一条」，
         * 所以「收回了」和「本来就没开」不会混成同一件事。
         * 这条审计进的是 GATE 前缀 —— 它记录的是「一个安全开关被关掉了」，
         * 属于事后要能查到的那类。 */
        if (record.state === 'ok') {
          try {
            if (stores.profiles.revokeExemption(record.profileId)) {
              appendAudit(
                stores,
                GATE_ACTION_PREFIX + '伪装',
                `环境 ${record.profileId}`,
                `伪装已回到 ok，环境级豁免（allowUnmaskedL2）已自动收回；` +
                  `此后不可逆动作重新要求伪装完整`
              )
              for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed()) win.webContents.send(CH.push.profileState, stores.profiles.list())
              }
            }
          } catch (err) {
            console.error('[boot] 收回伪装豁免失败 profile=' + record.profileId, err)
          }
        }

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

    const runtime = new ProfileRuntime(wm, (profileId, status, error) => {
      // 把运行状态真正写回 Profile.status。
      // 以前这个字段从没被写过，于是卡片上的「失败」红标恒为 false、
      // 控制台的「运行中 N / 需要关注 N」恒为 0 —— 两处都是死代码。
      try {
        stores.profiles.update(profileId, {
          status,
          ...(status === 'error' ? { lastError: error ?? '启动失败' } : {})
        })
      } catch (err) {
        // 状态写不进去不能让启动失败：它是展示用的派生信息。
        console.error('[boot] 环境状态写入失败 profile=' + profileId, err)
      }
    })
    registerHandlers({ wm, runtime })

    // 门禁的伪装读数入口。注入而不是让 `actions.ts` 直接 import `windows.ts`：
    // 执行器要被 `tools/probe-gate.mjs` 在纯 Node 里加载，拖进 electron 就加载不了。
    //
    // 用 `wm.maskStateOf`（单个、可为 null）而不是 `listMaskStates`（数组）：
    // 数组的「空」既可能是没窗口，也可能是编号传错，调用方分不出来，
    // 而分不出来就会把「缺失」当成「没问题」。
    //
    // 这里的 `webContentsId` 是**标签页**的 wc.id（由 `Approval.maskWebContentsId`
    // 传入），不是控制台窗口 renderer 的 id —— 两者的键空间不同，混用就会永远查不到。
    setMaskStateLookup((webContentsId) => wm?.maskStateOf(webContentsId) ?? null)

    /* 「这个环境是否被豁免了伪装闸门」。
     *
     * 读的是**盘上的配置**（`Profile.allowUnmaskedL2`），不是状态记录 —— 豁免是配置。
     * 查不到环境一律当未豁免：`?.` 之后的 `=== true` 让 undefined / null 都落到 false，
     * 默认值必须是安全方向。
     *
     * 为什么按 profileId 而不是 webContentsId：豁免是环境的属性，
     * 同一个环境开两个窗口应该一致；按窗口查会把「配置」写成「每个窗口一份」。 */
    setMaskExemptionLookup((profileId) => stores.profiles.get(profileId)?.allowUnmaskedL2 === true)

    consoleWindow = createConsoleWindow()

    app.on('activate', () => {
      // 判据是「没有控制台窗口」，不是「一个窗口都没有」：
      // 环境窗口开着、控制台被关掉时，App 就是一个回不去的孤儿。
      if (!consoleWindow || consoleWindow.isDestroyed()) {
        consoleWindow = createConsoleWindow()
      }
    })
  }).catch((err: unknown) => {
    // 启动链上任何一步抛错（最常见的是数据目录不可写：磁盘满 / 用户目录只读 /
    // OneDrive 掉线 / 杀软锁目录），以前都会变成未捕获的 Promise 拒绝 ——
    // Node 15+ 直接把主进程打退出，**没有窗口、没有对话框、日志在用户看不到的地方**。
    // 用户的体验是「双击没反应」，而且连打开界面去修的机会都没有。
    const message = err instanceof Error ? err.message : String(err)
    console.error('[boot] 启动失败：' + message)
    try {
      dialog.showErrorBox(
        'ShadowSurf 启动失败',
        '数据目录不可用，应用无法启动。\n\n' +
          message +
          '\n\n常见原因：磁盘已满、用户目录只读、网盘（OneDrive 等）未同步、或安全软件锁住了目录。\n' +
          '请在磁盘上腾出空间或解除目录占用后重试。'
      )
    } catch {
      // 连对话框都弹不出来（例如无 GUI 环境）时，至少留一条日志
    }
    app.exit(1)
  })
} else {
  // 第二个实例：唯一的职责是退出。
  //
  // 注意这里**什么都不做**：不读主密钥、不封历史备份、不建 `WindowManager`、
  // 不注册 IPC、不开窗。`second-instance` 由上面那个持有锁的进程处理，
  // 本进程的事件循环里只剩 Electron 自己的东西，`app.quit()` 会正常收尾。
  app.quit()
}