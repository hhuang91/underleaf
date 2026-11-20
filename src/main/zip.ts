// Zip import/export. This is the bridge to Overleaf: "Download > Source" there
// produces an archive that extractZip() understands, and createZip() produces
// an archive that Overleaf's "Upload Project" accepts.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import yauzl from 'yauzl'
import yazl from 'yazl'
import { isInside, sanitizeSegment } from './util/fsx'

export interface ExtractResult {
  files: number
  bytes: number
}

export interface ExtractLimits {
  maxEntries: number
  maxBytes: number
}

const DEFAULT_LIMITS: ExtractLimits = {
  maxEntries: 20000,
  maxBytes: 2 * 1024 * 1024 * 1024
}

const JUNK = new Set(['__MACOSX', '.DS_Store', 'Thumbs.db', 'desktop.ini'])

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true },
      (err, zipfile) => {
        if (err || !zipfile) reject(err ?? new Error('Could not open the zip file'))
        else resolve(zipfile)
      }
    )
  })
}

function openEntryStream(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) reject(err ?? new Error('Could not read zip entry'))
      else resolve(stream)
    })
  })
}

function isSymlink(entry: yauzl.Entry): boolean {
  // Upper 16 bits hold the Unix mode when the archive was made on Unix.
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000
  return mode === 0o120000
}

/**
 * Extracts `zipPath` into `destDir` (which must exist). Entry names are
 * sanitised and can never escape `destDir`; symbolic links are skipped.
 */
export async function extractZip(
  zipPath: string,
  destDir: string,
  limits: ExtractLimits = DEFAULT_LIMITS
): Promise<ExtractResult> {
  const zipfile = await openZip(zipPath)
  const root = path.resolve(destDir)
  let files = 0
  let bytes = 0

  const handle = async (entry: yauzl.Entry): Promise<void> => {
    const raw = entry.fileName.replace(/\\/g, '/')
    const isDir = raw.endsWith('/')
    const parts = raw.split('/').filter((p) => p.length > 0)
    if (parts.length === 0) return
    if (parts.some((p) => p === '.' || p === '..')) {
      throw new Error(`Refusing to extract unsafe path "${entry.fileName}"`)
    }
    if (parts.some((p) => JUNK.has(p))) return
    if (isSymlink(entry)) return

    const target = path.join(root, ...parts.map(sanitizeSegment))
    if (!isInside(root, target)) {
      throw new Error(`Refusing to extract unsafe path "${entry.fileName}"`)
    }
    if (isDir) {
      await fsp.mkdir(target, { recursive: true })
      return
    }
    if (++files > limits.maxEntries) throw new Error('The zip file contains too many files')

    await fsp.mkdir(path.dirname(target), { recursive: true })
    const source = await openEntryStream(zipfile, entry)
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length
        if (bytes > limits.maxBytes) cb(new Error('The zip file is too large when extracted'))
        else cb(null, chunk)
      }
    })
    await pipeline(source, meter, fs.createWriteStream(target))
  }

  await new Promise<void>((resolve, reject) => {
    let failed = false
    const fail = (err: unknown): void => {
      if (failed) return
      failed = true
      try {
        zipfile.close()
      } catch {
        /* already closed */
      }
      reject(err instanceof Error ? err : new Error(String(err)))
    }
    zipfile.on('entry', (entry: yauzl.Entry) => {
      handle(entry).then(() => {
        if (!failed) zipfile.readEntry()
      }, fail)
    })
    zipfile.once('end', () => {
      if (!failed) resolve()
    })
    zipfile.once('error', fail)
    zipfile.readEntry()
  })

  return { files, bytes }
}

export interface ZipInput {
  /** Absolute path on disk (ignored for directories). */
  abs: string
  /** POSIX-style path inside the archive. */
  rel: string
  isDir: boolean
}

/** Writes a zip archive; files sit at the root of the archive, as Overleaf expects. */
export async function createZip(entries: ZipInput[], destZip: string): Promise<void> {
  const zip = new yazl.ZipFile()
  const tmp = `${destZip}.${process.pid}.part`
  const out = fs.createWriteStream(tmp)
  try {
    await new Promise<void>((resolve, reject) => {
      // A source file that vanished or cannot be read is reported on the
      // ZipFile itself, not on its output stream, and once for every such
      // file. The listeners therefore stay: an 'error' event that nobody
      // listens to would take the whole app down.
      zip.on('error', reject)
      zip.outputStream.on('error', reject)
      out.on('error', reject)
      // 'close' rather than 'finish': the file must be released before it is renamed.
      out.once('close', resolve)
      zip.outputStream.pipe(out)
      for (const e of entries) {
        if (e.isDir) zip.addEmptyDirectory(e.rel)
        else zip.addFile(e.abs, e.rel)
      }
      zip.end()
    })
    await fsp.rm(destZip, { force: true })
    await fsp.rename(tmp, destZip)
  } catch (err) {
    // The stream may still be busy opening the file. Removing it before the
    // stream has let go would come too early: the file would be created
    // afterwards and stay behind.
    await new Promise<void>((resolve) => {
      if (out.closed) return resolve()
      out.once('close', () => resolve())
      out.destroy()
    })
    await fsp.rm(tmp, { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)
    throw err
  }
}
