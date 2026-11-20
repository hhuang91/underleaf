// Watches open project folders so edits made outside the app (git, another
// editor, a sync client) show up immediately.

import fs from 'node:fs'
import path from 'node:path'
import { IGNORED_NAMES } from '@shared/fileTypes'

interface Entry {
  watcher: fs.FSWatcher
  timer: NodeJS.Timeout | null
  pending: Set<string>
}

const DEBOUNCE_MS = 250

export class ProjectWatcher {
  private readonly entries = new Map<string, Entry>()

  start(dir: string, onChange: (paths: string[]) => void): void {
    const key = path.resolve(dir)
    if (this.entries.has(key)) return
    let watcher: fs.FSWatcher
    try {
      watcher = fs.watch(key, { recursive: true, persistent: false })
    } catch {
      return // watching is a convenience; the app works without it
    }
    const entry: Entry = { watcher, timer: null, pending: new Set() }
    this.entries.set(key, entry)

    watcher.on('change', (_event, filename) => {
      const rel = typeof filename === 'string' ? filename.split(path.sep).join('/') : ''
      if (rel && IGNORED_NAMES.has(rel.split('/')[0])) return
      if (rel) {
        const base = rel.slice(rel.lastIndexOf('/') + 1)
        if (IGNORED_NAMES.has(base)) return
      }
      entry.pending.add(rel || '*')
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        entry.timer = null
        const paths = entry.pending.size > 200 ? ['*'] : [...entry.pending]
        entry.pending.clear()
        onChange(paths)
      }, DEBOUNCE_MS)
    })
    watcher.on('error', () => this.stop(key))
  }

  isWatching(dir: string): boolean {
    return this.entries.has(path.resolve(dir))
  }

  stop(dir: string): void {
    const key = path.resolve(dir)
    const entry = this.entries.get(key)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    try {
      entry.watcher.close()
    } catch {
      /* already closed */
    }
    this.entries.delete(key)
  }

  stopAll(): void {
    for (const key of [...this.entries.keys()]) this.stop(key)
  }
}
