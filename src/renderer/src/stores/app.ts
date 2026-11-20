import { create } from 'zustand'
import type { AppInfo, AppSettings, DeepPartial, TexStatus } from '@shared/types'
import { deepMerge, errorMessage } from '../lib/util'

export type Route = { name: 'dashboard' } | { name: 'project'; id: string }

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  message: string
  action?: { label: string; run: () => void }
}

interface AppState {
  ready: boolean
  fatal: string | null
  info: AppInfo | null
  settings: AppSettings | null
  tex: TexStatus | null
  route: Route
  toasts: Toast[]
  init(): Promise<void>
  /** Applies the change locally right away and persists it in the background. */
  patchSettings(patch: DeepPartial<AppSettings>): Promise<void>
  navigate(route: Route): void
  notify(kind: Toast['kind'], message: string, action?: Toast['action']): void
  dismiss(id: number): void
  refreshTex(force?: boolean): Promise<void>
}

let nextToastId = 1

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  fatal: null,
  info: null,
  settings: null,
  tex: null,
  route: { name: 'dashboard' },
  toasts: [],

  async init() {
    try {
      const [info, settings] = await Promise.all([window.api.app.info(), window.api.app.getSettings()])
      set({ info, settings, ready: true })
      void get().refreshTex()
    } catch (err) {
      set({ fatal: errorMessage(err) })
    }
  },

  async patchSettings(patch) {
    const current = get().settings
    if (current) set({ settings: deepMerge(current, patch) })
    try {
      set({ settings: await window.api.app.updateSettings(patch) })
    } catch (err) {
      get().notify('error', `Could not save settings: ${errorMessage(err)}`)
    }
  },

  navigate(route) {
    set({ route })
  },

  notify(kind, message, action) {
    const id = nextToastId++
    set({ toasts: [...get().toasts.slice(-3), { id, kind, message, action }] })
    window.setTimeout(() => get().dismiss(id), kind === 'error' ? 9000 : 5500)
  },

  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  },

  async refreshTex(force = false) {
    try {
      set({ tex: await window.api.app.texStatus(force) })
    } catch {
      /* purely informational */
    }
  }
}))

/** Settings are loaded before any screen renders, so screens can rely on them. */
export function useSettings(): AppSettings {
  const settings = useApp((s) => s.settings)
  if (!settings) throw new Error('Settings are not loaded yet')
  return settings
}

export function notifyError(err: unknown): void {
  useApp.getState().notify('error', errorMessage(err))
}
