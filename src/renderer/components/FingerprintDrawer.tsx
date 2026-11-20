/**
 * 指纹配置抽屉（宽 460px，右侧滑出）。
 *
 * 四个 tab：基础 / 指纹 / 代理 / 影子。
 * 指纹 tab 底部的「一致性评分」是真的算出来的（见 lib/format.ts scoreFingerprint）：
 * 时区↔经纬度、语言↔地区、UA↔平台 各扣分，输出 0–100 与一句结论。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type {
  ExtensionRecord,
  FingerprintConfig,
  FingerprintPermissionState,
  InjectionIssue,
  Profile,
  ProxyGroup,
  ProxyProtocol
} from '@shared/types'
import { OS_TEMPLATES, PROFILE_COLORS, TIMEZONE_GEO } from '@shared/presets'
import { Button, Field, Icon, Modal, Toggle, cssVars, useToast } from './ui'
import { bridge, errorMessage } from '@renderer/lib/api'
import { useI18n } from '@renderer/lib/i18n'
import {
  formatDate,
  formatRelative,
  localeCountry,
  profileNo,
  scoreFingerprint,
  tzOffsetLabel
} from '@renderer/lib/format'

type Tab = 'basic' | 'fingerprint' | 'proxy' | 'shadow'

const TABS: Array<{ id: Tab; labelKey: string }> = [
  { id: 'basic', labelKey: 'fp.tab.basic' },
  { id: 'fingerprint', labelKey: 'fp.tab.fingerprint' },
  { id: 'proxy', labelKey: 'fp.tab.proxy' },
  { id: 'shadow', labelKey: 'fp.tab.shadow' }
]

const TIMEZONES = Object.keys(TIMEZONE_GEO)

interface FingerprintDrawerProps {
  profile: Profile | null
  onClose: () => void
  onSaved: (next: Profile) => void
  onLaunch: (id: string) => void
}

function cloneProfile(p: Profile): Profile {
  return {
    ...p,
    fingerprint: {
      ...p.fingerprint,
      languages: [...p.fingerprint.languages],
      fonts: [...p.fingerprint.fonts],
      screen: { ...p.fingerprint.screen },
      hardware: { ...p.fingerprint.hardware },
      webgl: { ...p.fingerprint.webgl },
      geolocation: p.fingerprint.geolocation ? { ...p.fingerprint.geolocation } : null
    },
    proxy: p.proxy ? { ...p.proxy } : null,
    tags: [...p.tags]
  }
}

/* ────────────────────────────── 焦点辅助 ──────────────────────────────
 *
 * 为什么这里重写一份、而不是从 './ui' import：
 * ui.tsx 里的 focusableIn / trapFocus 是**模块私有**的（没有 export），
 * Modal 在用它们，但把它们导出去等于给整个渲染层开一个只有抽屉需要的口子。
 * 本轮改动范围被限定在抽屉和 ApiPanel 两个文件里，所以照抄一份等价实现。
 * 代价是两份实现必须同步改 —— 所以选择器字符串逐字保持一致，
 * 否则键盘行为会在抽屉和弹窗之间分叉（同一个产品里两种 Tab 语义最难查）。 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** 取容器内当前可见、可聚焦的元素（隐藏元素拿不到焦点，必须滤掉） */
function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement
  )
}

/** 把 Tab / Shift+Tab 挡在容器内循环，容器自身需要带 tabIndex=-1 兜底 */
function trapFocus(container: HTMLElement, event: ReactKeyboardEvent): void {
  if (event.key !== 'Tab') return
  const items = focusableIn(container)
  if (items.length === 0) {
    // 没有任何可聚焦元素时锁在容器自身，否则焦点会掉到抽屉背后的页面
    event.preventDefault()
    container.focus()
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (event.shiftKey) {
    if (active === first || !container.contains(active)) {
      event.preventDefault()
      last.focus()
    }
  } else if (active === last || !container.contains(active)) {
    event.preventDefault()
    first.focus()
  }
}

export function FingerprintDrawer({ profile, onClose, onSaved, onLaunch }: FingerprintDrawerProps) {
  const toast = useToast()
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('fingerprint')
  const [draft, setDraft] = useState<Profile | null>(null)
  /** 可挂到环境的代理组。`null` = 读失败，保存时不覆盖已有绑定（同扩展列表的三态） */
  const [proxyGroups, setProxyGroups] = useState<ProxyGroup[] | null>(null)
  useEffect(() => {
    if (!profile) {
      setProxyGroups(null)
      return
    }
    let alive = true
    setProxyGroups(null)
    void (async () => {
      try {
        const list = await bridge().proxyGroups.list()
        if (alive) setProxyGroups(list)
      } catch {
        if (alive) setProxyGroups(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [profile?.id])
  const [busy, setBusy] = useState(false)
  /** 地理校准的独立忙碌位：它探测代理可能耗时数秒，不能和保存共用 busy */
  const [geoBusy, setGeoBusy] = useState(false)

  /* 抽屉本体（焦点陷阱的作用域）与「打开前的焦点」（关闭时还原的目标）。 */
  const drawerRef = useRef<HTMLElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  /* 有未保存修改时，关闭动作先转到这里弹确认，不直接 onClose。 */
  const [discardOpen, setDiscardOpen] = useState(false)

  /* 伪装闸门豁免的三个状态。
   *
   * 为什么不走 `draft` + 保存按钮：这个开关是**立即生效**的配置，走保存流程会出现
   * 「界面上开着、主进程里还关着」的中间态 —— 而它控制的是一道安全闸，
   * 中间态必须不存在。所以单独一条 IPC（`profiles.setExemption`），
   * 成功之后用主进程返回的 Profile 覆盖本地状态，不信自己的乐观更新。
   *
   * `pendingExempt` = 「用户想开，但还没打环境名」。开启必须有这一步：
   * 点一下就能关掉闸门的开关，等于没有开关。 */
  const [exemptOn, setExemptOn] = useState(false)
  const [pendingExempt, setPendingExempt] = useState(false)
  const [exemptName, setExemptName] = useState('')
  const [exemptBusy, setExemptBusy] = useState(false)

  /* 本环境可选的扩展目录。`null` = 还没读到（加载中或读取失败）。
   *
   * 为什么不用 `[]` 表示读取失败：保存时会把 `extensionIds` 过滤成「仍然存在」
   * 的集合，而空数组会让每一份绑定都被判成「已删除」—— 一次读取失败 + 一次
   * 保存就会静默清空环境的扩展绑定。三态是这里的正确形状。
   *
   * 只读**已启用**的扩展：停用的扩展在启动流程里会被跳过，把它摆出来让用户
   * 勾选等于承诺一件不会发生的事。 */
  const [extensions, setExtensions] = useState<ExtensionRecord[] | null | undefined>(undefined)
  useEffect(() => {
    if (!profile) {
      setExtensions(undefined)
      return
    }
    let alive = true
    setExtensions(undefined)
    void (async () => {
      try {
        const all = await bridge().extensions.list()
        if (alive) setExtensions(Array.isArray(all) ? all.filter((e) => e.enabled) : [])
      } catch {
        // 保持 null：界面说「读不到」，保存时原样保留已有绑定
        if (alive) setExtensions(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [profile?.id])

  /* 本次会话的注入失败台账。
   *
   * 为什么在这里：这些记录以前**没有任何读者**（`listInjectionIssues` 零调用方），
   * 而它们记的正是「哪个子目标没伪装住」—— 环境卡片上的状态点只说明「此刻怎么样」，
   * 说不出「刚才是什么没装上」。抽屉是看单个环境的地方，放在这里不打扰主界面。
   *
   * 拉取失败就当作空：这条通道是诊断用的，读不到不该让整个抽屉打不开。 */
  const [issues, setIssues] = useState<InjectionIssue[]>([])
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const all = await bridge().injection.list()
        if (!alive) return
        const mine = Array.isArray(all) ? all.filter((i) => i.profileId === profile?.id) : []
        setIssues(mine)
      } catch {
        if (alive) setIssues([])
      }
    })()
    return () => {
      alive = false
    }
  }, [profile?.id])

  useEffect(() => {
    setDraft(profile ? cloneProfile(profile) : null)
    setTab('fingerprint')
    setExemptOn(profile?.allowUnmaskedL2 === true)
    setPendingExempt(false)
    setExemptName('')
    // 换环境时残留的确认框必须收掉：它的文案属于上一个环境
    setDiscardOpen(false)
  }, [profile])

  const report = useMemo(() => {
    if (!draft) return null
    return scoreFingerprint(draft.fingerprint, draft.proxy !== null)
  }, [draft])

  /* 抽屉是否真的开着（有草稿才算开 —— 没草稿时下面走「关着」的早退分支）。 */
  const open = draft !== null && report !== null

  /* 打开时把焦点收进抽屉，关闭时还原到打开前的那个元素。
   *
   * 为什么必须做：抽屉是覆盖层，但焦点默认留在触发它的按钮上。
   * 那一刻键盘用户按 Tab，走的是抽屉**下面**的页面 —— 抽屉等于对键盘不存在。
   * 还原同样重要：不还原的话焦点会掉到 body，关闭后得从页面第一个控件重新 Tab。
   *
   * 依赖只放 open：profile/draft 每次编辑都会换引用，放它们会让焦点被反复抢回抽屉，
   * 用户正在输入的字段会失焦。 */
  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement as HTMLElement | null
    const drawer = drawerRef.current
    if (drawer) {
      const first = focusableIn(drawer)[0]
      // 没有可聚焦元素时聚焦抽屉自身（它带 tabIndex=-1），保证焦点确实进了抽屉
      ;(first ?? drawer).focus()
    }
    return () => {
      const back = restoreRef.current
      // 触发按钮可能已经不在文档里（列表重渲染过），这时还原会无效，直接跳过
      if (back && document.contains(back)) back.focus()
    }
  }, [open])

  /**
   * 关闭抽屉的统一入口：遮罩、关闭按钮、Esc 都走这里。
   *
   * 草稿是本地 state，原来这三个入口都是直接 onClose —— 一次误触就静默丢掉
   * 整轮编辑，且没有任何提示。所以先比草稿与 profile，有差异就先问。
   * 用 JSON.stringify 比较是刻意的省事：draft 由 cloneProfile + 浅合并产生，
   * 键序稳定，序列化结果可比；这里不需要深比较库。
   */
  const requestClose = (): void => {
    const dirty =
      draft !== null && profile !== null && JSON.stringify(draft) !== JSON.stringify(profile)
    if (dirty) {
      setDiscardOpen(true)
      return
    }
    onClose()
  }

  /* 抽屉内键盘：Esc 走关闭流程，其余按键交给焦点陷阱。 */
  const onDrawerKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      requestClose()
      return
    }
    const drawer = drawerRef.current
    if (drawer) trapFocus(drawer, event)
  }

  if (!draft || !report) {
    return (
      <>
        <div className="mask" />
        <aside className="drawer" aria-hidden="true" />
      </>
    )
  }

  const fp = draft.fingerprint
  const tpl = OS_TEMPLATES[draft.platform]

  const patch = (p: Partial<Profile>): void => setDraft((d) => (d ? { ...d, ...p } : d))
  const patchFp = (p: Partial<FingerprintConfig>): void =>
    setDraft((d) => (d ? { ...d, fingerprint: { ...d.fingerprint, ...p } } : d))

  const scoreTone = report.score >= 90 ? '' : report.score >= 70 ? 'warn' : 'bad'

  async function save(launch: boolean): Promise<void> {
    if (!draft) return
    setBusy(true)
    try {
      const next = await bridge().profiles.update(draft.id, {
        name: draft.name.trim() || draft.name,
        group: draft.group,
        note: draft.note,
        tags: draft.tags,
        color: draft.color,
        fingerprint: draft.fingerprint,
        proxy: draft.proxy,
        // 代理组是互斥字段：必须显式提交（包括 null = 退出组），否则从组切回单条
        // 代理时主进程收不到「退出组」的指令，界面和出口会各说各话。
        proxyGroupId: draft.proxyGroupId ?? null,
        // 空串表示「没配启动页」：undefined 在 update 的合并语义里等于「不改」，
        // 传它会导致用户清空后旧值永远清不掉。主进程启动时按 trim 后是否为空回落默认。
        startUrl: draft.startUrl?.trim() ?? '',
        // 只提交当前仍然存在的扩展：登记表里被删掉的 id 清掉，
        // 否则它会一直挂在这个环境上，每次启动都多一条失败记录。
        // 列表没读到（null）时原样提交，避免一次读取失败把绑定清空。
        extensionIds:
          extensions == null
            ? draft.extensionIds
            : (draft.extensionIds ?? []).filter((id) => extensions.some((e) => e.id === id))
      })
      onSaved(next)
      if (launch) {
        await bridge().profiles.launch(next.id)
        onLaunch(next.id)
      }
      toast.push(launch ? t('fp.toast.savedAndLaunched') : t('fp.toast.saved'), 'ok')
      onClose()
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 开关伪装闸门豁免。开启必须带环境名，校验在主进程（这里只是把它送过去）。
   *
   * 失败时不做乐观更新：`exemptOn` 只在主进程返回之后才变。
   * 这个开关控制的是「伪装不完整时能不能执行不可逆动作」，界面显示成开、
   * 实际没开（或反过来）都属于「界面与门禁不一致」—— 那是这一轮反复修的那类缺陷。
   */
  async function applyExemption(enabled: boolean, confirmName: string): Promise<void> {
    if (!draft) return
    setExemptBusy(true)
    try {
      const next = await bridge().profiles.setExemption(draft.id, enabled, confirmName)
      setExemptOn(next.allowUnmaskedL2 === true)
      setPendingExempt(false)
      setExemptName('')
      onSaved(next)
      toast.push(
        next.allowUnmaskedL2 ? t('fp.toast.exemptOn') : t('fp.toast.exemptOff'),
        next.allowUnmaskedL2 ? 'info' : 'ok'
      )
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setExemptBusy(false)
    }
  }

  function toggleExemption(on: boolean): void {
    if (on) {
      // 只进入「待确认」，不写任何东西。名字对上之前主进程那边始终是 false。
      setPendingExempt(true)
      setExemptName('')
      return
    }
    void applyExemption(false, '')
  }

  /**
   * 按当前挂载代理的出口校准地理字段。
   *
   * ── 为什么只动时区 / 语言 / 语言列表 / 经纬度 ──
   * 这四项是页面能从出口 IP 推断出来的东西。UA、屏幕、WebGL 是浏览器与硬件
   * 特征，和出口国家没有对应关系：按国家改 UA 等于伪造一个不存在的版本组合，
   * 换代理就换屏换显卡则会让同一台「机器」显得比不换更异常 —— 改了反而制造矛盾。
   *
   * 主进程成功时已经落盘并审计；这里只把同一次结果合并进草稿，
   * 让抽屉立刻显示新值。用户点「仅保存 / 保存并启动」才把草稿写回，
   * 不会因为点一下校准就顺手保存其它未完成的编辑。
   */
  async function matchGeo(): Promise<void> {
    if (!draft) return
    setGeoBusy(true)
    try {
      const res = await bridge().profiles.matchGeo(draft.id)
      // 返回值没有坐标，按主进程同一张 TIMEZONE_GEO 表推导：
      // 表里没有的时区在主进程侧就是 geolocation=null，这里保持一致。
      const geo = TIMEZONE_GEO[res.timezone]
      patchFp({
        timezone: res.timezone,
        locale: res.locale,
        languages: [...res.languages],
        geolocation: geo ? { latitude: geo.latitude, longitude: geo.longitude } : null
      })
      toast.push(
        t('fp.matchGeoOk', { country: res.country || '—', ip: res.ip || '—' }),
        'ok'
      )
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setGeoBusy(false)
    }
  }

  async function regenerate(): Promise<void> {
    if (!draft) return
    setBusy(true)
    try {
      const next = await bridge().profiles.regenerate(draft.id)
      setDraft(cloneProfile(next))
      toast.push(t('fp.toast.reseeded'), 'ok')
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 按平台重算一套指纹（「按平台模板重置」和「重置为默认」共用）。
   *
   * ── 为什么这件事必须问主进程 ──
   *
   * 重算需要种子，而种子不出主进程（`Profile` 里只有 `seedHint`）。
   * 渲染层以前直接调 `resolveFingerprint(platform, seed)`，除了把种子摆到
   * 进程里之外还有一个更隐蔽的问题：`resolveFingerprint` **只对 windows 叠
   * seed 扰动**，macos/linux 会退化成模板默认值。而主进程保存时走的是
   * `buildFingerprint`（对三个平台都叠扰动）。于是「预览看到的」和「保存后的」
   * 不是同一个值 —— 用户以为自己换成了模板默认分辨率，实际落盘的是另一个。
   * 走 `preview` 之后两处用的是同一个函数。
   */
  async function resetToPlatform(platform: Profile['platform']): Promise<void> {
    if (!draft) return
    setBusy(true)
    try {
      const fingerprint = await bridge().profiles.preview(draft.id, { platform })
      setDraft((d) =>
        d === null ? d : { ...d, platform, fingerprint, browserVersion: fingerprint.uaVersion }
      )
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="mask on" onClick={requestClose} />
      <aside
        ref={drawerRef}
        className="drawer on"
        role="dialog"
        aria-modal="true"
        aria-label={t('fp.aria')}
        tabIndex={-1}
        onKeyDown={onDrawerKeyDown}
      >
        <div className="drawer-head">
          <div className="r1">
            <h3>{draft.name}</h3>
            <span className="id">{profileNo(draft.id)}</span>
            <button type="button" className="x" onClick={requestClose} aria-label={t('common.close')}>
              <Icon name="close" size={13} strokeWidth={2} />
            </button>
          </div>
          <div className="sub">
            <span className={draft.status === 'running' ? 'status run' : 'status'}>
              <i />
              {draft.status === 'running'
                ? t('fp.status.running')
                : draft.status === 'error'
                  ? t('fp.status.failed')
                  : t('fp.status.idle')}
            </span>
            {' · '}
            {t('fp.meta.created', { date: formatDate(draft.createdAt) })}
            {' · '}
            {t('fp.meta.lastUsed', { time: formatRelative(draft.lastUsedAt) })}
          </div>
        </div>

        <div className="dtabs" role="tablist">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`dtab${tab === item.id ? ' on' : ''}`}
              onClick={() => setTab(item.id)}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>

        <div className="drawer-body scroll-thin">
          {tab === 'basic' ? (
            <>
              <div className="fieldset">
                <div className="fs-head">
                  <h4>{t('fp.section.identity')}</h4>
                </div>
                <Field label={t('common.name')}>
                  <input
                    className="val"
                    value={draft.name}
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                </Field>
                <Field label={t('fp.field.group')}>
                  <input
                    className="val"
                    /* 存储值是 '默认'；英文界面显示 Default。只有用户真的改了输入框
                       才会写回新分组，原样保存不会把 '默认' 改写成 'Default'。 */
                    value={draft.group === '默认' ? t('profiles.group.default') : draft.group}
                    placeholder={t('fp.group.placeholder')}
                    onChange={(e) => patch({ group: e.target.value })}
                  />
                </Field>
                <Field label={t('fp.field.tags')}>
                  <input
                    className="val"
                    value={draft.tags.join(', ')}
                    placeholder={t('fp.tags.placeholder')}
                    onChange={(e) =>
                      patch({
                        tags: e.target.value
                          .split(/[,，]/)
                          .map((s) => s.trim())
                          .filter(Boolean)
                      })
                    }
                  />
                </Field>
                <Field label={t('fp.startUrl')} hint={t('fp.startUrlHint')}>
                  <input
                    className="val mono"
                    value={draft.startUrl ?? ''}
                    placeholder={t('fp.startUrlPlaceholder')}
                    onChange={(e) => patch({ startUrl: e.target.value })}
                  />
                </Field>
                <Field label={t('fp.extensions')} hint={t('fp.extensionsHint')}>
                  {extensions === undefined ? (
                    <span className="ext-empty">{t('common.loading')}</span>
                  ) : extensions === null ? (
                    <span className="ext-empty">{t('fp.extensionsUnavailable')}</span>
                  ) : extensions.length === 0 ? (
                    <span className="ext-empty">{t('fp.extensionsEmpty')}</span>
                  ) : (
                    <div className="ext-pick">
                      {extensions.map((ext) => {
                        const on = (draft.extensionIds ?? []).includes(ext.id)
                        return (
                          <button
                            key={ext.id}
                            type="button"
                            className={`ext-chip${on ? ' on' : ''}`}
                            aria-pressed={on}
                            title={ext.path}
                            onClick={() => {
                              const cur = draft.extensionIds ?? []
                              patch({
                                extensionIds: on
                                  ? cur.filter((id) => id !== ext.id)
                                  : [...cur, ext.id]
                              })
                            }}
                          >
                            {ext.name}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </Field>
                <Field label={t('fp.field.color')}>
                  <div className="color-row">
                    {PROFILE_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`color-dot${draft.color === c ? ' on' : ''}`}
                        style={cssVars({ background: c })}
                        aria-label={t('fp.color.aria', { color: c })}
                        onClick={() => patch({ color: c })}
                      />
                    ))}
                  </div>
                </Field>
              </div>

              <div className="fieldset">
                <div className="fs-head">
                  <h4>{t('fp.section.note')}</h4>
                </div>
                <Field label={t('fp.field.note')}>
                  <textarea
                    className="val wrap"
                    rows={3}
                    value={draft.note}
                    placeholder={t('fp.note.placeholder')}
                    onChange={(e) => patch({ note: e.target.value })}
                  />
                </Field>
              </div>

              <div className="fieldset">
                <div className="fs-head">
                  <h4>{t('fp.section.seed')}</h4>
                </div>
                <Field
                  label={t('fp.field.seed')}
                  action={
                    <button
                      type="button"
                      className="dice"
                      title={t('fp.seed.reroll')}
                      onClick={() => void regenerate()}
                      disabled={busy}
                    >
                      <Icon name="dice" size={12} strokeWidth={2} />
                    </button>
                  }
                >
                  <div className="val mono" title={draft.seedHint}>
                    {draft.seedHint}
                  </div>
                </Field>
                <div className="note">{t('fp.seed.desc')}</div>
              </div>
            </>
          ) : null}

          {tab === 'fingerprint' ? (
            <>
              <div className="fieldset">
                <div className="fs-head">
                  <h4>{t('fp.section.system')}</h4>
                  <span className={`badge${scoreTone === 'bad' ? ' bad' : scoreTone === 'warn' ? ' warn' : ''}`}>
                    {t('fp.consistency.badge', { score: report.score })}
                  </span>
                </div>

                <Field
                  label={t('fp.field.os')}
                  action={
                    <button
                      type="button"
                      className="dice"
                      title={t('fp.os.reset')}
                      disabled={busy}
                      onClick={() => void resetToPlatform(draft.platform)}
                    >
                      <Icon name="dice" size={12} strokeWidth={2} />
                    </button>
                  }
                >
                  <select
                    className="val"
                    value={draft.platform}
                    onChange={(e) => {
                      const platform = e.target.value as Profile['platform']
                      void resetToPlatform(platform)
                    }}
                  >
                    <option value="windows">Windows</option>
                    <option value="macos">macOS</option>
                    <option value="linux">Linux</option>
                  </select>
                </Field>

                <Field label={t('fp.field.osLabel')}>
                  <input
                    className="val"
                    value={fp.osLabel}
                    onChange={(e) => patchFp({ osLabel: e.target.value })}
                  />
                </Field>

                <Field
                  label={t('fp.field.userAgent')}
                  action={
                    <button
                      type="button"
                      className="dice"
                      title={t('fp.ua.template')}
                      onClick={() => patchFp({ userAgent: tpl.userAgent })}
                    >
                      <Icon name="dice" size={12} strokeWidth={2} />
                    </button>
                  }
                >
                  <textarea
                    className="val mono wrap"
                    rows={3}
                    value={fp.userAgent}
                    onChange={(e) => patchFp({ userAgent: e.target.value })}
                  />
                </Field>

                <Field
                  label={t('fp.field.browserVersion')}
                  action={
                    <button
                      type="button"
                      className="dice"
                      title={t('fp.uaVersion.align')}
                      onClick={() => patchFp({ uaVersion: tpl.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? fp.uaVersion })}
                    >
                      <Icon name="dice" size={12} strokeWidth={2} />
                    </button>
                  }
                >
                  <input
                    className="val"
                    value={fp.uaVersion}
                    onChange={(e) => patchFp({ uaVersion: e.target.value })}
                  />
                </Field>
              </div>

              <div className="fieldset">
                <div className="fs-head">
                  <h4>{t('fp.section.region')}</h4>
                </div>

                <Field
                  label={t('fp.field.timezone')}
                  action={
                    <button
                      type="button"
                      className="dice"
                      title={t('fp.tz.template')}
                      onClick={() => patchFp({ timezone: tpl.timezone })}
                    >
                      <Icon name="dice" size={12} strokeWidth={2} />
                    </button>
                  }
                >
                  <select
                    className="val"
                    value={fp.timezone}
                    onChange={(e) => {
                      const timezone = e.target.value
                      const geo = TIMEZONE_GEO[timezone]
                      patchFp({
                        timezone,
                        geolocation: geo && fp.geolocation ? { ...geo } : fp.geolocation
                      })
                    }}
                  >
                    {!TIMEZONES.includes(fp.timezone) ? (
                      <option value={fp.timezone}>{fp.timezone}</option>
                    ) : null}
                    {TIMEZONES.map((tz) => (
                      <option key={tz} value={tz}>
                        {tz} ({tzOffsetLabel(tz)})
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label={t('fp.field.locale')}>
                  <input
                    className="val"
                    value={fp.locale}
                    onChange={(e) => patchFp({ locale: e.target.value })}
                  />
                </Field>

                <Field
                  label={t('fp.field.languages')}
                  action={
                    <button
                      type="button"
                      className="dice"
                      title={t('fp.languages.template')}
                      onClick={() => patchFp({ languages: [...tpl.languages] })}
                    >
                      <Icon name="dice" size={12} strokeWidth={2} />
                    </button>
                  }
                >
                  <input
                    className="val"
                    value={fp.languages.join(', ')}
                    placeholder="en-US, en"
                    onChange={(e) =>
                      patchFp({
                        languages: e.target.value
                          .split(/[,，]/)
                          .map((s) => s.trim())
                          .filter(Boolean)
                      })
                    }
                  />
                </Field>

                <Field
                  label={t('fp.field.geolocation')}
                  action={
                    <Toggle
                      checked={fp.geolocation !== null}
                      label={t('fp.geo.toggle')}
                      onChange={(on) =>
                        patchFp({
                          geolocation: on
                            ? (TIMEZONE_GEO[fp.timezone] ?? { latitude: 0, longitude: 0 })
                            : null
                        })
                      }
                    />
                  }
                >
                  {fp.geolocation ? (
                    <div style={{ display: 'flex', gap: 6, minWidth: 0 }}>
                      <input
                        className="val"
                        value={fp.geolocation.latitude}
                        aria-label={t('fp.geo.lat')}
                        onChange={(e) =>
                          patchFp({
                            geolocation: {
                              latitude: Number(e.target.value) || 0,
                              longitude: fp.geolocation?.longitude ?? 0
                            }
                          })
                        }
                      />
                      <input
                        className="val"
                        value={fp.geolocation.longitude}
                        aria-label={t('fp.geo.lng')}
                        onChange={(e) =>
                          patchFp({
                            geolocation: {
                              latitude: fp.geolocation?.latitude ?? 0,
                              longitude: Number(e.target.value) || 0
                            }
                          })
                        }
                      />
                    </div>
                  ) : (
                    <div className="val" style={{ color: 'var(--ink-4)' }}>
                      {t('fp.geo.off')}
                    </div>
                  )}
                </Field>
              </div>

              <div className="fieldset">
                <div className="fs-head">
                  <h4>{t('fp.section.hardware')}</h4>
                </div>

                <Field label={t('fp.field.screen')}>
                  <div style={{ display: 'flex', gap: 6, minWidth: 0 }}>
                    <input
                      className="val"
                      value={fp.screen.width}
                      aria-label={t('fp.screen.width')}
                      onChange={(e) =>
                        patchFp({ screen: { ...fp.screen, width: Number(e.target.value) || 0 } })
                      }
                    />
                    <input
                      className="val"
                      value={fp.screen.height}
                      aria-label={t('fp.screen.height')}
                      onChange={(e) =>
                        patchFp({ screen: { ...fp.screen, height: Number(e.target.value) || 0 } })
                      }
                    />
                    <input
                      className="val"
                      value={fp.screen.dpr}
                      aria-label={t('fp.screen.dpr')}
                      onChange={(e) =>
                        patchFp({ screen: { ...fp.screen, dpr: Number(e.target.value) || 1 } })
                      }
                    />
                  </div>
                </Field>

                <Field label={t('fp.field.cpuMemory')}>
                  <div style={{ display: 'flex', gap: 6, minWidth: 0 }}>
                    <input
                      className="val"
                      value={fp.hardware.cpuCores}
                      aria-label={t('fp.hw.cores')}
                      onChange={(e) =>
                        patchFp({
                          hardware: { ...fp.hardware, cpuCores: Number(e.target.value) || 1 }
                        })
                      }
                    />
                    <input
                      className="val"
                      value={fp.hardware.memoryGB}
                      aria-label={t('fp.hw.memory')}
                      onChange={(e) =>
                        patchFp({
                          hardware: { ...fp.hardware, memoryGB: Number(e.target.value) || 1 }
                        })
                      }
                    />
                  </div>
                </Field>

                <Field
                  label={t('fp.field.webglRenderer')}
                  action={
                    <button
                      type="button"
                      className="dice"
                      title={t('fp.webgl.template')}
                      onClick={() => patchFp({ webgl: { ...tpl.webgl } })}
                    >
                      <Icon name="dice" size={12} strokeWidth={2} />
                    </button>
                  }
                >
                  <input
                    className="val mono"
                    value={fp.webgl.renderer}
                    onChange={(e) =>
                      patchFp({ webgl: { ...fp.webgl, renderer: e.target.value } })
                    }
                  />
                </Field>

                <Field label={t('fp.field.gpuVendor')}>
                  <input
                    className="val mono"
                    value={fp.webgl.vendor}
                    onChange={(e) => patchFp({ webgl: { ...fp.webgl, vendor: e.target.value } })}
                  />
                </Field>
              </div>

              <div className="fieldset">
                <div className="fs-head">
                  <h4>{t('fp.section.privacy')}</h4>
                </div>

                <Field label={t('fp.field.canvas')}>
                  <select
                    className="val"
                    value={fp.canvas}
                    onChange={(e) => patchFp({ canvas: e.target.value as FingerprintConfig['canvas'] })}
                  >
                    <option value="noise">{t('fp.canvas.noise')}</option>
                    <option value="block">{t('fp.canvas.block')}</option>
                    <option value="off">{t('fp.canvas.off')}</option>
                  </select>
                </Field>

                <Field label={t('fp.field.audioContext')}>
                  <select
                    className="val"
                    value={fp.audio}
                    onChange={(e) => patchFp({ audio: e.target.value as FingerprintConfig['audio'] })}
                  >
                    <option value="noise">{t('fp.audio.noise')}</option>
                    <option value="block">{t('fp.audio.block')}</option>
                    <option value="off">{t('fp.audio.off')}</option>
                  </select>
                </Field>

                <Field label={t('fp.field.webrtc')}
                  hint={
                    fp.webrtc === 'disabled'
                      ? t('fp.webrtc.hint.disabled')
                      : fp.webrtc === 'proxy'
                        ? t('fp.webrtc.hint.proxy')
                        : t('fp.webrtc.hint.real')
                  }
                >
                  <select
                    className="val"
                    value={fp.webrtc}
                    onChange={(e) =>
                      patchFp({ webrtc: e.target.value as FingerprintConfig['webrtc'] })
                    }
                  >
                    <option value="proxy">{t('fp.webrtc.proxy')}</option>
                    <option value="disabled">{t('fp.webrtc.disabled')}</option>
                    <option value="real">{t('fp.webrtc.real')}</option>
                  </select>
                </Field>

                <Field
                  label={t('fp.field.fonts')}
                  action={
                    <button
                      type="button"
                      className="dice"
                      title={t('fp.fonts.template')}
                      onClick={() => patchFp({ fonts: [...tpl.fonts] })}
                    >
                      <Icon name="dice" size={12} strokeWidth={2} />
                    </button>
                  }
                >
                  <input
                    className="val"
                    value={t('fp.fonts.summary', {
                      n: fp.fonts.length,
                      list: fp.fonts.slice(0, 3).join(' / ')
                    })}
                    title={fp.fonts.join(', ')}
                    readOnly
                  />
                </Field>

                {/*
                  ── 高级面：以前只存了值、UI 改不了 ──
                  商业指纹浏览器把这些逐项暴露；这里补上 9 个面的可编辑控件。
                  全部写在 fingerprint 上、走 patchFp，保存时与其他字段一起校验。
                */}
                <div className="fs-subhead">{t('fp.section.advanced')}</div>

                <Field label={t('fp.field.maxTouchPoints')}>
                  <input
                    className="val"
                    type="number"
                    min={0}
                    max={10}
                    value={fp.maxTouchPoints ?? 0}
                    onChange={(e) =>
                      patchFp({ maxTouchPoints: Math.max(0, Number(e.target.value) || 0) })
                    }
                  />
                </Field>

                <Field label={t('fp.field.connection')}>
                  <div className="fp-inline-3">
                    <select
                      className="val"
                      value={fp.connection?.effectiveType ?? '4g'}
                      onChange={(e) =>
                        patchFp({
                          connection: {
                            effectiveType: e.target.value as NonNullable<FingerprintConfig['connection']>['effectiveType'],
                            downlink: fp.connection?.downlink ?? 10,
                            rtt: fp.connection?.rtt ?? 50,
                            saveData: fp.connection?.saveData ?? false
                          }
                        })
                      }
                    >
                      {(['4g', '3g', '2g', 'slow-2g'] as const).map((v) => (
                        <option value={v} key={v}>{v}</option>
                      ))}
                    </select>
                    <input
                      className="val"
                      type="number"
                      min={0}
                      step={0.1}
                      title={t('fp.field.downlink')}
                      value={fp.connection?.downlink ?? 10}
                      onChange={(e) =>
                        patchFp({
                          connection: {
                            effectiveType: fp.connection?.effectiveType ?? '4g',
                            downlink: Number(e.target.value) || 0,
                            rtt: fp.connection?.rtt ?? 50,
                            saveData: fp.connection?.saveData ?? false
                          }
                        })
                      }
                    />
                    <input
                      className="val"
                      type="number"
                      min={0}
                      title={t('fp.field.rtt')}
                      value={fp.connection?.rtt ?? 50}
                      onChange={(e) =>
                        patchFp({
                          connection: {
                            effectiveType: fp.connection?.effectiveType ?? '4g',
                            downlink: fp.connection?.downlink ?? 10,
                            rtt: Number(e.target.value) || 0,
                            saveData: fp.connection?.saveData ?? false
                          }
                        })
                      }
                    />
                  </div>
                </Field>

                <Field label={t('fp.field.battery')}>
                  <div className="fp-inline-2">
                    <input
                      className="val"
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      title={t('fp.field.batteryLevel')}
                      value={Math.round((fp.battery?.level ?? 1) * 100)}
                      onChange={(e) =>
                        patchFp({
                          battery: {
                            charging: fp.battery?.charging ?? true,
                            level: Math.min(1, Math.max(0, (Number(e.target.value) || 0) / 100)),
                            chargingTime: fp.battery?.chargingTime ?? 0,
                            dischargingTime: fp.battery?.dischargingTime ?? Infinity
                          }
                        })
                      }
                    />
                    <Toggle
                      checked={fp.battery?.charging ?? true}
                      onChange={(v) =>
                        patchFp({
                          battery: {
                            charging: v,
                            level: fp.battery?.level ?? 1,
                            chargingTime: fp.battery?.chargingTime ?? 0,
                            dischargingTime: fp.battery?.dischargingTime ?? Infinity
                          }
                        })
                      }
                      label={t('fp.field.batteryCharging')}
                    />
                  </div>
                </Field>

                <Field label={t('fp.field.mediaDevices')}>
                  <div className="fp-inline-3">
                    {([
                      ['audioInput', t('fp.field.audioInput')],
                      ['audioOutput', t('fp.field.audioOutput')],
                      ['videoInput', t('fp.field.videoInput')]
                    ] as const).map(([kind, label]) => (
                      <input
                        key={kind}
                        className="val"
                        type="number"
                        min={0}
                        max={8}
                        title={label}
                        value={fp.mediaDevices?.[kind] ?? 0}
                        onChange={(e) =>
                          patchFp({
                            mediaDevices: {
                              audioInput: fp.mediaDevices?.audioInput ?? 0,
                              audioOutput: fp.mediaDevices?.audioOutput ?? 0,
                              videoInput: fp.mediaDevices?.videoInput ?? 0,
                              [kind]: Math.max(0, Number(e.target.value) || 0)
                            }
                          })
                        }
                      />
                    ))}
                  </div>
                </Field>

                <Field label={t('fp.field.permissions')} hint={t('fp.permissionsHint')}>
                  <div className="fp-inline-2">
                    {(['geolocation', 'camera', 'microphone', 'notifications'] as const).map((k) => (
                      <select
                        key={k}
                        className="val"
                        value={fp.permissions?.[k] ?? 'prompt'}
                        title={k}
                        onChange={(e) =>
                          patchFp({
                            permissions: {
                              ...(fp.permissions ?? {}),
                              [k]: e.target.value as FingerprintPermissionState
                            }
                          })
                        }
                      >
                        <option value="granted">granted</option>
                        <option value="prompt">prompt</option>
                        <option value="denied">denied</option>
                      </select>
                    ))}
                  </div>
                </Field>

                <Field label={t('fp.field.plugins')}>
                  <select
                    className="val"
                    value={fp.plugins ?? 'chrome-pdf'}
                    onChange={(e) => patchFp({ plugins: e.target.value as FingerprintConfig['plugins'] })}
                  >
                    <option value="chrome-pdf">{t('fp.plugins.pdf')}</option>
                    <option value="none">{t('fp.plugins.none')}</option>
                  </select>
                </Field>

                <div className="fp-inline-2">
                  <Toggle checked={fp.mediaCapabilities ?? true} onChange={(v) => patchFp({ mediaCapabilities: v })} label={t('fp.field.mediaCapabilities')} />
                  <Toggle checked={fp.storageEstimate ?? true} onChange={(v) => patchFp({ storageEstimate: v })} label={t('fp.field.storageEstimate')} />
                </div>
                <div className="fp-inline-2">
                  <Toggle checked={fp.webgpu ?? true} onChange={(v) => patchFp({ webgpu: v })} label={t('fp.field.webgpu')} />
                  <Toggle checked={fp.clientRectsNoise ?? true} onChange={(v) => patchFp({ clientRectsNoise: v })} label={t('fp.field.clientRectsNoise')} />
                </div>
                <div className="fp-inline-2">
                  <Toggle checked={fp.uaHighEntropy ?? true} onChange={(v) => patchFp({ uaHighEntropy: v })} label={t('fp.field.uaHighEntropy')} />
                </div>
              </div>

              <div className={`consist${scoreTone ? ` ${scoreTone}` : ''}`}>
                <div className="ring" style={cssVars({ '--pct': report.score })}>
                  <span>{report.score}</span>
                </div>
                <div className="txt">
                  <b>
                    {report.score >= 95
                      ? t('fp.score.good')
                      : report.score >= 80
                        ? t('fp.score.fair')
                        : report.score >= 60
                          ? t('fp.score.warn')
                          : t('fp.score.bad')}
                  </b>
                  <span>{report.verdict}</span>
                </div>
              </div>
              <div className="note">{t('fp.score.note')}</div>
            </>
          ) : null}

          {tab === 'proxy' ? (
            <>
              <div className="fieldset">
                <div className="fs-head">
                  <h4>{t('fp.section.proxy')}</h4>
                  <span className={`badge${draft.proxy || draft.proxyGroupId ? '' : ' warn'}`}>
                    {draft.proxyGroupId
                      ? t('pg.title')
                      : draft.proxy
                        ? t('fp.proxy.configured')
                        : t('fp.proxy.direct')}
                  </span>
                </div>

                <Field label={t('pg.assign')} hint={t('pg.assignHint')}>
                  {proxyGroups === null ? (
                    <span className="ext-empty">{t('wh.readFailed')}</span>
                  ) : (
                    <select
                      className="val"
                      value={draft.proxyGroupId ?? ''}
                      onChange={(e) => patch({ proxyGroupId: e.target.value || null })}
                    >
                      <option value="">{t('pg.assignNone')}</option>
                      {proxyGroups.map((g) => (
                        <option value={g.id} key={g.id}>
                          {g.name}（{t('pg.count', { n: g.proxyIds.length })}）
                        </option>
                      ))}
                    </select>
                  )}
                </Field>

                <Field label={t('fp.field.protocol')}>
                  <select
                    className="val"
                    value={draft.proxy?.type ?? 'http'}
                    onChange={(e) => {
                      const type = e.target.value as ProxyProtocol
                      patch({ proxy: { type, host: draft.proxy?.host ?? '', port: draft.proxy?.port ?? 8080 } })
                    }}
                  >
                    <option value="http">HTTP</option>
                    <option value="https">HTTPS</option>
                    <option value="socks5">SOCKS5</option>
                    <option value="socks5h">{t('fp.proxy.socks5h')}</option>
                  </select>
                </Field>

                <Field label={t('fp.field.host')}>
                  <input
                    className="val mono"
                    value={draft.proxy?.host ?? ''}
                    placeholder="45.132.8.21"
                    onChange={(e) =>
                      patch({
                        proxy: {
                          type: draft.proxy?.type ?? 'http',
                          host: e.target.value,
                          port: draft.proxy?.port ?? 8080,
                          username: draft.proxy?.username,
                          password: draft.proxy?.password
                        }
                      })
                    }
                  />
                </Field>

                <Field label={t('fp.field.port')}>
                  <input
                    className="val"
                    value={draft.proxy?.port ?? ''}
                    placeholder="8000"
                    onChange={(e) =>
                      patch({
                        proxy: {
                          type: draft.proxy?.type ?? 'http',
                          host: draft.proxy?.host ?? '',
                          port: Number(e.target.value) || 0,
                          username: draft.proxy?.username,
                          password: draft.proxy?.password
                        }
                      })
                    }
                  />
                </Field>

                <Field label={t('fp.field.username')}>
                  <input
                    className="val"
                    value={draft.proxy?.username ?? ''}
                    placeholder={t('fp.proxy.optional')}
                    onChange={(e) =>
                      patch({
                        proxy: {
                          type: draft.proxy?.type ?? 'http',
                          host: draft.proxy?.host ?? '',
                          port: draft.proxy?.port ?? 8080,
                          username: e.target.value,
                          password: draft.proxy?.password
                        }
                      })
                    }
                  />
                </Field>

                <Field label={t('fp.field.password')}>
                  <input
                    className="val"
                    type="password"
                    value={draft.proxy?.password ?? ''}
                    placeholder={t('fp.proxy.optional')}
                    onChange={(e) =>
                      patch({
                        proxy: {
                          type: draft.proxy?.type ?? 'http',
                          host: draft.proxy?.host ?? '',
                          port: draft.proxy?.port ?? 8080,
                          username: draft.proxy?.username,
                          password: e.target.value
                        }
                      })
                    }
                  />
                </Field>
              </div>

              <div className="fieldset">
                <div className="fs-head">
                  <h4>{t('fp.section.exit')}</h4>
                </div>
                <Field label={t('fp.field.currentExit')}>
                  <div className="val mono">
                    {draft.proxy ? `${draft.proxy.host}:${draft.proxy.port}` : t('fp.proxy.direct')}
                  </div>
                </Field>
                <Field label={t('fp.field.regionMatch')}>
                  <div className="val">
                    {localeCountry(fp.locale)} · {tzOffsetLabel(fp.timezone)}
                  </div>
                </Field>
                {/*
                  按代理出口校准。只在挂了代理时可用：直连环境没有「出口」可对齐，
                  用本机时区校准等于什么都没做，而猜一个国家再写进去是凭空制造矛盾。
                  禁用的原因放进 title，因为按钮变灰本身不解释为什么。
                */}
                <div style={{ marginTop: 8 }}>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="globe"
                    disabled={!draft.proxy || geoBusy || busy}
                    title={draft.proxy ? t('fp.matchGeoHint') : t('fp.matchGeoDisabled')}
                    onClick={() => void matchGeo()}
                  >
                    {t('fp.matchGeo')}
                  </Button>
                </div>
                <div className="note">{t('fp.matchGeoHint')}</div>
                <div className="note">{t('fp.proxy.note')}</div>
                <div style={{ marginTop: 8 }}>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="close"
                    onClick={() => patch({ proxy: null })}
                  >
                    {t('fp.proxy.clear')}
                  </Button>
                </div>
              </div>
            </>
          ) : null}

          {tab === 'shadow' ? (
            <>
              <div className="fieldset">
                <div className="fs-head">
                  <h4>{t('fp.section.shadow')}</h4>
                </div>
                <Field label={t('fp.shadow.isolated')}>
                  <div className="val">{t('fp.shadow.isolatedValue')}</div>
                </Field>
                <Field label={t('fp.shadow.binding')}>
                  <div className="val">{t('fp.shadow.bindingValue')}</div>
                </Field>
                <Field label={t('fp.shadow.riskActions')}>
                  <div className="val">{t('fp.shadow.riskActionsValue')}</div>
                </Field>
              </div>

              {/* 伪装闸门豁免 —— 环境级配置，**不放在失败弹窗里**。
                  放弹窗里等于告诉用户「这里有个开关」，而伪装失败的正确处置是
                  修环境（重开窗口 / 换 profile），不是「我知道有风险，继续」。 */}
              <div className="fieldset">
                <div className="fs-head">
                  <h4>{t('fp.section.maskGate')}</h4>
                </div>
                <Field
                  label={t('fp.exempt.field')}
                  action={
                    <Toggle
                      checked={exemptOn}
                      label={t('fp.exempt.toggle')}
                      disabled={exemptBusy}
                      onChange={toggleExemption}
                    />
                  }
                >
                  <div className={`val${exemptOn ? ' warn' : ''}`}>
                    {exemptOn ? t('fp.exempt.on') : t('fp.exempt.off')}
                  </div>
                </Field>
                {pendingExempt ? (
                  <Field label={t('fp.exempt.confirm')}>
                    <div className="exempt-confirm">
                      <input
                        className="val"
                        value={exemptName}
                        placeholder={t('fp.exempt.placeholder', { name: draft.name })}
                        onChange={(e) => setExemptName(e.target.value)}
                      />
                      <Button
                        variant="ghost"
                        disabled={exemptBusy || exemptName.trim() !== draft.name}
                        onClick={() => void applyExemption(true, exemptName)}
                      >
                        {t('fp.exempt.enable')}
                      </Button>
                    </div>
                  </Field>
                ) : null}
                <div className="note">
                  {t('fp.exempt.note')}
                  {pendingExempt ? t('fp.exempt.notePending') : ''}
                </div>
              </div>

              <div className="fieldset">
                <div className="fs-head">
                  <h4>{t('fp.section.hardening')}</h4>
                </div>
                <Field
                  label={t('fp.field.clientRects')}
                  action={
                    <Toggle
                      checked={fp.clientRectsNoise}
                      label={t('fp.clientRects.toggle')}
                      onChange={(on) => patchFp({ clientRectsNoise: on })}
                    />
                  }
                >
                  <div className="val">
                    {fp.clientRectsNoise ? t('fp.state.noise') : t('fp.state.off')}
                  </div>
                </Field>
                <Field
                  label={t('fp.field.webgpu')}
                  action={
                    <Toggle
                      checked={fp.webgpu}
                      label={t('fp.webgpu.toggle')}
                      onChange={(on) => patchFp({ webgpu: on })}
                    />
                  }
                >
                  <div className="val">{fp.webgpu ? t('fp.webgpu.on') : t('fp.webgpu.off')}</div>
                </Field>
                <div className="note">{t('fp.hardening.note')}</div>
              </div>

              <div className="fieldset">
                <div className="fs-head">
                  <h4>{t('fp.section.injection')}</h4>
                </div>
                {issues.length === 0 ? (
                  <div className="note">{t('fp.injection.empty')}</div>
                ) : (
                  <>
                    {issues
                      .slice(-5)
                      .reverse()
                      .map((it, i) => (
                        <Field key={String(it.at) + '-' + String(i)} label={it.target}>
                          <div className="val">{it.reason.slice(0, 140)}</div>
                        </Field>
                      ))}
                    <div className="note">
                      {t('fp.injection.summary', { n: issues.length })}
                      {issues.length > 5 ? t('fp.injection.olderHidden') : ''}
                    </div>
                  </>
                )}
              </div>

              <div className="fieldset">
                <div className="fs-head">
                  <h4>{t('fp.section.recent')}</h4>
                </div>
                <Field label={t('fp.field.lastLaunch')}>
                  <div className="val">{formatRelative(draft.lastUsedAt)}</div>
                </Field>
                <Field label={t('fp.field.updated')}>
                  <div className="val">{formatDate(draft.updatedAt)}</div>
                </Field>
              </div>
            </>
          ) : null}
        </div>

        <div className="drawer-foot">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void resetToPlatform(draft.platform)}
          >
            {t('fp.footer.reset')}
          </Button>
          <div className="spacer" />
          <Button variant="ghost" disabled={busy} onClick={() => void save(false)}>
            {t('fp.footer.saveOnly')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save(true)}>
            {t('fp.footer.saveAndLaunch')}
          </Button>
        </div>
      </aside>

      {/* 草稿确认。放在 aside 外面（同为 fragment 的子节点），
          这样它的 keydown 不会冒泡进抽屉的 Esc 处理，两套关闭逻辑不会互相触发。 */}
      <Modal
        open={discardOpen}
        title={t('fp.discard.title')}
        icon="alert"
        onClose={() => setDiscardOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDiscardOpen(false)}>
              {t('fp.discard.keep')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setDiscardOpen(false)
                onClose()
              }}
            >
              {t('fp.discard.discard')}
            </Button>
          </>
        }
      >
        {t('fp.discard.body')}
      </Modal>
    </>
  )
}
