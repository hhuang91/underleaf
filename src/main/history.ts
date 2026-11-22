// Version history of a project, kept in git.
//
// A version is a commit. Which commits Underleaf writes, and where, depends on
// whose repository the project folder is:
//
// - No repository: Underleaf creates one in the project folder the first time
//   a version is saved, and marks it as its own. Versions that the user saves
//   by name are ordinary commits on its branch, visible to every git tool.
// - A repository that was already there (also one that the project is only a
//   sub-folder of): its branches and its index are never written to.
//
// In both cases the automatic versions, and in the second case the named ones
// as well, are commits that only a ref below refs/underleaf/ points at. They
// are in no branch's history (only `git log --all` and tools that show every
// ref list them) and are not pushed by default. The routine ones are thinned
// out over time by deleting their refs; the copies made before something
// replaces the project's files are kept.
//
// The trees of all these commits are built here, from the files in the folder
// and by one piece of code, so that two versions of the same files are equal.
// Which files those are is decided the way git decides it: by the ignore rules,
// except for files that the repository's branch already has.
//
// No Electron imports: the module is unit-tested under plain Node.

import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp, { type FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import ignore, { type Ignore } from 'ignore'
import * as git from 'isomorphic-git'
import { IGNORED_NAMES, kindOfFile, mimeOfImage } from '@shared/fileTypes'
import type {
  HistoryList,
  HistorySettings,
  RestoreResult,
  VersionChange,
  VersionFile,
  VersionInfo,
  VersionRef
} from '@shared/types'
import { assertContained, decodeText } from './files'
import { exists, isInside, resolveInside, samePath, toPosix, writeFileAtomic } from './util/fsx'

const deflate = promisify(zlib.deflate)

/** Why the app saved a version by itself. */
export type AutoReason = 'open' | 'edits' | 'close' | 'before-restore' | 'before-import' | 'after-import'

export interface HistoryDeps {
  settings(): HistorySettings
  /** A version was added to the project in this folder. */
  onChanged?(dir: string): void
  /**
   * Where the user's own git configuration is looked for: their name for the
   * commits, and the ignore rules they have for every repository.
   */
  homeDir?: string
  now?(): number
}

interface Repo {
  /** The project folder. */
  dir: string
  /** The work tree of the repository: the project folder or a folder above it. */
  root: string
  gitdir: string
  /** POSIX path of the project folder below `root`; empty when it is the root. */
  prefix: string
  /** Created by Underleaf: versions saved by name are commits on its branch. */
  managed: boolean
}

type Located =
  | { kind: 'repo'; repo: Repo }
  | { kind: 'none' }
  | { kind: 'unsupported'; reason: string }

interface FileState {
  oid: string
  /** Git's file mode: 100644, 100755 (executable) or 120000 (a link). */
  mode: string
}

/** Every file of one state of the project, by its POSIX path. */
type FileMap = Map<string, FileState>

interface StatEntry {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
  oid: string
}

interface Tracker {
  /** The project folder (it can be renamed while the count goes on). */
  dir: string
  timer: NodeJS.Timeout | null
  /** Completed edits since the last version. */
  edits: number
  /** Something changed since the last completed edit. */
  pending: boolean
  /** A version for the edits counted so far is being saved. */
  saving: boolean
}

/**
 * Where a version's ref lives. 'auto' holds the routine automatic versions,
 * which are thinned out with time. 'kept' holds the copies made before and
 * after something replaced the project's files: they are what makes a restore
 * or an import undoable, so they stay. 'named' is what the user saved by name
 * in a repository that is not Underleaf's own.
 */
type RefKind = 'auto' | 'kept' | 'named'

interface Version extends VersionInfo {
  /** Where it is kept: below one of this app's refs, or on the repository's branch. */
  store: RefKind | 'branch'
}

/** The project as it is in its folder, next to the newest version of it. */
interface State {
  latest: Version | undefined
  /** The files of `latest`; undefined when there is none or it cannot be read. */
  before: FileMap | undefined
  files: FileMap
}

const REF_KINDS: readonly RefKind[] = ['auto', 'kept', 'named']
const REF_BASE = 'refs/underleaf'
const OID = /^[0-9a-f]{40}$/
const STAMP = /^\d{8}T\d{9}Z$/
/** Files beyond this size are left out of versions (a version holds a copy of every file). */
const MAX_FILE_BYTES = 100 * 1024 * 1024
/** More files than this are more than a project has; something else is in the folder. */
const MAX_FILES = 20_000
/**
 * A file that was modified this recently is read again next time even when
 * its size and time are unchanged: some file systems keep times to two
 * seconds only, and a second change within them would go unnoticed.
 */
const SETTLED_MS = 3000
/** Where what is known about the files of a project is kept between sessions. */
const STAT_CACHE = 'underleaf-files.json'
/** Larger text is not shown as a difference, larger pictures not at all. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
/** Automatic versions that are younger than this are all kept. */
const KEEP_ALL_MS = 48 * 60 * 60 * 1000
const MAX_AUTO_VERSIONS = 1000
/** How long what the library read from a repository is held on to. */
const CACHE_MS = 5 * 60 * 1000
/** Errors of a file that another program has open at the moment (Windows). */
const LOCK_ERRORS: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES'])
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

const EXCLUDE = `# Files that Underleaf leaves out of a project's versions.
.underleaf.json
.DS_Store
Thumbs.db
desktop.ini
__MACOSX/
`

const LABELS: Record<AutoReason, (detail: string, first: boolean) => string> = {
  open: (_d, first) => (first ? 'First version' : 'On opening the project'),
  edits: () => 'Automatic version',
  close: () => 'On closing the project',
  'before-restore': () => 'Before restoring an earlier version',
  'before-import': (d) => `Before updating from ${d || 'an archive'}`,
  'after-import': (d) => `Updated from ${d || 'an archive'}`
}

/** The versions that are made in the ordinary course of work, as opposed to safety copies. */
const ROUTINE: ReadonlySet<AutoReason> = new Set(['open', 'edits', 'close'])

const errorCode = (err: unknown): string => (err as NodeJS.ErrnoException)?.code ?? ''
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const present = (p: string): Promise<boolean> => fsp.lstat(p).then(() => true, () => false)
/** On a file system that does not tell "Notes.tex" from "notes.tex", the two are one file here as well. */
const fold = (p: string): string => (CASE_INSENSITIVE ? p.toLowerCase() : p)
const published = ({ store: _store, ...info }: Version): VersionInfo => info

/** Runs a file operation again a few times while another program holds the file (Windows). */
async function steadily<T>(op: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await op()
    } catch (err) {
      if (!LOCK_ERRORS.has(errorCode(err)) || attempt >= 5) throw err
      await sleep(80 * attempt)
    }
  }
}

function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

function sameBytesIgnoringLineEnds(a: Uint8Array, b: Uint8Array): boolean {
  let i = 0
  let j = 0
  for (;;) {
    if (i < a.length && a[i] === 13 && a[i + 1] === 10) i++
    if (j < b.length && b[j] === 13 && b[j + 1] === 10) j++
    if (i >= a.length || j >= b.length) return i >= a.length && j >= b.length
    if (a[i] !== b[j]) return false
    i++
    j++
  }
}

/** How the lines of a text end, when they all end the same way. */
function lineEnds(text: Uint8Array): 'crlf' | 'lf' | null {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== 10) continue
    if (i > 0 && text[i - 1] === 13) crlf++
    else lf++
  }
  if (crlf > 0 && lf === 0) return 'crlf'
  if (lf > 0 && crlf === 0) return 'lf'
  return null
}

/** The same text with its lines ending the other way. */
function withLineEnds(text: Uint8Array, to: 'crlf' | 'lf'): Uint8Array {
  if (to === 'crlf') {
    let lines = 0
    for (let i = 0; i < text.length; i++) if (text[i] === 10) lines++
    const out = Buffer.allocUnsafe(text.length + lines)
    let j = 0
    for (let i = 0; i < text.length; i++) {
      if (text[i] === 10) out[j++] = 13
      out[j++] = text[i]
    }
    return out
  }
  const out = Buffer.allocUnsafe(text.length)
  let j = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === 13 && text[i + 1] === 10) continue
    out[j++] = text[i]
  }
  return out.subarray(0, j)
}

/**
 * Git LFS keeps a short text file in the repository in place of the real one.
 * Returns what such a pointer says about the real file, or null for any other content.
 */
function lfsPointer(blob: Uint8Array): { sha256: string; size: number } | null {
  if (blob.length > 1024) return null
  const text = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength).toString('utf8')
  if (!text.startsWith('version https://git-lfs.github.com/spec/v1')) return null
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)
  const size = /^size (\d+)$/m.exec(text)
  return oid && size ? { sha256: oid[1], size: Number(size[1]) } : null
}

function isThatFile(pointer: { sha256: string; size: number }, content: Uint8Array): boolean {
  return content.length === pointer.size && createHash('sha256').update(content).digest('hex') === pointer.sha256
}

/**
 * A path from a repository that cannot be a file here. A repository can hold
 * names that git itself would not create, or that mean something else on this
 * system (on Windows "a:b" is a stream of the file "a").
 */
function unusable(rel: string): boolean {
  if (/[\\\0]/.test(rel)) return true
  return rel.split('/').some(
    (part) =>
      part === '' ||
      part === '.' ||
      part === '..' ||
      part.toLowerCase() === '.git' ||
      (process.platform === 'win32' &&
        (/[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || WINDOWS_DEVICE.test(part)))
  )
}

/** "20261121T031501123Z": sorts by time and is a valid part of a ref name. */
function stampOf(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:.]/g, '')
}

function timeOfStamp(stamp: string): number {
  const m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(\d{3})Z/.exec(stamp)
  if (!m) return 0
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7])
}

/**
 * Which automatic versions to let go of. All of the last two days are kept;
 * of older days only the last one of each day, so that the history thins out
 * instead of ending.
 */
export function stampsToDrop(stamps: string[], now: number): string[] {
  const newestFirst = [...stamps].sort().reverse()
  const drop: string[] = []
  const days = new Set<string>()
  let kept = 0
  for (const stamp of newestFirst) {
    const time = timeOfStamp(stamp)
    let keep = now - time <= KEEP_ALL_MS
    if (!keep) {
      const d = new Date(time)
      const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
      keep = !days.has(day)
      days.add(day)
    }
    if (keep && kept < MAX_AUTO_VERSIONS) kept++
    else drop.push(stamp)
  }
  return drop
}

/**
 * The few settings of the user's own git configuration that matter here:
 * their name and address, and where their ignore rules for all repositories
 * are. (Included files are not followed.)
 */
async function globalConfig(home: string, configHome: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  // Git reads them in this order, and a later file overrides an earlier one.
  for (const file of [path.join(configHome, 'git', 'config'), path.join(home, '.gitconfig')]) {
    let text: string
    try {
      text = await fsp.readFile(file, 'utf8')
    } catch {
      continue
    }
    let section = ''
    for (const line of text.split(/\r?\n/)) {
      const head = /^\s*\[\s*([A-Za-z0-9.-]+)[^\]]*\]/.exec(line)
      if (head) {
        section = head[1].toLowerCase()
        continue
      }
      const pair = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*?)\s*$/.exec(line)
      if (!pair || (section !== 'user' && section !== 'core')) continue
      const quoted = /^"(.*)"$/.exec(pair[2])
      const value = (quoted ? quoted[1] : pair[2].replace(/\s+[#;].*$/, '')).trim()
      if (value) out.set(`${section}.${pair[1].toLowerCase()}`, value)
    }
  }
  return out
}

/** Runs `fn` for every item, a few at a time, and stops at the first failure. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  let failed = false
  const worker = async (): Promise<void> => {
    while (next < items.length && !failed) {
      try {
        await fn(items[next++])
      } catch (err) {
        failed = true
        throw err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/** One file with ignore patterns; `base` is the folder its patterns are relative to. */
interface RuleSource {
  /** POSIX path below the repository's root; empty for the root itself. */
  base: string
  rules: Ignore
}

type Verdict = { ignored: boolean; unignored: boolean }

function ruleSource(base: string, text: string): RuleSource | null {
  if (!/^\s*[^#\s]/m.test(text)) return null // nothing but comments
  return { base, rules: ignore({ ignorecase: CASE_INSENSITIVE }).add(text) }
}

/**
 * What one rule file says about a path by itself. The package's public `test`
 * also answers for the folders above the path, going by that one file; here
 * it is the caller that keeps track of ignored folders, across all rule files,
 * which is how git does it. (A folder ignored by one file can be taken back
 * in by a more specific one, and what is in it is then judged on its own.)
 */
function verdictOf(rules: Ignore, local: string): Verdict {
  const own = (rules as unknown as { _testOne?: (path: string, checkUnignored: boolean) => Verdict })._testOne
  if (typeof own === 'function') return own.call(rules, local, true)
  try {
    return rules.test(local)
  } catch {
    return { ignored: false, unignored: false } // a name the matcher cannot take
  }
}

/**
 * Tells whether git's rules ignore a path, given that the folder it is in is
 * not ignored. `sources` are the rule files that apply in that folder, least
 * specific first: a later one overrides an earlier one, and within one file
 * the last matching line decides.
 */
function ignoredBy(sources: RuleSource[], rootRel: string, isDir: boolean): boolean {
  let out = false
  for (const source of sources) {
    const local = source.base ? rootRel.slice(source.base.length + 1) : rootRel
    const verdict = verdictOf(source.rules, isDir ? `${local}/` : local)
    if (verdict.ignored) out = true
    else if (verdict.unignored) out = false
  }
  return out
}

export class HistoryManager {
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly trackers = new Map<string, Tracker>()
  /** What is known about each file as it was last read, per project folder. */
  private readonly stats = new Map<string, Map<string, StatEntry>>()
  private readonly trees = new Map<string, FileMap>()
  /** The library's own cache of what it read from a repository, per git folder. */
  private readonly caches = new Map<string, { made: number; cache: object }>()
  private readonly home: string
  private readonly configHome: string

  constructor(private readonly deps: HistoryDeps) {
    this.home = deps.homeDir ?? os.homedir()
    this.configHome = deps.homeDir
      ? path.join(deps.homeDir, '.config')
      : process.env['XDG_CONFIG_HOME'] || path.join(this.home, '.config')
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /** One operation at a time per project folder. */
  private queue<T>(dir: string, op: () => Promise<T>): Promise<T> {
    const key = path.resolve(dir)
    const run = (this.chains.get(key) ?? Promise.resolve()).then(op, op)
    const tail = run.catch(() => undefined)
    this.chains.set(key, tail)
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key)
    })
    return run
  }

  /**
   * Without it the library reads a whole pack file again for every object,
   * which takes seconds in a cloned repository. It is let go of after a while,
   * so that it can neither grow without bound nor go stale.
   */
  private cacheFor(repo: Repo): object {
    const now = Date.now()
    for (const [gitdir, entry] of this.caches) if (now - entry.made > CACHE_MS) this.caches.delete(gitdir)
    let entry = this.caches.get(repo.gitdir)
    if (!entry) this.caches.set(repo.gitdir, (entry = { made: now, cache: {} }))
    return entry.cache
  }

  // ------------------------------------------------------- repository

  private async locate(dir: string): Promise<Located> {
    const project = path.resolve(dir)
    for (let probe = project; ; ) {
      const own = samePath(probe, project)
      const dotGit = path.join(probe, '.git')
      const st = await fsp.lstat(dotGit).catch(() => null)
      // A repository that spans the home folder (for dotfiles) is not about this project.
      if (st && !own && (samePath(probe, this.home) || isInside(probe, this.home))) return { kind: 'none' }
      if (st && !st.isDirectory()) {
        // A file: a linked work tree or a submodule, whose data is elsewhere.
        return {
          kind: 'unsupported',
          reason: own
            ? 'This folder is a linked git work tree or a submodule, which Underleaf cannot keep versions in.'
            : `This project is inside a linked git work tree or submodule (${probe}), which Underleaf cannot keep versions in.`
        }
      }
      if (st) {
        if (!(await exists(path.join(dotGit, 'HEAD')))) {
          // Not, not yet or no longer a repository. In the project folder
          // itself that is nothing to build on, and nothing to replace either;
          // further up it is none of this project's business.
          if (own) {
            return {
              kind: 'unsupported',
              reason: 'This folder has a .git folder that is not a complete repository. Underleaf leaves it alone.'
            }
          }
        } else {
          const config = async (key: string): Promise<string> =>
            String((await git.getConfig({ fs, gitdir: dotGit, path: key }).catch(() => undefined)) ?? '')
          if ((await config('extensions.objectformat')).toLowerCase() === 'sha256') {
            return { kind: 'unsupported', reason: 'This repository uses SHA-256 object names, which Underleaf cannot read.' }
          }
          const refs = (await config('extensions.refstorage')).toLowerCase()
          if (refs && refs !== 'files') {
            // Versions written the way this app writes refs would be invisible to git there.
            return {
              kind: 'unsupported',
              reason: `This repository keeps its refs in the "${refs}" format, which Underleaf cannot write.`
            }
          }
          const repo: Repo = {
            dir: project,
            root: probe,
            gitdir: dotGit,
            prefix: toPosix(path.relative(probe, project)),
            managed: own && (await config('underleaf.managed')) === 'true'
          }
          // A repository that ignores the whole project folder is not about it
          // either; one of the project's own, inside it, is out of its way.
          if (!own && (await this.ignoresProject(repo))) return { kind: 'none' }
          return { kind: 'repo', repo }
        }
      }
      const parent = path.dirname(probe)
      if (parent === probe) return { kind: 'none' }
      probe = parent
    }
  }

  private async create(dir: string): Promise<Repo> {
    const project = path.resolve(dir)
    const gitdir = path.join(project, '.git')
    // Only ever in a folder that has nothing of the kind: an existing .git,
    // whatever state it is in, is somebody's.
    if (await present(gitdir)) throw new Error('This folder already has a .git entry that Underleaf did not create')
    await git.init({ fs, dir: project, gitdir, defaultBranch: 'main' })
    await git.setConfig({ fs, gitdir, path: 'underleaf.managed', value: 'true' })
    // Files are stored byte for byte, whatever the user's git is set to do
    // with line ends elsewhere.
    await git.setConfig({ fs, gitdir, path: 'core.autocrlf', value: false })
    await fsp.mkdir(path.join(gitdir, 'info'), { recursive: true })
    await fsp.writeFile(path.join(gitdir, 'info', 'exclude'), EXCLUDE)
    if (process.platform === 'win32') {
      // Like git itself does on Windows; purely cosmetic. (By its full path:
      // a program of that name in the current folder would be found first.)
      const attrib = path.join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'attrib.exe')
      await promisify(execFile)(attrib, ['+h', gitdir], { windowsHide: true }).catch(() => undefined)
    }
    return { dir: project, root: project, gitdir, prefix: '', managed: true }
  }

  private scopeOf(prefix: string): string {
    if (!prefix) return REF_BASE
    return `${REF_BASE}/in-${createHash('sha1').update(prefix).digest('hex').slice(0, 12)}`
  }

  private scope(repo: Repo): string {
    return this.scopeOf(repo.prefix)
  }

  private async identity(repo: Repo): Promise<{ name: string; email: string }> {
    const local = async (key: string): Promise<string> =>
      String((await git.getConfig({ fs, gitdir: repo.gitdir, path: key }).catch(() => undefined)) ?? '').trim()
    let name = await local('user.name')
    let email = await local('user.email')
    if (!name || !email) {
      const global = await globalConfig(this.home, this.configHome)
      name ||= global.get('user.name') ?? ''
      email ||= global.get('user.email') ?? ''
    }
    if (!name) {
      try {
        name = os.userInfo().username
      } catch {
        name = ''
      }
    }
    return { name: name || 'Underleaf', email: email || 'underleaf@localhost' }
  }

  // ----------------------------------------------------- ignore rules

  /** The rule files that apply to everything in the repository. */
  private async repositoryRules(repo: Repo): Promise<RuleSource[]> {
    const out: RuleSource[] = []
    const add = async (file: string): Promise<void> => {
      const source = ruleSource('', await fsp.readFile(file, 'utf8').catch(() => ''))
      if (source) out.push(source)
    }
    // The user's rules for all their repositories ...
    let excludes = String(
      (await git.getConfig({ fs, gitdir: repo.gitdir, path: 'core.excludesfile' }).catch(() => undefined)) ?? ''
    )
    if (!excludes) excludes = (await globalConfig(this.home, this.configHome)).get('core.excludesfile') ?? ''
    if (excludes.startsWith('~/')) excludes = path.join(this.home, excludes.slice(2))
    await add(excludes || path.join(this.configHome, 'git', 'ignore'))
    // ... and the ones of this repository that are not in a .gitignore.
    await add(path.join(repo.gitdir, 'info', 'exclude'))
    return out
  }

  private async gitignoreOf(dirAbs: string, base: string): Promise<RuleSource | null> {
    return ruleSource(base, await fsp.readFile(path.join(dirAbs, '.gitignore'), 'utf8').catch(() => ''))
  }

  /**
   * The rule files that apply in the project folder, and whether the folder,
   * or one that it is in, is ignored by the repository it is part of.
   */
  private async rulesAbove(repo: Repo): Promise<{ sources: RuleSource[]; ignored: boolean }> {
    let sources = await this.repositoryRules(repo)
    let ignored = false
    const parts = repo.prefix ? repo.prefix.split('/') : []
    for (let i = 0; i < parts.length && !ignored; i++) {
      const own = await this.gitignoreOf(path.join(repo.root, ...parts.slice(0, i)), parts.slice(0, i).join('/'))
      if (own) sources = [...sources, own]
      ignored = ignoredBy(sources, parts.slice(0, i + 1).join('/'), true)
    }
    return { sources, ignored }
  }

  /** The tree of the project folder in the commit that the repository is at, if it has one. */
  private async headTree(repo: Repo): Promise<string | null> {
    const head = await this.headCommit(repo)
    if (!head) return null
    const cache = this.cacheFor(repo)
    try {
      let oid = (await git.readCommit({ fs, gitdir: repo.gitdir, oid: head, cache })).commit.tree
      for (const part of repo.prefix ? repo.prefix.split('/') : []) {
        const { tree } = await git.readTree({ fs, gitdir: repo.gitdir, oid, cache })
        const entry = tree.find((e) => e.type === 'tree' && fold(e.path) === fold(part))
        if (!entry) return null
        oid = entry.oid
      }
      return oid
    } catch {
      return null
    }
  }

  /**
   * What the repository's branch has of the project: git does not ignore a
   * file that it already tracks, whatever the rules say, and neither does this.
   */
  private async tracked(repo: Repo): Promise<{ files: Set<string>; dirs: Set<string> }> {
    const files = new Set<string>()
    const dirs = new Set<string>()
    const tree = await this.headTree(repo)
    if (!tree) return { files, dirs }
    for (const rel of (await this.flatten(repo, tree).catch(() => new Map() as FileMap)).keys()) {
      files.add(fold(rel))
      for (let i = rel.indexOf('/'); i >= 0; i = rel.indexOf('/', i + 1)) dirs.add(fold(rel.slice(0, i)))
    }
    return { files, dirs }
  }

  /**
   * True when the repository that the project is a sub-folder of ignores that
   * folder and has nothing of it.
   */
  private async ignoresProject(repo: Repo): Promise<boolean> {
    if (!repo.prefix || (await this.headTree(repo))) return false
    return (await this.rulesAbove(repo)).ignored
  }

  // ------------------------------------------------------------ files

  /**
   * The files of the project that versions are kept of, as git would pick
   * them. A folder that cannot be listed is an error, not an empty folder: a
   * version that silently lacks files would delete them when it is restored.
   */
  private async listFiles(repo: Repo): Promise<Array<{ rel: string; abs: string }>> {
    const tracked = await this.tracked(repo)
    const above = await this.rulesAbove(repo)
    const rootRel = (rel: string): string => (repo.prefix ? (rel ? `${repo.prefix}/${rel}` : repo.prefix) : rel)
    const out: Array<{ rel: string; abs: string }> = []

    // `excluded`: the folder is ignored, and is only looked into for the files
    // in it that the repository has nevertheless.
    const visit = async (dirAbs: string, rel: string, inherited: RuleSource[], excluded: boolean): Promise<void> => {
      let dirents
      try {
        dirents = await steadily(() => fsp.readdir(dirAbs, { withFileTypes: true }))
      } catch (err) {
        if (errorCode(err) === 'ENOENT' && rel !== '') return // gone since its parent was listed
        throw new Error(`The folder "${rel || path.basename(dirAbs)}" could not be read (${errorCode(err) || String(err)})`)
      }
      // Git reads no rule files below a folder that it ignores.
      const own = excluded ? null : await this.gitignoreOf(dirAbs, rootRel(rel))
      const sources = own ? [...inherited, own] : inherited
      for (const d of dirents) {
        if (d.name === '.git' || IGNORED_NAMES.has(d.name)) continue
        const childRel = rel ? `${rel}/${d.name}` : d.name
        const abs = path.join(dirAbs, d.name)
        if (d.isDirectory()) {
          const ignored = excluded || ignoredBy(sources, rootRel(childRel), true)
          if (ignored && !tracked.dirs.has(fold(childRel))) continue
          // A repository of its own (a submodule, a clone inside the project):
          // its files are its own business and never this project's to touch.
          if (await present(path.join(abs, '.git'))) continue
          await visit(abs, childRel, sources, ignored)
        } else if (d.isFile() || d.isSymbolicLink()) {
          if (!tracked.files.has(fold(childRel)) && (excluded || ignoredBy(sources, rootRel(childRel), false))) continue
          if (out.length >= MAX_FILES) {
            throw new Error(
              `This folder holds more than ${MAX_FILES.toLocaleString('en-US')} files, which is more than a project can have. Move large data or dependency folders out of it, or have git ignore them.`
            )
          }
          out.push({ rel: childRel, abs })
        }
      }
    }
    await visit(repo.dir, '', above.sources, above.ignored)
    return out
  }

  /** Stores a file's content as a git object and returns its id. */
  private async writeBlob(repo: Repo, content: Buffer): Promise<string> {
    const header = Buffer.from(`blob ${content.length}\0`)
    const oid = createHash('sha1').update(header).update(content).digest('hex')
    const file = this.looseObject(repo, oid)
    if (await exists(file)) return oid
    const packed = await deflate(Buffer.concat([header, content]))
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await fsp.writeFile(tmp, packed)
      await fsp.rename(tmp, file)
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined)
      // Written by someone else in the meantime: the content is the same.
      if (!(await exists(file))) throw err
    }
    return oid
  }

  private looseObject(repo: Repo, oid: string): string {
    return path.join(repo.gitdir, 'objects', oid.slice(0, 2), oid.slice(2))
  }

  /**
   * The files in the project folder as they are now, stored in the repository.
   * `previous` is where a file's mode comes from on systems that have none.
   * A file that cannot be read fails the whole thing, for the reason given at
   * `listFiles`.
   */
  private async workingFiles(repo: Repo, previous?: FileMap): Promise<FileMap> {
    const entries = await this.listFiles(repo)
    const cache = await this.statCache(repo)
    let cacheChanged = false
    const seen = new Set<string>()
    const found: Array<[string, FileState]> = []

    await mapLimit(entries, 8, async (entry) => {
      let st
      try {
        st = await fsp.lstat(entry.abs)
      } catch (err) {
        if (errorCode(err) === 'ENOENT') return // gone since the folder was listed
        throw new Error(`"${entry.rel}" could not be read (${errorCode(err) || String(err)})`)
      }
      if (st.isSymbolicLink()) {
        // As git does: the link itself is the content, not what it leads to.
        const target = await fsp.readlink(entry.abs).catch(() => null)
        if (target === null) return
        found.push([entry.rel, { oid: await this.writeBlob(repo, Buffer.from(toPosix(target))), mode: '120000' }])
        return
      }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return
      const mode =
        process.platform === 'win32'
          ? previous?.get(entry.rel)?.mode === '100755'
            ? '100755'
            : '100644'
          : st.mode & 0o111
            ? '100755'
            : '100644'
      seen.add(entry.rel)
      const known = cache.get(entry.rel)
      if (
        known &&
        known.size === st.size &&
        known.mtimeMs === st.mtimeMs &&
        known.ctimeMs === st.ctimeMs &&
        known.ino === st.ino &&
        (await exists(this.looseObject(repo, known.oid)))
      ) {
        found.push([entry.rel, { oid: known.oid, mode }])
        return
      }
      let content: Buffer
      try {
        content = await steadily(() => fsp.readFile(entry.abs))
      } catch (err) {
        if (errorCode(err) === 'ENOENT') {
          seen.delete(entry.rel)
          return
        }
        throw new Error(
          `"${entry.rel}" could not be read (${errorCode(err) || String(err)}). It may be open in another program.`
        )
      }
      const oid = await this.writeBlob(repo, content)
      // Only remembered when the file did not change while it was being read,
      // and not while it is so new that a further change could hide behind
      // the same time stamp.
      const after = await fsp.stat(entry.abs).catch(() => null)
      const settled = Date.now() - st.mtimeMs > SETTLED_MS
      if (settled && after && after.size === st.size && after.mtimeMs === st.mtimeMs && content.length === st.size) {
        cache.set(entry.rel, { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino, oid })
        cacheChanged = true
      } else if (cache.delete(entry.rel)) {
        cacheChanged = true
      }
      found.push([entry.rel, { oid, mode }])
    })

    for (const rel of [...cache.keys()]) {
      if (!seen.has(rel)) {
        cache.delete(rel)
        cacheChanged = true
      }
    }
    if (cacheChanged) await this.storeStatCache(repo, cache)
    return new Map(found.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  }

  private statCacheFile(repo: Repo): string {
    const name = repo.prefix
      ? STAT_CACHE.replace('.json', `-${createHash('sha1').update(repo.prefix).digest('hex').slice(0, 12)}.json`)
      : STAT_CACHE
    return path.join(repo.gitdir, name)
  }

  /**
   * What is known about the project's files from the last time they were
   * read: with it, a file that has not changed is not read again, in this
   * session or the next. It is a convenience; losing it costs time only.
   */
  private async statCache(repo: Repo): Promise<Map<string, StatEntry>> {
    const loaded = this.stats.get(repo.dir)
    if (loaded) return loaded
    const cache = new Map<string, StatEntry>()
    try {
      const stored = JSON.parse(await fsp.readFile(this.statCacheFile(repo), 'utf8')) as {
        version?: number
        files?: Record<string, unknown>
      }
      if (stored.version === 2 && stored.files) {
        for (const [rel, entry] of Object.entries(stored.files)) {
          if (!Array.isArray(entry) || entry.length !== 5) continue
          const [size, mtimeMs, ctimeMs, ino, oid] = entry as unknown[]
          if ([size, mtimeMs, ctimeMs, ino].every((n) => typeof n === 'number') && OID.test(String(oid))) {
            cache.set(rel, { size, mtimeMs, ctimeMs, ino, oid } as StatEntry)
          }
        }
      }
    } catch {
      /* none yet, or unreadable: start empty */
    }
    this.stats.set(repo.dir, cache)
    return cache
  }

  private async storeStatCache(repo: Repo, cache: Map<string, StatEntry>): Promise<void> {
    const files: Record<string, [number, number, number, number, string]> = {}
    for (const [rel, e] of cache) files[rel] = [e.size, e.mtimeMs, e.ctimeMs, e.ino, e.oid]
    await writeFileAtomic(this.statCacheFile(repo), JSON.stringify({ version: 2, files })).catch(() => undefined)
  }

  /** Writes the tree objects for a set of files and returns the id of the top one. */
  private async writeTree(repo: Repo, files: FileMap): Promise<string> {
    interface Dir {
      files: Array<{ name: string; state: FileState }>
      dirs: Map<string, Dir>
    }
    const top: Dir = { files: [], dirs: new Map() }
    for (const [rel, state] of files) {
      const parts = rel.split('/')
      let dir = top
      for (const part of parts.slice(0, -1)) {
        let child = dir.dirs.get(part)
        if (!child) dir.dirs.set(part, (child = { files: [], dirs: new Map() }))
        dir = child
      }
      dir.files.push({ name: parts[parts.length - 1], state })
    }
    const write = async (dir: Dir): Promise<string> => {
      const tree: git.TreeEntry[] = dir.files.map((f) => ({
        mode: f.state.mode,
        path: f.name,
        oid: f.state.oid,
        type: 'blob'
      }))
      for (const [name, child] of dir.dirs) {
        tree.push({ mode: '040000', path: name, oid: await write(child), type: 'tree' })
      }
      return git.writeTree({ fs, gitdir: repo.gitdir, tree })
    }
    return write(top)
  }

  /** Every file of a tree. What Underleaf never shows is left out here too. */
  private async flatten(repo: Repo, treeOid: string): Promise<FileMap> {
    const known = this.trees.get(treeOid)
    if (known) return known
    const out: FileMap = new Map()
    const cache = this.cacheFor(repo)
    const visit = async (oid: string, base: string): Promise<void> => {
      const { tree } = await git.readTree({ fs, gitdir: repo.gitdir, oid, cache })
      for (const entry of tree) {
        if (IGNORED_NAMES.has(entry.path)) continue
        const rel = base ? `${base}/${entry.path}` : entry.path
        if (entry.type === 'tree') await visit(entry.oid, rel)
        else if (entry.type === 'blob') out.set(rel, { oid: entry.oid, mode: entry.mode })
        // 'commit' is a submodule: nothing of it is in this repository.
      }
    }
    await visit(treeOid, '')
    if (this.trees.size >= 40) this.trees.delete(this.trees.keys().next().value as string)
    this.trees.set(treeOid, out)
    return out
  }

  private async filesOfCommit(repo: Repo, oid: string): Promise<FileMap> {
    if (!OID.test(oid)) throw new Error('Unknown version')
    let commit
    try {
      commit = await git.readCommit({ fs, gitdir: repo.gitdir, oid, cache: this.cacheFor(repo) })
    } catch {
      throw new Error('This version is no longer in the repository')
    }
    try {
      return await this.flatten(repo, commit.commit.tree)
    } catch (err) {
      // The library refuses trees with entries such as ".git" or "..", which
      // git itself never writes. Nothing of such a version is used.
      if ((err as { code?: string }).code === 'UnsafeFilepathError') {
        throw new Error('This version contains file names that are not safe to use, so it cannot be shown or restored')
      }
      throw err
    }
  }

  private filesAt(repo: Repo, ref: VersionRef): Promise<FileMap> {
    return ref === 'current' ? this.workingFiles(repo) : this.filesOfCommit(repo, ref)
  }

  // ------------------------------------------------------------- refs

  private async refStamps(repo: Repo, kind: RefKind, scope = this.scope(repo)): Promise<string[]> {
    const names = await git
      .listRefs({ fs, gitdir: repo.gitdir, filepath: `${scope}/${kind}` })
      .catch(() => [] as string[])
    return names.filter((n) => STAMP.test(n)).sort().reverse()
  }

  private async headCommit(repo: Repo): Promise<string | null> {
    return git.resolveRef({ fs, gitdir: repo.gitdir, ref: 'HEAD' }).catch(() => null)
  }

  /**
   * Writes a ref the way git does: into "<ref>.lock", which nobody else may
   * have at the same time, and from there into place in one step. (A ref that
   * also has a line in git's packed-refs file is overruled by its own file.)
   */
  private async writeRef(repo: Repo, ref: string, oid: string): Promise<void> {
    const parts = ref.split('/')
    if (
      parts[0] !== 'refs' ||
      parts.length < 3 ||
      parts.some((p) => p === '' || p === '.' || p === '..' || p.endsWith('.lock'))
    ) {
      throw new Error(`Not a ref name that can be written: ${ref}`)
    }
    const file = path.join(repo.gitdir, ...parts)
    const lock = `${file}.lock`
    await fsp.mkdir(path.dirname(file), { recursive: true })
    let handle: FileHandle | null = null
    for (let attempt = 1; handle === null; attempt++) {
      try {
        handle = await fsp.open(lock, 'wx')
      } catch (err) {
        if (errorCode(err) !== 'EEXIST') throw err
        if (attempt >= 8) {
          throw new Error(`Another program is changing this repository (${lock} is in the way). Try again in a moment.`)
        }
        await sleep(40 * attempt)
      }
    }
    try {
      await handle.writeFile(`${oid}\n`)
      await handle.sync().catch(() => undefined)
      await handle.close()
      handle = null
      await steadily(() => fsp.rename(lock, file))
    } catch (err) {
      await handle?.close().catch(() => undefined)
      await fsp.rm(lock, { force: true }).catch(() => undefined)
      throw err
    }
  }

  /**
   * Deletes refs of this app. A ref can be a file of its own, a line in the
   * packed-refs file that all refs of the repository share, or both. That
   * shared file is only rewritten the way git does it: under its lock, from
   * what it holds at that moment, and replaced in one step. When someone else
   * holds the lock, the lines stay for another time.
   */
  private async deleteRefs(repo: Repo, refs: string[]): Promise<void> {
    const mine = refs.filter((ref) => ref.startsWith(`${REF_BASE}/`))
    if (mine.length === 0) return
    for (const ref of mine) await fsp.rm(path.join(repo.gitdir, ...ref.split('/')), { force: true }).catch(() => undefined)

    const packed = path.join(repo.gitdir, 'packed-refs')
    const gone = new Set(mine)
    const names = (line: string): boolean =>
      !line.startsWith('#') && !line.startsWith('^') && gone.has(line.slice(41).trim())
    if (!(await fsp.readFile(packed, 'utf8').catch(() => '')).split('\n').some(names)) return
    const lock = `${packed}.lock`
    let handle: FileHandle | null = null
    for (let attempt = 1; handle === null; attempt++) {
      try {
        handle = await fsp.open(lock, 'wx')
      } catch {
        // Another project of the same repository is done in a moment. Git may
        // take longer, and then this can wait for another time.
        if (attempt >= 5) return
        await sleep(40 * attempt)
      }
    }
    try {
      const kept: string[] = []
      let dropping = false
      for (const line of (await fsp.readFile(packed, 'utf8')).split('\n')) {
        // "^<id>" belongs to the line above it (the commit a tag stands for).
        if (!line.startsWith('^')) dropping = names(line)
        if (!dropping) kept.push(line)
      }
      await handle.writeFile(kept.join('\n'))
      await handle.sync().catch(() => undefined)
      await handle.close()
      handle = null
      await steadily(() => fsp.rename(lock, packed))
    } catch {
      await handle?.close().catch(() => undefined)
      await fsp.rm(lock, { force: true }).catch(() => undefined)
    }
  }

  // --------------------------------------------------------- versions

  /** Newest first. Commits of the repository's branch count as versions saved by name. */
  private async versions(repo: Repo, max: number): Promise<Version[]> {
    const cache = this.cacheFor(repo)
    const out: Version[] = []
    for (const kind of REF_KINDS) {
      for (const stamp of (await this.refStamps(repo, kind)).slice(0, max)) {
        try {
          const oid = await git.resolveRef({ fs, gitdir: repo.gitdir, ref: `${this.scope(repo)}/${kind}/${stamp}` })
          const { commit } = await git.readCommit({ fs, gitdir: repo.gitdir, oid, cache })
          out.push({
            id: oid,
            kind: kind === 'named' ? 'named' : 'auto',
            label: commit.message.split('\n')[0].trim() || '(no description)',
            time: timeOfStamp(stamp) || commit.committer.timestamp * 1000,
            author: commit.author.name,
            onBranch: false,
            store: kind
          })
        } catch {
          /* a ref that leads nowhere is not a version */
        }
      }
    }
    // The history of a repository that the project is only a part of is not
    // the history of the project.
    if (!repo.prefix) {
      const log = await git.log({ fs, gitdir: repo.gitdir, ref: 'HEAD', depth: max, cache }).catch(() => [])
      for (const { oid, commit } of log) {
        out.push({
          id: oid,
          kind: 'named',
          label: commit.message.split('\n')[0].trim() || '(no description)',
          time: commit.committer.timestamp * 1000,
          author: commit.author.name,
          onBranch: true,
          store: 'branch'
        })
      }
    }
    // Commit times are whole seconds. Within one second, a commit on the
    // branch is taken to be the later one: it is what the user did last.
    const second = (v: VersionInfo): number => Math.floor(v.time / 1000)
    out.sort((a, b) => second(b) - second(a) || Number(b.onBranch) - Number(a.onBranch) || b.time - a.time)
    return out.slice(0, max)
  }

  private async commit(repo: Repo, files: FileMap, message: string, parent: string | null): Promise<string> {
    const who = {
      ...(await this.identity(repo)),
      timestamp: Math.floor(this.now() / 1000),
      timezoneOffset: new Date(this.now()).getTimezoneOffset()
    }
    return git.writeCommit({
      fs,
      gitdir: repo.gitdir,
      commit: {
        message: `${message.trim()}\n`,
        tree: await this.writeTree(repo, files),
        parent: parent ? [parent] : [],
        author: who,
        committer: who
      }
    })
  }

  /** Points a new ref below refs/underleaf/ at the commit and returns the time it stands for. */
  private async keep(repo: Repo, kind: RefKind, oid: string): Promise<number> {
    const taken = new Set(await this.refStamps(repo, kind))
    let time = this.now()
    while (taken.has(stampOf(time))) time++
    await this.writeRef(repo, `${this.scope(repo)}/${kind}/${stampOf(time)}`, oid)
    return time
  }

  private async thinOut(repo: Repo): Promise<void> {
    const drop = stampsToDrop(await this.refStamps(repo, 'auto'), this.now())
    await this.deleteRefs(repo, drop.map((stamp) => `${this.scope(repo)}/auto/${stamp}`))
  }

  private sameFiles(a: FileMap, b: FileMap): boolean {
    if (a.size !== b.size) return false
    for (const [rel, state] of a) if (b.get(rel)?.oid !== state.oid) return false
    return true
  }

  /** The edits counted so far: they are what a version that is saved now covers. */
  private counted(dir: string): number {
    return this.trackers.get(path.resolve(dir))?.edits ?? 0
  }

  /** Takes the edits that a version covers off the count. One that ended in the meantime stays on it. */
  private settle(dir: string, counted: number): void {
    const tracker = this.trackers.get(path.resolve(dir))
    if (tracker) tracker.edits = Math.max(0, tracker.edits - counted)
  }

  private async look(repo: Repo): Promise<State> {
    const [latest] = await this.versions(repo, 1)
    const before = latest ? await this.filesOfCommit(repo, latest.id).catch(() => undefined) : undefined
    return { latest, before, files: await this.workingFiles(repo, before) }
  }

  /** Keeps the state as a version of the app's own. Null: there was nothing new to keep. */
  private async saveState(repo: Repo, state: State, reason: AutoReason, detail: string): Promise<VersionInfo | null> {
    const { latest, before, files } = state
    const routine = ROUTINE.has(reason)
    // Nothing to keep when the newest version already is what is in the folder
    // -- unless that version is one of those that are let go of some day, and
    // this is to be the copy that something can be undone with.
    const undo = reason === 'before-restore' || reason === 'before-import'
    if (before && this.sameFiles(before, files) && !(undo && latest?.store === 'auto')) return null
    if (!latest && files.size === 0) return null
    const label = LABELS[reason](detail, !latest)
    const head = repo.prefix ? null : await this.headCommit(repo)
    const oid = await this.commit(repo, files, label, head)
    const time = await this.keep(repo, routine ? 'auto' : 'kept', oid)
    if (routine) await this.thinOut(repo)
    return { id: oid, kind: 'auto', label, time, author: (await this.identity(repo)).name, onBranch: false }
  }

  /**
   * Saves a version on the app's own initiative. Resolves with null when there
   * was nothing new to save, or when automatic versions are off and the project
   * has no history that a safety copy could be added to.
   */
  saveAuto(dir: string, reason: AutoReason, detail = ''): Promise<VersionInfo | null> {
    return this.queue(dir, async () => {
      // Versions in the ordinary course of work are what the setting turns
      // off. The ones around an import or a restore are safety copies, and
      // are still made for a project that has a history.
      if (ROUTINE.has(reason) && !this.deps.settings().auto) return null
      if (!(await exists(dir))) return null
      const located = await this.locate(dir)
      if (located.kind === 'unsupported') return null
      let repo: Repo
      if (located.kind === 'repo') repo = located.repo
      else if (!this.deps.settings().auto || reason === 'before-restore') return null
      else repo = await this.create(dir)
      const counted = this.counted(dir)
      const version = await this.saveState(repo, await this.look(repo), reason, detail)
      // Edits that changed nothing that versions are kept of are done with too.
      this.settle(dir, counted)
      if (version) this.deps.onChanged?.(repo.dir)
      return version
    })
  }

  /** Saves the project as it is now under a name the user chose. */
  saveNamed(dir: string, label: string): Promise<VersionInfo> {
    return this.queue(dir, async () => {
      const name = String(label ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
      if (!name) throw new Error('Give the version a name')
      if (!(await exists(dir))) throw new Error('The project folder no longer exists')
      const located = await this.locate(dir)
      if (located.kind === 'unsupported') throw new Error(located.reason)
      const repo = located.kind === 'repo' ? located.repo : await this.create(dir)
      const counted = this.counted(repo.dir)
      const head = repo.prefix ? null : await this.headCommit(repo)
      const before = head ? await this.filesOfCommit(repo, head).catch(() => undefined) : undefined
      const files = await this.workingFiles(repo, before)
      if (files.size === 0) {
        throw new Error('There is nothing to save: this project has no files that versions are kept of.')
      }
      const author = (await this.identity(repo)).name
      let branch: string | null = null
      if (repo.managed) {
        branch = (await git.currentBranch({ fs, gitdir: repo.gitdir, fullname: true }).catch(() => undefined)) ?? null
        if (branch && !branch.startsWith('refs/heads/')) branch = null
      }

      const oid = await this.commit(repo, files, name, head)
      if (!branch) {
        // Not Underleaf's repository (or its HEAD is not on a branch): the
        // version is kept beside the branches.
        const time = await this.keep(repo, 'named', oid)
        this.settle(repo.dir, counted)
        this.deps.onChanged?.(repo.dir)
        return { id: oid, kind: 'named', label: name, time, author, onBranch: false }
      }

      await this.writeRef(repo, branch, oid)
      // Bring git's index in line, so that `git status` reports a clean folder:
      // every path whose content or mode is new, and every path the index
      // still has that the commit does not.
      const changed = new Set<string>()
      for (const [rel, state] of files) {
        const old = before?.get(rel)
        if (old?.oid !== state.oid || old.mode !== state.mode) changed.add(rel)
      }
      const cache = {}
      const indexed = await git.listFiles({ fs, dir: repo.dir, gitdir: repo.gitdir, cache }).catch(() => [] as string[])
      for (const rel of indexed) if (!files.has(rel)) changed.add(rel)
      // The files that are there go in with one call, which writes the index
      // once; doing it file by file takes minutes for a few thousand files.
      // (`force`: what is in the commit belongs in the index, whatever the
      // ignore rules say about it.)
      const there = [...changed].filter((rel) => files.has(rel))
      if (there.length > 0) {
        await git
          .add({ fs, dir: repo.dir, gitdir: repo.gitdir, filepath: there, parallel: true, force: true, cache })
          .catch(() => undefined)
      }
      for (const rel of changed) {
        if (files.has(rel)) continue
        await git.resetIndex({ fs, dir: repo.dir, gitdir: repo.gitdir, filepath: rel, cache }).catch(() => undefined)
      }
      this.settle(repo.dir, counted)
      this.deps.onChanged?.(repo.dir)
      return { id: oid, kind: 'named', label: name, time: Math.floor(this.now() / 1000) * 1000, author, onBranch: true }
    })
  }

  list(dir: string, limit = 200): Promise<HistoryList> {
    return this.queue(dir, async () => {
      const located = await this.locate(dir)
      if (located.kind === 'unsupported') {
        return { repository: 'unsupported', reason: located.reason, versions: [], more: false }
      }
      if (located.kind === 'none') return { repository: 'none', versions: [], more: false }
      const max = Math.min(2000, Math.max(1, Math.round(limit)))
      const versions = await this.versions(located.repo, max + 1)
      return {
        repository: located.repo.managed ? 'own' : 'yours',
        versions: versions.slice(0, max).map(published),
        more: versions.length > max
      }
    })
  }

  private async requireRepo(dir: string): Promise<Repo> {
    const located = await this.locate(dir)
    if (located.kind === 'unsupported') throw new Error(located.reason)
    if (located.kind === 'none') throw new Error('This project has no versions yet')
    return located.repo
  }

  private async readBlob(repo: Repo, oid: string): Promise<Uint8Array> {
    return (await git.readBlob({ fs, gitdir: repo.gitdir, oid, cache: this.cacheFor(repo) })).blob
  }

  /** Git LFS has been at work in this repository, so files in it may be stored as pointers. */
  private usesLfs(repo: Repo): Promise<boolean> {
    return exists(path.join(repo.gitdir, 'lfs'))
  }

  /**
   * True when two stored contents are the same file as far as the user is
   * concerned although their bytes differ: text that differs in its line ends
   * only (a repository may hold LF for a file that has CRLF in the folder), or
   * a Git LFS pointer and the file it stands for.
   */
  private async sameForTheUser(repo: Repo, a: string, b: string, rel: string, lfs: boolean): Promise<boolean> {
    if (a === b) return true
    const kind = kindOfFile(rel)
    const textual = kind === 'text' || kind === 'unknown'
    if (!textual && !lfs) return false
    const [x, y] = await Promise.all([this.readBlob(repo, a), this.readBlob(repo, b)])
    if (lfs) {
      const px = lfsPointer(x)
      const py = lfsPointer(y)
      if (px && !py) return isThatFile(px, y)
      if (py && !px) return isThatFile(py, x)
    }
    return textual && !looksBinary(x) && !looksBinary(y) && sameBytesIgnoringLineEnds(x, y)
  }

  /**
   * The file of that name in a state. `loosely`: when the state is compared
   * with the folder, on a system where "Intro.tex" and "intro.tex" are one
   * file there, a name that differs in case only is that file as well.
   */
  private pick(files: FileMap, rel: string, loosely: boolean): [string, FileState] | undefined {
    const exact = files.get(rel)
    if (exact) return [rel, exact]
    if (!loosely) return undefined
    for (const entry of files) if (fold(entry[0]) === fold(rel)) return entry
    return undefined
  }

  /** The files that differ between two states. `from` null stands for an empty project. */
  changes(dir: string, from: VersionRef | null, to: VersionRef): Promise<VersionChange[]> {
    return this.queue(dir, async () => {
      const repo = await this.requireRepo(dir)
      const a: FileMap = from === null ? new Map() : await this.filesAt(repo, from)
      const b = await this.filesAt(repo, to)
      const lfs = await this.usesLfs(repo)
      const loosely = CASE_INSENSITIVE && (from === 'current' || to === 'current')
      const out: VersionChange[] = []
      const older = new Map(a)
      const unpaired: Array<[string, FileState]> = []
      const compare = async (rel: string, old: FileState, state: FileState): Promise<void> => {
        if (old.oid !== state.oid && !(await this.sameForTheUser(repo, old.oid, state.oid, rel, lfs))) {
          out.push({ path: rel, status: 'modified' })
        }
      }
      for (const [rel, state] of b) {
        const old = older.get(rel)
        if (!old) unpaired.push([rel, state])
        else {
          older.delete(rel)
          await compare(rel, old, state)
        }
      }
      for (const [rel, state] of unpaired) {
        const twin = loosely ? this.pick(older, rel, true) : undefined
        if (!twin) out.push({ path: rel, status: 'added' })
        else {
          older.delete(twin[0])
          await compare(rel, twin[1], state)
        }
      }
      for (const rel of older.keys()) out.push({ path: rel, status: 'deleted' })
      return out.sort((p, q) => (p.path < q.path ? -1 : p.path > q.path ? 1 : 0))
    })
  }

  /** One file in two states. */
  file(dir: string, from: VersionRef | null, to: VersionRef, rel: string): Promise<VersionFile> {
    return this.queue(dir, async () => {
      const repo = await this.requireRepo(dir)
      const loosely = CASE_INSENSITIVE && (from === 'current' || to === 'current')
      const a = from === null ? undefined : this.pick(await this.filesAt(repo, from), rel, loosely)?.[1]
      const b = this.pick(await this.filesAt(repo, to), rel, loosely)?.[1]
      if (!a && !b) throw new Error('This file is in neither of the two versions')
      const [before, after] = await Promise.all([
        a ? this.readBlob(repo, a.oid) : null,
        b ? this.readBlob(repo, b.oid) : null
      ])
      const sides = [before, after].filter((x): x is Uint8Array => x !== null)
      const lfs = await this.usesLfs(repo)
      const pointer = (x: Uint8Array): ReturnType<typeof lfsPointer> => (lfs ? lfsPointer(x) : null)
      const kind = kindOfFile(rel)
      // A Git LFS pointer is text, but not the text (or the picture) of the file.
      if (!sides.some((x) => pointer(x))) {
        if (kind === 'image' && sides.every((x) => x.length <= MAX_IMAGE_BYTES)) {
          return { kind: 'image', mime: mimeOfImage(rel), before, after }
        }
        if ((kind === 'text' || kind === 'unknown') && sides.every((x) => x.length <= MAX_TEXT_BYTES && !looksBinary(x))) {
          const text = (x: Uint8Array | null): string | null =>
            x === null ? null : decodeText(Buffer.from(x.buffer, x.byteOffset, x.byteLength)).text.replace(/\r\n?/g, '\n')
          return { kind: 'text', before: text(before), after: text(after) }
        }
      }
      const size = (x: Uint8Array | null): number | null => (x === null ? null : (pointer(x)?.size ?? x.length))
      return { kind: 'binary', before: size(before), after: size(after) }
    })
  }

  /**
   * Text that takes the place of other text keeps that text's line ends. A
   * repository may hold a file with LF that is in the folder with CRLF, and
   * which of the two a file has is not what a version is restored for.
   */
  private async inTheStyleOf(repo: Repo, content: Uint8Array, replaced: string, rel: string): Promise<Uint8Array> {
    const kind = kindOfFile(rel)
    if ((kind !== 'text' && kind !== 'unknown') || content.length > MAX_TEXT_BYTES || looksBinary(content)) return content
    const has = lineEnds(content)
    if (!has) return content
    const old = await this.readBlob(repo, replaced)
    if (old.length > MAX_TEXT_BYTES || looksBinary(old)) return content
    const wanted = lineEnds(old)
    return wanted && wanted !== has ? withLineEnds(content, wanted) : content
  }

  /**
   * Puts the project, or with `rel` one file of it, back the way it was in a
   * version. What is in the folder now is saved as a version first, so that
   * this can be undone the same way. That copy only has the files that
   * versions are kept of, so nothing else is replaced or removed: not a file
   * that git ignores or that is too large, not a link, and nothing in a folder
   * that is a repository of its own. The result says what was left as it is.
   */
  restore(dir: string, version: string, rel: string | null): Promise<RestoreResult> {
    return this.queue(dir, async () => {
      const repo = await this.requireRepo(dir)
      const target = await this.filesOfCommit(repo, version)
      const one = rel === null ? undefined : this.pick(target, rel, CASE_INSENSITIVE)
      if (rel !== null && !one) throw new Error('That version has no such file')
      const counted = this.counted(repo.dir)
      const state = await this.look(repo)
      const lfs = await this.usesLfs(repo)
      const result: RestoreResult = { left: [], failed: [] }
      const failure = (file: string, err: unknown): void => {
        result.failed.push({ path: file, message: err instanceof Error ? err.message : String(err) })
      }

      const current = new Map<string, { rel: string; state: FileState }>()
      for (const [file, s] of state.files) current.set(fold(file), { rel: file, state: s })
      const wanted = new Map<string, { rel: string; state: FileState }>()
      for (const [file, s] of one ? [one] : target) {
        // Two names that are one file on this system: the first one is it.
        if (wanted.has(fold(file))) result.left.push({ path: file, reason: 'name' })
        else wanted.set(fold(file), { rel: file, state: s })
      }

      // ---- what there is to do; when it is nothing, no copy needs keeping
      const remove: string[] = []
      if (rel === null) {
        for (const [key, have] of current) {
          if (wanted.has(key)) continue
          if (have.state.mode === '120000') result.left.push({ path: have.rel, reason: 'link' })
          else remove.push(have.rel)
        }
      }
      const write: Array<{ rel: string; state: FileState; replaces: string | undefined }> = []
      for (const [key, want] of wanted) {
        const have = current.get(key)
        if (have?.state.oid === want.state.oid) continue
        if (want.state.mode === '120000' || have?.state.mode === '120000') {
          result.left.push({ path: want.rel, reason: 'link' })
          continue
        }
        if (unusable(want.rel)) {
          result.left.push({ path: want.rel, reason: 'name' })
          continue
        }
        if (have) {
          // The same for the user already (line ends, or the file that a Git
          // LFS pointer stands for): the folder's own form of it is the right one.
          if (await this.sameForTheUser(repo, have.state.oid, want.state.oid, want.rel, lfs)) continue
        } else {
          // Something is there that no version is kept of, so the copy made
          // below would not have it and replacing it could not be undone. (A
          // folder may still be emptied by what is removed below.)
          const st = await fsp.lstat(resolveInside(repo.dir, want.rel)).catch(() => null)
          if (st && !st.isDirectory()) {
            result.left.push({ path: want.rel, reason: 'unversioned' })
            continue
          }
        }
        if (lfs && lfsPointer(await this.readBlob(repo, want.state.oid))) {
          // Only git, with Git LFS, can produce the file from this.
          result.left.push({ path: want.rel, reason: 'lfs' })
          continue
        }
        write.push({ rel: want.rel, state: want.state, replaces: have?.state.oid })
      }
      if (remove.length === 0 && write.length === 0) return result

      // The copy is of exactly the files that the decisions above were made about.
      if (await this.saveState(repo, state, 'before-restore', '')) {
        this.settle(repo.dir, counted)
        this.deps.onChanged?.(repo.dir)
      }

      // ---- first what the version does not have, so that a file can take the
      // place of a folder of the same name and the other way round
      for (const file of remove) {
        try {
          const abs = resolveInside(repo.dir, file)
          await assertContained(repo.dir, path.dirname(abs))
          // A file that is marked read-only is still the user's to have removed.
          if (process.platform === 'win32') await fsp.chmod(abs, 0o666).catch(() => undefined)
          await steadily(() => fsp.rm(abs, { force: true }))
          // Folders that this emptied go as well.
          for (let d = path.dirname(abs); isInside(repo.dir, d); d = path.dirname(d)) {
            try {
              await fsp.rmdir(d)
            } catch {
              break
            }
          }
        } catch (err) {
          failure(file, err)
        }
      }

      // True when a file, a link or a repository of its own is where a folder
      // on the way to this path would have to be.
      const folders = new Map<string, boolean>()
      const blocked = async (file: string): Promise<boolean> => {
        const parts = file.split('/')
        for (let i = 1; i < parts.length; i++) {
          const key = parts.slice(0, i).join('/')
          let bad = folders.get(key)
          if (bad === undefined) {
            const abs = path.join(repo.dir, ...parts.slice(0, i))
            const st = await fsp.lstat(abs).catch(() => null)
            bad = st !== null && (!st.isDirectory() || (await present(path.join(abs, '.git'))))
            folders.set(key, bad)
          }
          if (bad) return true
        }
        return false
      }
      for (const { rel: file, state: want, replaces } of write) {
        try {
          const abs = resolveInside(repo.dir, file)
          if (await blocked(file)) {
            result.left.push({ path: file, reason: 'unversioned' })
            continue
          }
          if ((await fsp.lstat(abs).catch(() => null))?.isDirectory()) {
            // A folder is in the file's place. It goes if it is empty by now.
            try {
              await fsp.rmdir(abs)
            } catch {
              result.left.push({ path: file, reason: 'unversioned' })
              continue
            }
          }
          await assertContained(repo.dir, path.dirname(abs))
          await fsp.mkdir(path.dirname(abs), { recursive: true })
          let content = await this.readBlob(repo, want.oid)
          if (replaces) content = await this.inTheStyleOf(repo, content, replaces, file)
          // A file that is marked read-only is still the user's to have back.
          if (process.platform === 'win32') await fsp.chmod(abs, 0o666).catch(() => undefined)
          await steadily(() => writeFileAtomic(abs, content))
          if (want.mode === '100755' && process.platform !== 'win32') await fsp.chmod(abs, 0o755).catch(() => undefined)
        } catch (err) {
          failure(file, err)
        }
      }
      return result
    })
  }

  // --------------------------------------------------------- activity

  /**
   * Something in the project folder changed. Changes that follow each other
   * closely are one edit; an edit is over when nothing has changed for the
   * configured pause, and a version is saved after the configured number of
   * edits.
   */
  noteActivity(dir: string): void {
    const settings = this.deps.settings()
    if (!settings.auto) return
    const key = path.resolve(dir)
    let tracker = this.trackers.get(key)
    if (!tracker) this.trackers.set(key, (tracker = { dir: key, timer: null, edits: 0, pending: false, saving: false }))
    const t = tracker
    t.pending = true
    if (t.timer) clearTimeout(t.timer)
    t.timer = setTimeout(() => {
      t.timer = null
      t.pending = false
      t.edits++
      if (!this.deps.settings().auto || t.saving) return
      // The count goes down when the version is written, by the edits it
      // covers: one that ends while it is being written counts towards the next.
      if (t.edits >= Math.max(1, this.deps.settings().editsPerVersion)) {
        t.saving = true
        void this.saveAuto(t.dir, 'edits')
          .catch(() => undefined)
          .finally(() => {
            t.saving = false
          })
      }
    }, Math.max(0.01, settings.editPauseSeconds) * 1000)
    t.timer.unref?.()
  }

  /**
   * The folder was renamed: what is remembered about it goes along, and so do
   * the versions of a project that is a sub-folder of a repository, which are
   * filed under its place in that repository.
   */
  async moved(from: string, to: string): Promise<void> {
    const a = path.resolve(from)
    const b = path.resolve(to)
    const tracker = this.trackers.get(a)
    if (tracker) {
      this.trackers.delete(a)
      tracker.dir = b
      this.trackers.set(b, tracker)
    }
    this.stats.delete(a)
    await this.queue(b, async () => {
      const located = await this.locate(b)
      if (located.kind !== 'repo' || !located.repo.prefix) return
      const repo = located.repo
      const was = toPosix(path.relative(repo.root, a))
      if (!was || was === '..' || was.startsWith('../') || path.isAbsolute(was) || was === repo.prefix) return
      const old = this.scopeOf(was)
      const dropped: string[] = []
      for (const kind of REF_KINDS) {
        for (const stamp of await this.refStamps(repo, kind, old)) {
          const ref = `${old}/${kind}/${stamp}`
          const oid = await git.resolveRef({ fs, gitdir: repo.gitdir, ref }).catch(() => null)
          if (!oid) continue
          await this.writeRef(repo, `${this.scope(repo)}/${kind}/${stamp}`, oid)
          dropped.push(ref)
        }
      }
      await this.deleteRefs(repo, dropped)
      await fsp.rm(this.statCacheFile({ ...repo, prefix: was }), { force: true }).catch(() => undefined)
    }).catch(() => undefined)
  }

  /** The project is being closed: keep what was changed since the last version. */
  async flush(dir: string): Promise<void> {
    const key = path.resolve(dir)
    const tracker = this.trackers.get(key)
    if (tracker) {
      if (tracker.timer) clearTimeout(tracker.timer)
      this.trackers.delete(key)
      if ((tracker.pending || tracker.edits > 0) && this.deps.settings().auto) {
        await this.saveAuto(key, 'close').catch(() => undefined)
      }
    }
    // Whatever is still being written for the folder is finished first.
    await this.whenIdle(key)
  }

  async flushAll(): Promise<void> {
    await Promise.all([...new Set([...this.trackers.keys(), ...this.chains.keys()])].map((dir) => this.flush(dir)))
  }

  /** Lets go of what is remembered about a folder (it was removed). */
  forget(dir: string): void {
    const key = path.resolve(dir)
    const tracker = this.trackers.get(key)
    if (tracker?.timer) clearTimeout(tracker.timer)
    this.trackers.delete(key)
    this.stats.delete(key)
  }

  /** Resolves when nothing is being saved for the folder any more. */
  async whenIdle(dir: string): Promise<void> {
    await (this.chains.get(path.resolve(dir)) ?? Promise.resolve())
  }
}
