// Opt-in integration test with the real Tectonic binary:
//
//   npm run fetch:tectonic
//   UNDERLEAF_TEST_REAL_ENGINE=1 npm test
//
// It is skipped by default because the first run downloads TeX packages
// (tens of megabytes) into Tectonic's cache.

import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CompileManager, type CompileRequest } from '../../src/main/compile'
import { writeTemplate } from '../../src/main/templates'

const osName = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
const binary = path.resolve(
  __dirname,
  '../../resources/bin',
  `${osName}-${process.arch}`,
  process.platform === 'win32' ? 'tectonic.exe' : 'tectonic'
)
const enabled = process.env.UNDERLEAF_TEST_REAL_ENGINE === '1' && existsSync(binary)
const verbose = process.env.UNDERLEAF_TEST_VERBOSE === '1'

describe.skipIf(!enabled)('real Tectonic engine', () => {
  let tmp: string
  let project: string
  let manager: CompileManager
  const notices: string[] = []

  const request = (overrides: Partial<CompileRequest> = {}): CompileRequest => ({
    projectDir: project,
    rootDoc: 'main.tex',
    compiler: 'pdflatex',
    backend: 'tectonic',
    texBinPath: '',
    stopOnFirstError: false,
    fromScratch: false,
    ...overrides
  })

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'underleaf-real-'))
    project = path.join(tmp, 'Example Project')
    await fs.mkdir(project)
    await writeTemplate(project, 'example', 'Example Project')
    manager = new CompileManager({
      cacheRoot: path.join(tmp, 'cache'),
      latexmkrc: null,
      findTectonic: async () => binary,
      onProgress: (_dir, line, sticky) => {
        if (sticky) notices.push(line)
        if (verbose) console.log(sticky ? `[notice] ${line}` : `  ${line}`)
      }
    })
  })

  afterAll(async () => {
    manager?.stopAll()
    if (tmp) await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  it('compiles the example project, with bibliography, to a PDF', async () => {
    const result = await manager.compile(request())
    if (verbose || result.status !== 'success') {
      console.log(JSON.stringify({ ...result, rawLog: result.rawLog.slice(-3000) }, null, 2))
    }
    expect(result.status).toBe('success')
    expect(result.hasPdf).toBe(true)
    expect(result.counts.errors).toBe(0)
    const pdf = await manager.readPdf(project)
    expect(pdf?.data.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf?.data.length).toBeGreaterThan(20_000)
    // Citations were resolved by the bibliography pass.
    expect(result.entries.filter((e) => /Citation .* undefined/.test(e.message))).toEqual([])
  }, 900_000)

  it('recompiles from the local cache without going online', async () => {
    notices.length = 0
    const started = Date.now()
    const result = await manager.compile(request())
    if (verbose) console.log(`cached recompile took ${Date.now() - started} ms`)
    expect(result.status).toBe('success')
    expect(notices).toEqual([])
  }, 300_000)

  it('maps between source lines and PDF positions', async () => {
    const source = await fs.readFile(path.join(project, 'main.tex'), 'utf8')
    const line = source.split('\n').findIndex((l) => l.includes('Everything in this project')) + 1
    const rects = await manager.syncToPdf(project, 'main.tex', line)
    if (verbose) console.log('forward', line, rects)
    expect(rects.length).toBeGreaterThan(0)
    expect(rects[0].page).toBe(1)
    expect(rects[0].width).toBeGreaterThan(100)

    const r = rects[0]
    const back = await manager.syncToSource(project, r.page, r.x + r.width / 2, r.y + r.height / 2)
    if (verbose) console.log('inverse', back)
    expect(back?.file).toBe('main.tex')
    expect(Math.abs((back?.line ?? 0) - line)).toBeLessThanOrEqual(3)
  }, 60_000)

  it('reports a LaTeX error with its file and line', async () => {
    const file = path.join(project, 'main.tex')
    const source = await fs.readFile(file, 'utf8')
    const lines = source.split('\n')
    const at = lines.findIndex((l) => l.startsWith('\\section{Introduction}'))
    lines.splice(at + 1, 0, 'This line calls \\notarealcommand here.')
    await fs.writeFile(file, lines.join('\n'))

    const result = await manager.compile(request())
    if (verbose || result.counts.errors !== 1) {
      console.log(JSON.stringify({ ...result, rawLog: result.rawLog.slice(-2500) }, null, 2))
    }
    expect(result.status).toBe('failure')
    const error = result.entries.find((e) => e.level === 'error')
    expect(error).toMatchObject({ file: 'main.tex', line: at + 2 })
    expect(error?.message).toContain('Undefined control sequence')
    // "Try to compile despite errors" still yields a PDF.
    expect(result.hasPdf).toBe(true)

    const strict = await manager.compile(request({ stopOnFirstError: true }))
    if (verbose) console.log(JSON.stringify({ ...strict, rawLog: strict.rawLog.slice(-1500) }, null, 2))
    expect(strict.status).toBe('failure')
    expect(strict.entries.some((e) => e.level === 'error' && e.line === at + 2)).toBe(true)

    await fs.writeFile(file, source)
  }, 300_000)

  it('reports an error in an included file under that file, also without ".tex" in \\input', async () => {
    const file = path.join(project, 'main.tex')
    const source = await fs.readFile(file, 'utf8')
    const chapter = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the chapter.`)
    chapter[29] = 'Line 30 calls \\notarealcommand here.'
    await fs.writeFile(path.join(project, 'chapter.tex'), `${chapter.join('\n')}\n`)
    await fs.writeFile(file, source.replace('\\section{Figures}', '\\input{chapter}\n\n\\section{Figures}'))
    try {
      const result = await manager.compile(request())
      if (verbose) console.log(JSON.stringify({ ...result, rawLog: result.rawLog.slice(-2500) }, null, 2))
      // One error, in the right file; the engine's console repeats it under
      // the name "chapter", which must not show up as further errors.
      const errors = result.entries.filter((e) => e.level === 'error')
      expect(errors.map((e) => [e.file, e.line, e.message])).toEqual([
        ['chapter.tex', 30, 'Undefined control sequence: \\notarealcommand']
      ])

      // SyncTeX knows the included file as well.
      const rects = await manager.syncToPdf(project, 'chapter.tex', 5)
      expect(rects.length).toBeGreaterThan(0)
      const r = rects[0]
      const back = await manager.syncToSource(project, r.page, r.x + r.width / 2, r.y + r.height / 2)
      expect(back?.file).toBe('chapter.tex')
    } finally {
      await fs.writeFile(file, source)
      await fs.rm(path.join(project, 'chapter.tex'), { force: true })
    }
  }, 300_000)

  it('reports a missing file without retrying forever', async () => {
    const file = path.join(project, 'main.tex')
    const source = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, source.replace('\\maketitle', '\\maketitle\n\\input{no-such-file}'))
    const result = await manager.compile(request())
    if (verbose) console.log(JSON.stringify({ ...result, rawLog: result.rawLog.slice(-1500) }, null, 2))
    expect(result.status).toBe('failure')
    const errors = result.entries.filter((e) => e.level === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ file: 'main.tex', message: "LaTeX Error: File `no-such-file.tex' not found." })
    await fs.writeFile(file, source)
  }, 300_000)

  it('fetches a package on demand when it is not in the cache', async () => {
    const file = path.join(project, 'main.tex')
    const source = await fs.readFile(file, 'utf8')
    await fs.writeFile(
      file,
      source
        .replace('\\usepackage{booktabs}', '\\usepackage{booktabs}\n\\usepackage{lipsum}')
        .replace('\\section{Introduction}', '\\section{Introduction}\n\\lipsum[1]')
    )
    const result = await manager.compile(request())
    if (verbose || result.status !== 'success') {
      console.log(JSON.stringify({ ...result, rawLog: result.rawLog.slice(-1500) }, null, 2))
    }
    expect(result.status).toBe('success')
    await fs.writeFile(file, source)
  }, 600_000)

  it('explains what is wrong when the first compile cannot reach the network', async () => {
    // An empty engine cache plus an unreachable proxy is what a first start
    // without internet access looks like.
    const saved = { ...process.env }
    const offline = new CompileManager({
      cacheRoot: path.join(tmp, 'offline-cache'),
      latexmkrc: null,
      findTectonic: async () => binary,
      onProgress: (_dir, line, sticky) => {
        if (verbose) console.log(sticky ? `[notice] ${line}` : `  ${line}`)
      }
    })
    try {
      process.env.TECTONIC_CACHE_DIR = path.join(tmp, 'empty-tectonic-cache')
      for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
        process.env[name] = 'http://127.0.0.1:9'
      }
      const result = await offline.compile(request())
      if (verbose || result.status !== 'failure') {
        console.log(JSON.stringify({ ...result, rawLog: result.rawLog.slice(-2500) }, null, 2))
      }
      expect(result.status).toBe('failure')
      expect(result.hasPdf).toBe(false)
      expect(result.entries[0]).toMatchObject({ level: 'error', source: 'engine' })
      expect(result.entries[0].message).toMatch(/could not download/)
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
      offline.stopAll()
    }
  }, 300_000)

  it('says so when a package is not cached yet and the network is unreachable', async () => {
    const saved = { ...process.env }
    const file = path.join(project, 'main.tex')
    const source = await fs.readFile(file, 'utf8')
    try {
      expect((await manager.compile(request())).status).toBe('success') // the engine cache is primed
      for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
        process.env[name] = 'http://127.0.0.1:9'
      }
      // A package that exists but that nothing here has downloaded so far.
      await fs.writeFile(file, source.replace('\\usepackage{booktabs}', '\\usepackage{booktabs}\n\\usepackage{chessboard}'))
      const result = await manager.compile(request())
      if (verbose || result.status !== 'failure') {
        console.log(JSON.stringify({ ...result, rawLog: result.rawLog.slice(-2500) }, null, 2))
      }
      expect(result.status).toBe('failure')
      // The engine reports a file it could not fetch exactly like one that does
      // not exist, and a missing package drags dozens of errors along. What the
      // user gets is one error, with advice that covers both causes.
      const errors = result.entries.filter((e) => e.level === 'error')
      expect(errors.map((e) => e.message)).toEqual(["LaTeX Error: File `chessboard.sty' not found."])
      expect(errors[0].hint).toMatch(/could not be fetched/)
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
      await fs.writeFile(file, source)
    }
  }, 300_000)

  it('still compiles without a network when only the engine’s own cache is left', async () => {
    // A new build folder (after deleting it, or after reinstalling the app)
    // while the engine's package cache still holds what the document needs.
    const saved = { ...process.env }
    const fresh = new CompileManager({
      cacheRoot: path.join(tmp, 'fresh-cache'),
      latexmkrc: null,
      findTectonic: async () => binary,
      onProgress: (_dir, line, sticky) => {
        if (verbose) console.log(sticky ? `[notice] ${line}` : `  ${line}`)
      }
    })
    try {
      for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
        process.env[name] = 'http://127.0.0.1:9'
      }
      const result = await fresh.compile(request())
      if (verbose || result.status !== 'success') {
        console.log(JSON.stringify({ ...result, rawLog: result.rawLog.slice(-2000) }, null, 2))
      }
      expect(result.status).toBe('success')
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
      fresh.stopAll()
    }
  }, 300_000)

  it('compiles a main document that lives in a sub-folder and uses root-relative paths', async () => {
    await fs.mkdir(path.join(project, 'paper'), { recursive: true })
    await fs.mkdir(path.join(project, 'shared'), { recursive: true })
    await fs.writeFile(path.join(project, 'shared', 'macros.tex'), '\\newcommand{\\projectname}{Underleaf}\n')
    await fs.writeFile(path.join(project, 'paper', 'local.tex'), 'Text from a file next to the main document.\n')
    await fs.writeFile(
      path.join(project, 'paper', 'thesis.tex'),
      [
        '\\documentclass{article}',
        '\\usepackage{graphicx}',
        '\\input{shared/macros}', // relative to the project root
        '\\begin{document}',
        'Hello from \\projectname.',
        '\\input{local}', // relative to the main document
        '\\includegraphics[width=3cm]{figures/wave.png}',
        '\\end{document}',
        ''
      ].join('\n')
    )
    const result = await manager.compile(request({ rootDoc: 'paper/thesis.tex' }))
    if (verbose || result.status !== 'success') {
      console.log(JSON.stringify({ ...result, rawLog: result.rawLog.slice(-2000) }, null, 2))
    }
    expect(result.status).toBe('success')
    const rects = await manager.syncToPdf(project, 'paper/thesis.tex', 5)
    expect(rects.length).toBeGreaterThan(0)
  }, 300_000)
})
