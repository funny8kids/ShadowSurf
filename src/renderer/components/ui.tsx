/**
 * 小组件集合：图标 / 按钮 / 徽标 / 开关 / 字段行 / 弹窗 / Toast，
 * 以及一组新增的受控原语（Select / Tabs / Tooltip / Checkbox / Input / Card
 * / Badge / Skeleton / Spinner / Popover / Segmented）。
 *
 * 全部为受控组件，不持有业务状态；新增原语的颜色、间距、时长、层级都走
 * styles/tokens.css 里的令牌，样式类名放在 styles/base.css（CommandPalette 除外）。
 * 文本一律通过 React 文本节点渲染（等价于 textContent），页面标题、模型输出
 * 这类不可信数据不会被当作 HTML 解析。
 */

import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode,
  RefObject
} from 'react'

/* ────────────────────────────── 类名 / CSS 变量 ────────────────────────────── */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p)).join(' ')
}

/** 允许把 --c / --pct 这类自定义属性写进 style */
export function cssVars(vars: Record<string, string | number>): CSSProperties {
  return vars as unknown as CSSProperties
}

/* ────────────────────────────── 焦点辅助 ────────────────────────────── */

/** 容器内可聚焦元素的统一选择器，焦点陷阱和「找首个焦点」都用它 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** 取容器内所有当前可见、可聚焦的元素 */
function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement
  )
}

/**
 * 把 Tab / Shift+Tab 挡在容器内循环。
 * 返回清理函数；esc 由各组件自己处理，避免和业务逻辑耦合。
 */
function trapFocus(container: HTMLElement, event: ReactKeyboardEvent): void {
  if (event.key !== 'Tab') return
  const items = focusableIn(container)
  if (items.length === 0) {
    // 没有任何可聚焦元素时，锁在容器自身（容器需带 tabindex=-1）
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
  | 'sun'
  | 'moon'
  | 'auto'

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
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.1 5.1l1.4 1.4M17.5 17.5l1.4 1.4M18.9 5.1l-1.4 1.4M6.5 17.5l-1.4 1.4" />
    </>
  ),
  moon: <path d="M20 14.2A8.2 8.2 0 1 1 9.8 4a6.6 6.6 0 0 0 10.2 10.2z" />,
  // 跟随系统：半明半暗的圆，比「齿轮」「显示器」更直接
  auto: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" />
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
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'accent' | 'info'
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
  action,
  hint
}: {
  label: string
  children: ReactNode
  action?: ReactNode
  /** 一行补充说明。用于「选项名字不足以说清后果」的场合，比 title 提示更可靠 */
  hint?: string
}) {
  // 稳定 id：label 的 htmlFor 和原生控件的 id 必须成对，读屏才能把标签读出来。
  // 不用 index、不用随机数 —— useId 在 SSR / StrictMode 双挂载下都稳定。
  const id = useId()
  const hintId = `${id}-hint`

  // 只在子节点是原生表单控件时注入 id（和 aria-describedby）。
  // 用 cloneElement 且「仅当子节点没写这些属性时才补」，这样消费方显式传的 id
  // 不会被覆盖 —— 这是 39 处 Field 调用零改动的关键。非表单子节点（如一组按钮、
  // 纯文本 val）原样渲染，label 对它们没有语义指向，交给消费方自己加 aria-label。
  const enhanced = Children.map(children, (child) => {
    if (
      isValidElement(child) &&
      typeof child.type === 'string' &&
      (child.type === 'input' || child.type === 'select' || child.type === 'textarea')
    ) {
      const el = child as ReactElement<Record<string, unknown>>
      const patch: Record<string, unknown> = {}
      if (el.props.id === undefined || el.props.id === null) patch.id = id
      if (hint && (el.props['aria-describedby'] === undefined || el.props['aria-describedby'] === null)) {
        patch['aria-describedby'] = hintId
      }
      return Object.keys(patch).length > 0 ? cloneElement(el, patch) : child
    }
    return child
  })

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {enhanced}
      {action ?? <span />}
      {hint ? (
        <span className="field-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
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
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  // onClose 常是父组件里的内联函数，每次渲染都换引用。
  // 放进 ref 后焦点逻辑只依赖 open，父组件重渲染不会把焦点抢来抢去。
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  /* 退场动画：关闭时不立刻卸载，先播 150ms 加速退场再真正 onClose。
     之前是 `if (!open) return null` 直接瞬切 —— 进场有动画、退场没有，
     是「不够丝滑」最直观的一处。closing 期间遮罩仍可点（幂等）。 */
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const closeTimer = useRef<number | null>(null)

  const requestClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    closeTimer.current = window.setTimeout(() => {
      closingRef.current = false
      setClosing(false)
      closeRef.current()
    }, 150)
  }, [])

  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    // 记住打开前的焦点，关闭后还回去 —— 否则焦点会掉到 body，键盘用户得从头 Tab。
    const previous = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    if (dialog) {
      const first = focusableIn(dialog)[0]
      // 没有可聚焦元素时聚焦 dialog 自身（它带 tabIndex=-1），保证焦点确实进来了。
      ;(first ?? dialog).focus()
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        requestClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [open, requestClose])

  if (!open) return null

  return (
    <div
      className={cx('modal-mask', closing && 'closing')}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose()
      }}
    >
      <div
        ref={dialogRef}
        className={cx('modal', align === 'left' && 'left')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (dialogRef.current) trapFocus(dialogRef.current, e)
        }}
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
        <h3 id={titleId}>{title}</h3>
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
  /** 退场中：播 150ms 加速退场后再从列表移除，避免瞬切 */
  out?: boolean
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

  /* 退场：到点先给这一项打 .out，播 150ms 加速退场再移除。
     之前是到点直接从数组过滤 —— 瞬切，不丝滑。 */
  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.map((t) => (t.id === id ? { ...t, out: true } : t)))
    const t = window.setTimeout(() => {
      setItems((prev) => prev.filter((x) => x.id !== id))
    }, 150)
    timers.current.push(t)
  }, [])

  const push = useCallback(
    (text: string, tone: ToastTone = 'err') => {
      seq.current += 1
      const id = seq.current
      setItems((prev) => [...prev.slice(-3), { id, tone, text, out: false }])
      const timer = window.setTimeout(() => dismiss(id), tone === 'err' ? 5200 : 2600)
      timers.current.push(timer)
    },
    [dismiss]
  )

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
          <div key={t.id} className={cx('toast', t.tone, t.out && 'out')}>
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

/* ══════════════════════════════════════════════════════════════════════════
 * 新增原语
 *
 * 这些都是受控组件，颜色/间距/时长/层级一律走 tokens.css 的新刻度，
 * 样式类名在 base.css（CommandPalette 单独在 command-palette.css）。
 * 它们是给新代码用的，旧组件无需改动，因此没有视觉回归风险。
 * ══════════════════════════════════════════════════════════════════════════ */

/* ────────────────────────────── Input / Textarea ────────────────────────────── */

interface InputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  type?: string
  hint?: string
  id?: string
}

/** 受控单行输入。hint 存在时用 aria-describedby 指向说明文字 */
export function Input({ value, onChange, placeholder, disabled, type = 'text', hint, id }: InputProps) {
  const autoId = useId()
  const inputId = id ?? autoId
  const hintId = `${inputId}-hint`
  return (
    <>
      <input
        id={inputId}
        className="ui-input"
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? (
        <span className="ui-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </>
  )
}

/** 受控多行输入。用法与 Input 一致 */
export function Textarea({
  value,
  onChange,
  placeholder,
  disabled,
  hint,
  id,
  rows
}: InputProps & { rows?: number }) {
  const autoId = useId()
  const inputId = id ?? autoId
  const hintId = `${inputId}-hint`
  return (
    <>
      <textarea
        id={inputId}
        className="ui-textarea"
        rows={rows}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? (
        <span className="ui-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </>
  )
}

/* ────────────────────────────── Select ────────────────────────────── */

interface SelectProps {
  options: { value: string; label: string }[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  hint?: string
  id?: string
}

/** 受控下拉。label 由外层 Field 约定提供（见 Field 的 htmlFor/id 注入） */
export function Select({ options, value, onChange, disabled, hint, id }: SelectProps) {
  const autoId = useId()
  const selectId = id ?? autoId
  const hintId = `${selectId}-hint`
  return (
    <>
      <select
        id={selectId}
        className="ui-select"
        value={value}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {hint ? (
        <span className="ui-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </>
  )
}

/* ────────────────────────────── Checkbox ────────────────────────────── */

interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  disabled?: boolean
  id?: string
}

/** 受控复选框：原生 input 保留语义（含 aria-checked），方块只是视觉替代 */
export function Checkbox({ checked, onChange, label, disabled, id }: CheckboxProps) {
  const autoId = useId()
  const inputId = id ?? autoId
  return (
    <label className="ui-checkbox" htmlFor={inputId}>
      <input
        id={inputId}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="ui-checkbox-box" aria-hidden="true">
        {checked ? <Icon name="check" size={12} strokeWidth={2.4} /> : null}
      </span>
      <span className="ui-checkbox-label">{label}</span>
    </label>
  )
}

/* ────────────────────────────── Card ────────────────────────────── */

interface CardProps {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
}

/** 语义化卡片：用 <article>，标题/副标题/操作区可选 */
export function Card({ title, subtitle, actions, children, className }: CardProps) {
  return (
    <article className={cx('ui-card', className)}>
      {title || subtitle || actions ? (
        <div className="ui-card-head">
          <div>
            {title ? <div className="ui-card-title">{title}</div> : null}
            {subtitle ? <div className="ui-card-subtitle">{subtitle}</div> : null}
          </div>
          {actions ? <div className="ui-card-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </article>
  )
}

/* ────────────────────────────── Badge ────────────────────────────── */

/**
 * Badge 是 Chip 的重命名友好别名，补上了 Chip 原来没有的 info 档。
 * 等消费方从 Chip 迁过来后，可以只改这一处实现。
 */
export function Badge({
  tone = 'neutral',
  children
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'accent' | 'info'
  children: ReactNode
}) {
  return <Chip tone={tone}>{children}</Chip>
}

/* ────────────────────────────── Skeleton / Spinner ────────────────────────────── */

interface SkeletonProps {
  width?: number | string
  height?: number | string
  radius?: number | string
  circle?: boolean
}

/** 骨架占位条：基于 base.css 的 .skeleton，radius/circle 走 --sk-radius */
export function Skeleton({ width, height, radius, circle }: SkeletonProps) {
  const style: Record<string, string | number> = {
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(circle ? { borderRadius: '50%' } : radius !== undefined ? { '--sk-radius': radius } : {})
  }
  return <span className="skeleton" style={cssVars(style)} aria-hidden="true" />
}

/** 加载指示器：复用 app.css 的 rot 关键帧，尺寸/无障碍标签可配 */
export function Spinner({ size = 16, label = '加载中' }: { size?: number; label?: string }) {
  return (
    <span
      className="ui-spinner"
      style={{ width: size, height: size, borderWidth: Math.max(2, Math.round(size / 8)) }}
      role="status"
      aria-label={label}
    />
  )
}

/* ────────────────────────────── Tabs ────────────────────────────── */

interface TabItem {
  id: string
  label: string
  icon?: IconName
  disabled?: boolean
}

interface TabsProps {
  items: TabItem[]
  active: string
  onChange: (id: string) => void
  'aria-label': string
  children?: ReactNode | ((activeId: string) => ReactNode)
}

/**
 * 受控 Tabs：roving tabindex —— 只有当前 tab 可 Tab 聚焦，
 * 左右方向键在可用 tab 间移动并激活。面板通过 aria-controls / aria-labelledby
 * 与 tab 双向关联。children 可以是节点，也可以是以当前 id 为参数的渲染函数。
 */
export function Tabs({ items, active, onChange, children, ...aria }: TabsProps) {
  const baseId = useId()
  const tabId = (id: string) => `${baseId}-tab-${id}`
  const panelId = (id: string) => `${baseId}-panel-${id}`
  const enabled = items.filter((item) => !item.disabled)
  const panelIdForActive = panelId(active)

  const move = (dir: 1 | -1) => {
    if (enabled.length === 0) return
    const idx = enabled.findIndex((item) => item.id === active)
    const next = enabled[(idx + dir + enabled.length) % enabled.length]
    if (next) {
      onChange(next.id)
      // 焦点跟随到新 tab；id 是 DOM 上的，下一帧即可聚焦
      requestAnimationFrame(() => {
        document.getElementById(tabId(next.id))?.focus()
      })
    }
  }

  const onTabKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Home' && enabled[0]) {
      e.preventDefault()
      onChange(enabled[0].id)
    } else if (e.key === 'End' && enabled[enabled.length - 1]) {
      e.preventDefault()
      onChange(enabled[enabled.length - 1].id)
    }
  }

  return (
    <div>
      <div className="ui-tabs" role="tablist" aria-label={aria['aria-label']}>
        {items.map((item) => {
          const selected = item.id === active
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={tabId(item.id)}
              className="ui-tab"
              aria-selected={selected}
              aria-controls={panelId(item.id)}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => onChange(item.id)}
              onKeyDown={onTabKeyDown}
            >
              {item.icon ? <Icon name={item.icon} size={13} /> : null}
              {item.label}
            </button>
          )
        })}
      </div>
      <div
        className="ui-tabpanel"
        role="tabpanel"
        id={panelIdForActive}
        aria-labelledby={tabId(active)}
        tabIndex={0}
      >
        {typeof children === 'function' ? children(active) : children}
      </div>
    </div>
  )
}

/* ────────────────────────────── Tooltip ────────────────────────────── */

/** 轻量 tooltip：hover / focus 都显示，靠 CSS 定位，不依赖 title= */
export function Tooltip({
  content,
  children
}: {
  content: ReactNode
  children: ReactNode
}) {
  const id = useId()
  // 把 aria-describedby 注入到可聚焦的子节点上，读屏聚焦时能读到提示。
  // 子节点不是元素（纯文本等）时不注入，退化为视觉提示。
  const described = Children.map(children, (child) =>
    isValidElement(child) && typeof child.type === 'string'
      ? cloneElement(child as ReactElement<Record<string, unknown>>, { 'aria-describedby': id })
      : child
  )
  return (
    <span className="ui-tooltip">
      {described}
      <span className="ui-tooltip-bubble" role="tooltip" id={id}>
        {content}
      </span>
    </span>
  )
}

/* ────────────────────────────── Popover ────────────────────────────── */

interface PopoverProps {
  open: boolean
  anchor: RefObject<HTMLElement | null> | HTMLElement | null
  onClose: () => void
  children: ReactNode
  'aria-label'?: string
}

/**
 * 受控 popover：Escape 和点击外部关闭，关闭后把焦点还给 anchor。
 * 定位只做 CSS 的「左对齐 + 下方」（见 base.css 的 .ui-popover），
 * 不做碰撞检测/自动翻转 —— 贴边可能溢出，这是刻意的简化。
 */
export function Popover({ open, anchor, onClose, children, ...aria }: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const anchorEl =
    anchor && 'current' in anchor ? anchor.current : anchor
  // 同 Modal：onClose 用 ref 保持新鲜，焦点逻辑只依赖 open / anchorEl。
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
      }
    }
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      if (anchorEl?.contains(target)) return
      closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    // 捕获阶段监听：即使面板里的控件 stopPropagation 了也能正确关闭
    window.addEventListener('mousedown', onPointer, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onPointer, true)
      anchorEl?.focus()
    }
  }, [open, anchorEl])

  if (!open) return null

  return (
    <div ref={panelRef} className="ui-popover" role="dialog" aria-label={aria['aria-label']}>
      {children}
    </div>
  )
}

/* ────────────────────────────── Segmented ────────────────────────────── */

interface SegmentedProps {
  items: { id: string; label: string; icon?: IconName; disabled?: boolean }[]
  active: string
  onChange: (id: string) => void
  'aria-label'?: string
}

/** 受控分段控件，替代 ProfileGrid 里 ad-hoc 的 .seg 结构 */
export function Segmented({ items, active, onChange, ...aria }: SegmentedProps) {
  return (
    <div className="ui-segmented" role="group" aria-label={aria['aria-label']}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={item.id === active}
          disabled={item.disabled}
          onClick={() => onChange(item.id)}
        >
          {item.icon ? <Icon name={item.icon} size={12} /> : null}
          {item.label}
        </button>
      ))}
    </div>
  )
}

/* ────────────────────────────── AnimatedNumber ────────────────────────────── */

interface AnimatedNumberProps {
  value: number
  /** 补间时长，默认 250ms（--dur-5） */
  durationMs?: number
  format?: (n: number) => string
  className?: string
}

/**
 * 数字补间：值变化时从旧值滚动到新值，而不是瞬变。
 *
 * 为什么需要：统计卡与审计分数是用户判断「有没有变化」的第一眼读数，
 * 瞬变会让人分不清「刚变」还是「一直是这个数」。250ms 的滚动补间把变化
 * 本身变成可读的信息。
 *
 * 尊重 reduced-motion：媒体查询命中时直接跳到终值，不做补间。
 */
export function AnimatedNumber({ value, durationMs = 250, format, className }: AnimatedNumberProps) {
  const [shown, setShown] = useState(value)
  const fromRef = useRef(value)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    // 尊重 reduced-motion：直接落终值
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      fromRef.current = value
      setShown(value)
      return
    }
    const from = fromRef.current
    if (from === value) return
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs)
      // easeOutCubic：起步快、落点稳
      const eased = 1 - Math.pow(1 - t, 3)
      const next = Math.round(from + (value - from) * eased)
      setShown(next)
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        fromRef.current = value
      }
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      fromRef.current = value
    }
  }, [value, durationMs])

  return <span className={className}>{format ? format(shown) : shown}</span>
}
