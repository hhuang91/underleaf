// File-system operations inside a project folder. No Electron imports here so
// the module can be unit-tested under plain Node.

import fs from 'node:fs/promises'
import path from 'node:path'
import type { FileNode, ImportFilesResult, ReadFileResult } from '@shared/types'
import { IGNORED_NAMES, kindOfFile } from '@shared/fileTypes'
import {
  exists,
  isDirectory,
  isInside,
  resolveInside,
  samePath,
  sanitizeSegment,
  toPosix,
  validateEntryName
} from './util/fsx'

export interface WalkEntry {
  /** POSIX-style path relative to the walk root. */
  rel: string
  abs: string
  isDir: boolean
  size: number
  mtimeMs: number
}

const MAX_ENTRIES = 20000
const MAX_TEXT_BYTES = 5 * 1024 * 1024

/**
 * Lists every file and folder below `root` (depth first), skipping ignored
 * names. The list is cut off at `max` entries. With `strict` that is an error
 * instead: use it wherever a missing file would go unnoticed, such as an
 * export or the build mirror.
 */
export async function walk(
  root: string,
  opts: { stats?: boolean; max?: number; strict?: boolean } = {}
): Promise<WalkEntry[]> {
  const out: WalkEntry[] = []
  const max = opts.max ?? MAX_ENTRIES
  let truncated = false

  async function visit(dirAbs: string, dirRel: string): Promise<void> {
    let dirents
    try {
      dirents = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of dirents) {
      if (out.length >= max) {
        truncated = true
        return
      }
      if (IGNORED_NAMES.has(d.name)) continue
      const abs = path.join(dirAbs, d.name)
      const rel = dirRel ? `${dirRel}/${d.name}` : d.name
      let isFile = d.isFile()
      let st = null
      if (d.isSymbolicLink()) {
        try {
          st = await fs.stat(abs)
        } catch {
          continue // dangling link
        }
        if (st.isDirectory()) continue // never follow directory links (cycles)
        isFile = st.isFile()
      }
      if (d.isDirectory()) {
        out.push({ rel, abs, isDir: true, size: 0, mtimeMs: 0 })
        await visit(abs, rel)
      } else if (isFile) {
        if (opts.stats && !st) {
          try {
            st = await fs.stat(abs)
          } catch {
            continue
          }
        }
        out.push({ rel, abs, isDir: false, size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0 })
      }
    }
  }

  await visit(root, '')
  if (truncated && opts.strict) {
    throw new Error(
      `This folder holds more than ${max.toLocaleString('en-US')} files and folders, which is more than a project can have. Move large data or dependency folders out of it.`
    )
  }
  return out
}

/** Refuses to act on a project whose folder is gone instead of quietly re-creating it. */
async function requireRoot(root: string): Promise<void> {
  if (!(await isDirectory(root))) throw new Error('The project folder no longer exists')
}

/**
 * `dir` lies inside `root` by name, but one of its components could be a link
 * (or a Windows junction) that leads somewhere else. The app never follows
 * linked folders itself, so nothing it offers goes through one; this guards
 * the file operations against paths that do.
 */
export async function assertContained(root: string, dir: string): Promise<void> {
  const realRoot = await fs.realpath(root)
  let probe = dir
  for (;;) {
    let real: string
    try {
      real = await fs.realpath(probe)
    } catch (err) {
      // Not created yet: its closest existing ancestor decides.
      const parent = path.dirname(probe)
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || parent === probe) throw err
      probe = parent
      continue
    }
    if (!samePath(real, realRoot) && !isInside(realRoot, real)) {
      throw new Error('Path is outside of the project folder')
    }
    return
  }
}

const LOCK_ERRORS: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES'])

/**
 * On Windows a file is briefly unwritable while a virus scanner, a sync client
 * or the search indexer has it open. Such locks last milliseconds, so a few
 * quick retries spare the user a failed save.
 */
async function retryWhileLocked<T>(op: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await op()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (process.platform !== 'win32' || attempt >= 5 || !LOCK_ERRORS.has(code)) throw err
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt))
    }
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Nested tree for the file panel: folders first, then files, both alphabetical. */
export async function readTree(root: string): Promise<FileNode[]> {
  let budget = MAX_ENTRIES

  async function visit(dirAbs: string, dirRel: string): Promise<FileNode[]> {
    let dirents
    try {
      dirents = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return []
    }
    const nodes: FileNode[] = []
    for (const d of dirents) {
      if (budget <= 0) break
      if (IGNORED_NAMES.has(d.name)) continue
      const abs = path.join(dirAbs, d.name)
      const rel = dirRel ? `${dirRel}/${d.name}` : d.name
      let isFile = d.isFile()
      if (d.isSymbolicLink()) {
        try {
          const st = await fs.stat(abs)
          if (st.isDirectory()) continue
          isFile = st.isFile()
        } catch {
          continue
        }
      }
      if (d.isDirectory()) {
        budget--
        nodes.push({ name: d.name, path: rel, type: 'folder', children: await visit(abs, rel) })
      } else if (isFile) {
        budget--
        nodes.push({ name: d.name, path: rel, type: 'file' })
      }
    }
    nodes.sort((a, b) =>
      a.type === b.type ? collator.compare(a.name, b.name) : a.type === 'folder' ? -1 : 1
    )
    return nodes
  }

  return visit(root, '')
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export function decodeText(buf: Buffer): { text: string; transcoded: boolean } {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), transcoded: true }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), transcoded: true }
  }
  const body = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), transcoded: false }
  } catch {
    // Legacy 8-bit file: decode as Windows-1252, it is saved back as UTF-8.
    return { text: new TextDecoder('windows-1252').decode(body), transcoded: true }
  }
}

export async function readProjectFile(root: string, rel: string): Promise<ReadFileResult> {
  const abs = resolveInside(root, rel)
  await assertContained(root, path.dirname(abs))
  const st = await fs.stat(abs)
  if (!st.isFile()) throw new Error('Not a file')
  const kind = kindOfFile(rel)
  if (kind === 'image' || kind === 'pdf' || kind === 'binary') {
    return { kind, size: st.size, mtimeMs: st.mtimeMs }
  }
  if (st.size > MAX_TEXT_BYTES) {
    return { kind: 'binary', size: st.size, mtimeMs: st.mtimeMs, reason: 'too-large' }
  }
  const buf = await fs.readFile(abs)
  const isUtf16 = buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))
  if (!isUtf16 && looksBinary(buf)) return { kind: 'binary', size: st.size, mtimeMs: st.mtimeMs }
  const { text, transcoded } = decodeText(buf)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return {
    kind: 'text',
    content: text.replace(/\r\n?/g, '\n'),
    eol,
    mtimeMs: st.mtimeMs,
    size: st.size,
    transcoded
  }
}

export async function readProjectBinary(root: string, rel: string): Promise<Buffer> {
  const abs = resolveInside(root, rel)
  await assertContained(root, path.dirname(abs))
  const st = await fs.stat(abs)
  if (!st.isFile()) throw new Error('Not a file')
  if (st.size > 200 * 1024 * 1024) throw new Error('File is too large to preview')
  return fs.readFile(abs)
}

export async function writeProjectFile(
  root: string,
  rel: string,
  content: string,
  eol: '\n' | '\r\n'
): Promise<number> {
  const abs = resolveInside(root, rel)
  if (samePath(abs, root)) throw new Error('Invalid path')
  await requireRoot(root)
  await assertContained(root, path.dirname(abs))
  const data = eol === '\r\n' ? content.replace(/\n/g, '\r\n') : content
  try {
    await fs.mkdir(path.dirname(abs), { recursive: true })
    // Written in place rather than through a temporary file: that keeps links,
    // permissions and other programs' handles on the file intact.
    await retryWhileLocked(() => fs.writeFile(abs, data, 'utf8'))
  } catch (err) {
    throw new Error(describeWriteError(err))
  }
  return (await fs.stat(abs)).mtimeMs
}

/** Says in plain words why a file could not be written. */
function describeWriteError(err: unknown): string {
  switch ((err as NodeJS.ErrnoException).code) {
    case 'EPERM':
    case 'EACCES':
    case 'EROFS':
      return 'the file is read-only, or you do not have permission to change it'
    case 'EBUSY':
      return 'the file is in use by another program'
    case 'ENOSPC':
      return 'the disk is full'
    case 'ENOENT':
      return 'its folder no longer exists'
    default:
      return err instanceof Error ? err.message : String(err)
  }
}

function checkedRel(rel: string): string {
  const parts = toPosix(rel).split('/').filter((p) => p.length > 0)
  if (parts.length === 0) throw new Error('Name cannot be empty')
  return parts.map((p) => validateEntryName(p)).join('/')
}

export async function createFile(root: string, rel: string, content: string): Promise<string> {
  const clean = checkedRel(rel)
  const abs = resolveInside(root, clean)
  await requireRoot(root)
  await assertContained(root, path.dirname(abs))
  await fs.mkdir(path.dirname(abs), { recursive: true })
  try {
    await fs.writeFile(abs, content, { encoding: 'utf8', flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('A file or folder with this name already exists')
    }
    throw err
  }
  return clean
}

export async function createFolder(root: string, rel: string): Promise<string> {
  const clean = checkedRel(rel)
  const abs = resolveInside(root, clean)
  await requireRoot(root)
  await assertContained(root, path.dirname(abs))
  if (await exists(abs)) throw new Error('A file or folder with this name already exists')
  await fs.mkdir(abs, { recursive: true })
  return clean
}

export async function renameEntry(root: string, rel: string, newName: string): Promise<string> {
  const name = validateEntryName(newName)
  const src = resolveInside(root, rel)
  if (samePath(src, root)) throw new Error('Invalid path')
  await assertContained(root, path.dirname(src))
  const dest = path.join(path.dirname(src), name)
  if (!samePath(src, dest) && (await exists(dest))) {
    throw new Error('A file or folder with this name already exists')
  }
  await fs.rename(src, dest)
  return toPosix(path.relative(root, dest))
}

export async function moveEntry(root: string, rel: string, destFolderRel: string): Promise<string> {
  const src = resolveInside(root, rel)
  if (samePath(src, root)) throw new Error('Invalid path')
  const destDir = resolveInside(root, destFolderRel || '.')
  const dest = path.join(destDir, path.basename(src))
  if (samePath(src, dest)) return toPosix(path.relative(root, dest))
  if (samePath(destDir, src) || isInside(src, destDir)) {
    throw new Error('A folder cannot be moved into itself')
  }
  if (await exists(dest)) throw new Error('A file or folder with this name already exists there')
  await requireRoot(root)
  await assertContained(root, path.dirname(src))
  await assertContained(root, destDir)
  await fs.mkdir(destDir, { recursive: true })
  await fs.rename(src, dest)
  return toPosix(path.relative(root, dest))
}

/**
 * Moves an entry to the system trash and resolves with true. When the trash
 * is not available for this location (a network drive, for example) nothing
 * is deleted and the result is false: the caller can ask whether to delete
 * for good and call again with `permanently`.
 */
export async function deleteEntry(
  root: string,
  rel: string,
  trash: (target: string) => Promise<void>,
  permanently = false
): Promise<boolean> {
  const abs = resolveInside(root, rel)
  if (samePath(abs, root)) throw new Error('Invalid path')
  await assertContained(root, path.dirname(abs))
  try {
    await fs.lstat(abs)
  } catch {
    return true // already gone
  }
  if (permanently) {
    await fs.rm(abs, { recursive: true, force: true })
    return true
  }
  try {
    await trash(abs)
    return true
  } catch {
    return false
  }
}

/**
 * Copies files or folders from anywhere on disk into the project ("upload").
 * Nothing is copied when files would be overwritten and `overwrite` is false;
 * the caller can then ask the user and call again.
 */
export async function importExternalFiles(
  root: string,
  destFolderRel: string,
  sources: string[],
  overwrite: boolean
): Promise<ImportFilesResult> {
  const destDir = resolveInside(root, destFolderRel || '.')
  await requireRoot(root)
  await assertContained(root, destDir)
  const plan: Array<{ src: string; dest: string }> = []

  for (const source of sources) {
    const src = path.resolve(source)
    let st
    try {
      st = await fs.stat(src)
    } catch {
      continue
    }
    const topName = sanitizeSegment(path.basename(src))
    if (IGNORED_NAMES.has(topName)) continue
    if (st.isDirectory()) {
      // Importing the project (or one of its parents) into itself would recurse.
      if (samePath(src, root) || isInside(src, root)) continue
      for (const entry of await walk(src, { strict: true })) {
        if (entry.isDir) continue
        const relParts = entry.rel.split('/').map(sanitizeSegment)
        plan.push({ src: entry.abs, dest: path.join(destDir, topName, ...relParts) })
      }
    } else if (st.isFile()) {
      plan.push({ src, dest: path.join(destDir, topName) })
    }
  }

  const work = plan.filter((p) => !samePath(p.src, p.dest))
  const conflicts: string[] = []
  for (const p of work) {
    if (await exists(p.dest)) conflicts.push(toPosix(path.relative(root, p.dest)))
  }
  if (conflicts.length > 0 && !overwrite) return { imported: [], conflicts, sources }

  const imported: string[] = []
  for (const p of work) {
    resolveInside(root, path.relative(root, p.dest))
    await fs.mkdir(path.dirname(p.dest), { recursive: true })
    await fs.copyFile(p.src, p.dest)
    imported.push(toPosix(path.relative(root, p.dest)))
  }
  return { imported, conflicts: [], sources }
}
