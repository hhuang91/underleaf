import { describe, expect, it } from 'vitest'
import {
  countEntries,
  parseBibLog,
  parseEngineOutput,
  parseLatexLog,
  unwrapLog,
  type ParseContext
} from '../../src/main/compile/logParser'

// Resolves the way the compile manager does: only files of the project map to a path.
const PROJECT = new Set(['main.tex', 'sections/intro.tex', 'refs.bib'])
const ctx: ParseContext = {
  resolveFile(p) {
    const rel = p.replace(/\\/g, '/').replace(/^\.\//, '')
    return PROJECT.has(rel) ? rel : null
  }
}

const PDFLATEX_LOG = String.raw`This is pdfTeX, Version 3.141592653-2.6-1.40.26 (TeX Live 2025) (preloaded format=pdflatex)
 restricted \write18 enabled.
 file:line:error style messages enabled.
**main.tex
(./main.tex
LaTeX2e <2024-11-01> patch level 2
(/usr/local/texlive/2025/texmf-dist/tex/latex/base/article.cls
Document Class: article 2024/06/29 v1.4n Standard LaTeX document class
(/usr/local/texlive/2025/texmf-dist/tex/latex/base/size10.clo
File: size10.clo 2024/06/29 v1.4n Standard LaTeX file (size option)
)
\c@part=\count196
)
(./output.aux)
\openout1 = ` + '`' + String.raw`output.aux'.

LaTeX Font Info:    Checking defaults for OML/cmm/m/it on input line 5.
LaTeX Font Info:    ... okay on input line 5.
(./sections/intro.tex
./sections/intro.tex:3: Undefined control sequence.
l.3 Hello \foo
               world

LaTeX Warning: Reference ` + '`' + String.raw`fig:missing' on page 1 undefined on input line 7.

Overfull \hbox (15.2pt too wide) in paragraph at lines 9--10
[]\OT1/cmr/m/n/10 A very long line (with an unbalanced parenthesis

)

LaTeX Warning: Citation ` + '`' + String.raw`knuth' on page 1 undefined on input line 12.

Package hyperref Warning: Token not allowed in a PDF string (Unicode):
(hyperref)                removing ` + '`' + String.raw`math shift' on input line 14.

[1{/usr/local/texlive/2025/texmf-var/fonts/map/pdftex/updmap/pdftex.map}] (./output.aux)

LaTeX Warning: There were undefined references.

 )
Output written on output.pdf (1 page, 12345 bytes).
`

describe('parseLatexLog', () => {
  const entries = parseLatexLog(PDFLATEX_LOG, ctx)

  it('reads file:line errors and names the undefined command', () => {
    const errors = entries.filter((e) => e.level === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      file: 'sections/intro.tex',
      line: 3,
      message: 'Undefined control sequence: \\foo'
    })
    expect(errors[0].content).toContain('l.3 Hello \\foo')
  })

  it('attributes warnings to the file that was open at that point', () => {
    const ref = entries.find((e) => e.message.includes('fig:missing'))
    expect(ref).toMatchObject({ level: 'warning', file: 'sections/intro.tex', line: 7 })
  })

  it('is not confused by parentheses in overfull-box text', () => {
    const box = entries.find((e) => e.level === 'typesetting')
    expect(box).toMatchObject({ file: 'sections/intro.tex', line: 9 })
    // The ")" after the box closes intro.tex, so later warnings belong to main.tex.
    const cite = entries.find((e) => e.message.includes('knuth'))
    expect(cite).toMatchObject({ level: 'warning', file: 'main.tex', line: 12 })
  })

  it('joins continuation lines of package warnings', () => {
    const hyper = entries.find((e) => e.message.startsWith('Package hyperref'))
    expect(hyper?.message).toContain("removing `math shift' on input line 14.")
    expect(hyper).toMatchObject({ file: 'main.tex', line: 14 })
  })

  it('does not attribute messages to class or package files', () => {
    const log = String.raw`(./main.tex
(/usr/local/texlive/2025/texmf-dist/tex/latex/foo/foo.sty
LaTeX Warning: You have requested package ` + '`' + String.raw`foo', but the package provides ` + '`' + String.raw`bar' on input line 3.

)
)`
    const [warning] = parseLatexLog(log, ctx)
    expect(warning.file).toBeUndefined()
  })

  it('counts by level', () => {
    expect(countEntries(entries)).toEqual({ errors: 1, warnings: 4, typesetting: 1 })
  })
})

describe('classic "!" errors', () => {
  it('reports a missing package once, with the line from the emergency stop', () => {
    const log = String.raw`(./main.tex
! LaTeX Error: File ` + '`' + String.raw`nonexistent.sty' not found.

Type X to quit or <RETURN> to proceed,
or enter new name. (Default extension: sty)

Enter file name:
! Emergency stop.
<read *>

l.3 \usepackage
               {amsmath}^^M
!  ==> Fatal error occurred, no output PDF file produced!
`
    const entries = parseLatexLog(log, ctx)
    const messages = entries.map((e) => e.message)
    expect(messages[0]).toBe("LaTeX Error: File `nonexistent.sty' not found.")
    expect(messages).not.toContain('Emergency stop.')
    expect(messages).toContain('Fatal error: no output PDF file was produced')
    expect(entries[0]).toMatchObject({ level: 'error', file: 'main.tex', line: 3 })
  })

  it('joins package error continuation lines and finds the source line', () => {
    const log = String.raw`(./main.tex
! Package inputenc Error: Unicode character α (U+03B1)
(inputenc)                not set up for use with LaTeX.

See the inputenc package documentation for explanation.
Type  H <return>  for immediate help.
 ...

l.12 α

)`
    const [error] = parseLatexLog(log, ctx)
    expect(error.message).toBe('Package inputenc Error: Unicode character α (U+03B1) not set up for use with LaTeX.')
    expect(error).toMatchObject({ file: 'main.tex', line: 12 })
    expect(error.content).not.toContain('Type  H')
  })

  it('keeps a lone emergency stop', () => {
    const entries = parseLatexLog('(./main.tex\n! Emergency stop.\n\n)', ctx)
    expect(entries.map((e) => e.message)).toEqual(['Emergency stop.'])
  })

  it('understands bare file names as printed by Tectonic and MiKTeX', () => {
    const log = '(main.tex\n(sections/intro.tex\n\nLaTeX Warning: Label `a\' multiply defined.\n\n))'
    expect(parseLatexLog(log, ctx)[0]).toMatchObject({ file: 'sections/intro.tex' })
  })
})

describe('Tectonic logs', () => {
  it('reports a missing \\input file once instead of a hundred times', () => {
    // Excerpt of a real Tectonic 0.17 log: without a terminal, LaTeX's
    // "enter a new file name" prompt keeps failing until the error limit.
    const log = String.raw`(main.tex
LaTeX2e <2021-11-15> patch level 1
(article.cls
Document Class: article 2021/10/04 v1.4n Standard LaTeX document class
(size10.clo)) (main.aux)

! ! LaTeX Error: File ` + '`' + String.raw`no-such-file.tex' not found..
\@missingfileerror ...or: File ` + '`' + String.raw`#1.#2' not found.}

l.17 \input{no-such-file}

! Undefined control sequence.
\reserved@a ...xpand \@iinput {\@missingfile@area
                                                  \@missingfile@base .\@miss...
l.17 \input{no-such-file}

! Undefined control sequence.
\reserved@a ...issingfile@base .\@missingfile@ext
                                                  }}\reserved@a
l.17 \input{no-such-file}

! ! LaTeX Error: File ` + '`' + String.raw`.' not found..
\@missingfileerror ...or: File ` + '`' + String.raw`#1.#2' not found.}

l.17 \input{no-such-file}

(That makes 100 errors; please try again.)
No pages of output.
`
    const entries = parseLatexLog(log, ctx)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      level: 'error',
      file: 'main.tex',
      line: 17,
      message: "LaTeX Error: File `no-such-file.tex' not found."
    })
  })

  it('reports a missing package once, without the errors it drags along', () => {
    // Excerpt of a real Tectonic 0.17 log in "continue on errors" mode.
    const log = String.raw`(main.tex
LaTeX2e <2021-11-15> patch level 1
(article.cls
Document Class: article 2021/10/04 v1.4n Standard LaTeX document class
(size10.clo))

! ! LaTeX Error: File ` + '`' + String.raw`chessboard.sty' not found..
\@missingfileerror ...or: File ` + '`' + String.raw`#1.#2' not found.}

l.3 \begin
          {document}
This error message was generated by an \errmessage
command, so I can't give any explicit help.
Pretend that you're Hercule Poirot: Examine all clues,
and deduce the truth by order and method.

! Undefined control sequence.
<argument> @pkg-disable@\@currname
                                   .\@currext
l.3 \begin
          {document}
The control sequence at the end of the top line
of your error message was never \def'ed. If you have
misspelled it (e.g., ` + '`' + String.raw`\hobx'), type ` + '`' + String.raw`I' and the correct
spelling (e.g., ` + '`' + String.raw`I\hbox'). Otherwise just continue,
and I'll forget about whatever was undefined.

! Undefined control sequence.
<argument> \edef \@currpkg@reqd {\@currname
                                            .\@currext }\ifx \CurrentFile \C...
l.3 \begin
          {document}
The control sequence at the end of the top line
of your error message was never \def'ed.

! Undefined control sequence.
<argument> @currpath @currname
                               .@currext
l.3 \begin
          {document}

! Undefined control sequence.
<argument> .@currext

l.3 \begin
          {document}

! Undefined control sequence.
\reserved@a ...csname \csname @raw@opt@\@currname
                                                  .\@currext \endcsname \glo...
l.3 \begin
          {document}

! LaTeX Error: The package . failed to load.

See the LaTeX manual or LaTeX Companion for explanation.
Type  H <return>  for immediate help.
 ...

l.3 \begin
          {document}

! Undefined control sequence.
l.5 A real \mistake
                    further down.
[1] (main.aux) )
`
    const entries = parseLatexLog(log, ctx)
    expect(entries.map((e) => [e.message, e.file, e.line])).toEqual([
      ["LaTeX Error: File `chessboard.sty' not found.", 'main.tex', 3],
      ['Undefined control sequence: \\mistake', 'main.tex', 5]
    ])
  })

  it('names the command that is undefined, also inside a macro expansion', () => {
    const log = String.raw`(./main.tex
./main.tex:12: Undefined control sequence.
\mymacro ->Some text \notdefined
                                 and more
l.12 Call \mymacro
                   here.
)`
    const [error] = parseLatexLog(log, ctx)
    expect(error).toMatchObject({ message: 'Undefined control sequence: \\notdefined', file: 'main.tex', line: 12 })
  })

  it('reads classic errors with bare file names', () => {
    const log = String.raw`(main.tex (sections/intro.tex
! Undefined control sequence.
l.25 This line calls \notarealcommand
                                      here.
The control sequence at the end of the top line
of your error message was never \def'ed.

) [1] (main.aux) )
Output written on main.xdv (2 pages, 28960 bytes).
`
    expect(parseLatexLog(log, ctx)).toEqual([
      {
        level: 'error',
        source: 'latex',
        message: 'Undefined control sequence: \\notarealcommand',
        content: 'l.25 This line calls \\notarealcommand\n                                      here.',
        file: 'sections/intro.tex',
        line: 25
      }
    ])
  })
})

describe('unwrapLog', () => {
  it('rejoins lines that TeX broke at 79 columns', () => {
    const long = 'LaTeX Warning: Reference `a-very-long-label-name-that-keeps-going-and-going-and'
    expect(long).toHaveLength(79)
    const lines = unwrapLog(`${long}\n-more' on page 1 undefined on input line 5.\nnext`)
    expect(lines[0]).toBe(`${long}-more' on page 1 undefined on input line 5.`)
    expect(lines[1]).toBe('next')
  })

  it('leaves error context lines alone, which are cut off rather than wrapped', () => {
    const cut = '<argument> \\edef \\@currpkg@reqd {\\@currname .\\@currext }\\ifx \\CurrentFile \\C...'
    expect(cut).toHaveLength(79)
    expect(unwrapLog(`${cut}\nl.3 \\begin`)).toEqual([cut, 'l.3 \\begin'])
  })
})

describe('parseBibLog', () => {
  it('reads BibTeX warnings and errors', () => {
    const blg = [
      'This is BibTeX, Version 0.99d (TeX Live 2025)',
      'Database file #1: refs.bib',
      'Warning--I didn\'t find a database entry for "nobody2020"',
      "I was expecting a `,' or a `}'---line 12 of file refs.bib",
      ' : ',
      "I'm skipping whatever remains of this entry",
      'Warning--empty journal in knuth1984',
      "I couldn't open style file fancy.bst",
      '(There was 1 error message)'
    ].join('\n')
    const entries = parseBibLog(blg, ctx)
    expect(entries.map((e) => e.level)).toEqual(['warning', 'error', 'warning', 'error'])
    expect(entries[1]).toMatchObject({ file: 'refs.bib', line: 12 })
    expect(entries[3].message).toContain('fancy.bst')
  })

  it('reads Biber messages', () => {
    const blg = "[123] Utils.pm:411> WARN - I didn't find a database entry for 'x' (section 0)\n[124] Biber.pm:99> ERROR - Cannot find 'refs2.bib'!"
    expect(parseBibLog(blg, ctx).map((e) => e.level)).toEqual(['warning', 'error'])
  })
})

describe('parseEngineOutput', () => {
  const output = [
    'note: Running TeX ...',
    'error: main.tex:5: Undefined control sequence',
    'warning: main.tex:9: Overfull \\hbox (3.0pt too wide) in paragraph at lines 9--9',
    'error: halted on potentially-recoverable error as specified',
    'error: something bad happened inside XeTeX; its output follows:',
    'error: the XeTeX engine had an unrecoverable error',
    'warning: errors were issued by the TeX engine, but were ignored; use --print and/or --keep-logs for details.',
    'error: failed to open the default bundle'
  ].join('\n')

  it('reads console diagnostics and skips the engine\'s generic wrappers', () => {
    const entries = parseEngineOutput(output, ctx)
    expect(entries).toHaveLength(3)
    expect(entries[0]).toMatchObject({ level: 'error', file: 'main.tex', line: 5 })
    expect(entries[1].level).toBe('typesetting')
  })

  it('can keep only engine-level problems', () => {
    const entries = parseEngineOutput(output, ctx, true)
    expect(entries.map((e) => e.message)).toEqual(['failed to open the default bundle'])
  })
})
