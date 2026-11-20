// PDF.js setup plus a small imperative facade so toolbar buttons (zoom, page
// navigation, SyncTeX) can talk to whichever viewer instance is on screen.

import * as pdfjsLib from 'pdfjs-dist'
import type { PageViewport } from 'pdfjs-dist'
import type { PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { create } from 'zustand'
import type { PdfRect } from '@shared/types'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

/** Static PDF.js resources copied to public/pdfjs by scripts/copy-pdfjs-assets.mjs. */
const asset = (dir: string): string => new URL(`pdfjs/${dir}/`, document.baseURI).href

let sharedWorker: pdfjsLib.PDFWorker | null = null

/** One worker for the lifetime of the window: recompiles then load without a warm-up. */
function worker(): pdfjsLib.PDFWorker {
  if (!sharedWorker || sharedWorker.destroyed) sharedWorker = pdfjsLib.PDFWorker.create({ name: 'underleaf-pdf' })
  return sharedWorker
}

export function loadPdf(data: Uint8Array): pdfjsLib.PDFDocumentLoadingTask {
  return pdfjsLib.getDocument({
    // PDF.js takes ownership of the buffer it is given, so hand it a copy.
    data: data.slice(),
    worker: worker(),
    cMapUrl: asset('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts'),
    wasmUrl: asset('wasm'),
    iccUrl: asset('iccs')
  })
}

export interface ViewState {
  /** 'page-width', 'page-height' or a number as a string. */
  scale: string
  scrollTop: number
  scrollLeft: number
}

interface ActiveViewer {
  viewer: PDFViewer
  container: HTMLDivElement
  overlay: HTMLDivElement
}

interface PdfUiState {
  page: number
  pages: number
  /** Numeric zoom factor (1 = 100%). */
  scale: number
  /** Preset name when one is active, otherwise ''. */
  preset: string
}

export const usePdfUi = create<PdfUiState>(() => ({ page: 1, pages: 0, scale: 1, preset: 'page-width' }))

let active: ActiveViewer | null = null

export const pdfControl = {
  setActive(next: ActiveViewer | null): void {
    active = next
    if (next) {
      usePdfUi.setState({
        page: next.viewer.currentPageNumber || 1,
        pages: next.viewer.pagesCount,
        scale: next.viewer.currentScale || 1,
        preset: presetOf(next.viewer.currentScaleValue)
      })
    } else {
      usePdfUi.setState({ pages: 0, page: 1 })
    }
  },

  isActive(viewer: PDFViewer): boolean {
    return active?.viewer === viewer
  },

  zoomIn(): void {
    active?.viewer.increaseScale()
  },

  zoomOut(): void {
    active?.viewer.decreaseScale()
  },

  setZoom(value: string): void {
    if (active) active.viewer.currentScaleValue = value
  },

  goToPage(page: number): void {
    if (!active) return
    const n = Math.min(Math.max(1, Math.round(page)), active.viewer.pagesCount)
    active.viewer.currentPageNumber = n
  },

  /**
   * Scrolls to and flashes the given rectangles (PDF points, top-left origin).
   * Used when jumping from a source line to the PDF.
   */
  highlight(rects: PdfRect[]): void {
    if (!active || rects.length === 0) return
    const { viewer, container, overlay } = active
    // getPageView() is untyped in PDF.js; pin down the parts that are used here.
    const pageView = viewer.getPageView(rects[0].page - 1) as
      | { div?: HTMLDivElement; viewport?: PageViewport }
      | undefined
    if (!pageView?.div || !pageView.viewport) return
    const div = pageView.div
    const viewport = pageView.viewport
    const [x0, y0, , y1] = viewport.viewBox
    const pageHeight = y1 - y0

    overlay.replaceChildren()
    let top = Infinity
    for (const r of rects) {
      if (r.page !== rects[0].page) continue
      // PDF user space has its origin at the bottom-left corner.
      const [ax, ay] = viewport.convertToViewportPoint(x0 + r.x, y0 + pageHeight - r.y) as number[]
      const [bx, by] = viewport.convertToViewportPoint(
        x0 + r.x + r.width,
        y0 + pageHeight - (r.y + r.height)
      ) as number[]
      const left = Math.min(ax, bx)
      const y = Math.min(ay, by)
      const mark = document.createElement('div')
      mark.className = 'pdf-sync-highlight'
      mark.style.left = `${div.offsetLeft + div.clientLeft + left - 3}px`
      mark.style.top = `${div.offsetTop + div.clientTop + y - 2}px`
      mark.style.width = `${Math.abs(bx - ax) + 6}px`
      mark.style.height = `${Math.abs(by - ay) + 4}px`
      overlay.appendChild(mark)
      top = Math.min(top, div.offsetTop + div.clientTop + y)
    }
    if (Number.isFinite(top)) {
      container.scrollTo({ top: Math.max(0, top - container.clientHeight * 0.35), behavior: 'smooth' })
    }
    window.setTimeout(() => {
      if (overlay.isConnected) overlay.replaceChildren()
    }, 2200)
  },

  /**
   * Converts a mouse position into page coordinates (PDF points, top-left
   * origin) for a reverse SyncTeX lookup.
   */
  locate(clientX: number, clientY: number): { page: number; x: number; y: number } | null {
    if (!active) return null
    const el = document.elementFromPoint(clientX, clientY)
    const pageDiv = el?.closest<HTMLDivElement>('.page')
    if (!pageDiv || !active.container.contains(pageDiv)) return null
    const page = Number(pageDiv.dataset.pageNumber)
    const pageView = active.viewer.getPageView(page - 1) as { viewport?: PageViewport } | undefined
    if (!pageView?.viewport) return null
    const rect = pageDiv.getBoundingClientRect()
    const [px, py] = pageView.viewport.convertToPdfPoint(
      clientX - rect.left - pageDiv.clientLeft,
      clientY - rect.top - pageDiv.clientTop
    ) as number[]
    const [x0, , , y1] = pageView.viewport.viewBox
    return { page, x: px - x0, y: y1 - py }
  },

  /** A point near the top of what is currently visible, for "show this in the source". */
  visiblePoint(): { clientX: number; clientY: number } | null {
    if (!active) return null
    const r = active.container.getBoundingClientRect()
    return { clientX: r.left + r.width / 2, clientY: r.top + Math.min(r.height * 0.3, 220) }
  }
}

export function presetOf(value: string | undefined): string {
  return value === 'page-width' || value === 'page-height' || value === 'page-fit' || value === 'auto' ? value : ''
}
