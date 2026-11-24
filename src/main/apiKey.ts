// The API key for the model server, for the servers that want one. It is kept
// apart from the settings (which the window can read in full), encrypted with
// the system's own key store: the Keychain on macOS, the user's account on
// Windows. A key belongs to the server it was entered for (its origin: scheme,
// host and port) and is handed out for no other, so that changing the address
// does not send it to wherever the address now points.

import { randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import { safeStorage } from 'electron'

interface Stored {
  /** Encrypted with safeStorage, in base64. */
  encrypted: string
  origin: string
}

export class ApiKeyStore {
  private cached: { key: string; origin: string } | null | undefined

  constructor(private readonly file: string) {}

  private async load(): Promise<{ key: string; origin: string } | null> {
    if (this.cached !== undefined) return this.cached
    let loaded: { key: string; origin: string } | null = null
    try {
      const stored = JSON.parse(await fsp.readFile(this.file, 'utf8')) as Partial<Stored>
      if (typeof stored.encrypted === 'string' && typeof stored.origin === 'string') {
        const key = safeStorage.decryptString(Buffer.from(stored.encrypted, 'base64'))
        if (key) loaded = { key, origin: stored.origin }
      }
    } catch {
      loaded = null // none stored, or it cannot be read any more (another computer's key store)
    }
    this.cached = loaded
    return loaded
  }

  /** The key for the server at this origin, if one was entered for it. */
  async keyFor(origin: string): Promise<string | null> {
    const stored = await this.load()
    return stored && stored.origin === origin ? stored.key : null
  }

  /** The server that the stored key is for, if one is stored. */
  async origin(): Promise<string | null> {
    return (await this.load())?.origin ?? null
  }

  /** Stores the key for the server at `origin`; an empty key removes the stored one. */
  async set(key: string, origin: string): Promise<void> {
    const value = key.trim()
    if (!value) {
      await fsp.rm(this.file, { force: true })
      this.cached = null
      return
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('This computer offers no safe place to keep the key, so it cannot be stored.')
    }
    const stored: Stored = { encrypted: safeStorage.encryptString(value).toString('base64'), origin }
    // Readable by its owner only from the start, and in place in one step.
    const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await fsp.writeFile(tmp, JSON.stringify(stored), { mode: 0o600 })
      await fsp.rename(tmp, this.file)
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => undefined)
    }
    this.cached = { key: value, origin }
  }
}
