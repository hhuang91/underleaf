// The writing assistant in the window: how the last request for a suggestion
// went (shown on the editor's toolbar), and the proofreading under way.

import { create } from 'zustand'
import { MAX_PROOFREAD_CHARS } from '@shared/types'
import type { AssistantStatus } from '../editor/assistant'
import { editor } from '../editor/controller'
import { errorMessage } from '../lib/util'
import { useApp } from './app'

export interface ProofreadSession {
  id: string
  /** The file, and where in it the passage was. */
  path: string
  from: number
  to: number
  original: string
  phase: 'running' | 'done' | 'failed'
  /** The answer so far; once done, the corrected passage. */
  text: string
  /** The model is still in its reasoning phase. */
  thinking: boolean
  /** The answer stopped before the end of the passage. */
  truncated: boolean
  error: string | null
}

interface AssistantState {
  status: AssistantStatus
  session: ProofreadSession | null
  /** Proofreads the selection, or the paragraph that the cursor is in. */
  proofread(): Promise<void>
  /** Stops the proofreading and closes it. */
  closeProofreading(): void
  /**
   * Puts the corrected passage in place. False when the passage is no longer
   * where it was (the file was closed, or changed there in the meantime).
   */
  apply(text: string): boolean
}

let serial = 0

export const useAssistant = create<AssistantState>((set, get) => ({
  status: { state: 'idle' },
  session: null,

  async proofread() {
    if (get().session) return
    const notify = useApp.getState().notify
    const target = editor.proofreadTarget()
    if (!target || !target.text.trim()) {
      notify('info', 'Select the text to proofread, or put the cursor in a paragraph.')
      return
    }
    if (target.text.length > MAX_PROOFREAD_CHARS) {
      notify(
        'error',
        `That is too much to proofread in one go (${target.text.length.toLocaleString()} characters, at most ${MAX_PROOFREAD_CHARS.toLocaleString()}). Select a shorter part.`
      )
      return
    }
    const id = `proofread-${++serial}`
    const session: ProofreadSession = {
      id,
      path: target.path,
      from: target.from,
      to: target.to,
      original: target.text,
      phase: 'running',
      text: '',
      thinking: false,
      truncated: false,
      error: null
    }
    set({ session })
    try {
      const result = await window.api.assistant.proofread({ id, path: target.path, text: target.text })
      const current = get().session
      if (current?.id !== id) return
      if (!result) set({ session: null })
      else set({ session: { ...current, phase: 'done', text: result.text, truncated: result.truncated, thinking: false } })
    } catch (err) {
      const current = get().session
      if (current?.id === id) set({ session: { ...current, phase: 'failed', error: errorMessage(err), thinking: false } })
    }
  },

  closeProofreading() {
    const session = get().session
    if (session?.phase === 'running') void window.api.assistant.cancel(session.id).catch(() => undefined)
    set({ session: null })
  },

  apply(text) {
    const session = get().session
    if (!session) return false
    if (!editor.replacePassage(session.path, session.from, session.to, session.original, text)) return false
    set({ session: null })
    return true
  }
}))

editor.assistantHooks = {
  status: (status) => {
    useAssistant.setState({ status })
    // A suggestion that was asked for gets an answer, also when there is none.
    if ((status.state === 'error' || status.state === 'empty') && status.asked) {
      useApp.getState().notify(status.state === 'error' ? 'error' : 'info', status.message)
    }
  },
  proofread: () => void useAssistant.getState().proofread()
}

window.api.assistant.onProgress((event) => {
  const session = useAssistant.getState().session
  if (session?.id === event.id && session.phase === 'running') {
    useAssistant.setState({ session: { ...session, text: event.text, thinking: event.thinking } })
  }
})
