// A reader for SyncTeX files (.synctex / .synctex.gz), used to jump between a
// source line and the matching place in the PDF and back.
//
// Records are kept in parallel typed arrays instead of objects: a thesis can
// easily contain more than a million of them.

import fs from 'node:fs/promises'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import type { PdfRect } from '@shared/types'

const gunzip = promisify(zlib.gunzip)

const T_VBOX = 0
const T_HBOX = 1
const T_VOID_VBOX = 2
const T_VOID_HBOX = 3
const T_LEAF = 4 // current point, kern, glue, math, rule

/** Scaled points per PDF point ("big point"): 65536 * 72.27 / 72. */
const SP_PER_BP = 65781.76

export interface SynctexData {
  /** Input tag -> file name exactly as recorded by TeX. */
  inputs: Map<number, string>
  count: number
  type: Uint8Array
  input: Int32Array
  line: Int32Array
  page: Int32Array
  h: Int32Array
  v: Int32Array
  width: Int32Array
  height: Int32Array
  depth: Int32Array
  /** Index of the enclosing box record, or -1. */
  parent: Int32Array
  /** For boxes: index of the last record inside the box. */
  end: Int32Array
  /** Page number -> [first record, last record]. */
  pages: Map<number, [number, number]>
  /** Multiply a recorded coordinate by this to get PDF points. */
  scale: number
  offsetX: number
  offsetY: number
}

export function parseSynctex(buf: Buffer): SynctexData {
  const n = buf.length
  let cap = Math.max(1024, Math.ceil(n / 24))
  let type: Uint8Array = new Uint8Array(cap)
  let input: Int32Array = new Int32Array(cap)
  let line: Int32Array = new Int32Array(cap)
  let page: Int32Array = new Int32Array(cap)
  let h: Int32Array = new Int32Array(cap)
  let v: Int32Array = new Int32Array(cap)
  let width: Int32Array = new Int32Array(cap)
  let height: Int32Array = new Int32Array(cap)
  let depth: Int32Array = new Int32Array(cap)
  let parent: Int32Array = new Int32Array(cap)
  let end: Int32Array = new Int32Array(cap)

  const grow = (): void => {
    cap *= 2
    const g8 = (a: Uint8Array): Uint8Array => {
      const b = new Uint8Array(cap)
      b.set(a)
      return b
    }
    const g32 = (a: Int32Array): Int32Array => {
      const b = new Int32Array(cap)
      b.set(a)
      return b
    }
    type = g8(type)
    input = g32(input)
    line = g32(line)
    page = g32(page)
    h = g32(h)
    v = g32(v)
    width = g32(width)
    height = g32(height)
    depth = g32(depth)
    parent = g32(parent)
    end = g32(end)
  }

  const inputs = new Map<number, string>()
  const pages = new Map<number, [number, number]>()
  const open: number[] = []
  let count = 0
  let unit = 1
  let magnification = 1000
  let offsetX = 0
  let offsetY = 0
  let inPreamble = true
  let inPage = false
  let currentPage = 0
  let pos = 0

  const readInt = (): number => {
    let negative = false
    if (buf[pos] === 45 /* - */) {
      negative = true
      pos++
    }
    let value = 0
    let c = buf[pos]
    while (c >= 48 && c <= 57) {
      value = value * 10 + (c - 48)
      pos++
      c = buf[pos]
    }
    return negative ? -value : value
  }

  const startsWith = (at: number, text: string): boolean => {
    if (at + text.length > n) return false
    for (let i = 0; i < text.length; i++) if (buf[at + i] !== text.charCodeAt(i)) return false
    return true
  }

  const closeBox = (): void => {
    const idx = open.pop()
    if (idx !== undefined) end[idx] = count - 1
  }

  while (pos < n) {
    let eol = buf.indexOf(10, pos)
    if (eol < 0) eol = n
    const c = buf[pos]

    if (c === 73 /* I */ && startsWith(pos, 'Input:')) {
      pos += 6
      const tag = readInt()
      if (buf[pos] === 58 /* : */) {
        let stop = eol
        if (stop > pos && buf[stop - 1] === 13) stop--
        inputs.set(tag, buf.toString('utf8', pos + 1, stop))
      }
    } else if (inPage) {
      switch (c) {
        case 40: // (  hbox
        case 91: // [  vbox
        case 104: // h  void hbox
        case 118: // v  void vbox
        case 120: // x  current point
        case 107: // k  kern
        case 103: // g  glue
        case 36: // $  math
        case 114: {
          // r  rule
          pos++
          const tag = readInt()
          if (buf[pos] !== 44) break
          pos++
          const ln = readInt()
          if (buf[pos] === 44) {
            pos++
            readInt() // column, unused
          }
          if (buf[pos] !== 58) break
          pos++
          const hh = readInt()
          if (buf[pos] !== 44) break
          pos++
          const vv = readInt()
          let w = 0
          let ht = 0
          let dp = 0
          if (buf[pos] === 58) {
            pos++
            w = readInt()
            if (buf[pos] === 44) {
              pos++
              ht = readInt()
              if (buf[pos] === 44) {
                pos++
                dp = readInt()
              }
            }
          }
          if (count === cap) grow()
          type[count] =
            c === 40 ? T_HBOX : c === 91 ? T_VBOX : c === 104 ? T_VOID_HBOX : c === 118 ? T_VOID_VBOX : T_LEAF
          input[count] = tag
          line[count] = ln
          page[count] = currentPage
          h[count] = hh
          v[count] = vv
          width[count] = w
          height[count] = ht
          depth[count] = dp
          parent[count] = open.length > 0 ? open[open.length - 1] : -1
          end[count] = count
          if (c === 40 || c === 91) open.push(count)
          count++
          break
        }
        case 41: // )
        case 93: // ]
          closeBox()
          break
        case 125: {
          // }  end of page
          while (open.length > 0) closeBox()
          const range = pages.get(currentPage)
          if (range) range[1] = count - 1
          inPage = false
          break
        }
        default:
          break // byte offsets ("!123"), form references, ...
      }
    } else if (c === 123 /* { */) {
      pos++
      currentPage = readInt()
      inPage = true
      inPreamble = false
      open.length = 0
      pages.set(currentPage, [count, count - 1])
    } else if (inPreamble) {
      if (startsWith(pos, 'Unit:')) {
        pos += 5
        unit = readInt() || 1
      } else if (startsWith(pos, 'Magnification:')) {
        pos += 14
        magnification = readInt() || 1000
      } else if (startsWith(pos, 'X Offset:')) {
        pos += 9
        offsetX = readInt()
      } else if (startsWith(pos, 'Y Offset:')) {
        pos += 9
        offsetY = readInt()
      } else if (startsWith(pos, 'Content:')) {
        inPreamble = false
      }
    }
    pos = eol + 1
  }

  // A truncated file may end inside a page.
  if (inPage) {
    while (open.length > 0) closeBox()
    const range = pages.get(currentPage)
    if (range) range[1] = count - 1
  }

  return {
    inputs,
    count,
    type,
    input,
    line,
    page,
    h,
    v,
    width,
    height,
    depth,
    parent,
    end,
    pages,
    scale: (unit * magnification) / 1000 / SP_PER_BP,
    offsetX: (offsetX * unit) / SP_PER_BP,
    offsetY: (offsetY * unit) / SP_PER_BP
  }
}

export async function loadSynctex(file: string): Promise<SynctexData> {
  const raw = await fs.readFile(file)
  const isGzip = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b
  return parseSynctex(isGzip ? await gunzip(raw) : raw)
}

function rectOf(d: SynctexData, i: number): PdfRect {
  return {
    page: d.page[i],
    x: d.h[i] * d.scale + d.offsetX,
    y: (d.v[i] - d.height[i]) * d.scale + d.offsetY,
    width: d.width[i] * d.scale,
    height: (d.height[i] + d.depth[i]) * d.scale
  }
}

/**
 * Forward search: where on the page does this source line end up?
 * `tags` are the input tags that refer to the file (see {@link tagsFor}).
 */
export function sourceToPdf(d: SynctexData, tags: ReadonlySet<number>, targetLine: number): PdfRect[] {
  if (tags.size === 0) return []

  const collect = (wanted: number): number[] => {
    const out: number[] = []
    for (let i = 0; i < d.count; i++) {
      if (d.line[i] === wanted && tags.has(d.input[i])) out.push(i)
    }
    return out
  }

  let matches = collect(targetLine)
  if (matches.length === 0) {
    // Blank lines and comments leave no trace: use the closest line that did.
    let after = Infinity
    let before = -Infinity
    for (let i = 0; i < d.count; i++) {
      if (!tags.has(d.input[i])) continue
      const l = d.line[i]
      if (l > targetLine && l < after) after = l
      else if (l < targetLine && l > before) before = l
    }
    const nearest = Number.isFinite(after) ? after : before
    if (!Number.isFinite(nearest)) return []
    matches = collect(nearest)
  }

  // Prefer the line boxes that contain matching glue/kern/text records: they
  // are tighter than boxes that merely carry the line number themselves.
  const fromLeaves = new Set<number>()
  const direct = new Set<number>()
  const loose: number[] = []
  for (const i of matches) {
    const t = d.type[i]
    if (t === T_HBOX || t === T_VOID_HBOX) {
      direct.add(i)
    } else if (t === T_LEAF) {
      const p = d.parent[i]
      if (p >= 0 && d.type[p] === T_HBOX) fromLeaves.add(p)
      else loose.push(i)
    }
  }

  const maxHeight = 260 / d.scale // skip boxes that span a large part of a page
  const usable = (set: Set<number>): number[] =>
    [...set].filter((i) => d.width[i] > 0 && d.height[i] + d.depth[i] > 0 && d.height[i] + d.depth[i] < maxHeight)

  let boxes = usable(fromLeaves)
  if (boxes.length === 0) boxes = usable(direct)

  let rects: PdfRect[] = boxes.map((i) => rectOf(d, i))
  if (rects.length === 0) {
    // Material sitting directly in a vertical list (rules, display maths, ...).
    rects = loose.map((i) => {
      const p = d.parent[i]
      const x = p >= 0 ? d.h[p] : d.h[i]
      const w = p >= 0 && d.width[p] > 0 ? d.width[p] : 40 / d.scale
      return {
        page: d.page[i],
        x: x * d.scale + d.offsetX,
        y: d.v[i] * d.scale + d.offsetY - 10,
        width: w * d.scale,
        height: 12
      }
    })
  }
  if (rects.length === 0) return []

  const firstPage = rects.reduce((min, r) => Math.min(min, r.page), Infinity)
  return rects
    .filter((r) => r.page === firstPage)
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .slice(0, 40)
}

export interface SynctexHit {
  /** File name as recorded by TeX. */
  input: string
  line: number
}

/**
 * Inverse search: which source line produced the material at (x, y) on `page`?
 * Coordinates are PDF points measured from the top-left corner of the page.
 */
export function pdfToSource(d: SynctexData, page: number, x: number, y: number): SynctexHit | null {
  const range = d.pages.get(page)
  if (!range) return null
  const [first, last] = range
  const hq = (x - d.offsetX) / d.scale
  const vq = (y - d.offsetY) / d.scale

  // Smallest horizontal box that contains the point.
  let best = -1
  let bestArea = Infinity
  for (let i = first; i <= last; i++) {
    if (d.type[i] !== T_HBOX) continue
    const left = d.h[i]
    const top = d.v[i] - d.height[i]
    if (hq < left || hq > left + d.width[i] || vq < top || vq > d.v[i] + d.depth[i]) continue
    const area = d.width[i] * (d.height[i] + d.depth[i])
    if (area <= bestArea) {
      best = i
      bestArea = area
    }
  }

  if (best < 0) {
    // Clicked in a margin or between lines: take the nearest line box.
    let bestDist = Infinity
    const reach = 60 / d.scale
    for (let i = first; i <= last; i++) {
      if (d.type[i] !== T_HBOX || d.width[i] <= 0) continue
      const left = d.h[i]
      const right = left + d.width[i]
      const top = d.v[i] - d.height[i]
      const bottom = d.v[i] + d.depth[i]
      const dx = hq < left ? left - hq : hq > right ? hq - right : 0
      const dy = vq < top ? top - vq : vq > bottom ? vq - bottom : 0
      const dist = dx + dy * 3 // staying on the same text line matters more
      const lineLike = bottom - top < 40 / d.scale
      if (lineLike && dist < bestDist && dx < reach * 4 && dy < reach) {
        best = i
        bestDist = dist
      }
    }
    if (best < 0) return null
  }

  // Inside that box, the record closest to the click gives the exact line.
  let leaf = -1
  let leafDist = Infinity
  for (let i = best + 1; i <= d.end[best]; i++) {
    if (d.type[i] === T_HBOX || d.type[i] === T_VBOX) continue
    const left = d.h[i]
    const right = left + Math.max(0, d.width[i])
    const dist = hq < left ? left - hq : hq > right ? hq - right : 0
    if (dist < leafDist) {
      leaf = i
      leafDist = dist
    }
  }

  for (const idx of [leaf, best]) {
    if (idx < 0) continue
    const name = d.inputs.get(d.input[idx])
    if (name !== undefined && d.line[idx] > 0) return { input: name, line: d.line[idx] }
  }
  return null
}

/** Input tags whose file resolves (via `resolve`) to the given project-relative path. */
export function tagsFor(
  d: SynctexData,
  relPath: string,
  resolve: (inputName: string) => string | null,
  caseInsensitive: boolean
): Set<number> {
  const norm = (p: string): string => (caseInsensitive ? p.toLowerCase() : p)
  const wanted = norm(relPath)
  const tags = new Set<number>()
  for (const [tag, name] of d.inputs) {
    const rel = resolve(name)
    if (rel !== null && norm(rel) === wanted) tags.add(tag)
  }
  return tags
}
