// Tests for the code paths that drive an installed TeX distribution. The
// "tools" are small scripts written on the fly: they record how they were
// called and produce the files the real programs would.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runLatexmk, runManual, type EngineContext } from '../../src/main/compile/engines'
import { candidateBinDirs, detectTex, enginesOf, type TexInstall } from '../../src/main/compile/texDetect'

let tmp: string
let work: string
let bin: string
let calls: string

/** Writes a fake tool that logs "name|cwd|args|env" and then runs `body`. */
async function tool(name: string, body: string): Promise<string> {
  const file = path.join(bin, `${name}.cjs`)
  await fs.writeFile(
    file,
    `const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({
  tool: ${JSON.stringify(name)}, cwd: process.cwd(), args,
  TEXINPUTS: process.env.TEXINPUTS || null, BIBINPUTS: process.env.BIBINPUTS || null,
  rc: process.env.LATEXMKRCSYS || null,
  pathStartsWithBin: (process.env.PATH || process.env.Path || '').startsWith(${JSON.stringify(bin)})
}) + '\\n');
${body}
`
  )
  return file
}

async function recorded(): Promise<Array<Record<string, any>>> {
  const text = await fs.readFile(calls, 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

function context(overrides: Partial<EngineContext> = {}): EngineContext {
  return {
    workRoot: work,
    mainDir: work,
    mainBase: 'main.tex',
    compiler: 'pdflatex',
    stopOnFirstError: false,
    useProjectRc: true,
    timeoutMs: 20000,
    onLine: () => undefined,
    notice: () => undefined,
    onSpawn: () => undefined,
    isStopped: () => false,
    ...overrides
  }
}

function install(tools: TexInstall['tools'], latexmkWorks = true): TexInstall {
  return { binDir: bin, distribution: 'TeX Live', tools, latexmkWorks }
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'underleaf-engines-'))
  work = path.join(tmp, 'work dir with spaces')
  bin = path.join(tmp, 'bin')
  calls = path.join(tmp, 'calls.jsonl')
  await fs.mkdir(work, { recursive: true })
  await fs.mkdir(bin)
  await fs.writeFile(path.join(work, 'main.tex'), '\\documentclass{article}\\begin{document}x\\end{document}')
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('runLatexmk', () => {
  it('uses the same options as Overleaf and runs in the main document folder', async () => {
    const latexmk = await tool('latexmk', "fs.writeFileSync('output.pdf', '%PDF-'); console.log('Latexmk: done')")
    const lines: string[] = []
    const run = await runLatexmk(context({ onLine: (l) => lines.push(l) }), install({ latexmk }), path.join(tmp, 'rc'))

    expect(run).toMatchObject({ jobname: 'output', exitCode: 0, timedOut: false, spawnError: null })
    expect(lines).toContain('Latexmk: done')
    const [call] = await recorded()
    // The child sees its working directory with symbolic links resolved.
    expect(await fs.realpath(call.cwd)).toBe(await fs.realpath(work))
    expect(call.args).toEqual([
      '-jobname=output',
      '-synctex=1',
      '-interaction=batchmode',
      '-file-line-error',
      '-f',
      '-pdf',
      'main.tex'
    ])
    expect(call.rc).toBe(path.join(tmp, 'rc'))
    expect(call.pathStartsWithBin).toBe(true)
    expect(call.TEXINPUTS).toBeNull() // only needed when the main file is in a sub-folder
  })

  it('maps every compiler and "stop on first error" to latexmk flags', async () => {
    const latexmk = await tool('latexmk', '')
    for (const compiler of ['xelatex', 'lualatex', 'latex'] as const) {
      await runLatexmk(context({ compiler, stopOnFirstError: true }), install({ latexmk }), null)
    }
    const flags = (await recorded()).map((c) => c.args.slice(4, 6))
    expect(flags).toEqual([
      ['-halt-on-error', '-xelatex'],
      ['-halt-on-error', '-lualatex'],
      ['-halt-on-error', '-pdfdvi']
    ])
  })

  it('makes the project root searchable when the main document is in a sub-folder', async () => {
    const mainDir = path.join(work, 'paper', 'src')
    await fs.mkdir(mainDir, { recursive: true })
    await fs.writeFile(path.join(work, 'latexmkrc'), '# project settings')
    const latexmk = await tool('latexmk', '')
    await runLatexmk(context({ mainDir, mainBase: 'thesis.tex' }), install({ latexmk }), null)

    const [call] = await recorded()
    expect(await fs.realpath(call.cwd)).toBe(await fs.realpath(mainDir))
    expect(call.args.at(-1)).toBe('thesis.tex')
    // The project's own latexmkrc lives at the root and is passed explicitly.
    expect(call.args).toContain('-r')
    expect(call.args[call.args.indexOf('-r') + 1]).toBe('../../latexmkrc')
    expect(call.TEXINPUTS.startsWith(`.${path.delimiter}../..${path.delimiter}`)).toBe(true)
    expect(call.BIBINPUTS.startsWith(`.${path.delimiter}../..${path.delimiter}`)).toBe(true)
  })

  it('does not hand latexmk a project rc file that the user has not allowed', async () => {
    const mainDir = path.join(work, 'paper')
    await fs.mkdir(mainDir, { recursive: true })
    await fs.writeFile(path.join(work, 'latexmkrc'), 'system("anything");')
    const latexmk = await tool('latexmk', '')
    await runLatexmk(context({ mainDir, mainBase: 'thesis.tex', useProjectRc: false }), install({ latexmk }), null)
    const [call] = await recorded()
    expect(call.args).not.toContain('-r')
  })

  it('retries without the default rc file if latexmk rejects it', async () => {
    const latexmk = await tool(
      'latexmk',
      "if (process.env.LATEXMKRCSYS) { console.error('Latexmk: Initialization file has errors'); process.exit(2) }\nfs.writeFileSync('output.log', 'ok')"
    )
    const run = await runLatexmk(context(), install({ latexmk }), path.join(tmp, 'rc'))
    expect(run.exitCode).toBe(0)
    expect((await recorded()).map((c) => c.rc)).toEqual([path.join(tmp, 'rc'), null])
  })

  it('reports the exit code of a failed build', async () => {
    const latexmk = await tool('latexmk', "fs.writeFileSync('output.log', '! error'); process.exit(12)")
    const run = await runLatexmk(context(), install({ latexmk }), path.join(tmp, 'rc'))
    expect(run.exitCode).toBe(12)
    expect(await recorded()).toHaveLength(1) // a real LaTeX failure is not retried
  })
})

describe('runManual (no latexmk)', () => {
  // A pretend engine: the aux file settles after the second pass.
  const ENGINE = `
const n = (fs.existsSync('passes') ? Number(fs.readFileSync('passes', 'utf8')) : 0) + 1;
fs.writeFileSync('passes', String(n));
fs.writeFileSync('output.aux', WITH_BIB + '\\\\newlabel{a}{' + Math.min(n, 2) + '}');
fs.writeFileSync('output.log', 'pass ' + n);
fs.writeFileSync(OUTPUT, 'result of pass ' + n);
`

  it('re-runs the engine until references are stable, with BibTeX in between', async () => {
    const pdflatex = await tool(
      'pdflatex',
      ENGINE.replace('WITH_BIB', JSON.stringify('\\bibdata{refs}')).replace('OUTPUT', "'output.pdf'")
    )
    const bibtex = await tool('bibtex', "fs.writeFileSync('output.bbl', 'bibliography')")
    const makeindex = await tool('makeindex', '')
    const notices: string[] = []
    const run = await runManual(
      context({ notice: (t) => notices.push(t) }),
      install({ pdflatex, bibtex, makeindex }, false)
    )

    expect(run).toMatchObject({ jobname: 'output', exitCode: 0 })
    const sequence = (await recorded()).map((c) => c.tool)
    // pass 1, bibtex, pass 2 (aux changed), pass 3 (confirms that nothing changes any more)
    expect(sequence).toEqual(['pdflatex', 'bibtex', 'pdflatex', 'pdflatex'])
    expect(notices).toHaveLength(3)
    const engineCall = (await recorded())[0]
    expect(engineCall.args).toEqual(['-synctex=1', '-interaction=batchmode', '-file-line-error', '-jobname=output', 'main.tex'])
    expect((await recorded())[1].args).toEqual(['output'])
    expect(run.output).toContain('$ bibtex.cjs output')
    expect(await fs.readFile(path.join(work, 'output.pdf'), 'utf8')).toBe('result of pass 3')
  })

  it('needs a single pass when nothing changed since the last build', async () => {
    const pdflatex = await tool(
      'pdflatex',
      "fs.writeFileSync('output.aux', 'stable'); fs.writeFileSync('output.pdf', 'x')"
    )
    await fs.writeFile(path.join(work, 'output.aux'), 'stable')
    await runManual(context(), install({ pdflatex }, false))
    expect((await recorded()).map((c) => c.tool)).toEqual(['pdflatex'])
  })

  it('prefers biber when biblatex asked for it, and builds the index', async () => {
    const pdflatex = await tool(
      'pdflatex',
      "fs.writeFileSync('output.aux', 'x'); fs.writeFileSync('output.bcf', 'x'); fs.writeFileSync('output.idx', 'x')"
    )
    const bibtex = await tool('bibtex', '')
    const biber = await tool('biber', '')
    const makeindex = await tool('makeindex', '')
    await runManual(context(), install({ pdflatex, bibtex, biber, makeindex }, false))
    const sequence = (await recorded()).map((c) => c.tool)
    expect(sequence.slice(0, 3)).toEqual(['pdflatex', 'biber', 'makeindex'])
    expect(sequence).not.toContain('bibtex')
  })

  it('converts DVI to PDF for the "latex" compiler', async () => {
    const latex = await tool(
      'latex',
      ENGINE.replace('WITH_BIB', "''").replace('OUTPUT', "'output.dvi'")
    )
    const dvipdfmx = await tool('dvipdfmx', "fs.writeFileSync('output.pdf', '%PDF-')")
    const run = await runManual(context({ compiler: 'latex' }), install({ latex, dvipdfmx }, false))
    expect(run.exitCode).toBe(0)
    const all = await recorded()
    expect(all.at(-1)).toMatchObject({ tool: 'dvipdfmx', args: ['-o', 'output.pdf', 'output.dvi'] })
  })

  it('stops after the first failing pass when asked to', async () => {
    const pdflatex = await tool('pdflatex', "fs.writeFileSync('output.aux', String(Math.random())); process.exit(1)")
    const run = await runManual(context({ stopOnFirstError: true }), install({ pdflatex }, false))
    expect(run.exitCode).toBe(1)
    const all = await recorded()
    expect(all).toHaveLength(1)
    expect(all[0].args).toContain('-halt-on-error')
  })

  it('never loops forever on a document that keeps changing', async () => {
    const pdflatex = await tool('pdflatex', "fs.writeFileSync('output.aux', String(Math.random()))")
    await runManual(context(), install({ pdflatex }, false))
    expect(await recorded()).toHaveLength(4)
  })

  it('explains when the chosen engine is not installed', async () => {
    const run = await runManual(context({ compiler: 'lualatex' }), install({}, false))
    expect(run.spawnError).toMatch(/lualatex was not found/)
  })
})

describe('TeX detection', () => {
  const exe = process.platform === 'win32' ? '.exe' : ''

  it('finds a distribution in a user-supplied folder', async () => {
    const dist = path.join(tmp, 'texlive', '2026', 'bin', 'windows')
    await fs.mkdir(dist, { recursive: true })
    for (const name of ['pdflatex', 'xelatex', 'bibtex', 'latexmk']) {
      await fs.writeFile(path.join(dist, `${name}${exe}`), 'not a real program', { mode: 0o755 })
    }
    const found = await detectTex(dist)
    expect(found).not.toBeNull()
    if (!found) return
    expect(found.binDir).toBe(dist)
    expect(found.distribution).toBe('TeX Live')
    expect(found.tools.pdflatex).toBe(path.join(dist, `pdflatex${exe}`))
    expect(found.tools.lualatex).toBeUndefined()
    // The placeholder cannot actually run, so latexmk must be reported as unusable.
    expect(found.latexmkWorks).toBe(false)
    expect(enginesOf(found)).toEqual(['pdflatex', 'xelatex'])
  })

  it('searches the override first and has no duplicates', async () => {
    const dirs = await candidateBinDirs(bin)
    expect(dirs[0]).toBe(bin)
    const keys = dirs.map((d) => (process.platform === 'win32' ? d.toLowerCase() : d))
    expect(new Set(keys).size).toBe(keys.length)
  })
})
