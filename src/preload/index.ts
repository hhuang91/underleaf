// The only bridge between the sandboxed renderer and the main process.

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { CompileProgressEvent, HistoryChangedEvent, ProjectChangedEvent, UnderleafApi } from '@shared/api'
import { CHANNELS, EVENTS, type ChannelNamespace, type IpcReply } from '@shared/channels'

function call(channel: string) {
  return async (...args: unknown[]): Promise<unknown> => {
    const reply = (await ipcRenderer.invoke(channel, ...args)) as IpcReply<unknown>
    if (!reply.ok) throw new Error(reply.error)
    return reply.value
  }
}

function namespace(ns: ChannelNamespace): Record<string, (...args: unknown[]) => Promise<unknown>> {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  for (const method of CHANNELS[ns]) out[method] = call(`${ns}:${method}`)
  return out
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api = {
  app: {
    ...namespace('app'),
    pathForFile: (file: File): string => {
      const filePath = webUtils.getPathForFile(file)
      // Only a file that the user really dropped or picked has a path. Tell the
      // main process, which accepts no other paths from outside the projects.
      if (filePath) ipcRenderer.send(EVENTS.droppedPath, filePath)
      return filePath
    },
    onMenuCommand: (cb: (command: string) => void) => subscribe<string>(EVENTS.menuCommand, cb),
    onFlushRequest: (cb: () => Promise<boolean>) =>
      subscribe<void>(EVENTS.flushRequest, () => {
        Promise.resolve()
          .then(cb)
          .catch(() => false)
          .then((saved) => ipcRenderer.send(EVENTS.flushDone, saved !== false))
      })
  },
  projects: {
    ...namespace('projects'),
    onChanged: (cb: (event: ProjectChangedEvent) => void) =>
      subscribe<ProjectChangedEvent>(EVENTS.projectChanged, cb)
  },
  files: namespace('files'),
  compile: {
    ...namespace('compile'),
    onProgress: (cb: (event: CompileProgressEvent) => void) =>
      subscribe<CompileProgressEvent>(EVENTS.compileProgress, cb)
  },
  history: {
    ...namespace('history'),
    onChanged: (cb: (event: HistoryChangedEvent) => void) =>
      subscribe<HistoryChangedEvent>(EVENTS.historyChanged, cb)
  }
} as unknown as UnderleafApi

contextBridge.exposeInMainWorld('api', api)
