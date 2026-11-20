// Light-weight static analysis of a project: symbols for autocompletion and an
// approximate word count.

import fs from 'node:fs/promises'
import path from 'node:path'
import type { BibEntryInfo, ProjectIndex, WordCount } from '@shared/types'
import { extensionOf } from '@shared/fileTypes'
import { walk } from './files'
import { isInside } from './util/fsx'

const TEX_LIKE = new Set(['tex', 'ltx', 'latex', 'sty', 'cls'])
const MAX_SCAN_BYTES = 3 * 1024 * 1024

interface FileSymbols {
  size: number
  mtimeMs: number
  labels: string[]
  commands: string[]
  environments: string[]
  bib: BibEntryInfo[]
}

/** Removes TeX comments (an unescaped % up to the end of the line). */
export function stripComments(text: string): string {
  return text.replace(/(^|[^\\])%.*$/gm, '$1')
}

function cleanBibValue(value: string): string {
  return value
    .replace(/\\[a-zA-Z]+\s*/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseBibEntries(text: string, file: string): BibEntryInfo[] {
  const out: BibEntryInfo[] = []
  const header = /@([A-Za-z]+)\s*[{(]\s*([^,\s{}()"]+)\s*,/g
  const starts: Array<{ index: number; end: number; type: string; key: string }> = []
  let m: RegExpExecArray | null
  while ((m = header.exec(text))) {
    const type = m[1].toLowerCase()
    if (type === 'comment' || type === 'string' || type === 'preamble') continue
    starts.push({ index: m.index, end: header.lastIndex, type, key: m[2] })
  }
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]
    const body = text.slice(s.end, i + 1 < starts.length ? starts[i + 1].index : Math.min(text.length, s.end + 8000))
    const entry: BibEntryInfo = { key: s.key, type: s.type, file }
    const field = /\b(title|author|year|date)\s*=\s*(?:\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}|"([^"]*)"|(\d+))/gi
    let f: RegExpExecArray | null
    while ((f = field.exec(body))) {
      const name = f[1].toLowerCase()
      const value = cleanBibValue(f[2] ?? f[3] ?? f[4] ?? '')
      if (!value) continue
      if (name === 'title' && !entry.title) entry.title = value
      else if (name === 'author' && !entry.author) entry.author = value
      else if ((name === 'year' || name === 'date') && !entry.year) entry.year = value.slice(0, 4)
    }
    out.push(entry)
  }
  return out
}

export function scanTex(text: string): { labels: string[]; commands: string[]; environments: string[] } {
  const src = stripComments(text)
  const labels = new Set<string>()
  const commands = new Set<string>()
  const environments = new Set<string>()
  let m: RegExpExecArray | null

  const label = /\\label\s*\{([^{}]+)\}/g
  while ((m = label.exec(src))) labels.add(m[1].trim())

  const cmd =
    /\\(?:(?:re)?newcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|NewDocumentCommand|RenewDocumentCommand|def|let)\*?\s*\{?\s*\\([A-Za-z@]+)/g
  while ((m = cmd.exec(src))) commands.add(m[1])

  const env = /\\(?:(?:re)?newenvironment|newtheorem|NewDocumentEnvironment|newtcolorbox|declaretheorem)\*?\s*(?:\[[^\]]*\]\s*)?\{([A-Za-z@*]+)\}/g
  while ((m = env.exec(src))) environments.add(m[1])

  return { labels: [...labels], commands: [...commands], environments: [...environments] }
}

export class ProjectAnalyzer {
  private readonly cache = new Map<string, FileSymbols>()

  /** Collects labels, citation keys and user-defined macros across the project. */
  async index(dir: string): Promise<ProjectIndex> {
    const entries = await walk(dir, { stats: true })
    const alive = new Set<string>()
    const result: ProjectIndex = { labels: [], bibEntries: [], commands: [], environments: [] }
    const commands = new Set<string>()
    const environments = new Set<string>()

    for (const e of entries) {
      if (e.isDir || e.size > MAX_SCAN_BYTES) continue
      const ext = extensionOf(e.rel)
      const isBib = ext === 'bib'
      if (!isBib && !TEX_LIKE.has(ext)) continue
      alive.add(e.abs)

      let sym = this.cache.get(e.abs)
      if (!sym || sym.size !== e.size || sym.mtimeMs !== e.mtimeMs) {
        let text = ''
        try {
          text = await fs.readFile(e.abs, 'utf8')
        } catch {
          continue
        }
        sym = { size: e.size, mtimeMs: e.mtimeMs, labels: [], commands: [], environments: [], bib: [] }
        if (isBib) sym.bib = parseBibEntries(text, e.rel)
        else Object.assign(sym, scanTex(text))
        this.cache.set(e.abs, sym)
      }
      for (const name of sym.labels) result.labels.push({ name, file: e.rel })
      for (const b of sym.bib) result.bibEntries.push({ ...b, file: e.rel })
      for (const c of sym.commands) commands.add(c)
      for (const en of sym.environments) environments.add(en)
    }

    // Forget files that no longer exist (only those below this project).
    for (const key of this.cache.keys()) {
      if (!alive.has(key) && isInside(dir, key)) this.cache.delete(key)
    }
    result.commands = [...commands].sort()
    result.environments = [...environments].sort()
    return result
  }

  /** Approximate word count of the document starting at `rootDoc`. */
  async wordCount(dir: string, rootDoc: string): Promise<WordCount> {
    const visited = new Set<string>()
    const mainDir = path.dirname(path.resolve(dir, rootDoc))

    const load = async (abs: string, depth: number): Promise<string> => {
      const key = abs.toLowerCase()
      if (depth > 8 || visited.has(key) || !isInside(dir, abs)) return ''
      visited.add(key)
      let text: string
      try {
        text = stripComments(await fs.readFile(abs, 'utf8'))
      } catch {
        return ''
      }
      const include = /\\(?:input|include|subfile)\s*\{([^{}]+)\}/g
      let out = ''
      let lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = include.exec(text))) {
        out += text.slice(lastIndex, m.index)
        lastIndex = include.lastIndex
        let target = m[1].trim()
        if (!/\.[A-Za-z0-9]+$/.test(target)) target += '.tex'
        out += '\n' + (await load(path.resolve(mainDir, target), depth + 1)) + '\n'
      }
      return out + text.slice(lastIndex)
    }

    const full = await load(path.resolve(dir, rootDoc), 0)
    return { ...countWordsInTex(full), files: visited.size }
  }
}

export function countWordsInTex(source: string): Omit<WordCount, 'files'> {
  let text = source
  const begin = text.search(/\\begin\s*\{document\}/)
  if (begin >= 0) text = text.slice(begin).replace(/\\begin\s*\{document\}/, '')
  const endDoc = text.search(/\\end\s*\{document\}/)
  if (endDoc >= 0) text = text.slice(0, endDoc)

  // Material that is not prose.
  text = text.replace(
    /\\begin\s*\{(verbatim\*?|lstlisting|minted|tikzpicture|comment|filecontents\*?)\}[\s\S]*?\\end\s*\{\1\}/g,
    ' '
  )

  let mathDisplay = 0
  let mathInline = 0
  text = text.replace(
    /\\begin\s*\{(equation|align|gather|multline|eqnarray|displaymath|flalign|alignat|math)(\*?)\}[\s\S]*?\\end\s*\{\1\2\}/g,
    (_all, name: string) => {
      if (name === 'math') mathInline++
      else mathDisplay++
      return ' '
    }
  )
  text = text.replace(/\\\[[\s\S]*?\\\]/g, () => (mathDisplay++, ' '))
  text = text.replace(/\$\$[\s\S]*?\$\$/g, () => (mathDisplay++, ' '))
  text = text.replace(/\\\([\s\S]*?\\\)/g, () => (mathInline++, ' '))
  text = text.replace(/(^|[^\\])\$[^$]*?[^\\]?\$/g, (_all, pre: string) => (mathInline++, pre + ' '))

  const headers = (text.match(/\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{/g) ?? []).length

  // \href{url}{text}: drop the URL, keep the text.
  text = text.replace(/\\href\s*\{[^{}]*\}/g, ' ')
  // Commands whose arguments are not prose.
  text = text.replace(
    /\\(?:cite[a-zA-Z]*|[a-zA-Z]*ref|label|includegraphics|input|include|bibliography|bibliographystyle|usepackage|begin|end|url|vspace|hspace|setlength|addbibresource|printbibliography|newcommand|renewcommand|pagestyle|thispagestyle|color|textcolor|definecolor)\*?\s*(?:\[[^\]]*\]\s*)*(?:\{[^{}]*\}\s*)*/g,
    ' '
  )
  text = text.replace(/\\[a-zA-Z@]+\*?/g, ' ').replace(/\\./g, ' ')
  text = text.replace(/\[[^\]\n]{0,80}\]/g, ' ')

  const words = (text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) ?? []).length
  return { words, headers, mathInline, mathDisplay }
}
