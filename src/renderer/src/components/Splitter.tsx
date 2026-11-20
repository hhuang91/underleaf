import { useRef } from 'react'
import { cx } from '../lib/util'

interface SplitterProps {
  className?: string
  onStart: () => void
  /** Horizontal distance from where the drag started. */
  onDrag: (deltaX: number) => void
  onEnd: () => void
  onDoubleClick?: () => void
  children?: React.ReactNode
}

/** A vertical divider that can be dragged left and right. */
export function Splitter({ className, onStart, onDrag, onEnd, onDoubleClick, children }: SplitterProps): React.JSX.Element {
  const startX = useRef<number | null>(null)

  return (
    <div
      className={cx('splitter', className)}
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
        e.currentTarget.setPointerCapture(e.pointerId)
        startX.current = e.clientX
        document.body.classList.add('resizing')
        onStart()
      }}
      onPointerMove={(e) => {
        if (startX.current !== null) onDrag(e.clientX - startX.current)
      }}
      onPointerUp={(e) => {
        if (startX.current === null) return
        startX.current = null
        e.currentTarget.releasePointerCapture(e.pointerId)
        document.body.classList.remove('resizing')
        onEnd()
      }}
      onPointerCancel={() => {
        if (startX.current === null) return
        startX.current = null
        document.body.classList.remove('resizing')
        onEnd()
      }}
      onDoubleClick={onDoubleClick}
    >
      {children}
    </div>
  )
}
