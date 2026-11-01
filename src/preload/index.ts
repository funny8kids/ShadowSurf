/**
 * preload：主进程与渲染层之间唯一的桥。
 *
 * 三件事：
 * 1. 把 `Result<T>` 拆包——渲染层只写 try/catch，不关心 ok 字段；
 * 2. 把 `ss:push:*` 通道包装成返回取消函数的订阅；
 * 3. 把渲染层的布局矩形翻译成主进程能直接用的 ContentInsets。
 *
 * 注意：这里绝不暴露 ipcRenderer 本身。渲染层能调用的通道是白名单，
 * 一旦开放任意 invoke，XSS 就等于拿到了主进程。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { CH } from '@shared/ipc'
import type { ContentInsetsPayload, ShadowSurfAPI } from '@shared/ipc'
import type { Result } from '@shared/types'

// preload 运行在渲染进程里，确实有 window；但 tsconfig.node 不带 DOM lib，
// 这里只声明真正用到的那一个属性，不把整个 DOM 类型引进主进程。
declare const window: { innerHeight: number }

/** 统一的 invoke 包装：失败时抛错，让渲染层用 try/catch 处理 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as Result<T> | T
  if (res !== null && typeof res === 'object' && 'ok' in (res as Record<string, unknown>)) {
    const wrapped = res as Result<T>
    if (wrapped.ok) return wrapped.data
    const err = new Error(wrapped.error?.message ?? '操作失败') as Error & {
      code?: string
      detail?: string
      lostFields?: string[]
    }
    err.code = wrapped.error?.code
    err.detail = wrapped.error?.detail
    // 结构化补充信息必须原样过桥。丢了它，`legacy-identity-loss` 在渲染层
    // 就只剩一句「身份会变」的泛泛之谈 —— 而那个对话框的全部价值就在于
    // 把「具体变哪几项」摆到用户面前。
    err.lostFields = wrapped.error?.lostFields
    throw err
  }
  return res as T
}

/** 订阅推送通道，返回取消函数（React 的 useEffect 直接 return 它） */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: ShadowSurfAPI = {
  profiles: {
    list: () => invoke(CH.profiles.list),
    get: (id) => invoke(CH.profiles.get, id),
    create: (input) => invoke(CH.profiles.create, input),
    update: (id, patch) => invoke(CH.profiles.update, id, patch),
    remove: (id) => invoke(CH.profiles.remove, id),
    clone: (id, opts) => invoke(CH.profiles.clone, id, opts),
    launch: (id) => invoke(CH.profiles.launch, id),
    stop: (id) => invoke(CH.profiles.stop, id),
    regenerate: (id) => invoke(CH.profiles.regenerate, id)
  },

  window: {
    open: (profileId) => invoke(CH.window.open, profileId),
    close: (windowId) => invoke(CH.window.close, windowId),
    newTab: (windowId, url) => invoke(CH.window.newTab, windowId, url),
    closeTab: (windowId, tabId) => invoke(CH.window.closeTab, windowId, tabId),
    activateTab: (windowId, tabId) => invoke(CH.window.activateTab, windowId, tabId),
    navigate: (windowId, tabId, url) => invoke(CH.window.navigate, windowId, tabId, url),
    back: (windowId, tabId) => invoke(CH.window.back, windowId, tabId),
    forward: (windowId, tabId) => invoke(CH.window.forward, windowId, tabId),
    reload: (windowId, tabId) => invoke(CH.window.reload, windowId, tabId),
    stopLoading: (windowId, tabId) => invoke(CH.window.stopLoading, windowId, tabId),

    setContentInsets: (payload: ContentInsetsPayload) => {
      // 高频调用（拖拽 / resize），走 send 不等待回执；主进程会自行节流布局
      ipcRenderer.send(CH.window.setContentInsets, {
        top: Math.round(payload.top),
        // 底部控制条的高度只能由渲染层量：主进程只知道窗口尺寸
        bottom: Math.max(0, Math.round(window.innerHeight - payload.top - payload.height)),
        left: Math.round(payload.left),
        // 侧栏在右侧，右侧留白就是侧栏宽度
        right: Math.round(payload.panelWidth),
        panelWidth: Math.round(payload.panelWidth)
      })
    },

    onState: (cb) => subscribe(CH.push.windowState, cb)
  },

  agent: {
    run: (req) => invoke(CH.agent.run, req),
    cancel: () => invoke(CH.agent.cancel),
    // 这里原本有 confirm(approved)。它已经随通道一起删掉：
    // 渲染层不能断言「用户同意了」，只能请求（run）或取消（cancel）。
    snapshot: (profileId, tabId) => invoke(CH.agent.snapshot, profileId, tabId),
    onEvent: (cb) => subscribe(CH.push.agentEvent, cb)
  },

  tasks: {
    list: () => invoke(CH.tasks.list),
    get: (id) => invoke(CH.tasks.get, id),
    clear: () => invoke(CH.tasks.clear),
    onUpdate: (cb) => subscribe(CH.push.taskUpdate, cb)
  },

  settings: {
    get: () => invoke(CH.settings.get),
    set: (patch) => invoke(CH.settings.set, patch),
    test: (patch) => invoke(CH.settings.test, patch)
  },

  system: {
    info: () => invoke(CH.system.info),
    openExternal: (url) => invoke(CH.system.openExternal, url),
    storeHealth: () => invoke(CH.system.storeHealth)
  },

  proxies: {
    list: () => invoke(CH.proxies.list),
    create: (input) => invoke(CH.proxies.create, input),
    update: (id, patch) => invoke(CH.proxies.update, id, patch),
    remove: (id) => invoke(CH.proxies.remove, id),
    import: (text) => invoke(CH.proxies.import, text),
    check: (id) => invoke(CH.proxies.check, id),
    checkAll: () => invoke(CH.proxies.checkAll),
    apply: (profileId, proxyId) => invoke(CH.proxies.apply, profileId, proxyId)
  },

  templates: {
    list: () => invoke(CH.templates.list),
    save: (fromProfileId, name, description) =>
      invoke(CH.templates.save, fromProfileId, name, description),
    apply: (templateId, profileId) => invoke(CH.templates.apply, templateId, profileId),
    remove: (id) => invoke(CH.templates.remove, id)
  },

  migration: {
    export: (profileIds, password) => invoke(CH.migration.export, profileIds, password),
    import: (json, password, acceptLegacyIdentityLoss) =>
      invoke(CH.migration.import, json, password, acceptLegacyIdentityLoss)
  },

  scripts: {
    list: () => invoke(CH.scripts.list),
    get: (id) => invoke(CH.scripts.get, id),
    save: (script) => invoke(CH.scripts.save, script),
    remove: (id) => invoke(CH.scripts.remove, id),
    run: (scriptId, profileId, options) => invoke(CH.scripts.run, scriptId, profileId, options)
  },

  audit: {
    list: (limit) => invoke(CH.audit.list, limit),
    verify: () => invoke(CH.audit.verify)
  },

  selfcheck: {
    run: (profileId) => invoke(CH.selfcheck.run, profileId)
  },

  data: {
    cookies: (profileId) => invoke(CH.data.cookies, profileId),
    clearCookies: (profileId) => invoke(CH.data.clearCookies, profileId),
    downloads: () => invoke(CH.data.downloads),
    clearDownloads: () => invoke(CH.data.clearDownloads),
    history: (profileId) => invoke(CH.data.history, profileId),
    clearHistory: (profileId) => invoke(CH.data.clearHistory, profileId),
    onDownload: (cb) => subscribe(CH.push.download, cb)
  },

  localApi: {
    state: () => invoke(CH.localApi.state),
    start: (port) => invoke(CH.localApi.start, port),
    stop: () => invoke(CH.localApi.stop),
    // 只把令牌写进剪贴板，不返回明文 —— 渲染层拿不到它
    copyToken: () => invoke(CH.localApi.copyToken),
    onState: (cb) => subscribe(CH.push.localApiState, cb)
  }
}

contextBridge.exposeInMainWorld('ss', api)
