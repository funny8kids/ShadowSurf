/**
 * 小组件集合：图标 / 按钮 / 徽标 / 开关 / 字段行 / 弹窗 / Toast。
 *
 * 全部为受控组件，不持有业务状态；样式全部走 styles/app.css 里的类名。
 * 文本一律通过 React 文本节点渲染（等价于 textContent），页面标题、模型输出
 * 这类不可信数据不会被当作 HTML 解析。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

/* ────────────────────────────── 类名 / CSS 变量 ────────────────────────────── */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p)).join(' ')
}

/** 允许把 --c / --pct 这类自定义属性写进 style */
export function cssVars(vars: Record<string, string | number>): CSSProperties {
  return vars as unknown as CSSProperties
}

/* ────────────────────────────── 图标 ────────────────────────────── */

export type IconName =
  | 'wave'
  | 'grid'
  | 'tasks'
  | 'globe'
  | 'shield'
  | 'users'
  | 'list'
  | 'settings'
  | 'search'
  | 'bell'
  | 'plus'
  | 'close'
  | 'check'
  | 'more'
  | 'chevronLeft'
  | 'chevronRight'
  | 'reload'
  | 'lock'
  | 'play'
  | 'pause'
  | 'stop'
  | 'trash'
  | 'folder'
  | 'swap'
  | 'send'
  | 'eye'
  | 'eyeOff'
  | 'alert'
  | 'sliders'
  | 'download'
  | 'dice'
  | 'spark'
  | 'external'
  | 'arrowRight'
  | 'square'
  | 'hand'

const ICON_PATHS: Record<IconName, ReactNode> = {
  wave: <path d="M3 12h4l2.5-7 3.5 14 2.5-7H21" />,
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  tasks: (
    <>
      <path d="M9 11l3 3 8-8" />
      <path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9c-4-1.5-7-4.5-7-9V6z" />
      <path d="M9.5 12l2 2 3.5-4" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <path d="M16 5.5a3.2 3.2 0 0 1 0 5.6M18 14.5c2 .8 3 2.9 3 5.5" />
    </>
  ),
  list: <path d="M4 7h16M4 12h16M4 17h10" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 11.5 4V3.8a2 2 0 1 1 4 0V4a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 22 11a2 2 0 1 1 0 4z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M4 12l5 5L20 6" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  chevronLeft: <path d="M15 18l-6-6 6-6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  reload: <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" />,
  lock: (
    <>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  play: <path d="M8 5v14l11-7z" fill="currentColor" stroke="none" />,
  pause: <path d="M9 5v14M15 5v14" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />,
  square: <rect x="6" y="6" width="12" height="12" rx="1" />,
  trash: <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />,
  folder: <path d="M4 7h16M4 12h16M4 17h10" />,
  swap: (
    <>
      <path d="M4 8h13l-3-3M20 16H7l3 3" />
    </>
  ),
  send: <path d="M4 12h13M12 6l6 6-6 6" />,
  eye: (
    <>
      <path d="M2 12s3.6-6.8 10-6.8S22 12 22 12s-3.6 6.8-10 6.8S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M2 12s3.6-6.8 10-6.8c1.6 0 3 .4 4.2 1M22 12s-3.6 6.8-10 6.8c-1.6 0-3-.4-4.2-1" />
      <path d="M4 20L20 4" />
    </>
  ),
  alert: (
    <>
      <path d="M12 8v5M12 16.5v.5" />
      <circle cx="12" cy="12" r="9" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 8h10M18 8h2M4 16h4M12 16h8" />
      <circle cx="16" cy="8" r="2" />
      <circle cx="10" cy="16" r="2" />
    </>
  ),
  download: <path d="M12 4v11M7.5 11L12 15.5 16.5 11M5 20h14" />,
  dice: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <circle cx="9" cy="9" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="15" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  spark: <path d="M12 3l2.2 6.2L20.5 11l-6.3 1.8L12 19l-2.2-6.2L3.5 11l6.3-1.8z" />,
  external: <path d="M14 4h6v6M20 4l-8 8M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />,
  arrowRight: <path d="M5 12h13M12 6l6 6-6 6" />,
  hand: (
    <>
      <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6.5a1.5 1.5 0 0 1 3 0V13" />
      <path d="M17 11.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-2a6 6 0 0 1-6-6v-3l-1.6-2.4a1.5 1.5 0 0 1 2.4-1.8L8 10" />
    </>
  )
}

interface IconProps {
  name: IconName
  size?: number
  strokeWidth?: number
  className?: string
}

export function Icon({ name, size = 16, strokeWidth = 1.8, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name]}
    </svg>
  )
}

/* ────────────────────────────── 按钮 ────────────────────────────── */

type ButtonVariant = 'primary' | 'ghost' | 'quiet' | 'danger' | 'take'

interface ButtonProps {
  children?: ReactNode
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  icon?: IconName
  onClick?: () => void
  disabled?: boolean
  title?: string
  type?: 'button' | 'submit'
  className?: string
  ariaLabel?: string
}

export function Button({
  children,
  variant = 'ghost',
  size = 'md',
  icon,
  onClick,
  disabled,
  title,
  type = 'button',
  className,
  ariaLabel
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', className)}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
    >
      {icon ? <Icon name={icon} size={size === 'sm' ? 12 : 13} /> : null}
      {children}
    </button>
  )
}

/* ────────────────────────────── 徽标 / 开关 / 字段 ────────────────────────────── */

export function Chip({
  tone = 'neutral',
  children
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'accent'
  children: ReactNode
}) {
  return <span className={cx('chip', tone !== 'neutral' && tone)}>{children}</span>
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx('toggle', checked && 'on')}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  )
}

export function Field({
  label,
  children,
  action
}: {
  label: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {action ?? <span />}
    </div>
  )
}

/* ────────────────────────────── 弹窗 ────────────────────────────── */

interface ModalProps {
  open: boolean
  title: string
  icon?: IconName
  tone?: 'danger' | 'accent'
  children?: ReactNode
  footer?: ReactNode
  note?: string
  onClose: () => void
  align?: 'center' | 'left'
  maxWidth?: number
}

export function Modal({
  open,
  title,
  icon = 'alert',
  tone = 'danger',
  children,
  footer,
  note,
  onClose,
  align = 'center',
  maxWidth
}: ModalProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={cx('modal', align === 'left' && 'left')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={maxWidth ? { maxWidth } : undefined}
      >
        <div
          className="m-icon"
          style={
            tone === 'accent'
              ? { background: 'var(--accent-2)', color: 'var(--accent)' }
              : undefined
          }
        >
          <Icon name={icon} size={16} strokeWidth={2} />
        </div>
        <h3>{title}</h3>
        <div className="m-body">{children}</div>
        {footer ? <div className="m-foot">{footer}</div> : null}
        {note ? <div className="m-note">{note}</div> : null}
      </div>
    </div>
  )
}

/* ────────────────────────────── Toast ────────────────────────────── */

export type ToastTone = 'ok' | 'err' | 'info'

interface ToastItem {
  id: number
  tone: ToastTone
  text: string
}

interface ToastApi {
  push: (text: string, tone?: ToastTone) => void
}

const ToastContext = createContext<ToastApi>({ push: () => {} })

export function useToast(): ToastApi {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)
  const timers = useRef<number[]>([])

  const push = useCallback((text: string, tone: ToastTone = 'err') => {
    seq.current += 1
    const id = seq.current
    setItems((prev) => [...prev.slice(-3), { id, tone, text }])
    const timer = window.setTimeout(
      () => {
        setItems((prev) => prev.filter((t) => t.id !== id))
      },
      tone === 'err' ? 5200 : 2600
    )
    timers.current.push(timer)
  }, [])

  useEffect(() => {
    return () => {
      timers.current.forEach((t) => window.clearTimeout(t))
    }
  }, [])

  const api = useMemo<ToastApi>(() => ({ push }), [push])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx('toast', t.tone)}>
            <Icon
              name={t.tone === 'ok' ? 'check' : t.tone === 'info' ? 'spark' : 'alert'}
              size={13}
              strokeWidth={2}
            />
            <div className="tx">{t.text}</div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
