// Persistent application settings (a JSON file in the user-data folder).

import type { AppSettings, DeepPartial } from '@shared/types'
import { readJson, writeJson } from './util/fsx'

export function defaultSettings(libraryPath: string): AppSettings {
  return {
    libraryPath,
    externalProjects: [],
    engineBackend: 'auto',
    texBinPath: '',
    autoCompile: false,
    stopOnFirstError: false,
    overallTheme: 'default',
    editor: {
      fontSize: 13,
      fontFamily: 'monaco',
      lineHeight: 'normal',
      theme: 'textmate',
      keybindings: 'default',
      autoComplete: true,
      autoCloseBrackets: true,
      codeCheck: true,
      spellCheck: true
    },
    layout: {
      view: 'split',
      fileTreeWidth: 240,
      editorRatio: 0.5,
      outlineOpen: true
    },
    pdfZoom: 'page-width',
    lastOpenFile: {},
    trustedRc: {},
    windowBounds: null
  }
}

const ENUMS: Record<string, ReadonlySet<string>> = {
  engineBackend: new Set(['auto', 'system', 'tectonic']),
  overallTheme: new Set(['default', 'light']),
  'editor.fontFamily': new Set(['monaco', 'lucida']),
  'editor.lineHeight': new Set(['compact', 'normal', 'wide']),
  'editor.keybindings': new Set(['default', 'vim', 'emacs']),
  'layout.view': new Set(['split', 'editor', 'pdf'])
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Merges `incoming` over `base`, keeping only keys that exist in `base` with a
 * value of the same kind. Anything unexpected in the file falls back to the
 * default, so a hand-edited or outdated settings file cannot break the app.
 */
function mergeKnown(base: unknown, incoming: unknown, keyPath: string): unknown {
  if (incoming === undefined) return base
  // Free-form string maps and nullable objects are taken as a whole. In the
  // maps an empty string removes the entry.
  if (keyPath === 'lastOpenFile' || keyPath === 'trustedRc') {
    if (!isPlainObject(incoming)) return base
    const out: Record<string, string> = { ...(base as Record<string, string>) }
    for (const [k, v] of Object.entries(incoming)) {
      if (v === '') delete out[k]
      else if (typeof v === 'string') out[k] = v
    }
    return out
  }
  if (keyPath === 'windowBounds') {
    if (incoming === null) return null
    if (!isPlainObject(incoming)) return base
    const { width, height, x, y, maximized } = incoming
    if (typeof width !== 'number' || typeof height !== 'number') return base
    return {
      width,
      height,
      x: typeof x === 'number' ? x : undefined,
      y: typeof y === 'number' ? y : undefined,
      maximized: maximized === true
    }
  }
  if (Array.isArray(base)) {
    return Array.isArray(incoming) ? incoming.filter((v) => typeof v === 'string') : base
  }
  if (isPlainObject(base)) {
    if (!isPlainObject(incoming)) return base
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(base)) {
      out[key] = mergeKnown(base[key], incoming[key], keyPath ? `${keyPath}.${key}` : key)
    }
    return out
  }
  if (typeof incoming !== typeof base) return base
  const allowed = ENUMS[keyPath]
  if (allowed && !allowed.has(incoming as string)) return base
  if (typeof incoming === 'number' && !Number.isFinite(incoming)) return base
  return incoming
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function normalise(s: AppSettings): AppSettings {
  s.editor.fontSize = clamp(Math.round(s.editor.fontSize), 8, 32)
  s.layout.fileTreeWidth = clamp(Math.round(s.layout.fileTreeWidth), 140, 600)
  s.layout.editorRatio = clamp(s.layout.editorRatio, 0.15, 0.85)
  return s
}

export class SettingsStore {
  private data: AppSettings
  private writing: Promise<void> = Promise.resolve()

  private constructor(
    private readonly file: string,
    initial: AppSettings
  ) {
    this.data = initial
  }

  static async load(file: string, defaults: AppSettings): Promise<SettingsStore> {
    const stored = await readJson<unknown>(file)
    const merged = normalise(mergeKnown(defaults, stored ?? {}, '') as AppSettings)
    if (!merged.libraryPath.trim()) merged.libraryPath = defaults.libraryPath
    return new SettingsStore(file, merged)
  }

  get(): AppSettings {
    return this.data
  }

  async update(patch: DeepPartial<AppSettings>): Promise<AppSettings> {
    this.data = normalise(mergeKnown(this.data, patch, '') as AppSettings)
    await this.save()
    return this.data
  }

  /** Writes are serialised so that rapid updates cannot interleave on disk. */
  save(): Promise<void> {
    const snapshot = this.data
    this.writing = this.writing.then(() => writeJson(this.file, snapshot)).catch(() => undefined)
    return this.writing
  }
}
