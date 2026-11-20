// End-to-end test of the compile pipeline, using the fake engine from
// tests/fixtures so that it runs on machines without TeX.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CompileManager, rcFingerprint, type CompileRequest } from '../../src/main/compile'

const FAKE_ENGINE = path.resolve(__dirname, '../fixtures/fake-tectonic.mjs')

let tmp: string
let project: string
let cache: string
let progress: string[]
let manager: CompileManager

function request(overrides: Partial<CompileRequest> = {}): CompileRequest {
  return {
    projectDir: project,
    rootDoc: 'main.tex',
    compiler: 'pdflatex',
    backend: 'tectonic',
    texBinPath: '',
    stopOnFirstError: false,
    fromScratch: false,
    ...overrides
  }
}

const doc = (body: string, preamble = ''): string =>
  `\\documentclass{article}\n${preamble}\\begin{document}\n${body}\n\\end{document}\n`

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'underleaf-compile-'))
  project = path.join(tmp, 'My Project')
  cache = path.join(tmp, 'cache')
  await fs.mkdir(path.join(project, 'sections'), { recursive: true })
  progress = []
  manager = new CompileManager({
    cacheRoot: cache,
    latexmkrc: null,
    findTectonic: async () => FAKE_ENGINE,
    onProgress: (_dir, line) => progress.push(line)
  })
})

afterEach(async () => {
  manager.stopAll()
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('CompileManager with the built-in engine', () => {
  it('compiles, reports success and serves the PDF', async () => {
    await fs.writeFile(path.join(project, 'main.tex'), doc('Hello world\n\\input{sections/intro}'))
    await fs.writeFile(path.join(project, 'sections', 'intro.tex'), 'An introduction.\n')

    const result = await manager.compile(request())
    expect(result.status).toBe('success')
    expect(result.hasPdf).toBe(true)
    expect(result.counts).toEqual({ errors: 0, warnings: 0, typesetting: 0 })
    expect(result.engine?.backend).toBe('tectonic')
    expect(result.rawLog).toContain('Output written on main.pdf')

    const pdf = await manager.readPdf(project)
    expect(pdf?.data.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf?.version).toBe(result.pdfVersion)

    // Nothing was written into the project folder itself.
    expect((await fs.readdir(project)).sort()).toEqual(['main.tex', 'sections'])
    expect(progress.length).toBeGreaterThan(0)
  })

  it('reports errors with file and line, and still shows the PDF when it can', async () => {
    await fs.writeFile(path.join(project, 'main.tex'), doc('Fine line\n\\input{sections/intro}\nSee \\ref{missing}'))
    await fs.writeFile(path.join(project, 'sections', 'intro.tex'), 'Good\nThis is \\badcommand here\n')

    const result = await manager.compile(request())
    expect(result.status).toBe('failure')
    expect(result.hasPdf).toBe(true)
    expect(result.counts.errors).toBe(1)
    const error = result.entries.find((e) => e.level === 'error')
    expect(error).toMatchObject({ file: 'sections/intro.tex', line: 2 })
    expect(error?.message).toContain('Undefined control sequence')
    const warning = result.entries.find((e) => e.level === 'warning')
    expect(warning).toMatchObject({ file: 'main.tex', line: 5 })
  })

  it('stops at the first error when asked, and never passes off an old PDF as new', async () => {
    await fs.writeFile(path.join(project, 'main.tex'), doc('All good'))
    expect((await manager.compile(request())).status).toBe('success')

    await fs.writeFile(path.join(project, 'main.tex'), doc('Now \\badcommand'))
    const result = await manager.compile(request({ stopOnFirstError: true }))
    expect(result.status).toBe('failure')
    expect(result.hasPdf).toBe(false)
    expect(result.entries.some((e) => e.message.includes('no output PDF'))).toBe(true)
    // The PDF of the last good run is still there for the viewer to keep showing.
    expect(await manager.readPdf(project)).not.toBeNull()
  })

  it('goes online only when the cache is missing something', async () => {
    await fs.writeFile(path.join(project, 'main.tex'), doc('Text'))
    await manager.compile(request()) // first run primes the cache (online)
    expect(await fs.readdir(cache)).toContain('tectonic-primed')

    // Needs a "download": fails with --only-cached, succeeds on the online retry.
    await fs.writeFile(path.join(project, 'main.tex'), doc('Text', '\\usepackage{notcached}\n'))
    progress.length = 0
    const result = await manager.compile(request())
    expect(result.status).toBe('success')
    expect(progress.some((l) => l.includes('Downloading'))).toBe(true)

    // A genuine mistake is confirmed online once, then never retried again.
    await fs.writeFile(path.join(project, 'main.tex'), doc('\\input{does-not-exist}'))
    progress.length = 0
    const first = await manager.compile(request({ stopOnFirstError: true }))
    expect(first.status).toBe('failure')
    expect(progress.some((l) => l.includes('Downloading'))).toBe(true)
    progress.length = 0
    const second = await manager.compile(request({ stopOnFirstError: true }))
    expect(second.status).toBe('failure')
    expect(progress.some((l) => l.includes('Downloading'))).toBe(false)
  })

  it('does not wait for a download when the computer is offline, and says so', async () => {
    let online = true
    const m = new CompileManager({
      cacheRoot: cache,
      latexmkrc: null,
      findTectonic: async () => FAKE_ENGINE,
      onProgress: (_dir, line) => progress.push(line),
      isOnline: () => online
    })
    await fs.writeFile(path.join(project, 'main.tex'), doc('Text'))
    await m.compile(request())

    await fs.writeFile(path.join(project, 'main.tex'), doc('Text', '\\usepackage{notcached}\n'))
    online = false
    progress.length = 0
    const offline = await m.compile(request({ stopOnFirstError: true }))
    expect(offline.status).toBe('failure')
    expect(progress.some((l) => l.includes('Downloading'))).toBe(false)
    const error = offline.entries.find((e) => e.level === 'error')
    expect(error?.message).toContain("notcached.sty' not found")
    expect(error?.hint).toMatch(/appear to be offline/)

    // Back online, the very next compile fetches the package.
    online = true
    expect((await m.compile(request({ stopOnFirstError: true }))).status).toBe('success')
  })

  it('tries a failed download again after starting from scratch', async () => {
    await fs.writeFile(path.join(project, 'main.tex'), doc('Text'))
    await manager.compile(request())
    await fs.writeFile(path.join(project, 'main.tex'), doc('\\input{does-not-exist}'))
    const first = await manager.compile(request({ stopOnFirstError: true }))
    // The advice fits the kind of file: this one is not a package.
    expect(first.entries.find((e) => e.level === 'error')?.hint).toMatch(/name and the location of the file/)

    progress.length = 0
    await manager.compile(request({ stopOnFirstError: true }))
    expect(progress.some((l) => l.includes('Downloading'))).toBe(false)

    progress.length = 0
    await manager.compile(request({ stopOnFirstError: true, fromScratch: true }))
    expect(progress.some((l) => l.includes('Downloading'))).toBe(true)
  })

  it('supports a main document in a sub-folder', async () => {
    await fs.mkdir(path.join(project, 'paper'))
    await fs.writeFile(path.join(project, 'paper', 'thesis.tex'), doc('Deep \\badcommand'))
    const result = await manager.compile(request({ rootDoc: 'paper/thesis.tex' }))
    expect(result.hasPdf).toBe(true)
    expect(result.entries.find((e) => e.level === 'error')).toMatchObject({ file: 'paper/thesis.tex', line: 3 })
  })

  it('explains what is wrong when there is nothing to compile', async () => {
    const none = await manager.compile(request({ rootDoc: null }))
    expect(none.status).toBe('failure')
    expect(none.entries[0].message).toMatch(/No main document/)

    const gone = await manager.compile(request({ rootDoc: 'missing.tex' }))
    expect(gone.entries[0].message).toMatch(/does not exist/)
  })

  it('reports a missing engine', async () => {
    const without = new CompileManager({
      cacheRoot: cache,
      latexmkrc: null,
      findTectonic: async () => null,
      onProgress: () => undefined
    })
    await fs.writeFile(path.join(project, 'main.tex'), doc('x'))
    const result = await without.compile(request())
    expect(result.status).toBe('no-engine')
    expect(result.entries[0].level).toBe('error')
  })

  it('can be stopped', async () => {
    await fs.writeFile(path.join(project, 'main.tex'), doc('Slow\n% fake:sleep=20000'))
    const running = manager.compile(request())
    await new Promise((r) => setTimeout(r, 600))
    expect(manager.isCompiling(project)).toBe(true)
    manager.stop(project)
    const result = await running
    expect(result.status).toBe('stopped')
    expect(result.hasPdf).toBe(false)
    expect(manager.isCompiling(project)).toBe(false)
    await manager.whenIdle(project) // resolves at once when nothing runs
  }, 30000)

  it('lets a new request take over from a compile that is still running', async () => {
    await fs.writeFile(path.join(project, 'main.tex'), doc('Slow\n% fake:sleep=20000'))
    const abandoned = manager.compile(request())
    await new Promise((r) => setTimeout(r, 600))
    // As after reloading the window: nobody waits for the first one any more.
    await fs.writeFile(path.join(project, 'main.tex'), doc('Quick'))
    const [first, second] = await Promise.all([abandoned, manager.compile(request())])
    expect(first.status).toBe('stopped')
    expect(second.status).toBe('success')
    expect(manager.isCompiling(project)).toBe(false)
  }, 30000)

  it('throws away a PDF that was cut short by stopping', async () => {
    await fs.writeFile(path.join(project, 'main.tex'), doc('Good'))
    expect((await manager.compile(request())).hasPdf).toBe(true)

    // The engine starts to rewrite the PDF and is killed half-way.
    await fs.writeFile(path.join(project, 'main.tex'), doc('Slow\n% fake:partial-pdf\n% fake:sleep=20000'))
    const running = manager.compile(request())
    await new Promise((r) => setTimeout(r, 800))
    manager.stop(project)
    const result = await running
    expect(result.status).toBe('stopped')
    expect(result.hasPdf).toBe(false)
    expect(await manager.readPdf(project)).toBeNull()

    // The next compile is whole again.
    await fs.writeFile(path.join(project, 'main.tex'), doc('Good again'))
    const after = await manager.compile(request())
    expect(after).toMatchObject({ status: 'success', hasPdf: true })
  }, 30000)

  it('clears its cache and recompiles from scratch', async () => {
    await fs.writeFile(path.join(project, 'main.tex'), doc('Text'))
    await manager.compile(request())
    await manager.clearCache(project)
    expect(await manager.readPdf(project)).toBeNull()
    const again = await manager.compile(request({ fromScratch: true }))
    expect(again.status).toBe('success')
  })
})

describe('CompileManager with an installed distribution (latexmk)', () => {
  // A stand-in for latexmk with the one habit that matters here: when nothing
  // changed since its last run it does not run the engine again, and repeats
  // that run's exit code.
  const LATEXMK = `
const fs = require('node:fs')
const src = fs.readFileSync('main.tex', 'utf8')
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ rc: fs.existsSync('latexmkrc'), args: process.argv.slice(2) }) + '\\n')
const last = fs.existsSync('output.fdb_latexmk') ? JSON.parse(fs.readFileSync('output.fdb_latexmk', 'utf8')) : null
if (last && last.src === src) {
  console.log("Latexmk: Nothing to do for 'main.tex'.")
  if (last.code) console.log('  pdflatex: gave an error in previous invocation of latexmk.')
  process.exit(last.code)
}
const bad = src.includes('\\\\badcommand')
const fatal = src.includes('\\\\fatal')
let log = '(./main.tex\\n'
if (bad) log += './main.tex:3: Undefined control sequence.\\nl.3 Now \\\\badcommand\\n\\n'
if (fatal) log += './main.tex:3: Undefined control sequence.\\nl.3 \\\\fatal\\n\\n!  ==> Fatal error occurred, no output PDF file produced!\\n'
fs.writeFileSync('output.log', log + ')\\n')
if (!fatal) fs.writeFileSync('output.pdf', '%PDF-1.4 ' + src.length + ' ' + Date.now())
const code = bad || fatal ? 12 : 0
fs.writeFileSync('output.fdb_latexmk', JSON.stringify({ src, code }))
process.exit(code)
`
  let system: CompileManager
  let callsFile: string

  const calls = async (): Promise<Array<{ rc: boolean; args: string[] }>> =>
    (await fs.readFile(callsFile, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  const viaLatexmk = (overrides: Partial<CompileRequest> = {}): CompileRequest =>
    request({ backend: 'system', ...overrides })

  beforeEach(async () => {
    const bin = path.join(tmp, 'texbin')
    await fs.mkdir(bin)
    const script = path.join(bin, 'latexmk.cjs')
    await fs.writeFile(script, LATEXMK)
    callsFile = path.join(tmp, 'latexmk-calls.jsonl')
    process.env.FAKE_CALLS = callsFile
    system = new CompileManager({
      cacheRoot: cache,
      latexmkrc: null,
      findTectonic: async () => null,
      onProgress: () => undefined,
      detectTex: async () => ({
        binDir: bin,
        distribution: 'TeX Live',
        tools: { latexmk: script, pdflatex: script },
        latexmkWorks: true
      })
    })
  })

  afterEach(() => {
    delete process.env.FAKE_CALLS
  })

  it('compiles through latexmk with the options Overleaf uses', async () => {
    await fs.writeFile(path.join(project, 'main.tex'), doc('Fine'))
    const result = await system.compile(viaLatexmk())
    expect(result).toMatchObject({ status: 'success', hasPdf: true })
    expect(result.engine).toMatchObject({ backend: 'system' })
    expect(result.engine?.label).toContain('latexmk')
    expect((await calls())[0].args).toEqual([
      '-jobname=output',
      '-synctex=1',
      '-interaction=batchmode',
      '-file-line-error',
      '-f',
      '-pdf',
      'main.tex'
    ])
  })

  it('still has its PDF when latexmk sees nothing to do after a run with errors', async () => {
    await fs.writeFile(path.join(project, 'main.tex'), doc('Now \\badcommand'))
    const first = await system.compile(viaLatexmk())
    expect(first).toMatchObject({ status: 'failure', hasPdf: true })
    expect(first.entries.find((e) => e.level === 'error')).toMatchObject({ file: 'main.tex', line: 3 })

    // Unchanged sources: latexmk does not run the engine, and fails again.
    const again = await system.compile(viaLatexmk())
    expect(again).toMatchObject({ status: 'failure', hasPdf: true, pdfVersion: first.pdfVersion })
    expect(again.counts.errors).toBe(1)
    expect(await calls()).toHaveLength(2)
  })

  it('does not present an old PDF as the result of a run that produced none', async () => {
    await fs.writeFile(path.join(project, 'main.tex'), doc('Fine'))
    expect((await system.compile(viaLatexmk())).hasPdf).toBe(true)

    await fs.writeFile(path.join(project, 'main.tex'), doc('\\fatal'))
    expect(await system.compile(viaLatexmk())).toMatchObject({ status: 'failure', hasPdf: false })
    // ... and neither when latexmk then has nothing to do.
    expect(await system.compile(viaLatexmk())).toMatchObject({ status: 'failure', hasPdf: false })
    // The last good PDF is still there for the viewer to keep showing.
    expect(await system.readPdf(project)).not.toBeNull()
  })

  it('uses a latexmkrc of the project only once it has been allowed', async () => {
    await fs.writeFile(path.join(project, 'main.tex'), doc('Text'))
    expect(await rcFingerprint(project)).toBeNull()
    const rc = path.join(project, 'latexmkrc')
    await fs.writeFile(rc, '$pdf_mode = 1;\n')

    const before = await system.compile(viaLatexmk())
    expect(before.rcIgnored).toBe(true)
    expect((await calls()).at(-1)?.rc).toBe(false) // the file is not even in the build folder

    const allowed = await rcFingerprint(project)
    const after = await system.compile(viaLatexmk({ trustedRc: allowed }))
    expect(after.rcIgnored).toBe(false)
    expect((await calls()).at(-1)?.rc).toBe(true)

    // A different file needs to be allowed again, and is taken out meanwhile.
    await fs.writeFile(rc, 'system("anything");\n')
    const changed = await system.compile(viaLatexmk({ trustedRc: allowed }))
    expect(changed.rcIgnored).toBe(true)
    expect((await calls()).at(-1)?.rc).toBe(false)
  })

  it('does not mention a latexmkrc to engines that never read one', async () => {
    await fs.writeFile(path.join(project, 'main.tex'), doc('Text'))
    await fs.writeFile(path.join(project, 'latexmkrc'), '$pdf_mode = 1;\n')
    const result = await manager.compile(request()) // the built-in engine
    expect(result.status).toBe('success')
    expect(result.rcIgnored).toBe(false)
  })
})

describe('SyncTeX through the compile manager', () => {
  it('jumps from source to PDF and back', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line number ${i + 1}`)
    await fs.writeFile(path.join(project, 'main.tex'), doc(lines.join('\n') + '\n\\input{sections/intro}'))
    await fs.writeFile(path.join(project, 'sections', 'intro.tex'), 'From the intro file.\n')
    await manager.compile(request())

    // Body line N sits on source line N + 2 (after \documentclass and \begin{document}).
    const first = await manager.syncToPdf(project, 'main.tex', 3)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ page: 1 })
    expect(first[0].x).toBeCloseTo(72, 0)
    expect(first[0].y).toBeCloseTo(90 - 11, 0)

    // The fake engine puts 40 lines on a page, so body line 45 is on page 2.
    const later = await manager.syncToPdf(project, 'main.tex', 47)
    expect(later[0].page).toBe(2)

    const included = await manager.syncToPdf(project, 'sections/intro.tex', 1)
    expect(included[0].page).toBe(2)

    // And back: a click on the second text line of page 1.
    const source = await manager.syncToSource(project, 1, 150, 90 + 16 - 4)
    expect(source).toEqual({ file: 'main.tex', line: 4, column: 0 })
    const fromInclude = await manager.syncToSource(project, 2, 150, included[0].y + 4)
    expect(fromInclude).toMatchObject({ file: 'sections/intro.tex', line: 1 })

    expect(await manager.syncToPdf(project, 'nope.tex', 1)).toEqual([])
    expect(await manager.syncToSource(project, 9, 10, 10)).toBeNull()
  })

  it('works when the build folder is reached through a symbolic link', async () => {
    // Engines record the working directory with links resolved, so the paths
    // in the SyncTeX file do not start with the cache folder as the app knows
    // it. (On macOS the temp folder and /tmp are behind such a link.)
    const realCache = path.join(tmp, 'real-cache')
    const linkedCache = path.join(tmp, 'linked-cache')
    await fs.mkdir(realCache)
    await fs.symlink(realCache, linkedCache, 'junction')
    const linked = new CompileManager({
      cacheRoot: linkedCache,
      latexmkrc: null,
      findTectonic: async () => FAKE_ENGINE,
      onProgress: () => undefined
    })
    await fs.writeFile(path.join(project, 'main.tex'), doc('First line\n\\input{sections/intro}'))
    await fs.writeFile(path.join(project, 'sections', 'intro.tex'), 'From the intro file.\n')
    expect((await linked.compile(request())).status).toBe('success')

    expect(await linked.syncToPdf(project, 'main.tex', 3)).toHaveLength(1)
    expect(await linked.syncToPdf(project, 'sections/intro.tex', 1)).toHaveLength(1)
    expect(await linked.syncToSource(project, 1, 150, 90 - 4)).toEqual({ file: 'main.tex', line: 3, column: 0 })
    expect(await linked.syncToSource(project, 1, 150, 90 + 16 - 4)).toMatchObject({ file: 'sections/intro.tex', line: 1 })
  })

  it('returns nothing before the first compile', async () => {
    expect(await manager.syncToPdf(project, 'main.tex', 1)).toEqual([])
    expect(await manager.syncToSource(project, 1, 10, 10)).toBeNull()
  })
})
