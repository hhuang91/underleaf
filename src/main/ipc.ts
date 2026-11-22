// Request handlers behind `window.api`. Everything the renderer can ask the
// main process to do is listed here.

import fsp from 'node:fs/promises'
import path from 'node:path'
import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { UnderleafApi } from '@shared/api'
import { CHANNELS, EVENTS, type ChannelNamespace, type IpcReply } from '@shared/channels'
import type { AppSettings, Compiler, DeepPartial, VersionRef } from '@shared/types'
import type { ProjectAnalyzer } from './analysis'
import { isLatexmkRc, rcFingerprint, type CompileManager } from './compile'
import type { HistoryManager } from './history'
import {
  createFile,
  createFolder,
  deleteEntry,
  importExternalFiles,
  moveEntry,
  readProjectBinary,
  readProjectFile,
  readTree,
  renameEntry,
  writeProjectFile
} from './files'
import { encodeProjectId, type ProjectLibrary } from './projects'
import type { SettingsStore } from './settings'
import { exists, isDirectory, isInside, resolveInside, samePath } from './util/fsx'
import type { ProjectWatcher } from './watcher'

type Handlers = {
  [NS in ChannelNamespace]: {
    [M in (typeof CHANNELS)[NS][number]]: M extends keyof UnderleafApi[NS] ? UnderleafApi[NS][M] : never
  }
}

export interface IpcContext {
  settings: SettingsStore
  library: ProjectLibrary
  compiler: CompileManager
  analyzer: ProjectAnalyzer
  watcher: ProjectWatcher
  history: HistoryManager
  window(): BrowserWindow | null
  /** Origins that are allowed to call the API (the app itself, plus the dev server). */
  trustedOrigins: string[]
  trash(target: string): Promise<void>
}

const COMPILERS: ReadonlySet<string> = new Set(['pdflatex', 'latex', 'xelatex', 'lualatex'])

export function registerIpc(ctx: IpcContext): void {
  const { settings, library, compiler, analyzer, watcher, history } = ctx
  /** Folders the user picked in a native dialog during this session. */
  const chosenDirs = new Set<string>()
  /** Files this app wrote for the user (exports); they may be revealed in the file manager. */
  const revealable = new Set<string>()
  /**
   * Files and folders outside the projects that the user handed to the app in
   * this session: picked in a native dialog, or dropped on the window (the
   * preload script reports those). Nothing else outside a project is ever
   * read, whatever a request asks for.
   */
  const userPaths = new Set<string>()

  const fromApp = (url: string | undefined): boolean =>
    ctx.trustedOrigins.some((origin) => (url ?? '').startsWith(origin))

  const allowPath = (p: string): void => {
    if (userPaths.size >= 5000) userPaths.clear()
    userPaths.add(path.resolve(p))
  }
  const isAllowedPath = (p: unknown): p is string => typeof p === 'string' && userPaths.has(path.resolve(p))

  ipcMain.on(EVENTS.droppedPath, (event, p: unknown) => {
    if (typeof p === 'string' && p && fromApp(event.senderFrame?.url)) allowPath(p)
  })

  const send = (channel: string, payload: unknown): void => {
    const win = ctx.window()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  const trusted = (event: IpcMainInvokeEvent): boolean => fromApp(event.senderFrame?.url)

  const register = <NS extends ChannelNamespace>(ns: NS, impl: Handlers[NS]): void => {
    for (const method of CHANNELS[ns]) {
      const fn = (impl as Record<string, (...args: unknown[]) => Promise<unknown>>)[method]
      ipcMain.handle(`${ns}:${method}`, async (event, ...args: unknown[]): Promise<IpcReply<unknown>> => {
        if (!trusted(event)) return { ok: false, error: 'Request rejected' }
        try {
          return { ok: true, value: await fn(...args) }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      })
    }
  }

  const dialogParent = (): BrowserWindow => {
    const win = ctx.window()
    if (!win) throw new Error('No window')
    return win
  }

  const rememberOpenFile = (dir: string, rel: string): void => {
    if (settings.get().lastOpenFile[dir] === rel) return
    void settings.update({ lastOpenFile: { [dir]: rel } })
  }

  /**
   * Shows a file or folder in the system's file manager: a folder is opened,
   * anything else is selected inside its folder. On macOS a folder with an
   * extension can be a bundle, which "opening" would launch, so those are
   * selected as well.
   */
  const reveal = async (abs: string): Promise<void> => {
    const maybeBundle = process.platform === 'darwin' && path.extname(abs) !== ''
    if ((await isDirectory(abs)) && !maybeBundle) await shell.openPath(abs)
    else shell.showItemInFolder(abs)
  }

  const watch = (dir: string): void => {
    const id = encodeProjectId(dir)
    watcher.start(dir, (paths) => {
      send(EVENTS.projectChanged, { id, paths })
      // Whatever changed the files (this app, another editor, git): it is
      // what the automatic versions count as editing.
      history.noteActivity(dir)
    })
  }

  /** Stops whatever keeps the project folder busy; resolves with whether it was being watched. */
  const release = async (dir: string): Promise<boolean> => {
    const wasWatched = watcher.isWatching(dir)
    watcher.stop(dir)
    compiler.stop(dir)
    await compiler.whenIdle(dir)
    await history.whenIdle(dir)
    return wasWatched
  }

  const versionRef = <N extends boolean>(value: unknown, orNothing: N): VersionRef | (N extends true ? null : never) => {
    if (value === null && orNothing) return null as N extends true ? null : never
    if (value === 'current' || (typeof value === 'string' && /^[0-9a-f]{40}$/.test(value))) return value
    throw new Error('Unknown version')
  }

  // The project's latexmkrc is only used with the user's consent (it is code).
  const isRcTrusted = async (dir: string): Promise<boolean> => {
    const fingerprint = await rcFingerprint(dir)
    return fingerprint !== null && settings.get().trustedRc[dir] === fingerprint
  }
  const trustRc = async (dir: string): Promise<void> => {
    await settings.update({ trustedRc: { [dir]: (await rcFingerprint(dir)) ?? '' } })
  }

  // ------------------------------------------------------------- app

  register('app', {
    info: async () => ({
      version: app.getVersion(),
      platform: process.platform as 'win32' | 'darwin' | 'linux',
      isPackaged: app.isPackaged
    }),
    getSettings: async () => settings.get(),
    updateSettings: async (patch) => {
      const safe: DeepPartial<AppSettings> = { ...patch }
      // Only the main process decides which folders count as projects and
      // which latexmkrc files may run.
      delete safe.externalProjects
      delete safe.trustedRc
      if (safe.libraryPath !== undefined && !chosenDirs.has(safe.libraryPath)) delete safe.libraryPath
      if (safe.texBinPath !== undefined && safe.texBinPath !== '' && !chosenDirs.has(safe.texBinPath)) {
        delete safe.texBinPath
      }
      return settings.update(safe)
    },
    chooseDirectory: async (title) => {
      const result = await dialog.showOpenDialog(dialogParent(), {
        title: String(title ?? 'Choose a folder'),
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      chosenDirs.add(result.filePaths[0])
      return result.filePaths[0]
    },
    openExternal: async (url) => {
      if (typeof url === 'string' && /^(https?:|mailto:)/i.test(url)) await shell.openExternal(url)
    },
    showItemInFolder: async (target) => {
      if (typeof target !== 'string') return
      const abs = path.resolve(target)
      const lib = settings.get().libraryPath
      const known =
        revealable.has(abs) ||
        samePath(abs, lib) ||
        isInside(lib, abs) ||
        settings.get().externalProjects.some((p) => samePath(p, abs) || isInside(p, abs))
      if (known) await reveal(abs)
    },
    texStatus: async (refresh) => compiler.texStatus(settings.get().texBinPath, refresh === true)
  })

  // -------------------------------------------------------- projects

  register('projects', {
    list: async () => library.list(),
    create: async (name, template) =>
      library.create(String(name ?? ''), template === 'example' ? 'example' : 'blank'),
    pickZip: async () => {
      const result = await dialog.showOpenDialog(dialogParent(), {
        title: 'Upload project',
        properties: ['openFile'],
        filters: [{ name: 'Zip archives', extensions: ['zip'] }]
      })
      if (result.canceled || result.filePaths.length === 0) return null
      allowPath(result.filePaths[0])
      return result.filePaths[0]
    },
    importZip: async (zipPath, mode) => {
      if (typeof zipPath !== 'string' || !/\.zip$/i.test(zipPath)) {
        throw new Error('Please choose a .zip file')
      }
      if (!isAllowedPath(zipPath)) throw new Error('Please choose the .zip file again')
      const stat = await fsp.stat(zipPath).catch(() => null)
      if (!stat?.isFile()) throw new Error('The zip file could not be found')
      return library.importZip(zipPath, mode === 'replace' || mode === 'keep-both' ? mode : 'ask')
    },
    addFolder: async () => {
      const result = await dialog.showOpenDialog(dialogParent(), {
        title: 'Open existing folder as a project',
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      return library.addExternal(result.filePaths[0])
    },
    exportZip: async (id) => {
      const dir = library.dirFor(id)
      const result = await dialog.showSaveDialog(dialogParent(), {
        title: 'Download source',
        defaultPath: path.join(app.getPath('downloads'), `${path.basename(dir)}.zip`),
        filters: [{ name: 'Zip archives', extensions: ['zip'] }]
      })
      if (result.canceled || !result.filePath) return null
      const dest = /\.zip$/i.test(result.filePath) ? result.filePath : `${result.filePath}.zip`
      await library.exportZip(id, dest)
      revealable.add(path.resolve(dest))
      return dest
    },
    rename: async (id, name) => {
      const dir = library.dirFor(id)
      // Windows cannot rename a folder that is being watched, and the build
      // cache of the old name is about to be removed.
      const wasWatched = await release(dir)
      let renamed
      try {
        renamed = await library.rename(id, String(name ?? ''))
      } catch (err) {
        if (wasWatched) watch(dir)
        throw err
      }
      const { from, summary } = renamed
      if (from === summary.path) {
        // The new name is the old one: nothing moved.
        if (wasWatched) watch(dir)
        return summary
      }
      // Carry what is remembered about the folder over to its new name. The
      // window that has it open follows with `open`, which starts watching it.
      await history.moved(from, summary.path)
      const { lastOpenFile, trustedRc } = settings.get()
      if (lastOpenFile[from]) await settings.update({ lastOpenFile: { [summary.path]: lastOpenFile[from], [from]: '' } })
      if (trustedRc[from]) await settings.update({ trustedRc: { [summary.path]: trustedRc[from], [from]: '' } })
      await compiler.clearCache(from).catch(() => undefined)
      return summary
    },
    copy: async (id, name) => library.copy(id, String(name ?? '')),
    remove: async (id) => {
      const dir = library.dirFor(id)
      const wasWatched = await release(dir)
      try {
        await library.remove(id)
      } catch (err) {
        if (wasWatched) watch(dir)
        throw err
      }
      history.forget(dir)
      await compiler.clearCache(dir).catch(() => undefined)
    },
    reveal: async (id) => {
      const dir = library.dirFor(id)
      if (!(await isDirectory(dir))) throw new Error('The project folder no longer exists')
      await reveal(dir)
    },
    open: async (id) => {
      const dir = library.dirFor(id)
      if (!(await isDirectory(dir))) throw new Error('The project folder no longer exists')
      const [tree, root] = await Promise.all([readTree(dir), library.effectiveRootDoc(dir)])
      const projectCompiler = await library.effectiveCompiler(dir, root.rootDoc)
      // A project that is opened (as opposed to one that was renamed while
      // open) gets a version of how it was found, unless it has not changed.
      const fresh = !library.isOpen(dir)
      library.markOpen(dir)
      watch(dir)
      if (fresh) void history.saveAuto(dir, 'open').catch(() => undefined)
      const last = settings.get().lastOpenFile[dir] ?? null
      return {
        summary: await library.summary(dir),
        tree,
        rootDoc: root.rootDoc,
        rootDocExplicit: root.explicit,
        compiler: projectCompiler,
        lastOpenFile: last && (await exists(path.join(dir, last))) ? last : null
      }
    },
    close: async (id) => {
      const dir = library.dirFor(id)
      watcher.stop(dir)
      library.markClosed(dir)
      // What was changed since the last version is kept as one.
      await history.flush(dir)
    },
    setCompiler: async (id, value) => {
      if (!COMPILERS.has(value)) throw new Error('Unknown compiler')
      await library.updateMeta(library.dirFor(id), { compiler: value as Compiler })
    },
    setRootDoc: async (id, rel) => {
      const dir = library.dirFor(id)
      if (rel !== null) {
        const abs = resolveInside(dir, rel)
        if (!(await exists(abs))) throw new Error('File not found')
      }
      await library.updateMeta(dir, { rootDoc: rel ?? undefined })
      return (await library.effectiveRootDoc(dir)).rootDoc
    },
    trustRc: async (id) => trustRc(library.dirFor(id)),
    index: async (id) => analyzer.index(library.dirFor(id)),
    wordCount: async (id) => {
      const dir = library.dirFor(id)
      const { rootDoc } = await library.effectiveRootDoc(dir)
      if (!rootDoc) throw new Error('This project has no main document')
      return analyzer.wordCount(dir, rootDoc)
    }
  })

  // ----------------------------------------------------------- files

  register('files', {
    tree: async (id) => readTree(library.dirFor(id)),
    read: async (id, rel) => {
      const dir = library.dirFor(id)
      const result = await readProjectFile(dir, rel)
      rememberOpenFile(dir, rel)
      return result
    },
    readBinary: async (id, rel) => readProjectBinary(library.dirFor(id), rel),
    write: async (id, rel, content, eol) => {
      if (typeof content !== 'string') throw new Error('Invalid content')
      const dir = library.dirFor(id)
      // A latexmkrc that was allowed stays allowed when it is edited here.
      const keepTrust = typeof rel === 'string' && isLatexmkRc(rel) && (await isRcTrusted(dir))
      const mtimeMs = await writeProjectFile(dir, rel, content, eol === '\r\n' ? '\r\n' : '\n')
      if (keepTrust) await trustRc(dir)
      return mtimeMs
    },
    createFile: async (id, rel, content) => {
      const dir = library.dirFor(id)
      // The first latexmkrc of a project, when written in this app, is the user's own.
      const ownRc = typeof rel === 'string' && isLatexmkRc(rel) && (await rcFingerprint(dir)) === null
      await createFile(dir, rel, typeof content === 'string' ? content : '')
      if (ownRc) await trustRc(dir)
    },
    createFolder: async (id, rel) => {
      await createFolder(library.dirFor(id), rel)
    },
    rename: async (id, rel, newName) => renameEntry(library.dirFor(id), rel, newName),
    move: async (id, rel, destFolder) => moveEntry(library.dirFor(id), rel, destFolder),
    remove: async (id, rel, permanently) => deleteEntry(library.dirFor(id), rel, ctx.trash, permanently === true),
    pickAndImport: async (id, destFolder) => {
      const dir = library.dirFor(id)
      const result = await dialog.showOpenDialog(dialogParent(), {
        title: 'Upload files',
        properties: ['openFile', 'multiSelections']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      // Remembered so that the same files can be sent again to overwrite.
      for (const p of result.filePaths) allowPath(p)
      return importExternalFiles(dir, destFolder, result.filePaths, false)
    },
    importPaths: async (id, destFolder, absPaths, overwrite) => {
      if (!Array.isArray(absPaths) || !absPaths.every(isAllowedPath)) {
        throw new Error('These files cannot be added. Please choose them again.')
      }
      return importExternalFiles(library.dirFor(id), destFolder, absPaths, overwrite === true)
    },
    reveal: async (id, rel) => {
      // Always selected in its folder, never opened: "opening" a file would run it.
      shell.showItemInFolder(resolveInside(library.dirFor(id), rel))
    }
  })

  // --------------------------------------------------------- compile

  register('compile', {
    run: async (id, fromScratch) => {
      const dir = library.dirFor(id)
      const { rootDoc } = await library.effectiveRootDoc(dir)
      const s = settings.get()
      return compiler.compile({
        projectDir: dir,
        rootDoc,
        compiler: await library.effectiveCompiler(dir, rootDoc),
        backend: s.engineBackend,
        texBinPath: s.texBinPath,
        stopOnFirstError: s.stopOnFirstError,
        fromScratch: fromScratch === true,
        trustedRc: s.trustedRc[dir] ?? null
      })
    },
    stop: async (id) => compiler.stop(library.dirFor(id)),
    clearCache: async (id) => {
      const dir = library.dirFor(id)
      compiler.stop(dir)
      await compiler.whenIdle(dir)
      await compiler.clearCache(dir)
    },
    readPdf: async (id) => compiler.readPdf(library.dirFor(id)),
    savePdf: async (id) => {
      const dir = library.dirFor(id)
      const source = await compiler.pdfPath(dir)
      if (!source) throw new Error('There is no PDF yet. Compile the project first.')
      const result = await dialog.showSaveDialog(dialogParent(), {
        title: 'Download PDF',
        defaultPath: path.join(app.getPath('downloads'), `${path.basename(dir)}.pdf`),
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (result.canceled || !result.filePath) return null
      const dest = /\.pdf$/i.test(result.filePath) ? result.filePath : `${result.filePath}.pdf`
      await fsp.copyFile(source, dest)
      revealable.add(path.resolve(dest))
      return dest
    },
    openBuildFolder: async (id) => {
      await shell.openPath(await compiler.buildFolder(library.dirFor(id)))
    },
    syncToPdf: async (id, file, line) => {
      if (typeof file !== 'string' || !Number.isFinite(line)) return []
      return compiler.syncToPdf(library.dirFor(id), file, Math.round(line))
    },
    syncToSource: async (id, page, x, y) => {
      if (![page, x, y].every((n) => Number.isFinite(n))) return null
      return compiler.syncToSource(library.dirFor(id), Math.round(page), x, y)
    }
  })

  // --------------------------------------------------------- history

  register('history', {
    list: async (id, limit) => history.list(library.dirFor(id), Number.isFinite(limit) ? limit : 200),
    save: async (id, label) => history.saveNamed(library.dirFor(id), typeof label === 'string' ? label : ''),
    changes: async (id, from, to) => history.changes(library.dirFor(id), versionRef(from, true), versionRef(to, false)),
    file: async (id, from, to, rel) => {
      if (typeof rel !== 'string') throw new Error('Invalid path')
      return history.file(library.dirFor(id), versionRef(from, true), versionRef(to, false), rel)
    },
    restore: async (id, version, rel) => {
      if (rel !== null && typeof rel !== 'string') throw new Error('Invalid path')
      const ref = versionRef(version, false)
      if (ref === 'current') throw new Error('Unknown version')
      return history.restore(library.dirFor(id), ref, rel)
    }
  })
}
