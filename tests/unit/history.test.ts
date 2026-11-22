import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryManager, stampsToDrop } from '../../src/main/history'
import { exampleFigurePng } from '../../src/main/templates'
import { writeFileAtomic } from '../../src/main/util/fsx'
import type { HistorySettings } from '../../src/shared/types'

const hasGit = spawnSync('git', ['--version']).status === 0

let tmp: string
let home: string
let project: string
let clock: number
let settings: HistorySettings
let changed: string[]
let history: HistoryManager

/**
 * Runs the real git, shielded from the configuration of whoever runs the
 * tests. What it commits is dated before the clock of the tests starts, so
 * that the order of the versions does not depend on the day the tests run.
 */
function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: path.join(tmp, 'empty-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_DATE: '2026-11-20T08:00:00Z',
      GIT_COMMITTER_DATE: '2026-11-20T08:00:00Z'
    }
  }).trim()
}

const AS_OWNER = ['-c', 'user.name=Owner', '-c', 'user.email=owner@example.org']

/** Stores content in the repository, as git's own tools do it, and returns its id. */
function blobOf(content: string | Buffer, dir = project): string {
  return execFileSync('git', ['-C', dir, 'hash-object', '-w', '--stdin'], { input: content, encoding: 'utf8' }).trim()
}

/** A tree from lines such as "100644 blob <id>\tname". */
function treeOf(lines: string[], dir = project): string {
  return execFileSync('git', ['-C', dir, 'mktree'], { input: lines.map((l) => `${l}\n`).join(''), encoding: 'utf8' }).trim()
}

function commitOf(tree: string, message: string, dir = project): string {
  return git(dir, ...AS_OWNER, 'commit-tree', tree, '-m', message)
}

/**
 * What git itself would put into a commit of everything: the files it tracks
 * and the ones it does not ignore. It reads the same configuration as the
 * code under test (the one in the pretended home folder).
 */
function gitFiles(dir: string, sub = ''): string[] {
  const out = execFileSync('git', ['-C', dir, 'ls-files', '-co', '--exclude-standard', '-z', ...(sub ? ['--', sub] : [])], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  })
  return [...new Set(out.split('\0').filter(Boolean))]
    .map((p) => (sub ? p.slice(sub.length + 1) : p))
    .filter((p) => path.posix.basename(p) !== '.underleaf.json') // never part of a version
    .sort()
}

async function write(rel: string, content: string | Buffer, root = project): Promise<void> {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content)
}

const read = (rel: string, root = project): Promise<string> => fs.readFile(path.join(root, rel), 'utf8')
const present = (rel: string, root = project): Promise<boolean> => fs.stat(path.join(root, rel)).then(() => true, () => false)
/** Versions are told apart by their time, so let some pass between them. */
const later = (minutes = 1): void => void (clock += minutes * 60_000)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const DAYS = 24 * 60
const filesOf = async (version: string, dir = project): Promise<string[]> =>
  (await history.changes(dir, null, version)).map((c) => c.path).sort()
const labels = async (dir = project): Promise<string[]> => (await history.list(dir)).versions.map((v) => v.label)
const failing = (code: string): Error => Object.assign(new Error(`${code}: made up for the test`), { code })

function newManager(): HistoryManager {
  return new HistoryManager({ settings: () => settings, homeDir: home, now: () => clock, onChanged: (dir) => changed.push(dir) })
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'underleaf-history-')))
  home = path.join(tmp, 'home')
  project = path.join(tmp, 'work', 'Paper')
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(project, { recursive: true })
  await fs.writeFile(path.join(tmp, 'empty-gitconfig'), '')
  await fs.writeFile(path.join(home, '.gitconfig'), '[core]\n\teditor = vi\n[user]\n\tname = Test Person\n\temail = "test@example.org"\n')
  clock = Date.UTC(2026, 10, 21, 12, 0, 0)
  settings = { auto: true, editsPerVersion: 10, editPauseSeconds: 5 }
  changed = []
  history = newManager()
  await write('main.tex', '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n')
  await write('refs.bib', '@book{a, title={A}}\n')
  await write('figures/plot.png', exampleFigurePng())
  await write('.underleaf.json', '{"compiler":"xelatex"}\n')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('a project without a repository', () => {
  it('has no versions and gets no repository while automatic versions are off', async () => {
    expect(await history.list(project)).toEqual({ repository: 'none', versions: [], more: false })
    settings.auto = false
    expect(await history.saveAuto(project, 'open')).toBeNull()
    expect(await history.saveAuto(project, 'before-import', 'Paper.zip')).toBeNull()
    expect(await present('.git')).toBe(false)
  })

  it('gets a repository of its own with the first version', async () => {
    const first = await history.saveAuto(project, 'open')
    expect(first).toMatchObject({ kind: 'auto', label: 'First version', onBranch: false, author: 'Test Person', time: clock })
    expect(changed).toEqual([project])
    expect(await read('.git/info/exclude')).toContain('.underleaf.json')

    const listed = await history.list(project)
    expect(listed.repository).toBe('own')
    expect(listed.versions).toEqual([first])
    // Nothing new: no second version.
    later()
    expect(await history.saveAuto(project, 'open')).toBeNull()
    expect((await history.list(project)).versions).toHaveLength(1)
  })

  it('saves a version by name even when automatic versions are off', async () => {
    settings.auto = false
    const v = await history.saveNamed(project, '  First   draft ')
    expect(v).toMatchObject({ kind: 'named', label: 'First draft', onBranch: true })
    await expect(history.saveNamed(project, '   ')).rejects.toThrow(/name/)
  })

  it('leaves a .git folder alone that is not a repository', async () => {
    await write('.git/keep.txt', 'something of the user\n')
    const listed = await history.list(project)
    expect(listed.repository).toBe('unsupported')
    expect(listed.reason).toMatch(/not a complete repository/)
    expect(await history.saveAuto(project, 'open')).toBeNull()
    await expect(history.saveNamed(project, 'One')).rejects.toThrow(/not a complete repository/)
    expect(await fs.readdir(path.join(project, '.git'))).toEqual(['keep.txt'])
  })

  it('saves nothing for a folder that is gone, and does not bring it back', async () => {
    await history.saveNamed(project, 'One')
    await fs.rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    expect(await history.saveAuto(project, 'close')).toBeNull()
    await expect(history.saveNamed(project, 'Two')).rejects.toThrow(/no longer exists/)
    expect(await present('.')).toBe(false)
  })
})

describe.skipIf(!hasGit)('a repository of its own, as real git sees it', () => {
  it('commits named versions to the branch and leaves the folder clean', async () => {
    await write('a-b', 'sorts before a.txt\n')
    await write('a.txt', 'sorts before the folder a\n')
    await write('a/inner.tex', 'inside\n')
    const first = await history.saveNamed(project, 'Draft 1')

    expect(git(project, 'fsck', '--no-dangling')).not.toMatch(/error|missing|broken/i)
    expect(git(project, 'log', '--format=%s|%an|%ae')).toBe('Draft 1|Test Person|test@example.org')
    expect(git(project, 'rev-parse', 'HEAD')).toBe(first.id)
    expect(git(project, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    expect(git(project, 'status', '--porcelain')).toBe('')
    expect(git(project, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')).toEqual([
      'a-b',
      'a.txt',
      'a/inner.tex',
      'figures/plot.png',
      'main.tex',
      'refs.bib'
    ])

    later()
    await write('main.tex', 'changed\n')
    await write('new/chapter.tex', 'new\n')
    await fs.rm(path.join(project, 'refs.bib'))
    await fs.rm(path.join(project, 'a'), { recursive: true })
    await history.saveNamed(project, 'Draft 2')

    expect(git(project, 'log', '--format=%s')).toBe('Draft 2\nDraft 1')
    expect(git(project, 'status', '--porcelain')).toBe('')
    expect(git(project, 'diff', '--name-status', 'HEAD~1', 'HEAD').split('\n').map((l) => l.replace(/\s+/, ' '))).toEqual([
      'D a/inner.tex',
      'M main.tex',
      'A new/chapter.tex',
      'D refs.bib'
    ])
    expect(git(project, 'fsck', '--no-dangling')).not.toMatch(/error|missing|broken/i)
  })

  it('keeps automatic versions beside the branch, away from its history and the index', async () => {
    await history.saveNamed(project, 'Draft 1')
    const head = git(project, 'rev-parse', 'HEAD')
    later()
    await write('main.tex', 'work in progress\n')
    const auto = await history.saveAuto(project, 'edits')
    expect(auto).toMatchObject({ kind: 'auto', label: 'Automatic version', onBranch: false })

    expect(git(project, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(project, 'log', '--format=%s')).toBe('Draft 1')
    // Still an unstaged change, exactly as before the automatic version.
    expect(git(project, 'status', '--porcelain')).toBe('M main.tex')
    expect(git(project, 'for-each-ref', '--format=%(refname)', 'refs/underleaf')).toMatch(/^refs\/underleaf\/auto\/\d{8}T\d{9}Z$/)
    expect(git(project, 'show', `${auto?.id}:main.tex`)).toBe('work in progress')
    // The automatic version hangs off the commit it was made on top of.
    expect(git(project, 'rev-parse', `${auto?.id}^`)).toBe(head)
  })

  it('keeps a file that the repository has although a rule ignores it', async () => {
    await write('.gitignore', '*.log\n')
    await write('keep.log', 'kept on purpose\n')
    await write('other.log', 'not kept\n')
    await history.saveNamed(project, 'One')
    expect(git(project, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toMatch(/\.log/)
    // The user adds one of them by hand, as git allows.
    git(project, 'add', '-f', 'keep.log')
    git(project, ...AS_OWNER, 'commit', '-q', '-m', 'Add the log by hand')

    later()
    await write('main.tex', 'changed\n')
    await write('keep.log', 'changed as well\n')
    await history.saveNamed(project, 'Two')
    expect(git(project, 'show', 'HEAD:keep.log')).toBe('changed as well')
    expect(git(project, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toMatch(/other\.log/)
    expect(git(project, 'status', '--porcelain')).toBe('')
  })

  it('writes a ref only when no other program is writing it, and leaves no lock behind', async () => {
    await history.saveNamed(project, 'One')
    later()
    await write('main.tex', 'two\n')
    // What git puts there while it updates the branch.
    await write('.git/refs/heads/main.lock', '')
    await expect(history.saveNamed(project, 'Two')).rejects.toThrow(/Another program is changing this repository/)
    expect(git(project, 'log', '--format=%s')).toBe('One')

    await fs.rm(path.join(project, '.git', 'refs', 'heads', 'main.lock'))
    await history.saveNamed(project, 'Two')
    later()
    await write('main.tex', 'three\n')
    await history.saveAuto(project, 'edits')
    expect(git(project, 'log', '--format=%s')).toBe('Two\nOne')
    const inRefs = await fs.readdir(path.join(project, '.git', 'refs'), { recursive: true })
    expect(inRefs.filter((name) => name.endsWith('.lock'))).toEqual([])
  })
})

describe('versions and what changed between them', () => {
  it('lists the newest first and says when there are more', async () => {
    const a = await history.saveNamed(project, 'One')
    later()
    await write('main.tex', 'two\n')
    const b = await history.saveAuto(project, 'edits')
    later()
    await write('main.tex', 'three\n')
    const c = await history.saveNamed(project, 'Three')

    const all = await history.list(project)
    expect(all.versions.map((v) => v.id)).toEqual([c.id, b?.id, a.id])
    expect(all.versions.map((v) => v.kind)).toEqual(['named', 'auto', 'named'])
    expect(all.more).toBe(false)
    const firstTwo = await history.list(project, 2)
    expect(firstTwo.versions.map((v) => v.id)).toEqual([c.id, b?.id])
    expect(firstTwo.more).toBe(true)
  })

  it('reports added, modified and deleted files', async () => {
    const one = await history.saveNamed(project, 'One')
    later()
    await write('main.tex', '\\documentclass{article}\n\\begin{document}\nGoodbye\n\\end{document}\n')
    await write('sections/intro.tex', 'Intro\n')
    await fs.rm(path.join(project, 'refs.bib'))
    const two = await history.saveNamed(project, 'Two')

    expect(await history.changes(project, one.id, two.id)).toEqual([
      { path: 'main.tex', status: 'modified' },
      { path: 'refs.bib', status: 'deleted' },
      { path: 'sections/intro.tex', status: 'added' }
    ])
    // The oldest version is compared with nothing: everything in it is new.
    expect((await history.changes(project, null, one.id)).map((c) => `${c.status} ${c.path}`)).toEqual([
      'added figures/plot.png',
      'added main.tex',
      'added refs.bib'
    ])
    // And any version can be compared with the folder as it is now.
    await write('main.tex', 'now\n')
    expect(await history.changes(project, two.id, 'current')).toEqual([{ path: 'main.tex', status: 'modified' }])
    expect(await history.changes(project, 'current', 'current')).toEqual([])
  })

  it('does not call a different kind of line end a change', async () => {
    const one = await history.saveNamed(project, 'One')
    await write('main.tex', (await read('main.tex')).replace(/\n/g, '\r\n'))
    expect(await history.changes(project, one.id, 'current')).toEqual([])
    await write('main.tex', (await read('main.tex')).replace('Hello', 'Hallo'))
    expect(await history.changes(project, one.id, 'current')).toEqual([{ path: 'main.tex', status: 'modified' }])
  })

  it('hands out both states of a file', async () => {
    const one = await history.saveNamed(project, 'One')
    later()
    await write('main.tex', 'Line one\r\nLine two\r\n')
    await write('figures/plot.png', Buffer.concat([exampleFigurePng(), Buffer.from('more')]))
    await write('data.bin', Buffer.from([1, 2, 0, 3]))
    const two = await history.saveNamed(project, 'Two')

    expect(await history.file(project, one.id, two.id, 'main.tex')).toEqual({
      kind: 'text',
      before: '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      after: 'Line one\nLine two\n'
    })
    const picture = await history.file(project, one.id, two.id, 'figures/plot.png')
    expect(picture).toMatchObject({ kind: 'image', mime: 'image/png' })
    if (picture.kind === 'image') {
      expect(picture.before?.length).toBe(exampleFigurePng().length)
      expect(picture.after?.length).toBe(exampleFigurePng().length + 4)
    }
    expect(await history.file(project, one.id, two.id, 'data.bin')).toEqual({ kind: 'binary', before: null, after: 4 })
    expect(await history.file(project, null, one.id, 'refs.bib')).toEqual({ kind: 'text', before: null, after: '@book{a, title={A}}\n' })
    await expect(history.file(project, one.id, two.id, 'nowhere.tex')).rejects.toThrow(/neither/)
    await expect(history.changes(project, 'not-a-version', two.id)).rejects.toThrow(/Unknown version/)
  })
})

describe('restoring', () => {
  it('puts the whole project back and keeps what was there as a version', async () => {
    const one = await history.saveNamed(project, 'One')
    later()
    await write('main.tex', 'rewritten\n')
    await write('notes/todo.tex', 'to do\n')
    await write('notes/deep/more.tex', 'more\n')
    await fs.rm(path.join(project, 'refs.bib'))
    await write('.underleaf.json', '{"compiler":"lualatex"}\n')
    later()

    expect(await history.restore(project, one.id, null)).toEqual({ left: [], failed: [] })

    expect(await read('main.tex')).toContain('Hello')
    expect(await read('refs.bib')).toBe('@book{a, title={A}}\n')
    expect(await present('notes')).toBe(false) // the files and the folders they left empty
    // The project's settings are not part of any version.
    expect(await read('.underleaf.json')).toBe('{"compiler":"lualatex"}\n')
    expect(await history.changes(project, one.id, 'current')).toEqual([])

    const { versions } = await history.list(project)
    expect(versions.map((v) => v.label)).toEqual(['Before restoring an earlier version', 'One'])
    // ... from which the restore can be taken back.
    later()
    await history.restore(project, versions[0].id, null)
    expect(await read('main.tex')).toBe('rewritten\n')
    expect(await read('notes/deep/more.tex')).toBe('more\n')
    expect(await present('refs.bib')).toBe(false)
    // Every restore leaves the state it replaced behind as a version.
    expect(await labels()).toEqual(['Before restoring an earlier version', 'Before restoring an earlier version', 'One'])
    // Restoring what is already there changes nothing and needs no copy.
    later()
    await history.restore(project, versions[0].id, null)
    expect((await history.list(project)).versions).toHaveLength(3)
  })

  it('copes with a file where the version has a folder of that name, and the other way round', async () => {
    await write('data', 'a file called data\n')
    await write('plots/one.tex', 'a folder called plots\n')
    const one = await history.saveNamed(project, 'One')
    later()
    await fs.rm(path.join(project, 'data'))
    await write('data/inside.tex', 'now data is a folder\n')
    await fs.rm(path.join(project, 'plots'), { recursive: true })
    await write('plots', 'now plots is a file\n')

    expect(await history.restore(project, one.id, null)).toEqual({ left: [], failed: [] })
    expect(await read('data')).toBe('a file called data\n')
    expect(await read('plots/one.tex')).toBe('a folder called plots\n')
    expect(await history.changes(project, one.id, 'current')).toEqual([])
  })

  it('puts back a single file', async () => {
    const one = await history.saveNamed(project, 'One')
    later()
    await write('main.tex', 'rewritten\n')
    await write('refs.bib', 'also rewritten\n')
    await history.restore(project, one.id, 'refs.bib')
    expect(await read('refs.bib')).toBe('@book{a, title={A}}\n')
    expect(await read('main.tex')).toBe('rewritten\n')
    await expect(history.restore(project, one.id, 'never-existed.tex')).rejects.toThrow(/no such file/)
  })

  it('keeps the copies made before a restore for good, while the routine versions thin out', async () => {
    const one = await history.saveNamed(project, 'One')
    for (const text of ['a\n', 'b\n']) {
      later()
      await write('main.tex', text)
      await history.saveAuto(project, 'edits')
    }
    later()
    await write('main.tex', 'c\n')
    await history.restore(project, one.id, null)
    expect(await labels()).toEqual(['Before restoring an earlier version', 'Automatic version', 'Automatic version', 'One'])

    // Ten days on, work continues: of that day's routine versions only the
    // last one stays. The copy is not one of them.
    later(10 * DAYS)
    await write('main.tex', 'd\n')
    await history.saveAuto(project, 'edits')
    expect(await labels()).toEqual(['Automatic version', 'Before restoring an earlier version', 'Automatic version', 'One'])
    const copy = (await history.list(project)).versions[1]
    expect(await history.file(project, null, copy.id, 'main.tex')).toMatchObject({ after: 'c\n' })
    expect(await fs.readdir(path.join(project, '.git', 'refs', 'underleaf', 'kept'))).toHaveLength(1)
  })

  it('makes that copy even when a routine version of the same state exists', async () => {
    const one = await history.saveNamed(project, 'One')
    later()
    await write('main.tex', 'work\n')
    await history.saveAuto(project, 'edits')
    later()
    // The newest version is what is in the folder, but it will not be kept for good.
    await history.restore(project, one.id, null)
    expect(await labels()).toEqual(['Before restoring an earlier version', 'Automatic version', 'One'])
  })

  it('leaves a file alone that is too large to keep versions of', async () => {
    await write('data.bin', 'small\n')
    const one = await history.saveNamed(project, 'One')
    later()
    const big = 100 * 1024 * 1024 + 1
    await fs.truncate(path.join(project, 'data.bin'), big)
    // No copy of it would be in the history, so it is not replaced.
    const result = await history.restore(project, one.id, null)
    expect(result).toEqual({ left: [{ path: 'data.bin', reason: 'unversioned' }], failed: [] })
    expect((await fs.stat(path.join(project, 'data.bin'))).size).toBe(big)
  })

  it('leaves a repository inside the project alone', async () => {
    await write('vendor/note.tex', 'ours\n')
    await write('vendor/lib/code.tex', 'ours, for now\n')
    await write('vendor/lib/gone.tex', 'ours, for now\n')
    const before = await history.saveNamed(project, 'Before')
    later()
    // The folder becomes a repository of its own: a clone, a submodule.
    await write('vendor/lib/.git/HEAD', 'ref: refs/heads/main\n')
    await write('vendor/lib/code.tex', 'theirs\n')
    await fs.rm(path.join(project, 'vendor', 'lib', 'gone.tex'))
    const after = await history.saveNamed(project, 'After')
    expect(await filesOf(after.id)).toEqual(['figures/plot.png', 'main.tex', 'refs.bib', 'vendor/note.tex'])

    later()
    await write('main.tex', 'changed\n')
    const result = await history.restore(project, before.id, null)
    // Neither replaced, nor removed, nor added to.
    expect(await read('vendor/lib/code.tex')).toBe('theirs\n')
    expect(await present('vendor/lib/gone.tex')).toBe(false)
    expect(await read('main.tex')).toContain('Hello')
    expect(result.left.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'vendor/lib/code.tex', reason: 'unversioned' },
      { path: 'vendor/lib/gone.tex', reason: 'unversioned' }
    ])
  })

  it('puts back a file that is marked read-only, and removes one', async () => {
    const one = await history.saveNamed(project, 'One')
    later()
    await write('main.tex', 'rewritten\n')
    await write('extra.tex', 'added\n')
    await fs.chmod(path.join(project, 'main.tex'), 0o444)
    await fs.chmod(path.join(project, 'extra.tex'), 0o444)
    expect(await history.restore(project, one.id, null)).toEqual({ left: [], failed: [] })
    expect(await read('main.tex')).toContain('Hello')
    expect(await present('extra.tex')).toBe(false)
  })

  it('says which files could not be put back, and puts back the others', async () => {
    const one = await history.saveNamed(project, 'One')
    later()
    await write('main.tex', 'rewritten\n')
    await write('refs.bib', 'rewritten\n')
    const real = fs.writeFile.bind(fs) as (...args: unknown[]) => Promise<void>
    vi.spyOn(fs, 'writeFile').mockImplementation(((file: unknown, ...rest: unknown[]) =>
      String(file).startsWith(path.join(project, 'main.tex')) ? Promise.reject(failing('EIO')) : real(file, ...rest)) as never)
    const result = await history.restore(project, one.id, null)
    vi.restoreAllMocks()

    expect(result).toEqual({ left: [], failed: [{ path: 'main.tex', message: expect.stringContaining('EIO') }] })
    expect(await read('refs.bib')).toBe('@book{a, title={A}}\n')
    expect(await read('main.tex')).toBe('rewritten\n')
    expect((await fs.readdir(project)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    // What was there is in the history, and the restore can be done again.
    expect(await labels()).toEqual(['Before restoring an earlier version', 'One'])
    later()
    expect(await history.restore(project, one.id, null)).toEqual({ left: [], failed: [] })
    expect(await read('main.tex')).toContain('Hello')
  })

  it.runIf(process.platform !== 'linux')('takes names that differ only in case for one file', async () => {
    await write('Notes.tex', 'old\n')
    const one = await history.saveNamed(project, 'One')
    later()
    await fs.rename(path.join(project, 'Notes.tex'), path.join(project, 'notes.tex'))
    // The folder does not tell the two names apart, so nothing has changed.
    expect(await history.changes(project, one.id, 'current')).toEqual([])
    await write('notes.tex', 'new\n')
    expect(await history.changes(project, one.id, 'current')).toEqual([{ path: 'notes.tex', status: 'modified' }])
    expect(await history.file(project, one.id, 'current', 'notes.tex')).toEqual({ kind: 'text', before: 'old\n', after: 'new\n' })

    expect(await history.restore(project, one.id, null)).toEqual({ left: [], failed: [] })
    expect((await fs.readdir(project)).filter((name) => name.toLowerCase() === 'notes.tex')).toHaveLength(1)
    expect(await read('notes.tex')).toBe('old\n')
    // The single file can be asked for by the name it has now.
    await write('notes.tex', 'newer\n')
    expect(await history.restore(project, one.id, 'notes.tex')).toEqual({ left: [], failed: [] })
    expect(await read('notes.tex')).toBe('old\n')
  })

  it('finishes what is being saved before the app closes', async () => {
    const saving = history.saveNamed(project, 'One')
    await history.flushAll()
    expect(await present('.git/refs/heads/main')).toBe(true)
    await saving
  })
})

describe('writing a file by way of a temporary one', () => {
  it('leaves no temporary file behind when the file cannot be written', async () => {
    // A folder is where the file should go: neither renaming nor writing works.
    await fs.mkdir(path.join(project, 'taken'))
    await expect(writeFileAtomic(path.join(project, 'taken'), 'text')).rejects.toThrow()
    expect((await fs.readdir(project)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('reading the files again', () => {
  const hourAgo = (): Date => new Date(Date.now() - 60 * 60 * 1000)
  /** How often the content of a file of the project was read. */
  function readsOf(rel: string): () => number {
    const spy = vi.spyOn(fs, 'readFile')
    return () => spy.mock.calls.filter(([file]) => file === path.join(project, rel)).length
  }

  it('does not read a file again that is the way it was', async () => {
    await fs.utimes(path.join(project, 'refs.bib'), hourAgo(), hourAgo())
    const one = await history.saveNamed(project, 'One')
    const reads = readsOf('refs.bib')
    expect(await history.changes(project, one.id, 'current')).toEqual([])
    expect(reads()).toBe(0)
    // What was remembered outlasts the session: it is kept with the repository.
    const next = newManager()
    expect(await next.changes(project, one.id, 'current')).toEqual([])
    expect(reads()).toBe(0)
    // A new time is a change.
    await write('refs.bib', '@book{c, title={C}}\n')
    expect(await next.changes(project, one.id, 'current')).toEqual([{ path: 'refs.bib', status: 'modified' }])
    expect(reads()).toBe(1)
  })

  it('reads a file again that was changed a moment ago, whatever its time says', async () => {
    // File systems that keep times to two seconds would hide a second change.
    const now = new Date()
    await fs.utimes(path.join(project, 'refs.bib'), now, now)
    const one = await history.saveNamed(project, 'One')
    const reads = readsOf('refs.bib')
    expect(await history.changes(project, one.id, 'current')).toEqual([])
    expect(reads()).toBe(1)
  })

  it('notices a file that another one of the same size and time has taken the place of', async () => {
    const time = hourAgo()
    await fs.utimes(path.join(project, 'refs.bib'), time, time)
    const one = await history.saveNamed(project, 'One')
    expect(await history.changes(project, one.id, 'current')).toEqual([])
    // As a program does it that writes a new file and renames it over the old one.
    const other = path.join(tmp, 'other.bib')
    await fs.writeFile(other, '@book{b, title={B}}\n')
    await fs.utimes(other, time, time)
    await fs.rename(other, path.join(project, 'refs.bib'))
    expect(await history.changes(project, one.id, 'current')).toEqual([{ path: 'refs.bib', status: 'modified' }])
  })
})

describe('files that cannot be read', () => {
  /** Makes reading one file of the project fail, the given number of times. */
  function lockFile(rel: string, times: number): void {
    const real = fs.readFile.bind(fs) as (...args: unknown[]) => Promise<unknown>
    let left = times
    vi.spyOn(fs, 'readFile').mockImplementation(((file: unknown, ...rest: unknown[]) =>
      file === path.join(project, rel) && left-- > 0 ? Promise.reject(failing('EBUSY')) : real(file, ...rest)) as never)
  }

  it('fail the version instead of being left out of it', async () => {
    await history.saveNamed(project, 'One')
    later()
    await write('refs.bib', 'changed\n')
    lockFile('refs.bib', Infinity)
    // A version without the file would delete it when it is restored.
    await expect(history.saveAuto(project, 'edits')).rejects.toThrow(/"refs\.bib" could not be read/)
    await expect(history.saveNamed(project, 'Two')).rejects.toThrow(/"refs\.bib" could not be read/)
    vi.restoreAllMocks()
    expect(await labels()).toEqual(['One'])
  })

  it('are waited for when another program only has them open for a moment', async () => {
    lockFile('refs.bib', 2)
    const one = await history.saveNamed(project, 'One')
    expect(await filesOf(one.id)).toEqual(['figures/plot.png', 'main.tex', 'refs.bib'])
  })

  it('include a folder that cannot be listed', async () => {
    const real = fs.readdir.bind(fs) as (...args: unknown[]) => Promise<unknown>
    vi.spyOn(fs, 'readdir').mockImplementation(((dir: unknown, ...rest: unknown[]) =>
      dir === path.join(project, 'figures') ? Promise.reject(failing('EACCES')) : real(dir, ...rest)) as never)
    await expect(history.saveNamed(project, 'One')).rejects.toThrow(/folder "figures" could not be read/)
  })
})

describe.skipIf(!hasGit)('a repository that was already there', () => {
  let head: string

  beforeEach(async () => {
    git(project, 'init', '-q', '-b', 'trunk')
    await write('.gitignore', 'secret.txt\nbuild/\n')
    await write('secret.txt', 'not for the repository\n')
    await write('build/out.log', 'log\n')
    git(project, 'add', '-A')
    git(project, ...AS_OWNER, 'commit', '-q', '-m', 'Their own commit')
    head = git(project, 'rev-parse', 'HEAD')
  })

  it('shows its commits and never writes to its branches or its index', async () => {
    const listed = await history.list(project)
    expect(listed.repository).toBe('yours')
    expect(listed.versions).toMatchObject([{ id: head, kind: 'named', label: 'Their own commit', author: 'Owner', onBranch: true }])

    later()
    await write('main.tex', 'edited\n')
    git(project, 'add', 'main.tex') // something staged by the owner
    await write('refs.bib', 'edited too\n')
    const statusBefore = git(project, 'status', '--porcelain')

    const named = await history.saveNamed(project, 'Mine')
    later()
    await write('refs.bib', 'and again\n')
    const auto = await history.saveAuto(project, 'edits')

    expect(named).toMatchObject({ kind: 'named', onBranch: false })
    expect(git(project, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(project, 'log', '--branches', '--tags', '--format=%s')).toBe('Their own commit')
    expect(git(project, 'status', '--porcelain')).toBe(statusBefore)
    expect(git(project, 'for-each-ref', '--format=%(refname)').split('\n').map((r) => r.replace(/\d{8}T\d{9}Z/, '*'))).toEqual([
      'refs/heads/trunk',
      'refs/underleaf/auto/*',
      'refs/underleaf/named/*'
    ])
    expect((await history.list(project)).versions.map((v) => v.id)).toEqual([auto?.id, named.id, head])
    expect(git(project, 'fsck', '--no-dangling')).not.toMatch(/error|missing|broken/i)
  })

  it('leaves out what the repository ignores, and leaves it alone when restoring', async () => {
    const mine = await history.saveNamed(project, 'Mine')
    expect(await filesOf(mine.id)).toEqual(['.gitignore', 'figures/plot.png', 'main.tex', 'refs.bib'])

    later()
    await write('secret.txt', 'changed, still not for the repository\n')
    await write('main.tex', 'changed\n')
    expect(await history.restore(project, mine.id, null)).toEqual({ left: [], failed: [] })
    expect(await read('main.tex')).toContain('Hello')
    expect(await read('secret.txt')).toBe('changed, still not for the repository\n')
    expect(await read('build/out.log')).toBe('log\n')
  })

  it('does not replace a file it keeps no versions of, even when the version has one', async () => {
    // A commit from before those files were ignored: it has them, with other content.
    const other = blobOf('as it was in the old commit\n')
    const old = commitOf(
      treeOf([
        `040000 tree ${treeOf([`100644 blob ${other}\tout.log`])}\tbuild`,
        `100644 blob ${other}\tmain.tex`,
        `100644 blob ${other}\tsecret.txt`
      ]),
      'Old'
    )
    // Asked for by itself, the file is left as it is, and nothing else happens.
    expect(await history.restore(project, old, 'secret.txt')).toEqual({
      left: [{ path: 'secret.txt', reason: 'unversioned' }],
      failed: []
    })
    expect(await labels()).toEqual(['Their own commit'])

    await write('refs.bib', 'changed since their commit\n')
    const result = await history.restore(project, old, null)
    expect(await read('secret.txt')).toBe('not for the repository\n')
    expect(await read('build/out.log')).toBe('log\n')
    // What versions are kept of is put back, and is in the copy made before.
    expect(await read('main.tex')).toBe('as it was in the old commit\n')
    expect(await present('refs.bib')).toBe(false)
    expect(result.failed).toEqual([])
    expect(result.left.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'build/out.log', reason: 'unversioned' },
      { path: 'secret.txt', reason: 'unversioned' }
    ])
    const [copy] = (await history.list(project)).versions
    expect(copy.label).toBe('Before restoring an earlier version')
    expect(await filesOf(copy.id)).toEqual(['.gitignore', 'figures/plot.png', 'main.tex', 'refs.bib'])
    expect(await history.file(project, null, copy.id, 'refs.bib')).toMatchObject({ after: 'changed since their commit\n' })
  })

  it('needs no copy of a state that is their own commit', async () => {
    const other = blobOf('as it was in the old commit\n')
    const old = commitOf(treeOf([`100644 blob ${other}\tmain.tex`]), 'Old')
    await history.restore(project, old, null)
    expect(await read('main.tex')).toBe('as it was in the old commit\n')
    expect(await labels()).toEqual(['Their own commit'])
    expect(git(project, 'for-each-ref', '--format=%(refname)', 'refs/underleaf')).toBe('')
  })

  it('does not restore over the repository itself', async () => {
    // A commit, as a hostile repository could carry it, with a ".git" folder in its tree.
    const blob = git(project, 'hash-object', '-w', 'main.tex')
    const hostile = commitOf(
      treeOf([`040000 tree ${treeOf([`100644 blob ${blob}\tconfig`])}\t.git`, `100644 blob ${blob}\tmain.tex`]),
      'hostile'
    )
    const config = await read('.git/config')
    await write('main.tex', 'what is in the folder\n')

    // Nothing of such a version is used: not shown, not restored.
    await expect(history.restore(project, hostile, null)).rejects.toThrow(/not safe/)
    await expect(history.changes(project, null, hostile)).rejects.toThrow(/not safe/)
    expect(await read('.git/config')).toBe(config)
    expect(await read('main.tex')).toBe('what is in the folder\n')
  })

  it('does not write a file name that means something else on Windows', async () => {
    // "main.tex:hidden" is an ordinary name elsewhere; on Windows it is a
    // hidden stream of main.tex.
    const blob = git(project, 'hash-object', '-w', 'refs.bib')
    const odd = commitOf(treeOf([`100644 blob ${blob}\tmain.tex:hidden`, `100644 blob ${blob}\trefs.bib`]), 'odd name')
    const result = await history.restore(project, odd, 'main.tex:hidden')
    if (process.platform === 'win32') {
      expect(result).toEqual({ left: [{ path: 'main.tex:hidden', reason: 'name' }], failed: [] })
      expect(await read('main.tex')).toContain('Hello')
    } else {
      expect(result).toEqual({ left: [], failed: [] })
      expect(await read('main.tex:hidden')).toBe('@book{a, title={A}}\n')
    }
  })

  it('says so when the repository keeps its refs in a way it cannot write', async () => {
    await fs.appendFile(path.join(project, '.git', 'config'), '[extensions]\n\trefStorage = reftable\n')
    const listed = await history.list(project)
    expect(listed.repository).toBe('unsupported')
    expect(listed.reason).toMatch(/reftable/)
    expect(await history.saveAuto(project, 'open')).toBeNull()
    await expect(history.saveNamed(project, 'One')).rejects.toThrow(/reftable/)
    expect(await present('.git/refs/underleaf')).toBe(false)
  })

  it('takes its refs out of the file that all refs share only under git\'s lock', async () => {
    git(project, ...AS_OWNER, 'tag', '-a', 'v1', '-m', 'Tagged')
    for (const text of ['one\n', 'two\n']) {
      later()
      await write('main.tex', text)
      await history.saveAuto(project, 'edits')
    }
    git(project, 'pack-refs', '--all')
    const packed = await read('.git/packed-refs')
    expect(packed.match(/refs\/underleaf\/auto\//g)).toHaveLength(2)
    expect(await present('.git/refs/underleaf/auto')).toBe(false)

    // Ten days on, the older of the two is due to go. While someone else is
    // rewriting the file, it is not touched.
    later(10 * DAYS)
    await write('.git/packed-refs.lock', '')
    await write('main.tex', 'three\n')
    await history.saveAuto(project, 'edits')
    expect(await read('.git/packed-refs')).toBe(packed)
    expect((await history.list(project)).versions.filter((v) => v.kind === 'auto')).toHaveLength(3)

    await fs.rm(path.join(project, '.git', 'packed-refs.lock'))
    later()
    await write('main.tex', 'four\n')
    await history.saveAuto(project, 'edits')
    const refs = git(project, 'for-each-ref', '--format=%(refname)').split('\n')
    expect(refs.filter((r) => r.startsWith('refs/underleaf/auto/'))).toHaveLength(3)
    // Everything else in the file is as it was.
    expect(git(project, 'rev-parse', 'refs/heads/trunk')).toBe(head)
    expect(git(project, 'rev-parse', 'v1^{commit}')).toBe(head)
    expect(await read('.git/packed-refs')).toMatch(/^\^[0-9a-f]{40}$/m)
    expect(await present('.git/packed-refs.lock')).toBe(false)
    expect(git(project, 'fsck', '--no-dangling')).not.toMatch(/error|missing|broken/i)
  })

  it('still works after git has packed the repository', async () => {
    const named = await history.saveNamed(project, 'Mine')
    later()
    await write('main.tex', 'two\n')
    const auto = await history.saveAuto(project, 'edits')
    git(project, 'gc', '-q', '--prune=now')
    // Its refs are lines in the packed-refs file now, its objects in a pack.
    expect((await read('.git/packed-refs')).match(/ refs\/underleaf\//g)).toHaveLength(2)
    expect(await present(`.git/objects/${named.id.slice(0, 2)}/${named.id.slice(2)}`)).toBe(false)

    const fresh = newManager()
    expect((await fresh.list(project)).versions.map((v) => v.id)).toEqual([auto?.id, named.id, head])
    expect(await fresh.changes(project, named.id, auto?.id as string)).toEqual([{ path: 'main.tex', status: 'modified' }])
    expect(await fresh.file(project, named.id, auto?.id as string, 'main.tex')).toMatchObject({ kind: 'text', after: 'two\n' })
    later()
    await write('main.tex', 'three\n')
    expect(await fresh.restore(project, head, null)).toEqual({ left: [], failed: [] })
    expect(await read('main.tex')).toContain('Hello')
    expect(git(project, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(project, 'fsck', '--no-dangling')).not.toMatch(/error|missing|broken/i)
  })
})

describe.skipIf(!hasGit)('which files versions are kept of', () => {
  /** Both git and the code under test get these as the user's rules for all repositories. */
  async function globalRules(text: string): Promise<void> {
    await fs.writeFile(path.join(home, 'ignore-everywhere'), text)
    await fs.appendFile(path.join(home, '.gitconfig'), `[core]\n\texcludesFile = ${path.join(home, 'ignore-everywhere').replace(/\\/g, '/')}\n`)
  }

  it('are the files that git would pick', async () => {
    git(project, 'init', '-q', '-b', 'main')
    await globalRules('*.swp\ngenerated/\n')
    await write('.git/info/exclude', 'notes-private/\n')
    await write(
      '.gitignore',
      ['*.log', '/build/', '!important.log', 'drafts/*', '!drafts/keep/', 'secret?.txt', 'docs/**/tmp', '# taken back in:', '!generated/', ''].join('\n')
    )
    await write('sub/.gitignore', '!debug.log\n/local.cfg\nout/\n')
    // "Everything but the sources", in the way that takes folders back in.
    await write('deep/a/.gitignore', '*\n!*/\n!*.tex\n')
    const all = [
      'a.log', 'important.log', 'build/out.txt', 'build/tracked.txt', 'sub/build/x.txt',
      'drafts/one.tex', 'drafts/keep/two.tex', 'secret1.txt', 'secret.txt',
      'docs/x/tmp/file.txt', 'docs/tmp/file.txt', 'docs/x/keep.txt',
      'sub/debug.log', 'sub/other.log', 'sub/local.cfg', 'sub/deeper/local.cfg', 'sub/out/file.txt',
      'deep/a/x.tex', 'deep/a/x.pdf', 'deep/a/b/y.tex', 'deep/a/b/y.aux',
      'notes-private/n.txt', 'edit.swp', 'generated/x.tex', 'generated/y.swp'
    ]
    for (const rel of all) await write(rel, `${rel}\n`)
    // One file is in the repository although a rule ignores the folder it is in.
    git(project, 'add', '-f', 'build/tracked.txt')
    git(project, ...AS_OWNER, 'commit', '-q', '-m', 'Tracked by hand')

    const version = await history.saveNamed(project, 'Everything')
    const kept = await filesOf(version.id)
    expect(kept).toEqual(gitFiles(project))
    // Spelled out, so that it is plain what the comparison stands for.
    expect(kept).toEqual(
      [
        '.gitignore', 'figures/plot.png', 'main.tex', 'refs.bib', 'important.log', 'build/tracked.txt', 'sub/build/x.txt',
        'drafts/keep/two.tex', 'secret.txt', 'docs/x/keep.txt', 'sub/.gitignore', 'sub/debug.log', 'sub/deeper/local.cfg',
        // (deep/a/.gitignore ignores itself, with its "*")
        'deep/a/x.tex', 'deep/a/b/y.tex', 'generated/x.tex'
      ].sort()
    )
  })

  it('are picked the same way in a project that is part of a larger repository', async () => {
    const repo = path.join(tmp, 'work')
    git(repo, 'init', '-q', '-b', 'main')
    await globalRules('*.swp\n')
    await write('.gitignore', '*.bak\n/Paper/private/\nPaper/*.log\n!Paper/keep.log\n', repo)
    await write('.gitignore', 'out/\n!special.bak\n')
    const all = [
      'a.bak', 'special.bak', 'private/x.tex', 'private/tracked.tex', 'sub/private/x.tex',
      'run.log', 'keep.log', 'sub/run.log', 'out/o.txt', 'edit.swp'
    ]
    for (const rel of all) await write(rel, `${rel}\n`)
    git(repo, 'add', '-f', 'Paper/private/tracked.tex')
    git(repo, ...AS_OWNER, 'commit', '-q', '-m', 'Tracked by hand')

    const version = await history.saveNamed(project, 'Everything')
    const kept = await filesOf(version.id)
    expect(kept).toEqual(gitFiles(repo, 'Paper'))
    expect(kept).toEqual(
      ['.gitignore', 'figures/plot.png', 'main.tex', 'refs.bib', 'special.bak', 'private/tracked.tex', 'sub/private/x.tex', 'keep.log', 'sub/run.log'].sort()
    )
  })

  it('does not look into a folder that is ignored', async () => {
    await write('.gitignore', 'node_modules/\n')
    await write('node_modules/pkg/index.js', 'x\n')
    const listing = vi.spyOn(fs, 'readdir')
    const one = await history.saveNamed(project, 'One')
    expect(listing.mock.calls.map(([dir]) => String(dir)).filter((dir) => dir.includes('node_modules'))).toEqual([])
    expect(await filesOf(one.id)).toEqual(['.gitignore', 'figures/plot.png', 'main.tex', 'refs.bib'])
  })
})

describe.skipIf(!hasGit)('files that a repository holds in another form', () => {
  beforeEach(() => {
    git(project, 'init', '-q', '-b', 'main')
  })

  it('takes a Git LFS pointer for the file it stands for', async () => {
    const png = exampleFigurePng()
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${createHash('sha256').update(png).digest('hex')}\nsize ${png.length}\n`
    // The repository has the picture as a pointer; the folder has the picture.
    const commit = commitOf(
      treeOf([
        `040000 tree ${treeOf([`100644 blob ${blobOf(pointer)}\tplot.png`])}\tfigures`,
        `100644 blob ${git(project, 'hash-object', '-w', 'main.tex')}\tmain.tex`,
        `100644 blob ${git(project, 'hash-object', '-w', 'refs.bib')}\trefs.bib`
      ]),
      'With a picture in Git LFS'
    )
    await fs.mkdir(path.join(project, '.git', 'lfs', 'objects'), { recursive: true })

    expect(await history.changes(project, commit, 'current')).toEqual([])
    expect(await history.file(project, commit, 'current', 'figures/plot.png')).toEqual({
      kind: 'binary',
      before: png.length,
      after: png.length
    })

    // Another picture now: the pointer cannot bring the old one back, and its
    // text must not take the picture's place.
    await write('figures/plot.png', Buffer.concat([png, Buffer.from('x')]))
    await write('main.tex', 'changed\n')
    expect(await history.changes(project, commit, 'current')).toEqual([
      { path: 'figures/plot.png', status: 'modified' },
      { path: 'main.tex', status: 'modified' }
    ])
    expect(await history.restore(project, commit, null)).toEqual({
      left: [{ path: 'figures/plot.png', reason: 'lfs' }],
      failed: []
    })
    expect((await fs.readFile(path.join(project, 'figures', 'plot.png'))).length).toBe(png.length + 1)
    expect(await read('main.tex')).toContain('Hello')
  })

  it('keeps the line ends that a file has in the folder', async () => {
    git(project, 'add', 'main.tex', 'refs.bib')
    git(project, ...AS_OWNER, 'commit', '-q', '-m', 'With LF')
    const commit = git(project, 'rev-parse', 'HEAD')
    // As git leaves it with core.autocrlf: LF in the repository, CRLF in the folder.
    await write('main.tex', 'Line one\r\nLine two, changed\r\n')
    await write('refs.bib', '@book{a, title={A}}\r\n')
    expect(await history.changes(project, commit, 'current')).toEqual([
      { path: 'figures/plot.png', status: 'added' },
      { path: 'main.tex', status: 'modified' }
    ])

    expect(await history.restore(project, commit, 'main.tex')).toEqual({ left: [], failed: [] })
    expect(await read('main.tex')).toBe('\\documentclass{article}\r\n\\begin{document}\r\nHello\r\n\\end{document}\r\n')
    // Only the line ends differ: not touched at all.
    expect(await history.restore(project, commit, 'refs.bib')).toEqual({ left: [], failed: [] })
    expect(await read('refs.bib')).toBe('@book{a, title={A}}\r\n')
    // A file that is not in the folder comes back the way the version has it.
    await fs.rm(path.join(project, 'main.tex'))
    await history.restore(project, commit, 'main.tex')
    expect(await read('main.tex')).toBe('\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n')
  })
})

describe.skipIf(!hasGit)('a project that is part of a larger repository', () => {
  const repo = (): string => path.join(tmp, 'work')

  it('keeps its versions in that repository, under a name of its own', async () => {
    git(repo(), 'init', '-q', '-b', 'main')
    await write('code/run.py', 'print(1)\n', repo())
    git(repo(), 'add', '-A')
    git(repo(), ...AS_OWNER, 'commit', '-q', '-m', 'Everything')
    const head = git(repo(), 'rev-parse', 'HEAD')

    const one = await history.saveNamed(project, 'Paper, first')
    expect(one.onBranch).toBe(false)
    expect(await present('.git')).toBe(false) // no repository inside the repository
    const listed = await history.list(project)
    expect(listed.repository).toBe('yours')
    // The history of the whole repository is not the history of the paper.
    expect(listed.versions.map((v) => v.label)).toEqual(['Paper, first'])
    expect(git(repo(), 'for-each-ref', '--format=%(refname)', 'refs/underleaf')).toMatch(/^refs\/underleaf\/in-[0-9a-f]{12}\/named\/\d{8}T\d{9}Z$/)
    expect(git(repo(), 'rev-parse', 'HEAD')).toBe(head)
    // The version holds the paper's files, by the names they have in the project.
    expect(git(repo(), 'ls-tree', '-r', '--name-only', one.id).split('\n')).toEqual(['figures/plot.png', 'main.tex', 'refs.bib'])

    later()
    await write('main.tex', 'changed\n')
    await write('code/run.py', 'print(2)\n', repo())
    await history.restore(project, one.id, null)
    expect(await read('main.tex')).toContain('Hello')
    expect(await read('code/run.py', repo())).toBe('print(2)\n')
  })

  it('gets a repository of its own when the larger one ignores the project folder', async () => {
    git(repo(), 'init', '-q', '-b', 'main')
    await write('.gitignore', 'Paper/\n', repo())
    expect((await history.list(project)).repository).toBe('none')
    const one = await history.saveNamed(project, 'One')
    expect(one.onBranch).toBe(true)
    expect(await present('.git/HEAD')).toBe(true)
    expect((await history.list(project)).repository).toBe('own')
    expect(await filesOf(one.id)).toEqual(['figures/plot.png', 'main.tex', 'refs.bib'])
    expect(git(repo(), 'for-each-ref', '--format=%(refname)', 'refs/underleaf')).toBe('')
  })

  it('takes its versions along when the project folder is renamed', async () => {
    git(repo(), 'init', '-q', '-b', 'main')
    const one = await history.saveNamed(project, 'One')
    later()
    await write('main.tex', 'two\n')
    const two = await history.saveAuto(project, 'edits')

    const renamed = path.join(repo(), 'Article')
    await fs.rename(project, renamed)
    await history.moved(project, renamed)
    expect((await history.list(renamed)).versions.map((v) => v.id)).toEqual([two?.id, one.id])
    const refs = git(repo(), 'for-each-ref', '--format=%(refname)', 'refs/underleaf').split('\n')
    expect(refs).toHaveLength(2)
    expect(new Set(refs.map((ref) => ref.split('/')[2])).size).toBe(1)
    // Nothing of it is left for a project that takes the old name.
    await write('main.tex', 'another paper\n')
    expect((await history.list(project)).versions).toEqual([])
  })

  it('saves nothing when the project folder is gone', async () => {
    git(repo(), 'init', '-q', '-b', 'main')
    await history.saveNamed(project, 'One')
    await fs.rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    expect(await history.saveAuto(project, 'close')).toBeNull()
    expect(git(repo(), 'for-each-ref', '--format=%(refname)', 'refs/underleaf').split('\n')).toHaveLength(1)
  })
})

describe('repositories that are not the project\'s', () => {
  it('ignores a repository that spans the home folder', async () => {
    const inHome = path.join(home, 'Documents', 'Underleaf', 'Paper')
    await write('main.tex', 'x\n', inHome)
    await fs.mkdir(path.join(home, '.git'))
    await fs.writeFile(path.join(home, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    expect((await history.list(inHome)).repository).toBe('none')
    await history.saveNamed(inHome, 'One')
    expect(await present('.git/HEAD', inHome)).toBe(true)
    expect((await history.list(inHome)).repository).toBe('own')
  })

  it('ignores it also when the home folder is a linked work tree', async () => {
    const inHome = path.join(home, 'Documents', 'Underleaf', 'Paper')
    await write('main.tex', 'x\n', inHome)
    await fs.writeFile(path.join(home, '.git'), 'gitdir: /somewhere/else\n')
    expect((await history.list(inHome)).repository).toBe('none')
    expect((await history.saveNamed(inHome, 'One')).onBranch).toBe(true)
  })

  it('says so when the folder is a linked work tree', async () => {
    await fs.writeFile(path.join(project, '.git'), 'gitdir: /somewhere/else\n')
    const listed = await history.list(project)
    expect(listed.repository).toBe('unsupported')
    expect(listed.reason).toMatch(/work tree|submodule/)
    expect(await history.saveAuto(project, 'open')).toBeNull()
    await expect(history.saveNamed(project, 'One')).rejects.toThrow(/work tree|submodule/)
  })
})

describe('automatic versions while working', () => {
  beforeEach(() => {
    settings = { auto: true, editsPerVersion: 3, editPauseSeconds: 0.04 }
  })

  /** A burst of changes, then a pause that is long enough to end the edit. */
  async function edit(text: string): Promise<void> {
    await write('main.tex', text)
    for (let i = 0; i < 5; i++) history.noteActivity(project)
    await sleep(140)
    await history.whenIdle(project)
  }

  it('counts a burst of changes as one edit and saves after the configured number', async () => {
    await history.saveAuto(project, 'open')
    later()
    await edit('one\n')
    await edit('two\n')
    expect((await history.list(project)).versions).toHaveLength(1)
    await edit('three\n')
    await history.whenIdle(project)
    const { versions } = await history.list(project)
    expect(versions.map((v) => v.label)).toEqual(['Automatic version', 'First version'])
    expect(await history.changes(project, versions[1].id, versions[0].id)).toEqual([{ path: 'main.tex', status: 'modified' }])

    // The count starts again after a version, also after one saved by name.
    later()
    await edit('four\n')
    await edit('five\n')
    await history.saveNamed(project, 'By hand')
    later()
    await edit('six\n')
    await edit('seven\n')
    expect((await history.list(project)).versions).toHaveLength(3)
    await edit('eight\n')
    await history.whenIdle(project)
    expect((await history.list(project)).versions).toHaveLength(4)
  })

  it('counts an edit that ends while a version is being saved towards the next one', async () => {
    settings.editsPerVersion = 2
    await history.saveAuto(project, 'open')
    later()
    // Writing the version is held up where it reads the file, until the test lets it go on.
    let reached = (): void => undefined
    let letGo = (): void => undefined
    const reading = new Promise<void>((resolve) => (reached = resolve))
    const gate = new Promise<void>((resolve) => (letGo = resolve))
    const real = fs.readFile.bind(fs) as (...args: unknown[]) => Promise<unknown>
    const held = vi.spyOn(fs, 'readFile').mockImplementation((async (file: unknown, ...rest: unknown[]) => {
      if (file === path.join(project, 'main.tex')) {
        reached()
        await gate
      }
      return real(file, ...rest)
    }) as never)
    await edit('one\n')
    await write('main.tex', 'two\n')
    history.noteActivity(project) // the second edit ends in 40 ms, and the version is started
    await reading
    await write('main.tex', 'three\n')
    history.noteActivity(project) // the third ends while the version is being written
    await sleep(150)
    letGo()
    await history.whenIdle(project)
    held.mockRestore()
    expect(await labels()).toEqual(['Automatic version', 'First version'])

    // It was not forgotten: one more edit makes two.
    later()
    await edit('four\n')
    await history.whenIdle(project)
    expect(await labels()).toEqual(['Automatic version', 'Automatic version', 'First version'])
  })

  it('saves what is left when the project is closed', async () => {
    await history.saveAuto(project, 'open')
    later()
    await edit('one\n')
    await history.flush(project)
    expect(await labels()).toEqual(['On closing the project', 'First version'])
    // Closing again, with nothing changed, adds nothing.
    await history.flush(project)
    expect((await history.list(project)).versions).toHaveLength(2)
  })

  it('does nothing of the kind when automatic versions are off', async () => {
    settings.auto = false
    await history.saveNamed(project, 'By hand')
    later()
    for (let i = 0; i < 4; i++) await edit(`${i}\n`)
    await history.flush(project)
    expect(await history.saveAuto(project, 'open')).toBeNull()
    expect(await labels()).toEqual(['By hand'])
    // The safety copy before a restore is still made.
    await history.restore(project, (await history.list(project)).versions[0].id, null)
    expect(await labels()).toEqual(['Before restoring an earlier version', 'By hand'])
  })
})

describe('thinning out automatic versions', () => {
  const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:.]/g, '')
  const now = new Date(2026, 10, 21, 12, 0, 0).getTime()
  const hour = 60 * 60 * 1000

  it('keeps everything from the last two days', () => {
    const recent = Array.from({ length: 40 }, (_, i) => stamp(now - i * hour))
    expect(stampsToDrop(recent, now)).toEqual([])
  })

  it('keeps the last version of each older day', () => {
    // Three days ago, at 9, 15 and 21 o'clock; ten days ago at 10 and 11.
    const day = 24 * hour
    const base = new Date(2026, 10, 18, 0, 0, 0).getTime()
    const older = new Date(2026, 10, 11, 0, 0, 0).getTime()
    const stamps = [base + 9 * hour, base + 15 * hour, base + 21 * hour, older + 10 * hour, older + 11 * hour].map(stamp)
    expect(now - (base + 21 * hour)).toBeGreaterThan(2 * day)
    expect(stampsToDrop(stamps, now).sort()).toEqual([stamp(older + 10 * hour), stamp(base + 9 * hour), stamp(base + 15 * hour)].sort())
  })
})
