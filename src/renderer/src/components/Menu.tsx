import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { mdiCheck } from '@mdi/js'
import { cx } from '../lib/util'
import { Icon } from './Icon'

export type MenuEntry =
  | { type: 'divider' }
  | { type: 'header'; label: string }
  | {
      type?: 'item'
      label: string
      icon?: string
      /** Shows a check mark column; true = checked. */
      checked?: boolean
      detail?: string
      disabled?: boolean
      danger?: boolean
      onClick?: () => void
    }

export interface MenuAnchor {
  /** Viewport rectangle the menu is attached to. */
  top: number
  bottom: number
  left: number
  right: number
}

interface MenuListProps {
  anchor: MenuAnchor
  align?: 'left' | 'right'
  entries: MenuEntry[]
  onClose: () => void
  className?: string
}

/** A floating menu rendered at the document root so no container can clip it. */
export function MenuList({ anchor, align = 'left', entries, onClose, className }: MenuListProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const margin = 8
    let left = align === 'right' ? anchor.right - width : anchor.left
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin))
    let top = anchor.bottom + 4
    if (top + height > window.innerHeight - margin) {
      const above = anchor.top - 4 - height
      top = above >= margin ? above : Math.max(margin, window.innerHeight - height - margin)
    }
    setPos({ top, left })
  }, [anchor.top, anchor.bottom, anchor.left, anchor.right, align, entries.length])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    // Capture phase, so the menu closes even when a handler stops propagation.
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const hasChecks = entries.some((e) => (e.type === undefined || e.type === 'item') && e.checked !== undefined)

  return createPortal(
    <div
      ref={ref}
      className={cx('dropdown-menu', className)}
      role="menu"
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((entry, i) => {
        if (entry.type === 'divider') return <div key={i} className="dropdown-divider" />
        if (entry.type === 'header') {
          return (
            <div key={i} className="dropdown-header">
              {entry.label}
            </div>
          )
        }
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={cx('dropdown-item', entry.danger && 'danger')}
            disabled={entry.disabled}
            onClick={() => {
              onClose()
              entry.onClick?.()
            }}
          >
            {hasChecks && <span className="check">{entry.checked && <Icon path={mdiCheck} size={18} />}</span>}
            {entry.icon && <Icon path={entry.icon} size={18} />}
            <span>{entry.label}</span>
            {entry.detail && <span className="detail">{entry.detail}</span>}
          </button>
        )
      })}
    </div>,
    document.body
  )
}

interface DropdownProps {
  entries: MenuEntry[] | (() => MenuEntry[])
  align?: 'left' | 'right'
  className?: string
  menuClassName?: string
  /** Renders the trigger; call `toggle` from its click handler. */
  children: (toggle: () => void, open: boolean) => React.ReactNode
}

export function Dropdown({ entries, align, className, menuClassName, children }: DropdownProps): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)

  const toggle = (): void => {
    if (anchor) {
      setAnchor(null)
      return
    }
    const r = ref.current?.getBoundingClientRect()
    if (r) setAnchor({ top: r.top, bottom: r.bottom, left: r.left, right: r.right })
  }

  return (
    <span ref={ref} className={cx('dropdown', className)}>
      {children(toggle, anchor !== null)}
      {anchor && (
        <MenuList
          anchor={anchor}
          align={align}
          className={menuClassName}
          entries={typeof entries === 'function' ? entries() : entries}
          onClose={() => setAnchor(null)}
        />
      )}
    </span>
  )
}

/** Menu shown at the pointer position (right-click). */
export function ContextMenu({
  x,
  y,
  entries,
  onClose
}: {
  x: number
  y: number
  entries: MenuEntry[]
  onClose: () => void
}): React.JSX.Element {
  return <MenuList anchor={{ top: y, bottom: y, left: x, right: x }} entries={entries} onClose={onClose} />
}
