/**
 * 「代理出口 → 指纹地理自动校准」。
 *
 * 解决的是环境里最常见的一种自相矛盾：代理出口在德国，指纹时区却还是
 * America/Los_Angeles、语言 en-US。以前挂代理只弹一条“时区不一致”的警告，
 * 用户得自己记住探测结果再手改四项。这里把整条链路一次做完：
 *
 *   profile.proxy --(host:port)--> 代理记录 --(5 分钟内缓存 / 现场探测)-->
 *   出口 timezone + country --> 纯策略 geo-match-policy --> 写回指纹 + 审计
 *
 * 为什么探测和写回都在主进程：出口信息不能由渲染层声明。渲染层只发一个
 * `profileId`，主进程自己去连代理、自己落库，这样“写进去的地理参数和出口一致”
 * 才是可保证的，也才有审计可查。
 *
 * 纯映射逻辑全部在 `./geo-match-policy.ts`，本文件只做编排与副作用。
 */

import { CH } from '@shared/ipc'
import type { ProxyConfig, ProxyCheck, ProxyRecord } from '@shared/types'
import { appendAudit } from './audit'
import type { ModuleContext } from './context'
import { planGeoCalibration } from './geo-match-policy'
import { probeProxy } from './proxy'

/**
 * 探测缓存的有效期。
 *
 * 5 分钟是一个折中：短到代理已经换出口（机场节点切换）时不会拿旧国家校准，
 * 长到连续给一批环境点“校准”时不会把同一条代理重复探十几次。
 * 过期后不是直接复用旧值，而是重新探测 —— 缓存只省请求，不替代事实。
 */
const CHECK_TTL_MS = 5 * 60 * 1000

/** host:port 归一化：大小写、空白、IPv6 的方括号都不应该影响“是不是同一条” */
function endpointKey(host: string, port: number): string {
  const clean = String(host ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  return `${clean}:${Number(port)}`
}

/**
 * 在代理池里找环境挂载的那条记录。
 *
 * `Profile.proxy` 存的是连接参数快照，没有 proxyId；唯一稳定的关联就是 host:port。
 * 但同一个 host:port 可以有多条记录（http / socks5 各存一条，或同协议不同账号），
 * 所以先按 host:port 收窄，再优先挑协议与用户名都一致的那条：
 * 拿错凭据去探测会把“账号不对”误报成“代理不可用”，让人白换一条好代理。
 */
function pickProxyRecord(records: ProxyRecord[], attached: ProxyConfig): ProxyRecord | null {
  const key = endpointKey(attached.host, attached.port)
  const candidates = records.filter((record) => endpointKey(record.host, record.port) === key)
  if (candidates.length === 0) return null

  const wantedProtocol = String(attached.type).toLowerCase()
  const wantedUser = attached.username ?? ''
  const exact = candidates.find(
    (record) =>
      String(record.protocol).toLowerCase() === wantedProtocol &&
      (record.username ?? '') === wantedUser
  )
  return exact ?? candidates[0]
}

/**
 * 5 分钟内的成功探测可以直接复用。
 *
 * 必须是 `ok` 且带时区：失败记录不缓存（见下面失败分支），
 * 没时区的成功记录也不能用于校准 —— 复用只会让调用方多绕一圈再报错。
 */
function freshCheck(record: ProxyRecord): ProxyCheck | null {
  const last = record.lastCheck
  if (last === null || !last.ok) return null
  if (typeof last.timezone !== 'string' || last.timezone.trim() === '') return null
  if (!Number.isFinite(last.at)) return null

  const age = Date.now() - last.at
  // age < 0 只可能来自手改过的记录或系统时钟回拨。这种“未来”的记录
  // 不能当作刚探测过，否则一条脏数据会永久跳过真实探测。
  if (age < 0 || age >= CHECK_TTL_MS) return null
  return last
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function registerGeoMatchModule(ctx: ModuleContext): void {
  ctx.handle(CH.profiles.matchGeo, async (_event, rawId) => {
    if (typeof rawId !== 'string' || rawId.trim() === '') {
      throw new Error('环境 id 必须是字符串')
    }
    const profileId = rawId.trim()
    const profile = ctx.stores.profiles.get(profileId)
    if (profile === null) throw new Error('环境不存在：' + profileId)

    const attached = profile.proxy
    // 直连环境没有“出口”可对齐：用本机时区校准等于什么都没做，
    // 而用某个猜测的国家校准则是凭空制造矛盾。这里明确拒绝。
    // 判 `!attached` 而不是 `=== null`：老盘 / 导入包里的记录可能压根没有
    // 这个键（undefined 在类型上不该出现，但运行时形状由盘上的 JSON 决定）。
    if (!attached) throw new Error('该环境未挂代理，没有可校准的出口')

    const record = pickProxyRecord(ctx.stores.proxies.list(), attached)
    if (record === null) throw new Error('代理记录不存在')

    let check = freshCheck(record)
    if (check === null) {
      try {
        check = await probeProxy(record)
      } catch (err) {
        // 探测函数本身通常以 { ok:false } 返回，这里兜的是连接层抛出的异常。
        // 统一成同一句可读错误，绝不编造一个时区让校准“看起来成功”。
        throw new Error('代理探测失败：' + errorText(err))
      }
      // 失败也要回写：代理列表上的状态点应该立刻变红。只回写成功的话，
      // 界面会一直停留在上一次的成功状态，用户以为代理还好着。
      ctx.stores.proxies.update(record.id, { lastCheck: check })
    }
    if (!check.ok) throw new Error('代理探测失败：' + (check.error ?? '未知原因'))

    const plan = planGeoCalibration({
      timezone: check.timezone,
      country: check.country,
      current: profile.fingerprint
    })
    if (plan === null) throw new Error('代理出口没有返回时区，无法校准')

    // 只覆盖 plan 里的四个地理字段：其余键（os / userAgent / screen / webgl / …）
    // 原样保留。指纹的其他面由各自的编辑入口负责，校准不是一套“重新掷骰子”。
    ctx.stores.profiles.update(profileId, {
      fingerprint: { ...profile.fingerprint, ...plan }
    })

    appendAudit(
      ctx.stores,
      '环境·按代理校准地理',
      `环境 ${profile.name}（${profileId}）`,
      `时区 ${profile.fingerprint.timezone} → ${plan.timezone}；` +
        `语言 ${profile.fingerprint.locale} → ${plan.locale}；` +
        `出口 ${check.ip ?? '未知'}${check.country ? `（${check.country}）` : ''}`
    )

    // 直接调 store 不会触发 handlers.ts 里 `profiles.update` 那条广播路径，
    // 所以这里自己推一次：环境卡片与指纹抽屉需要立刻看到新 locale / 时区。
    ctx.broadcast(CH.push.profileState, ctx.stores.profiles.list())

    return {
      ok: true as const,
      timezone: plan.timezone,
      locale: plan.locale,
      languages: plan.languages,
      country: check.country ?? '',
      ip: check.ip ?? ''
    }
  })
}
