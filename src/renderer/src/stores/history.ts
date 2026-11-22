// State of the History screen: the project's versions, the one that is
// selected, what it is compared with, and the file whose changes are shown.

import { create } from 'zustand'
import type { HistoryList, RestoreResult, VersionChange, VersionFile, VersionInfo, VersionRef } from '@shared/types'
import { editor } from '../editor/controller'
import { errorMessage } from '../lib/util'
import { useApp } from './app'
import { useIde } from './ide'

/**
 * 'previous' shows what a version changed (compared with the one before it),
 * 'current' what has changed since (compared with the project as it is now).
 */
export type CompareMode = 'previous' | 'current'

const PAGE = 100

/** A restore that did not do everything: what it was of, and what it left. */
export interface RestoreReport {
  /** The name of the version. */
  label: string
  /** The one file that was restored; null for the whole project. */
  path: string | null
  result: RestoreResult
}

interface HistoryState {
  open: boolean
  loading: boolean
  error: string | null
  list: HistoryList | null
  limit: number
  selected: string | null
  compare: CompareMode
  changes: VersionChange[] | null
  changesError: string | null
  path: string | null
  file: VersionFile | null
  fileError: string | null
  /** A restore or a save is under way. */
  busy: boolean
  /** Set when the last restore left files as they were, until it is dismissed. */
  report: RestoreReport | null

  show(): Promise<void>
  hide(): void
  /** Reads the list of versions again, keeping the selection when it is still there. */
  refresh(): Promise<void>
  loadMore(): Promise<void>
  select(id: string): Promise<void>
  setCompare(mode: CompareMode): Promise<void>
  selectPath(path: string): Promise<void>
  /** Saves the project as it is now under a name. Works with the screen closed, too. */
  saveVersion(label: string): Promise<VersionInfo>
  /** Puts back one file of a version, or with null the whole project. */
  restore(version: string, path: string | null): Promise<void>
  dismissReport(): void
  reset(): void
}

const blank = {
  open: false,
  loading: false,
  error: null as string | null,
  list: null as HistoryList | null,
  limit: PAGE,
  selected: null as string | null,
  compare: 'previous' as CompareMode,
  changes: null as VersionChange[] | null,
  changesError: null as string | null,
  path: null as string | null,
  file: null as VersionFile | null,
  fileError: null as string | null,
  busy: false,
  report: null as RestoreReport | null
}

/** Bumped whenever the selection changes, so that slower answers for an older one are dropped. */
let token = 0

export const useHistory = create<HistoryState>((set, get) => {
  const api = window.api.history
  const projectId = (): string | null => useIde.getState().projectId

  /** The two states that the selection compares, or null while that cannot be told. */
  const range = (): { from: VersionRef | null; to: VersionRef } | null => {
    const { selected, compare, list } = get()
    if (!selected || !list) return null
    if (compare === 'current') return { from: selected, to: 'current' }
    const index = list.versions.findIndex((v) => v.id === selected)
    if (index < 0) return null
    const older = list.versions[index + 1]
    // The version before the last one listed is not loaded yet.
    if (!older && list.more) return null
    return { from: older?.id ?? null, to: selected }
  }

  const loadFile = async (path: string): Promise<void> => {
    const id = projectId()
    const r = range()
    if (!id || !r) return
    const mine = token
    set({ path, file: null, fileError: null })
    try {
      const file = await api.file(id, r.from, r.to, path)
      if (mine === token && get().path === path) set({ file })
    } catch (err) {
      if (mine === token && get().path === path) set({ fileError: errorMessage(err) })
    }
  }

  const loadChanges = async (): Promise<void> => {
    const id = projectId()
    if (!id || !get().selected) return
    const mine = ++token
    set({ changes: null, changesError: null, file: null, fileError: null })
    try {
      if (!range() && get().list?.more) await get().loadMore()
      if (mine !== token) return
      const r = range()
      if (!r) return
      const changes = await api.changes(id, r.from, r.to)
      if (mine !== token) return
      // Stay on the file that was being looked at; else start with the one
      // open in the editor, else with the first.
      const wanted = [get().path, useIde.getState().open?.path].find((p) => p && changes.some((c) => c.path === p))
      const path = wanted ?? changes[0]?.path ?? null
      set({ changes, path })
      if (path) await loadFile(path)
    } catch (err) {
      if (mine === token) set({ changesError: errorMessage(err) })
    }
  }

  return {
    ...blank,

    async show() {
      if (!projectId()) return
      set({ ...blank, open: true, loading: true })
      // "The project as it is now" is read from disk: write what is in the editor first.
      await editor.flush()
      await get().refresh()
    },

    hide() {
      token++
      set({ ...blank })
    },

    async refresh() {
      const id = projectId()
      if (!id) return
      try {
        const list = await api.list(id, get().limit)
        if (projectId() !== id || !get().open) return
        const still = list.versions.some((v) => v.id === get().selected)
        set({ list, loading: false, error: null })
        if (!still) {
          const first = list.versions[0]
          if (first) await get().select(first.id)
          else set({ selected: null, changes: null, path: null, file: null })
        } else if (get().compare === 'current' || get().changes === null) {
          // What "now" is may have moved on.
          await loadChanges()
        }
      } catch (err) {
        if (projectId() === id) set({ loading: false, error: errorMessage(err) })
      }
    },

    async loadMore() {
      const id = projectId()
      if (!id) return
      const limit = get().limit + PAGE
      set({ limit })
      try {
        const list = await api.list(id, limit)
        if (projectId() === id && get().open) set({ list })
      } catch (err) {
        if (projectId() === id) set({ error: errorMessage(err) })
      }
    },

    async select(id) {
      if (get().selected === id && get().changes !== null) return
      set({ selected: id, path: null })
      await loadChanges()
    },

    async setCompare(mode) {
      if (get().compare === mode) return
      set({ compare: mode })
      await loadChanges()
    },

    async selectPath(path) {
      if (get().path === path && (get().file || get().fileError)) return
      await loadFile(path)
    },

    async saveVersion(label) {
      const id = projectId()
      if (!id) throw new Error('No project is open')
      if (!(await editor.flush())) {
        throw new Error('The latest changes could not be written to disk, so the version would miss them. Try again once they are saved.')
      }
      const version = await api.save(id, label)
      if (get().open) {
        set({ selected: version.id, changes: null, path: null })
        await get().refresh()
      }
      return version
    },

    async restore(version, path) {
      const id = projectId()
      if (!id || get().busy) return
      set({ busy: true })
      try {
        if (!(await editor.flush())) {
          throw new Error('The latest changes could not be written to disk. They would be lost by restoring now; try again once they are saved.')
        }
        const label = get().list?.versions.find((v) => v.id === version)?.label ?? 'the version'
        const result = await api.restore(id, version, path)
        if (projectId() !== id) return
        // The files are different now: show that at once, without waiting for
        // the folder's watcher to notice.
        await useIde.getState().handleExternalChange(['*'])
        if (projectId() !== id) return
        const complete = result.left.length === 0 && result.failed.length === 0
        if (complete && path === null) {
          get().hide()
          useApp.getState().notify('success', `The project is back the way it was in "${label}". How it was before is in the history, too.`)
        } else {
          if (complete) useApp.getState().notify('success', `${path} is back the way it was in "${label}".`)
          // Something was left as it is: stay here and say what.
          set({ busy: false, report: complete ? null : { label, path, result } })
          await get().refresh()
        }
        if (path === null) void useIde.getState().compile()
      } finally {
        if (get().busy) set({ busy: false })
      }
    },

    dismissReport() {
      set({ report: null })
    },

    reset() {
      token++
      set({ ...blank })
    }
  }
})
