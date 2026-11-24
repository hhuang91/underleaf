// The writing assistant in the editor.
//
// Suggestions: when the writer pauses (or presses Alt+\), the model is asked
// how the text goes on at the cursor, and its answer is shown in grey after
// the cursor. Tab takes it, Ctrl/Cmd+→ takes its next word, typing the same
// characters keeps the rest of it, and anything else lets it go.
//
// Proofreading: the passage to proofread is the selection, or else the
// paragraph that the cursor is in.

import { completionStatus, hasNextSnippetField } from '@codemirror/autocomplete'
import { presentableDiff } from '@codemirror/merge'
import {
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Transaction,
  type TransactionSpec
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import type { InlineRequest, InlineResult, InlineSuggestions } from '@shared/types'

export interface Suggestion {
  /** Where it goes: the cursor, when it was made. */
  pos: number
  text: string
}

export type AssistantStatus =
  | { state: 'idle' }
  | { state: 'thinking' }
  /** `asked`: the user asked for it, so it is worth telling them. */
  | { state: 'error'; message: string; asked: boolean }
  | { state: 'empty'; message: string; asked: boolean }

export interface AssistantConfig {
  inline: InlineSuggestions
  /** The file shown, relative to the project. */
  path(): string
  ask(request: InlineRequest): Promise<InlineResult | null>
  cancel(id: string): void
  status(status: AssistantStatus): void
  proofread(): void
}

/** How long the writer has to pause before a suggestion is asked for. */
export const PAUSE_MS = 600
/** After an error, suggestions after a pause wait this long before trying again. */
const BACK_OFF_MS = 30_000
const BEFORE = 1500
const BLOCK = 1000
const AFTER = 400

export const setSuggestion = StateEffect.define<Suggestion | null>()
/** Asks for a suggestion right away (Alt+\). */
const askNow = StateEffect.define<null>()

/** The suggestion on display, if any. */
export const suggestionField = StateField.define<Suggestion | null>({
  create: () => null,
  update(current, tr) {
    for (const effect of tr.effects) if (effect.is(setSuggestion)) return effect.value
    if (!current) return null
    const sel = tr.state.selection
    if (tr.docChanged) {
      // Typing what the suggestion says keeps the rest of it on display.
      let typed: string | null = null
      let single = true
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        if (typed !== null || fromA !== toA || fromA !== current.pos) single = false
        else typed = inserted.toString()
      })
      if (!single || !typed) return null
      const text: string = typed
      const pos = current.pos + text.length
      if (!current.text.startsWith(text) || current.text.length === text.length) return null
      if (sel.ranges.length > 1 || !sel.main.empty || sel.main.head !== pos) return null
      return { pos, text: current.text.slice(text.length) }
    }
    if (tr.selection && (sel.ranges.length > 1 || !sel.main.empty || sel.main.head !== current.pos)) return null
    return current
  }
})

/** The part of a suggestion up to the end of its next word. */
export function nextWord(text: string): string {
  return /^\s*[^\s]+/.exec(text)?.[0] ?? text
}

/** The transaction that takes the suggestion, or its next word, into the text. */
export function acceptSpec(state: EditorState, part: 'all' | 'word'): TransactionSpec | null {
  const suggestion = state.field(suggestionField, false)
  if (!suggestion || completionStatus(state) !== null) return null
  const text = part === 'all' ? suggestion.text : nextWord(suggestion.text)
  const rest = suggestion.text.slice(text.length)
  const end = suggestion.pos + text.length
  return {
    changes: { from: suggestion.pos, insert: text },
    selection: { anchor: end },
    effects: setSuggestion.of(rest ? { pos: end, text: rest } : null),
    scrollIntoView: true,
    userEvent: 'input.complete'
  }
}

/**
 * The text around the cursor that a suggestion is asked for with. Where it
 * starts only moves on every thousand characters, so that a server that keeps
 * what it read of the last question (they all do) reads little that is new.
 */
export function excerpt(state: EditorState, pos: number): { before: string; after: string } {
  const doc = state.doc
  let start = Math.max(0, Math.floor((pos - BEFORE) / BLOCK) * BLOCK)
  if (start > 0) {
    const line = doc.lineAt(start)
    if (line.from < start && line.to + 1 < pos) start = line.to + 1
  }
  let end = Math.min(doc.length, pos + AFTER)
  if (end < doc.length) {
    const line = doc.lineAt(end)
    if (line.from > pos) end = line.from - 1
  }
  return { before: doc.sliceString(start, pos), after: doc.sliceString(pos, end) }
}

/**
 * Whether a suggestion makes sense where the cursor is. After a pause it is
 * only asked for at the end of a word, on a line with text, outside of the
 * completion list and of snippet fields (which Tab belongs to then).
 */
export function canSuggest(state: EditorState, trigger: 'auto' | 'manual'): boolean {
  const sel = state.selection
  if (state.readOnly || sel.ranges.length > 1 || !sel.main.empty) return false
  if (trigger === 'manual') return true
  if (completionStatus(state) !== null || hasNextSnippetField(state)) return false
  const pos = sel.main.head
  const line = state.doc.lineAt(pos)
  const beforeCursor = line.text.slice(0, pos - line.from)
  const next = line.text.charAt(pos - line.from)
  return beforeCursor.trim() !== '' && !/[\p{L}\p{N}_]/u.test(next)
}

/**
 * Whether a change is the writer typing: keys, Backspace. Not text that an
 * input method is still composing (its pauses are spent choosing characters),
 * and not the edits of Vim's normal mode, which Vim reports the same way.
 */
export function isTyping(tr: Transaction): boolean {
  if (tr.isUserEvent('input.type.compose')) return false
  return tr.isUserEvent('input.type') || tr.isUserEvent('delete.backward')
}

/** False while Vim's normal or visual mode has the keyboard: suggestions are for writing. */
function writing(view: EditorView): boolean {
  const vim = (view as unknown as { cm?: { state?: { vim?: { insertMode?: boolean } | null } } }).cm?.state?.vim
  return !vim || vim.insertMode === true
}

/** The passage to proofread: the selection, or the paragraph that the cursor is in. */
export function proofreadRange(state: EditorState): { from: number; to: number } | null {
  const sel = state.selection.main
  if (!sel.empty) return { from: sel.from, to: sel.to }
  const doc = state.doc
  const here = doc.lineAt(sel.head)
  if (!here.text.trim()) return null
  let first = here
  while (first.number > 1) {
    const prev = doc.line(first.number - 1)
    if (!prev.text.trim()) break
    first = prev
  }
  let last = here
  while (last.number < doc.lines) {
    const next = doc.line(last.number + 1)
    if (!next.text.trim()) break
    last = next
  }
  return { from: first.from, to: last.to }
}

/** One change that proofreading proposes: a piece of the passage and what to put instead. */
export interface Correction {
  from: number
  to: number
  /** The text that replaces original[from, to). */
  insert: string
}

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch)

/**
 * The corrections between a passage and the corrected version. A change
 * inside a word is widened to the whole word ("recieve" → "receive" rather
 * than "ie" → "ei"), which is how a person reads a correction.
 */
export function corrections(original: string, corrected: string): Correction[] {
  const raw = presentableDiff(original, corrected)
  const out: Array<{ fromA: number; toA: number; fromB: number; toB: number }> = []
  raw.forEach((change, i) => {
    let { fromA, toA, fromB, toB } = change
    const removed = original.slice(fromA, toA)
    const inserted = corrected.slice(fromB, toB)
    // Between two changes the texts are the same, so both sides widen alike.
    const floor = out.length > 0 ? out[out.length - 1].toA : 0
    const ceiling = i + 1 < raw.length ? raw[i + 1].fromA : original.length
    if (isWordChar(removed[0]) || isWordChar(inserted[0])) {
      while (fromA > floor && fromB > 0 && isWordChar(original[fromA - 1])) {
        fromA--
        fromB--
      }
    }
    if (isWordChar(removed.at(-1)) || isWordChar(inserted.at(-1))) {
      while (toA < ceiling && toB < corrected.length && isWordChar(original[toA])) {
        toA++
        toB++
      }
    }
    const previous = out[out.length - 1]
    if (previous && fromA <= previous.toA) {
      previous.toA = Math.max(previous.toA, toA)
      previous.toB = Math.max(previous.toB, toB)
    } else {
      out.push({ fromA, toA, fromB, toB })
    }
  })
  return out.map((c) => ({ from: c.fromA, to: c.toA, insert: corrected.slice(c.fromB, c.toB) }))
}

/**
 * The corrections to offer, and which of them start out rejected (the text
 * is kept as it was there unless the writer takes them):
 * - When the answer stopped before the end of the passage, the end of the
 *   passage is missing from it. That is not a correction, so it is not offered.
 * - A proofreader corrects; it does not cut. A correction that would remove a
 *   good deal of text (a model leaving out a sentence, say) starts out rejected.
 */
export function proposedCorrections(
  original: string,
  corrected: string,
  truncated: boolean
): { list: Correction[]; rejected: Set<number> } {
  let list = corrections(original, corrected)
  const last = list.at(-1)
  if (truncated && last && last.to === original.length) list = list.slice(0, -1)
  const rejected = new Set<number>()
  list.forEach((c, i) => {
    const removed = c.to - c.from
    if (removed >= 20 && c.insert.length < removed / 3) rejected.add(i)
  })
  return { list, rejected }
}

/** The passage with the corrections that were not rejected. */
export function applyCorrections(original: string, list: Correction[], rejected: ReadonlySet<number>): string {
  let out = ''
  let pos = 0
  list.forEach((c, i) => {
    out += original.slice(pos, c.from) + (rejected.has(i) ? original.slice(c.from, c.to) : c.insert)
    pos = c.to
  })
  return out + original.slice(pos)
}

class SuggestionWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }

  eq(other: SuggestionWidget): boolean {
    return other.text === this.text
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-suggestion'
    span.setAttribute('aria-hidden', 'true')
    span.textContent = this.text
    return span
  }
}

let counter = 0

function suggestionPlugin(config: AssistantConfig): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none
      private timer: number | null = null
      /** The request under way, if any. */
      private asking: string | null = null
      private quietUntil = 0

      constructor(readonly view: EditorView) {}

      update(update: ViewUpdate): void {
        if (update.docChanged || update.selectionSet || (update.focusChanged && !update.view.hasFocus)) this.stop()
        if (update.focusChanged && !update.view.hasFocus && update.state.field(suggestionField, false)) {
          // Clicking elsewhere lets it go (not now: no dispatching during an update).
          queueMicrotask(() => this.view.dispatch({ effects: setSuggestion.of(null) }))
        }
        const shown = update.state.field(suggestionField, false)
        // Not over text that an input method is composing.
        this.decorations =
          shown && completionStatus(update.state) === null && !update.view.composing
            ? Decoration.set([Decoration.widget({ widget: new SuggestionWidget(shown.text), side: 1 }).range(shown.pos)])
            : Decoration.none
        if (update.transactions.some((tr) => tr.effects.some((e) => e.is(askNow)))) {
          queueMicrotask(() => void this.ask('manual'))
          return
        }
        if (shown || config.inline !== 'auto' || !update.docChanged) return
        if (update.transactions.some(isTyping) && Date.now() >= this.quietUntil) {
          this.timer = window.setTimeout(() => {
            this.timer = null
            void this.ask('auto')
          }, PAUSE_MS)
        }
      }

      /** Forgets the request under way and the one that was about to be made. */
      stop(): void {
        if (this.timer !== null) window.clearTimeout(this.timer)
        this.timer = null
        if (this.asking) {
          config.cancel(this.asking)
          this.asking = null
          config.status({ state: 'idle' })
        }
      }

      async ask(trigger: 'auto' | 'manual'): Promise<void> {
        const view = this.view
        const state = view.state
        if (!canSuggest(state, trigger) || view.composing || !writing(view)) return
        if (trigger === 'auto' && !view.hasFocus) return
        this.stop()
        const pos = state.selection.main.head
        const id = `suggest-${++counter}`
        this.asking = id
        config.status({ state: 'thinking' })
        let result: InlineResult | null
        try {
          result = await config.ask({ id, path: config.path(), ...excerpt(state, pos), trigger })
        } catch (err) {
          if (this.asking !== id) return
          this.asking = null
          if (trigger === 'auto') this.quietUntil = Date.now() + BACK_OFF_MS
          config.status({ state: 'error', message: err instanceof Error ? err.message : String(err), asked: trigger === 'manual' })
          return
        }
        if (this.asking !== id) return
        this.asking = null
        this.quietUntil = 0
        // Only for the place it was asked for, and only while nothing has changed.
        if (!result || view.state.doc !== state.doc || view.state.selection.main.head !== pos) {
          config.status({ state: 'idle' })
          return
        }
        if (!result.text) {
          config.status({
            state: 'empty',
            asked: trigger === 'manual',
            message: result.thinking
              ? 'The model spent its whole answer on thinking, and this server offers no way to ask it not to. Turn thinking off in the server’s settings, or choose a model without a reasoning phase.'
              : 'The model had no suggestion here.'
          })
          return
        }
        config.status({ state: 'idle' })
        view.dispatch({ effects: setSuggestion.of({ pos, text: result.text }) })
      }

      destroy(): void {
        this.stop()
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
}

/** Asks for a suggestion at the cursor now. */
export function requestSuggestion(view: EditorView): boolean {
  if (view.state.field(suggestionField, false) === undefined) return false // the assistant is not on
  view.dispatch({ effects: askNow.of(null) })
  return true
}

export function acceptSuggestion(view: EditorView, part: 'all' | 'word' = 'all'): boolean {
  // In Vim's normal mode the keys are Vim's.
  if (!writing(view) || view.composing) return false
  const spec = acceptSpec(view.state, part)
  if (!spec) return false
  view.dispatch(spec)
  return true
}

/** Lets the suggestion go. Returns false so that Escape still does what it otherwise does. */
function dismissSuggestion(view: EditorView): boolean {
  if (view.state.field(suggestionField, false)) view.dispatch({ effects: setSuggestion.of(null) })
  return false
}

/** Everything the assistant adds to the editor, for the given settings. */
export function assistantExtension(config: AssistantConfig): Extension {
  const keys = [{ key: 'Mod-Shift-p', run: () => (config.proofread(), true) }]
  if (config.inline === 'off') return Prec.high(keymap.of(keys))
  return [
    suggestionField,
    suggestionPlugin(config),
    Prec.highest(
      keymap.of([
        { key: 'Tab', run: (view) => acceptSuggestion(view, 'all') },
        { key: 'Mod-ArrowRight', run: (view) => acceptSuggestion(view, 'word') },
        { key: 'Escape', run: dismissSuggestion },
        { key: 'Alt-\\', run: requestSuggestion },
        ...keys
      ])
    )
  ]
}
