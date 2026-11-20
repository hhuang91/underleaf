export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  if (!timestamp) return ''
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 45) return 'a few seconds ago'
  if (seconds < 90) return 'a minute ago'
  const minutes = Math.round(seconds / 60)
  if (minutes < 45) return `${minutes} minutes ago`
  if (minutes < 90) return 'an hour ago'
  const hours = Math.round(minutes / 60)
  if (hours < 22) return `${hours} hours ago`
  if (hours < 36) return 'a day ago'
  const days = Math.round(hours / 24)
  if (days < 26) return `${days} days ago`
  if (days < 45) return 'a month ago'
  if (days < 320) return `${Math.round(days / 30)} months ago`
  if (days < 548) return 'a year ago'
  return `${Math.round(days / 365)} years ago`
}

export function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function dirName(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

/** Recursively merges `patch` into a copy of `base` (arrays are replaced). */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    out[key] = deepMerge(out[key], value)
  }
  return out as T
}

export const isMac = navigator.platform.toLowerCase().includes('mac')

/** "Ctrl" on Windows/Linux, the command symbol on macOS. */
export const MOD = isMac ? '⌘' : 'Ctrl'

/** What deleted things go to, in the platform's own words. */
export const TRASH = isMac ? 'Trash' : 'recycle bin'

/** Label for "show this file or folder in the system file manager". */
export const REVEAL = isMac ? 'Reveal in Finder' : 'Show in folder'
