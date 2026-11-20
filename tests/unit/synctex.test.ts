import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { loadSynctex, parseSynctex, pdfToSource, sourceToPdf, tagsFor } from '../../src/main/compile/synctex'

const SP = 65781.76

// Two pages. Page 1 has a line from main.tex (source lines 8-9) and a line
// from sections/intro.tex (source lines 4-5); page 2 has main.tex line 20.
const SAMPLE = `SyncTeX Version:1
Input:1:/work/./main.tex
Input:2:/usr/share/texlive/texmf-dist/tex/latex/base/article.cls
Input:3:/work/./sections/intro.tex
Output:pdf
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
!100
{1
[1,10:4736286,47171296:26673152,43234918,0
(1,10:4736286,6000000:26673152,655360,0
x1,8:4736286,6000000
g1,8:5000000,6000000
x1,9:9000000,6000000
)
(3,5:4736286,7000000:26673152,655360,131072
x3,4:4736286,7000000
k3,4:6000000,7000000:65536
x3,5:15000000,7000000
)
]
!200
}1
{2
[1,20:4736286,47171296:26673152,43234918,0
(1,20:4736286,6000000:26673152,655360,0
x1,20:4736286,6000000
)
]
}2
Postamble:
Count:12
Post scriptum:
`

const resolve = (name: string): string | null => {
  const m = /^\/work\/(?:\.\/)?(.+)$/.exec(name)
  return m ? m[1] : null
}

describe('parseSynctex', () => {
  const data = parseSynctex(Buffer.from(SAMPLE))

  it('reads inputs, pages and records', () => {
    expect(data.inputs.get(1)).toBe('/work/./main.tex')
    expect(data.inputs.get(3)).toBe('/work/./sections/intro.tex')
    expect([...data.pages.keys()]).toEqual([1, 2])
    expect(data.count).toBe(12)
    expect(data.pages.get(1)).toEqual([0, 8])
    expect(data.pages.get(2)).toEqual([9, 11])
  })

  it('links records to their enclosing box', () => {
    // Record 0 is the page's vbox, 1 the first hbox, 2 its first leaf.
    expect(data.parent[0]).toBe(-1)
    expect(data.parent[1]).toBe(0)
    expect(data.parent[2]).toBe(1)
    expect(data.end[1]).toBe(4)
    expect(data.end[0]).toBe(8)
  })

  it('maps a file to its input tags', () => {
    expect([...tagsFor(data, 'main.tex', resolve, false)]).toEqual([1])
    expect([...tagsFor(data, 'Sections/Intro.tex', resolve, true)]).toEqual([3])
    expect(tagsFor(data, 'missing.tex', resolve, false).size).toBe(0)
  })

  it('finds the PDF position of a source line', () => {
    const rects = sourceToPdf(data, new Set([1]), 8)
    expect(rects).toHaveLength(1)
    expect(rects[0].page).toBe(1)
    expect(rects[0].x).toBeCloseTo(4736286 / SP, 3) // one inch
    expect(rects[0].y).toBeCloseTo((6000000 - 655360) / SP, 3)
    expect(rects[0].width).toBeCloseTo(26673152 / SP, 3)
    expect(rects[0].height).toBeCloseTo(655360 / SP, 3)
  })

  it('falls back to the nearest line that produced output', () => {
    // Lines 11-19 of main.tex left no trace; the next one that did is 20, on page 2.
    const rects = sourceToPdf(data, new Set([1]), 11)
    expect(rects[0].page).toBe(2)
    // Past the end of the file: the last line that produced output.
    expect(sourceToPdf(data, new Set([1]), 500)[0].page).toBe(2)
  })

  it('returns nothing for a file that is not part of the PDF', () => {
    expect(sourceToPdf(data, new Set([99]), 1)).toEqual([])
    expect(sourceToPdf(data, new Set(), 1)).toEqual([])
  })

  it('finds the source line of a PDF position', () => {
    // Inside the second line box, horizontally closest to the kern from line 4.
    const hit = pdfToSource(data, 1, 6100000 / SP, 6800000 / SP)
    expect(hit).toEqual({ input: '/work/./sections/intro.tex', line: 4 })
    // Further right, the record from line 5 is closer.
    expect(pdfToSource(data, 1, 16000000 / SP, 6800000 / SP)).toEqual({
      input: '/work/./sections/intro.tex',
      line: 5
    })
    // First line box.
    expect(pdfToSource(data, 1, 9100000 / SP, 5900000 / SP)).toEqual({ input: '/work/./main.tex', line: 9 })
  })

  it('snaps a click between lines to the nearest line and ignores far-away clicks', () => {
    const between = pdfToSource(data, 1, 9000000 / SP, 6100000 / SP)
    expect(between?.input).toBe('/work/./main.tex')
    expect(pdfToSource(data, 1, 9000000 / SP, 30000000 / SP)).toBeNull()
    expect(pdfToSource(data, 7, 100, 100)).toBeNull()
  })

  it('applies the offsets that XeTeX-based engines record', () => {
    const xe = parseSynctex(Buffer.from(SAMPLE.replace('X Offset:0', 'X Offset:4736287').replace('Y Offset:0', 'Y Offset:4736287')))
    const [rect] = sourceToPdf(xe, new Set([1]), 8)
    expect(rect.x).toBeCloseTo((4736286 + 4736287) / SP, 3)
    expect(pdfToSource(xe, 1, (9100000 + 4736287) / SP, (5900000 + 4736287) / SP)?.line).toBe(9)
  })

  it('survives a truncated file', () => {
    const cut = parseSynctex(Buffer.from(SAMPLE.slice(0, SAMPLE.indexOf('x3,5'))))
    expect(cut.pages.get(1)?.[1]).toBe(cut.count - 1)
    expect(pdfToSource(cut, 1, 6100000 / SP, 6800000 / SP)?.line).toBe(4)
  })
})

describe('loadSynctex', () => {
  it('reads gzip-compressed and plain files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'underleaf-synctex-'))
    try {
      const gz = path.join(dir, 'output.synctex.gz')
      const plain = path.join(dir, 'output.synctex')
      await fs.writeFile(gz, zlib.gzipSync(Buffer.from(SAMPLE)))
      await fs.writeFile(plain, SAMPLE)
      expect((await loadSynctex(gz)).count).toBe(12)
      expect((await loadSynctex(plain)).count).toBe(12)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
