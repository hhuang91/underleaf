// Owns the single CodeMirror view and everything around it: per-file state
// (undo history, selection, scroll position), auto-saving and live settings.
// It knows nothing about React; the IDE store drives it and listens to events.

import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap
} from '@codemirror/autocomplete'
import {
  defaultKeymap,
  history,
  historyField,
  historyKeymap,
  indentWithTab
} from '@codemirror/commands'
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language'
import { gotoLine, highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type ViewUpdate
} from '@codemirror/view'
import type { EditorSettings, Keybindings, LogEntry } from '@shared/types'
import { extensionOf } from '@shared/fileTypes'
import { errorMessage } from '../lib/util'
import { latexCompletionSource } from './completions'
import {
  applyLogEntries,
  flashLineAt,
  latexEnterKeymap,
  latexLinter,
  lineFlash,
  logGutter,
  noSpellCheck,
  spellCheck,
  wrapSelection
} from './extensions'
import { bibtexLanguage, latexLanguage } from './latexLanguage'
import { parseOutline, type OutlineItem } from './outline'
import { editorTheme } from './themes'

export interface EditorEvents {
  /** The document has unsaved changes. */
  onDirty(): void
  onSaved(path: string): void
  onSaveError(path: string, message: string): void
  onCursor(line: number): void
  onOutline(items: OutlineItem[]): void
  onRecompile(): void
}

const LATEX_EXTS = new Set(['tex', 'ltx', 'latex', 'sty', 'cls', 'def', 'clo', 'tikz', 'pgf', 'dtx', 'bbl', 'ldf', 'cfg'])
const BIB_EXTS = new Set(['bib', 'bst', 'bbx', 'cbx'])

const SAVE_DELAY_MS = 450
/** After a failed save, try again this often for as long as the changes are unsaved. */
const SAVE_RETRY_MS = 4000
const OUTLINE_DELAY_MS = 350

const themeC = new Compartment()
const languageC = new Compartment()
const keysC = new Compartment()
const bracketsC = new Compartment()
const completeC = new Compartment()
const spellC = new Compartment()
const lintC = new Compartment()
const readOnlyC = new Compartment()

// A document that must not be edited: nothing changes it, whoever asks.
const READ_ONLY: Extension = [EditorState.readOnly.of(true), EditorState.changeFilter.of(() => false)]

interface DocMeta {
  path: string
  eol: '\n' | '\r\n'
  dirty: boolean
  readOnly: boolean
}

const DEFAULT_SETTINGS: EditorSettings = {
  fontSize: 13,
  fontFamily: 'monaco',
  lineHeight: 'normal',
  theme: 'textmate',
  keybindings: 'default',
  autoComplete: true,
  autoCloseBrackets: true,
  codeCheck: true,
  spellCheck: true
}

class EditorController {
  private view: EditorView | null = null
  private meta: DocMeta | null = null
  /** A state prepared while no view was mounted. */
  private pending: EditorState | null = null
  private readonly stash = new Map<string, { json: unknown; scrollTop: number }>()
  /**
   * Where the document shown last still has to be scrolled to: back to where
   * it was left (`top`), or to a place that was asked for (`pos`). It is carried
   * out once the editor is laid out, because a hidden editor (display: none
   * while a preview is shown) cannot scroll.
   */
  private pendingScroll: { top: number } | { pos: number } | null = null
  private projectId: string | null = null
  private saveTimer: number | null = null
  private outlineTimer: number | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private settings: EditorSettings = DEFAULT_SETTINGS
  private keyExtension: Extension = []
  private loadedKeys: Keybindings = 'default'
  private entries: LogEntry[] = []
  private applyingExternal = false
  private lastCursorLine = 0
  private revisionCounter = 0

  events: EditorEvents = {
    onDirty: () => undefined,
    onSaved: () => undefined,
    onSaveError: () => undefined,
    onCursor: () => undefined,
    onOutline: () => undefined,
    onRecompile: () => undefined
  }

  // ---------------------------------------------------------- extensions

  private isLatex(path: string): boolean {
    return LATEX_EXTS.has(extensionOf(path))
  }

  private language(path: string): Extension {
    const ext = extensionOf(path)
    if (LATEX_EXTS.has(ext)) return latexLanguage
    if (BIB_EXTS.has(ext)) return bibtexLanguage
    return []
  }

  private themeExtension(): Extension {
    const s = this.settings
    return editorTheme(s.theme, { fontSize: s.fontSize, fontFamily: s.fontFamily, lineHeight: s.lineHeight })
  }

  private completion(path: string): Extension {
    if (!this.settings.autoComplete || !this.isLatex(path)) return []
    return autocompletion({
      override: [latexCompletionSource],
      activateOnTyping: true,
      icons: false,
      maxRenderedOptions: 60
    })
  }

  private lint(path: string): Extension {
    return this.settings.codeCheck && extensionOf(path) === 'tex' ? latexLinter : []
  }

  private extensions(path: string, readOnly: boolean): Extension[] {
    return [
      keysC.of(this.keyExtension), // Vim/Emacs must see keys before everything else
      readOnlyC.of(readOnly ? READ_ONLY : []),
      lineNumbers(),
      logGutter,
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      EditorView.lineWrapping,
      EditorState.tabSize.of(4),
      indentUnit.of('    '),
      search({ top: true }),
      lineFlash,
      languageC.of(this.language(path)),
      themeC.of(this.themeExtension()),
      bracketsC.of(this.settings.autoCloseBrackets ? closeBrackets() : []),
      completeC.of(this.completion(path)),
      spellC.of(this.settings.spellCheck ? spellCheck : noSpellCheck),
      lintC.of(this.lint(path)),
      this.isLatex(path) ? latexEnterKeymap : [],
      keymap.of([
        { key: 'Mod-Enter', run: () => this.recompile() },
        { key: 'Mod-s', run: () => this.recompile() },
        { key: 'Mod-b', run: (v) => wrapSelection(v, '\\textbf{', '}') },
        { key: 'Mod-i', run: (v) => wrapSelection(v, '\\textit{', '}') },
        { key: 'Mod-Shift-l', run: gotoLine },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...completionKeymap,
        indentWithTab
      ]),
      EditorView.updateListener.of((update) => this.onUpdate(update))
    ]
  }

  private recompile(): boolean {
    this.events.onRecompile()
    return true
  }

  private onUpdate(update: ViewUpdate): void {
    if (!this.meta) return
    if (update.docChanged) this.revisionCounter++
    if (update.docChanged && !this.applyingExternal) {
      this.meta.dirty = true
      this.events.onDirty()
      this.scheduleSave()
    }
    if (update.docChanged) this.scheduleOutline()
    if (update.docChanged || update.selectionSet) {
      const line = update.state.doc.lineAt(update.state.selection.main.head).number
      if (line !== this.lastCursorLine) {
        this.lastCursorLine = line
        this.events.onCursor(line)
      }
    }
  }

  // ------------------------------------------------------------ lifecycle

  mount(host: HTMLElement): void {
    if (this.view) this.view.destroy()
    this.view = new EditorView({
      parent: host,
      state: this.pending ?? EditorState.create({ doc: '', extensions: [themeC.of(this.themeExtension())] })
    })
    this.pending = null
    if (this.meta) {
      this.applyPendingScroll()
      this.afterShow()
    }
  }

  unmount(): void {
    if (!this.view) return
    // Keep the live state so a remount (or React's development double-mount) is seamless.
    if (this.meta) {
      this.pending = this.view.state
      this.pendingScroll ??= { top: this.view.scrollDOM.scrollTop }
    }
    this.view.destroy()
    this.view = null
  }

  /** Starts a fresh session for a project (or none). */
  reset(projectId: string | null): void {
    this.cancelTimers()
    this.projectId = projectId
    this.meta = null
    this.pending = null
    this.pendingScroll = null
    this.stash.clear()
    this.entries = []
    this.lastCursorLine = 0
    this.revisionCounter++
    this.view?.setState(EditorState.create({ doc: '', extensions: [themeC.of(this.themeExtension())] }))
  }

  /**
   * The open project got a new identity (its folder was renamed). Everything
   * in the editor stays as it is; later saves go to the new place.
   */
  setProject(projectId: string): void {
    this.projectId = projectId
  }

  private cancelTimers(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    if (this.outlineTimer !== null) window.clearTimeout(this.outlineTimer)
    this.saveTimer = null
    this.outlineTimer = null
  }

  // ------------------------------------------------------------ documents

  get currentPath(): string | null {
    return this.meta?.path ?? null
  }

  private stashCurrent(): void {
    if (!this.meta) return
    const state = this.view?.state ?? this.pending
    if (!state) return
    // A document that was not scrolled back to its place yet is still "there".
    const owed = this.pendingScroll && 'top' in this.pendingScroll ? this.pendingScroll.top : null
    this.stash.set(this.meta.path, {
      json: state.toJSON({ history: historyField }),
      scrollTop: owed ?? this.view?.scrollDOM.scrollTop ?? 0
    })
  }

  /** Carries out `pendingScroll` as soon as the editor is visible. */
  private applyPendingScroll(): void {
    const view = this.view
    if (!view || !this.pendingScroll) return
    requestAnimationFrame(() => {
      const wanted = this.pendingScroll
      if (this.view !== view || !wanted) return
      if (view.scrollDOM.clientHeight === 0) return // still hidden: refreshLayout() comes back to it
      this.pendingScroll = null
      if ('top' in wanted) view.scrollDOM.scrollTop = wanted.top
      else view.dispatch({ effects: EditorView.scrollIntoView(Math.min(wanted.pos, view.state.doc.length), { y: 'center' }) })
    })
  }

  /**
   * Shows a text file. Undo history and cursor survive switching back and
   * forth. A read-only document cannot be changed until `makeEditable`.
   */
  show(path: string, content: string, eol: '\n' | '\r\n', readOnly = false): void {
    this.stashCurrent()
    const saved = this.stash.get(path)
    const extensions = this.extensions(path, readOnly)
    let state: EditorState
    if (saved && (saved.json as { doc?: unknown }).doc === content) {
      state = EditorState.fromJSON(saved.json, { extensions }, { history: historyField })
    } else {
      state = EditorState.create({ doc: content, extensions })
    }
    this.meta = { path, eol, dirty: false, readOnly }
    this.lastCursorLine = 0
    this.revisionCounter++
    this.pendingScroll = { top: saved?.scrollTop ?? 0 }
    if (this.view) {
      this.view.setState(state)
      this.applyPendingScroll()
      this.afterShow()
    } else {
      this.pending = state
    }
  }

  /** Called when something other than a text file takes over the editor area. */
  hide(): void {
    this.stashCurrent()
    this.cancelTimers()
    this.meta = null
    this.pending = null
    this.pendingScroll = null
    this.events.onOutline([])
  }

  private afterShow(): void {
    if (!this.view || !this.meta) return
    applyLogEntries(this.view, this.entries, this.meta.path)
    this.emitOutline()
    const line = this.view.state.doc.lineAt(this.view.state.selection.main.head).number
    this.lastCursorLine = line
    this.events.onCursor(line)
  }

  /** The view was hidden with display:none; CodeMirror needs to re-measure. */
  refreshLayout(): void {
    this.view?.requestMeasure()
    this.applyPendingScroll()
  }

  focus(): void {
    this.view?.focus()
  }

  /** Runs an editing command against the view, if there is an open document. */
  run(command: (view: EditorView) => unknown): void {
    if (this.view && this.meta) command(this.view)
  }

  /**
   * Lifts the write protection of the open document and treats its content as
   * changed, so that it is saved (as UTF-8) even without a further edit.
   */
  makeEditable(): void {
    const meta = this.meta
    if (!meta || !meta.readOnly) return
    meta.readOnly = false
    this.view?.dispatch({ effects: readOnlyC.reconfigure([]) })
    meta.dirty = true
    this.revisionCounter++
    this.events.onDirty()
    this.scheduleSave()
    this.view?.focus()
  }

  cursor(): { line: number; column: number } | null {
    if (!this.view || !this.meta) return null
    const head = this.view.state.selection.main.head
    const line = this.view.state.doc.lineAt(head)
    return { line: line.number, column: head - line.from }
  }

  jumpTo(line: number, column = 0, flash = true): void {
    const view = this.view
    if (!view || !this.meta) return
    const doc = view.state.doc
    const target = doc.line(Math.min(Math.max(1, Math.round(line)), doc.lines))
    const pos = Math.min(target.from + Math.max(0, column), target.to)
    // A destination that was asked for replaces going back to where the file
    // was left. A hidden editor cannot scroll yet, so it is kept for later.
    const hidden = view.scrollDOM.clientHeight === 0
    this.pendingScroll = hidden ? { pos } : null
    view.dispatch({
      selection: { anchor: pos },
      effects: hidden ? [] : EditorView.scrollIntoView(pos, { y: 'center' })
    })
    view.focus()
    if (flash) flashLineAt(view, pos)
  }

  // ------------------------------------------------------------- outline

  private scheduleOutline(): void {
    if (this.outlineTimer !== null) window.clearTimeout(this.outlineTimer)
    this.outlineTimer = window.setTimeout(() => {
      this.outlineTimer = null
      this.emitOutline()
    }, OUTLINE_DELAY_MS)
  }

  private emitOutline(): void {
    if (!this.view || !this.meta || !this.isLatex(this.meta.path)) {
      this.events.onOutline([])
      return
    }
    this.events.onOutline(parseOutline(this.view.state.doc.toString()))
  }

  // -------------------------------------------------------------- saving

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null
      void this.flush()
    }, SAVE_DELAY_MS)
  }

  get dirty(): boolean {
    return this.meta?.dirty ?? false
  }

  /**
   * A number that changes whenever the open document, or what is known to be
   * on disk for it, changes: on every edit and whenever a save starts. Two
   * equal readings mean that nothing happened in between.
   */
  get revision(): number {
    return this.revisionCounter
  }

  /** Resolves once no save is in flight (without starting one). */
  async idle(): Promise<void> {
    await this.writeChain
  }

  /**
   * Writes pending changes to disk. Resolves with true once everything is on
   * disk and with false when writing failed: the changes are then still in the
   * editor, marked as unsaved, and saving is tried again shortly. Whoever is
   * about to replace the document must not go ahead in that case.
   */
  async flush(): Promise<boolean> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    const meta = this.meta
    const state = this.view?.state ?? this.pending
    if (meta && meta.dirty && !meta.readOnly && state && this.projectId) {
      const projectId = this.projectId
      const { path, eol } = meta
      const text = state.doc.toString()
      meta.dirty = false
      this.revisionCounter++
      this.writeChain = this.writeChain.then(async () => {
        try {
          await window.api.files.write(projectId, path, text, eol)
          this.events.onSaved(path)
        } catch (err) {
          // Still the same document: what it holds is not on disk.
          if (this.meta === meta) {
            meta.dirty = true
            this.revisionCounter++
            if (this.saveTimer === null) {
              this.saveTimer = window.setTimeout(() => {
                this.saveTimer = null
                void this.flush()
              }, SAVE_RETRY_MS)
            }
          }
          this.events.onSaveError(path, errorMessage(err))
        }
      })
    }
    await this.writeChain
    return !(this.meta?.dirty ?? false)
  }

  /**
   * The file changed on disk (another editor, git, a sync client). Unsaved
   * local edits win; otherwise the new content is merged in without moving
   * the cursor more than necessary. The change can be undone like any other.
   */
  externalChange(path: string, content: string): void {
    if (this.meta?.path !== path || !this.view) {
      this.stash.delete(path)
      return
    }
    if (this.meta.dirty) return
    const current = this.view.state.doc.toString()
    if (current === content) return
    let start = 0
    const shortest = Math.min(current.length, content.length)
    while (start < shortest && current.charCodeAt(start) === content.charCodeAt(start)) start++
    let endOld = current.length
    let endNew = content.length
    while (endOld > start && endNew > start && current.charCodeAt(endOld - 1) === content.charCodeAt(endNew - 1)) {
      endOld--
      endNew--
    }
    this.applyingExternal = true
    try {
      this.view.dispatch({
        changes: { from: start, to: endOld, insert: content.slice(start, endNew) },
        // Also applies to a write-protected document: this is not an edit.
        filter: false
      })
    } finally {
      this.applyingExternal = false
    }
  }

  /** A file or folder was renamed or moved: keep cached editor state attached to it. */
  renamePath(from: string, to: string): void {
    const remap = (p: string): string | null =>
      p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : null
    for (const [key, value] of [...this.stash]) {
      const next = remap(key)
      if (next !== null) {
        this.stash.delete(key)
        this.stash.set(next, value)
      }
    }
    if (this.meta) {
      const next = remap(this.meta.path)
      if (next !== null) {
        this.meta.path = next
        this.view?.dispatch({
          effects: [
            languageC.reconfigure(this.language(next)),
            completeC.reconfigure(this.completion(next)),
            lintC.reconfigure(this.lint(next))
          ]
        })
      }
    }
  }

  forget(path: string): void {
    for (const key of [...this.stash.keys()]) {
      if (key === path || key.startsWith(path + '/')) this.stash.delete(key)
    }
    if (this.meta && (this.meta.path === path || this.meta.path.startsWith(path + '/'))) {
      this.cancelTimers()
      this.meta = null
      this.pending = null
    }
  }

  // ------------------------------------------------------------ settings

  configure(settings: EditorSettings): void {
    const previous = this.settings
    this.settings = settings
    if (settings.keybindings !== this.loadedKeys) void this.loadKeybindings(settings.keybindings)
    if (!this.view) return
    const path = this.meta?.path ?? ''
    const effects = []
    if (
      previous.theme !== settings.theme ||
      previous.fontSize !== settings.fontSize ||
      previous.fontFamily !== settings.fontFamily ||
      previous.lineHeight !== settings.lineHeight
    ) {
      effects.push(themeC.reconfigure(this.themeExtension()))
    }
    if (!this.meta) {
      if (effects.length > 0) this.view.dispatch({ effects })
      return
    }
    if (previous.autoCloseBrackets !== settings.autoCloseBrackets) {
      effects.push(bracketsC.reconfigure(settings.autoCloseBrackets ? closeBrackets() : []))
    }
    if (previous.autoComplete !== settings.autoComplete) effects.push(completeC.reconfigure(this.completion(path)))
    if (previous.spellCheck !== settings.spellCheck) {
      effects.push(spellC.reconfigure(settings.spellCheck ? spellCheck : noSpellCheck))
    }
    if (previous.codeCheck !== settings.codeCheck) effects.push(lintC.reconfigure(this.lint(path)))
    if (effects.length > 0) this.view.dispatch({ effects })
  }

  /** Vim and Emacs emulation are loaded on demand; most people never need them. */
  private async loadKeybindings(mode: Keybindings): Promise<void> {
    this.loadedKeys = mode
    let extension: Extension = []
    try {
      if (mode === 'vim') {
        const { vim, Vim } = await import('@replit/codemirror-vim')
        Vim.defineEx('write', 'w', () => this.events.onRecompile())
        extension = vim()
      } else if (mode === 'emacs') {
        const { emacs } = await import('@replit/codemirror-emacs')
        extension = emacs()
      }
    } catch {
      extension = []
    }
    if (this.loadedKeys !== mode) return // changed again while loading
    this.keyExtension = extension
    if (this.view && this.meta) this.view.dispatch({ effects: keysC.reconfigure(extension) })
  }

  // ---------------------------------------------------------- compile log

  setLogEntries(entries: LogEntry[]): void {
    this.entries = entries
    if (this.view && this.meta) applyLogEntries(this.view, entries, this.meta.path)
  }
}

export const editor = new EditorController()
