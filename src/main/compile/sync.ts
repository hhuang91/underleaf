// Mirrors a project's sources into a private build directory.
//
// Compiling in a mirror (the way Overleaf's compile service does) keeps .aux,
// .log and friends out of the user's project folder, so the folder stays clean
// for git, cloud sync and zip export.

import fs from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import path from 'node:path'
import { walk } from '../files'
import { readJson, writeJson } from '../util/fsx'

interface Manifest {
  version: 1
  /** Relative path -> fingerprint of the source file that was last copied. */
  files: Record<string, { size: number; mtimeMs: number }>
}

export interface SyncResult {
  copied: number
  removed: number
  /** Project-relative paths of all source files (POSIX separators). */
  files: string[]
}

export interface SyncOptions {
  /**
   * Project-relative paths for which this returns true are kept out of the
   * mirror, and removed from it if an earlier run put them there.
   */
  exclude?: (rel: string) => boolean
}

export async function syncTree(
  srcRoot: string,
  workRoot: string,
  manifestFile: string,
  opts: SyncOptions = {}
): Promise<SyncResult> {
  await fs.mkdir(workRoot, { recursive: true })
  const previous = (await readJson<Manifest>(manifestFile)) ?? { version: 1, files: {} }
  const next: Manifest = { version: 1, files: {} }
  // Strict: compiling a mirror that silently lacks files only produces confusing errors.
  const all = await walk(srcRoot, { stats: true, strict: true })
  const entries = opts.exclude ? all.filter((e) => e.isDir || !opts.exclude?.(e.rel)) : all

  for (const e of entries) {
    if (e.isDir) await fs.mkdir(path.join(workRoot, e.rel), { recursive: true })
  }

  let copied = 0
  for (const e of entries) {
    if (e.isDir) continue
    const dest = path.join(workRoot, e.rel)
    const seen = previous.files[e.rel]
    let upToDate = !!seen && seen.size === e.size && seen.mtimeMs === e.mtimeMs
    if (upToDate) {
      try {
        await fs.access(dest)
      } catch {
        upToDate = false
      }
    }
    if (!upToDate) {
      await fs.mkdir(path.dirname(dest), { recursive: true })
      // FICLONE makes this a copy-on-write clone where the file system supports it.
      await fs.copyFile(e.abs, dest, FS.COPYFILE_FICLONE)
      // Keep the source's timestamp so latexmk's change detection stays quiet.
      const mtime = new Date(e.mtimeMs)
      await fs.utimes(dest, mtime, mtime).catch(() => undefined)
      copied++
    }
    next.files[e.rel] = { size: e.size, mtimeMs: e.mtimeMs }
  }

  let removed = 0
  for (const rel of Object.keys(previous.files)) {
    if (!(rel in next.files)) {
      await fs.rm(path.join(workRoot, rel), { force: true })
      removed++
    }
  }

  await writeJson(manifestFile, next)
  return { copied, removed, files: Object.keys(next.files) }
}
