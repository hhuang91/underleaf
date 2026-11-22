import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { countWordsInTex, parseBibEntries, ProjectAnalyzer, scanTex } from '../../src/main/analysis'
import { envWithPath, runProcess } from '../../src/main/compile/proc'
import { defaultSettings, SettingsStore } from '../../src/main/settings'
import { blankMainTex, encodePng, escapeLatex, exampleFigurePng, writeTemplate } from '../../src/main/templates'

describe('project analysis', () => {
  it('finds labels, macros and environments, ignoring comments', () => {
    const tex = String.raw`
\newcommand{\R}{\mathbb{R}}
\renewcommand\vec[1]{\mathbf{#1}}
\DeclareMathOperator{\argmax}{arg\,max}
\newtheorem{lemma}{Lemma}
\newenvironment{proofsketch}{}{}
\section{Intro}\label{sec:intro}
% \label{sec:commented}
\begin{equation}\label{eq:one}\end{equation}
`
    const sym = scanTex(tex)
    expect(sym.labels.sort()).toEqual(['eq:one', 'sec:intro'])
    expect(sym.commands.sort()).toEqual(['R', 'argmax', 'vec'])
    expect(sym.environments.sort()).toEqual(['lemma', 'proofsketch'])
  })

  it('reads BibTeX entries', () => {
    const bib = `@string{aw = "Addison-Wesley"}
@book{knuth1984,
  author = {Donald E. Knuth},
  title  = {The {\\TeX}book},
  year   = 1984
}
@Article{shannon1948, author = "Claude E. Shannon", title = "A Mathematical Theory of Communication", year = {1948}}
@comment{ignored, x}
`
    const entries = parseBibEntries(bib, 'refs.bib')
    expect(entries.map((e) => e.key)).toEqual(['knuth1984', 'shannon1948'])
    expect(entries[0]).toMatchObject({ type: 'book', author: 'Donald E. Knuth', title: 'The book', year: '1984' })
    expect(entries[1]).toMatchObject({ type: 'article', title: 'A Mathematical Theory of Communication', year: '1948' })
  })

  it('indexes a project and counts words across included files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'underleaf-analysis-'))
    try {
      await fs.mkdir(path.join(dir, 'sections'))
      await fs.writeFile(
        path.join(dir, 'main.tex'),
        String.raw`\documentclass{article}
\title{Ignored preamble words here}
\begin{document}
\section{First heading}
One two three \cite{knuth1984} four. % five six
Inline $x^2$ maths and \textbf{bold words}.
\begin{equation} E = mc^2 \end{equation}
\input{sections/more}
\end{document}
Trailing text is not counted.
`
      )
      await fs.writeFile(path.join(dir, 'sections', 'more.tex'), 'Seven eight\\label{sec:more} nine.\n')
      await fs.writeFile(path.join(dir, 'refs.bib'), '@book{knuth1984, title={T}}')

      const analyzer = new ProjectAnalyzer()
      const index = await analyzer.index(dir)
      expect(index.labels).toEqual([{ name: 'sec:more', file: 'sections/more.tex' }])
      expect(index.bibEntries.map((b) => b.key)).toEqual(['knuth1984'])

      const count = await analyzer.wordCount(dir, 'main.tex')
      // First heading | One two three four | Inline maths and bold words | Seven eight nine
      expect(count).toEqual({ words: 14, headers: 1, mathInline: 1, mathDisplay: 1, files: 2 })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('counts display maths in all its spellings', () => {
    const c = countWordsInTex(String.raw`Text \[ a \] and $$ b $$ and \( c \) plus $d$ end \href{http://x.org}{link text}.`)
    expect(c.mathDisplay).toBe(2)
    expect(c.mathInline).toBe(2)
    expect(c.words).toBe(7) // Text and and plus end link text
  })
})

describe('settings store', () => {
  it('fills in defaults and ignores invalid values', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'underleaf-settings-'))
    try {
      const file = path.join(dir, 'settings.json')
      await fs.writeFile(
        file,
        JSON.stringify({
          engineBackend: 'banana',
          autoCompile: 'yes',
          editor: { fontSize: 400, theme: 'dracula', keybindings: 'vim', unknown: 1 },
          layout: { editorRatio: 5, view: 'pdf' },
          externalProjects: ['/a', 7],
          lastOpenFile: { '/a': 'main.tex', '/b': 3 },
          windowBounds: { width: 800, height: 600, maximized: true },
          extra: true
        })
      )
      const defaults = defaultSettings(path.join(dir, 'Library'))
      const store = await SettingsStore.load(file, defaults)
      const s = store.get()
      expect(s.engineBackend).toBe('auto')
      expect(s.autoCompile).toBe(false)
      expect(s.editor).toMatchObject({ fontSize: 32, theme: 'dracula', keybindings: 'vim', autoComplete: true })
      expect(s.editor).not.toHaveProperty('unknown')
      expect(s.layout).toMatchObject({ editorRatio: 0.85, view: 'pdf' })
      expect(s.externalProjects).toEqual(['/a'])
      expect(s.lastOpenFile).toEqual({ '/a': 'main.tex' })
      expect(s.windowBounds).toMatchObject({ width: 800, height: 600, maximized: true })
      expect(s).not.toHaveProperty('extra')
      expect(s.libraryPath).toBe(defaults.libraryPath)

      await store.update({ editor: { fontSize: 15 }, lastOpenFile: { '/c': 'x.tex' } })
      const reloaded = await SettingsStore.load(file, defaults)
      expect(reloaded.get().editor.fontSize).toBe(15)
      expect(reloaded.get().editor.theme).toBe('dracula')
      expect(reloaded.get().lastOpenFile).toEqual({ '/a': 'main.tex', '/c': 'x.tex' })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('starts from defaults when the file is missing or corrupt', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'underleaf-settings-'))
    try {
      const file = path.join(dir, 'settings.json')
      const defaults = defaultSettings('/library')
      expect((await SettingsStore.load(file, defaults)).get()).toEqual(defaults)
      await fs.writeFile(file, '{ not json')
      expect((await SettingsStore.load(file, defaults)).get()).toEqual(defaults)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('templates', () => {
  it('escapes project names for LaTeX', () => {
    expect(escapeLatex('R&D: 100% #1_draft {v2}')).toBe('R\\&D: 100\\% \\#1\\_draft \\{v2\\}')
    expect(blankMainTex('A_B', new Date(2026, 10, 20))).toContain('\\title{A\\_B}')
    expect(blankMainTex('X', new Date(2026, 10, 20))).toContain('\\date{November 2026}')
  })

  it('writes an example project that only refers to things it contains', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'underleaf-template-'))
    try {
      await writeTemplate(dir, 'example', 'R&D notes')
      const tex = await fs.readFile(path.join(dir, 'main.tex'), 'utf8')
      expect(tex).toContain('\\title{R\\&D notes}')

      const all = (pattern: RegExp): string[] =>
        [...tex.matchAll(pattern)].flatMap((m) => m[1].split(',').map((s) => s.trim()))

      // Every reference has its label, and the other way round.
      const labels = scanTex(tex).labels.sort()
      expect(labels).toEqual(['eq:damped', 'fig:wave', 'tab:engines'])
      expect([...new Set(all(/\\(?:eq)?ref\{([^}]+)\}/g))].sort()).toEqual(labels)

      // Every citation is in the bibliography file the document names.
      const bibFile = `${all(/\\bibliography\{([^}]+)\}/g)[0]}.bib`
      const keys = parseBibEntries(await fs.readFile(path.join(dir, bibFile), 'utf8'), bibFile).map((e) => e.key)
      expect([...new Set(all(/\\cite\{([^}]+)\}/g))].sort()).toEqual([...keys].sort())

      // Every picture exists.
      const pictures = all(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)
      expect(pictures).toEqual(['figures/wave.png'])
      for (const picture of pictures) expect((await fs.stat(path.join(dir, picture))).size).toBeGreaterThan(2000)

      // \verb cannot be used inside the argument of another command.
      expect(tex).not.toMatch(/\\(?:caption|section|textbf|emph|texttt)\{[^}]*\\verb/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('produces a valid PNG for the example figure', () => {
    const png = exampleFigurePng()
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(png.readUInt32BE(16)).toBe(720) // width
    expect(png.readUInt32BE(20)).toBe(400) // height
    expect(png.length).toBeGreaterThan(2000)

    // Decode a tiny image by hand to check the encoder (filter byte + RGB per row).
    const tiny = encodePng(2, 1, new Uint8Array([255, 0, 0, 0, 0, 255]))
    const idatLength = tiny.readUInt32BE(33)
    const raw = zlib.inflateSync(tiny.subarray(41, 41 + idatLength))
    expect([...raw]).toEqual([0, 255, 0, 0, 0, 0, 255])
  })
})

describe('third-party licences', () => {
  it('gathers a licence text for everything that is compiled into the app', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'underleaf-licences-'))
    try {
      const out = path.join(dir, 'licences.txt')
      const script = path.resolve(__dirname, '../../scripts/collect-licenses.mjs')
      // The script fails when a package comes without a licence text that it
      // cannot supply itself, which needs a look by a person.
      const report = execFileSync(process.execPath, [script, '--out', out], { encoding: 'utf8' })
      expect(report).toMatch(/^Licences of \d+ packages/)

      const text = await fs.readFile(out, 'utf8')
      // Every package section holds a licence text (some bring none; a standard one is used).
      const sections = text.split(/^-{78}\n(?=\S+ \d+\.\d+)/m).slice(1)
      expect(sections.length).toBeGreaterThan(20)
      for (const section of sections.filter((s) => /^Licence: /m.test(s))) {
        expect(section.length, section.split('\n')[0]).toBeGreaterThan(400)
      }
      expect(text).toMatch(/^clean-git-ref \d[\s\S]{0,400}contains no licence file[\s\S]{0,300}Copyright Eli White/m)
      const listed = (name: string): boolean =>
        new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} \\d+\\.\\d+\\.\\d+`, 'm').test(text)

      // Libraries the app imports, directly or through another library ...
      for (const name of ['react', 'react-dom', 'scheduler', 'zustand', 'pdfjs-dist', '@codemirror/view', '@codemirror/merge', '@lezer/common', 'yauzl', 'yazl', '@mdi/js', 'isomorphic-git', 'ignore', 'pako']) {
        expect(listed(name), name).toBe(true)
      }
      // ... but not the tools that build and test it.
      for (const name of ['vite', 'vitest', 'typescript', 'electron-builder', 'playwright', '@types/node']) {
        expect(listed(name), name).toBe(false)
      }

      expect(text).toMatch(/^Tectonic \d+\.\d+\.\d+$/m)
      expect(text).toContain('Permission is hereby granted, free of charge') // MIT
      expect(text).toMatch(/Apache License\s+Version 2\.0, January 2004/)
      expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1')
      expect(text).toMatch(/GNU GENERAL PUBLIC LICENSE\s+Version 2, June 1991/)
      // The resources PDF.js loads at runtime come with licences of their own.
      for (const file of ['cmaps/LICENSE', 'standard_fonts/LICENSE_FOXIT', 'standard_fonts/LICENSE_LIBERATION', 'wasm/LICENSE_OPENJPEG']) {
        expect(text).toContain(`[${file}]`)
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('process helpers', () => {
  it('prepends to PATH without creating a second, differently-cased key', () => {
    expect(envWithPath({ Path: 'C:\\Windows' }, 'C:\\tex')).toEqual({ Path: `C:\\tex${path.delimiter}C:\\Windows` })
    expect(envWithPath({ HOME: '/h' }, '/tex')).toEqual({ HOME: '/h', PATH: '/tex' })
    expect(envWithPath({ PATH: '/bin' }, null)).toEqual({ PATH: '/bin' })
  })

  it('runs a script, captures its output and reports the exit code', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'underleaf-proc-'))
    try {
      const script = path.join(dir, 'tool.mjs')
      await fs.writeFile(script, 'console.log("out " + process.argv[2]); console.error("err"); process.exit(3)')
      const lines: string[] = []
      const result = await runProcess(script, ['arg'], { cwd: dir, onLine: (l) => lines.push(l) })
      expect(result.code).toBe(3)
      expect(result.spawnError).toBeNull()
      expect(result.output).toContain('out arg')
      expect(lines.sort()).toEqual(['err', 'out arg'])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('times out and kills a hanging process', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'underleaf-proc-'))
    try {
      const script = path.join(dir, 'hang.mjs')
      await fs.writeFile(script, 'setInterval(() => {}, 1000)')
      const started = Date.now()
      const result = await runProcess(script, [], { cwd: dir, timeoutMs: 400 })
      expect(result.timedOut).toBe(true)
      expect(Date.now() - started).toBeLessThan(8000)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('reports a missing executable instead of throwing', async () => {
    const result = await runProcess(path.join(os.tmpdir(), 'definitely-not-here.exe'), [], { cwd: os.tmpdir() })
    expect(result.code).toBeNull()
    expect(result.spawnError).toBeTruthy()
  })
})
