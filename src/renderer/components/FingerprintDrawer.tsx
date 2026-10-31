/**
 * 指纹配置抽屉（宽 460px，右侧滑出）。
 *
 * 四个 tab：基础 / 指纹 / 代理 / 影子。
 * 指纹 tab 底部的「一致性评分」是真的算出来的（见 lib/format.ts scoreFingerprint）：
 * 时区↔经纬度、语言↔地区、UA↔平台 各扣分，输出 0–100 与一句结论。
 */

import { useEffect, useMemo, useState } from 'react'
import type { FingerprintConfig, Profile } from '@shared/types'
import { OS_TEMPLATES, PROFILE_COLORS, TIMEZONE_GEO, resolveFingerprint } from '@shared/presets'
import { Button, Field, Icon, Toggle, cssVars, useToast } from './ui'
import { bridge, errorMessage } from '@renderer/lib/api'
import {
  formatDate,
  formatRelative,
  localeCountry,
  profileNo,
  scoreFingerprint,
  tzOffsetLabel
} from '@renderer/lib/format'

type Tab = 'basic' | 'fingerprint' | 'proxy' | 'shadow'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'basic', label: '基础' },
  { id: 'fingerprint', label: '指纹' },
  { id: 'proxy', label: '代理' },
  { id: 'shadow', label: '影子' }
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

export function FingerprintDrawer({ profile, onClose, onSaved, onLaunch }: FingerprintDrawerProps) {
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('fingerprint')
  const [draft, setDraft] = useState<Profile | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setDraft(profile ? cloneProfile(profile) : null)
    setTab('fingerprint')
  }, [profile])

  const report = useMemo(() => {
    if (!draft) return null
    return scoreFingerprint(draft.fingerprint, draft.proxy !== null)
  }, [draft])

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
        proxy: draft.proxy
      })
      onSaved(next)
      if (launch) {
        await bridge().profiles.launch(next.id)
        onLaunch(next.id)
      }
      toast.push(launch ? '已保存并启动' : '已保存', 'ok')
      onClose()
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setBusy(false)
    }
  }

  async function regenerate(): Promise<void> {
    if (!draft) return
    setBusy(true)
    try {
      const next = await bridge().profiles.regenerate(draft.id)
      setDraft(cloneProfile(next))
      toast.push('已重掷指纹种子', 'ok')
    } catch (err) {
      toast.push(errorMessage(err), 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="mask on" onClick={onClose} />
      <aside className="drawer on" aria-label="环境配置">
        <div className="drawer-head">
          <div className="r1">
            <h3>{draft.name}</h3>
            <span className="id">{profileNo(draft.id)}</span>
            <button type="button" className="x" onClick={onClose} aria-label="关闭">
              <Icon name="close" size={13} strokeWidth={2} />
            </button>
          </div>
          <div className="sub">
            <span className={draft.status === 'running' ? 'status run' : 'status'}>
              <i />
              {draft.status === 'running'
                ? '运行中'
                : draft.status === 'error'
                  ? '启动失败'
                  : '影子待命'}
            </span>
            · 创建于 {formatDate(draft.createdAt)} · 最后使用 {formatRelative(draft.lastUsedAt)}
          </div>
        </div>

        <div className="dtabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`dtab${tab === t.id ? ' on' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="drawer-body scroll-thin">
          {tab === 'basic' ? (
            <>
              <div className="fieldset">
                <div className="fs-head">
                  <h4>标识</h4>
                </div>
                <Field label="名称">
                  <input
                    className="val"
                    value={draft.name}
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                </Field>
                <Field label="分组">
                  <input
                    className="val"
                    value={draft.group}
                    placeholder="未分组"
                    onChange={(e) => patch({ group: e.target.value })}
                  />
                </Field>
                <Field label="标签">
                  <input
                    className="val"
                    value={draft.tags.join(', ')}
                    placeholder="用逗号分隔"
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
                <Field label="标识色">
                  <div className="color-row">
                    {PROFILE_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`color-dot${draft.color === c ? ' on' : ''}`}
                        style={cssVars({ background: c })}
                        aria-label={`选择颜色 ${c}`}
                        onClick={() => patch({ color: c })}
                      />
                    ))}
                  </div>
                </Field>
              </div>

              <div className="fieldset">
                <div className="fs-head">
                  <h4>备注</h4>
                </div>
                <Field label="用途说明">
                  <textarea
                    className="val wrap"
                    rows={3}
                    value={draft.note}
                    placeholder="例如：Amazon 美区主号，仅用于价格采集"
                    onChange={(e) => patch({ note: e.target.value })}
                  />
                </Field>
              </div>

              <div className="fieldset">
                <div className="fs-head">
                  <h4>指纹种子</h4>
                </div>
                <Field
                  label="Seed"
                  action={
                    <button
                      type="button"
                      className="dice"
                      title="重掷种子并重新生成整套参数"
                      onClick={() => void regenerate()}
                      disabled={busy}
                    >
                      <Icon name="dice" size={12} strokeWidth={2} />
                    </button>
                  }
                >
                  <div className="val mono" title={draft.seed}>
                    {draft.seed}
                  </div>
                </Field>
                <div className="note">
                  种子由主密钥与环境 ID 经 HKDF 派生，不可手工编辑。同一个种子永远解析出同一套参数，
                  因此备份恢复、跨机迁移后指纹完全一致。
                </div>
              </div>
            </>
          ) : null}

          {tab === 'fingerprint' ? (
            <>
              <div className="fieldset">
                <div className="fs-head">
                  <h4>系统与浏览器</h4>
                  <span className={`badge${scoreTone === 'bad' ? ' bad' : scoreTone === 'warn' ? ' warn' : ''}`}>
                    一致性 {report.score}
                  </span>
                </div>

                <Field
                  label="操作系统"
                  action={
                    <button
                      type="button"
                      className="dice"
                      title="按平台模板重置"
                      onClick={() =>
                        setDraft((d) =>
                          d
                            ? {
                                ...d,
                                fingerprint: resolveFingerprint(d.platform, d.seed),
                                browserVersion: d.fingerprint.uaVersion
                              }
                            : d
                        )
                      }
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
                      setDraft((d) =>
                        d
                          ? {
                              ...d,
                              platform,
                              fingerprint: resolveFingerprint(platform, d.seed)
                            }
                          : d
                      )
                    }}
                  >
                    <option value="windows">Windows</option>
                    <option value="macos">macOS</option>
                    <option value="linux">Linux</option>
                  </select>
                </Field>

                <Field label="系统版本">
                  <input
                    className="val"
                    value={fp.osLabel}
                    onChange={(e) => patchFp({ osLabel: e.target.value })}
                  />
                </Field>

                <Field
                  label="User-Agent"
                  action={
                    <button
                      type="button"
                      className="dice"
                      title="使用平台模板 UA"
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
                  label="浏览器版本"
                  action={
                    <button
                      type="button"
                      className="dice"
                      title="与内置 Chromium 对齐"
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
                  <h4>区域与语言</h4>
                </div>

                <Field
                  label="时区"
                  action={
                    <button
                      type="button"
                      className="dice"
                      title="使用模板时区"
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

                <Field label="语言">
                  <input
                    className="val"
                    value={fp.locale}
                    onChange={(e) => patchFp({ locale: e.target.value })}
                  />
                </Field>

                <Field
                  label="语言列表"
                  action={
                    <button
                      type="button"
                      className="dice"
                      title="使用模板语言列表"
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
                  label="地理位置"
                  action={
                    <Toggle
                      checked={fp.geolocation !== null}
                      label="启用地理位置伪装"
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
                        aria-label="纬度"
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
                        aria-label="经度"
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
                      已关闭 · 站点会退回真实 IP 定位
                    </div>
                  )}
                </Field>
              </div>

              <div className="fieldset">
                <div className="fs-head">
                  <h4>硬件指纹</h4>
                </div>

                <Field label="分辨率">
                  <div style={{ display: 'flex', gap: 6, minWidth: 0 }}>
                    <input
                      className="val"
                      value={fp.screen.width}
                      aria-label="宽度"
                      onChange={(e) =>
                        patchFp({ screen: { ...fp.screen, width: Number(e.target.value) || 0 } })
                      }
                    />
                    <input
                      className="val"
                      value={fp.screen.height}
                      aria-label="高度"
                      onChange={(e) =>
                        patchFp({ screen: { ...fp.screen, height: Number(e.target.value) || 0 } })
                      }
                    />
                    <input
                      className="val"
                      value={fp.screen.dpr}
                      aria-label="像素比"
                      onChange={(e) =>
                        patchFp({ screen: { ...fp.screen, dpr: Number(e.target.value) || 1 } })
                      }
                    />
                  </div>
                </Field>

                <Field label="CPU / 内存">
                  <div style={{ display: 'flex', gap: 6, minWidth: 0 }}>
                    <input
                      className="val"
                      value={fp.hardware.cpuCores}
                      aria-label="CPU 核心数"
                      onChange={(e) =>
                        patchFp({
                          hardware: { ...fp.hardware, cpuCores: Number(e.target.value) || 1 }
                        })
                      }
                    />
                    <input
                      className="val"
                      value={fp.hardware.memoryGB}
                      aria-label="内存 GB"
                      onChange={(e) =>
                        patchFp({
                          hardware: { ...fp.hardware, memoryGB: Number(e.target.value) || 1 }
                        })
                      }
                    />
                  </div>
                </Field>

                <Field
                  label="WebGL 渲染器"
                  action={
                    <button
                      type="button"
                      className="dice"
                      title="使用模板渲染器"
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

                <Field label="GPU 厂商">
                  <input
                    className="val mono"
                    value={fp.webgl.vendor}
                    onChange={(e) => patchFp({ webgl: { ...fp.webgl, vendor: e.target.value } })}
                  />
                </Field>
              </div>

              <div className="fieldset">
                <div className="fs-head">
                  <h4>隐私噪声</h4>
                </div>

                <Field label="Canvas">
                  <select
                    className="val"
                    value={fp.canvas}
                    onChange={(e) => patchFp({ canvas: e.target.value as FingerprintConfig['canvas'] })}
                  >
                    <option value="noise">噪声模式 · 每次会话一致</option>
                    <option value="off">关闭 · 暴露真实指纹</option>
                  </select>
                </Field>

                <Field label="AudioContext">
                  <select
                    className="val"
                    value={fp.audio}
                    onChange={(e) => patchFp({ audio: e.target.value as FingerprintConfig['audio'] })}
                  >
                    <option value="noise">噪声模式</option>
                    <option value="off">关闭</option>
                  </select>
                </Field>

                <Field
                  label="WebRTC"
                  hint={
                    fp.webrtc === 'disabled'
                      ? '接口保留、候选全部丢弃 —— 与真实浏览器一致：WebRTC 是整特性开关，主世界和 Worker 里同真同假。'
                      : fp.webrtc === 'proxy'
                        ? '本地地址与 srflx（STUN 看到的真实公网 IP）全部丢弃，只放行非私有的 host 候选。'
                        : '不拦截任何候选，页面能拿到真实内网地址与公网 IP。'
                  }
                >
                  <select
                    className="val"
                    value={fp.webrtc}
                    onChange={(e) =>
                      patchFp({ webrtc: e.target.value as FingerprintConfig['webrtc'] })
                    }
                  >
                    <option value="proxy">代理转发 · 屏蔽本地 IP</option>
                    <option value="disabled">不产生候选 · 接口保留</option>
                    <option value="real">暴露真实 IP</option>
                  </select>
                </Field>

                <Field
                  label="字体列表"
                  action={
                    <button
                      type="button"
                      className="dice"
                      title="使用模板字体集"
                      onClick={() => patchFp({ fonts: [...tpl.fonts] })}
                    >
                      <Icon name="dice" size={12} strokeWidth={2} />
                    </button>
                  }
                >
                  <input
                    className="val"
                    value={`${fp.fonts.length} 项 · ${fp.fonts.slice(0, 3).join(' / ')}`}
                    title={fp.fonts.join(', ')}
                    readOnly
                  />
                </Field>
              </div>

              <div className={`consist${scoreTone ? ` ${scoreTone}` : ''}`}>
                <div className="ring" style={cssVars({ '--pct': report.score })}>
                  <span>{report.score}</span>
                </div>
                <div className="txt">
                  <b>
                    {report.score >= 95
                      ? '指纹一致性良好'
                      : report.score >= 80
                        ? '指纹基本一致'
                        : report.score >= 60
                          ? '存在明显矛盾'
                          : '指纹不可信'}
                  </b>
                  <span>{report.verdict}</span>
                </div>
              </div>
              <div className="note">
                评分口径：UA 与平台、UA 与浏览器版本、时区与经纬度、语言与地区、首选语言、WebRTC
                策略、噪声开关、是否配置代理。命中一条扣一次分，最低 0 分。
              </div>
            </>
          ) : null}

          {tab === 'proxy' ? (
            <>
              <div className="fieldset">
                <div className="fs-head">
                  <h4>出口代理</h4>
                  <span className={`badge${draft.proxy ? '' : ' warn'}`}>
                    {draft.proxy ? '已配置' : '直连'}
                  </span>
                </div>

                <Field label="协议">
                  <select
                    className="val"
                    value={draft.proxy?.type ?? 'http'}
                    onChange={(e) => {
                      const type = e.target.value as 'http' | 'https' | 'socks5'
                      patch({ proxy: { type, host: draft.proxy?.host ?? '', port: draft.proxy?.port ?? 8080 } })
                    }}
                  >
                    <option value="http">HTTP</option>
                    <option value="https">HTTPS</option>
                    <option value="socks5">SOCKS5</option>
                  </select>
                </Field>

                <Field label="主机">
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

                <Field label="端口">
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

                <Field label="用户名">
                  <input
                    className="val"
                    value={draft.proxy?.username ?? ''}
                    placeholder="可选"
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

                <Field label="密码">
                  <input
                    className="val"
                    type="password"
                    value={draft.proxy?.password ?? ''}
                    placeholder="可选"
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
                  <h4>出口信息</h4>
                </div>
                <Field label="当前出口">
                  <div className="val mono">
                    {draft.proxy ? `${draft.proxy.host}:${draft.proxy.port}` : '直连'}
                  </div>
                </Field>
                <Field label="地区匹配">
                  <div className="val">
                    {localeCountry(fp.locale)} · {tzOffsetLabel(fp.timezone)}
                  </div>
                </Field>
                <div className="note">
                  代理延迟由主进程拨测后回传，渲染层不发起探测请求。出口地区与指纹地区不一致时，
                  上面的「一致性评分」会直接扣分。
                </div>
                <div style={{ marginTop: 8 }}>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="close"
                    onClick={() => patch({ proxy: null })}
                  >
                    清除代理，改为直连
                  </Button>
                </div>
              </div>
            </>
          ) : null}

          {tab === 'shadow' ? (
            <>
              <div className="fieldset">
                <div className="fs-head">
                  <h4>影子空间</h4>
                </div>
                <Field label="独立会话">
                  <div className="val">开启 · 影子拥有独立 Cookie 与存储</div>
                </Field>
                <Field label="绑定方式">
                  <div className="val">打开窗口时自动新建影子标签</div>
                </Field>
                <Field label="风险动作">
                  <div className="val">L2 动作一律弹窗确认，不可跳过</div>
                </Field>
              </div>

              <div className="fieldset">
                <div className="fs-head">
                  <h4>反检测增强</h4>
                </div>
                <Field
                  label="ClientRects"
                  action={
                    <Toggle
                      checked={fp.clientRectsNoise}
                      label="ClientRects 噪声"
                      onChange={(on) => patchFp({ clientRectsNoise: on })}
                    />
                  }
                >
                  <div className="val">{fp.clientRectsNoise ? '噪声模式' : '关闭'}</div>
                </Field>
                <Field
                  label="WebGPU"
                  action={
                    <Toggle
                      checked={fp.webgpu}
                      label="WebGPU 上报"
                      onChange={(on) => patchFp({ webgpu: on })}
                    />
                  }
                >
                  <div className="val">{fp.webgpu ? '按平台上报' : '禁用'}</div>
                </Field>
                <div className="note">
                  ClientRects 噪声会让元素边界产生亚像素级抖动，抵御基于布局测量的指纹；
                  代价是极少数依赖精确坐标的站点可能出现 1px 偏移。
                </div>
              </div>

              <div className="fieldset">
                <div className="fs-head">
                  <h4>最近使用</h4>
                </div>
                <Field label="最后启动">
                  <div className="val">{formatRelative(draft.lastUsedAt)}</div>
                </Field>
                <Field label="更新时间">
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
            onClick={() =>
              setDraft((d) => (d ? { ...d, fingerprint: resolveFingerprint(d.platform, d.seed) } : d))
            }
          >
            重置为默认
          </Button>
          <div className="spacer" />
          <Button variant="ghost" disabled={busy} onClick={() => void save(false)}>
            仅保存
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save(true)}>
            保存并启动
          </Button>
        </div>
      </aside>
    </>
  )
}
