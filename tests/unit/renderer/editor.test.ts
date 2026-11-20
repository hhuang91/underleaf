import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { openEnvironment, unclosedCount } from '../../../src/renderer/src/editor/completions'
import { checkLatex } from '../../../src/renderer/src/editor/extensions'
import { bibtexLanguage, latexLanguage } from '../../../src/renderer/src/editor/latexLanguage'
import { parseOutline, plainTitle } from '../../../src/renderer/src/editor/outline'

/** Tokenises `doc` and returns [text, token kind] pairs for the highlighted ranges. */
function tokens(doc: string, language = latexLanguage): Array<[string, string]> {
  const state = EditorState.create({ doc, extensions: [language] })
  const tree = ensureSyntaxTree(state, doc.length, 5000)
  if (!tree) throw new Error('parse timed out')
  const out: Array<[string, string]> = []
  tree.iterate({
    enter: (node) => {
      if (node.name !== 'Document' && node.to > node.from) out.push([doc.slice(node.from, node.to), node.name])
    }
  })
  return out
}

const kindOf = (doc: string, text: string, language = latexLanguage): string | undefined =>
  tokens(doc, language).find(([t]) => t === text)?.[1]

describe('LaTeX highlighting', () => {
  it('distinguishes commands, structure, environments and comments', () => {
    const doc = '\\documentclass[11pt]{article} % a comment\n\\begin{itemize}\n\\item \\textbf{x}\n\\end{itemize}'
    expect(kindOf(doc, '\\documentclass')).toBe('structure')
    expect(kindOf(doc, 'article')).toBe('fileArg')
    expect(kindOf(doc, '% a comment')).toBe('comment')
    expect(kindOf(doc, '\\begin')).toBe('structure')
    expect(kindOf(doc, 'itemize')).toBe('envName')
    expect(kindOf(doc, '\\textbf')).toBe('command')
    // The optional argument is ordinary text, not a file name.
    expect(kindOf(doc, '11pt')).toBeUndefined()
  })

  it('marks labels, citations and headings', () => {
    const doc = '\\section{Results}\\label{sec:res} see \\cite{knuth1984,lamport1994} and \\ref{fig:a}'
    expect(kindOf(doc, 'Results')).toBe('heading')
    expect(kindOf(doc, 'sec:res')).toBe('refKey')
    expect(kindOf(doc, 'knuth1984,lamport1994')).toBe('refKey')
    expect(kindOf(doc, 'fig:a')).toBe('refKey')
  })

  it('tracks inline, display and environment maths', () => {
    const doc = 'a $x^2$ b \\[ y \\] c\n\\begin{align*}\nz &= 1\n\\end{align*}\ntext'
    const t = tokens(doc)
    expect(t.filter(([, k]) => k === 'mathDelim').map(([s]) => s)).toEqual(['$', '$', '\\[', '\\]'])
    expect(kindOf(doc, 'x^2')).toBe('math')
    expect(kindOf(doc, 'z')).toBe('math')
    expect(kindOf(doc, 'align*')).toBe('envName')
    // After \end{align*} we are back in text mode.
    expect(kindOf(doc, 'text')).toBeUndefined()
  })

  it('does not treat \\$ as maths and recovers from a stray $ at a paragraph break', () => {
    expect(tokens('costs \\$5 and \\$6').some(([, k]) => k === 'math')).toBe(false)
    const doc = 'an unbalanced $ here\n\n\\section{Next}'
    expect(kindOf(doc, '\\section')).toBe('structure')
  })

  it('leaves verbatim content alone', () => {
    const doc = '\\begin{verbatim}\n\\notacommand $x$ %\n\\end{verbatim}\n\\emph{y}'
    expect(tokens(doc).some(([s, k]) => s.includes('\\notacommand') && k === 'verbatim')).toBe(true)
    expect(kindOf(doc, '\\emph')).toBe('command')
  })

  it('highlights BibTeX', () => {
    const doc = '@article{key1,\n  title = {A {B} C},\n  year = 1999,\n  note = "quoted"\n}\nstray'
    expect(kindOf(doc, '@article', bibtexLanguage)).toBe('keyword')
    expect(kindOf(doc, 'key1', bibtexLanguage)).toBe('refKey')
    expect(kindOf(doc, 'title', bibtexLanguage)).toBe('propertyName')
    expect(kindOf(doc, '1999', bibtexLanguage)).toBe('number')
    expect(kindOf(doc, '"quoted"', bibtexLanguage)).toBe('string')
  })
})

describe('outline', () => {
  it('lists headings with their level and line', () => {
    const text = [
      '\\documentclass{book}',
      '\\chapter{One}',
      'text \\section*{Starred \\emph{title}} more',
      '% \\section{Commented out}',
      '\\subsection[short]{Long $x^2$ title\\label{s}}',
      '50\\% done \\section{After percent}',
      '\\section{Spans',
      '  two lines}'
    ].join('\n')
    expect(parseOutline(text)).toEqual([
      { level: 1, title: 'One', line: 2 },
      { level: 2, title: 'Starred title', line: 3 },
      { level: 3, title: 'Long x^2 title', line: 5 },
      { level: 2, title: 'After percent', line: 6 },
      { level: 2, title: 'Spans two lines', line: 7 }
    ])
  })

  it('cleans titles', () => {
    expect(plainTitle('A~B \\textbf{C} \\\\ D')).toBe('A B C D')
    expect(plainTitle('')).toBe('')
  })
})

describe('environment bookkeeping', () => {
  it('counts unclosed environments, ignoring comments', () => {
    const text = '\\begin{itemize}\n\\begin{itemize}\n\\end{itemize}\n% \\end{itemize}\n'
    expect(unclosedCount(text, 'itemize')).toBe(1)
    expect(unclosedCount(text, 'enumerate')).toBe(0)
    expect(unclosedCount('\\begin{align*}', 'align*')).toBe(1)
  })

  it('finds the innermost open environment', () => {
    expect(openEnvironment('\\begin{document}\\begin{figure}\\begin{center}\\end{center}')).toBe('figure')
    expect(openEnvironment('\\begin{a}\\end{a}')).toBeNull()
  })
})

describe('syntax check', () => {
  const messages = (text: string): string[] => checkLatex(text).map((d) => d.message)

  it('accepts well-formed documents', () => {
    const text = [
      '\\documentclass{article}',
      // Unbalanced on purpose, as people write in preambles:
      '\\newcommand{\\be}{\\begin{equation}}',
      '\\newcommand{\\ee}{\\end{equation}}',
      '\\begin{document}',
      'Text with \\{escaped\\} braces, 100\\% sure, \\verb|{| and {grouped \\textbf{bold}}.',
      '% a comment with } and \\end{nothing}',
      '\\begin{verbatim}',
      '} \\end{itemize} {',
      '\\end{verbatim}',
      '\\begin{itemize}\\item x\\end{itemize}',
      '\\end{document}'
    ].join('\n')
    expect(messages(text)).toEqual([])
  })

  it('reports mismatched environments and braces', () => {
    expect(messages('\\begin{itemize}\n\\item x\n\\end{enumerate}')[0]).toMatch(/does not match \\begin\{itemize\}/)
    expect(messages('\\begin{figure}\ntext')).toEqual(['\\begin{figure} has no matching \\end'])
    expect(messages('text}')).toEqual(['Unexpected }'])
    expect(messages('\\textbf{bold')).toEqual(['This { is never closed'])
    expect(messages('\\end{center}')).toEqual(['\\end{center} has no matching \\begin'])
    expect(messages('\\begin{center}{oops\\end{center}')[0]).toMatch(/not closed before \\end\{center\}/)
  })

  it('points at the offending text', () => {
    const text = 'ab\\end{x}'
    const [d] = checkLatex(text)
    expect(text.slice(d.from, d.to)).toBe('\\end{x}')
  })
})
