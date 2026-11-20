import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createFile,
  createFolder,
  deleteEntry,
  importExternalFiles,
  moveEntry,
  readProjectFile,
  readTree,
  renameEntry,
  walk,
  writeProjectFile
} from '../../src/main/files'
import { syncTree } from '../../src/main/compile/sync'
import { resolveInside, sanitizeProjectName, sanitizeSegment, validateEntryName } from '../../src/main/util/fsx'
import { artifactStem, kindOfFile } from '../../src/shared/fileTypes'

let tmp: string
let root: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'underleaf-files-'))
  root = path.join(tmp, 'project')
  await fs.mkdir(path.join(root, 'sections'), { recursive: true })
  await fs.writeFile(path.join(root, 'main.tex'), 'main')
  await fs.writeFile(path.join(root, 'sections', 'b.tex'), 'b')
  await fs.writeFile(path.join(root, 'sections', 'a10.tex'), 'a10')
  await fs.writeFile(path.join(root, 'sections', 'a2.tex'), 'a2')
  await fs.writeFile(path.join(root, '.underleaf.json'), '{}')
  await fs.mkdir(path.join(root, '.git'))
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('path safety', () => {
  it('keeps every path inside the project', () => {
    expect(resolveInside(root, 'sections/a2.tex')).toBe(path.join(root, 'sections', 'a2.tex'))
    expect(resolveInside(root, '.')).toBe(root)
    expect(() => resolveInside(root, '../outside.txt')).toThrow()
    expect(() => resolveInside(root, 'sections/../../outside.txt')).toThrow()
    expect(() => resolveInside(root, path.join(tmp, 'elsewhere'))).toThrow()
    expect(() => resolveInside(root, 'a\0b')).toThrow()
  })

  it('validates and sanitises names', () => {
    expect(validateEntryName('  chapter 1.tex ')).toBe('chapter 1.tex')
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'what?.tex', 'trailing.', 'x'.repeat(151)]) {
      expect(() => validateEntryName(bad), bad).toThrow()
    }
    expect(sanitizeSegment('fig:1?.png')).toBe('fig_1_.png')
    expect(sanitizeSegment('...')).toBe('_')
    expect(sanitizeProjectName('')).toBe('Untitled Project')
    expect(sanitizeProjectName('.hidden')).toBe('hidden')
    expect(sanitizeProjectName('Report 2024.')).toBe('Report 2024')
  })

  it('classifies files', () => {
    expect(kindOfFile('main.tex')).toBe('text')
    expect(kindOfFile('figures/plot.PNG')).toBe('image')
    expect(kindOfFile('paper.pdf')).toBe('pdf')
    expect(kindOfFile('archive.zip')).toBe('binary')
    expect(kindOfFile('latexmkrc')).toBe('text')
    expect(kindOfFile('mystery.xyz')).toBe('unknown')
    expect(artifactStem('main.synctex.gz')).toBe('main')
    expect(artifactStem('sub/output.aux')).toBe('output')
    expect(artifactStem('main.tex')).toBeNull()
    expect(artifactStem('.aux')).toBeNull()
  })
})

describe('file tree', () => {
  it('lists folders first, sorts naturally and hides internal files', async () => {
    const tree = await readTree(root)
    expect(tree.map((n) => n.name)).toEqual(['sections', 'main.tex'])
    expect(tree[0].children?.map((n) => n.path)).toEqual(['sections/a2.tex', 'sections/a10.tex', 'sections/b.tex'])
  })

  it('creates, renames, moves and deletes entries', async () => {
    await createFile(root, 'notes/todo.txt', 'x')
    await expect(createFile(root, 'notes/todo.txt', 'y')).rejects.toThrow(/already exists/)
    await expect(createFile(root, 'bad|name.tex', '')).rejects.toThrow()
    await createFolder(root, 'figures')
    await expect(createFolder(root, 'figures')).rejects.toThrow(/already exists/)

    expect(await renameEntry(root, 'notes/todo.txt', 'done.txt')).toBe('notes/done.txt')
    await expect(renameEntry(root, 'main.tex', 'sections')).rejects.toThrow(/already exists/)
    // Changing only the case of a name must work on case-insensitive file systems too.
    expect(await renameEntry(root, 'main.tex', 'Main.tex')).toBe('Main.tex')
    expect(await fs.readdir(root)).toContain('Main.tex')

    expect(await moveEntry(root, 'notes/done.txt', 'figures')).toBe('figures/done.txt')
    expect(await moveEntry(root, 'figures/done.txt', '')).toBe('done.txt')
    await expect(moveEntry(root, 'sections', 'sections')).rejects.toThrow(/into itself/)
    await fs.mkdir(path.join(root, 'sections', 'deep'))
    await expect(moveEntry(root, 'sections', 'sections/deep')).rejects.toThrow(/into itself/)
    await fs.writeFile(path.join(root, 'figures', 'b.tex'), 'clash')
    await expect(moveEntry(root, 'sections/b.tex', 'figures')).rejects.toThrow(/already exists/)

    const trashed: string[] = []
    const deleted = await deleteEntry(root, 'done.txt', async (p) => {
      trashed.push(p)
      await fs.rm(p)
    })
    expect(deleted).toBe(true)
    expect(trashed).toEqual([path.join(root, 'done.txt')])

    // Without a trash nothing is deleted unless that is asked for explicitly.
    const noTrash = async (): Promise<void> => {
      throw new Error('no trash here')
    }
    expect(await deleteEntry(root, 'notes', noTrash)).toBe(false)
    expect(await fs.readdir(root)).toContain('notes')
    expect(await deleteEntry(root, 'notes', noTrash, true)).toBe(true)
    expect(await fs.readdir(root)).not.toContain('notes')
    expect(await deleteEntry(root, 'was-never-there.txt', noTrash)).toBe(true)
    await expect(deleteEntry(root, '.', async () => undefined)).rejects.toThrow()
  })
})

describe('safeguards', () => {
  it('fails loudly instead of handing out a cut-off file list', async () => {
    for (let i = 0; i < 12; i++) await fs.writeFile(path.join(root, `extra${i}.txt`), 'x')
    expect(await walk(root, { max: 5 })).toHaveLength(5)
    await expect(walk(root, { max: 5, strict: true })).rejects.toThrow(/more than 5 files/)
    // Exactly at the limit nothing is missing.
    const total = (await walk(root)).length
    expect(await walk(root, { max: total, strict: true })).toHaveLength(total)
  })

  it('does not bring back a project folder that is gone', async () => {
    const gone = path.join(tmp, 'renamed-away')
    await expect(writeProjectFile(gone, 'main.tex', 'x', '\n')).rejects.toThrow(/no longer exists/)
    await expect(createFile(gone, 'main.tex', '')).rejects.toThrow(/no longer exists/)
    await expect(createFolder(gone, 'figures')).rejects.toThrow(/no longer exists/)
    await expect(fs.stat(gone)).rejects.toThrow()
  })

  it('does not follow a linked folder out of the project', async () => {
    const outside = path.join(tmp, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
    await fs.symlink(outside, path.join(root, 'link'), 'junction')

    // Listings leave it out ...
    expect((await readTree(root)).map((n) => n.name)).not.toContain('link')
    expect((await walk(root)).some((e) => e.rel.startsWith('link'))).toBe(false)
    // ... and requests that name a path through it are refused.
    await expect(readProjectFile(root, 'link/secret.txt')).rejects.toThrow(/outside/)
    await expect(writeProjectFile(root, 'link/new.txt', 'x', '\n')).rejects.toThrow(/outside/)
    await expect(createFile(root, 'link/new.txt', '')).rejects.toThrow(/outside/)
    await expect(renameEntry(root, 'link/secret.txt', 'renamed.txt')).rejects.toThrow(/outside/)
    await expect(moveEntry(root, 'main.tex', 'link')).rejects.toThrow(/outside/)
    await expect(deleteEntry(root, 'link/secret.txt', async () => undefined, true)).rejects.toThrow(/outside/)
    expect(await fs.readdir(outside)).toEqual(['secret.txt'])
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret')
  })

  it('keeps working with a linked file, such as a bibliography shared between projects', async () => {
    const shared = path.join(tmp, 'library.bib')
    await fs.writeFile(shared, '@book{a,}')
    try {
      await fs.symlink(shared, path.join(root, 'refs.bib'), 'file')
    } catch {
      return // Windows without the right to create file links
    }
    expect((await walk(root)).map((e) => e.rel)).toContain('refs.bib')
    expect(await readProjectFile(root, 'refs.bib')).toMatchObject({ kind: 'text', content: '@book{a,}' })
    // Saving writes through the link instead of replacing it with a copy.
    await writeProjectFile(root, 'refs.bib', '@book{b,}', '\n')
    expect(await fs.readFile(shared, 'utf8')).toBe('@book{b,}')
    expect((await fs.lstat(path.join(root, 'refs.bib'))).isSymbolicLink()).toBe(true)
  })
})

describe('reading and writing text', () => {
  it('normalises line endings on read and restores them on write', async () => {
    await fs.writeFile(path.join(root, 'crlf.tex'), 'one\r\ntwo\r\n')
    const res = await readProjectFile(root, 'crlf.tex')
    expect(res).toMatchObject({ kind: 'text', content: 'one\ntwo\n', eol: '\r\n', transcoded: false })
    await writeProjectFile(root, 'crlf.tex', 'one\ntwo\nthree\n', '\r\n')
    expect(await fs.readFile(path.join(root, 'crlf.tex'), 'utf8')).toBe('one\r\ntwo\r\nthree\r\n')
    await writeProjectFile(root, 'lf.tex', 'a\nb\n', '\n')
    expect(await fs.readFile(path.join(root, 'lf.tex'), 'utf8')).toBe('a\nb\n')
  })

  it('decodes legacy encodings and byte-order marks', async () => {
    await fs.writeFile(path.join(root, 'latin1.tex'), Buffer.from([0x63, 0x61, 0x66, 0xe9])) // "café"
    expect(await readProjectFile(root, 'latin1.tex')).toMatchObject({ content: 'café', transcoded: true })
    await fs.writeFile(path.join(root, 'bom.tex'), Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]))
    expect(await readProjectFile(root, 'bom.tex')).toMatchObject({ content: 'hi', transcoded: false })
    await fs.writeFile(path.join(root, 'utf16.txt'), Buffer.from('﻿hi', 'utf16le'))
    expect(await readProjectFile(root, 'utf16.txt')).toMatchObject({ content: 'hi', transcoded: true })
  })

  it('does not treat binary data as text', async () => {
    await fs.writeFile(path.join(root, 'blob.dat2'), Buffer.from([1, 2, 0, 3]))
    expect((await readProjectFile(root, 'blob.dat2')).kind).toBe('binary')
    await fs.writeFile(path.join(root, 'fig.png'), 'not really a png')
    expect((await readProjectFile(root, 'fig.png')).kind).toBe('image')
    await expect(readProjectFile(root, '../secret')).rejects.toThrow()
    await expect(writeProjectFile(root, '../secret', 'x', '\n')).rejects.toThrow()
  })
})

describe('uploading files into a project', () => {
  it('copies files and folders, and asks before overwriting', async () => {
    const outside = path.join(tmp, 'outside')
    await fs.mkdir(path.join(outside, 'data', 'nested'), { recursive: true })
    await fs.writeFile(path.join(outside, 'plot.png'), 'png')
    await fs.writeFile(path.join(outside, 'main.tex'), 'other main')
    await fs.writeFile(path.join(outside, 'data', 'nested', 'x.csv'), '1,2')

    const first = await importExternalFiles(root, 'sections', [path.join(outside, 'plot.png'), path.join(outside, 'data')], false)
    expect(first.conflicts).toEqual([])
    expect(first.imported.sort()).toEqual(['sections/data/nested/x.csv', 'sections/plot.png'])

    const clash = await importExternalFiles(root, '', [path.join(outside, 'main.tex')], false)
    expect(clash).toMatchObject({ imported: [], conflicts: ['main.tex'] })
    expect(await fs.readFile(path.join(root, 'main.tex'), 'utf8')).toBe('main')

    const forced = await importExternalFiles(root, '', clash.sources, true)
    expect(forced.imported).toEqual(['main.tex'])
    expect(await fs.readFile(path.join(root, 'main.tex'), 'utf8')).toBe('other main')
  })

  it('ignores attempts to import the project into itself', async () => {
    const result = await importExternalFiles(root, 'sections', [root, tmp], false)
    expect(result.imported).toEqual([])
  })
})

describe('build mirror', () => {
  it('copies sources, follows changes and leaves generated files alone', async () => {
    const work = path.join(tmp, 'cache', 'work')
    const manifest = path.join(tmp, 'cache', 'manifest.json')

    let result = await syncTree(root, work, manifest)
    expect(result.copied).toBe(4)
    expect(result.files.sort()).toEqual(['main.tex', 'sections/a10.tex', 'sections/a2.tex', 'sections/b.tex'])
    expect((await fs.readdir(work)).sort()).toEqual(['main.tex', 'sections']) // no .git, no settings file

    // The compiler writes its own files into the mirror.
    await fs.writeFile(path.join(work, 'output.aux'), 'aux')
    await fs.writeFile(path.join(work, 'sections', 'b.aux'), 'aux')

    result = await syncTree(root, work, manifest)
    expect(result).toMatchObject({ copied: 0, removed: 0 })

    await new Promise((r) => setTimeout(r, 20))
    await fs.writeFile(path.join(root, 'main.tex'), 'main changed')
    await fs.rm(path.join(root, 'sections', 'a2.tex'))
    await fs.writeFile(path.join(root, 'new.bib'), '@book{x,}')

    result = await syncTree(root, work, manifest)
    expect(result).toMatchObject({ copied: 2, removed: 1 })
    expect(await fs.readFile(path.join(work, 'main.tex'), 'utf8')).toBe('main changed')
    expect((await fs.readdir(path.join(work, 'sections'))).sort()).toEqual(['a10.tex', 'b.aux', 'b.tex'])
    expect(await fs.readFile(path.join(work, 'output.aux'), 'utf8')).toBe('aux')

    // A file that vanished from the mirror is restored.
    await fs.rm(path.join(work, 'sections', 'b.tex'))
    result = await syncTree(root, work, manifest)
    expect(result.copied).toBe(1)
  })
})
