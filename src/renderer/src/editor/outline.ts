// Section structure of a .tex file, for the "File outline" panel.

export interface OutlineItem {
  /** 0 = part ... 6 = subparagraph */
  level: number
  title: string
  /** 1-based line number. */
  line: number
}

const LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6
}

const HEADING = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{/g

/** Reads a brace-delimited argument starting right after its opening brace. */
export function readBraced(text: string, start: number): string {
  let depth = 1
  let i = start
  while (i < text.length && depth > 0) {
    const ch = text[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') depth--
    i++
  }
  return text.slice(start, depth === 0 ? i - 1 : i)
}

export function plainTitle(raw: string): string {
  return raw
    .replace(/\\(?:label|index)\s*\{[^{}]*\}/g, '')
    .replace(/\$([^$]*)\$/g, '$1')
    .replace(/\\\\(\[[^\]]*\])?/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?\s*/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseOutline(text: string): OutlineItem[] {
  const items: OutlineItem[] = []
  const lines = text.split('\n')
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]
    if (!line.includes('\\')) continue
    // Ignore anything after an unescaped comment character.
    const comment = line.search(/(^|[^\\])%/)
    const code = comment < 0 ? line : line.slice(0, comment + (line[comment] === '%' ? 0 : 1))
    HEADING.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = HEADING.exec(code))) {
      // A heading's title may continue on the following lines.
      const rest = code.slice(m.index + m[0].length) + '\n' + lines.slice(n + 1, n + 4).join('\n')
      const title = plainTitle(readBraced(rest, 0))
      items.push({ level: LEVELS[m[1]], title: title || '(untitled)', line: n + 1 })
    }
  }
  return items
}
