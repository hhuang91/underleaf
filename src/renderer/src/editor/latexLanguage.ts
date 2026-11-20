// Syntax highlighting for LaTeX and BibTeX, implemented as CodeMirror stream
// parsers. They are deliberately forgiving: half-typed documents are the norm.

import { StreamLanguage, type StreamParser, type StringStream } from '@codemirror/language'
import { Tag } from '@lezer/highlight'

export const latexTags = {
  command: Tag.define(),
  /** \begin, \end, \section, \documentclass, ... */
  structure: Tag.define(),
  envName: Tag.define(),
  /** Labels and citation keys. */
  refKey: Tag.define(),
  /** Package, class and file names. */
  fileArg: Tag.define(),
  heading: Tag.define(),
  math: Tag.define(),
  mathCommand: Tag.define(),
  mathDelim: Tag.define(),
  verbatim: Tag.define(),
  special: Tag.define()
}

type ArgKind = 'env' | 'key' | 'file' | 'heading'

interface LatexState {
  /** Closing delimiter of the current math mode, or 'env' for math environments. */
  math: null | '$' | '$$' | '\\)' | '\\]' | 'env'
  mathEnv: string | null
  /** Name of the verbatim-like environment being skipped. */
  verbatim: string | null
  /** The command just read expects a {argument} of this kind. */
  pending: ArgKind | null
  pendingIsBegin: boolean
  /** Brackets opened since the command while its {argument} is still pending. */
  optDepth: number
  /** Kind of the {argument} the parser is inside. */
  arg: ArgKind | null
  argDepth: number
  argText: string
}

const HEADINGS = new Set(['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'title'])

const STRUCTURE = new Set([
  'begin', 'end', 'documentclass', 'usepackage', 'RequirePackage', 'input', 'include', 'subfile',
  'bibliography', 'bibliographystyle', 'addbibresource', 'printbibliography', 'maketitle',
  'tableofcontents', 'listoffigures', 'listoftables', 'appendix', 'author', 'date', 'newcommand',
  'renewcommand', 'providecommand', 'newenvironment', 'renewenvironment', 'newtheorem', 'def',
  'DeclareMathOperator', ...HEADINGS
])

const FILE_COMMANDS = new Set([
  'documentclass', 'usepackage', 'RequirePackage', 'LoadClass', 'input', 'include', 'includeonly',
  'subfile', 'includegraphics', 'includepdf', 'bibliography', 'bibliographystyle', 'addbibresource',
  'usetikzlibrary', 'usepgfplotslibrary', 'graphicspath', 'lstinputlisting', 'inputminted'
])

const KEY_COMMAND = /^(label|ref|eqref|pageref|autoref|nameref|cref|Cref|crefrange|vref|autopageref|hyperref|bibitem|nocite|[a-zA-Z]*cite[a-zA-Z]*)$/

const MATH_ENVS = new Set([
  'equation', 'align', 'gather', 'multline', 'eqnarray', 'displaymath', 'math', 'flalign', 'alignat',
  'dmath', 'IEEEeqnarray'
])

const VERBATIM_ENVS = new Set([
  'verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted', 'comment', 'filecontents', 'filecontents*'
])

const ARG_STYLE: Record<ArgKind, string> = {
  env: 'envName',
  key: 'refKey',
  file: 'fileArg',
  heading: 'heading'
}

function textToken(stream: StringStream, state: LatexState): string | null {
  const ch = stream.peek()

  if (ch === '\\') {
    stream.next()
    if (stream.match(/^[a-zA-Z@]+\*?/)) {
      const name = stream.current().slice(1).replace(/\*$/, '')
      state.optDepth = 0
      if (name === 'begin' || name === 'end') {
        state.pending = 'env'
        state.pendingIsBegin = name === 'begin'
      } else if (HEADINGS.has(name)) {
        state.pending = 'heading'
      } else if (FILE_COMMANDS.has(name)) {
        state.pending = 'file'
      } else if (KEY_COMMAND.test(name)) {
        state.pending = 'key'
      } else {
        state.pending = null
      }
      return STRUCTURE.has(name) ? 'structure' : 'command'
    }
    const symbol = stream.next()
    state.pending = null
    if (symbol === '(') {
      state.math = '\\)'
      return 'mathDelim'
    }
    if (symbol === '[') {
      state.math = '\\]'
      return 'mathDelim'
    }
    return 'command'
  }

  if (ch === '$') {
    stream.next()
    state.math = stream.eat('$') ? '$$' : '$'
    state.pending = null
    return 'mathDelim'
  }

  if (ch === '{') {
    stream.next()
    if (state.arg) {
      state.argDepth++
    } else if (state.pending && state.optDepth === 0) {
      state.arg = state.pending
      state.pending = null
      state.argDepth = 1
      state.argText = ''
    }
    return 'bracket'
  }

  if (ch === '}') {
    stream.next()
    if (state.arg && --state.argDepth <= 0) {
      const kind = state.arg
      state.arg = null
      state.argDepth = 0
      if (kind === 'env' && state.pendingIsBegin) {
        const env = state.argText.trim()
        if (VERBATIM_ENVS.has(env)) {
          state.verbatim = env
        } else if (MATH_ENVS.has(env.replace(/\*$/, ''))) {
          state.math = 'env'
          state.mathEnv = env
        }
      }
    }
    return 'bracket'
  }

  if (ch === '[') {
    stream.next()
    if (state.pending) state.optDepth++
    return 'bracket'
  }

  if (ch === ']') {
    stream.next()
    if (state.pending && state.optDepth > 0) state.optDepth--
    return 'bracket'
  }

  if (state.arg) {
    stream.next()
    stream.eatWhile(/[^\\%{}$\s]/)
    if (state.arg === 'env') state.argText += stream.current()
    return ARG_STYLE[state.arg]
  }

  if (ch === '&' || ch === '~' || ch === '^' || ch === '_' || ch === '#') {
    stream.next()
    return 'special'
  }

  stream.next()
  stream.eatWhile(/[^\\%{}[\]$&~^_#\s]/)
  // Ordinary text after a command means the command took no {argument}.
  if (state.pending && state.optDepth === 0) state.pending = null
  return null
}

function mathToken(stream: StringStream, state: LatexState): string | null {
  const ch = stream.peek()

  if (ch === '\\') {
    if (state.math === '\\)' && stream.match('\\)')) {
      state.math = null
      return 'mathDelim'
    }
    if (state.math === '\\]' && stream.match('\\]')) {
      state.math = null
      return 'mathDelim'
    }
    if (state.math === 'env' && stream.match(`\\end{${state.mathEnv}}`, false)) {
      state.math = null
      state.mathEnv = null
      return textToken(stream, state)
    }
    stream.next()
    if (!stream.match(/^[a-zA-Z@]+\*?/)) stream.next()
    return 'mathCommand'
  }

  if (ch === '$') {
    if (state.math === '$$' && stream.match('$$')) {
      state.math = null
      return 'mathDelim'
    }
    stream.next()
    if (state.math === '$') {
      state.math = null
      return 'mathDelim'
    }
    return 'math'
  }

  if (ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === '(' || ch === ')') {
    stream.next()
    return 'bracket'
  }

  stream.next()
  stream.eatWhile(/[^\\$%{}[\]()\s]/)
  return 'math'
}

const latexParser: StreamParser<LatexState> = {
  name: 'latex',

  startState: () => ({
    math: null,
    mathEnv: null,
    verbatim: null,
    pending: null,
    pendingIsBegin: false,
    optDepth: 0,
    arg: null,
    argDepth: 0,
    argText: ''
  }),

  copyState: (state) => ({ ...state }),

  token(stream, state) {
    if (state.verbatim) {
      const closer = `\\end{${state.verbatim}}`
      if (stream.match(closer, false)) {
        state.verbatim = null
      } else {
        stream.next()
        while (!stream.eol() && !stream.match(closer, false)) stream.next()
        return 'verbatim'
      }
    }
    if (stream.eatSpace()) return null
    if (stream.peek() === '%') {
      stream.skipToEnd()
      return 'comment'
    }
    return state.math ? mathToken(stream, state) : textToken(stream, state)
  },

  blankLine(state) {
    // Inline math cannot span paragraphs; recover from an unbalanced "$".
    if (state.math === '$' || state.math === '\\)') state.math = null
    state.pending = null
    state.optDepth = 0
  },

  languageData: {
    commentTokens: { line: '%' },
    closeBrackets: { brackets: ['(', '[', '{', '$'] }
  },

  tokenTable: latexTags
}

export const latexLanguage = StreamLanguage.define(latexParser)

// ----------------------------------------------------------------- BibTeX

interface BibState {
  /** Brace depth inside an entry; 0 = between entries. */
  depth: number
  inEntry: boolean
  expectKey: boolean
  inQuote: boolean
}

const bibtexParser: StreamParser<BibState> = {
  name: 'bibtex',

  startState: () => ({ depth: 0, inEntry: false, expectKey: false, inQuote: false }),

  copyState: (state) => ({ ...state }),

  token(stream, state) {
    if (state.inQuote) {
      while (!stream.eol()) {
        const c = stream.next()
        if (c === '\\') stream.next()
        else if (c === '"') {
          state.inQuote = false
          break
        }
      }
      return 'string'
    }
    if (stream.eatSpace()) return null

    if (!state.inEntry) {
      if (stream.match(/^@[A-Za-z]+/)) {
        state.inEntry = true
        state.depth = 0
        return 'keyword'
      }
      if (stream.peek() === '%') {
        stream.skipToEnd()
        return 'comment'
      }
      stream.next()
      stream.eatWhile(/[^@%]/)
      return 'comment' // BibTeX ignores everything between entries
    }

    const ch = stream.next()
    if (ch === '{') {
      state.depth++
      if (state.depth === 1) state.expectKey = true
      return 'bracket'
    }
    if (ch === '}') {
      state.depth--
      if (state.depth <= 0) {
        state.depth = 0
        state.inEntry = false
      }
      return 'bracket'
    }
    if (state.depth >= 2) {
      stream.eatWhile(/[^{}]/)
      return 'string'
    }
    if (state.depth === 0) return null // between "@type" and its opening brace

    if (state.expectKey) {
      state.expectKey = false
      if (ch === ',') return null
      stream.eatWhile(/[^,\s{}]/)
      return 'refKey'
    }
    if (ch === '=') return 'operator'
    if (ch === '"') {
      state.inQuote = true
      return 'string'
    }
    if (ch && /\d/.test(ch)) {
      stream.eatWhile(/\d/)
      return 'number'
    }
    if (ch && /[A-Za-z]/.test(ch)) {
      stream.eatWhile(/[\w-]/)
      return 'propertyName'
    }
    return null
  },

  languageData: {
    commentTokens: { line: '%' },
    closeBrackets: { brackets: ['{', '"'] }
  },

  tokenTable: { refKey: latexTags.refKey }
}

export const bibtexLanguage = StreamLanguage.define(bibtexParser)
