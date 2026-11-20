import fs from 'node:fs/promises'
import path from 'node:path'

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

export function toPosix(p: string): string {
  return path.sep === '/' ? p : p.split(path.sep).join('/')
}

export function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a)
  const rb = path.resolve(b)
  return CASE_INSENSITIVE ? ra.toLowerCase() === rb.toLowerCase() : ra === rb
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}

/**
 * Resolves a project-relative path and guarantees that the result stays inside
 * `root`. Every path that arrives from the renderer goes through here.
 */
export function resolveInside(root: string, rel: string): string {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new Error('Invalid path')
  const abs = path.resolve(root, rel)
  if (abs !== path.resolve(root) && !isInside(root, abs)) {
    throw new Error('Path is outside of the project folder')
  }
  return abs
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
// Characters that are illegal on Windows. They are rejected on every platform
// so that projects stay portable between machines (and zip archives).
const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f]/

/** Validates a single file or folder name typed by the user. */
export function validateEntryName(name: string): string {
  const trimmed = (name ?? '').trim()
  if (!trimmed) throw new Error('Name cannot be empty')
  if (trimmed === '.' || trimmed === '..') throw new Error('Invalid name')
  if (ILLEGAL_CHARS.test(trimmed)) {
    throw new Error('Names cannot contain any of these characters:  < > : " / \\ | ? *')
  }
  if (/[. ]$/.test(trimmed)) throw new Error('Names cannot end with a dot or a space')
  if (trimmed.length > 150) throw new Error('Name is too long (150 characters at most)')
  if (process.platform === 'win32' && WINDOWS_RESERVED.test(trimmed)) {
    throw new Error(`"${trimmed}" is a reserved name on Windows`)
  }
  return trimmed
}

/**
 * Makes one path segment coming from a zip archive safe for the local file
 * system without rejecting the archive.
 */
export function sanitizeSegment(segment: string): string {
  let s = segment.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '')
  if (!s) s = '_'
  if (process.platform === 'win32' && WINDOWS_RESERVED.test(s)) s = `${s}_`
  return s
}

/** Turns free text into a usable folder name for a project. */
export function sanitizeProjectName(name: string): string {
  let n = (name ?? '')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  if (n.length > 120) n = n.slice(0, 120).trim()
  if (!n) n = 'Untitled Project'
  if (WINDOWS_RESERVED.test(n)) n = `${n} project`
  if (n.startsWith('.')) n = n.replace(/^\.+/, '') || 'Untitled Project'
  return n
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** Writes via a temporary file so a crash never leaves a half-written file. */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, data)
  try {
    await fs.rename(tmp, file)
  } catch {
    // Windows refuses to replace a file that another process holds open.
    await fs.writeFile(file, data)
    await fs.rm(tmp, { force: true })
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n')
}
