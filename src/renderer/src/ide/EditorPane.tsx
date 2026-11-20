import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { redo, undo } from '@codemirror/commands'
import { openSearchPanel } from '@codemirror/search'
import type { EditorView } from '@codemirror/view'
import {
  mdiBookOpenVariantOutline,
  mdiCodeBrackets,
  mdiDotsHorizontal,
  mdiFileOutline,
  mdiFormatBold,
  mdiFormatItalic,
  mdiFormatListBulleted,
  mdiFormatListNumbered,
  mdiImageOutline,
  mdiLinkVariant,
  mdiLockOutline,
  mdiMagnify,
  mdiRedo,
  mdiSigma,
  mdiTable,
  mdiTagOutline,
  mdiUndo
} from '@mdi/js'
import * as pdfjsLib from 'pdfjs-dist'
import { mimeOfImage } from '@shared/fileTypes'
import { Icon } from '../components/Icon'
import { Dropdown, type MenuEntry } from '../components/Menu'
import { editor } from '../editor/controller'
import {
  currentHeading,
  insertBlock,
  insertList,
  insertTemplate,
  setHeading,
  wrapSelection,
  type HeadingLevel
} from '../editor/extensions'
import { baseName, cx, formatBytes, isMac, MOD } from '../lib/util'
import { useSettings } from '../stores/app'
import { useIde, type OpenDoc } from '../stores/ide'
import { loadPdf } from './pdfControl'

/** Hosts the CodeMirror view. It stays mounted while previews are shown on top. */
function CodeEditor({ hidden }: { hidden: boolean }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const settings = useSettings().editor

  useEffect(() => {
    if (!hostRef.current) return
    editor.mount(hostRef.current)
    return () => editor.unmount()
  }, [])

  useEffect(() => {
    editor.configure(settings)
  }, [settings])

  useEffect(() => {
    if (!hidden) editor.refreshLayout()
  }, [hidden])

  return <div ref={hostRef} className="editor-host" style={{ display: hidden ? 'none' : undefined }} />
}

const HEADINGS: Array<{ value: HeadingLevel; label: string }> = [
  { value: 'text', label: 'Normal text' },
  { value: 'section', label: 'Section' },
  { value: 'subsection', label: 'Subsection' },
  { value: 'subsubsection', label: 'Subsubsection' },
  { value: 'paragraph', label: 'Paragraph' },
  { value: 'subparagraph', label: 'Subparagraph' }
]

const FIGURE_TEMPLATE =
  '\\begin{figure}[htbp]\n\t\\centering\n\t\\includegraphics[width=0.5\\linewidth]{${file}}\n\t\\caption{${Caption}}\n\t\\label{fig:${label}}\n\\end{figure}'
const TABLE_TEMPLATE =
  '\\begin{table}[htbp]\n\t\\centering\n\t\\begin{tabular}{${c|c}}\n\t\t${} &  \\\\\n\t\t &  \\\\\n\t\\end{tabular}\n\t\\caption{${Caption}}\n\t\\label{tab:${label}}\n\\end{table}'

interface Tool {
  /** Tooltip, and the label in the overflow menu. */
  label: string
  icon: string
  /** Shown on the toolbar button instead of the icon. */
  text?: string
  /** Starts a new group: a separator is drawn in front of it. */
  group?: boolean
  run: (view: EditorView) => unknown
}

const TOOLS: Tool[] = [
  { label: `Bold (${MOD}+B)`, icon: mdiFormatBold, group: true, run: (v) => wrapSelection(v, '\\textbf{', '}') },
  { label: `Italic (${MOD}+I)`, icon: mdiFormatItalic, run: (v) => wrapSelection(v, '\\textit{', '}') },
  { label: 'Inline math', icon: mdiSigma, group: true, run: (v) => wrapSelection(v, '$', '$') },
  { label: 'Display math', icon: mdiCodeBrackets, text: '\\[ \\]', run: (v) => insertBlock(v, '\\[\n\t${}\n\\]') },
  { label: 'Insert link', icon: mdiLinkVariant, group: true, run: (v) => insertTemplate(v, '\\href{${url}}{${text}}') },
  { label: 'Insert cross-reference', icon: mdiTagOutline, run: (v) => insertTemplate(v, '\\ref{${}}') },
  { label: 'Insert citation', icon: mdiBookOpenVariantOutline, run: (v) => insertTemplate(v, '\\cite{${}}') },
  { label: 'Insert figure', icon: mdiImageOutline, group: true, run: (v) => insertBlock(v, FIGURE_TEMPLATE) },
  { label: 'Insert table', icon: mdiTable, run: (v) => insertBlock(v, TABLE_TEMPLATE) },
  { label: 'Bullet list', icon: mdiFormatListBulleted, group: true, run: (v) => insertList(v, 'itemize') },
  { label: 'Numbered list', icon: mdiFormatListNumbered, run: (v) => insertList(v, 'enumerate') }
]

// Keep the selection in the editor while a toolbar button is clicked.
const keepFocus = (e: React.MouseEvent): void => e.preventDefault()

function EditorToolbar(): React.JSX.Element {
  const cursorLine = useIde((s) => s.cursorLine)
  const [heading, setHeadingValue] = useState<HeadingLevel>('text')
  const itemsRef = useRef<HTMLDivElement>(null)
  // Tools that do not fit wrap onto a second row, which is clipped away; they
  // are offered in a "More" menu instead. They are always the last ones.
  const [overflowing, setOverflowing] = useState(0)

  useEffect(() => {
    editor.run((view) => setHeadingValue(currentHeading(view)))
  }, [cursorLine])

  useLayoutEffect(() => {
    const el = itemsRef.current
    if (!el) return
    const measure = (): void => {
      const items = Array.from(el.children) as HTMLElement[]
      if (items.length === 0) return
      // The first tool cannot wrap; when even that one is too wide, none fit.
      const noneFit = items[0].offsetWidth > el.clientWidth
      const firstRow = items[0].offsetTop
      setOverflowing(noneFit ? items.length : items.filter((item) => item.offsetTop > firstRow).length)
    }
    // Measuring changes what is rendered (the "More" button comes and goes),
    // which resizes this element again; doing it on the next frame keeps that
    // out of the observer's own delivery loop.
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    })
    observer.observe(el)
    measure()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  const moreEntries = (): MenuEntry[] =>
    TOOLS.slice(TOOLS.length - overflowing).map((tool) => ({
      label: tool.label,
      icon: tool.icon,
      onClick: () => editor.run(tool.run)
    }))

  return (
    <div className="editor-toolbar" role="toolbar" aria-label="Formatting">
      <button type="button" className="icon-btn" title={`Undo (${MOD}+Z)`} onMouseDown={keepFocus} onClick={() => editor.run(undo)}>
        <Icon path={mdiUndo} />
      </button>
      <button
        type="button"
        className="icon-btn"
        title={`Redo (${isMac ? '⇧⌘Z' : 'Ctrl+Y'})`}
        onMouseDown={keepFocus}
        onClick={() => editor.run(redo)}
      >
        <Icon path={mdiRedo} />
      </button>
      <span className="toolbar-sep" />
      <select
        className="select select-sm heading-select"
        value={heading}
        title="Section heading"
        onChange={(e) => {
          const level = e.target.value as HeadingLevel
          setHeadingValue(level)
          editor.run((view) => setHeading(view, level))
        }}
      >
        {HEADINGS.map((h) => (
          <option key={h.value} value={h.value}>
            {h.label}
          </option>
        ))}
      </select>

      <div className={cx('toolbar-items', overflowing === TOOLS.length && 'none-fit')} ref={itemsRef}>
        {TOOLS.map((tool) => (
          <span key={tool.label} className="toolbar-item">
            {tool.group && <span className="toolbar-sep" />}
            <button
              type="button"
              className={cx('icon-btn', tool.text && 'text-btn')}
              title={tool.label}
              onMouseDown={keepFocus}
              onClick={() => editor.run(tool.run)}
            >
              {tool.text ?? <Icon path={tool.icon} />}
            </button>
          </span>
        ))}
      </div>

      {overflowing > 0 && (
        <Dropdown entries={moreEntries} align="right">
          {(toggle) => (
            <button type="button" className="icon-btn" title="More" onMouseDown={keepFocus} onClick={toggle}>
              <Icon path={mdiDotsHorizontal} />
            </button>
          )}
        </Dropdown>
      )}
      <button
        type="button"
        className="icon-btn"
        title={`Search (${MOD}+F)`}
        onMouseDown={keepFocus}
        onClick={() => editor.run(openSearchPanel)}
      >
        <Icon path={mdiMagnify} />
      </button>
    </div>
  )
}

function ImagePreview({ doc }: { doc: OpenDoc }): React.JSX.Element {
  const projectId = useIde((s) => s.projectId)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    if (!projectId) return
    let revoked = false
    let objectUrl: string | null = null
    setUrl(null)
    setError(null)
    setSize(null)
    window.api.files
      .readBinary(projectId, doc.path)
      .then((bytes) => {
        if (revoked) return
        objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeOfImage(doc.path) }))
        setUrl(objectUrl)
      })
      .catch((err: unknown) => !revoked && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      revoked = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [projectId, doc.path, doc.size])

  return (
    <div className="preview">
      <div className="preview-meta">
        <strong>{baseName(doc.path)}</strong>
        <span className="muted">
          {formatBytes(doc.size)}
          {size && ` · ${size.w} × ${size.h} px`}
        </span>
      </div>
      <div className="preview-stage">
        {error && <p className="muted">Could not load the image: {error}</p>}
        {url && (
          <img
            src={url}
            alt={baseName(doc.path)}
            draggable={false}
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
        )}
      </div>
    </div>
  )
}

/** First page of a PDF that is used as a figure. */
function PdfFilePreview({ doc }: { doc: OpenDoc }): React.JSX.Element {
  const projectId = useIde((s) => s.projectId)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [info, setInfo] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    let task: pdfjsLib.PDFDocumentLoadingTask | null = null
    setError(null)
    setInfo('')
    ;(async () => {
      const bytes = await window.api.files.readBinary(projectId, doc.path)
      if (cancelled) return
      task = loadPdf(bytes)
      const pdf = await task.promise
      const page = await pdf.getPage(1)
      const canvas = canvasRef.current
      if (cancelled || !canvas) return
      const base = page.getViewport({ scale: 1 })
      const scale = Math.min(2.5, Math.max(0.5, 900 / base.width)) * window.devicePixelRatio
      const viewport = page.getViewport({ scale })
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      canvas.style.aspectRatio = `${viewport.width} / ${viewport.height}`
      await page.render({ canvas, viewport }).promise
      if (!cancelled) setInfo(`${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}`)
    })().catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      cancelled = true
      void task?.destroy()
    }
  }, [projectId, doc.path, doc.size])

  return (
    <div className="preview">
      <div className="preview-meta">
        <strong>{baseName(doc.path)}</strong>
        <span className="muted">
          {formatBytes(doc.size)}
          {info && ` · ${info}`}
        </span>
      </div>
      <div className="preview-stage">
        {error ? <p className="muted">Could not preview this PDF: {error}</p> : <canvas ref={canvasRef} className="preview-pdf" />}
      </div>
    </div>
  )
}

function BinaryNotice({ doc }: { doc: OpenDoc }): React.JSX.Element {
  const projectId = useIde((s) => s.projectId)
  return (
    <div className="preview">
      <div className="preview-stage">
        <div className="preview-card">
          <Icon path={mdiFileOutline} size={40} />
          <strong>{baseName(doc.path)}</strong>
          <span className="muted">{formatBytes(doc.size)}</span>
          <p className="muted">
            {doc.reason === 'too-large'
              ? 'This file is too large to edit here.'
              : 'This file cannot be shown in the editor, but it is part of the project and available to the compiler.'}
          </p>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => projectId && void window.api.files.reveal(projectId, doc.path)}
          >
            {isMac ? 'Reveal in Finder' : 'Show in folder'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function EditorPane(): React.JSX.Element {
  const open = useIde((s) => s.open)
  const loading = useIde((s) => s.loading)
  const isText = open?.kind === 'text'
  // A file in a legacy encoding is shown as decoded, but saving it would
  // rewrite it as UTF-8. That is only done once the user has seen the text.
  const writeProtected = isText && open.transcoded === true

  return (
    <div className={cx('editor-pane')}>
      {isText && !writeProtected && <EditorToolbar />}
      {writeProtected && (
        <div className="editor-notice">
          <Icon path={mdiLockOutline} size={18} />
          <span>
            This file is not UTF-8, so it is shown read-only. If the text looks right, convert it; it is
            saved as UTF-8 from then on.
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => useIde.getState().convertToUtf8()}
          >
            Convert to UTF-8 and edit
          </button>
        </div>
      )}
      <CodeEditor hidden={!isText} />
      {open?.kind === 'image' && <ImagePreview doc={open} />}
      {open?.kind === 'pdf' && <PdfFilePreview doc={open} />}
      {open?.kind === 'binary' && <BinaryNotice doc={open} />}
      {!open && !loading && (
        <div className="preview">
          <div className="preview-stage">
            <div className="preview-card">
              <Icon path={mdiFileOutline} size={40} />
              <strong>No file selected</strong>
              <p className="muted">Choose a file from the panel on the left, or create a new one.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
