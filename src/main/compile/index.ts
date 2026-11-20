// Orchestrates a compile: mirror the sources, pick an engine, run it, then
// turn the results into something the UI can show.

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  compilerLabel,
  type Compiler,
  type CompileResult,
  type EngineBackend,
  type EngineInfo,
  type LogEntry,
  type PdfRect,
  type SourceLocation,
  type TexStatus
} from '@shared/types'
import { walk } from '../files'
import { exists, readJson, toPosix, writeJson } from '../util/fsx'
import { syncTree } from './sync'
import { detectTex, enginesOf, type TexInstall } from './texDetect'
import {
  isNetworkFailure,
  runLatexmk,
  runManual,
  runTectonic,
  type EngineContext,
  type EngineRun,
  type TectonicMemo
} from './engines'
import {
  countEntries,
  isMissingFileError,
  parseBibLog,
  parseEngineOutput,
  parseLatexLog,
  type ParseContext
} from './logParser'
import { loadSynctex, pdfToSource, sourceToPdf, tagsFor, type SynctexData } from './synctex'

export interface CompileDeps {
  /** Folder for build mirrors; safe to delete at any time. */
  cacheRoot: string
  /** Default latexmk configuration shipped with the app. */
  latexmkrc: string | null
  /** Path of the bundled (or user-provided) Tectonic binary, if any. */
  findTectonic(): Promise<string | null>
  /** `sticky` marks status notices that should stay on screen until the compile ends. */
  onProgress(projectDir: string, line: string, sticky: boolean): void
  /** Whether the operating system reports a network connection. Assumed when absent. */
  isOnline?(): boolean
  /** Looks for an installed TeX distribution. Replaceable for tests. */
  detectTex?(texBinPath: string): Promise<TexInstall | null>
}

export interface CompileRequest {
  projectDir: string
  rootDoc: string | null
  compiler: Compiler
  backend: EngineBackend
  texBinPath: string
  stopOnFirstError: boolean
  fromScratch: boolean
  /**
   * Fingerprint (see {@link rcFingerprint}) of the latexmkrc that the user has
   * allowed for this project, if any. A latexmkrc is Perl code that latexmk
   * executes, so the project's own is only used while it matches; otherwise it
   * is kept out of the build.
   */
  trustedRc?: string | null
}

/** File names that latexmk reads as configuration (and executes). */
export function isLatexmkRc(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  return base === 'latexmkrc' || base === '.latexmkrc'
}

/**
 * Identifies the exact latexmkrc files of a project (names and contents), or
 * null when it has none. Permission to use them is tied to this value, so a
 * changed file has to be allowed again.
 */
export async function rcFingerprint(projectDir: string): Promise<string | null> {
  const files = (await walk(projectDir)).filter((e) => !e.isDir && isLatexmkRc(e.rel))
  if (files.length === 0) return null
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const hash = crypto.createHash('sha256')
  for (const f of files) {
    hash.update(f.rel)
    hash.update('\0')
    hash.update(await fs.readFile(f.abs).catch(() => Buffer.alloc(0)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

interface OutputState {
  /** Folder of the main document, relative to the mirror root ('' for the root). */
  mainDir: string
  jobname: string
  rootDoc: string
  /** Whether the last compile ended with a usable PDF. */
  hasPdf?: boolean
}

interface Job {
  kill: (() => void) | null
  stopped: boolean
  /** Settles when the compile has finished and released the project. */
  done: Promise<void>
}

interface Paths {
  base: string
  work: string
  manifest: string
  state: string
}

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'
const COMPILE_TIMEOUT_MS = 10 * 60 * 1000
const MAX_RAW_LOG = 1024 * 1024
/** Console lines that tell the user nothing (shown neither as progress nor in the raw log). */
const PROGRESS_NOISE = /^\s*(=+|Fontconfig error:.*|note: "version 2" Tectonic command-line interface activated)\s*$/
/** Lines that belong in the raw log but are not worth flashing up while compiling. */
const PROGRESS_SKIP = /panicked at|RUST_BACKTRACE|^caused by:/

const MISSING_FILE_NAME = /File `([^']+)' not found/
/** Files that come from a TeX package rather than from the project. */
const PACKAGE_FILE = /\.(?:sty|cls|def|fd|cfg|clo|ldf|bst|bbx|cbx|lbx|tfm|enc|map|otf|ttf|pfb)$/i

const HINT_OWN_FILE =
  'Check the name and the location of the file. Paths are relative to the folder of the main document.'
const HINT_BUILTIN =
  'The built-in engine downloads packages the first time they are used. This file is not in its cache and could not be fetched: check your internet connection and recompile. If the file is one of your own, check its name and location.'
const HINT_BUILTIN_OFFLINE =
  'You appear to be offline. The built-in engine downloads packages the first time they are used, so connect to the internet and recompile. If the file is one of your own, check its name and location.'
const HINT_SYSTEM =
  'If this file belongs to a LaTeX package, the package is not installed in your TeX distribution: add it with the distribution’s package manager (tlmgr, or the MiKTeX Console). If the file is one of your own, check its name and location.'

async function readLog(file: string): Promise<string> {
  try {
    const buf = await fs.readFile(file)
    // Logs can contain stray 8-bit bytes; never let decoding throw.
    return new TextDecoder('utf-8', { fatal: false }).decode(buf)
  } catch {
    return ''
  }
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n\n[... ${text.length - max} more characters not shown ...]\n`
}

export class CompileManager {
  private readonly running = new Map<string, Job>()
  private texCache: { key: string; install: TexInstall | null } | null = null
  private readonly synctexCache = new Map<string, { mtimeMs: number; data: SynctexData }>()
  private readonly tectonicConfirmed = new Map<string, { signature: string; at: number }>()
  private tectonicPrimed: boolean | null = null

  constructor(private readonly deps: CompileDeps) {}

  // ------------------------------------------------------------ paths

  private pathsFor(projectDir: string): Paths {
    const resolved = path.resolve(projectDir)
    const key = crypto
      .createHash('sha1')
      .update(CASE_INSENSITIVE ? resolved.toLowerCase() : resolved)
      .digest('hex')
      .slice(0, 16)
    const base = path.join(this.deps.cacheRoot, key)
    return {
      base,
      work: path.join(base, 'work'),
      manifest: path.join(base, 'manifest.json'),
      state: path.join(base, 'state.json')
    }
  }

  private async outputOf(projectDir: string): Promise<{ dir: string; jobname: string; paths: Paths } | null> {
    const paths = this.pathsFor(projectDir)
    const state = await readJson<OutputState>(paths.state)
    if (!state || typeof state.jobname !== 'string') return null
    return { dir: path.join(paths.work, state.mainDir ?? ''), jobname: state.jobname, paths }
  }

  /**
   * Maps paths printed by TeX to project files. Relative paths are relative to
   * the main document's folder. Absolute ones (SyncTeX records those) are
   * based on the working directory as the operating system reports it, which
   * is not how this app spells it when a symbolic link is involved: on macOS,
   * for example, /tmp and /var are links into /private. Both spellings of the
   * mirror root are therefore accepted.
   *
   * A name may come without its ".tex": Tectonic's log and console name a file
   * the way the document did, so \input{chapter} is reported as "chapter".
   */
  private async resolver(
    workRoot: string,
    mainDirAbs: string,
    sourceFiles: Iterable<string>
  ): Promise<(p: string) => string | null> {
    const roots = [workRoot]
    const physical = await fs.realpath(workRoot).catch(() => workRoot)
    if (physical !== workRoot) roots.push(physical)
    const known = new Map<string, string>()
    for (const rel of sourceFiles) known.set(CASE_INSENSITIVE ? rel.toLowerCase() : rel, rel)
    const lookup = (rel: string): string | undefined => known.get(CASE_INSENSITIVE ? rel.toLowerCase() : rel)
    return (logPath: string) => {
      if (!logPath) return null
      const abs = path.resolve(mainDirAbs, logPath.replace(/^"+|"+$/g, ''))
      for (const root of roots) {
        const rel = toPosix(path.relative(root, abs))
        if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) continue
        const hit = lookup(rel) ?? lookup(`${rel}.tex`)
        if (hit !== undefined) return hit
      }
      return null
    }
  }

  // ---------------------------------------------------------- engines

  async texInstall(texBinPath: string, refresh = false): Promise<TexInstall | null> {
    if (!refresh && this.texCache && this.texCache.key === texBinPath) return this.texCache.install
    const install = await (this.deps.detectTex ?? detectTex)(texBinPath)
    this.texCache = { key: texBinPath, install }
    return install
  }

  async texStatus(texBinPath: string, refresh: boolean): Promise<TexStatus> {
    const install = await this.texInstall(texBinPath, refresh)
    const tectonic = await this.deps.findTectonic()
    return {
      system: install
        ? {
            found: true,
            binDir: install.binDir,
            distribution: install.distribution,
            hasLatexmk: install.latexmkWorks,
            engines: enginesOf(install)
          }
        : { found: false, hasLatexmk: false, engines: [] },
      tectonic: tectonic ? { found: true, path: tectonic } : { found: false }
    }
  }

  private primedMarker(): string {
    return path.join(this.deps.cacheRoot, 'tectonic-primed')
  }

  private async tectonicMemo(): Promise<TectonicMemo> {
    if (this.tectonicPrimed === null) this.tectonicPrimed = await exists(this.primedMarker())
    return {
      isPrimed: () => this.tectonicPrimed === true,
      markPrimed: () => {
        this.tectonicPrimed = true
        void fs
          .mkdir(this.deps.cacheRoot, { recursive: true })
          .then(() => fs.writeFile(this.primedMarker(), new Date().toISOString()))
          .catch(() => undefined)
      },
      confirmed: this.tectonicConfirmed,
      isOnline: () => this.deps.isOnline?.() ?? true
    }
  }

  // ---------------------------------------------------------- compile

  isCompiling(projectDir: string): boolean {
    return this.running.has(path.resolve(projectDir))
  }

  stop(projectDir: string): void {
    const job = this.running.get(path.resolve(projectDir))
    if (!job) return
    job.stopped = true
    job.kill?.()
  }

  stopAll(): void {
    for (const job of this.running.values()) {
      job.stopped = true
      job.kill?.()
    }
  }

  /** Resolves once no compile is running for the project any more. */
  async whenIdle(projectDir: string): Promise<void> {
    await this.running.get(path.resolve(projectDir))?.done
  }

  async clearCache(projectDir: string): Promise<void> {
    const paths = this.pathsFor(projectDir)
    this.forget(paths)
    await fs.rm(paths.base, { recursive: true, force: true })
  }

  /** Drops what is remembered about a project's previous builds. */
  private forget(paths: Paths): void {
    this.synctexCache.delete(paths.base)
    // Starting over is also the way to say "try that download again now".
    this.tectonicConfirmed.delete(paths.base)
  }

  async buildFolder(projectDir: string): Promise<string> {
    const paths = this.pathsFor(projectDir)
    await fs.mkdir(paths.work, { recursive: true })
    return paths.work
  }

  private failure(
    status: CompileResult['status'],
    message: string,
    started: number,
    rootDoc: string | null,
    extra: Partial<CompileResult> = {}
  ): CompileResult {
    const entries: LogEntry[] = [{ level: 'error', source: 'engine', message }]
    return {
      status,
      hasPdf: false,
      pdfVersion: 0,
      entries,
      rawLog: '',
      engine: null,
      durationMs: Date.now() - started,
      rootDoc,
      counts: countEntries(entries),
      ...extra
    }
  }

  async compile(req: CompileRequest): Promise<CompileResult> {
    const key = path.resolve(req.projectDir)
    // A new request replaces a compile that is still running for the same
    // project. A window never asks twice on its own, so the earlier one belongs
    // to a window that is gone or was reloaded, and nobody waits for it.
    for (let earlier = this.running.get(key); earlier; earlier = this.running.get(key)) {
      earlier.stopped = true
      earlier.kill?.()
      await earlier.done
    }
    const started = Date.now()
    let release = (): void => undefined
    const job: Job = { kill: null, stopped: false, done: new Promise<void>((resolve) => (release = resolve)) }
    this.running.set(key, job)
    try {
      return await this.compileInner(req, job, started)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return this.failure('error', `The compile could not be started: ${message}`, started, req.rootDoc)
    } finally {
      if (this.running.get(key) === job) this.running.delete(key)
      release()
    }
  }

  private async compileInner(req: CompileRequest, job: Job, started: number): Promise<CompileResult> {
    if (!req.rootDoc) {
      return this.failure(
        'failure',
        'No main document found. Add a .tex file that contains \\documentclass, or choose the main document in Menu > Settings.',
        started,
        null
      )
    }
    const paths = this.pathsFor(req.projectDir)
    if (req.fromScratch) {
      this.forget(paths)
      await fs.rm(paths.base, { recursive: true, force: true })
    }

    // A latexmkrc is code that latexmk would run. Unless the user allowed
    // exactly this one for the project, it does not even reach the build folder.
    const rc = await rcFingerprint(req.projectDir)
    const projectHasRc = rc !== null
    const useProjectRc = projectHasRc && req.trustedRc === rc
    const synced = await syncTree(req.projectDir, paths.work, paths.manifest, {
      exclude: (rel) => !useProjectRc && isLatexmkRc(rel)
    })
    const mainDirRel = req.rootDoc.includes('/') ? req.rootDoc.slice(0, req.rootDoc.lastIndexOf('/')) : ''
    const mainDirAbs = path.join(paths.work, mainDirRel)
    const mainBase = req.rootDoc.slice(req.rootDoc.lastIndexOf('/') + 1)
    if (!(await exists(path.join(mainDirAbs, mainBase)))) {
      return this.failure('failure', `The main document "${req.rootDoc}" does not exist.`, started, req.rootDoc)
    }

    // ---- choose the engine
    const install = req.backend === 'tectonic' ? null : await this.texInstall(req.texBinPath)
    const tectonic = req.backend === 'system' ? null : await this.deps.findTectonic()
    const systemUsable = !!install && (!!install.tools[req.compiler] || install.latexmkWorks)
    let useSystem: boolean
    if (req.backend === 'system') useSystem = true
    else if (req.backend === 'tectonic') useSystem = false
    else useSystem = systemUsable || !tectonic

    if (useSystem && !install) {
      return this.failure(
        'no-engine',
        req.backend === 'system'
          ? 'No TeX distribution was found on this computer. Install TeX Live, MacTeX or MiKTeX, or switch the TeX engine to "Built-in" in Menu > Settings.'
          : 'No TeX engine is available. Install TeX Live, MacTeX or MiKTeX and recompile.',
        started,
        req.rootDoc
      )
    }
    if (!useSystem && !tectonic) {
      return this.failure(
        'no-engine',
        'The built-in TeX engine is not part of this build. Install TeX Live, MacTeX or MiKTeX, or run "npm run fetch:tectonic" when working from source.',
        started,
        req.rootDoc
      )
    }

    // Engine output can arrive in bursts; forward at most one line per
    // interval, always ending with the most recent one.
    const progress: { timer: NodeJS.Timeout | null; pending: string | null } = { timer: null, pending: null }
    const flushProgress = (): void => {
      progress.timer = null
      if (progress.pending === null) return
      const line = progress.pending
      progress.pending = null
      this.deps.onProgress(req.projectDir, line, false)
      progress.timer = setTimeout(flushProgress, 100)
    }
    const ctx: EngineContext = {
      workRoot: paths.work,
      mainDir: mainDirAbs,
      mainBase,
      compiler: req.compiler,
      stopOnFirstError: req.stopOnFirstError,
      useProjectRc,
      timeoutMs: COMPILE_TIMEOUT_MS,
      onLine: (line) => {
        if (PROGRESS_NOISE.test(line) || PROGRESS_SKIP.test(line)) return
        progress.pending = line.length > 300 ? line.slice(0, 300) : line
        if (progress.timer === null) flushProgress()
      },
      notice: (text) => this.deps.onProgress(req.projectDir, text, true),
      onSpawn: (kill) => {
        job.kill = kill
        if (job.stopped) kill()
      },
      isStopped: () => job.stopped
    }

    // Remember what the PDF and the log looked like before the run, to tell
    // newly written files from ones left over by an earlier compile.
    const expectedJob = useSystem ? 'output' : mainBase.replace(/\.[^.]+$/, '')
    const previous = await readJson<OutputState>(paths.state)
    const pdfBefore = await fs.stat(path.join(mainDirAbs, `${expectedJob}.pdf`)).catch(() => null)
    const logBefore = await fs.stat(path.join(mainDirAbs, `${expectedJob}.log`)).catch(() => null)

    let run: EngineRun
    let engine: EngineInfo
    let usedLatexmk = false
    if (useSystem && install) {
      if (install.latexmkWorks) {
        usedLatexmk = true
        run = await runLatexmk(ctx, install, this.deps.latexmkrc)
        engine = { backend: 'system', label: `${compilerLabel(req.compiler)} via latexmk (${install.distribution})` }
      } else {
        run = await runManual(ctx, install)
        engine = { backend: 'system', label: `${compilerLabel(req.compiler)} (${install.distribution})` }
      }
    } else {
      run = await runTectonic(ctx, tectonic as string, await this.tectonicMemo(), paths.base)
      engine = { backend: 'tectonic', label: 'Built-in engine (Tectonic, XeTeX-based)' }
    }

    if (progress.timer !== null) clearTimeout(progress.timer)
    progress.timer = null
    progress.pending = null

    // ---- collect the results
    this.synctexCache.delete(paths.base)

    const outFile = (ext: string): string => path.join(mainDirAbs, `${run.jobname}.${ext}`)
    const logText = await readLog(outFile('log'))
    const parseCtx: ParseContext = { resolveFile: await this.resolver(paths.work, mainDirAbs, synced.files) }

    let entries: LogEntry[] = logText ? parseLatexLog(logText, parseCtx) : []
    const blg = await readLog(outFile('blg'))
    if (blg) entries.push(...parseBibLog(blg, parseCtx))
    if (engine.backend === 'tectonic') {
      // Tectonic reports problems on its console that never reach the TeX log.
      // With a log, only keep console errors that are about the engine itself.
      const known = new Set(entries.map((e) => e.message))
      const fromConsole = parseEngineOutput(run.output, parseCtx, logText !== '')
      entries.push(
        ...fromConsole.filter((e) => !known.has(e.message) && (logText === '' || e.level === 'error'))
      )
      if (run.exitCode !== 0 && isNetworkFailure(run.output)) {
        entries.unshift({
          level: 'error',
          source: 'engine',
          message:
            'The built-in engine could not download the TeX files it needs. It fetches packages the first time they are used; check your internet connection and recompile. Projects compile offline once their packages are cached.'
        })
      }
    }

    // A missing file calls for different advice depending on what kind of file
    // it is and on which engine was asked for it.
    for (const entry of entries) {
      const missing = isMissingFileError(entry) ? MISSING_FILE_NAME.exec(entry.message) : null
      if (!missing) continue
      if (!PACKAGE_FILE.test(missing[1])) entry.hint = HINT_OWN_FILE
      else if (engine.backend === 'system') entry.hint = HINT_SYSTEM
      else entry.hint = run.offline ? HINT_BUILTIN_OFFLINE : HINT_BUILTIN
    }

    let pdfVersion = 0
    let pdfFresh = false
    try {
      const st = await fs.stat(outFile('pdf'))
      if (st.isFile() && st.size > 0) {
        pdfVersion = Math.round(st.mtimeMs)
        pdfFresh =
          run.jobname !== expectedJob ||
          !pdfBefore ||
          st.mtimeMs !== pdfBefore.mtimeMs ||
          st.size !== pdfBefore.size
      }
    } catch {
      /* no PDF */
    }

    // latexmk does not run the engine again when nothing changed since a run
    // that had errors; it just reports failure once more. The log is then
    // untouched, and whatever the earlier run produced still stands.
    const logAfter = await fs.stat(outFile('log')).catch(() => null)
    const engineRan =
      run.jobname !== expectedJob ||
      !logBefore ||
      !logAfter ||
      logAfter.mtimeMs !== logBefore.mtimeMs ||
      logAfter.size !== logBefore.size

    // A compile that was stopped or timed out has no result. If the engine was
    // rewriting the PDF at that moment the file is cut short: remove it.
    const interrupted = job.stopped || run.timedOut
    if (interrupted && pdfFresh) {
      await fs.rm(outFile('pdf'), { force: true }).catch(() => undefined)
      pdfVersion = 0
    }
    // A PDF left over from an earlier run only counts if this run did not fail.
    const hasPdf =
      !interrupted &&
      pdfVersion > 0 &&
      (pdfFresh || run.exitCode === 0 || (!engineRan && previous?.hasPdf === true))

    const state: OutputState = {
      mainDir: mainDirRel,
      jobname: run.jobname,
      rootDoc: req.rootDoc,
      hasPdf: interrupted ? pdfVersion > 0 && previous?.hasPdf === true : hasPdf
    }
    await writeJson(paths.state, state).catch(() => undefined)

    let status: CompileResult['status']
    if (job.stopped) status = 'stopped'
    else if (run.timedOut) status = 'timedout'
    else if (run.spawnError) status = 'error'
    else if (run.exitCode === 0 && hasPdf && !entries.some((e) => e.level === 'error')) status = 'success'
    else status = 'failure'

    if (status === 'timedout') {
      entries.unshift({
        level: 'error',
        source: 'engine',
        message: `The compile was stopped after ${Math.round(COMPILE_TIMEOUT_MS / 60000)} minutes. An infinite loop in the document is the usual cause.`
      })
    } else if (status === 'error') {
      entries.unshift({
        level: 'error',
        source: 'engine',
        message: `The TeX engine could not be started: ${run.spawnError}`
      })
    } else if (status === 'failure' && !entries.some((e) => e.level === 'error')) {
      entries.unshift({
        level: 'error',
        source: 'engine',
        message: hasPdf
          ? 'The compiler reported a problem. See the raw log below for details.'
          : 'No PDF was produced. See the raw log below for details.'
      })
    }

    const consoleText = run.output
      .split(/\r?\n/)
      .filter((l) => !PROGRESS_NOISE.test(l))
      .join('\n')
      .trim()
    const rawLog =
      logText && engine.backend === 'system'
        ? clip(logText, MAX_RAW_LOG)
        : clip([logText, consoleText && `--- engine output ---\n${consoleText}`].filter(Boolean).join('\n\n'), MAX_RAW_LOG)

    return {
      status,
      hasPdf,
      pdfVersion: hasPdf ? pdfVersion : 0,
      entries,
      rawLog,
      engine,
      durationMs: Date.now() - started,
      rootDoc: req.rootDoc,
      counts: countEntries(entries),
      rcIgnored: usedLatexmk && projectHasRc && !useProjectRc
    }
  }

  // ----------------------------------------------------------- output

  async pdfPath(projectDir: string): Promise<string | null> {
    const out = await this.outputOf(projectDir)
    if (!out) return null
    const file = path.join(out.dir, `${out.jobname}.pdf`)
    return (await exists(file)) ? file : null
  }

  async readPdf(projectDir: string): Promise<{ data: Buffer; version: number } | null> {
    const file = await this.pdfPath(projectDir)
    if (!file) return null
    try {
      const st = await fs.stat(file)
      if (st.size === 0) return null
      return { data: await fs.readFile(file), version: Math.round(st.mtimeMs) }
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------- synctex

  private async synctex(projectDir: string): Promise<{
    data: SynctexData
    resolve: (p: string) => string | null
  } | null> {
    const out = await this.outputOf(projectDir)
    if (!out) return null
    let file = path.join(out.dir, `${out.jobname}.synctex.gz`)
    if (!(await exists(file))) {
      file = path.join(out.dir, `${out.jobname}.synctex`)
      if (!(await exists(file))) return null
    }
    const st = await fs.stat(file)
    let cached = this.synctexCache.get(out.paths.base)
    if (!cached || cached.mtimeMs !== st.mtimeMs) {
      cached = { mtimeMs: st.mtimeMs, data: await loadSynctex(file) }
      this.synctexCache.set(out.paths.base, cached)
    }
    const manifest = await readJson<{ files: Record<string, unknown> }>(out.paths.manifest)
    const resolve = await this.resolver(out.paths.work, out.dir, Object.keys(manifest?.files ?? {}))
    return { data: cached.data, resolve }
  }

  async syncToPdf(projectDir: string, file: string, line: number): Promise<PdfRect[]> {
    const sync = await this.synctex(projectDir)
    if (!sync) return []
    const tags = tagsFor(sync.data, file, sync.resolve, CASE_INSENSITIVE)
    return sourceToPdf(sync.data, tags, line)
  }

  async syncToSource(projectDir: string, page: number, x: number, y: number): Promise<SourceLocation | null> {
    const sync = await this.synctex(projectDir)
    if (!sync) return null
    const hit = pdfToSource(sync.data, page, x, y)
    if (!hit) return null
    const file = sync.resolve(hit.input)
    return file ? { file, line: hit.line, column: 0 } : null
  }
}
