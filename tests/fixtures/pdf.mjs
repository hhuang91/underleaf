// A tiny PDF writer for tests: plain text in Helvetica, one or more pages.

function escapeText(text) {
  return text.replace(/[\\()]/g, '\\$&').replace(/[^\x20-\x7e]/g, '?')
}

/**
 * @param {Array<Array<{ x: number, y: number, size: number, text: string }>>} pages
 *   Text items per page; `y` is the baseline measured from the top of the page.
 * @returns {Buffer}
 */
export function makePdf(pages, { width = 612, height = 792 } = {}) {
  const objects = new Map()
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>')
  objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const kids = []
  pages.forEach((items, i) => {
    const contentId = 4 + 2 * i
    const pageId = 5 + 2 * i
    const content = items
      .map((it) => `BT /F1 ${it.size} Tf ${it.x} ${height - it.y} Td (${escapeText(it.text)}) Tj ET`)
      .join('\n')
    objects.set(contentId, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
    objects.set(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${contentId} 0 R ` +
        '/Resources << /Font << /F1 3 0 R >> >> >>'
    )
    kids.push(`${pageId} 0 R`)
  })
  objects.set(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`)

  const count = 3 + 2 * pages.length
  let out = '%PDF-1.4\n'
  const offsets = []
  for (let id = 1; id <= count; id++) {
    offsets.push(out.length)
    out += `${id} 0 obj\n${objects.get(id)}\nendobj\n`
  }
  const xref = out.length
  out += `xref\n0 ${count + 1}\n0000000000 65535 f \n`
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
