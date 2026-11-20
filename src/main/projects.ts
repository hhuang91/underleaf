// The project library: every project is a plain folder. Folders inside the
// library directory are listed automatically; folders elsewhere can be linked.

import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Compiler, ImportResult, ProjectSummary } from '@shared/types'
import { artifactStem, isTexFile } from '@shared/fileTypes'
import { walk } from './files'
import { createZip, extractZip, type ZipInput } from './zip'
import { writeTemplate, type TemplateName } from './templates'
import {
  exists,
  isDirectory,
  isInside,
  readJson,
  samePath,
  sanitizeProjectName,
  writeJson
} from './util/fsx'

export const META_FILE = '.underleaf.json'

/** Per-project settings that travel with the folder. */
export interface ProjectMeta {
  compiler?: Compiler
  rootDoc?: string
}

export interface LibraryDeps {
  libraryPath(): string
  externalProjects(): string[]
  setExternalProjects(list: string[]): Promise<void>
  /** Moves a file or folder to the OS recycle bin / trash. */
  trash(target: string): Promise<void>
}

const VALID_COMPILERS: ReadonlySet<string> = new Set(['pdflatex', 'latex', 'xelatex', 'lualatex'])

export function encodeProjectId(dir: string): string {
  return Buffer.from(path.resolve(dir), 'utf8').toString('base64url')
}

// ------------------------------------------------------------ detection

async function readHead(file: string, bytes = 256 * 1024): Promise<string> {
  let handle
  try {
    handle = await fs.open(file, 'r')
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } catch {
    return ''
  } finally {
    await handle?.close()
  }
}

/** True when the text has an uncommented \documentclass. */
export function hasDocumentClass(text: string): boolean {
  return /^[^%\n]*\\documentclass/m.test(text)
}

/**
 * Finds the main document the way Overleaf does after an upload: the first
 * .tex file with a \documentclass, preferring main.tex and shallow paths.
 */
export async function findRootDoc(dir: string): Promise<string | null> {
  const tex = (await walk(dir)).filter((e) => !e.isDir && isTexFile(e.rel)).map((e) => e.rel)
  const rank = (rel: string): number => {
    const depth = rel.split('/').length - 1
    const base = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase()
    return depth * 10 + (base === 'main.tex' ? 0 : 1)
  }
  tex.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  for (const rel of tex.slice(0, 300)) {
    if (hasDocumentClass(await readHead(path.join(dir, rel)))) return rel
  }
  return null
}

/** Reads the title from \title{...}; used to name projects that have no better name. */
export function titleFromTex(text: string): string | null {
  const m = /^[^%\n]*\\title\s*(?:\[[^\]]*\])?\s*\{/m.exec(text)
  if (!m) return null
  let depth = 1
  let i = m.index + m[0].length
  let out = ''
  while (i < text.length && depth > 0) {
    const ch = text[i]
    if (ch === '\\' && i + 1 < text.length) {
      out += ch + text[i + 1]
      i += 2
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') depth--
    if (depth > 0) out += ch
    i++
  }
  const plain = out
    .replace(/%.*$/gm, '')
    .replace(/\\\\(\[[^\]]*\])?/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?\s*/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/[{}~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain || null
}

/**
 * Overleaf archives do not record the compiler, so guess it from the source:
 * an explicit "% !TEX program" comment wins, then a latexmkrc, then packages
 * that only work with one engine.
 */
export function guessCompiler(mainTex: string, latexmkrc = ''): Compiler {
  const magic = /^\s*%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*([A-Za-z]+)/im.exec(mainTex)
  if (magic) {
    const name = magic[1].toLowerCase()
    if (name === 'xelatex' || name === 'lualatex' || name === 'pdflatex' || name === 'latex') return name
  }
  const mode = /^\s*\$pdf_mode\s*=\s*(\d)/m.exec(latexmkrc)
  if (mode) {
    if (mode[1] === '4') return 'lualatex'
    if (mode[1] === '5') return 'xelatex'
    if (mode[1] === '2' || mode[1] === '3') return 'latex'
    if (mode[1] === '1') return 'pdflatex'
  }
  const preamble = mainTex.split(/\\begin\s*\{document\}/)[0].replace(/(^|[^\\])%.*$/gm, '$1')
  if (/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{[^}]*\b(?:luacode|luatexja|luatextra|luaotfload|lua-ul)\b/.test(preamble) || /\\directlua\b/.test(preamble)) {
    return 'lualatex'
  }
  if (/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{[^}]*\b(?:fontspec|xeCJK|polyglossia|unicode-math|xltxtra|mathspec|xunicode)\b/.test(preamble)) {
    return 'xelatex'
  }
  if (/\\documentclass\s*(?:\[[^\]]*\])?\s*\{(?:ctexart|ctexrep|ctexbook|ctexbeamer)\}/.test(preamble)) {
    return 'xelatex'
  }
  return 'pdflatex'
}

async function newestMtime(dir: string): Promise<number> {
  let newest = 0
  for (const e of await walk(dir, { stats: true, max: 3000 })) {
    if (!e.isDir && e.mtimeMs > newest) newest = e.mtimeMs
  }
  if (newest === 0) {
    try {
      newest = (await fs.stat(dir)).mtimeMs
    } catch {
      /* folder vanished */
    }
  }
  return newest
}

function timestamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// -------------------------------------------------------------- library

export class ProjectLibrary {
  /**
   * Folders of the projects that are open in a window. They stay valid until
   * closed even if they stop being listed, which is what happens to the open
   * project when the library is pointed at another folder.
   */
  private readonly opened = new Set<string>()

  constructor(private readonly deps: LibraryDeps) {}

  private get root(): string {
    return path.resolve(this.deps.libraryPath())
  }

  private isLibraryProject(dir: string): boolean {
    return samePath(path.dirname(dir), this.root) && !path.basename(dir).startsWith('.')
  }

  /** Maps an id from the renderer back to a folder, refusing anything that is not a known project. */
  dirFor(id: string): string {
    if (typeof id !== 'string' || !id) throw new Error('Unknown project')
    const dir = path.resolve(Buffer.from(id, 'base64url').toString('utf8'))
    const known =
      this.isLibraryProject(dir) ||
      this.deps.externalProjects().some((p) => samePath(p, dir)) ||
      [...this.opened].some((p) => samePath(p, dir))
    if (!known) throw new Error('Unknown project')
    return dir
  }

  /** Call when a window opens the project (after `dirFor` accepted it) and when it lets go of it. */
  markOpen(dir: string): void {
    this.opened.add(path.resolve(dir))
  }

  markClosed(dir: string): void {
    for (const p of [...this.opened]) if (samePath(p, dir)) this.opened.delete(p)
  }

  async summary(dir: string): Promise<ProjectSummary> {
    return {
      id: encodeProjectId(dir),
      name: path.basename(dir),
      path: dir,
      location: this.isLibraryProject(dir) ? 'library' : 'external',
      modifiedAt: await newestMtime(dir)
    }
  }

  async list(): Promise<ProjectSummary[]> {
    await fs.mkdir(this.root, { recursive: true })
    const dirs: string[] = []
    for (const d of await fs.readdir(this.root, { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith('.')) dirs.push(path.join(this.root, d.name))
    }
    for (const ext of this.deps.externalProjects()) {
      if (!dirs.some((d) => samePath(d, ext)) && (await isDirectory(ext))) dirs.push(path.resolve(ext))
    }
    const out = await Promise.all(dirs.map((d) => this.summary(d)))
    out.sort((a, b) => b.modifiedAt - a.modifiedAt)
    return out
  }

  private async findByName(name: string): Promise<string | null> {
    const wanted = name.toLowerCase()
    try {
      for (const d of await fs.readdir(this.root, { withFileTypes: true })) {
        if (d.isDirectory() && d.name.toLowerCase() === wanted) return path.join(this.root, d.name)
      }
    } catch {
      /* library folder does not exist yet */
    }
    return null
  }

  /** Creates a new, uniquely named folder in the library ("Name", "Name (1)", ...). */
  private async allocate(name: string): Promise<string> {
    await fs.mkdir(this.root, { recursive: true })
    const base = sanitizeProjectName(name)
    for (let i = 0; i < 1000; i++) {
      const candidate = i === 0 ? base : `${base} (${i})`
      if (await this.findByName(candidate)) continue
      const dir = path.join(this.root, candidate)
      try {
        await fs.mkdir(dir)
        return dir
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
    }
    throw new Error('Could not find a free project name')
  }

  async create(name: string, template: TemplateName): Promise<ProjectSummary> {
    const dir = await this.allocate(name)
    await writeTemplate(dir, template, path.basename(dir))
    return this.summary(dir)
  }

  async rename(id: string, newName: string): Promise<{ from: string; summary: ProjectSummary }> {
    const dir = this.dirFor(id)
    const name = sanitizeProjectName(newName)
    const dest = path.join(path.dirname(dir), name)
    if (dest === dir) return { from: dir, summary: await this.summary(dir) }
    if (!samePath(dir, dest) && (await exists(dest))) {
      throw new Error(`A project named "${name}" already exists`)
    }
    await fs.rename(dir, dest)
    const external = this.deps.externalProjects()
    if (external.some((p) => samePath(p, dir))) {
      await this.deps.setExternalProjects(external.map((p) => (samePath(p, dir) ? dest : p)))
    }
    if ([...this.opened].some((p) => samePath(p, dir))) {
      this.markClosed(dir)
      this.markOpen(dest)
    }
    return { from: dir, summary: await this.summary(dest) }
  }

  async copy(id: string, newName: string): Promise<ProjectSummary> {
    const src = this.dirFor(id)
    const dest = await this.allocate(newName)
    try {
      await fs.cp(src, dest, {
        recursive: true,
        filter: (from) => {
          const base = path.basename(from)
          return base !== '.git' && base !== '.svn' && base !== '.hg'
        }
      })
    } catch (err) {
      await fs.rm(dest, { recursive: true, force: true })
      throw err
    }
    return this.summary(dest)
  }

  /** Library projects go to the recycle bin; linked folders are only unlinked. */
  async remove(id: string): Promise<void> {
    const dir = this.dirFor(id)
    if (this.isLibraryProject(dir)) {
      try {
        await this.deps.trash(dir)
      } catch {
        // No trash on this drive. A whole project is never deleted for good from here.
        throw new Error(
          'This project could not be moved to the trash, which is not available for its location. To delete it anyway, remove its folder in your file manager.'
        )
      }
      this.markClosed(dir)
      return
    }
    await this.deps.setExternalProjects(this.deps.externalProjects().filter((p) => !samePath(p, dir)))
    this.markClosed(dir)
  }

  async addExternal(folder: string): Promise<ProjectSummary> {
    const dir = path.resolve(folder)
    if (!(await isDirectory(dir))) throw new Error('Folder not found')
    if (samePath(dir, this.root) || isInside(dir, this.root)) {
      throw new Error('This folder contains the project library and cannot be added as a project')
    }
    if (!this.isLibraryProject(dir)) {
      const external = this.deps.externalProjects()
      if (!external.some((p) => samePath(p, dir))) await this.deps.setExternalProjects([...external, dir])
    }
    return this.summary(dir)
  }

  // ------------------------------------------------------------- meta

  async readMeta(dir: string): Promise<ProjectMeta> {
    const raw = await readJson<Record<string, unknown>>(path.join(dir, META_FILE))
    const meta: ProjectMeta = {}
    if (raw && typeof raw.compiler === 'string' && VALID_COMPILERS.has(raw.compiler)) {
      meta.compiler = raw.compiler as Compiler
    }
    if (raw && typeof raw.rootDoc === 'string' && raw.rootDoc) meta.rootDoc = raw.rootDoc
    return meta
  }

  async updateMeta(dir: string, patch: ProjectMeta & { rootDoc?: string | undefined }): Promise<ProjectMeta> {
    const meta = { ...(await this.readMeta(dir)), ...patch }
    if (!meta.rootDoc) delete meta.rootDoc
    if (!meta.compiler) delete meta.compiler
    if (Object.keys(meta).length === 0) await fs.rm(path.join(dir, META_FILE), { force: true })
    else await writeJson(path.join(dir, META_FILE), meta)
    return meta
  }

  /** The document that gets compiled: the explicit choice if it still exists, else auto-detected. */
  async effectiveRootDoc(dir: string): Promise<{ rootDoc: string | null; explicit: boolean }> {
    const meta = await this.readMeta(dir)
    if (meta.rootDoc) {
      const abs = path.resolve(dir, meta.rootDoc)
      if (isInside(dir, abs) && (await exists(abs))) return { rootDoc: meta.rootDoc, explicit: true }
    }
    return { rootDoc: await findRootDoc(dir), explicit: false }
  }

  async effectiveCompiler(dir: string, rootDoc: string | null): Promise<Compiler> {
    const meta = await this.readMeta(dir)
    if (meta.compiler) return meta.compiler
    if (!rootDoc) return 'pdflatex'
    const main = await readHead(path.join(dir, rootDoc))
    const rc = (await readHead(path.join(dir, 'latexmkrc'), 32 * 1024)) || (await readHead(path.join(dir, '.latexmkrc'), 32 * 1024))
    return guessCompiler(main, rc)
  }

  // -------------------------------------------------------- zip import

  /**
   * Imports a project archive (for example Overleaf's "Download > Source").
   *
   * When a project with the same name exists, mode 'ask' reports a conflict
   * without touching anything; 'replace' swaps the files in place (keeping the
   * project's settings and any .git folder, and moving the old files to the
   * recycle bin); 'keep-both' imports under a new name.
   */
  async importZip(zipPath: string, mode: 'ask' | 'keep-both' | 'replace'): Promise<ImportResult> {
    const zipName = path.basename(zipPath).replace(/\.zip$/i, '')
    const proposed = sanitizeProjectName(zipName)

    // Browsers append " (1)" to repeated downloads; treat "Paper (1).zip" as
    // a new version of "Paper" when that project exists.
    let existing = await this.findByName(proposed)
    let name = proposed
    if (!existing) {
      const stripped = proposed.replace(/\s*\(\d+\)$/, '').trim()
      if (stripped && stripped !== proposed) {
        const match = await this.findByName(stripped)
        if (match) {
          existing = match
          name = stripped
        }
      }
    }

    if (existing && mode === 'ask') {
      return { status: 'conflict', zipPath, proposedName: name, existing: await this.summary(existing) }
    }

    await fs.mkdir(this.root, { recursive: true })
    const staging = path.join(this.root, `.import-${crypto.randomBytes(6).toString('hex')}`)
    await fs.mkdir(staging)
    try {
      await extractZip(zipPath, staging)
      const content = await this.contentRoot(staging)

      if (existing && mode === 'replace') {
        await this.replaceContents(existing, content)
        return { status: 'imported', project: await this.summary(existing), replaced: true }
      }

      // 'keep-both', or no conflict at all. An archive without a usable file
      // name falls back to the document title.
      let finalName = existing ? proposed : name
      if (!zipName.trim()) {
        const root = await findRootDoc(content)
        const title = root ? titleFromTex(await readHead(path.join(content, root))) : null
        if (title) finalName = title
      }
      const dir = await this.allocate(finalName)
      await this.moveChildren(content, dir)
      return { status: 'imported', project: await this.summary(dir), replaced: false }
    } finally {
      await fs.rm(staging, { recursive: true, force: true })
    }
  }

  /** Archives made by zipping a folder have one top-level directory; look inside it. */
  private async contentRoot(staging: string): Promise<string> {
    const entries = await fs.readdir(staging, { withFileTypes: true })
    if (entries.length === 1 && entries[0].isDirectory()) return path.join(staging, entries[0].name)
    if (entries.length === 0) throw new Error('The zip file is empty')
    return staging
  }

  private async moveChildren(from: string, to: string, moved: string[] = []): Promise<string[]> {
    for (const name of await fs.readdir(from)) {
      await fs.rename(path.join(from, name), path.join(to, name))
      moved.push(name)
    }
    return moved
  }

  private async replaceContents(projectDir: string, content: string): Promise<void> {
    // The project's settings and version-control data always survive a replace.
    const always = new Set([META_FILE, '.git', '.svn', '.hg'])
    // These survive unless the archive brings its own copy.
    const keepIfAbsent = new Set(['.gitignore', '.gitattributes'])
    for (const name of always) {
      await fs.rm(path.join(content, name), { recursive: true, force: true })
    }

    const backup = path.join(this.root, `.replaced-${crypto.randomBytes(6).toString('hex')}`)
    await fs.mkdir(backup)
    const movedOut: string[] = []
    const movedIn: string[] = []
    try {
      for (const name of await fs.readdir(projectDir)) {
        if (always.has(name)) continue
        if (keepIfAbsent.has(name) && !(await exists(path.join(content, name)))) continue
        await fs.rename(path.join(projectDir, name), path.join(backup, name))
        movedOut.push(name)
      }
      await this.moveChildren(content, projectDir, movedIn)
    } catch (err) {
      // Roll back: drop what was brought in and put the original files back.
      for (const name of movedIn) {
        await fs.rm(path.join(projectDir, name), { recursive: true, force: true }).catch(() => undefined)
      }
      for (const name of movedOut) {
        await fs.rename(path.join(backup, name), path.join(projectDir, name)).catch(() => undefined)
      }
      await fs.rmdir(backup).catch(() => undefined)
      throw err
    }

    // The previous version stays recoverable from the recycle bin.
    const visible = path.join(this.root, `${path.basename(projectDir)} (replaced ${timestamp()})`)
    let trashTarget = backup
    try {
      await fs.rename(backup, visible)
      trashTarget = visible
    } catch {
      /* keep the hidden name */
    }
    try {
      await this.deps.trash(trashTarget)
    } catch {
      // No recycle bin: leave the backup as a visible project instead of deleting it.
    }
  }

  // -------------------------------------------------------- zip export

  /** Collects what goes into an export: sources only, no settings, no build products. */
  async exportEntries(dir: string): Promise<ZipInput[]> {
    // An archive that silently lacks files would be worse than no archive.
    const all = await walk(dir, { strict: true })
    const texStems = new Set<string>()
    for (const e of all) {
      if (!e.isDir && isTexFile(e.rel)) texStems.add(e.rel.replace(/\.[^./]+$/, '').toLowerCase())
    }
    const files = all.filter((e) => {
      if (e.isDir) return false
      const stem = artifactStem(e.rel)
      if (stem === null) return true
      const folder = e.rel.includes('/') ? e.rel.slice(0, e.rel.lastIndexOf('/') + 1) : ''
      return !texStems.has((folder + stem).toLowerCase())
    })
    const nonEmpty = new Set<string>()
    for (const f of files) {
      const parts = f.rel.split('/')
      for (let i = 1; i < parts.length; i++) nonEmpty.add(parts.slice(0, i).join('/'))
    }
    const emptyDirs = all.filter((e) => e.isDir && !nonEmpty.has(e.rel))
    return [
      ...emptyDirs.map((e) => ({ abs: e.abs, rel: e.rel, isDir: true })),
      ...files.map((e) => ({ abs: e.abs, rel: e.rel, isDir: false }))
    ]
  }

  async exportZip(id: string, destZip: string): Promise<number> {
    const dir = this.dirFor(id)
    const entries = await this.exportEntries(dir)
    if (isInside(dir, destZip)) {
      // Saving the archive inside the project: do not include it in itself.
      const self = path.relative(dir, destZip).split(path.sep).join('/')
      await createZip(entries.filter((e) => e.rel !== self), destZip)
    } else {
      await createZip(entries, destZip)
    }
    return entries.filter((e) => !e.isDir).length
  }
}
