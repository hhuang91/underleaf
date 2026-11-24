// The request/response IPC surface. The preload script builds `window.api`
// from this table and the main process must implement every entry, so the two
// sides cannot drift apart.

export const CHANNELS = {
  app: [
    'info',
    'getSettings',
    'updateSettings',
    'chooseDirectory',
    'openExternal',
    'showItemInFolder',
    'texStatus'
  ],
  projects: [
    'list',
    'create',
    'pickZip',
    'importZip',
    'addFolder',
    'exportZip',
    'rename',
    'copy',
    'remove',
    'reveal',
    'open',
    'close',
    'setCompiler',
    'setRootDoc',
    'trustRc',
    'index',
    'wordCount'
  ],
  files: [
    'tree',
    'read',
    'readBinary',
    'write',
    'createFile',
    'createFolder',
    'rename',
    'move',
    'remove',
    'pickAndImport',
    'importPaths',
    'reveal'
  ],
  compile: [
    'run',
    'stop',
    'clearCache',
    'readPdf',
    'savePdf',
    'openBuildFolder',
    'syncToPdf',
    'syncToSource'
  ],
  history: ['list', 'save', 'changes', 'file', 'restore'],
  assistant: ['models', 'detect', 'check', 'complete', 'proofread', 'cancel', 'setKey', 'keyStatus']
} as const

export type ChannelNamespace = keyof typeof CHANNELS

/** One-way messages from the main process to the renderer. */
export const EVENTS = {
  projectChanged: 'event:project-changed',
  compileProgress: 'event:compile-progress',
  historyChanged: 'event:history-changed',
  /** The answer so far of a proofreading request. */
  assistantProgress: 'event:assistant-progress',
  menuCommand: 'event:menu-command',
  flushRequest: 'event:flush-request',
  flushDone: 'event:flush-done',
  /** Preload -> main: the path of a file the user dropped on the window. */
  droppedPath: 'event:dropped-path'
} as const

export type IpcReply<T> = { ok: true; value: T } | { ok: false; error: string }
