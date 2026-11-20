// Turns TeX and BibTeX logs into a list of errors and warnings with file and
// line information, similar to the "Logs" panel in Overleaf.

import type { LogEntry } from '@shared/types'

export interface ParseContext {
  /**
   * Maps a path as it appears in the log to a project-relative path, or null
   * when the file is not part of the project (class files, packages, ...).
   */
  resolveFile(logPath: string): string | null
}

const WRAP_COLUMN = 79
const MAX_ENTRIES = 600

/**
 * TeX hard-wraps log lines at 79 columns; glue those pieces back together.
 * The context lines of an error are different: they are cut off with "..." at
 * that width and do not continue on the next line.
 */
export function unwrapLog(text: string): string[] {
  const raw = text.split(/\r?\n/)
  const out: string[] = []
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i]
    let piece = raw[i]
    while (
      i + 1 < raw.length &&
      (piece.length === WRAP_COLUMN || Buffer.byteLength(piece, 'utf8') === WRAP_COLUMN) &&
      !piece.endsWith('...')
    ) {
      i++
      piece = raw[i]
      line += piece
    }
    out.push(line)
  }
  return out
}

// "./chapters/intro.tex:12: Undefined control sequence."
const FILE_LINE_ERROR = /^((?:[A-Za-z]:)?(?:[^:\n]*[\\/])?[^:\\/\n]+\.[A-Za-z0-9_-]+):(\d+): (.+)$/
const WARNING =
  /^(LaTeX3?(?: Font)?|pdfTeX|Package \S+|Class \S+|Module \S+) [Ww]arning(?: \([^)]*\))?: ?(.*)$/
const BAD_BOX = /^(Overfull|Underfull) \\[hv]box \(/
const MISSING_CHAR = /^Missing character: There is no (.+) in font (.+?)!?$/
const SOURCE_LINE = /^l\.(\d+)(?: (.*))?$/
// Stock advice that TeX prints after every error; it only adds noise.
const BOILERPLATE = /^(See the LaTeX manual|Type\s+H <return>|\s*\.\.\.\s*$|Type X to quit|or enter new name|Enter file name)/
// A path that is explicit about being a path: ./x, ../x, /x or C:\x
const EXPLICIT_PATH = /^((?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])[^()\n]*?\.[A-Za-z0-9_-]+)(?=[\s()]|$)/
// A bare token such as "main.tex" (Tectonic and MiKTeX print these).
const BARE_PATH = /^([^\s()]+\.[A-Za-z0-9_-]+)(?=[\s()]|$)/

function startsMessage(line: string): boolean {
  return (
    line.startsWith('! ') ||
    WARNING.test(line) ||
    BAD_BOX.test(line) ||
    FILE_LINE_ERROR.test(line)
  )
}

function tidy(message: string): string {
  return message.replace(/\s+/g, ' ').trim()
}

export function parseLatexLog(text: string, ctx: ParseContext): LogEntry[] {
  const lines = unwrapLog(text)
  const entries: LogEntry[] = []
  const seen = new Set<string>()
  // One element per open parenthesis: a file path, or null for an ordinary "(".
  const stack: Array<string | null> = []

  const push = (entry: LogEntry): void => {
    if (entries.length >= MAX_ENTRIES) return
    const key = `${entry.level}|${entry.file ?? ''}|${entry.line ?? ''}|${entry.message}`
    if (seen.has(key)) return
    seen.add(key)
    entries.push(entry)
  }

  const currentFile = (): string | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const p = stack[i]
      if (p !== null) return ctx.resolveFile(p) ?? undefined
    }
    return undefined
  }

  const trackFiles = (line: string): void => {
    let pos = 0
    while (pos < line.length) {
      const ch = line.charCodeAt(pos)
      if (ch === 40 /* ( */) {
        const rest = line.slice(pos + 1)
        const explicit = EXPLICIT_PATH.exec(rest)
        if (explicit) {
          stack.push(explicit[1])
          pos += 1 + explicit[0].length
          continue
        }
        const bare = BARE_PATH.exec(rest)
        if (bare && ctx.resolveFile(bare[1]) !== null) {
          stack.push(bare[1])
          pos += 1 + bare[0].length
          continue
        }
        stack.push(null)
      } else if (ch === 41 /* ) */) {
        stack.pop()
      }
      pos++
    }
  }

  /**
   * Collects the explanatory lines after an error up to and including the
   * "l.<n> <source>" line, which also tells us the line number.
   */
  const errorContext = (start: number): { next: number; line?: number; content: string; top?: string } => {
    const context: string[] = []
    let lineNo: number | undefined
    let i = start
    const limit = Math.min(lines.length, start + 25)
    while (i < limit) {
      const l = lines[i]
      if (startsMessage(l)) break
      const m = SOURCE_LINE.exec(l)
      if (m) {
        lineNo = Number(m[1])
        context.push(l)
        i++
        // TeX prints the rest of the source line on the following line.
        if (i < lines.length && lines[i].trim() && !startsMessage(lines[i])) {
          context.push(lines[i])
          i++
        }
        break
      }
      if (l.trim() && !BOILERPLATE.test(l)) context.push(l)
      i++
    }
    if (lineNo === undefined) {
      // No source line found: keep only the paragraph right after the error.
      const firstGap = lines.slice(start, i).findIndex((l) => !l.trim())
      const end = firstGap < 0 ? i : start + firstGap
      const paragraph = lines.slice(start, end)
      return { next: end, content: paragraph.join('\n').trim(), top: paragraph.find((l) => l.trim()) }
    }
    return { next: i, line: lineNo, content: context.join('\n').trim(), top: context[0] }
  }

  const describeError = (message: string, top: string | undefined): string => {
    // Tectonic prints LaTeX errors as "! ! LaTeX Error: ... not found.."
    let msg = tidy(message).replace(/^(?:! )+/, '').replace(/\.\.$/, '.')
    if (/^Undefined control sequence\.?$/.test(msg) && top) {
      // TeX breaks the first context line right after the offending command.
      // That line is the source line itself, or, when the command sits inside
      // a macro, the expansion of that macro.
      const cs = /(\\(?:[A-Za-z@]+|.))\s*$/.exec(top.replace(/^l\.\d+ /, ''))
      if (cs) msg = `Undefined control sequence: ${cs[1]}`
    }
    return msg
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // ---- errors in file:line:message form (-file-line-error)
    let m = FILE_LINE_ERROR.exec(line)
    if (m) {
      const ctxInfo = errorContext(i + 1)
      const file = ctx.resolveFile(m[1]) ?? undefined
      push({
        level: 'error',
        source: 'latex',
        message: describeError(m[3], ctxInfo.top),
        content: ctxInfo.content || undefined,
        file,
        line: file ? Number(m[2]) : undefined
      })
      i = ctxInfo.next
      continue
    }

    // ---- classic "! message" errors
    if (line.startsWith('! ')) {
      let message = line.slice(2)
      let j = i + 1
      // "! Package foo Error: text" continues on lines prefixed with "(foo)".
      const pkg = /^(?:Package|Class) (\S+) Error:/.exec(message)
      if (pkg) {
        const prefix = `(${pkg[1]})`
        while (j < lines.length && lines[j].startsWith(prefix)) {
          message += ' ' + lines[j].slice(prefix.length).trim()
          j++
        }
      }
      const ctxInfo = errorContext(j)
      const fatal = /^ ?==> Fatal error occurred/.test(message)
      push({
        level: 'error',
        source: 'latex',
        message: fatal ? 'Fatal error: no output PDF file was produced' : describeError(message, ctxInfo.top),
        content: ctxInfo.content || undefined,
        file: currentFile(),
        line: ctxInfo.line
      })
      i = ctxInfo.next
      continue
    }

    // ---- warnings
    m = WARNING.exec(line)
    if (m) {
      const origin = m[1]
      let message = m[2]
      const pkgName = /^(?:Package|Class|Module) (\S+)$/.exec(origin)?.[1]
      const prefix = pkgName ? `(${pkgName})` : origin.includes('Font') ? '(Font)' : null
      let j = i + 1
      while (j < lines.length && j < i + 12) {
        const l = lines[j]
        if (!l.trim() || startsMessage(l)) break
        if (prefix && l.startsWith(prefix)) message += ' ' + l.slice(prefix.length).trim()
        else if (!prefix && /^\s{2,}\S/.test(l)) message += ' ' + l.trim() // indented continuation
        else break
        j++
      }
      message = tidy(message)
      const lineMatch = /on input line (\d+)/.exec(message) ?? /on line (\d+)/.exec(message)
      const file = currentFile()
      push({
        level: 'warning',
        source: 'latex',
        message: pkgName ? `${origin.split(' ')[0]} ${pkgName}: ${message}` : message,
        file,
        line: lineMatch ? Number(lineMatch[1]) : undefined
      })
      i = j
      continue
    }

    // ---- overfull / underfull boxes
    if (BAD_BOX.test(line)) {
      const range = /at lines (\d+)--(\d+)/.exec(line) ?? /at line (\d+)/.exec(line)
      push({
        level: 'typesetting',
        source: 'latex',
        message: tidy(line),
        file: currentFile(),
        line: range ? Number(range[1]) : undefined
      })
      // The offending text follows; it may contain parentheses, so skip it.
      let j = i + 1
      while (
        j < lines.length &&
        j < i + 8 &&
        lines[j].trim() &&
        !startsMessage(lines[j]) &&
        !/^[()]/.test(lines[j])
      ) {
        j++
      }
      i = j
      continue
    }

    m = MISSING_CHAR.exec(line)
    if (m) {
      push({
        level: 'warning',
        source: 'latex',
        message: `Missing character: there is no ${m[1]} in font ${m[2]}`,
        file: currentFile()
      })
      i++
      continue
    }

    trackFiles(line)
    i++
  }

  return dropConsequentialErrors(entries)
}

/** True for the error that reports a file (package, class, input, image) as missing. */
export function isMissingFileError(entry: LogEntry): boolean {
  return entry.level === 'error' && /File `[^']+' not found/.test(entry.message) && !/File `\.' not found/.test(entry.message)
}

// Names from LaTeX's file-loading code. They show up, with or without a
// backslash, in the context of the errors that follow a file that could not be
// loaded, and never in errors about the document's own text.
const MISSING_FILE_FALLOUT = /@currname|@currext|@currpath|@currpkg@reqd|@missingfile|@pkg-disable|@raw@opt@/

/** Removes errors that are only the fallout of an earlier, real error. */
function dropConsequentialErrors(all: LogEntry[]): LogEntry[] {
  // A missing file sends an engine that cannot ask the user through LaTeX's
  // "enter a new file name" prompt and leaves internal macros undefined. What
  // follows, up to a hundred errors, says nothing the first one did not.
  let entries = all
  if (all.some(isMissingFileError)) {
    let afterMissingFile = false
    entries = all.filter((e) => {
      if (isMissingFileError(e)) {
        afterMissingFile = true
        return true
      }
      if (!afterMissingFile || e.level !== 'error') return true
      if (/File `\.' not found|The (?:package|class) \. failed to load/.test(e.message)) return false
      return !(/^Undefined control sequence/.test(e.message) && MISSING_FILE_FALLOUT.test(e.content ?? ''))
    })
  }

  // "Emergency stop" only ever follows a real error and says nothing by itself,
  // but it often knows the line number that the real error lacks.
  const isStop = (e: LogEntry): boolean => e.level === 'error' && /^Emergency stop\.?$/.test(e.message)
  if (!entries.some((e) => e.level === 'error' && !isStop(e))) return entries
  let lastError: LogEntry | null = null
  for (const e of entries) {
    if (e.level !== 'error') continue
    if (isStop(e)) {
      if (lastError && lastError.line === undefined && e.line !== undefined && lastError.file === e.file) {
        lastError.line = e.line
      }
    } else {
      lastError = e
    }
  }
  return entries.filter((e) => !isStop(e))
}

/** Parses a BibTeX (.blg) or Biber log. */
export function parseBibLog(text: string, ctx: ParseContext): LogEntry[] {
  const lines = text.split(/\r?\n/)
  const entries: LogEntry[] = []
  const resolve = (p: string): string | undefined => ctx.resolveFile(p.trim()) ?? undefined

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Biber: "[123] Utils.pm:411> WARN - message"
    const biber = /^\[\d+\] \S+> (WARN|ERROR) - (.+)$/.exec(line)
    if (biber) {
      const where = /([^\s,']+\.bib)(?:_\d+\.utf8)?, line (\d+)/.exec(biber[2])
      entries.push({
        level: biber[1] === 'ERROR' ? 'error' : 'warning',
        source: 'bibtex',
        message: biber[2].trim(),
        file: where ? resolve(where[1].split(/[\\/]/).pop() ?? where[1]) : undefined,
        line: where ? Number(where[2]) : undefined
      })
      continue
    }

    const warning = /^Warning--(.+)$/.exec(line)
    if (warning) {
      const where = /^--line (\d+) of file (.+)$/.exec(lines[i + 1] ?? '')
      entries.push({
        level: 'warning',
        source: 'bibtex',
        message: warning[1].trim(),
        file: where ? resolve(where[2]) : undefined,
        line: where ? Number(where[1]) : undefined
      })
      if (where) i++
      continue
    }

    const error = /^(.*?)---line (\d+) of file (.+)$/.exec(line)
    if (error) {
      const message = error[1].trim() || (lines[i - 1] ?? '').trim() || 'BibTeX error'
      entries.push({
        level: 'error',
        source: 'bibtex',
        message,
        file: resolve(error[3]),
        line: Number(error[2])
      })
      continue
    }

    const missing = /^I couldn't open (database|style|auxiliary) file (.+)$/.exec(line)
    if (missing) {
      entries.push({
        level: 'error',
        source: 'bibtex',
        message: `BibTeX could not open the ${missing[1]} file ${missing[2].trim()}`
      })
      continue
    }

    const found = /^I found no (.+?)---while reading file (.+)$/.exec(line)
    if (found) {
      entries.push({ level: 'warning', source: 'bibtex', message: `BibTeX found no ${found[1]}` })
    }
  }
  return entries
}

// Tectonic's wrappers around a TeX failure; the TeX log has the real message.
const ENGINE_NOISE =
  /^halted (on|after) |^something bad happened inside|engine had an unrecoverable error|errors were issued by the TeX engine/

/**
 * Reads "error: ..." / "warning: ..." lines from an engine's console output
 * (Tectonic prints these). With `engineOnly`, messages that point at a source
 * line are skipped because the TeX log already reports them in more detail.
 */
export function parseEngineOutput(output: string, ctx: ParseContext, engineOnly = false): LogEntry[] {
  const entries: LogEntry[] = []
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    const m = /^(error|warning): (.+)$/.exec(line)
    if (!m) continue
    if (ENGINE_NOISE.test(m[2])) continue
    const where = /^((?:[A-Za-z]:)?[^:]+\.[A-Za-z0-9_-]+):(\d+): (.+)$/.exec(m[2])
    if (where && engineOnly) continue
    const file = where ? ctx.resolveFile(where[1]) ?? undefined : undefined
    const message = where ? where[3] : m[2]
    entries.push({
      level: m[1] === 'error' ? 'error' : /^(Overfull|Underfull) /.test(message) ? 'typesetting' : 'warning',
      source: 'engine',
      message,
      file,
      line: where && file ? Number(where[2]) : undefined
    })
  }
  return entries
}

export function countEntries(entries: LogEntry[]): { errors: number; warnings: number; typesetting: number } {
  let errors = 0
  let warnings = 0
  let typesetting = 0
  for (const e of entries) {
    if (e.level === 'error') errors++
    else if (e.level === 'warning') warnings++
    else if (e.level === 'typesetting') typesetting++
  }
  return { errors, warnings, typesetting }
}
