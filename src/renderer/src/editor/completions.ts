// Autocompletion for LaTeX: commands, environments, labels, citation keys,
// file names, packages and document classes.

import {
  snippet,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import type { ProjectIndex } from '@shared/types'
import { extensionOf } from '@shared/fileTypes'
import { BIB_STYLES, COMMANDS, DOCUMENT_CLASSES, ENVIRONMENT_ARGS, ENVIRONMENTS, PACKAGES } from './latexData'

interface CompletionData {
  index: ProjectIndex
  /** All project file paths (POSIX, relative to the project root). */
  files: string[]
}

let data: CompletionData = {
  index: { labels: [], bibEntries: [], commands: [], environments: [] },
  files: []
}

export function setCompletionData(next: Partial<CompletionData>): void {
  data = { ...data, ...next }
}

const REF_COMMAND = /^(ref|eqref|pageref|autoref|nameref|cref|Cref|crefrange|vref|autopageref|hyperref)$/
const CITE_COMMAND = /^([a-zA-Z]*cite[a-zA-Z]*|nocite)$/
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'pdf', 'eps', 'svg', 'gif'])

function environmentTemplate(name: string): string {
  const args = ENVIRONMENT_ARGS[name] ?? ''
  const body = (ENVIRONMENTS[name] ?? '${}').replace(/\n/g, '\n\t')
  return `\\begin{${name}}${args}\n\t${body}\n\\end{${name}}`
}

// Built once: the static part of the command list.
const STATIC_COMMANDS: Completion[] = [
  ...COMMANDS.map(([name, args]) =>
    snippetCompletion(`\\${name}${args}`, {
      label: `\\${name}${args.replace(/\$\{[^}]*\}/g, '').replace(/\\linewidth/, '')}`.trimEnd(),
      type: args ? 'function' : 'constant',
      boost: name.length <= 4 ? 1 : 0
    })
  ),
  snippetCompletion('\\begin{${env}}\n\t${}\n\\end{${env}}', { label: '\\begin{}', type: 'keyword', boost: 3 }),
  snippetCompletion('\\end{${env}}', { label: '\\end{}', type: 'keyword' }),
  ...Object.keys(ENVIRONMENTS).map((name) =>
    snippetCompletion(environmentTemplate(name), {
      label: `\\begin{${name}}`,
      type: 'keyword',
      boost: 2
    })
  )
]

const STATIC_COMMAND_LABELS = new Set(COMMANDS.map(([name]) => name))

function commandOptions(): Completion[] {
  const own = data.index.commands
    .filter((name) => !STATIC_COMMAND_LABELS.has(name))
    .map((name): Completion => ({ label: `\\${name}`, type: 'variable', detail: 'project', boost: 1 }))
  const ownEnvs = data.index.environments
    .filter((name) => !(name in ENVIRONMENTS))
    .map((name) =>
      snippetCompletion(environmentTemplate(name), { label: `\\begin{${name}}`, type: 'keyword', detail: 'project', boost: 2 })
    )
  return own.length || ownEnvs.length ? [...STATIC_COMMANDS, ...own, ...ownEnvs] : STATIC_COMMANDS
}

/** Number of \begin{name} minus \end{name} in the text (comments ignored). */
export function unclosedCount(text: string, name: string): number {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const code = text.replace(/(^|[^\\])%.*$/gm, '$1')
  const begins = code.match(new RegExp(`\\\\begin\\s*\\{${esc}\\}`, 'g'))?.length ?? 0
  const ends = code.match(new RegExp(`\\\\end\\s*\\{${esc}\\}`, 'g'))?.length ?? 0
  return begins - ends
}

/** Innermost environment that is still open before `pos`. */
export function openEnvironment(text: string): string | null {
  const code = text.replace(/(^|[^\\])%.*$/gm, '$1')
  const re = /\\(begin|end)\s*\{([^{}]+)\}/g
  const stack: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    if (m[1] === 'begin') stack.push(m[2])
    else {
      const i = stack.lastIndexOf(m[2])
      if (i >= 0) stack.length = i
    }
  }
  return stack.length > 0 ? stack[stack.length - 1] : null
}

function environmentNameOptions(): Completion[] {
  const names = new Set([...Object.keys(ENVIRONMENTS), ...data.index.environments])
  return [...names].map((name): Completion => ({
    label: name,
    type: 'keyword',
    // Typing inside \begin{...}: finish the name and add the body and \end.
    apply: (view: EditorView, _c: Completion, from: number, to: number) => {
      const doc = view.state.doc
      const closesHere = doc.sliceString(to, to + 1) === '}'
      const end = closesHere ? to + 1 : to
      const text = doc.toString()
      // The \begin being edited already counts as one opening.
      const alreadyClosed = unclosedCount(text.slice(0, from) + name + '}' + text.slice(end), name) <= 0
      if (alreadyClosed) {
        view.dispatch({
          changes: { from, to: end, insert: `${name}}` },
          selection: { anchor: from + name.length + 1 },
          userEvent: 'input.complete'
        })
        return
      }
      const args = ENVIRONMENT_ARGS[name] ?? ''
      const body = (ENVIRONMENTS[name] ?? '${}').replace(/\n/g, '\n\t')
      snippet(`${name}}${args}\n\t${body}\n\\end{${name}}`)(view, null, from, end)
    }
  }))
}

function labelOptions(currentDoc: string): Completion[] {
  const seen = new Set<string>()
  const out: Completion[] = []
  const re = /\\label\s*\{([^{}]+)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(currentDoc))) {
    const name = m[1].trim()
    if (!seen.has(name)) {
      seen.add(name)
      out.push({ label: name, type: 'variable', boost: 1 })
    }
  }
  for (const l of data.index.labels) {
    if (seen.has(l.name)) continue
    seen.add(l.name)
    out.push({ label: l.name, type: 'variable', detail: l.file })
  }
  return out
}

function citeOptions(): Completion[] {
  const seen = new Set<string>()
  const out: Completion[] = []
  for (const b of data.index.bibEntries) {
    if (seen.has(b.key)) continue
    seen.add(b.key)
    const who = b.author ? b.author.split(/\s+and\s+/i)[0].split(',')[0].trim() : ''
    out.push({
      label: b.key,
      type: 'text',
      detail: [who, b.year].filter(Boolean).join(' '),
      info: b.title
    })
  }
  return out
}

function fileOptions(filter: (path: string, ext: string) => boolean, stripExt: boolean): Completion[] {
  return data.files
    .filter((p) => filter(p, extensionOf(p)))
    .map((p): Completion => ({
      label: stripExt ? p.replace(/\.[^./]+$/, '') : p,
      type: 'text'
    }))
}

const plain = (labels: readonly string[], type: string): Completion[] => labels.map((label) => ({ label, type }))

export function latexCompletionSource(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos)
  const before = line.text.slice(0, context.pos - line.from)
  if (/(^|[^\\])%/.test(before)) return null // inside a comment

  // ---- inside the {argument} of a command
  const arg = /\\([a-zA-Z@]+)\*?\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)$/.exec(before)
  if (arg) {
    const command = arg[1]
    const content = arg[2]
    const partial = content.slice(content.lastIndexOf(',') + 1).replace(/^\s+/, '')
    const from = context.pos - partial.length
    const result = (options: Completion[], validFor = /^[^{},\s]*$/): CompletionResult | null =>
      options.length > 0 ? { from, options, validFor } : null

    if (command === 'begin') return result(environmentNameOptions(), /^[\w*]*$/)
    if (command === 'end') {
      const open = openEnvironment(context.state.doc.sliceString(0, line.from + arg.index))
      const names = new Set([...(open ? [open] : []), ...Object.keys(ENVIRONMENTS), ...data.index.environments])
      return result(
        [...names].map((label): Completion => ({ label, type: 'keyword', boost: label === open ? 10 : 0 })),
        /^[\w*]*$/
      )
    }
    if (REF_COMMAND.test(command)) return result(labelOptions(context.state.doc.toString()))
    if (CITE_COMMAND.test(command)) return result(citeOptions())
    if (command === 'includegraphics' || command === 'includepdf') {
      return result(fileOptions((_p, ext) => IMAGE_EXTS.has(ext), false), /^[^{}]*$/)
    }
    if (command === 'input' || command === 'include' || command === 'subfile' || command === 'includeonly') {
      return result(fileOptions((_p, ext) => ext === 'tex', true), /^[^{}]*$/)
    }
    if (command === 'bibliography') return result(fileOptions((_p, ext) => ext === 'bib', true), /^[^{},]*$/)
    if (command === 'addbibresource') return result(fileOptions((_p, ext) => ext === 'bib', false), /^[^{}]*$/)
    if (command === 'usepackage' || command === 'RequirePackage') return result(plain(PACKAGES, 'namespace'))
    if (command === 'documentclass') return result(plain(DOCUMENT_CLASSES, 'class'))
    if (command === 'bibliographystyle') return result(plain(BIB_STYLES, 'text'))
    return null
  }

  // ---- a command name
  const cmd = /\\[a-zA-Z@]*$/.exec(before)
  if (cmd) {
    // "\\" is a line break, not the start of a command.
    const start = cmd.index
    if (start > 0 && before[start - 1] === '\\' && cmd[0] === '\\') return null
    return {
      from: line.from + start,
      options: commandOptions(),
      validFor: /^\\[a-zA-Z@]*$/
    }
  }
  return null
}
