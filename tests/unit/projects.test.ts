import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import yazl from 'yazl'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { walk } from '../../src/main/files'
import {
  findRootDoc,
  guessCompiler,
  hasDocumentClass,
  META_FILE,
  ProjectLibrary,
  titleFromTex
} from '../../src/main/projects'
import { createZip, extractZip } from '../../src/main/zip'

let tmp: string
let libraryDir: string
let external: string[]
let trashed: string[]
let library: ProjectLibrary

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'underleaf-projects-'))
  libraryDir = path.join(tmp, 'Library')
  external = []
  trashed = []
  library = new ProjectLibrary({
    libraryPath: () => libraryDir,
    externalProjects: () => external,
    setExternalProjects: async (list) => {
      external = list
    },
    trash: async (target) => {
      trashed.push(target)
      await fs.rm(target, { recursive: true, force: true })
    }
  })
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

/** Builds a zip in memory; `files` maps archive paths to contents (null = empty folder). */
function zipBuffer(files: Record<string, string | null>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile()
    for (const [name, content] of Object.entries(files)) {
      if (content === null) zip.addEmptyDirectory(name)
      else zip.addBuffer(Buffer.from(content), name)
    }
    zip.end()
    const chunks: Buffer[] = []
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c))
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
    zip.outputStream.on('error', reject)
  })
}

async function writeZip(name: string, files: Record<string, string | null>): Promise<string> {
  const file = path.join(tmp, name)
  await fs.writeFile(file, await zipBuffer(files))
  return file
}

const MAIN = '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n'

async function fileList(dir: string): Promise<string[]> {
  return (await walk(dir)).filter((e) => !e.isDir).map((e) => e.rel).sort()
}

describe('ProjectLibrary basics', () => {
  it('creates projects with unique names and lists them', async () => {
    const a = await library.create('My Paper', 'blank')
    const b = await library.create('My Paper', 'blank')
    const c = await library.create('  Weird: name? / here  ', 'example')
    expect(a.name).toBe('My Paper')
    expect(b.name).toBe('My Paper (1)')
    expect(c.name).toBe('Weird name here')
    expect(a.location).toBe('library')
    const names = (await library.list()).map((p) => p.name).sort()
    expect(names).toEqual(['My Paper', 'My Paper (1)', 'Weird name here'])
    expect(await fileList(c.path)).toEqual(['figures/wave.png', 'main.tex', 'references.bib'])
    expect(library.dirFor(a.id)).toBe(a.path)
  })

  it('refuses ids that do not point at a known project', () => {
    const outside = Buffer.from(path.join(tmp, 'elsewhere'), 'utf8').toString('base64url')
    expect(() => library.dirFor(outside)).toThrow()
    expect(() => library.dirFor('')).toThrow()
    const nested = Buffer.from(path.join(libraryDir, 'a', 'b'), 'utf8').toString('base64url')
    expect(() => library.dirFor(nested)).toThrow()
  })

  it('renames, copies and deletes', async () => {
    const p = await library.create('Draft', 'blank')
    const { summary: renamed } = await library.rename(p.id, 'Final')
    expect(renamed.name).toBe('Final')
    expect(await fs.readdir(libraryDir)).toEqual(['Final'])

    await fs.mkdir(path.join(renamed.path, '.git'))
    await fs.writeFile(path.join(renamed.path, '.git', 'HEAD'), 'ref')
    const copy = await library.copy(renamed.id, 'Final (Copy)')
    expect(await fileList(copy.path)).toEqual(['main.tex'])
    expect(await fs.readdir(copy.path)).not.toContain('.git')

    await expect(library.rename(copy.id, 'Final')).rejects.toThrow(/already exists/)

    await library.remove(copy.id)
    expect(trashed).toEqual([copy.path])
    expect((await library.list()).map((x) => x.name)).toEqual(['Final'])
  })

  it('links external folders without ever deleting them', async () => {
    const dir = path.join(tmp, 'elsewhere', 'thesis')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'thesis.tex'), MAIN)
    const p = await library.addExternal(dir)
    expect(p.location).toBe('external')
    expect((await library.list()).map((x) => x.name)).toEqual(['thesis'])
    await library.remove(p.id)
    expect(trashed).toEqual([])
    expect(await fs.readdir(dir)).toEqual(['thesis.tex'])
    expect(await library.list()).toEqual([])
    await expect(library.addExternal(tmp)).rejects.toThrow()
  })

  it('keeps an open project reachable when the library is pointed elsewhere', async () => {
    const p = await library.create('Open One', 'blank')
    library.markOpen(p.path)
    libraryDir = path.join(tmp, 'Another Library')
    // No longer listed, but the window that has it open can go on saving.
    expect(await library.list()).toEqual([])
    expect(library.dirFor(p.id)).toBe(p.path)
    // A rename is followed.
    const { summary } = await library.rename(p.id, 'Open Two')
    expect(library.dirFor(summary.id)).toBe(summary.path)
    expect(() => library.dirFor(p.id)).toThrow()
    // Once closed it is unknown again.
    library.markClosed(summary.path)
    expect(() => library.dirFor(summary.id)).toThrow()
  })

  it('never deletes a project for good when there is no trash', async () => {
    const noTrash = new ProjectLibrary({
      libraryPath: () => libraryDir,
      externalProjects: () => external,
      setExternalProjects: async (list) => {
        external = list
      },
      trash: async () => {
        throw new Error('not supported on this volume')
      }
    })
    const p = await noTrash.create('Keep Me', 'blank')
    await expect(noTrash.remove(p.id)).rejects.toThrow(/could not be moved to the trash/)
    expect(await fs.readdir(p.path)).toEqual(['main.tex'])
  })

  it('stores per-project settings next to the files', async () => {
    const p = await library.create('Meta', 'blank')
    expect(await library.readMeta(p.path)).toEqual({})
    await library.updateMeta(p.path, { compiler: 'xelatex', rootDoc: 'main.tex' })
    expect(await library.readMeta(p.path)).toEqual({ compiler: 'xelatex', rootDoc: 'main.tex' })
    expect(await library.effectiveCompiler(p.path, 'main.tex')).toBe('xelatex')
    await library.updateMeta(p.path, { rootDoc: undefined })
    expect(await library.readMeta(p.path)).toEqual({ compiler: 'xelatex' })
    // The settings file never shows up as a project file.
    expect(await fileList(p.path)).toEqual(['main.tex'])
  })
})

describe('main document and compiler detection', () => {
  it('prefers main.tex, then shallow files, and needs \\documentclass', async () => {
    const dir = path.join(tmp, 'detect')
    await fs.mkdir(path.join(dir, 'chapters'), { recursive: true })
    await fs.writeFile(path.join(dir, 'chapters', 'one.tex'), 'Just a chapter')
    expect(await findRootDoc(dir)).toBeNull()
    await fs.writeFile(path.join(dir, 'chapters', 'standalone.tex'), MAIN)
    expect(await findRootDoc(dir)).toBe('chapters/standalone.tex')
    await fs.writeFile(path.join(dir, 'thesis.tex'), MAIN)
    expect(await findRootDoc(dir)).toBe('thesis.tex')
    await fs.writeFile(path.join(dir, 'main.tex'), MAIN)
    expect(await findRootDoc(dir)).toBe('main.tex')
    expect(hasDocumentClass('% \\documentclass{article}\ntext')).toBe(false)
  })

  it('honours an explicit main document until it disappears', async () => {
    const p = await library.create('Root', 'blank')
    await fs.writeFile(path.join(p.path, 'other.tex'), MAIN)
    await library.updateMeta(p.path, { rootDoc: 'other.tex' })
    expect(await library.effectiveRootDoc(p.path)).toEqual({ rootDoc: 'other.tex', explicit: true })
    await fs.rm(path.join(p.path, 'other.tex'))
    expect(await library.effectiveRootDoc(p.path)).toEqual({ rootDoc: 'main.tex', explicit: false })
  })

  it('guesses the compiler from the source', () => {
    expect(guessCompiler(MAIN)).toBe('pdflatex')
    expect(guessCompiler('% !TEX program = xelatex\n' + MAIN)).toBe('xelatex')
    expect(guessCompiler('% !TeX TS-program = lualatex\n' + MAIN)).toBe('lualatex')
    expect(guessCompiler('\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}')).toBe('xelatex')
    expect(guessCompiler('\\documentclass{article}\n\\usepackage[no-math]{fontspec,luacode}\n')).toBe('lualatex')
    expect(guessCompiler('\\documentclass{article}\n% \\usepackage{fontspec}\n\\begin{document}')).toBe('pdflatex')
    expect(guessCompiler('\\documentclass{article}\n\\begin{document}\n\\usepackage{fontspec}')).toBe('pdflatex')
    expect(guessCompiler(MAIN, '$pdf_mode = 5;\n')).toBe('xelatex')
    expect(guessCompiler(MAIN, '$pdf_mode = 4;\n')).toBe('lualatex')
  })

  it('extracts a readable title', () => {
    expect(titleFromTex('\\title{A Study of \\LaTeX{} \\\\ in Two Lines}')).toBe('A Study of in Two Lines')
    expect(titleFromTex('\\title[short]{Nested {Braces} \\& more}')).toBe('Nested Braces & more')
    expect(titleFromTex('% \\title{Commented}\n')).toBeNull()
  })
})

describe('zip import (Overleaf -> Underleaf)', () => {
  it('imports an archive with files at the root, named after the zip', async () => {
    const zip = await writeZip('Quantum Paper.zip', {
      'main.tex': MAIN,
      'sections/intro.tex': 'Intro',
      'figures/': null,
      '__MACOSX/._main.tex': 'junk',
      '.DS_Store': 'junk'
    })
    const result = await library.importZip(zip, 'ask')
    expect(result.status).toBe('imported')
    if (result.status !== 'imported') return
    expect(result.project.name).toBe('Quantum Paper')
    expect(result.replaced).toBe(false)
    expect(await fileList(result.project.path)).toEqual(['main.tex', 'sections/intro.tex'])
    expect((await fs.stat(path.join(result.project.path, 'figures'))).isDirectory()).toBe(true)
    // No staging folders are left behind.
    expect((await fs.readdir(libraryDir)).filter((n) => n.startsWith('.'))).toEqual([])
  })

  it('unwraps archives that contain a single top-level folder', async () => {
    const zip = await writeZip('wrapped.zip', { 'paper/main.tex': MAIN, 'paper/refs.bib': '@book{a,}' })
    const result = await library.importZip(zip, 'ask')
    if (result.status !== 'imported') throw new Error('expected an import')
    expect(await fileList(result.project.path)).toEqual(['main.tex', 'refs.bib'])
  })

  it('reports a conflict instead of touching an existing project', async () => {
    const existing = await library.create('Paper', 'blank')
    const zip = await writeZip('Paper.zip', { 'main.tex': 'NEW' })
    const result = await library.importZip(zip, 'ask')
    expect(result.status).toBe('conflict')
    if (result.status !== 'conflict') return
    expect(result.existing.id).toBe(existing.id)
    expect(await fs.readFile(path.join(existing.path, 'main.tex'), 'utf8')).not.toBe('NEW')
  })

  it('treats a browser-renamed download ("Paper (2).zip") as the same project', async () => {
    await library.create('Paper', 'blank')
    const zip = await writeZip('Paper (2).zip', { 'main.tex': 'NEW' })
    const ask = await library.importZip(zip, 'ask')
    expect(ask.status).toBe('conflict')
    const both = await library.importZip(zip, 'keep-both')
    if (both.status !== 'imported') throw new Error('expected an import')
    expect(both.project.name).toBe('Paper (2)')
  })

  it('keeps both when asked', async () => {
    await library.create('Paper', 'blank')
    const zip = await writeZip('Paper.zip', { 'main.tex': 'NEW' })
    const result = await library.importZip(zip, 'keep-both')
    if (result.status !== 'imported') throw new Error('expected an import')
    expect(result.project.name).toBe('Paper (1)')
    expect(result.replaced).toBe(false)
  })

  it('replaces in place, keeping settings and git data, and trashes the old files', async () => {
    const existing = await library.create('Paper', 'blank')
    await library.updateMeta(existing.path, { compiler: 'lualatex' })
    await fs.mkdir(path.join(existing.path, '.git'))
    await fs.writeFile(path.join(existing.path, '.git', 'HEAD'), 'ref: refs/heads/main')
    await fs.writeFile(path.join(existing.path, '.gitignore'), '*.pdf')
    await fs.writeFile(path.join(existing.path, 'old-notes.tex'), 'old')

    const zip = await writeZip('Paper.zip', {
      'main.tex': 'NEW MAIN',
      'chapters/one.tex': 'one',
      // An archive must not be able to overwrite local settings or git data.
      [META_FILE]: '{"compiler":"latex"}',
      '.git/HEAD': 'evil'
    })
    const result = await library.importZip(zip, 'replace')
    if (result.status !== 'imported') throw new Error('expected an import')
    expect(result.replaced).toBe(true)
    expect(result.project.id).toBe(existing.id)

    expect(await fileList(existing.path)).toEqual(['.gitignore', 'chapters/one.tex', 'main.tex'])
    expect(await fs.readFile(path.join(existing.path, 'main.tex'), 'utf8')).toBe('NEW MAIN')
    expect(await fs.readFile(path.join(existing.path, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main')
    expect(await library.readMeta(existing.path)).toEqual({ compiler: 'lualatex' })

    // The previous files went to the "trash" as one recognisable folder.
    expect(trashed).toHaveLength(1)
    expect(path.basename(trashed[0])).toMatch(/^Paper \(replaced \d{4}-\d{2}-\d{2} \d{6}\)$/)
    expect((await library.list()).map((p) => p.name)).toEqual(['Paper'])
  })

  it('rejects archives that try to write outside the project', async () => {
    // yazl refuses to create such an entry, so patch a valid archive's bytes.
    const good = await zipBuffer({ 'aa/evil.txt': 'x' })
    const bad = Buffer.from(good.toString('latin1').replaceAll('aa/evil.txt', '../evil.txt'), 'latin1')
    const zip = path.join(tmp, 'Evil.zip')
    await fs.writeFile(zip, bad)
    await expect(library.importZip(zip, 'ask')).rejects.toThrow()
    expect(await fs.readdir(tmp)).not.toContain('evil.txt')
    expect((await fs.readdir(libraryDir)).filter((n) => n.startsWith('.'))).toEqual([])
    expect(await library.list()).toEqual([])
  })

  it('rejects an empty archive', async () => {
    const zip = await writeZip('Empty.zip', {})
    await expect(library.importZip(zip, 'ask')).rejects.toThrow(/empty/)
  })
})

describe('zip export (Underleaf -> Overleaf)', () => {
  it('exports sources at the archive root without settings, git data or build products', async () => {
    const p = await library.create('Export Me', 'example')
    await library.updateMeta(p.path, { compiler: 'xelatex' })
    await fs.mkdir(path.join(p.path, '.git'))
    await fs.writeFile(path.join(p.path, '.git', 'HEAD'), 'ref')
    await fs.mkdir(path.join(p.path, 'empty-folder'))
    // Leftovers from compiling in place with another tool:
    await fs.writeFile(path.join(p.path, 'main.aux'), 'aux')
    await fs.writeFile(path.join(p.path, 'main.log'), 'log')
    await fs.writeFile(path.join(p.path, 'main.synctex.gz'), 'gz')
    // Not build products: no .tex file of the same name next to them.
    await fs.writeFile(path.join(p.path, 'results.out'), 'data')
    await fs.writeFile(path.join(p.path, 'main.bbl'), 'bbl')

    const dest = path.join(tmp, 'export.zip')
    const count = await library.exportZip(p.id, dest)
    const out = path.join(tmp, 'unzipped')
    await fs.mkdir(out)
    await extractZip(dest, out)

    expect(await fileList(out)).toEqual(['figures/wave.png', 'main.bbl', 'main.tex', 'references.bib', 'results.out'])
    expect(count).toBe(5)
    expect((await fs.stat(path.join(out, 'empty-folder'))).isDirectory()).toBe(true)
  })

  it('round-trips: export, then import as a new project, gives identical files', async () => {
    const p = await library.create('Round Trip', 'example')
    await fs.writeFile(path.join(p.path, 'ünïcödé naïve.tex'), 'accents: é ü 中文')
    const dest = path.join(tmp, 'Round Trip Copy.zip')
    await library.exportZip(p.id, dest)
    const result = await library.importZip(dest, 'ask')
    if (result.status !== 'imported') throw new Error('expected an import')
    const original = await fileList(p.path)
    expect(await fileList(result.project.path)).toEqual(original)
    for (const rel of original) {
      const a = await fs.readFile(path.join(p.path, rel))
      const b = await fs.readFile(path.join(result.project.path, rel))
      expect(b.equals(a), rel).toBe(true)
    }
  })

  it('fails cleanly, leaving nothing behind, when a file cannot be read', async () => {
    const dest = path.join(tmp, 'broken.zip')
    const entries = [
      { abs: path.join(tmp, 'vanished.tex'), rel: 'vanished.tex', isDir: false },
      { abs: path.join(tmp, 'also-gone.png'), rel: 'figures/also-gone.png', isDir: false }
    ]
    await expect(createZip(entries, dest)).rejects.toThrow()
    expect((await fs.readdir(tmp)).filter((n) => n.startsWith('broken.zip'))).toEqual([])
    // A failed attempt does not destroy an archive that is already there.
    await fs.writeFile(dest, 'previous archive')
    await expect(createZip(entries, dest)).rejects.toThrow()
    expect(await fs.readFile(dest, 'utf8')).toBe('previous archive')
  })

  it('does not include an archive saved inside the project in itself', async () => {
    const p = await library.create('Self', 'blank')
    const dest = path.join(p.path, 'backup.zip')
    await library.exportZip(p.id, dest)
    await library.exportZip(p.id, dest) // overwrite: the old archive must not be packed
    const out = path.join(tmp, 'self-out')
    await fs.mkdir(out)
    await extractZip(dest, out)
    expect(await fileList(out)).toEqual(['main.tex'])
  })
})
