import { useCallback, useEffect, useRef, useState } from 'react'
import {
  mdiArrowLeft,
  mdiArrowRight,
  mdiChevronDown,
  mdiClose,
  mdiDownload,
  mdiFileDocumentOutline,
  mdiLoading,
  mdiMinus,
  mdiPlus,
  mdiRefresh,
  mdiShieldAlertOutline
} from '@mdi/js'
import { Icon } from '../components/Icon'
import { Dropdown, type MenuEntry } from '../components/Menu'
import { editor } from '../editor/controller'
import { cx, MOD } from '../lib/util'
import { notifyError, useApp, useSettings } from '../stores/app'
import { useIde } from '../stores/ide'
import { LogsPane } from './LogsPane'
import { pdfControl, usePdfUi } from './pdfControl'
import { PdfViewer } from './PdfViewer'

const ZOOM_LEVELS = ['0.5', '0.75', '1', '1.25', '1.5', '2', '3', '4']

/** Jump from the cursor position in the editor to the matching place in the PDF. */
export async function syncToPdf(): Promise<void> {
  const { projectId, open, setPane } = useIde.getState()
  const cursor = editor.cursor()
  if (!projectId || !open || open.kind !== 'text' || !cursor) return
  try {
    await editor.flush()
    const rects = await window.api.compile.syncToPdf(projectId, open.path, cursor.line, cursor.column)
    if (rects.length === 0) {
      useApp.getState().notify('info', 'No matching position was found in the PDF. Recompile and try again.')
      return
    }
    setPane('pdf')
    // Give the PDF pane a frame to become visible before scrolling it.
    requestAnimationFrame(() => pdfControl.highlight(rects))
  } catch (err) {
    notifyError(err)
  }
}

/** Jump from a position in the PDF to the source line that produced it. */
export async function syncToSource(clientX: number, clientY: number): Promise<void> {
  const { projectId, openFile } = useIde.getState()
  const point = pdfControl.locate(clientX, clientY)
  if (!projectId || !point) return
  try {
    const target = await window.api.compile.syncToSource(projectId, point.page, point.x, point.y)
    if (!target) {
      useApp.getState().notify('info', 'No source location was found for this part of the PDF.')
      return
    }
    await openFile(target.file, { line: target.line, column: target.column })
  } catch (err) {
    notifyError(err)
  }
}

function PageInput(): React.JSX.Element {
  const page = usePdfUi((s) => s.page)
  const pages = usePdfUi((s) => s.pages)
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (): void => {
    if (draft !== null) {
      const n = Number(draft)
      if (Number.isFinite(n) && n >= 1) pdfControl.goToPage(n)
    }
    setDraft(null)
  }

  return (
    <span className="pdf-pages">
      <input
        className="pdf-page-input"
        value={draft ?? String(page)}
        disabled={pages === 0}
        aria-label="Page"
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraft(null)
            e.currentTarget.blur()
          }
        }}
      />
      <span>/ {pages || '–'}</span>
    </span>
  )
}

function ZoomControls(): React.JSX.Element {
  const scale = usePdfUi((s) => s.scale)
  const preset = usePdfUi((s) => s.preset)
  const pages = usePdfUi((s) => s.pages)

  const entries: MenuEntry[] = [
    { label: 'Fit to width', checked: preset === 'page-width', onClick: () => pdfControl.setZoom('page-width') },
    { label: 'Fit to height', checked: preset === 'page-height', onClick: () => pdfControl.setZoom('page-height') },
    { type: 'divider' },
    ...ZOOM_LEVELS.map(
      (z): MenuEntry => ({
        label: `${Math.round(Number(z) * 100)}%`,
        checked: !preset && Math.abs(scale - Number(z)) < 0.005,
        onClick: () => pdfControl.setZoom(z)
      })
    )
  ]

  return (
    <div className="pdf-zoom">
      <button type="button" className="icon-btn" title="Zoom out" disabled={pages === 0} onClick={() => pdfControl.zoomOut()}>
        <Icon path={mdiMinus} />
      </button>
      <Dropdown entries={entries} align="right">
        {(toggle) => (
          <button type="button" className="pdf-zoom-value" onClick={toggle} disabled={pages === 0} title="Zoom">
            {Math.round(scale * 100)}%
            <Icon path={mdiChevronDown} size={16} />
          </button>
        )}
      </Dropdown>
      <button type="button" className="icon-btn" title="Zoom in" disabled={pages === 0} onClick={() => pdfControl.zoomIn()}>
        <Icon path={mdiPlus} />
      </button>
    </div>
  )
}

export function PdfPane({ showSync }: { showSync: boolean }): React.JSX.Element {
  const settings = useSettings()
  const patchSettings = useApp((s) => s.patchSettings)
  const pdf = useIde((s) => s.pdf)
  const pane = useIde((s) => s.pane)
  const compiling = useIde((s) => s.compiling)
  const progress = useIde((s) => s.progress)
  const progressNote = useIde((s) => s.progressNote)
  const result = useIde((s) => s.result)
  const rootDoc = useIde((s) => s.rootDoc)
  const loading = useIde((s) => s.loading)
  const projectId = useIde((s) => s.projectId)
  const compile = useIde((s) => s.compile)
  const stopCompile = useIde((s) => s.stopCompile)
  const setPane = useIde((s) => s.setPane)
  const notify = useApp((s) => s.notify)

  // Remember the zoom level, but do not write settings on every wheel tick.
  const zoomTimer = useRef<number | null>(null)
  const onZoomChange = useCallback(
    (zoom: string) => {
      if (zoomTimer.current !== null) window.clearTimeout(zoomTimer.current)
      zoomTimer.current = window.setTimeout(() => {
        zoomTimer.current = null
        if (useApp.getState().settings?.pdfZoom !== zoom) void patchSettings({ pdfZoom: zoom })
      }, 600)
    },
    [patchSettings]
  )
  useEffect(
    () => () => {
      if (zoomTimer.current !== null) window.clearTimeout(zoomTimer.current)
    },
    []
  )

  // The notice about an unused latexmkrc can be closed for the open project.
  const [rcDismissedFor, setRcDismissedFor] = useState<string | null>(null)

  // The progress line only matters for slow compiles (first run, big documents).
  const [showProgress, setShowProgress] = useState(false)
  useEffect(() => {
    if (!compiling) {
      setShowProgress(false)
      return
    }
    const timer = window.setTimeout(() => setShowProgress(true), 1500)
    return () => window.clearTimeout(timer)
  }, [compiling])

  const downloadPdf = async (): Promise<void> => {
    if (!projectId) return
    try {
      const saved = await window.api.compile.savePdf(projectId)
      if (saved) {
        notify('success', `Saved ${saved.split(/[\\/]/).pop()}.`, {
          label: 'Show in folder',
          run: () => void window.api.app.showItemInFolder(saved)
        })
      }
    } catch (err) {
      notifyError(err)
    }
  }

  const compileEntries: MenuEntry[] = [
    { type: 'header', label: 'Auto compile' },
    { label: 'On', checked: settings.autoCompile, onClick: () => void patchSettings({ autoCompile: true }) },
    { label: 'Off', checked: !settings.autoCompile, onClick: () => void patchSettings({ autoCompile: false }) },
    { type: 'header', label: 'Compile error handling' },
    {
      label: 'Stop on first error',
      checked: settings.stopOnFirstError,
      onClick: () => void patchSettings({ stopOnFirstError: true })
    },
    {
      label: 'Try to compile despite errors',
      checked: !settings.stopOnFirstError,
      onClick: () => void patchSettings({ stopOnFirstError: false })
    },
    { type: 'divider' },
    { label: 'Stop compilation', disabled: !compiling, onClick: () => void stopCompile() },
    { label: 'Recompile from scratch', disabled: compiling, onClick: () => void compile(true) }
  ]

  const errors = result?.counts.errors ?? 0
  const warnings = result?.counts.warnings ?? 0

  return (
    <div className="pdf-pane">
      <div className="pdf-toolbar">
        <div className="split-btn">
          <button
            type="button"
            className="btn btn-primary btn-sm split-main"
            onClick={() => void compile()}
            disabled={compiling || loading}
            title={`Recompile the PDF (${MOD}+Enter)`}
          >
            <Icon path={compiling ? mdiLoading : mdiRefresh} size={16} spin={compiling} />
            {compiling ? 'Compiling…' : 'Recompile'}
          </button>
          <Dropdown entries={compileEntries}>
            {(toggle) => (
              <button type="button" className="btn btn-primary btn-sm split-caret" onClick={toggle} aria-label="Compile options">
                <Icon path={mdiChevronDown} size={16} />
              </button>
            )}
          </Dropdown>
        </div>

        <button
          type="button"
          className={cx('pdf-tool', pane === 'logs' && 'active')}
          onClick={() => setPane(pane === 'logs' ? 'pdf' : 'logs')}
          title="Logs and output files"
          aria-pressed={pane === 'logs'}
        >
          <Icon path={mdiFileDocumentOutline} />
          {errors > 0 ? (
            <span className="badge error">{errors > 99 ? '99+' : errors}</span>
          ) : warnings > 0 ? (
            <span className="badge warning">{warnings > 99 ? '99+' : warnings}</span>
          ) : null}
        </button>

        <button type="button" className="pdf-tool" onClick={() => void downloadPdf()} disabled={!pdf} title="Download PDF">
          <Icon path={mdiDownload} />
        </button>

        <span className="toolbar-gap" />

        {pane === 'pdf' && pdf && (
          <>
            <PageInput />
            <ZoomControls />
          </>
        )}
      </div>

      {result?.rcIgnored && rcDismissedFor !== projectId && (
        <div className="editor-notice">
          <Icon path={mdiShieldAlertOutline} size={18} />
          <span>
            This project has a <code>latexmkrc</code>, which was not used: such a file can run commands on
            your computer. Use it only if you trust where the project comes from.
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void useIde.getState().trustRc().catch(notifyError)}
          >
            Use it
          </button>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setRcDismissedFor(projectId)}>
            <Icon path={mdiClose} size={16} />
          </button>
        </div>
      )}

      <div className="pdf-body">
        {pdf ? (
          <PdfViewer
            pdf={pdf}
            initialZoom={settings.pdfZoom}
            onZoomChange={onZoomChange}
            onInverseSearch={(x, y) => void syncToSource(x, y)}
          />
        ) : (
          <div className="pdf-placeholder">
            {compiling || loading ? (
              <>
                <Icon path={mdiLoading} size={32} spin />
                <p>Compiling…</p>
              </>
            ) : !rootDoc && !loading ? (
              <p>
                This project has no main document yet. Add a <code>.tex</code> file that contains{' '}
                <code>\documentclass</code>.
              </p>
            ) : (
              <p>No PDF yet. Press Recompile to build the document.</p>
            )}
          </div>
        )}

        {pane === 'logs' && <LogsPane />}

        {showSync && pane === 'pdf' && pdf && (
          <div className="sync-buttons">
            <button type="button" title="Go to code location in PDF" onClick={() => void syncToPdf()}>
              <Icon path={mdiArrowRight} size={16} />
            </button>
            <button
              type="button"
              title="Go to PDF location in code (or double-click the PDF)"
              onClick={() => {
                const p = pdfControl.visiblePoint()
                if (p) void syncToSource(p.clientX, p.clientY)
              }}
            >
              <Icon path={mdiArrowLeft} size={16} />
            </button>
          </div>
        )}

        {compiling && (showProgress || progressNote) && (
          <div className="compile-progress" role="status">
            <Icon path={mdiLoading} size={14} spin />
            <div className="compile-progress-text">
              {progressNote && <div className="compile-progress-note">{progressNote}</div>}
              {(progress || !progressNote) && <div className="truncate">{progress || 'Compiling…'}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
