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
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CH } from '@shared/ipc'
import type { CookieExportFormat, CookieImportSummary } from '@shared/ipc'
import type { BackupFile, DownloadItem, HistoryItem } from '@shared/types'
import { CollectionStore, dataDir } from '@main/store'
import { appendAudit, flushAudit } from '@main/modules/audit'
import { partitionFor } from '@main/core/session'
import type { ModuleContext } from './context'
import {
  capErrors,
  cookieUrlFor,
  exportCookies,
  exportCookiesJson,
  importCookies,
  toCookieInfo
} from './cookie-io'
import type { ImportedCookie } from './cookie-io'

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
 * 下载进度广播的最小间隔（毫秒）。
 *
 * 为什么必须节流：`updated` 是 Electron 按「数据块到达」触发的，一个大文件
 * 每秒能来几十到几百次。每次都 `ctx.broadcast` 的话，主进程要把整条记录
 * 序列化一遍、渲染层要把列表里几百行重新 diff 一遍 —— 两头一起被淹，
 * 表现是下载一开始界面就卡。150ms ≈ 每秒最多 6~7 次，肉眼看到的进度仍然连续。
 *
 * 终态（done）不走节流：那是「这次传输的结果」，必须立刻到；被节流跳过的那几帧
 * 也不会丢，下一次通过节流的事件或 done 会带上最新的累计字节数。
 */
const DOWNLOAD_EMIT_INTERVAL_MS = 150

/**
 * 每条下载记录上次广播 `updated` 的时间戳。
 *
 * 按 item id 记：并发下多个文件各自有自己的节奏，用一条全局时间戳会让
 * 后开始的文件被前一个文件的窗口挡住。
 */
const lastDownloadEmit = new Map<string, number>()

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
    const profileId = requireProfileId(raw)
    // 环境必须真实存在：session.fromPartition 会为任何字符串造一个分区，
    // 传一个不存在的 id 会读回空列表，用户看到的是「这个环境很干净」——
    // 那是关于一个不存在对象的断言。与 export / import 同一道校验。
    requireProfile(ctx, profileId)
    const ses = session.fromPartition(partitionFor(profileId))
    const list = await ses.cookies.get({})
    // 按域名再按名字排序：同一站点的 Cookie 聚在一起，肉眼比对会话是否被清干净更直观
    return list
      .map(toCookieInfo)
      .sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name))
  })

  /**
   * 导出某个环境的 Cookie。
   *
   * 返回的是**文件内容**而不是结构化列表：格式知识（Netscape / JSON 的字段、
   * 单位、HttpOnly 前缀）必须只有一份，而它属于主进程 —— 散到渲染层就会漂移，
   * 漂移的症状是「导出的文件别的工具读不出来」。
   */
  ctx.handle(CH.data.exportCookies, async (_event, rawProfileId, rawFormat) => {
    const profileId = requireProfileId(rawProfileId)
    requireProfile(ctx, profileId)
    const format: CookieExportFormat = rawFormat === 'json' ? 'json' : 'netscape'

    const ses = session.fromPartition(partitionFor(profileId))
    // 读不到 ≠ 不存在：读失败必须变成错误，不能变成「这个环境没有 Cookie」
    const list = await readCookies(ses, profileId)
    const cookies = list.map(toCookieInfo)
    return format === 'json' ? exportCookiesJson(cookies) : exportCookies(cookies)
  })

  /**
   * 导入 Cookie 到某个环境。
   *
   * 两条硬规则：
   *
   * 1. **写失败的必须报出来。** 逐条 `cookies.set`，失败就记进错误列表。
   *    静默跳过的话，用户会看到「导入成功」而实际少了一半会话 —— 那种事比报错坏得多。
   * 2. **格式自动识别。** Netscape 文本还是 JSON，由 cookie-io 判定，坏行逐条报错。
   */
  ctx.handle(CH.data.importCookies, async (_event, rawProfileId, rawText): Promise<CookieImportSummary> => {
    const profileId = requireProfileId(rawProfileId)
    // 环境必须真实存在：写到一个不存在的 partition 里，等于凭空造一份没人认领的会话
    requireProfile(ctx, profileId)
    const text = typeof rawText === 'string' ? rawText : ''

    const parsed = importCookies(text)
    const ses = session.fromPartition(partitionFor(profileId))

    let imported = 0
    const failures: string[] = []
    for (const cookie of parsed.cookies) {
      try {
        await ses.cookies.set(toSetDetails(cookie))
        imported += 1
      } catch (err) {
        failures.push(
          `「${cookie.name}」（${cookie.domain}）写入失败：${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }

    // 解析错误与写入错误合并后统一封顶：两边的上限必须一致，
    // 否则「解析错误占满 10 条 + 写入错误再给 10 条」会让界面上的错误列表长度不可预测
    const errors = capErrors([...parsed.errors, ...failures], '条')
    // failed 必须同时覆盖「提交了但没写进去」和「压根没解析出来」两种失败。
    // 只算 failures.length 的话，全坏输入会得到 {imported:0, failed:0, errors:[…]}，
    // 界面据此显示「已导入 0 条，全部成功」—— 一句与事实完全相反的绿灯。
    return { imported, failed: failures.length + parsed.rejected, errors }
  })

  ctx.handle(CH.data.clearCookies, async (_event, raw) => {
    const profileId = requireProfileId(raw)
    // 环境必须真实存在，否则这里会先 `session.fromPartition` **凭空建出一个分区目录**，
    // 再对它做一遍「读-删-读」并返回 0：用户以为清干净了，盘上却多了一份
    // 没人认领的 partition。与 export / import 同一道校验。
    requireProfile(ctx, profileId)
    const ses = session.fromPartition(partitionFor(profileId))
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
    // 节流表跟着一起清：留着旧 id 只会让这张 Map 随着开关面板无限长大
    lastDownloadEmit.clear()
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

  /* ── 整机备份 / 还原 ── */

  /**
   * 整机备份：把整个数据目录加密成一个文件。
   *
   * 备份的是**配置与身份**（环境、指纹、代理、团队、审计、脚本），
   * 不含浏览器的 Cookie / IndexedDB —— 那些在各环境的分区里，
   * 由站点自己的同步机制负责。
   *
   * 加密密钥由 `safeStorage` 派生：**只有同一台机器、同一个系统账户**能还原。
   * 这是刻意的取舍 —— 免去"备份文件可以随便发给别人"的隐患，
   * 代价是换机器还原不了（换机器请用迁移包）。
   */
  ctx.handle(CH.data.backup, async () => {
    const { createBackup } = await import('@main/store/backup')
    const path = await createBackup(dataDir())
    appendAudit(stores, '数据·备份', '本机工作区', path, 'local')
    return { path }
  })

  /** 备份目录里的文件列表（按写入时间倒序，最新的在最前） */
  ctx.handle(CH.data.backupList, async () => {
    const { backupsDir } = await import('@main/store/backup')
    const dir = backupsDir(dataDir())
    if (!existsSync(dir)) return []
    const files: BackupFile[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ssbak')) continue
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (!st.isFile()) continue
        files.push({ name, path: full, size: st.size, createdAt: st.mtimeMs })
      } catch {
        // 读不到就跳过这一条：备份列表是辅助信息，
        // 一条坏记录不该让整个列表报不出来
        continue
      }
    }
    return files.sort((a, b) => b.createdAt - a.createdAt)
  })

  /**
   * 还原时保留下来的旧数据目录。
   *
   * 只报位置与大小，**不提供删除**：那是用户还原前的唯一完整数据，
   * 误删的代价远大于让它多占一点磁盘。
   */
  ctx.handle(CH.data.backupKeptDirs, async () => {
    const { listKeptDirs } = await import('@main/store/backup')
    return listKeptDirs(dataDir())
  })

  /**
   * 整机还原。
   *
   * 不可逆：当前数据目录会被整体改名保留成 `.bak-<ts>`，新目录写入备份内容。
   * 保留的那份**不自动删** —— 用户确认没问题后自己清理。
   *
   * 还原前先把审计缓冲写干净：旧链会被完整保留在 `.bak-` 里，
   * 否则旧链最后几条只存在于内存，还原后就永远没了。
   */
  ctx.handle(CH.data.restore, async (_event, raw) => {
    const path = typeof raw === 'string' ? raw : ''
    if (path === '') throw new Error('请选择要还原的备份文件')
    const { restoreBackup } = await import('@main/store/backup')
    flushAudit(stores)
    const result = await restoreBackup(path, dataDir(), ctx.runtime)
    appendAudit(
      stores,
      '数据·还原',
      '本机工作区',
      `已还原 ${result.fileCount} 个文件；旧数据保留在 ${result.keeperPath}`,
      'local'
    )
    return { keeperPath: result.keeperPath, fileCount: result.fileCount }
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

/**
 * 环境必须真实存在。
 *
 * 为什么这一步不能省：`session.fromPartition()` 会**为任何字符串**造一个分区。
 * 于是传一个不存在的环境 id，界面看到的是「这个环境没有 Cookie」——
 * 一句关于「不存在的东西」的断言，听起来完全正常。
 * 这正是 store/json-file.ts 写的「读不到 ≠ 不存在」：
 * 查不到要报「查不到」，不能报「不存在的东西是空的」。
 */
function requireProfile(ctx: ModuleContext, profileId: string): void {
  if (ctx.stores.profiles.get(profileId) === null) {
    throw new Error('环境不存在：' + profileId)
  }
}

/**
 * 读 Cookie。**读失败必须冒泡。**
 *
 * `ses.cookies.get()` 抛错时如果吞掉、返回空数组，用户会看到「这个环境没有 Cookie」，
 * 于是把一个环境问题当成「会话是干净的」—— 那是两种完全相反的结论，
 * 而后者会让人在一个其实还登着号的会话上重新登录。
 */
async function readCookies(ses: Session, profileId: string): Promise<RawCookie[]> {
  try {
    return await ses.cookies.get({})
  } catch (err) {
    throw new Error(
      `读取环境 ${profileId} 的 Cookie 失败：${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * 导入的一条 Cookie → Electron `cookies.set` 的参数。
 *
 * 两处刻意的细节：
 *
 * - `domain` 只在「域 Cookie」时才给。host-only 的 Cookie 必须让 Chromium 从
 *   URL 推导主机名；显式写 domain 会把它变成域 Cookie（对子域也生效），
 *   那就等于多发了一份会话出去。
 * - `expirationDate` 是**秒**。Electron 读出来的是秒、写回去也要秒；
 *   应用内部用毫秒，换算只在这一处发生。
 */
function toSetDetails(cookie: ImportedCookie): Parameters<Session['cookies']['set']>[0] {
  const details: Parameters<Session['cookies']['set']>[0] = {
    url: cookie.url,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly
  }
  if (cookie.expires !== undefined) details.expirationDate = Math.floor(cookie.expires / 1000)
  if (cookie.sameSite !== undefined) details.sameSite = cookie.sameSite
  if (cookie.domain.startsWith('.')) details.domain = cookie.domain
  return details
}

/**
 * 还原出能匹配到这条 Cookie 的 URL。
 *
 * cookies.remove 是按 URL + name 匹配的，path 不带进 URL 的话，
 * 挂在 /foo 下的 Cookie 会删不掉。domain 为空（理论上不该出现）时直接跳过。
 *
 * 与 cookie-io 的 `cookieUrlFor` 是同一件事的两面：那一条给 `cookies.set` 用
 * （path 是独立参数，塞进 URL 反而让「域」和「路径」有两个来源），
 * 这一条给 `cookies.remove` 用（必须带 path 才匹配得上）。
 */
function cookieUrl(cookie: RawCookie): string | null {
  const host = (cookie.domain ?? '').replace(/^\./, '')
  if (!host) return null
  const path = cookie.path && cookie.path.startsWith('/') ? cookie.path : '/'
  return cookieUrlFor({ domain: cookie.domain ?? '', secure: cookie.secure === true }) + path
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
  if (downloads.length > DOWNLOAD_LIMIT) {
    // 顺带把被淘汰那几条的节流记录删掉，否则这张 Map 会随进程存活时间一直长
    for (const dropped of downloads.splice(DOWNLOAD_LIMIT)) lastDownloadEmit.delete(dropped.id)
  }
  // 这条记录刚推过一次全量，节流窗口从此刻开始算
  lastDownloadEmit.set(record.id, Date.now())
  ctx.broadcast(CH.push.download, { ...record })

  item.on('updated', (_event, state) => {
    record.received = item.getReceivedBytes()
    record.total = item.getTotalBytes()
    // savePath 要等用户确认保存对话框之后才有值，updated 阶段补一次
    record.savePath = item.getSavePath() || record.savePath
    if (state === 'interrupted') record.state = 'interrupted'

    // 进度节流：距上次广播不足 150ms 就只更新内存里的 record，不推给渲染层。
    // 被跳过的那一帧不会丢 —— 下一次通过窗口的事件（或 done）会带上最新累计值。
    // 中断要立刻广播：那是状态变化，不是进度数字，晚 150ms 用户会以为还在下。
    const now = Date.now()
    const last = lastDownloadEmit.get(record.id) ?? 0
    if (state !== 'interrupted' && now - last < DOWNLOAD_EMIT_INTERVAL_MS) return
    lastDownloadEmit.set(record.id, now)
    ctx.broadcast(CH.push.download, { ...record })
  })

  item.on('done', (_event, state) => {
    record.state = state
    record.received = item.getReceivedBytes()
    // 中断时 total 可能归零，保留上一次已知的总量，进度条才不会突然跳回 0%
    record.total = item.getTotalBytes() || record.total
    record.savePath = item.getSavePath() || record.savePath
    // 终态不节流：这条事件之后 item 不会再有更新，广播丢了就是永远停在旧进度
    lastDownloadEmit.delete(record.id)
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
