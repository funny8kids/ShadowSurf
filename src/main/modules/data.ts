/**
 * 浏览数据模块。
 *
 * 职责：
 * - Cookie 查看与清理（每个环境一个 persist:ss_<id> 分区，天然隔离）
 * - 下载记录（session 的 will-download 事件，只活在本次进程内存里）
 * - 历史记录（web-contents-created + did-navigate，落 stores.history）
 *
 * 归属：data-agent
 */

import { app, session } from 'electron'
import type { DownloadItem as ElectronDownloadItem, Session, WebContents } from 'electron'
import { CH } from '@shared/ipc'
import type { CookieItem, DownloadItem, HistoryItem } from '@shared/types'
import { CollectionStore } from '@main/store'
import { partitionFor } from '@main/core/session'
import type { ModuleContext } from './context'

/* ────────────────────────────── 模块级状态 ────────────────────────────── */

/**
 * 下载记录只放内存。
 * 它描述的是「这次进程里正在传输 / 刚刚传输完」的文件，重启后残留的旧进度
 * 既不可续传也不可信，写盘只会让人误以为还能继续下。
 */
const downloads: DownloadItem[] = []

/** 上限保护：长时间挂机下载会把数组撑爆，超出丢最旧的 */
const DOWNLOAD_LIMIT = 200

/**
 * 已经挂过 will-download 的 partition。
 * session 对象是按 partition 复用的，重复挂监听会让同一次下载被记两条，
 * 所以用 partition 字符串做去重键。
 */
const watchedPartitions = new Set<string>()

/** Cookie 的 domain 可能带前导点（表示对子域生效），拼 URL 时要剥掉 */
type RawCookie = Awaited<ReturnType<Session['cookies']['get']>>[number]

/* ────────────────────────────── 注册 ────────────────────────────── */

export function registerDataModule(ctx: ModuleContext): void {
  const stores = ctx.stores

  /* ── Cookie ── */

  ctx.handle(CH.data.cookies, async (_event, raw) => {
    const ses = session.fromPartition(partitionFor(requireProfileId(raw)))
    const list = await ses.cookies.get({})
    // 按域名再按名字排序：同一站点的 Cookie 聚在一起，肉眼比对会话是否被清干净更直观
    return list
      .map(toCookieItem)
      .sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name))
  })

  ctx.handle(CH.data.clearCookies, async (_event, raw) => {
    const ses = session.fromPartition(partitionFor(requireProfileId(raw)))
    const before = await ses.cookies.get({})

    for (const cookie of before) {
      const url = cookieUrl(cookie)
      if (!url) continue
      try {
        await ses.cookies.remove(url, cookie.name)
      } catch (err) {
        // 单条删不掉不该让整批失败：HttpOnly 之外的边界情况（例如同名的
        // host-only 与 domain Cookie）逐条报错更利于排查
        console.warn('[data] 删除 Cookie 失败', cookie.domain, cookie.name, err)
      }
    }

    // 用「删前删后条数差」而不是「remove 调用次数」：一次 remove 可能带走
    // 同名不同 path 的多条，也可能因为 URL 不匹配静默失败，差值才是真实结果。
    const after = await ses.cookies.get({})
    return Math.max(0, before.length - after.length)
  })

  /* ── 下载 ── */

  ctx.handle(CH.data.downloads, () => {
    // 每次拉取时补挂一遍：面板打开通常意味着用户马上要在新环境里下载东西，
    // 这是把「注册后新建的环境漏挂监听」这个缺口补上的最低成本时机。
    ensureDownloadWatchers(ctx)
    return downloads.slice().sort((a, b) => b.startedAt - a.startedAt)
  })

  ctx.handle(CH.data.clearDownloads, () => {
    // 只清展示用的记录，不取消正在进行中的下载：用户点的是「清空列表」，
    // 不是「中止传输」，擅自 cancel 会让人丢掉已经下了一半的文件。
    downloads.length = 0
  })

  /* ── 历史 ── */

  ctx.handle(CH.data.history, (_event, raw) => {
    const profileId = requireProfileId(raw)
    return stores.history
      .list()
      .filter((item) => item.profileId === profileId)
      .sort((a, b) => b.at - a.at)
  })

  ctx.handle(CH.data.clearHistory, (_event, raw) => {
    const profileId = requireProfileId(raw)
    const all = stores.history.list()
    const kept = all.filter((item) => item.profileId !== profileId)
    const removed = all.length - kept.length
    // 逐条 remove 会触发 N 次落盘（历史上限 2000），一次性 replaceAll 只写一次
    if (removed > 0) stores.history.replaceAll(kept)
    return removed
  })

  /* ── 事件接线 ── */

  ensureDownloadWatchers(ctx)
  watchNavigation(stores)
}

/* ────────────────────────────── Cookie 辅助 ────────────────────────────── */

function requireProfileId(raw: unknown): string {
  const id = String(raw ?? '').trim()
  if (!id) throw new Error('缺少环境 ID')
  return id
}

function toCookieItem(cookie: RawCookie): CookieItem {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? '',
    path: cookie.path ?? '/',
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    // Electron 对会话 Cookie 不给 expirationDate，这个缺失本身就是唯一可靠的判据
    session: cookie.expirationDate === undefined,
    // Electron 给的是秒级时间戳，渲染层统一按毫秒处理，在边界处换算一次
    expires: cookie.expirationDate === undefined ? undefined : Math.round(cookie.expirationDate * 1000)
  }
}

/**
 * 还原出能匹配到这条 Cookie 的 URL。
 * cookies.remove 是按 URL + name 匹配的，path 不带进 URL 的话，
 * 挂在 /foo 下的 Cookie 会删不掉。domain 为空（理论上不该出现）时直接跳过。
 */
function cookieUrl(cookie: RawCookie): string | null {
  const host = (cookie.domain ?? '').replace(/^\./, '')
  if (!host) return null
  const path = cookie.path && cookie.path.startsWith('/') ? cookie.path : '/'
  return `${cookie.secure ? 'https' : 'http'}://${host}${path}`
}

/* ────────────────────────────── 下载监听 ────────────────────────────── */

/**
 * 给每个环境的 partition 挂 will-download。
 *
 * 已知缺口：这里只覆盖「注册那一刻已经存在的环境」。模块注册之后新建的环境
 * 不会被自动挂上监听，得等到下一次打开数据面板（downloads 通道会再扫一遍）
 * 才会补挂；在那之前它产生的下载不会出现在列表里。真正的解法是让 profiles
 * 模块在 create 之后发一个事件，但那条线不归本模块改。
 */
function ensureDownloadWatchers(ctx: ModuleContext): void {
  for (const profile of ctx.stores.profiles.list()) {
    const partition = partitionFor(profile.id)
    if (watchedPartitions.has(partition)) continue
    watchedPartitions.add(partition)
    // 先登记再取 session：即使后面取 session 抛错，也不会在同一 partition 上
    // 反复重试导致监听叠加
    const ses = session.fromPartition(partition)
    ses.on('will-download', (_event, item) => trackDownload(ctx, profile.id, item))
  }
}

function trackDownload(
  ctx: ModuleContext,
  profileId: string,
  item: ElectronDownloadItem
): void {
  const record: DownloadItem = {
    id: CollectionStore.newId('dld'),
    profileId,
    filename: item.getFilename(),
    url: item.getURL(),
    savePath: item.getSavePath(),
    state: 'progressing',
    received: item.getReceivedBytes(),
    total: item.getTotalBytes(),
    startedAt: Date.now()
  }

  // 新的排最前：面板按时间倒序展示，这里直接 unshift 省掉渲染层排序
  downloads.unshift(record)
  if (downloads.length > DOWNLOAD_LIMIT) downloads.length = DOWNLOAD_LIMIT
  ctx.broadcast(CH.push.download, { ...record })

  item.on('updated', (_event, state) => {
    record.received = item.getReceivedBytes()
    record.total = item.getTotalBytes()
    // savePath 要等用户确认保存对话框之后才有值，updated 阶段补一次
    record.savePath = item.getSavePath() || record.savePath
    if (state === 'interrupted') record.state = 'interrupted'
    ctx.broadcast(CH.push.download, { ...record })
  })

  item.on('done', (_event, state) => {
    record.state = state
    record.received = item.getReceivedBytes()
    // 中断时 total 可能归零，保留上一次已知的总量，进度条才不会突然跳回 0%
    record.total = item.getTotalBytes() || record.total
    record.savePath = item.getSavePath() || record.savePath
    // 广播副本：主进程后续还会改 record，直接送引用会让渲染层拿到「未来」的值
    ctx.broadcast(CH.push.download, { ...record })
  })
}

/* ────────────────────────────── 历史采集 ────────────────────────────── */

function watchNavigation(stores: ModuleContext['stores']): void {
  /** session 对象没有可反查的 partition 名，只能用对象身份反推归属环境 */
  const ownerBySession = new Map<Session, string>()
  let mappedCount = -1

  const rebuildOwners = (): void => {
    const profiles = stores.profiles.list()
    mappedCount = profiles.length
    ownerBySession.clear()
    for (const profile of profiles) {
      ownerBySession.set(session.fromPartition(partitionFor(profile.id)), profile.id)
    }
  }

  const ownerOf = (ses: Session): string | null => {
    const hit = ownerBySession.get(ses)
    if (hit) return hit
    // 环境可能在模块注册之后才创建。用「环境数量」当变更信号重建映射，
    // 比每次导航都读一遍环境库便宜得多；代价是「删一个再建一个」这种
    // 数量不变的情况要等下一次数量变化才认得出新环境。
    if (stores.profiles.list().length !== mappedCount) {
      rebuildOwners()
      return ownerBySession.get(ses) ?? null
    }
    return null
  }

  rebuildOwners()

  /** 每个 webContents 最近一次记录的 URL 与历史 id，用于去重和补标题 */
  const lastUrl = new Map<number, string>()
  const lastRecordId = new Map<number, string>()

  app.on('web-contents-created', (_event, wc: WebContents) => {
    wc.on('did-navigate', (_e, url) => {
      const recordId = recordVisit(wc, url)
      if (recordId) lastRecordId.set(wc.id, recordId)
    })

    // did-navigate 触发时新页面的标题还没解析出来，只能等标题事件回来再补。
    // 拿不到就保留 URL 当标题，总比空一行强。
    wc.on('page-title-updated', (_e, title) => {
      const recordId = lastRecordId.get(wc.id)
      if (!recordId) return
      const next = title.trim()
      if (!next) return
      const record = stores.history.get(recordId)
      if (!record || record.title === next) return
      try {
        stores.history.update(recordId, { title: next })
      } catch {
        // 记录可能刚被「清空历史」删掉，补标题失败无需打扰用户
      }
    })

    wc.once('destroyed', () => {
      lastUrl.delete(wc.id)
      lastRecordId.delete(wc.id)
    })
  })

  function recordVisit(wc: WebContents, url: string): string | null {
    // 只记真实的网页跳转：about:blank、devtools://、chrome-extension:// 这类
    // 不是用户行为，记进去只会污染历史列表
    if (!/^https?:\/\//i.test(url)) return null

    const profileId = ownerOf(wc.session)
    // 找不到归属就跳过。宁可少记，也不能把控制台窗口自己的页面记到某个环境头上，
    // 那等于凭空给一个身份留下它从未访问过的痕迹。
    if (!profileId) return null

    // 刷新同一地址不重复记一条：did-navigate 在 reload 时也会触发
    if (lastUrl.get(wc.id) === url) return null
    lastUrl.set(wc.id, url)

    const item: HistoryItem = {
      id: CollectionStore.newId('hst'),
      profileId,
      url,
      title: wc.getTitle() || url,
      at: Date.now()
    }
    stores.history.add(item)
    return item.id
  }
}
