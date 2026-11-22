import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  shell,
  type MenuItemConstructorOptions
} from 'electron'
import { EVENTS } from '@shared/channels'
import { ProjectAnalyzer } from './analysis'
import { CompileManager } from './compile'
import { HistoryManager } from './history'
import { registerIpc } from './ipc'
import { encodeProjectId, ProjectLibrary } from './projects'
import { defaultSettings, SettingsStore } from './settings'
import { isInside } from './util/fsx'
import { ProjectWatcher } from './watcher'

const DEV_URL = process.env['ELECTRON_RENDERER_URL'] ?? null
const APP_ORIGIN = 'underleaf://app'
const RENDERER_DIR = path.join(__dirname, '../renderer')

// Tests and portable setups can redirect every location the app writes to.
if (process.env['UNDERLEAF_USER_DATA']) {
  app.setPath('userData', path.resolve(process.env['UNDERLEAF_USER_DATA']))
} else if (!app.isPackaged) {
  app.setPath('userData', `${app.getPath('userData')}-dev`)
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'underleaf',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true }
  }
])

let mainWindow: BrowserWindow | null = null
let quitting = false
let settings: SettingsStore
const watcher = new ProjectWatcher()
let compiler: CompileManager
let history: HistoryManager | null = null

// ---------------------------------------------------------------- paths

function resourcePath(...segments: string[]): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, ...segments)
    : path.join(app.getAppPath(), 'resources', ...segments)
}

function cacheRoot(): string {
  if (process.env['UNDERLEAF_CACHE']) return path.resolve(process.env['UNDERLEAF_CACHE'])
  const home = app.getPath('home')
  if (process.platform === 'win32') {
    return path.join(process.env['LOCALAPPDATA'] ?? app.getPath('userData'), 'Underleaf', 'build')
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'Underleaf', 'build')
  return path.join(process.env['XDG_CACHE_HOME'] ?? path.join(home, '.cache'), 'underleaf', 'build')
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile()
  } catch {
    return false
  }
}

let tectonicPath: string | null = null

/** The bundled engine, or one the user installed themselves. */
async function findTectonic(): Promise<string | null> {
  if (tectonicPath && (await isFile(tectonicPath))) return tectonicPath
  const exe = process.platform === 'win32' ? 'tectonic.exe' : 'tectonic'
  const candidates: string[] = []
  if (process.env['UNDERLEAF_TECTONIC']) candidates.push(process.env['UNDERLEAF_TECTONIC'])
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'bin', exe))
  } else {
    const os = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
    candidates.push(resourcePath('bin', `${os}-${process.arch}`, exe))
  }
  const pathVar = process.env['PATH'] ?? process.env['Path'] ?? ''
  for (const dir of pathVar.split(path.delimiter)) if (dir) candidates.push(path.join(dir, exe))
  if (process.platform === 'darwin') candidates.push('/opt/homebrew/bin/tectonic', '/usr/local/bin/tectonic')
  for (const candidate of candidates) {
    if (await isFile(candidate)) {
      tectonicPath = candidate
      return candidate
    }
  }
  return null
}

// ------------------------------------------------------------- protocol

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

/** Serves the bundled renderer from underleaf://app/, so it has a real, secure origin. */
function registerAppProtocol(): void {
  protocol.handle('underleaf', async (request) => {
    const url = new URL(request.url)
    if (url.host !== 'app') return new Response('Not found', { status: 404 })
    let rel: string
    try {
      rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    if (!rel) rel = 'index.html'
    const file = path.resolve(RENDERER_DIR, rel)
    if (!isInside(RENDERER_DIR, file)) return new Response('Forbidden', { status: 403 })
    try {
      const data = await fsp.readFile(file)
      const ext = path.extname(file).toLowerCase()
      const headers: Record<string, string> = {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff'
      }
      if (ext === '.html') headers['content-security-policy'] = CSP
      return new Response(new Uint8Array(data), { headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

// --------------------------------------------------------------- window

function sendMenuCommand(command: string): void {
  mainWindow?.webContents.send(EVENTS.menuCommand, command)
}

/**
 * Shows the licences of the software the app contains. The file is written by
 * scripts/collect-licenses.mjs and installed next to the app.
 */
async function openLicenses(): Promise<void> {
  const file = resourcePath('THIRD_PARTY_LICENSES.txt')
  const problem = (await isFile(file)) ? await shell.openPath(file) : 'missing'
  if (problem) dialog.showErrorBox('Open-Source Licenses', `The file with the licenses could not be opened:\n${file}`)
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = []
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => sendMenuCommand('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }
  template.push({
    label: 'File',
    submenu: [
      { label: 'New Project…', accelerator: 'CmdOrCtrl+Shift+N', click: () => sendMenuCommand('new-project') },
      { label: 'Upload Project (.zip)…', click: () => sendMenuCommand('upload-project') },
      { label: 'Open Existing Folder…', click: () => sendMenuCommand('open-folder') },
      { type: 'separator' },
      { label: 'Download Source (.zip)…', click: () => sendMenuCommand('download-zip') },
      { label: 'Download PDF…', click: () => sendMenuCommand('download-pdf') },
      { type: 'separator' },
      { label: 'Save Version…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenuCommand('save-version') },
      { label: 'History', accelerator: 'CmdOrCtrl+Shift+H', click: () => sendMenuCommand('history') },
      { type: 'separator' },
      { label: 'Back to Projects', click: () => sendMenuCommand('go-home') },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' }
    ]
  })
  template.push({ role: 'editMenu' })
  template.push({
    label: 'View',
    submenu: [
      { label: 'Recompile', accelerator: 'CmdOrCtrl+Enter', registerAccelerator: false, click: () => sendMenuCommand('recompile') },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { type: 'separator' },
      { role: 'toggleDevTools' },
      ...(DEV_URL ? ([{ role: 'reload' }] as MenuItemConstructorOptions[]) : [])
    ]
  })
  if (isMac) template.push({ role: 'windowMenu' })
  template.push({
    role: 'help',
    submenu: [
      {
        label: 'LaTeX Documentation',
        click: () => void shell.openExternal('https://www.overleaf.com/learn')
      },
      { label: 'Keyboard Shortcuts', click: () => sendMenuCommand('hotkeys') },
      { type: 'separator' },
      { label: 'Open-Source Licenses', click: () => void openLicenses() }
    ]
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Right-click menu: spelling suggestions and the usual clipboard actions. */
function attachContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = []
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 6)) {
        items.push({ label: suggestion, click: () => win.webContents.replaceMisspelling(suggestion) })
      }
      if (params.dictionarySuggestions.length === 0) items.push({ label: 'No suggestions', enabled: false })
      items.push({
        label: 'Add to Dictionary',
        click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      })
      items.push({ type: 'separator' })
    }
    if (params.isEditable) {
      items.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll' }
      )
    } else if (params.selectionText.trim()) {
      items.push({ role: 'copy' })
    }
    if (items.length > 0) Menu.buildFromTemplate(items).popup({ window: win })
  })
}

function isAppUrl(url: string): boolean {
  if (url.startsWith(`${APP_ORIGIN}/`)) return true
  return DEV_URL !== null && url.startsWith(DEV_URL)
}

function createWindow(): void {
  const bounds = settings.get().windowBounds
  const win = new BrowserWindow({
    width: bounds?.width ?? 1440,
    height: bounds?.height ?? 900,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 880,
    minHeight: 560,
    show: false,
    backgroundColor: '#1b222c',
    title: 'Underleaf',
    autoHideMenuBar: true,
    icon: process.platform === 'linux' ? resourcePath('icon.png') : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  })
  mainWindow = win
  if (bounds?.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())

  // Links (for example URLs inside the PDF) open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url)
  })
  attachContextMenu(win)

  // Give the editor a moment to write unsaved changes before the window goes
  // away, and do not let it go quietly when they could not be written.
  let closing: 'no' | 'waiting' | 'yes' = 'no'
  win.on('close', (event) => {
    if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) {
      const b = win.getBounds()
      void settings.update({ windowBounds: { ...b, maximized: false } })
    } else {
      const prev = settings.get().windowBounds
      void settings.update({
        windowBounds: { width: prev?.width ?? 1440, height: prev?.height ?? 900, x: prev?.x, y: prev?.y, maximized: win.isMaximized() }
      })
    }
    if (closing === 'yes' || win.webContents.isDestroyed() || win.webContents.isCrashed()) return
    event.preventDefault()
    if (closing === 'waiting') return
    closing = 'waiting'

    let settled = false
    const proceed = (): void => {
      const finish = (): void => {
        closing = 'yes'
        // Cancelling the close also cancelled a pending quit (Cmd+Q); resume it.
        if (quitting) app.quit()
        else if (!win.isDestroyed()) win.close()
      }
      // What was changed since the last version is kept as one. A slow disk
      // must not hold the window open for long, though.
      const kept = history?.flushAll() ?? Promise.resolve()
      void Promise.race([kept, new Promise((resolve) => setTimeout(resolve, 5000))]).then(finish, finish)
    }
    const settle = (saved: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ipcMain.removeListener(EVENTS.flushDone, onDone)
      if (saved || win.isDestroyed()) {
        proceed()
        return
      }
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['Close Anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Your latest changes could not be saved.',
        detail: 'If you close now, the changes that have not been written to disk are lost.'
      })
      if (choice === 0) {
        proceed()
      } else {
        closing = 'no'
        quitting = false
      }
    }
    const onDone = (e: Electron.IpcMainEvent, saved: unknown): void => {
      if (e.sender === win.webContents) settle(saved !== false)
    }
    ipcMain.on(EVENTS.flushDone, onDone)
    // A window that does not answer must not become impossible to close.
    const timer = setTimeout(() => settle(true), 2500)
    win.webContents.send(EVENTS.flushRequest)
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    // On macOS the app lives on without its window; nothing may keep running for it.
    compiler?.stopAll()
    watcher.stopAll()
  })

  if (DEV_URL) void win.loadURL(DEV_URL)
  else void win.loadURL(`${APP_ORIGIN}/index.html`)
}

// ------------------------------------------------------------ lifecycle

/** Removes staging folders that an interrupted import may have left behind. */
async function cleanLibrary(libraryPath: string): Promise<void> {
  try {
    for (const name of await fsp.readdir(libraryPath)) {
      if (name.startsWith('.import-')) {
        await fsp.rm(path.join(libraryPath, name), { recursive: true, force: true })
      }
    }
  } catch {
    /* the library folder is created on first use */
  }
}

async function bootstrap(): Promise<void> {
  const libraryDefault = process.env['UNDERLEAF_LIBRARY']
    ? path.resolve(process.env['UNDERLEAF_LIBRARY'])
    : path.join(app.getPath('documents'), 'Underleaf')
  settings = await SettingsStore.load(
    path.join(app.getPath('userData'), 'settings.json'),
    defaultSettings(libraryDefault)
  )
  if (process.env['UNDERLEAF_LIBRARY']) await settings.update({ libraryPath: libraryDefault })
  void cleanLibrary(settings.get().libraryPath)

  // Deleted files and projects go to the system trash. Tests set
  // UNDERLEAF_TRASH_DIR so that they collect in a folder of their own instead.
  const trashDir = process.env['UNDERLEAF_TRASH_DIR']
  const trash = async (target: string): Promise<void> => {
    if (!trashDir) return shell.trashItem(target)
    await fsp.mkdir(trashDir, { recursive: true })
    await fsp.rename(target, path.join(trashDir, `${Date.now()}-${path.basename(target)}`))
  }
  const versions = new HistoryManager({
    settings: () => settings.get().history,
    onChanged: (dir) => mainWindow?.webContents.send(EVENTS.historyChanged, { id: encodeProjectId(dir) })
  })
  history = versions
  const library = new ProjectLibrary({
    libraryPath: () => settings.get().libraryPath,
    externalProjects: () => settings.get().externalProjects,
    setExternalProjects: async (list) => {
      await settings.update({ externalProjects: list })
    },
    trash,
    // An archive that updates a project: the state before and the state it
    // brought are both versions, so what changed elsewhere can be looked at.
    beforeReplace: (dir, archive) => versions.saveAuto(dir, 'before-import', archive),
    afterReplace: (dir, archive) => versions.saveAuto(dir, 'after-import', archive)
  })

  const rc = resourcePath('latexmkrc')
  compiler = new CompileManager({
    cacheRoot: cacheRoot(),
    latexmkrc: (await isFile(rc)) ? rc : null,
    findTectonic,
    isOnline: () => net.isOnline(),
    onProgress: (projectDir, line, sticky) => {
      mainWindow?.webContents.send(EVENTS.compileProgress, {
        id: Buffer.from(path.resolve(projectDir), 'utf8').toString('base64url'),
        line,
        sticky
      })
    }
  })

  registerIpc({
    settings,
    library,
    compiler,
    analyzer: new ProjectAnalyzer(),
    watcher,
    history: versions,
    window: () => mainWindow,
    trustedOrigins: DEV_URL ? [`${APP_ORIGIN}/`, DEV_URL] : [`${APP_ORIGIN}/`],
    trash
  })

  registerAppProtocol()
  buildMenu()
  createWindow()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(bootstrap).catch((err) => {
    console.error(err)
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && settings) createWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    // The window may still call the quit off (unsaved changes), so nothing is
    // stopped here yet.
    quitting = true
  })

  app.on('will-quit', () => {
    compiler?.stopAll()
    watcher.stopAll()
  })

  // No part of the app needs to open additional windows or webviews.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}
