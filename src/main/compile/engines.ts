// Runs the TeX toolchain inside the build mirror. Three strategies:
//   1. latexmk from an installed TeX distribution (same tool Overleaf uses)
//   2. a small built-in driver for distributions where latexmk cannot run
//   3. the bundled Tectonic engine, which needs no TeX installation at all

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Compiler } from '@shared/types'
import { exists } from '../util/fsx'
import { envWithPath, runProcess, type RunResult } from './proc'
import type { TexInstall } from './texDetect'

export interface EngineContext {
  /** Root of the build mirror. */
  workRoot: string
  /** Folder (inside the mirror) that holds the main document; TeX runs here. */
  mainDir: string
  /** File name of the main document. */
  mainBase: string
  compiler: Compiler
  stopOnFirstError: boolean
  /** The project's own latexmkrc may be used (the user allowed it). */
  useProjectRc: boolean
  timeoutMs: number
  /** A line of engine output (shown briefly, may be skipped when output is fast). */
  onLine(line: string): void
  /** A status message of our own that should stay visible while the compile runs. */
  notice(text: string): void
  onSpawn(kill: () => void): void
  isStopped(): boolean
}

export interface EngineRun {
  /** Output files are <jobname>.pdf, <jobname>.log, <jobname>.synctex.gz in mainDir. */
  jobname: string
  exitCode: number | null
  output: string
  timedOut: boolean
  spawnError: string | null
  /**
   * Set when a file was missing from the engine's package cache and no
   * download was attempted because there is no network connection.
   */
  offline?: boolean
}

const LATEXMK_FLAG: Record<Compiler, string> = {
  pdflatex: '-pdf',
  xelatex: '-xelatex',
  lualatex: '-lualatex',
  latex: '-pdfdvi'
}

/** Relative path from the main document's folder up to the mirror root, or null if they coincide. */
function upToRoot(ctx: EngineContext): string | null {
  const rel = path.relative(ctx.mainDir, ctx.workRoot)
  return rel ? rel.split(path.sep).join('/') : null
}

/**
 * Environment for TeX tools. When the main document lives in a sub-folder the
 * project root is added to the search paths: Overleaf resolves \input and
 * \includegraphics against both folders, and projects rely on that.
 */
function texEnv(install: TexInstall, ctx: EngineContext, rcSys: string | null): NodeJS.ProcessEnv {
  const env = envWithPath(process.env, install.binDir)
  if (rcSys) env.LATEXMKRCSYS = rcSys
  const up = upToRoot(ctx)
  if (up) {
    for (const key of ['TEXINPUTS', 'BIBINPUTS', 'BSTINPUTS']) {
      // A trailing separator keeps the distribution's default search path.
      env[key] = `.${path.delimiter}${up}${path.delimiter}${process.env[key] ?? ''}`
    }
  }
  return env
}

function toRun(jobname: string, r: RunResult, output = r.output): EngineRun {
  return { jobname, exitCode: r.code, output, timedOut: r.timedOut, spawnError: r.spawnError }
}

// ------------------------------------------------------------- latexmk

export async function runLatexmk(
  ctx: EngineContext,
  install: TexInstall,
  defaultRc: string | null
): Promise<EngineRun> {
  const latexmk = install.tools.latexmk
  if (!latexmk) throw new Error('latexmk is not available')

  const build = async (rcSys: string | null): Promise<RunResult> => {
    const args = [
      '-jobname=output',
      '-synctex=1',
      '-interaction=batchmode',
      '-file-line-error',
      ctx.stopOnFirstError ? '-halt-on-error' : '-f'
    ]
    // latexmk only reads a latexmkrc from the folder it runs in. Projects keep
    // theirs at the root, which differs when the main document is in a sub-folder.
    // (A latexmkrc the user has not allowed is not in the build folder at all.)
    const up = upToRoot(ctx)
    if (up && ctx.useProjectRc) {
      for (const name of ['latexmkrc', '.latexmkrc']) {
        if (await exists(path.join(ctx.workRoot, name))) {
          args.push('-r', `${up}/${name}`)
          break
        }
      }
    }
    args.push(LATEXMK_FLAG[ctx.compiler], ctx.mainBase)
    return runProcess(latexmk, args, {
      cwd: ctx.mainDir,
      env: texEnv(install, ctx, rcSys),
      timeoutMs: ctx.timeoutMs,
      onLine: ctx.onLine,
      onSpawn: ctx.onSpawn
    })
  }

  let result = await build(defaultRc)
  // If our default rc file ever trips an unusual latexmk build, run without it
  // rather than failing every compile.
  if (
    defaultRc &&
    result.code !== 0 &&
    !result.timedOut &&
    !ctx.isStopped() &&
    /(initialization|rc) file|LATEXMKRCSYS/i.test(result.output) &&
    !(await exists(path.join(ctx.mainDir, 'output.log')))
  ) {
    result = await build(null)
  }
  return toRun('output', result)
}

// ------------------------------------------------ built-in build driver

async function digestOf(files: string[]): Promise<string> {
  const hash = crypto.createHash('sha1')
  for (const file of files) {
    try {
      hash.update(await fs.readFile(file))
    } catch {
      hash.update('\0missing\0')
    }
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function readText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Minimal replacement for latexmk: engine, bibliography, index, then re-runs
 * until the auxiliary files stop changing (at most four engine passes).
 */
export async function runManual(ctx: EngineContext, install: TexInstall): Promise<EngineRun> {
  const engine = install.tools[ctx.compiler]
  if (!engine) {
    return {
      jobname: 'output',
      exitCode: null,
      output: '',
      timedOut: false,
      spawnError: `${ctx.compiler} was not found in ${install.binDir}`
    }
  }

  const env = texEnv(install, ctx, null)
  const at = (name: string): string => path.join(ctx.mainDir, name)
  let transcript = ''
  let last: RunResult = { code: null, output: '', timedOut: false, spawnError: null }

  const step = async (cmd: string, args: string[]): Promise<RunResult> => {
    transcript += `\n$ ${path.basename(cmd)} ${args.join(' ')}\n`
    const r = await runProcess(cmd, args, {
      cwd: ctx.mainDir,
      env,
      timeoutMs: ctx.timeoutMs,
      onLine: ctx.onLine,
      onSpawn: ctx.onSpawn
    })
    transcript += r.output
    return r
  }
  const aborted = (r: RunResult): boolean => r.timedOut || r.spawnError !== null || ctx.isStopped()

  const engineArgs = ['-synctex=1', '-interaction=batchmode', '-file-line-error']
  if (ctx.stopOnFirstError) engineArgs.push('-halt-on-error')
  engineArgs.push('-jobname=output', ctx.mainBase)

  const tracked = ['output.aux', 'output.toc', 'output.lof', 'output.lot', 'output.out', 'output.bbl', 'output.ind'].map(at)
  let before = await digestOf(tracked)

  for (let pass = 1; pass <= 4; pass++) {
    ctx.notice(`Running ${ctx.compiler}, pass ${pass}…`)
    last = await step(engine, engineArgs)
    if (aborted(last)) return toRun('output', last, transcript)
    if (last.code !== 0 && ctx.stopOnFirstError) break

    if (pass === 1) {
      // Bibliography: biber when biblatex asked for it, BibTeX otherwise.
      const aux = await readText(at('output.aux'))
      if ((await exists(at('output.bcf'))) && install.tools.biber) {
        const r = await step(install.tools.biber, ['output'])
        if (aborted(r)) return toRun('output', r, transcript)
      } else if (/\\bibdata\{/.test(aux) && install.tools.bibtex) {
        const r = await step(install.tools.bibtex, ['output'])
        if (aborted(r)) return toRun('output', r, transcript)
      }
      if ((await exists(at('output.idx'))) && install.tools.makeindex) {
        const r = await step(install.tools.makeindex, ['output.idx'])
        if (aborted(r)) return toRun('output', r, transcript)
      }
    }

    const after = await digestOf(tracked)
    if (after === before) break // references are stable
    before = after
  }

  if (ctx.compiler === 'latex' && install.tools.dvipdfmx && (await exists(at('output.dvi')))) {
    const r = await step(install.tools.dvipdfmx, ['-o', 'output.pdf', 'output.dvi'])
    if (aborted(r)) return toRun('output', r, transcript)
  }

  return toRun('output', last, transcript)
}

// ------------------------------------------------------------ Tectonic

export interface TectonicMemo {
  /** True once an online run has succeeded, i.e. the package cache is populated. */
  isPrimed(): boolean
  markPrimed(): void
  /**
   * Failures that were already retried with network access, by project. While
   * the same failure repeats there is no point in going online on every
   * compile. An entry expires, though: the cause may have been a connection
   * that is back by now.
   */
  confirmed: Map<string, { signature: string; at: number }>
  /** False when the operating system reports that there is no network connection. */
  isOnline(): boolean
}

/** How long a failed download attempt is remembered before it is tried again. */
const RETRY_AFTER_MS = 60_000

function failureSignature(output: string, log: string): string {
  const lines = new Set<string>()
  for (const l of output.split(/\r?\n/)) if (/^error:/i.test(l.trim())) lines.add(l.trim())
  for (const l of log.split(/\r?\n/)) if (/^!|:\d+: /.test(l)) lines.add(l.trim())
  return [...lines].sort().join('\n').replace(/\d+/g, '#')
}

// Complaints that can mean "this file is not in the local package cache":
// a missing class/package/input, or a font that could not be loaded.
const MISSING_IN_LOG = /LaTeX Error: File [`'"][^`'"\n]+['"] not found|I can't find file|not loadable|cannot be found/
const MISSING_ON_CONSOLE = /^error:.*(?:not found|no such file|could not find|cache|bundle)/im

function looksLikeMissingResource(run: RunResult, log: string): boolean {
  // No log although the run failed: TeX never started, so the format or the
  // package bundle itself is not available yet.
  if (!log) return run.code !== 0
  return MISSING_IN_LOG.test(log) || MISSING_ON_CONSOLE.test(run.output)
}

const NETWORK_ERROR =
  /dns error|error sending request|failed to lookup address|could not resolve|connection (?:refused|reset|timed out|closed)|network is unreachable|failed to (?:download|fetch)|couldn't get it from the internet|\b(?:tls|ssl) (?:handshake|error|connection)|certificate verify|invalid peer certificate/i

/** True when the console output points at a failed download rather than a LaTeX problem. */
export function isNetworkFailure(output: string): boolean {
  // Only the engine's own messages count. Left out are TeX's terminal output,
  // which Tectonic quotes between two rules of "=", and the diagnostics it
  // prints per source line ("error: chapter.tex:12: ..."): both are about the
  // document, whose text and file names may well contain words like these.
  const lines = output.split(/\r?\n/)
  const first = lines.findIndex((l) => /^={20,}\s*$/.test(l))
  const last = lines.findLastIndex((l) => /^={20,}\s*$/.test(l))
  const own = first >= 0 && last > first ? [...lines.slice(0, first), ...lines.slice(last + 1)] : lines
  return own.some((l) => !/^(?:error|warning): [^:]+:\d+: /.test(l) && NETWORK_ERROR.test(l))
}

/**
 * Tectonic downloads TeX packages on demand and keeps them in a local cache.
 * To stay fast and to work offline, compile from the cache first and only go
 * online when something appears to be missing.
 */
export async function runTectonic(
  ctx: EngineContext,
  binary: string,
  memo: TectonicMemo,
  memoKey: string
): Promise<EngineRun> {
  const jobname = ctx.mainBase.replace(/\.[^.]+$/, '')
  const logFile = path.join(ctx.mainDir, `${jobname}.log`)

  const exec = (onlyCached: boolean): Promise<RunResult> => {
    const args = ['-X', 'compile', ctx.mainBase, '--synctex', '--keep-logs', '--keep-intermediates']
    if (!ctx.stopOnFirstError) args.push('-Z', 'continue-on-errors')
    const up = upToRoot(ctx)
    if (up) args.push('-Z', `search-path=${up}`)
    if (onlyCached) args.push('--only-cached')
    return runProcess(binary, args, {
      cwd: ctx.mainDir,
      env: process.env,
      timeoutMs: ctx.timeoutMs,
      onLine: ctx.onLine,
      onSpawn: ctx.onSpawn
    })
  }
  const settled = (r: RunResult): boolean => r.timedOut || r.spawnError !== null || ctx.isStopped()

  if (!memo.isPrimed()) {
    ctx.notice('Preparing the built-in TeX engine. The first compile downloads its support files…')
    await fs.rm(logFile, { force: true })
    const first = await exec(false)
    if (first.code === 0) memo.markPrimed()
    if (first.code === 0 || settled(first) || !isNetworkFailure(first.output)) return toRun(jobname, first)
    // No connection. The support files may be on this computer already (the
    // engine keeps its own cache, which outlives this app's), so try without
    // the network before giving up.
    const offline = await exec(true)
    if (settled(offline)) return toRun(jobname, offline)
    if (offline.code === 0 || (await exists(logFile))) {
      // TeX itself ran, so everything the engine needs to start is cached.
      memo.markPrimed()
      return toRun(jobname, offline)
    }
    return toRun(jobname, first)
  }

  await fs.rm(logFile, { force: true })
  const cached = await exec(true)
  if (settled(cached)) return toRun(jobname, cached)

  // Whether something is missing is judged from the log, not the exit code:
  // with "continue on errors" a missing package still ends in a (broken) PDF.
  const cachedLog = await readText(logFile)
  if (!looksLikeMissingResource(cached, cachedLog)) return toRun(jobname, cached)
  // Without a connection a download cannot succeed; do not make the user wait
  // for it to time out.
  if (!memo.isOnline()) return { ...toRun(jobname, cached), offline: true }
  // The same complaint was retried with network access a moment ago (a file
  // that really does not exist, say): going online again would only cost time.
  const earlier = memo.confirmed.get(memoKey)
  if (
    earlier &&
    earlier.signature === failureSignature(cached.output, cachedLog) &&
    Date.now() - earlier.at < RETRY_AFTER_MS
  ) {
    return toRun(jobname, cached)
  }

  ctx.notice('Downloading TeX files that are not in the local cache yet…')
  const online = await exec(false)
  if (settled(online)) return toRun(jobname, online)
  const onlineLog = await readText(logFile)
  if (online.code !== 0 && isNetworkFailure(online.output) && cachedLog) {
    // The download failed outright. The cached attempt at least produced a
    // real TeX log, so report that one, restored to disk, together with the
    // reason why nothing could be fetched.
    await fs.writeFile(logFile, cachedLog).catch(() => undefined)
    return toRun(jobname, cached, `${cached.output}\n${online.output}`)
  }
  if (looksLikeMissingResource(online, onlineLog)) {
    memo.confirmed.set(memoKey, { signature: failureSignature(online.output, onlineLog), at: Date.now() })
  } else {
    memo.confirmed.delete(memoKey)
  }
  return toRun(jobname, online)
}
