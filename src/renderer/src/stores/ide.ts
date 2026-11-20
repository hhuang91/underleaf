// State of the open project: file tree, the document in the editor, compile
// results and the PDF. Actions here are the single place where the editor
// controller, the main-process API and the UI meet.

import { create } from 'zustand'
import type {
  Compiler,
  CompileResult,
  FileNode,
  ProjectIndex,
  ProjectSummary
} from '@shared/types'
import { isTexFile, kindOfFile } from '@shared/fileTypes'
import { setCompletionData } from '../editor/completions'
import { editor } from '../editor/controller'
import type { OutlineItem } from '../editor/outline'
import { baseName, dirName, errorMessage, joinPath } from '../lib/util'
import { useApp } from './app'

export interface OpenDoc {
  path: string
  kind: 'text' | 'image' | 'pdf' | 'binary'
  size: number
  reason?: 'too-large'
  /**
   * The file is not UTF-8 and is shown as decoded from a legacy encoding.
   * It cannot be edited until the user agrees to convert it: saving would
   * rewrite it as UTF-8, which is destructive if the decoding guessed wrong.
   */
  transcoded?: boolean
}

export type SaveState = 'saved' | 'dirty' | 'error'

interface IdeState {
  projectId: string | null
  summary: ProjectSummary | null
  loading: boolean
  loadError: string | null
  tree: FileNode[]
  /** Expanded folders (by path). */
  expanded: Record<string, boolean>
  /** Entry highlighted in the file tree. */
  selected: string | null
  open: OpenDoc | null
  rootDoc: string | null
  rootDocExplicit: boolean
  compiler: Compiler
  compiling: boolean
  /** Latest line of engine output. */
  progress: string
  /** Status notice for the running compile ("Downloading TeX files…"). */
  progressNote: string
  result: CompileResult | null
  pdf: { version: number; data: Uint8Array } | null
  /** What the right-hand pane shows. */
  pane: 'pdf' | 'logs'
  /** The logs were opened automatically because a compile produced no PDF. */
  logsAuto: boolean
  outline: OutlineItem[]
  cursorLine: number
  saveState: SaveState

  load(id: string): Promise<void>
  /**
   * Leaves the project. Resolves with false, staying in it, when the latest
   * changes could not be saved; `discardUnsaved` leaves regardless.
   */
  unload(discardUnsaved?: boolean): Promise<boolean>
  refreshTree(): Promise<void>
  toggleFolder(path: string, open?: boolean): void
  select(path: string | null): void
  openFile(path: string, position?: { line: number; column?: number }): Promise<void>
  compile(fromScratch?: boolean): Promise<void>
  stopCompile(): Promise<void>
  clearCache(): Promise<void>
  setPane(pane: 'pdf' | 'logs'): void
  setCompiler(compiler: Compiler): Promise<void>
  setRootDoc(path: string | null): Promise<void>
  createFile(folder: string, name: string): Promise<void>
  createFolder(folder: string, name: string): Promise<void>
  renameEntry(path: string, newName: string): Promise<void>
  moveEntry(path: string, destFolder: string): Promise<void>
  /**
   * Moves the entry to the trash. Resolves with false, having deleted nothing,
   * when there is no trash for its location; `permanently` deletes it for good.
   */
  deleteEntry(path: string, permanently?: boolean): Promise<boolean>
  /** Makes a file that is not UTF-8 editable; it is saved as UTF-8 from then on. */
  convertToUtf8(): void
  /** Allows the project's latexmkrc to be used, and recompiles. */
  trustRc(): Promise<void>
  importPaths(destFolder: string, absPaths: string[], overwrite?: boolean): Promise<string[] | { conflicts: string[] }>
  renameProject(name: string): Promise<void>
  handleExternalChange(paths: string[]): Promise<void>
}

const EMPTY_INDEX: ProjectIndex = { labels: [], bibEntries: [], commands: [], environments: [] }

/** Bumped whenever a project starts loading or unloading; stale async work checks it. */
let loadToken = 0
/** Bumped for every file that is opened, so a slow read cannot overwrite a newer one. */
let openToken = 0
let compileQueued = false
let autoCompileTimer: number | null = null
let indexTimer: number | null = null
/** A failed save was reported; stay quiet about the retries until one succeeds. */
let saveErrorShown = false

function flatten(nodes: FileNode[], out: FileNode[] = []): FileNode[] {
  for (const n of nodes) {
    out.push(n)
    if (n.children) flatten(n.children, out)
  }
  return out
}

export function findNode(nodes: FileNode[], path: string): FileNode | null {
  for (const n of nodes) {
    if (n.path === path) return n
    if (n.children && path.startsWith(n.path + '/')) {
      const hit = findNode(n.children, path)
      if (hit) return hit
    }
  }
  return null
}

function ancestors(path: string): string[] {
  const parts = path.split('/')
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'))
  return out
}

function remapPath(path: string, from: string, to: string): string {
  if (path === from) return to
  return path.startsWith(from + '/') ? to + path.slice(from.length) : path
}

function isWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent + '/')
}

export const useIde = create<IdeState>((set, get) => {
  const api = window.api
  const notify = (kind: 'info' | 'success' | 'error', message: string): void =>
    useApp.getState().notify(kind, message)

  const requireId = (): string => {
    const id = get().projectId
    if (!id) throw new Error('No project is open')
    return id
  }

  const publishFiles = (tree: FileNode[]): void => {
    setCompletionData({
      files: flatten(tree)
        .filter((n) => n.type === 'file')
        .map((n) => n.path)
    })
  }

  const refreshIndex = (delay = 0): void => {
    if (indexTimer !== null) window.clearTimeout(indexTimer)
    indexTimer = window.setTimeout(() => {
      indexTimer = null
      const id = get().projectId
      if (!id) return
      api.projects
        .index(id)
        .then((index) => {
          if (get().projectId === id) setCompletionData({ index })
        })
        .catch(() => undefined)
    }, delay)
  }

  const scheduleAutoCompile = (): void => {
    if (!useApp.getState().settings?.autoCompile) return
    if (autoCompileTimer !== null) window.clearTimeout(autoCompileTimer)
    autoCompileTimer = window.setTimeout(() => {
      autoCompileTimer = null
      void get().compile()
    }, 1200)
  }

  // The editor reports back through these hooks.
  editor.events = {
    onDirty: () => {
      // After a failed save the indicator keeps saying so until one succeeds.
      if (get().saveState === 'saved') set({ saveState: 'dirty' })
    },
    onSaved: (path) => {
      saveErrorShown = false
      if (!editor.dirty) set({ saveState: 'saved' })
      if (/\.(tex|bib|sty|cls|ltx)$/i.test(path)) refreshIndex(1500)
      scheduleAutoCompile()
    },
    onSaveError: (path, message) => {
      set({ saveState: 'error' })
      if (saveErrorShown) return
      saveErrorShown = true
      notify(
        'error',
        `Could not save ${baseName(path)}: ${message}. Your changes are kept in the editor, and saving is tried again every few seconds.`
      )
    },
    onCursor: (line) => set({ cursorLine: line }),
    onOutline: (items) => set({ outline: items }),
    onRecompile: () => void get().compile()
  }

  const blank = {
    projectId: null,
    summary: null,
    loading: false,
    loadError: null,
    tree: [] as FileNode[],
    expanded: {} as Record<string, boolean>,
    selected: null,
    open: null,
    rootDoc: null,
    rootDocExplicit: false,
    compiler: 'pdflatex' as Compiler,
    compiling: false,
    progress: '',
    progressNote: '',
    result: null,
    pdf: null,
    pane: 'pdf' as const,
    logsAuto: false,
    outline: [] as OutlineItem[],
    cursorLine: 1,
    saveState: 'saved' as SaveState
  }

  return {
    ...blank,

    async load(id) {
      const token = ++loadToken
      openToken++
      compileQueued = false
      saveErrorShown = false
      editor.reset(id)
      setCompletionData({ index: EMPTY_INDEX, files: [] })
      set({ ...blank, projectId: id, loading: true })
      try {
        const state = await api.projects.open(id)
        if (token !== loadToken) return
        publishFiles(state.tree)
        set({
          summary: state.summary,
          tree: state.tree,
          rootDoc: state.rootDoc,
          rootDocExplicit: state.rootDocExplicit,
          compiler: state.compiler,
          loading: false
        })
        refreshIndex()

        // Show the PDF from the last session right away; a fresh compile follows.
        void api.compile
          .readPdf(id)
          .then((pdf) => {
            if (pdf && get().projectId === id && !get().pdf) set({ pdf })
          })
          .catch(() => undefined)

        const files = flatten(state.tree).filter((n) => n.type === 'file')
        const initial =
          state.lastOpenFile ??
          state.rootDoc ??
          files.find((n) => isTexFile(n.name))?.path ??
          files.find((n) => kindOfFile(n.name) === 'text')?.path ??
          null
        if (initial) await get().openFile(initial)
        if (token === loadToken && state.rootDoc) void get().compile()
      } catch (err) {
        if (token === loadToken) set({ loading: false, loadError: errorMessage(err) })
      }
    },

    async unload(discardUnsaved = false) {
      const id = get().projectId
      const token = ++loadToken
      openToken++
      if (autoCompileTimer !== null) window.clearTimeout(autoCompileTimer)
      if (indexTimer !== null) window.clearTimeout(indexTimer)
      autoCompileTimer = null
      indexTimer = null
      compileQueued = false
      const saved = await editor.flush()
      if (token !== loadToken) {
        // Another project started loading meanwhile and owns the editor now.
        // Only release this project's watcher if it is not the one being loaded.
        if (id && id !== get().projectId) void api.projects.close(id).catch(() => undefined)
        return true
      }
      // The text that could not be written exists nowhere but in the editor.
      if (!saved && !discardUnsaved) return false
      saveErrorShown = false
      editor.reset(null)
      set({ ...blank })
      if (id) {
        void api.compile.stop(id).catch(() => undefined)
        await api.projects.close(id).catch(() => undefined)
      }
      return true
    },

    async refreshTree() {
      const id = get().projectId
      if (!id) return
      try {
        const tree = await api.files.tree(id)
        if (get().projectId !== id) return
        publishFiles(tree)
        set({ tree })
      } catch {
        /* the folder may be temporarily unavailable; the next change event retries */
      }
    },

    toggleFolder(path, open) {
      const expanded = { ...get().expanded }
      const next = open ?? !expanded[path]
      if (next) expanded[path] = true
      else delete expanded[path]
      set({ expanded })
    },

    select(path) {
      set({ selected: path })
    },

    async openFile(path, position) {
      const id = requireId()
      const current = get().open
      if (current?.path === path) {
        if (position && current.kind === 'text') editor.jumpTo(position.line, position.column ?? 0)
        set({ selected: path })
        return
      }
      const token = ++openToken
      if (!(await editor.flush())) {
        // Replacing the document now would throw away the only copy of what
        // could not be written.
        notify(
          'error',
          `${baseName(current?.path ?? 'The open file')} has changes that could not be saved, so it stays open. Check that the file is not read-only or in use by another program.`
        )
        set({ selected: current?.path ?? null })
        return
      }
      const expanded = { ...get().expanded }
      for (const a of ancestors(path)) expanded[a] = true
      set({ selected: path, expanded })
      try {
        const res = await api.files.read(id, path)
        if (token !== openToken) return
        if (res.kind === 'text') {
          // A file that is not UTF-8 opens write-protected (see OpenDoc.transcoded).
          editor.show(path, res.content, res.eol, res.transcoded)
          set({
            open: { path, kind: 'text', size: res.size, transcoded: res.transcoded },
            saveState: 'saved'
          })
          if (position) editor.jumpTo(position.line, position.column ?? 0)
        } else {
          editor.hide()
          set({
            open: { path, kind: res.kind, size: res.size, reason: res.reason },
            outline: [],
            saveState: 'saved'
          })
        }
      } catch (err) {
        if (token === openToken) notify('error', `Could not open ${baseName(path)}: ${errorMessage(err)}`)
      }
    },

    async compile(fromScratch = false) {
      const id = get().projectId
      if (!id) return
      if (get().compiling) {
        compileQueued = true
        return
      }
      if (autoCompileTimer !== null) {
        window.clearTimeout(autoCompileTimer)
        autoCompileTimer = null
      }
      set({ compiling: true, progress: '', progressNote: '' })
      try {
        await editor.flush()
        const result = await api.compile.run(id, fromScratch)
        if (get().projectId !== id) return
        let pdf = get().pdf
        if (result.hasPdf && result.pdfVersion !== pdf?.version) {
          const fresh = await api.compile.readPdf(id)
          if (get().projectId !== id) return
          if (fresh) pdf = fresh
        }
        // Without a PDF the logs are all there is to show; go back to the PDF
        // on the next success if the logs were opened for that reason.
        const prev = get()
        let pane = prev.pane
        let logsAuto = prev.logsAuto
        if (result.status !== 'stopped') {
          if (!result.hasPdf) {
            if (pane !== 'logs') logsAuto = true
            pane = 'logs'
          } else if (logsAuto) {
            pane = 'pdf'
            logsAuto = false
          }
        }
        set({ result, pdf, compiling: false, progress: '', progressNote: '', pane, logsAuto })
        editor.setLogEntries(result.entries)
      } catch (err) {
        if (get().projectId === id) {
          set({ compiling: false, progress: '', progressNote: '' })
          notify('error', `Compile failed: ${errorMessage(err)}`)
        }
      }
      if (compileQueued && get().projectId === id) {
        compileQueued = false
        void get().compile()
      }
    },

    async stopCompile() {
      const id = get().projectId
      compileQueued = false
      if (id) await api.compile.stop(id).catch(() => undefined)
    },

    async clearCache() {
      const id = requireId()
      if (get().compiling) await get().stopCompile()
      await api.compile.clearCache(id)
      notify('success', 'Cached files cleared. The next compile starts from scratch.')
    },

    setPane(pane) {
      set({ pane, logsAuto: false })
    },

    async setCompiler(compiler) {
      const id = requireId()
      set({ compiler })
      await api.projects.setCompiler(id, compiler)
    },

    async setRootDoc(path) {
      const id = requireId()
      const rootDoc = await api.projects.setRootDoc(id, path)
      set({ rootDoc, rootDocExplicit: path !== null })
    },

    async createFile(folder, name) {
      const id = requireId()
      const path = joinPath(folder, name.trim())
      await api.files.createFile(id, path, '')
      await get().refreshTree()
      if (folder) get().toggleFolder(folder, true)
      await get().openFile(path)
      editor.focus()
    },

    async createFolder(folder, name) {
      const id = requireId()
      const path = joinPath(folder, name.trim())
      await api.files.createFolder(id, path)
      await get().refreshTree()
      const expanded = { ...get().expanded, [path]: true }
      if (folder) expanded[folder] = true
      set({ expanded, selected: path })
    },

    async renameEntry(path, newName) {
      const id = requireId()
      await editor.flush()
      const next = await api.files.rename(id, path, newName.trim())
      if (next === path) return
      const s = get()
      editor.renamePath(path, next)
      const expanded: Record<string, boolean> = {}
      for (const key of Object.keys(s.expanded)) expanded[remapPath(key, path, next)] = true
      set({
        expanded,
        selected: s.selected ? remapPath(s.selected, path, next) : null,
        open: s.open ? { ...s.open, path: remapPath(s.open.path, path, next) } : null,
        rootDoc: s.rootDoc ? remapPath(s.rootDoc, path, next) : null
      })
      // An explicitly chosen main document keeps pointing at the same file.
      if (s.rootDocExplicit && s.rootDoc && isWithin(s.rootDoc, path)) {
        await api.projects.setRootDoc(id, remapPath(s.rootDoc, path, next)).catch(() => undefined)
      }
      await get().refreshTree()
      refreshIndex(300)
    },

    async moveEntry(path, destFolder) {
      const id = requireId()
      if (dirName(path) === destFolder) return
      await editor.flush()
      const next = await api.files.move(id, path, destFolder)
      if (next === path) return
      const s = get()
      editor.renamePath(path, next)
      const expanded: Record<string, boolean> = {}
      for (const key of Object.keys(s.expanded)) expanded[remapPath(key, path, next)] = true
      if (destFolder) expanded[destFolder] = true
      set({
        expanded,
        selected: s.selected ? remapPath(s.selected, path, next) : null,
        open: s.open ? { ...s.open, path: remapPath(s.open.path, path, next) } : null,
        rootDoc: s.rootDoc ? remapPath(s.rootDoc, path, next) : null
      })
      if (s.rootDocExplicit && s.rootDoc && isWithin(s.rootDoc, path)) {
        await api.projects.setRootDoc(id, remapPath(s.rootDoc, path, next)).catch(() => undefined)
      }
      await get().refreshTree()
      refreshIndex(300)
    },

    async deleteEntry(path, permanently = false) {
      const id = requireId()
      // Leave no save pending: one that arrived late would bring the file back.
      await editor.flush()
      if (!(await api.files.remove(id, path, permanently))) return false
      const s = get()
      editor.forget(path)
      if (s.open !== null && isWithin(s.open.path, path)) {
        openToken++
        set({ open: null, outline: [], saveState: 'saved' })
      }
      set({ selected: s.selected && isWithin(s.selected, path) ? null : s.selected })
      await get().refreshTree()
      refreshIndex(300)
      // The main document may have been deleted: re-detect it.
      if (s.rootDoc && isWithin(s.rootDoc, path)) {
        const state = await api.projects.open(id).catch(() => null)
        if (state && get().projectId === id) {
          set({ rootDoc: state.rootDoc, rootDocExplicit: state.rootDocExplicit })
        }
      }
      return true
    },

    convertToUtf8() {
      const open = get().open
      if (!open || open.kind !== 'text' || !open.transcoded) return
      editor.makeEditable()
      set({ open: { ...open, transcoded: false } })
    },

    async trustRc() {
      const id = requireId()
      await api.projects.trustRc(id)
      void get().compile()
    },

    async importPaths(destFolder, absPaths, overwrite = false) {
      const id = requireId()
      const result = await api.files.importPaths(id, destFolder, absPaths, overwrite)
      if (result.conflicts.length > 0) return { conflicts: result.conflicts }
      await get().refreshTree()
      if (destFolder) get().toggleFolder(destFolder, true)
      refreshIndex(300)
      return result.imported
    },

    async renameProject(name) {
      const id = requireId()
      if (!(await editor.flush())) {
        throw new Error('the latest changes could not be saved. Try again once they are')
      }
      const summary = await api.projects.rename(id, name)
      if (summary.id === id) {
        set({ summary })
        return
      }
      // The folder moved, so the project has a new identity. The editor keeps
      // everything it holds (text, undo history, anything typed meanwhile);
      // only the place it saves to changes.
      editor.setProject(summary.id)
      set({ projectId: summary.id, summary })
      useApp.getState().navigate({ name: 'project', id: summary.id })
      // The rename stopped a compile that was running. Its result, should it
      // still arrive, belongs to the old identity and is ignored.
      compileQueued = false
      set({ compiling: false, progress: '', progressNote: '' })
      // Opening it under the new name makes the main process watch the folder again.
      const state = await api.projects.open(summary.id)
      if (get().projectId !== summary.id) return
      publishFiles(state.tree)
      set({ summary: state.summary, tree: state.tree })
      void get().compile()
    },

    async handleExternalChange(paths) {
      const id = get().projectId
      if (!id) return
      await get().refreshTree()
      if (get().projectId !== id) return
      const everything = paths.includes('*')
      const open = get().open
      const stillOpen = (): boolean => get().projectId === id && get().open?.path === open?.path

      /**
       * Brings the editor up to date with the file on disk. Our own saves
       * cause change events too, so what is read is only used if nothing was
       * typed or saved in the meantime: otherwise it may be older than what
       * the editor holds, or half-written, and the save that is under way
       * triggers another event anyway.
       */
      const reload = async (path: string): Promise<void> => {
        await editor.idle()
        if (!stillOpen() || editor.dirty) return
        const revision = editor.revision
        try {
          let res = await api.files.read(id, path)
          if (res.kind === 'text' && res.content === '') {
            // An empty file is often one that another program is rewriting
            // right now (truncate, then write). Give it a moment.
            await new Promise((resolve) => setTimeout(resolve, 300))
            res = await api.files.read(id, path)
          }
          if (!stillOpen() || editor.dirty || editor.revision !== revision) return
          if (res.kind === 'text') editor.externalChange(path, res.content)
        } catch {
          /* the file is mid-write; the next event will deliver it */
        }
      }

      if (open && findNode(get().tree, open.path) === null) {
        // Gone? A program that replaces a file (writes a new one and renames it
        // over the old) makes it vanish for an instant. Look again first.
        await new Promise((resolve) => setTimeout(resolve, 400))
        if (!stillOpen()) return
        await get().refreshTree()
        if (!stillOpen()) return
        if (findNode(get().tree, open.path) !== null) {
          if (open.kind === 'text') await reload(open.path)
        } else if (!editor.dirty) {
          // Deleted or renamed outside the app. (With unsaved edits the
          // document stays open instead: saving puts the file back.)
          openToken++
          editor.forget(open.path)
          set({ open: null, outline: [], saveState: 'saved' })
        }
      } else if (open?.kind === 'text' && (everything || paths.includes(open.path))) {
        await reload(open.path)
      }
      // Cached state of other files needs no invalidation here: it is only
      // reused when it still matches what is on disk (see EditorController.show).
      if (everything || paths.some((p) => /\.(tex|bib|sty|cls|ltx)$/i.test(p))) refreshIndex(800)
    }
  }
})
