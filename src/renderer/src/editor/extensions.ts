// Editor behaviour that is specific to LaTeX: formatting commands, automatic
// \end insertion, a light syntax check, compile-log markers and spell checking.

import { snippet } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import { linter, type Diagnostic } from '@codemirror/lint'
import {
  EditorSelection,
  Prec,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  gutter,
  GutterMarker,
  keymap,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import type { LogEntry } from '@shared/types'
import { unclosedCount } from './completions'

const INDENT = '    '

// ------------------------------------------------------------ formatting

/** Wraps every selection in `before`/`after`; with nothing selected the cursor lands inside. */
export function wrapSelection(view: EditorView, before: string, after: string): boolean {
  const tr = view.state.changeByRange((range) => {
    const text = view.state.sliceDoc(range.from, range.to)
    // Toggle off when the selection is already wrapped.
    const outerFrom = range.from - before.length
    const outerTo = range.to + after.length
    if (
      outerFrom >= 0 &&
      view.state.sliceDoc(outerFrom, range.from) === before &&
      view.state.sliceDoc(range.to, outerTo) === after
    ) {
      return {
        changes: [
          { from: outerFrom, to: range.from },
          { from: range.to, to: outerTo }
        ],
        range: EditorSelection.range(outerFrom, outerFrom + text.length)
      }
    }
    return {
      changes: [
        { from: range.from, insert: before },
        { from: range.to, insert: after }
      ],
      range: EditorSelection.range(range.from + before.length, range.to + before.length)
    }
  })
  view.dispatch(view.state.update(tr, { scrollIntoView: true, userEvent: 'input' }))
  view.focus()
  return true
}

export function insertTemplate(view: EditorView, template: string): void {
  const { from, to } = view.state.selection.main
  snippet(template)(view, null, from, to)
  view.focus()
}

/** Inserts a block-level template on its own line(s). */
export function insertBlock(view: EditorView, template: string): void {
  const { state } = view
  const pos = state.selection.main.head
  const line = state.doc.lineAt(pos)
  const indent = /^\s*/.exec(line.text)?.[0] ?? ''
  if (line.text.trim() === '') {
    snippet(template)(view, null, line.from + indent.length, line.to)
  } else {
    snippet('\n' + template)(view, null, line.to, line.to)
  }
  view.focus()
}

const SECTION_RE = /^(\s*)\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\{(.*)\}\s*$/

export type HeadingLevel = 'text' | 'section' | 'subsection' | 'subsubsection' | 'paragraph' | 'subparagraph'

/** Heading level of the line the cursor is on. */
export function currentHeading(view: EditorView): HeadingLevel {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  const m = SECTION_RE.exec(line.text)
  return m && m[2] !== 'part' && m[2] !== 'chapter' ? (m[2] as HeadingLevel) : 'text'
}

/** Turns the current line into a heading of the given level (or back into plain text). */
export function setHeading(view: EditorView, level: HeadingLevel): void {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  const m = SECTION_RE.exec(line.text)
  const indent = m ? m[1] : (/^\s*/.exec(line.text)?.[0] ?? '')
  const content = m ? m[4] : line.text.trim()
  const insert = level === 'text' ? indent + content : `${indent}\\${level}{${content}}`
  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    selection: { anchor: line.from + insert.length - (level === 'text' ? 0 : 1) },
    userEvent: 'input'
  })
  view.focus()
}

/** Wraps the selected lines in itemize/enumerate, one \item per line. */
export function insertList(view: EditorView, env: 'itemize' | 'enumerate'): void {
  const { state } = view
  const sel = state.selection.main
  if (sel.empty) {
    insertBlock(view, `\\begin{${env}}\n\t\\item \${}\n\\end{${env}}`)
    return
  }
  const first = state.doc.lineAt(sel.from)
  const last = state.doc.lineAt(sel.to)
  const indent = /^\s*/.exec(first.text)?.[0] ?? ''
  const items: string[] = []
  for (let n = first.number; n <= last.number; n++) {
    const text = state.doc.line(n).text.trim()
    if (text) items.push(`${indent}${INDENT}\\item ${text}`)
  }
  const insert = [`${indent}\\begin{${env}}`, ...items, `${indent}\\end{${env}}`].join('\n')
  view.dispatch({
    changes: { from: first.from, to: last.to, insert },
    selection: { anchor: first.from + insert.length },
    userEvent: 'input'
  })
  view.focus()
}

// --------------------------------------------- Enter: \end and \item help

const LIST_ENVS = new Set(['itemize', 'enumerate', 'description'])

function handleEnter(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty || state.selection.ranges.length > 1) return false
  const line = state.doc.lineAt(sel.head)
  const before = line.text.slice(0, sel.head - line.from)
  const after = line.text.slice(sel.head - line.from)
  if (after.trim() !== '') return false
  const indent = /^\s*/.exec(line.text)?.[0] ?? ''

  // \begin{env}<Enter> : add the matching \end{env}
  const begin = /\\begin\{([^{}]+)\}(?:\[[^\]]*\]|\{[^{}]*\})*\s*$/.exec(before)
  if (begin && !/(^|[^\\])%/.test(before)) {
    const name = begin[1]
    if (unclosedCount(state.doc.toString(), name) <= 0) return false
    const inner = indent + INDENT + (LIST_ENVS.has(name) ? '\\item ' : '')
    view.dispatch({
      changes: { from: sel.head, to: line.to, insert: `\n${inner}\n${indent}\\end{${name}}` },
      selection: { anchor: sel.head + 1 + inner.length },
      scrollIntoView: true,
      userEvent: 'input'
    })
    return true
  }

  // Inside a list: continue with a new \item, or leave the list on an empty one.
  const item = /^(\s*)\\item(\[[^\]]*\])?(\s*)(.*)$/.exec(before)
  if (item) {
    if (item[4].trim() === '') {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: item[1].slice(0, Math.max(0, item[1].length - INDENT.length)) },
        userEvent: 'delete'
      })
      return true
    }
    const insert = `\n${item[1]}\\item `
    view.dispatch({
      changes: { from: sel.head, to: line.to, insert },
      selection: { anchor: sel.head + insert.length },
      scrollIntoView: true,
      userEvent: 'input'
    })
    return true
  }
  return false
}

export const latexEnterKeymap: Extension = Prec.high(keymap.of([{ key: 'Enter', run: handleEnter }]))

// -------------------------------------------------------- syntax check

interface OpenGroup {
  kind: 'brace' | 'env'
  name: string
  from: number
  to: number
}

const VERBATIM_ENV = /^(verbatim\*?|Verbatim|lstlisting|minted|comment|filecontents\*?)$/

/** Finds mismatched braces and \begin/\end pairs. Deliberately conservative. */
export function checkLatex(text: string): Diagnostic[] {
  const out: Diagnostic[] = []
  const stack: OpenGroup[] = []
  const n = text.length
  // Preambles legitimately contain unbalanced pieces, for example
  // \newcommand{\be}{\begin{equation}}; only the document body is checked.
  const body = text.search(/\\begin\s*\{document\}/)
  let i = body < 0 ? 0 : body
  while (i < n && out.length < 25) {
    const ch = text[i]
    if (ch === '%') {
      const nl = text.indexOf('\n', i)
      i = nl < 0 ? n : nl + 1
      continue
    }
    if (ch === '\\') {
      // \verb|...| may contain anything up to its closing delimiter.
      const verb = /^\\verb\*?([^a-zA-Z\s*])/.exec(text.slice(i, i + 8))
      if (verb) {
        const start = i + verb[0].length
        const close = text.indexOf(verb[1], start)
        const lineEnd = text.indexOf('\n', start)
        i = close >= 0 && (lineEnd < 0 || close < lineEnd) ? close + 1 : start
        continue
      }
      const m = /^\\(begin|end)\s*\{([^{}\n]*)\}/.exec(text.slice(i, i + 80))
      if (m) {
        const name = m[2]
        const to = i + m[0].length
        if (m[1] === 'begin') {
          if (VERBATIM_ENV.test(name)) {
            const closer = `\\end{${name}}`
            const end = text.indexOf(closer, to)
            if (end < 0) {
              out.push({ from: i, to, severity: 'error', message: `\\begin{${name}} is never closed` })
              return out
            }
            i = end + closer.length
            continue
          }
          stack.push({ kind: 'env', name, from: i, to })
        } else {
          const top = stack[stack.length - 1]
          if (top && top.kind === 'env' && top.name === name) {
            stack.pop()
          } else if (top && top.kind === 'brace') {
            out.push({ from: top.from, to: top.to, severity: 'error', message: `This { is not closed before \\end{${name}}` })
            // Recover: drop braces opened since the matching \begin.
            while (stack.length > 0 && stack[stack.length - 1].kind === 'brace') stack.pop()
            const env = stack[stack.length - 1]
            if (env && env.name === name) stack.pop()
          } else if (top) {
            out.push({
              from: i,
              to,
              severity: 'error',
              message: `\\end{${name}} does not match \\begin{${top.name}}`
            })
            const match = stack.map((g) => g.kind === 'env' && g.name === name).lastIndexOf(true)
            if (match >= 0) stack.length = match
          } else {
            out.push({ from: i, to, severity: 'error', message: `\\end{${name}} has no matching \\begin` })
          }
        }
        i = to
        continue
      }
      i += 2 // skip the escaped character (\{, \}, \%, \\ ...)
      continue
    }
    if (ch === '{') {
      stack.push({ kind: 'brace', name: '{', from: i, to: i + 1 })
    } else if (ch === '}') {
      const top = stack[stack.length - 1]
      if (top && top.kind === 'brace') stack.pop()
      else out.push({ from: i, to: i + 1, severity: 'error', message: top ? `Unexpected } inside \\begin{${top.name}}` : 'Unexpected }' })
    }
    i++
  }
  for (const g of stack.slice(0, 10)) {
    out.push({
      from: g.from,
      to: g.to,
      severity: 'error',
      message: g.kind === 'env' ? `\\begin{${g.name}} has no matching \\end` : 'This { is never closed'
    })
  }
  return out
}

export const latexLinter: Extension = linter((view) => checkLatex(view.state.doc.toString()), { delay: 700 })

// ------------------------------------------------- compile-log markers

class LogMarker extends GutterMarker {
  constructor(
    readonly level: 'error' | 'warning' | 'typesetting',
    readonly text: string
  ) {
    super()
  }
  override eq(other: LogMarker): boolean {
    return other.level === this.level && other.text === this.text
  }
  override toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = `cm-log-marker ${this.level}`
    el.title = this.text
    return el
  }
}

const setLogMarkers = StateEffect.define<{ markers: RangeSet<GutterMarker>; lines: DecorationSet }>()

const logField = StateField.define<{ markers: RangeSet<GutterMarker>; lines: DecorationSet }>({
  create: () => ({ markers: RangeSet.empty, lines: Decoration.none }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLogMarkers)) return e.value
    if (!tr.docChanged) return value
    return { markers: value.markers.map(tr.changes), lines: value.lines.map(tr.changes) }
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.lines)
})

export const logGutter: Extension = [
  logField,
  gutter({
    class: 'cm-log-gutter',
    markers: (view) => view.state.field(logField).markers
  })
]

const RANK = { error: 3, warning: 2, typesetting: 1, info: 0 } as const
const errorLine = Decoration.line({ class: 'cm-log-line-error' })

/** Shows the compile results that belong to `path` next to their lines. */
export function applyLogEntries(view: EditorView, entries: LogEntry[], path: string): void {
  const doc = view.state.doc
  const byLine = new Map<number, { level: 'error' | 'warning' | 'typesetting'; messages: string[] }>()
  for (const e of entries) {
    if (e.file !== path || !e.line || e.line < 1 || e.line > doc.lines || e.level === 'info') continue
    const slot = byLine.get(e.line)
    if (!slot) byLine.set(e.line, { level: e.level, messages: [e.message] })
    else {
      if (RANK[e.level] > RANK[slot.level]) slot.level = e.level
      if (slot.messages.length < 6) slot.messages.push(e.message)
    }
  }
  const markers = new RangeSetBuilder<GutterMarker>()
  const lines = new RangeSetBuilder<Decoration>()
  for (const lineNo of [...byLine.keys()].sort((a, b) => a - b)) {
    const slot = byLine.get(lineNo)
    if (!slot) continue
    const from = doc.line(lineNo).from
    markers.add(from, from, new LogMarker(slot.level, slot.messages.join('\n')))
    if (slot.level === 'error') lines.add(from, from, errorLine)
  }
  view.dispatch({ effects: setLogMarkers.of({ markers: markers.finish(), lines: lines.finish() }) })
}

// ------------------------------------------------------- spell checking

// Token kinds that are not prose; the browser's spell checker skips them.
const NOT_PROSE = new Set([
  'command', 'structure', 'envName', 'refKey', 'fileArg', 'math', 'mathCommand', 'mathDelim',
  'verbatim', 'special', 'keyword', 'propertyName', 'number'
])

const noSpell = Decoration.mark({ attributes: { spellcheck: 'false' } })

function proseDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (NOT_PROSE.has(node.name) && node.to > node.from) builder.add(node.from, node.to, noSpell)
      }
    })
  }
  return builder.finish()
}

/** Enables native spell checking for prose while leaving commands and maths alone. */
export const spellCheck: Extension = [
  EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'off', autocapitalize: 'off' }),
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = proseDecorations(view)
      }
      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
          this.decorations = proseDecorations(update.view)
        }
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
]

export const noSpellCheck: Extension = EditorView.contentAttributes.of({ spellcheck: 'false' })

// ---------------------------------------------------------- line flash

const flashEffect = StateEffect.define<number | null>()
const flashLine = Decoration.line({ class: 'cm-sync-flash' })

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        return e.value === null ? Decoration.none : Decoration.set([flashLine.range(e.value)])
      }
    }
    return tr.docChanged ? value.map(tr.changes) : value
  },
  provide: (field) => EditorView.decorations.from(field)
})

export const lineFlash: Extension = flashField

/** Briefly highlights the line at `pos` (after jumping there from the PDF or the logs). */
export function flashLineAt(view: EditorView, pos: number): void {
  const from = view.state.doc.lineAt(pos).from
  view.dispatch({ effects: flashEffect.of(from) })
  window.setTimeout(() => {
    if (!view.dom.isConnected) return
    view.dispatch({ effects: flashEffect.of(null) })
  }, 1300)
}
