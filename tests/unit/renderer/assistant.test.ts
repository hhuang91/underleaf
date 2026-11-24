import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  acceptSpec,
  applyCorrections,
  canSuggest,
  corrections,
  excerpt,
  isTyping,
  nextWord,
  proofreadRange,
  proposedCorrections,
  setSuggestion,
  suggestionField
} from '../../../src/renderer/src/editor/assistant'

function stateWith(doc: string, cursor = doc.length): EditorState {
  return EditorState.create({ doc, selection: { anchor: cursor }, extensions: [suggestionField] })
}

function suggest(state: EditorState, text: string): EditorState {
  return state.update({ effects: setSuggestion.of({ pos: state.selection.main.head, text }) }).state
}

const type = (state: EditorState, text: string): EditorState => {
  const pos = state.selection.main.head
  return state.update({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length }, userEvent: 'input.type' }).state
}

describe('a suggestion in the editor', () => {
  it('stays while what is typed is what it says, and goes otherwise', () => {
    let state = suggest(stateWith('Our method is'), ' faster than before.')
    state = type(state, ' f')
    expect(state.field(suggestionField)).toEqual({ pos: 15, text: 'aster than before.' })
    expect(type(state, 'x').field(suggestionField)).toBeNull()
    // Typing all of it: nothing left to suggest.
    expect(type(state, 'aster than before.').field(suggestionField)).toBeNull()
  })

  it('goes when the cursor moves or the text changes elsewhere', () => {
    const state = suggest(stateWith('Our method is'), ' fast.')
    expect(state.update({ selection: { anchor: 3 } }).state.field(suggestionField)).toBeNull()
    expect(state.update({ selection: EditorSelection.range(0, 13) }).state.field(suggestionField)).toBeNull()
    expect(state.update({ changes: { from: 0, to: 3, insert: 'My' } }).state.field(suggestionField)).toBeNull()
    expect(state.update({ changes: { from: 12, to: 13 } }).state.field(suggestionField)).toBeNull()
    expect(state.update({ effects: setSuggestion.of(null) }).state.field(suggestionField)).toBeNull()
  })

  it('is taken whole, or a word at a time', () => {
    const state = suggest(stateWith('Our method is'), ' faster than before.')
    const all = state.update(acceptSpec(state, 'all')!).state
    expect(all.doc.toString()).toBe('Our method is faster than before.')
    expect(all.selection.main.head).toBe(all.doc.length)
    expect(all.field(suggestionField)).toBeNull()

    const word = state.update(acceptSpec(state, 'word')!).state
    expect(word.doc.toString()).toBe('Our method is faster')
    expect(word.field(suggestionField)).toEqual({ pos: 20, text: ' than before.' })
    expect(acceptSpec(stateWith('Nothing suggested'), 'all')).toBeNull()
    expect(nextWord('  \\textbf{x} rest')).toBe('  \\textbf{x}')
  })
})

describe('when a suggestion is asked for', () => {
  it('is after typing, not after text that an input method or Vim put in', () => {
    const state = stateWith('Text')
    const change = (userEvent: string) => state.update({ changes: { from: 4, insert: 'x' }, userEvent })
    expect(isTyping(change('input.type'))).toBe(true)
    expect(isTyping(change('delete.backward'))).toBe(true)
    // An input method's text that is not chosen yet; Vim's normal mode reports its edits the same way.
    expect(isTyping(change('input.type.compose'))).toBe(false)
    expect(isTyping(change('input.type.compose.start'))).toBe(false)
    expect(isTyping(change('input.paste'))).toBe(false)
    expect(isTyping(change('undo'))).toBe(false)
  })

  it('is at the end of a word, on a line with text, with a plain cursor', () => {
    expect(canSuggest(stateWith('Our method is'), 'auto')).toBe(true)
    expect(canSuggest(stateWith('Our method is.', 13), 'auto')).toBe(true)
    expect(canSuggest(stateWith('Our method is', 6), 'auto')).toBe(false) // inside "method"
    expect(canSuggest(stateWith('Text\n'), 'auto')).toBe(false) // an empty line
    const selected = EditorState.create({ doc: 'Some text', selection: EditorSelection.range(0, 4) })
    expect(canSuggest(selected, 'auto')).toBe(false)
    expect(canSuggest(selected, 'manual')).toBe(false)
    const readOnly = EditorState.create({ doc: 'Text', selection: { anchor: 4 }, extensions: [EditorState.readOnly.of(true)] })
    expect(canSuggest(readOnly, 'manual')).toBe(false)
    // When asked for, also where it would not be offered by itself.
    expect(canSuggest(stateWith('Text\n'), 'manual')).toBe(true)
  })

  it('sends an excerpt whose start moves seldom, so that the server can reuse what it read', () => {
    const line = 'A line of text that is forty characters\n' // 40 characters
    const doc = line.repeat(200) // 8000 characters
    const at = (pos: number): { before: string; after: string } => excerpt(stateWith(doc, pos), pos)
    const first = at(5000)
    expect(first.before.length).toBeGreaterThanOrEqual(1500)
    expect(first.before.length).toBeLessThanOrEqual(2500)
    expect(first.before.startsWith('A line')).toBe(true) // at the start of a line
    // A few characters further on, it starts at the same place.
    const later = at(5300)
    expect(doc.indexOf(later.before)).toBe(doc.indexOf(first.before))
    // After the cursor: up to the end of a line, about 400 characters.
    expect(first.after.length).toBeLessThanOrEqual(400)
    expect(first.after.endsWith('characters')).toBe(true)
    expect(at(10).before).toBe(doc.slice(0, 10))
  })
})

describe('the passage to proofread', () => {
  const doc = '\\section{Intro}\nFirst line of a paragraph\nand its second line.\n\nAnother paragraph.\n'

  it('is the selection, or else the paragraph around the cursor', () => {
    const selected = EditorState.create({ doc, selection: EditorSelection.range(16, 21) })
    expect(proofreadRange(selected)).toEqual({ from: 16, to: 21 })
    const inParagraph = EditorState.create({ doc, selection: { anchor: 30 } })
    const range = proofreadRange(inParagraph)!
    expect(doc.slice(range.from, range.to)).toBe('\\section{Intro}\nFirst line of a paragraph\nand its second line.')
    const onBlank = EditorState.create({ doc, selection: { anchor: doc.indexOf('\n\n') + 1 } })
    expect(proofreadRange(onBlank)).toBeNull()
  })

  it('gets the corrections that were not rejected', () => {
    const original = 'We recieve teh data, wich is noisy.'
    const corrected = 'We receive the data, which is noisy.'
    const list = corrections(original, corrected)
    expect(list.map((c) => [original.slice(c.from, c.to), c.insert])).toEqual([
      ['recieve', 'receive'],
      ['teh', 'the'],
      ['wich', 'which']
    ])
    expect(applyCorrections(original, list, new Set())).toBe(corrected)
    expect(applyCorrections(original, list, new Set([1]))).toBe('We receive teh data, which is noisy.')
    expect(applyCorrections(original, list, new Set([0, 1, 2]))).toBe(original)
  })

  it('does not offer the missing end of a cut-off answer, nor take large removals unasked', () => {
    const original = 'The first sentence has teh typo. The second sentence is fine. The third one is fine too.'
    // The answer stopped after the first sentence.
    const cut = proposedCorrections(original, 'The first sentence has the typo.', true)
    expect(cut.list.map((c) => original.slice(c.from, c.to))).toEqual(['teh'])
    expect(applyCorrections(original, cut.list, cut.rejected)).toBe(original.replace('teh', 'the'))
    // An answer that left out a sentence: that change waits for the writer.
    const shorter = proposedCorrections(original, 'The first sentence has the typo. The third one is fine too.', false)
    expect(shorter.list.length).toBe(2)
    expect([...shorter.rejected]).toEqual([1])
    expect(applyCorrections(original, shorter.list, shorter.rejected)).toBe(original.replace('teh', 'the'))
  })

  it('shows a correction as whole words, and punctuation by itself', () => {
    const show = (a: string, b: string): Array<[string, string]> =>
      corrections(a, b).map((c) => [a.slice(c.from, c.to), c.insert])
    expect(show('The result is good', 'The results are good')).toEqual([['result is', 'results are']])
    expect(show('the data , which', 'the data, which')).toEqual([[' ', '']])
    expect(show('a eror here', 'an error here')).toEqual([['a eror', 'an error']])
    expect(show('\\emph{teh} end', '\\emph{the} end')).toEqual([['teh', 'the']])
    for (const [a, b] of [
      ['Its a nice day , isnt it', "It's a nice day, isn't it"],
      ['', 'Something'],
      ['Something', '']
    ]) {
      expect(applyCorrections(a, corrections(a, b), new Set())).toBe(b)
    }
  })
})
