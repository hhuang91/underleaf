import { useMemo } from 'react'
import { mdiChevronDown, mdiChevronRight } from '@mdi/js'
import { Icon } from '../components/Icon'
import { editor } from '../editor/controller'
import { cx } from '../lib/util'
import { useApp, useSettings } from '../stores/app'
import { useIde } from '../stores/ide'

/** The "File outline" panel: sections of the open document; click to jump. */
export function Outline(): React.JSX.Element {
  const outline = useIde((s) => s.outline)
  const cursorLine = useIde((s) => s.cursorLine)
  const isText = useIde((s) => s.open?.kind === 'text')
  const open = useSettings().layout.outlineOpen
  const patchSettings = useApp((s) => s.patchSettings)

  const minLevel = useMemo(() => outline.reduce((min, item) => Math.min(min, item.level), 6), [outline])

  // The section the cursor is in: the last heading at or above the cursor.
  let current = -1
  for (let i = 0; i < outline.length; i++) {
    if (outline[i].line <= cursorLine) current = i
    else break
  }

  return (
    <div className={cx('outline', open && 'open')}>
      <button
        type="button"
        className="outline-header"
        aria-expanded={open}
        onClick={() => void patchSettings({ layout: { outlineOpen: !open } })}
      >
        <Icon path={open ? mdiChevronDown : mdiChevronRight} size={16} />
        File outline
      </button>
      {open && (
        <div className="outline-body">
          {outline.length === 0 ? (
            <div className="outline-empty">
              {isText ? 'Sections such as \\section{…} in this file will be listed here.' : 'Open a .tex file to see its outline.'}
            </div>
          ) : (
            <ul>
              {outline.map((item, i) => (
                <li key={`${item.line}:${item.title}`}>
                  <button
                    type="button"
                    className={cx('outline-item', i === current && 'current')}
                    style={{ paddingLeft: 12 + (item.level - minLevel) * 14 }}
                    title={item.title}
                    onClick={() => editor.jumpTo(item.line)}
                  >
                    <span className="truncate">{item.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
