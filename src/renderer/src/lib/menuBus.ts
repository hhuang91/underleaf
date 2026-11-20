// Commands from the native application menu, delivered to whichever screen is
// currently able to handle them.

import { useEffect, useRef } from 'react'

type Listener = (command: string) => void

const listeners = new Set<Listener>()
let pending: string | null = null

export function emitMenuCommand(command: string): void {
  if (listeners.size === 0) {
    pending = command
    return
  }
  for (const l of [...listeners]) l(command)
}

/** Queues a command for the next screen that mounts (used when navigating first). */
export function deferMenuCommand(command: string): void {
  pending = command
}

export function useMenuCommands(handler: Listener): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const listener: Listener = (command) => ref.current(command)
    listeners.add(listener)
    if (pending) {
      const command = pending
      pending = null
      listener(command)
    }
    return () => {
      listeners.delete(listener)
    }
  }, [])
}
