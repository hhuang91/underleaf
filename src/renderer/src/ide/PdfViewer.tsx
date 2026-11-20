import { memo, useEffect, useRef, useState } from 'react'
import { EventBus, LinkTarget, PDFLinkService, PDFViewer as PdfJsViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import { cx } from '../lib/util'
import { loadPdf, pdfControl, presetOf, usePdfUi, type ViewState } from './pdfControl'

interface PdfViewerProps {
  pdf: { version: number; data: Uint8Array }
  initialZoom: string
  onZoomChange: (zoom: string) => void
  /** Double-click: jump to the matching source line. */
  onInverseSearch: (clientX: number, clientY: number) => void
}

/**
 * Shows the compiled PDF. When a new version arrives it is rendered in a
 * hidden layer first and swapped in once its visible page is painted, so the
 * view never flashes white and keeps its scroll position.
 */
export function PdfViewer({ pdf, initialZoom, onZoomChange, onInverseSearch }: PdfViewerProps): React.JSX.Element {
  const [layers, setLayers] = useState<Array<{ version: number; data: Uint8Array }>>([])
  const [shown, setShown] = useState<number | null>(null)
  const view = useRef<ViewState>({ scale: initialZoom || 'page-width', scrollTop: 0, scrollLeft: 0 })

  useEffect(() => {
    setLayers((current) => {
      if (current.some((l) => l.version === pdf.version)) return current
      // Keep what is on screen plus the newest document; drop anything in between.
      const visible = current.filter((l) => l.version === shown)
      return [...visible, { version: pdf.version, data: pdf.data }]
    })
    // `shown` is deliberately not a dependency: only a new PDF adds a layer.
  }, [pdf])

  const handleReady = (version: number): void => {
    setShown(version)
    setLayers((current) => {
      const idx = current.findIndex((l) => l.version === version)
      return idx < 0 ? current : current.slice(idx)
    })
  }

  // A document that cannot be loaded (cut short, say) must not take the place
  // of one that is on screen and fine.
  const handleDiscard = (version: number): void => {
    setLayers((current) => current.filter((l) => l.version !== version))
  }

  return (
    <div className="pdf-stack">
      {layers.map((layer) => (
        <PdfLayer
          key={layer.version}
          data={layer.data}
          version={layer.version}
          active={layer.version === shown}
          hasFallback={shown !== null && shown !== layer.version}
          view={view}
          onReady={handleReady}
          onDiscard={handleDiscard}
          onZoomChange={onZoomChange}
          onInverseSearch={onInverseSearch}
        />
      ))}
    </div>
  )
}

interface PdfLayerProps {
  data: Uint8Array
  version: number
  active: boolean
  /** Another, working document is on screen while this one loads. */
  hasFallback: boolean
  view: React.RefObject<ViewState>
  onReady: (version: number) => void
  onDiscard: (version: number) => void
  onZoomChange: (zoom: string) => void
  onInverseSearch: (clientX: number, clientY: number) => void
}

const PdfLayer = memo(function PdfLayer(props: PdfLayerProps): React.JSX.Element {
  const { data, version, active, view } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<PdfJsViewer | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props
  const activeRef = useRef(active)
  activeRef.current = active
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const viewerEl = container.querySelector<HTMLDivElement>('.pdfViewer')
    const overlay = container.querySelector<HTMLDivElement>('.pdf-overlay')
    if (!viewerEl || !overlay) return

    let disposed = false
    let ready = false
    const eventBus = new EventBus()
    const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK })
    const viewer = new PdfJsViewer({ container, viewer: viewerEl, eventBus, linkService })
    linkService.setViewer(viewer)
    viewerRef.current = viewer

    const markReady = (): void => {
      if (ready || disposed) return
      ready = true
      callbacks.current.onReady(version)
    }
    const fallback = window.setTimeout(markReady, 3000)

    const task = loadPdf(data)
    task.promise.then(
      (doc) => {
        if (disposed) return // the cleanup below already destroyed the loading task
        viewer.setDocument(doc)
        linkService.setDocument(doc, null)
      },
      (err: unknown) => {
        if (disposed) return
        if (callbacks.current.hasFallback) {
          // Keep what is on screen; this layer just goes away.
          window.clearTimeout(fallback)
          ready = true
          callbacks.current.onDiscard(version)
          return
        }
        setError(err instanceof Error ? err.message : String(err))
        markReady()
      }
    )

    eventBus.on('pagesinit', () => {
      // Continue exactly where the previous version of the document was.
      viewer.currentScaleValue = view.current.scale
      container.scrollTop = view.current.scrollTop
      container.scrollLeft = view.current.scrollLeft
      if (activeRef.current) pdfControl.setActive({ viewer, container, overlay })
    })

    eventBus.on('pagerendered', (e: { source: { div: HTMLElement } }) => {
      if (ready) return
      const div = e.source.div
      const top = div.offsetTop - container.scrollTop
      if (top < container.clientHeight && top + div.offsetHeight > 0) markReady()
    })

    eventBus.on('pagechanging', (e: { pageNumber: number }) => {
      if (pdfControl.isActive(viewer)) usePdfUi.setState({ page: e.pageNumber })
    })

    eventBus.on('scalechanging', (e: { scale: number; presetValue?: string }) => {
      if (!pdfControl.isActive(viewer)) return
      const preset = presetOf(e.presetValue)
      usePdfUi.setState({ scale: e.scale, preset })
      const value = preset || String(Math.round(e.scale * 1000) / 1000)
      view.current.scale = value
      callbacks.current.onZoomChange(value)
    })

    const onScroll = (): void => {
      if (!pdfControl.isActive(viewer)) return
      view.current.scrollTop = container.scrollTop
      view.current.scrollLeft = container.scrollLeft
    }
    container.addEventListener('scroll', onScroll, { passive: true })

    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const factor = Math.exp(-e.deltaY / 400)
      viewer.updateScale({ scaleFactor: Math.min(1.25, Math.max(0.8, factor)), origin: [e.clientX, e.clientY] })
    }
    container.addEventListener('wheel', onWheel, { passive: false })

    const onDoubleClick = (e: MouseEvent): void => {
      if (!pdfControl.isActive(viewer)) return
      callbacks.current.onInverseSearch(e.clientX, e.clientY)
    }
    container.addEventListener('dblclick', onDoubleClick)

    // Presets such as "fit to width" depend on the pane size.
    let resizeTimer: number | null = null
    const observer = new ResizeObserver(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null
        if (disposed || !viewer.pdfDocument || container.clientWidth === 0) return
        const current = viewer.currentScaleValue
        if (presetOf(current)) viewer.currentScaleValue = current
        viewer.update()
      }, 80)
    })
    observer.observe(container)

    return () => {
      disposed = true
      window.clearTimeout(fallback)
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      observer.disconnect()
      container.removeEventListener('scroll', onScroll)
      container.removeEventListener('wheel', onWheel)
      container.removeEventListener('dblclick', onDoubleClick)
      if (pdfControl.isActive(viewer)) pdfControl.setActive(null)
      viewerRef.current = null
      try {
        viewer.setDocument(null)
        linkService.setDocument(null, null)
      } catch {
        /* the viewer was never fully initialised */
      }
      void task.destroy()
    }
    // A layer is created for exactly one document version and never updated.
  }, [])

  useEffect(() => {
    const container = containerRef.current
    const viewer = viewerRef.current
    if (!active || !container || !viewer) return
    const overlay = container.querySelector<HTMLDivElement>('.pdf-overlay')
    if (overlay) pdfControl.setActive({ viewer, container, overlay })
  }, [active])

  return (
    <div ref={containerRef} className={cx('pdf-container', !active && 'pending')} tabIndex={-1}>
      <div className="pdfViewer" />
      <div className="pdf-overlay" />
      {error && <div className="pdf-error selectable">The PDF could not be displayed: {error}</div>}
    </div>
  )
})
