/**
 * 命令面板（Ctrl/Cmd+K 风格）。
 *
 * 完全受控：open / onClose 由调用方管，快捷键监听也由调用方负责 ——
 * 这样多个面板、多处入口可以共存，组件本身不装全局监听，保持可组合。
 *
 * 键盘交互：输入过滤（label + keywords，大小写不敏感）、上下键移动高亮、
 * Enter 执行、Esc 关闭。焦点管理：打开时聚焦搜索框，期间 Trap 在面板内，
 * 关闭后还给打开前的元素。所有颜色/间距/时长/层级都走 tokens.css。
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import { Icon, cx } from './ui'
import type { IconName } from './ui'
import '../styles/command-palette.css'

/* electron-vite 在 TSX 里处理 CSS import（main.tsx 及各工具面板已经这么做），
   所以面板样式单独放 command-palette.css 从组件导入，不塞进 base.css。 */

export interface Command {
  id: string
  label: string
  hint?: string
  icon?: IconName
  group?: string
  keywords?: string[]
  shortcut?: string
  run: () => void
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  commands: Command[]
  placeholder?: string
  emptyText?: string
}

// 面板内可聚焦元素：目前只有搜索框，但保留通用的 Trap 以便将来加按钮。
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function CommandPalette({
  open,
  onClose,
  commands,
  placeholder = '搜索命令…',
  emptyText = '没有匹配的命令'
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  // 退场：关闭时先加 .cp-closing 播 150ms 加速退场，再真正 onClose。
  // .cp-closing 的样式早已在 command-palette.css 定义但从未被使用（死代码），
  // 这里把它接上 —— 进场有动画、退场瞬切是「不够丝滑」的典型。
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const closeTimer = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  /* 行引用：方向键移动高亮后由 effect 滚动到可见区。
     为什么不写在 ref 回调里：ref 回调每次 render 都会重跑，会在渲染期同步
     scrollIntoView，强制一次布局；移到 effect 后只在 highlight 变化时滚一次。 */
  const rowRefs = useRef<Array<HTMLDivElement | null>>([])
  const baseId = useId()
  const inputId = `${baseId}-input`
  const listId = `${baseId}-list`

  const requestClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    closeTimer.current = window.setTimeout(() => {
      closingRef.current = false
      setClosing(false)
      onClose()
    }, 150)
  }, [onClose])

  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    }
  }, [])

  // 过滤：label + keywords 大小写不敏感；query 用空白拆词，必须全部命中。
  const results = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return commands
    return commands.filter((cmd) => {
      const haystack = [cmd.label, ...(cmd.keywords ?? [])].join(' ').toLowerCase()
      return terms.every((t) => haystack.includes(t))
    })
  }, [commands, query])

  // 过滤结果变了就把高亮夹回合法范围，避免高亮指向不存在的行。
  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, results.length - 1)))
  }, [results.length])

  // 高亮变化时把当前行滚进视口。方向键把高亮移出视口时，否则 Enter 会执行一条看不见的命令。
  useEffect(() => {
    rowRefs.current[highlight]?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  // 打开时：清空查询、重置高亮、记住焦点并聚焦搜索框；关闭时还焦点。
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    setQuery('')
    setHighlight(0)
    // StrictMode 双挂载下 focus 是幂等的，重复聚焦没有副作用。
    requestAnimationFrame(() => inputRef.current?.focus())
    return () => previous?.focus()
  }, [open])

  if (!open) return null

  const optionId = (index: number) => `${baseId}-option-${index}`

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      requestClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => (results.length === 0 ? 0 : (h + 1) % results.length))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => (results.length === 0 ? 0 : (h - 1 + results.length) % results.length))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = results[highlight]
      if (cmd) {
        cmd.run()
        requestClose()
      }
      return
    }
    if (e.key === 'Tab' && dialogRef.current) {
      // 焦点陷阱：面板里可聚焦元素很少，确保焦点不会跑到面板背后。
      const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) {
        e.preventDefault()
        dialogRef.current.focus()
        return
      }
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  let flatIndex = -1

  return (
    <div className={cx('cp-mask', closing && 'cp-closing')} onMouseDown={(e) => {
      if (e.target === e.currentTarget) requestClose()
    }}>
      <div
        ref={dialogRef}
        className="cp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="cp-search">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            id={inputId}
            className="cp-input"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={results.length > 0 ? optionId(highlight) : undefined}
            value={query}
            placeholder={placeholder}
            onChange={(e) => {
              setQuery(e.target.value)
              setHighlight(0)
            }}
          />
          <kbd className="cp-esc">Esc</kbd>
        </div>

        <div className="cp-results" id={listId} role="listbox" aria-label="命令结果">
          {results.length === 0 ? (
            <div className="cp-empty">{emptyText}</div>
          ) : (
            results.map((cmd) => {
              flatIndex += 1
              const index = flatIndex
              const groupChanged = index === 0 || cmd.group !== results[index - 1].group
              return (
                <div key={cmd.id}>
                  {cmd.group && groupChanged ? (
                    <div className="cp-group">{cmd.group}</div>
                  ) : null}
                  <div
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === highlight}
                    className={cx('cp-row', index === highlight && 'active')}
                    ref={(el) => {
                      rowRefs.current[index] = el
                    }}
                    onMouseEnter={() => setHighlight(index)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      cmd.run()
                      requestClose()
                    }}
                  >
                    {cmd.icon ? (
                      <span className="cp-row-icon">
                        <Icon name={cmd.icon} size={15} />
                      </span>
                    ) : (
                      <span className="cp-row-icon" aria-hidden="true" />
                    )}
                    <span className="cp-row-label">{cmd.label}</span>
                    {cmd.hint ? <span className="cp-row-hint">{cmd.hint}</span> : null}
                    {cmd.shortcut ? <kbd className="cp-row-key">{cmd.shortcut}</kbd> : null}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
