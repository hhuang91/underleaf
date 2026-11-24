// End-to-end smoke test: launches the built app with Playwright, walks through
// the main workflows and saves screenshots to tests/e2e/output.
//
//   npm run build && npm run test:e2e
//
// It never touches real user data: settings, library and cache live in a
// temporary folder, and a fake TeX engine (tests/fixtures/fake-tectonic.mjs)
// stands in for Tectonic so no TeX installation or network is needed.
// Set UNDERLEAF_E2E_REAL_ENGINE=1 to compile with the real engine instead.
// UNDERLEAF_E2E_RUN=<name> keeps the screenshots in output/<name>, so that
// several runs do not overwrite each other's.
// UNDERLEAF_E2E_SLOWDOWN=<factor> slows the app's window down, to reproduce
// failures that only show on a slow or busy machine.

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { startFakeLlm } from '../fixtures/fake-llm.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const run = process.env.UNDERLEAF_E2E_RUN ?? ''
// The folder is emptied below, so only a plain name inside output/ is accepted.
if (run && !/^[\w-]+$/.test(run)) throw new Error('UNDERLEAF_E2E_RUN must be a simple name (letters, digits, "-", "_")')
const shots = path.join(root, 'tests', 'e2e', 'output', run)
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'underleaf-e2e-'))
const library = path.join(tmp, 'Library')
const realEngine = process.env.UNDERLEAF_E2E_REAL_ENGINE === '1'
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

await fs.rm(shots, { recursive: true, force: true })
await fs.mkdir(shots, { recursive: true })

const env = {
  ...process.env,
  UNDERLEAF_USER_DATA: path.join(tmp, 'user-data'),
  UNDERLEAF_LIBRARY: library,
  UNDERLEAF_CACHE: path.join(tmp, 'cache')
}
if (!realEngine) env.UNDERLEAF_TECTONIC = path.join(root, 'tests', 'fixtures', 'fake-tectonic.mjs')
// Deleted items are collected in a folder of the temp dir rather than in the
// system recycle bin. Set UNDERLEAF_E2E_REAL_TRASH=1 to use the real one.
const trashDir = process.env.UNDERLEAF_E2E_REAL_TRASH === '1' ? null : path.join(tmp, 'trash')
if (trashDir) env.UNDERLEAF_TRASH_DIR = trashDir
delete env.ELECTRON_RUN_AS_NODE
// A stand-in for a model server (tests/fixtures/fake-llm.mjs). The app looks
// for servers on this computer only there, not at the usual ports, where a
// real one may be running.
const llm = await startFakeLlm()
env.UNDERLEAF_ASSISTANT_PROBES = `Test server=${llm.port}`

// UNDERLEAF_E2E_APP=<path to a packaged executable> tests a packaged build
// (for example dist/win-unpacked/Underleaf.exe) instead of the working tree.
const packaged = process.env.UNDERLEAF_E2E_APP
const app = await electron.launch(
  packaged ? { executablePath: path.resolve(packaged), args: [], env } : { args: [root], env }
)
const problems = []
let step = 0

async function shot(win, name) {
  step++
  await win.waitForTimeout(350) // let dialogs and menus finish their entrance animation
  await win.screenshot({ path: path.join(shots, `${String(step).padStart(2, '0')}-${name}.png`) })
}

/** Replaces native dialogs in the main process with canned answers. */
async function stubDialogs(answers) {
  await app.evaluate(({ dialog }, a) => {
    if (a.save !== undefined) dialog.showSaveDialog = async () => ({ canceled: a.save === null, filePath: a.save ?? '' })
    if (a.open !== undefined) {
      dialog.showOpenDialog = async () => ({ canceled: a.open === null, filePaths: a.open ? [a.open] : [] })
    }
  }, answers)
}

const compileTimeout = realEngine ? 600_000 : 30_000

async function waitForPdf(win) {
  await win.waitForSelector('.pdf-container:not(.pending) .page[data-loaded="true"]', { timeout: compileTimeout })
  await win.waitForFunction(() => !document.querySelector('.split-main')?.textContent?.includes('Compiling'), null, {
    timeout: compileTimeout
  })
}

/**
 * Waits until the editor shows the main document. The editor only renders the
 * lines around the part that is scrolled into view, so this must not look for
 * one particular line such as the first.
 */
async function waitForMainTex(win) {
  await win.waitForFunction(() => {
    const selected = document.querySelector('.tree-item.selected')?.textContent ?? ''
    const text = document.querySelector('.cm-content')?.textContent ?? ''
    return selected.includes('main.tex') && /\\(documentclass|begin|end|section|item)\b/.test(text)
  })
}

/** Polls a condition that lives outside the page (usually a file on disk). */
async function until(check, what, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const exists = (p) => fs.stat(p).then(() => true, () => false)

/** What is in a project folder, apart from the repository that holds its versions. */
const filesIn = async (dir) => (await fs.readdir(dir)).filter((name) => name !== '.git').sort()

/**
 * Waits until the editor has nothing left to write. It saves a moment after
 * the last key, and the indicator takes a moment to say so, so "Saved" only
 * counts once it has stayed for longer than that.
 */
async function waitForSaved(win) {
  const saved = () => document.querySelector('.save-indicator')?.textContent?.includes('Saved') === true
  for (;;) {
    await win.waitForFunction(saved)
    await win.waitForTimeout(700)
    if (await win.evaluate(saved)) return
  }
}

try {
  const win = await app.firstWindow()
  win.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`)
  })
  win.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`))

  // UNDERLEAF_E2E_SLOWDOWN=<factor> makes the app's window that many times
  // slower than this script. That brings out steps which act before the app
  // is ready for them, the way a slow or busy machine does.
  const slowdown = Number(process.env.UNDERLEAF_E2E_SLOWDOWN ?? 0)
  if (slowdown > 1) {
    const cdp = await win.context().newCDPSession(win)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: slowdown })
  }

  // ---------------------------------------------------- empty dashboard
  await win.waitForSelector('.dash-welcome')
  await shot(win, 'dashboard-empty')

  // ------------------------------------ licences are installed with the app
  const about = await app.evaluate(({ app: a, Menu }) => ({
    help: (Menu.getApplicationMenu()?.items.find((item) => item.role === 'help')?.submenu?.items ?? []).map(
      (item) => item.label
    ),
    resources: a.isPackaged ? process.resourcesPath : `${a.getAppPath()}/resources`,
    isPackaged: a.isPackaged
  }))
  assert.ok(about.help.includes('Open-Source Licenses'), 'the Help menu offers the licences')
  assert.match(await fs.readFile(path.join(about.resources, 'THIRD_PARTY_LICENSES.txt'), 'utf8'), /^react \d+\./m)
  if (about.isPackaged) {
    assert.match(await fs.readFile(path.join(about.resources, 'LICENSE.txt'), 'utf8'), /Apache License\s+Version 2\.0/)
    assert.match(await fs.readFile(path.join(about.resources, 'NOTICE.txt'), 'utf8'), /^Underleaf\r?\n/)
  }
  // The menu item hands that file to the system's viewer (replaced here, so
  // that the test does not leave a text editor open).
  const opened = await app.evaluate(async ({ Menu, shell }) => {
    const original = shell.openPath
    let target = null
    shell.openPath = async (file) => {
      target = file
      return ''
    }
    try {
      const help = Menu.getApplicationMenu()?.items.find((item) => item.role === 'help')
      help?.submenu?.items.find((item) => item.label === 'Open-Source Licenses')?.click()
      for (let i = 0; i < 50 && target === null; i++) await new Promise((resolve) => setTimeout(resolve, 100))
    } finally {
      shell.openPath = original
    }
    return target
  })
  assert.equal(path.resolve(opened ?? ''), path.resolve(about.resources, 'THIRD_PARTY_LICENSES.txt'))

  // --------------------------------------------- create example project
  await win.click('.dash-welcome >> text=Example Project')
  await win.fill('#prompt-input', 'Demo Paper')
  await shot(win, 'new-project-dialog')
  await win.click('.modal-footer >> text=Create')

  await win.waitForSelector('.ide .cm-content')
  await win.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('\\documentclass'))
  await waitForPdf(win)
  assert.equal(await win.locator('.tree-item').count() >= 3, true, 'file tree lists the project files')
  assert.match(await win.locator('.tree-item.selected').innerText(), /main\.tex/)
  assert.equal(await win.locator('.outline-item').count() >= 5, true, 'outline lists the sections')
  await shot(win, 'editor')

  const projectDir = path.join(library, 'Demo Paper')
  assert.deepEqual(await filesIn(projectDir), ['figures', 'main.tex', 'references.bib'])

  // ------------------------------------------------ typing is auto-saved
  await win.click('.cm-content')
  await win.keyboard.press(`${mod}+End`)
  await win.keyboard.type('\n% typed by the smoke test')
  const onDisk = async (file) => fs.readFile(path.join(projectDir, file), 'utf8').catch(() => '')
  await until(async () => (await onDisk('main.tex')).includes('% typed by the smoke test'), 'the typed text to be saved')

  // -------------------------------- autocomplete and \begin ... \end help
  await win.keyboard.type('\n\\begin{itemize}')
  await win.keyboard.press('Escape')
  await win.keyboard.press('Enter')
  await win.keyboard.type('first item')
  await until(
    async () => /\\begin\{itemize\}\n\s+\\item first item\n\\end\{itemize\}/.test(await onDisk('main.tex')),
    '\\end and \\item to be inserted, and the result to be saved'
  )

  await win.keyboard.press(`${mod}+End`)
  await win.keyboard.type('\n\\sec')
  await win.waitForSelector('.cm-tooltip-autocomplete')
  await shot(win, 'autocomplete')
  await win.keyboard.press('Escape')
  for (let i = 0; i < 5; i++) await win.keyboard.press('Backspace')
  // Let the editor write its own changes first: unsaved local edits
  // deliberately take precedence over a change made on disk.
  await waitForSaved(win)

  // ---------------------- an external edit shows up, then fails to compile
  const original = await fs.readFile(path.join(projectDir, 'main.tex'), 'utf8')
  assert.doesNotMatch(original, /\\sec\b/)
  // CodeMirror only renders the lines in view; look at the top of the file.
  await win.keyboard.press(`${mod}+Home`)
  const broken = original.replace('\\section{Introduction}', '\\section{Introduction}\nThis line has a \\badcommand in it.')
  assert.notEqual(broken, original)
  await fs.writeFile(path.join(projectDir, 'main.tex'), broken)
  await win.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('\\badcommand'), null, {
    timeout: 10_000
  })

  await win.click('.split-main')
  await win.waitForSelector('.pdf-tool .badge.error', { timeout: compileTimeout })
  await win.click('.pdf-tool:has(.badge)')
  await win.waitForSelector('.log-entry.error')
  assert.match(await win.locator('.log-entry.error .log-entry-title').first().innerText(), /Undefined control sequence/)
  await shot(win, 'logs')

  // Clicking the location jumps to the offending line and marks it.
  await win.click('.log-entry.error .log-entry-link')
  await win.waitForFunction(() => document.querySelector('.cm-activeLine')?.textContent?.includes('\\badcommand'))
  assert.equal(await win.locator('.cm-log-marker.error').count() >= 1, true, 'gutter marker for the error')
  await win.click('.pdf-tool:has(.badge)') // back to the PDF
  await shot(win, 'error-in-editor')

  // ------------------------------------------------- fix it and recompile
  await fs.writeFile(path.join(projectDir, 'main.tex'), original)
  await win.waitForFunction(() => !document.querySelector('.cm-content')?.textContent?.includes('\\badcommand'))
  await win.keyboard.press(`${mod}+Enter`)
  await win.waitForFunction(() => !document.querySelector('.pdf-tool .badge.error'), null, { timeout: compileTimeout })
  await waitForPdf(win)

  // ------------------------------- a missing file: one error, with advice
  await fs.writeFile(
    path.join(projectDir, 'main.tex'),
    original.replace('\\maketitle', '\\maketitle\n\\input{sections/does-not-exist}')
  )
  await win.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('does-not-exist'), null, {
    timeout: 10_000
  })
  await win.click('.split-main')
  await win.waitForSelector('.pdf-tool .badge.error', { timeout: compileTimeout })
  // Without a PDF the logs open by themselves; otherwise open them.
  if ((await win.locator('.logs-pane').count()) === 0) await win.click('.pdf-tool:has(.badge)')
  await win.waitForSelector('.log-entry-hint')
  assert.equal(await win.locator('.log-entry.error').count(), 1, 'one error, not the cascade that follows it')
  assert.match(await win.locator('.log-entry.error .log-entry-title').innerText(), /does-not-exist\.tex' not found/)
  assert.match(await win.locator('.log-entry-hint').innerText(), /name and the location of the file/)
  await shot(win, 'missing-file-advice')
  await fs.writeFile(path.join(projectDir, 'main.tex'), original)
  await win.waitForFunction(() => !document.querySelector('.cm-content')?.textContent?.includes('does-not-exist'))
  await win.keyboard.press(`${mod}+Enter`)
  await win.waitForFunction(() => !document.querySelector('.pdf-tool .badge.error'), null, { timeout: compileTimeout })
  if ((await win.locator('.logs-pane').count()) > 0) await win.click('.pdf-tool[title="Logs and output files"]')
  await waitForPdf(win)

  // ------------- an error in another file: its log entry leads to the line
  const chapter = Array.from({ length: 200 }, (_, i) => `Line ${i + 1} of the chapter.`)
  chapter[149] = 'Line 150 has a \\badcommand in it.'
  await fs.writeFile(path.join(projectDir, 'chapter.tex'), `${chapter.join('\n')}\n`)
  await fs.writeFile(path.join(projectDir, 'main.tex'), original.replace('\\maketitle', '\\maketitle\n\\input{chapter}'))
  await win.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('\\input{chapter}'), null, {
    timeout: 10_000
  })
  await win.click('.split-main')
  await win.waitForSelector('.pdf-tool .badge.error', { timeout: compileTimeout })
  if ((await win.locator('.logs-pane').count()) === 0) await win.click('.pdf-tool:has(.badge)')
  await win.click('.log-entry.error .log-entry-link')
  // The file opens with that line in view, not at its top.
  await win.waitForFunction(() => {
    const scroller = document.querySelector('.cm-scroller')?.getBoundingClientRect()
    const line = document.querySelector('.cm-activeLine')
    const box = line?.getBoundingClientRect()
    if (!scroller || !line || !box || !line.textContent?.includes('Line 150')) return false
    return box.top >= scroller.top && box.bottom <= scroller.bottom
  })
  assert.match(await win.locator('.tree-item.selected').innerText(), /chapter\.tex/)
  await win.click('.tree-item >> text=main.tex')
  await waitForMainTex(win)
  await fs.writeFile(path.join(projectDir, 'main.tex'), original)
  await fs.rm(path.join(projectDir, 'chapter.tex'))
  await win.waitForFunction(
    () => ![...document.querySelectorAll('.tree-item')].some((e) => e.textContent?.includes('chapter.tex')),
    null,
    { timeout: 10_000 }
  )
  await win.waitForFunction(() => !document.querySelector('.cm-content')?.textContent?.includes('\\input{chapter}'))
  await win.click('.split-main')
  await win.waitForFunction(() => !document.querySelector('.pdf-tool .badge.error'), null, { timeout: compileTimeout })
  if ((await win.locator('.logs-pane').count()) > 0) await win.click('.pdf-tool[title="Logs and output files"]')
  await waitForPdf(win)

  // ------------------------------------------------------------- SyncTeX
  // source -> PDF: put the cursor in a paragraph and press the arrow button.
  await win.click('.cm-line:has-text("Everything in this project")')
  await win.click('.sync-buttons button >> nth=0')
  const mark = await win.waitForSelector('.pdf-sync-highlight')
  const markBox = await mark.boundingBox()
  await shot(win, 'synctex')

  // PDF -> source: double-click the highlighted spot and land in that paragraph again.
  await win.keyboard.press(`${mod}+Home`)
  await win.mouse.dblclick(markBox.x + markBox.width / 3, markBox.y + markBox.height / 2)
  await win.waitForFunction(() =>
    /Everything in this project|compiled locally|you want to work online|upload it to Overleaf/.test(
      document.querySelector('.cm-activeLine')?.textContent ?? ''
    )
  )

  // ------------------------------------------------- new file, other files
  await win.click('.tree-toolbar button[title="New file"]')
  await win.fill('#prompt-input', 'notes.tex')
  await win.click('.modal-footer >> text=Create')
  // The new file opens with the cursor in it: typing needs no click. (Wait for
  // that, not just for the file to be listed, or the first key is typed while
  // the dialog still has the focus.)
  await win.waitForFunction(
    () =>
      document.querySelector('.tree-item.selected')?.textContent?.includes('notes.tex') &&
      !document.querySelector('.modal') &&
      document.querySelector('.cm-content')?.contains(document.activeElement)
  )
  await win.keyboard.type('Some notes')
  await until(async () => (await onDisk('notes.tex')) !== '', 'the new file to be saved')
  await waitForSaved(win)
  assert.equal(await onDisk('notes.tex'), 'Some notes')

  // Formatting tools that do not fit next to the others sit in a "More" menu.
  const visibleTools = await win.locator('.toolbar-item').evaluateAll(
    (items) => items.filter((item) => item.offsetTop === items[0].offsetTop).length
  )
  assert.equal(visibleTools < 11, true, 'at this window size some tools overflow')
  await win.click('.editor-toolbar button[title="More"]')
  assert.equal(await win.locator('.dropdown-item').count(), 11 - visibleTools, 'the menu lists exactly the hidden tools')
  await shot(win, 'toolbar-more')
  await win.click('.dropdown-item >> text=Numbered list')
  await win.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('\\begin{enumerate}'))
  await win.keyboard.press(`${mod}+z`)
  await win.waitForFunction(() => !document.querySelector('.cm-content')?.textContent?.includes('\\begin{enumerate}'))
  await waitForSaved(win)
  assert.equal(await onDisk('notes.tex'), 'Some notes')

  // Rename through the context menu, then find-and-replace in the editor.
  await win.click('.tree-item >> text=notes.tex', { button: 'right' })
  await shot(win, 'context-menu')
  await win.click('.dropdown-item >> text=Rename')
  await win.fill('.tree-rename', 'todo.tex')
  await win.keyboard.press('Enter')
  await win.waitForFunction(() => [...document.querySelectorAll('.tree-item')].some((e) => e.textContent?.includes('todo.tex')))
  assert.deepEqual(await filesIn(projectDir), ['figures', 'main.tex', 'references.bib', 'todo.tex'])
  await win.click('.cm-content')
  await win.keyboard.press(`${mod}+f`)
  await win.waitForSelector('.cm-search')
  await win.keyboard.type('notes')
  await shot(win, 'search')
  await win.keyboard.press('Escape')

  // ------------------------------------ a save that fails loses nothing
  const todo = path.join(projectDir, 'todo.tex')
  await fs.chmod(todo, 0o444) // read-only: writing it fails
  await win.click('.cm-content')
  await win.keyboard.press(`${mod}+End`)
  await win.keyboard.type(' that must not get lost')
  await win.waitForSelector('.save-indicator.error', { timeout: 20_000 })
  assert.equal(await fs.readFile(todo, 'utf8'), 'Some notes')
  // Opening another file is refused: the text exists nowhere but in the editor.
  await win.click('.tree-item >> text=main.tex')
  await win.waitForFunction(
    () => [...document.querySelectorAll('.toast.error')].some((t) => t.textContent?.includes('stays open')),
    null,
    { timeout: 20_000 }
  )
  assert.match(await win.locator('.tree-item.selected').innerText(), /todo\.tex/)
  assert.equal(
    await win.evaluate(() => document.querySelector('.cm-content')?.textContent?.includes('that must not get lost')),
    true
  )
  await shot(win, 'save-failed')
  // As soon as the file can be written again it is saved, without further action.
  await fs.chmod(todo, 0o666)
  await win.waitForFunction(() => document.querySelector('.save-indicator')?.textContent?.includes('Saved'), null, {
    timeout: 20_000
  })
  assert.equal(await fs.readFile(todo, 'utf8'), 'Some notes that must not get lost')

  // -------------------- a file in a legacy encoding is not rewritten unasked
  const legacy = path.join(projectDir, 'legacy.tex')
  await fs.writeFile(legacy, Buffer.from([0x63, 0x61, 0x66, 0xe9])) // "café" in Latin-1
  await win.waitForFunction(
    () => [...document.querySelectorAll('.tree-item')].some((e) => e.textContent?.includes('legacy.tex')),
    null,
    { timeout: 10_000 }
  )
  await win.click('.tree-item >> text=legacy.tex')
  await win.waitForSelector('.editor-notice >> text=Convert to UTF-8 and edit')
  await win.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('café'))
  await win.click('.cm-content')
  await win.keyboard.type('typed into a protected file')
  await win.waitForTimeout(1200)
  assert.deepEqual([...(await fs.readFile(legacy))], [0x63, 0x61, 0x66, 0xe9], 'the bytes on disk are untouched')
  assert.equal(await win.evaluate(() => document.querySelector('.cm-content')?.textContent?.includes('typed into')), false)
  await shot(win, 'legacy-encoding')
  await win.click('.editor-notice >> text=Convert to UTF-8 and edit')
  await until(async () => (await fs.readFile(legacy, 'utf8')) === 'café', 'the file to be saved as UTF-8')
  assert.equal(await win.locator('.editor-notice').count(), 0)
  // The open file can be deleted like any other.
  await win.click('.tree-toolbar button[title="Delete"]')
  await win.click('.modal-footer >> text=Delete')
  await until(async () => !(await exists(legacy)), 'legacy.tex to be deleted')
  await win.waitForSelector('text=No file selected')
  await win.click('.tree-item >> text=todo.tex')
  await win.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('Some notes'))

  // Upload a file from disk into the selected folder.
  const extra = path.join(tmp, 'extra-figure.png')
  await fs.copyFile(path.join(projectDir, 'figures', 'wave.png'), extra)
  await stubDialogs({ open: extra })
  await win.click('.tree-item >> text=figures')
  await win.click('.tree-toolbar button[title="Upload files"]')
  await win.waitForFunction(() =>
    [...document.querySelectorAll('.tree-item')].some((e) => e.textContent?.includes('extra-figure.png'))
  )
  assert.deepEqual((await fs.readdir(path.join(projectDir, 'figures'))).sort(), ['extra-figure.png', 'wave.png'])

  await win.click('.tree-item >> text=wave.png')
  await win.waitForSelector('.preview img')
  await shot(win, 'image-preview')
  await win.click('.tree-item >> text=references.bib')
  await win.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('@book'))
  await win.click('.tree-item >> text=main.tex')
  await waitForMainTex(win)

  // ------------------------------------------------------------ the menu
  await win.click('.toolbar-btn >> text=Menu')
  await win.waitForSelector('.drawer')
  await shot(win, 'menu')
  await win.click('.drawer-link >> text=Word Count')
  await win.waitForSelector('.word-count')
  assert.equal(Number((await win.locator('.word-count dd').first().innerText()).replace(/\D/g, '')) > 100, true)
  await win.click('.modal-footer >> text=Close')
  await win.selectOption('.menu-row:has-text("Overall theme") select', 'light')
  await win.selectOption('.menu-row:has-text("Editor theme") select', 'dracula')
  await win.click('.drawer-header .icon-btn')
  await shot(win, 'light-chrome-dark-editor')

  // Spell check is on for prose, off for commands.
  assert.equal(await win.getAttribute('.cm-content', 'spellcheck'), 'true')
  assert.equal(await win.locator('.cm-content [spellcheck="false"]').count() > 5, true, 'commands are excluded')

  // Vim key bindings are loaded on demand: "dd" in normal mode deletes a line.
  await win.click('.toolbar-btn >> text=Menu')
  await win.selectOption('.menu-row:has-text("Keybindings") select', 'vim')
  await win.selectOption('.menu-row:has-text("Overall theme") select', 'default')
  await win.selectOption('.menu-row:has-text("Editor theme") select', 'textmate')
  await win.click('.drawer-header .icon-btn')
  await win.waitForSelector('.cm-fat-cursor')
  await win.click('.cm-line:has-text("\\\\maketitle")')
  const beforeVim = await win.locator('.cm-lineNumbers .cm-gutterElement').count()
  await win.keyboard.type('dd')
  await win.waitForFunction(() => !document.querySelector('.cm-content')?.textContent?.includes('\\maketitle'))
  await win.keyboard.type('u') // undo
  await win.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('\\maketitle'))
  assert.equal(await win.locator('.cm-lineNumbers .cm-gutterElement').count(), beforeVim)
  await win.click('.toolbar-btn >> text=Menu')
  await win.selectOption('.menu-row:has-text("Keybindings") select', 'default')
  await win.click('.drawer-header .icon-btn')
  await win.waitForFunction(() => !document.querySelector('.cm-fat-cursor'))
  await waitForSaved(win)

  // ---------------------------------------------------- writing assistant
  // Off until it is turned on: nothing has been sent to any server so far.
  assert.equal(llm.requests.length, 0, 'no request before the assistant is turned on')
  assert.equal(await win.locator('.assistant-btn').count(), 0)
  await win.click('.toolbar-btn >> text=Menu')
  await win.click('.menu-row:has-text("Writing assistant") button')
  await win.waitForSelector('.assistant-settings')
  // Turned on with no address yet, it looks for a server on this computer and
  // takes the first one with a model (embedding models are not offered).
  await win.click('.assistant-settings .settings-toggle')
  await win.waitForFunction((url) => document.querySelector('#assistant-url')?.value === url, llm.url)
  await win.waitForFunction(() => document.querySelector('#assistant-model')?.value === 'fake-writer')
  assert.match(await win.locator('.assistant-found').innerText(), /Test server/)
  await win.click('.assistant-settings button:has-text("Test the connection")')
  await win.waitForSelector('.assistant-check.ok')
  assert.match(await win.locator('.assistant-check').innerText(), /fake-writer answered in/)
  // A server that wants an API key gets it; the key is not kept with the settings.
  llm.state.key = 'e2e-secret-key'
  await win.fill('#assistant-key', 'e2e-secret-key')
  await win.keyboard.press('Enter')
  await win.waitForSelector('.assistant-key-remove')
  await win.click('.assistant-settings button:has-text("Test the connection")')
  await win.waitForSelector('.assistant-check.ok')
  assert.equal(llm.requests.at(-1).headers.authorization, 'Bearer e2e-secret-key')
  // The key belongs to that server: with another address (here the same
  // server under another name) it is not sent.
  await win.fill('#assistant-url', `http://localhost:${llm.port}/v1`)
  await win.keyboard.press('Enter')
  await win.waitForSelector('text=It is not sent to this server.')
  await win.click('.assistant-settings button:has-text("Test the connection")')
  await win.waitForSelector('.assistant-check.failed')
  assert.equal(
    llm.requests.filter((r) => r.headers.host?.startsWith('localhost') && r.headers.authorization).length,
    0,
    'the key is not sent to another address'
  )
  await win.fill('#assistant-url', llm.url)
  await win.keyboard.press('Enter')
  await win.waitForFunction(() => !document.body.textContent?.includes('It is not sent to this server.'))
  await win.click('.assistant-settings button:has-text("Test the connection")')
  await win.waitForSelector('.assistant-check.ok')
  const userData = path.join(tmp, 'user-data')
  await until(async () => (await fs.readFile(path.join(userData, 'settings.json'), 'utf8')).includes(llm.url), 'the address to be saved')
  assert.equal((await fs.readFile(path.join(userData, 'settings.json'), 'utf8')).includes('e2e-secret-key'), false)
  assert.equal((await fs.readFile(path.join(userData, 'assistant-key.json'), 'utf8')).includes('e2e-secret-key'), false, 'the key is stored encrypted')
  await shot(win, 'assistant-settings')
  await win.click('.modal-footer >> text=Done')
  await win.click('.drawer-header .icon-btn')
  await win.waitForSelector('.assistant-btn')

  // A pause after typing brings a suggestion, in grey after the cursor; Tab takes it.
  const suggestion = () => document.querySelector('.cm-suggestion')?.textContent ?? null
  const editorText = () => document.querySelector('.cm-content')?.textContent ?? ''
  await win.click('.cm-content')
  await win.keyboard.press(`${mod}+End`)
  await win.keyboard.type('\nOur method is')
  await win.waitForFunction(suggestion)
  assert.equal(await win.evaluate(suggestion), ' faster than every method before it.')
  // The cursor is shown in front of the word being typed, which the request names.
  const asked = llm.chats().at(-1).body
  assert.match(asked.messages.at(-1).content, /Our method <CURSOR>[\s\S]*the writer has typed "is" so far/)
  await shot(win, 'suggestion')
  await win.keyboard.press('Tab')
  await win.waitForFunction(() => !document.querySelector('.cm-suggestion'))
  assert.match(await win.evaluate(editorText), /Our method is faster than every method before it\./)
  // Typing what it says keeps the rest; Escape lets it go.
  await win.keyboard.type('\nThe results are summarised in')
  await win.waitForFunction(suggestion)
  await win.keyboard.type(' T')
  await win.waitForFunction(() => document.querySelector('.cm-suggestion')?.textContent === 'able 1.')
  await win.keyboard.press('Escape')
  await win.waitForFunction(() => !document.querySelector('.cm-suggestion'))
  assert.match(await win.evaluate(editorText), /The results are summarised in T(?!able)/)

  // Only on request: no suggestion after a pause, one on Alt+\.
  await win.click('.assistant-btn')
  await win.click('.dropdown-item >> text=Suggest after a pause in typing')
  await win.click('.cm-content')
  await win.keyboard.press(`${mod}+End`)
  const chatsBefore = llm.chats().length
  await win.keyboard.type('\nOur method is')
  await win.waitForTimeout(1500)
  assert.equal(llm.chats().length, chatsBefore, 'no suggestion is asked for after a pause')
  await win.keyboard.press('Alt+\\')
  await win.waitForFunction(suggestion)
  await win.keyboard.press('Tab')
  await win.waitForFunction(() => !document.querySelector('.cm-suggestion'))
  await win.click('.assistant-btn')
  await win.click('.dropdown-item >> text=Suggest after a pause in typing')
  await win.click('.cm-content')

  // In Vim's insert mode, Tab takes a suggestion as well.
  await win.click('.toolbar-btn >> text=Menu')
  await win.selectOption('.menu-row:has-text("Keybindings") select', 'vim')
  await win.click('.drawer-header .icon-btn')
  await win.waitForSelector('.cm-fat-cursor')
  await win.click('.cm-content')
  await win.keyboard.press('Escape')
  await win.keyboard.type('Go')
  await win.keyboard.type('Our method is')
  await win.waitForFunction(suggestion)
  await win.keyboard.press('Tab')
  await win.waitForFunction(() => !document.querySelector('.cm-suggestion'))
  await win.keyboard.press('Escape')
  await win.waitForSelector('.cm-fat-cursor')
  assert.equal((await win.evaluate(editorText)).match(/Our method is faster than every method before it\./g)?.length, 3)
  await win.click('.toolbar-btn >> text=Menu')
  await win.selectOption('.menu-row:has-text("Keybindings") select', 'default')
  await win.click('.drawer-header .icon-btn')
  await win.waitForFunction(() => !document.querySelector('.cm-fat-cursor'))

  // Proofreading: the corrections are shown in the passage, each can be kept
  // or rejected, and applying them is one step that Undo takes back.
  await win.click('.cm-content')
  await win.keyboard.press(`${mod}+End`)
  await win.keyboard.type('\n\nWe recieve teh data, wich is noisy.')
  await win.keyboard.press('Escape') // a suggestion may have come up
  await win.keyboard.press('Home')
  await win.keyboard.press('Shift+End')
  await win.keyboard.press(`${mod}+Shift+P`)
  await win.waitForFunction(() => document.querySelectorAll('.proofread-passage .correction').length === 3)
  assert.equal(llm.chats().at(-1).body.messages.at(-1).content, 'We recieve teh data, wich is noisy.')
  await win.locator('.proofread-passage .correction').nth(1).click() // keep "teh"
  await shot(win, 'proofread')
  await win.click('.modal-footer >> text=Apply 2 of 3')
  await win.waitForFunction(() => !document.querySelector('.proofread-passage'))
  await win.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('We receive teh data, which is noisy.'))
  await until(async () => (await onDisk('main.tex')).includes('We receive teh data, which is noisy.'), 'the corrected passage to be saved')
  await win.keyboard.press(`${mod}+z`)
  await win.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('We recieve teh data, wich is noisy.'))

  // A failure is reported when the suggestion was asked for.
  llm.state.fail = { status: 500, body: { error: { message: 'out of memory' } } }
  await win.keyboard.press('End')
  await win.keyboard.press('Alt+\\')
  await win.waitForFunction(() =>
    [...document.querySelectorAll('.toast.error')].some((t) => t.textContent?.includes('ran into a problem (500): out of memory'))
  )
  await win.waitForSelector('.assistant-btn.error')

  // Turned off, it sends nothing at all.
  await win.click('.toolbar-btn >> text=Menu')
  await win.click('.menu-row:has-text("Writing assistant") button')
  await win.click('.assistant-settings .settings-toggle')
  await win.waitForFunction(() => !document.querySelector('.assistant-settings .settings-toggle input')?.checked)
  await win.click('.modal-footer >> text=Done')
  await win.click('.drawer-header .icon-btn')
  await win.waitForFunction(() => !document.querySelector('.assistant-btn'))
  const requestsBefore = llm.requests.length
  await win.click('.cm-content')
  await win.keyboard.press(`${mod}+End`)
  await win.keyboard.type('\nOur method is')
  await win.waitForTimeout(1500)
  await win.keyboard.press(`${mod}+Shift+P`)
  await win.waitForTimeout(300)
  assert.equal(llm.requests.length, requestsBefore, 'nothing is sent while the assistant is off')
  assert.equal(await win.locator('.proofread-passage').count(), 0)
  // Back to where the steps below expect the cursor: on \maketitle.
  await win.keyboard.press(`${mod}+Home`)
  await win.click('.cm-line:has-text("\\\\maketitle")')
  await waitForSaved(win)

  // ------------------------------------------------ per-project settings
  // The compiler and the main document are stored next to the project's files.
  const readMeta = async () =>
    JSON.parse(await fs.readFile(path.join(projectDir, '.underleaf.json'), 'utf8').catch(() => '{}'))
  await win.click('.toolbar-btn >> text=Menu')
  await win.selectOption('.menu-row:has-text("Compiler") select', 'xelatex')
  await until(async () => (await readMeta()).compiler === 'xelatex', 'the compiler choice to be saved')
  await win.selectOption('.menu-row:has-text("Compiler") select', 'pdflatex')
  await until(async () => (await readMeta()).compiler === 'pdflatex', 'the compiler choice to be saved')
  await win.click('.drawer-header .icon-btn')

  // "Set as main document" in a file's context menu; back to automatic in the menu.
  await win.click('.tree-item >> text=todo.tex', { button: 'right' })
  await win.click('.dropdown-item >> text=Set as main document')
  await until(async () => (await readMeta()).rootDoc === 'todo.tex', 'the main document to be saved')
  await win.waitForSelector('.tree-item:has-text("todo.tex") .tree-badge')
  await win.click('.toolbar-btn >> text=Menu')
  assert.equal(await win.inputValue('.menu-row:has-text("Main document") select'), 'todo.tex')
  await win.selectOption('.menu-row:has-text("Main document") select', '')
  await until(async () => (await readMeta()).rootDoc === undefined, 'the main document to be reset')
  await win.click('.drawer-header .icon-btn')
  await win.waitForSelector('.tree-item:has-text("main.tex") .tree-badge')

  // ------------------------------------- move and delete files in the tree
  await win.dragAndDrop('.tree-item:has-text("todo.tex")', '.tree-item:has-text("figures")')
  await until(() => exists(path.join(projectDir, 'figures', 'todo.tex')), 'todo.tex to be moved into figures')
  assert.equal(await exists(path.join(projectDir, 'todo.tex')), false)
  // ... and back to the top level by dropping it on the empty part of the panel.
  const treeBox = await win.locator('.tree-scroll').boundingBox()
  await win.dragAndDrop('.tree-item:has-text("todo.tex")', '.tree-scroll', {
    targetPosition: { x: treeBox.width / 2, y: treeBox.height - 24 }
  })
  await until(() => exists(path.join(projectDir, 'todo.tex')), 'todo.tex to be moved back to the top level')
  assert.equal(await exists(path.join(projectDir, 'figures', 'todo.tex')), false)

  // The editor is hidden while a picture is shown. Leave the main document
  // scrolled down, look at a picture, delete it, and come back.
  await win.evaluate(() => {
    document.querySelector('.cm-scroller').scrollTop = 420
  })
  await win.waitForTimeout(300)
  const leftAt = await win.evaluate(() => Math.round(document.querySelector('.cm-scroller').scrollTop))
  assert.equal(leftAt > 100, true, 'the main document is long enough to scroll')
  await win.click('.tree-item >> text=extra-figure.png')
  await win.waitForSelector('.preview img')
  await win.click('.tree-toolbar button[title="Delete"]')
  await win.click('.modal-footer >> text=Delete')
  await until(async () => !(await exists(path.join(projectDir, 'figures', 'extra-figure.png'))), 'the file to be deleted')
  await win.waitForFunction(
    () => ![...document.querySelectorAll('.tree-item')].some((e) => e.textContent?.includes('extra-figure.png'))
  )
  await win.waitForSelector('text=No file selected')
  await win.click('.tree-item >> text=main.tex')
  await waitForMainTex(win)
  // The document is where it was left: same scroll position, same cursor.
  await win.waitForFunction(
    (top) => Math.abs((document.querySelector('.cm-scroller')?.scrollTop ?? -1) - top) <= 2,
    leftAt
  )
  assert.match(await win.locator('.cm-activeLine').innerText(), /\\maketitle/)

  // ---------------------------------------------------------- auto compile
  await win.click('.split-caret')
  await win.click('.dropdown-item >> text="On"')
  await win.click('.cm-line:has-text("\\\\maketitle")')
  await win.keyboard.press('End')
  await win.keyboard.press('Enter')
  await win.keyboard.type('Autocompiled sentence.')
  await win.waitForFunction(
    () =>
      [...document.querySelectorAll('.pdf-container:not(.pending) .textLayer')].some((layer) =>
        layer.textContent?.includes('Autocompiled')
      ),
    null,
    { timeout: compileTimeout }
  )
  await win.click('.split-caret')
  await win.click('.dropdown-item >> text="Off"')

  // -------------------------------------------------- clear cached files
  await win.click('.pdf-tool[title="Logs and output files"]')
  await win.click('.logs-actions >> text=Clear cached files')
  await win.waitForFunction(() =>
    [...document.querySelectorAll('.toast')].some((t) => t.textContent?.includes('Cached files cleared'))
  )
  await win.waitForFunction(() => !document.querySelector('.split-main')?.textContent?.includes('Compiling'), null, {
    timeout: compileTimeout
  })
  await win.waitForSelector('.logs-summary.ok')
  await win.click('.pdf-tool[title="Logs and output files"]')
  await waitForPdf(win)

  // --------------------------------------------------------------- layout
  await win.click('.toolbar-btn >> text=Layout')
  await win.click('.dropdown-item >> text=PDF only')
  await win.waitForFunction(() => getComputedStyle(document.querySelector('.ide-editor')).display === 'none')
  await shot(win, 'layout-pdf-only')

  // A compile that finishes while the PDF is out of sight: the new document
  // waits there and is in place when the pane comes back. (The viewer must
  // not try to position a page that has no size; it logs an error if it does,
  // which the check at the end of this test would catch.)
  await win.click('.toolbar-btn >> text=Layout')
  await win.click('.dropdown-item >> text=Editor only')
  await win.waitForFunction(() => getComputedStyle(document.querySelector('.ide-pdf')).display === 'none')
  const newestPdf = async (dir = path.join(tmp, 'cache')) => {
    let newest = 0
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) newest = Math.max(newest, await newestPdf(full))
      else if (entry.name.endsWith('.pdf')) newest = Math.max(newest, (await fs.stat(full)).mtimeMs)
    }
    return newest
  }
  const pdfBefore = await newestPdf()
  await win.click('.cm-content')
  await win.keyboard.press(`${mod}+Enter`)
  await until(async () => (await newestPdf()) > pdfBefore, 'the compile to write a new PDF', compileTimeout)
  await win.waitForFunction(() => !document.querySelector('.split-main')?.textContent?.includes('Compiling'), null, {
    timeout: compileTimeout
  })
  await win.waitForTimeout(1200) // long enough for the hidden pane to have loaded it
  await win.click('.toolbar-btn >> text=Layout')
  await win.click('.dropdown-item >> text=Editor & PDF')
  await waitForPdf(win)

  // ------------------------------------------------------------- versions
  // Save the project as it is under a name ...
  await win.click('.toolbar-btn >> text=Menu')
  await win.click('.drawer-link >> text=Save Version')
  await win.fill('#prompt-input', 'Before the rewrite')
  await win.click('.modal-footer >> text=Save')
  await win.waitForFunction(() =>
    [...document.querySelectorAll('.toast.success')].some((t) => t.textContent?.includes('Before the rewrite'))
  )
  const beforeRewrite = await onDisk('main.tex')

  // ... change it ...
  await win.click('.cm-content')
  await win.keyboard.press(`${mod}+End`)
  await win.keyboard.type('\n% a line that the history test adds')
  await until(async () => (await onDisk('main.tex')).includes('% a line that the history test adds'), 'the new line to be saved')
  await fs.writeFile(path.join(projectDir, 'scratch.tex'), 'A file that the version does not have.\n')
  await win.waitForFunction(
    () => [...document.querySelectorAll('.tree-item')].some((e) => e.textContent?.includes('scratch.tex')),
    null,
    { timeout: 10_000 }
  )

  // ... and look at the history: newest first, down to how the project was when it was first opened.
  await win.click('.toolbar-btn >> text=History')
  await win.waitForSelector('.history .version.selected')
  const versionLabels = await win.locator('.version-label').allInnerTexts()
  assert.equal(versionLabels[0], 'Before the rewrite')
  assert.equal(versionLabels[versionLabels.length - 1], 'First version')

  // What has changed since that version: one file edited, one new.
  const changeList = async () => (await win.locator('.change').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())
  await win.click('.history-compare >> text=Since this version')
  await win.waitForFunction(() => document.querySelectorAll('.change').length === 2)
  assert.deepEqual(await changeList(), ['main.tex edited', 'scratch.tex new'])
  await win.click('.change >> text=main.tex')
  await win.waitForFunction(() =>
    [...document.querySelectorAll('.history-text .cm-insertedLine, .history-text .cm-changedLine')].some((line) =>
      line.textContent?.includes('a line that the history test adds')
    )
  )
  await shot(win, 'history')

  // Going back to the version undoes both, in the folder and in the editor.
  await win.click('.history-timeline footer >> text=Restore this version')
  await win.click('.modal-footer >> text=Restore')
  await win.waitForFunction(() => !document.querySelector('.history'))
  await until(async () => (await onDisk('main.tex')) === beforeRewrite, 'main.tex to be put back')
  assert.equal(await exists(path.join(projectDir, 'scratch.tex')), false)
  await win.waitForFunction(
    () => ![...document.querySelectorAll('.tree-item')].some((e) => e.textContent?.includes('scratch.tex')),
    null,
    { timeout: 10_000 }
  )
  await waitForMainTex(win)

  // What the restore replaced is a version as well, and one file of it can be taken back by itself.
  await win.click('.toolbar-btn >> text=History')
  await win.waitForSelector('.history .version.selected')
  assert.equal(await win.locator('.version-label').first().innerText(), 'Before restoring an earlier version')
  await win.waitForFunction(() => document.querySelectorAll('.change').length === 2)
  assert.deepEqual(await changeList(), ['main.tex edited', 'scratch.tex new'])
  await win.click('.change >> text=scratch.tex')
  await win.waitForFunction(() => document.querySelector('.history-text .cm-content')?.textContent?.includes('does not have'))
  await win.click('.history-diff-header >> text=Restore this file')
  await win.click('.modal-footer >> text=Restore')
  await until(() => exists(path.join(projectDir, 'scratch.tex')), 'scratch.tex to be put back')
  assert.equal(await onDisk('scratch.tex'), 'A file that the version does not have.\n')
  assert.equal(await onDisk('main.tex'), beforeRewrite, 'the rest of the project stays as it is')
  await win.click('.history-diff-header >> text=Back to editor')
  await win.waitForFunction(() => !document.querySelector('.history'))
  await waitForMainTex(win)

  // A restore does not replace a file that no version is kept of (here: one
  // that git is told to ignore, so that the copy made before would not have
  // it), and says so.
  await fs.writeFile(path.join(projectDir, '.gitignore'), 'scratch.tex\n')
  await fs.writeFile(path.join(projectDir, 'scratch.tex'), 'Private notes that are in no version.\n')
  await win.click('.toolbar-btn >> text=History')
  await win.waitForSelector('.history .version.selected')
  // The older of the two copies is the one that has scratch.tex.
  await win.locator('.version:has-text("Before restoring an earlier version")').nth(1).click()
  await win.waitForFunction(() =>
    [...document.querySelectorAll('.change')].some((c) => c.textContent?.includes('scratch.tex'))
  )
  await win.click('.history-timeline footer >> text=Restore this version')
  await win.click('.modal-footer >> text=Restore')
  await win.waitForSelector('.modal[aria-label="Not everything was restored"]')
  const report = await win.locator('.modal').innerText()
  assert.match(report, /scratch\.tex/)
  assert.match(report, /keeps no versions of what is there now/)
  await shot(win, 'history-report')
  await win.click('.modal-footer >> text=Close')
  await win.waitForFunction(() => !document.querySelector('.modal'))
  assert.equal(await onDisk('scratch.tex'), 'Private notes that are in no version.\n')
  assert.match(await onDisk('main.tex'), /a line that the history test adds/, 'the files that versions are kept of are restored')
  assert.equal(await exists(path.join(projectDir, '.gitignore')), false)
  // Back to the named version once more. Nothing is in the way this time
  // (the notes are no longer ignored, so the copy made before has them).
  await win.click('.version >> text=Before the rewrite')
  await win.waitForFunction(() => document.querySelector('.version.selected')?.textContent?.includes('Before the rewrite'))
  await win.click('.history-timeline footer >> text=Restore this version')
  await win.click('.modal-footer >> text=Restore')
  await win.waitForFunction(() => !document.querySelector('.history'))
  await until(async () => (await onDisk('main.tex')) === beforeRewrite, 'main.tex to be put back again')
  assert.equal(await exists(path.join(projectDir, 'scratch.tex')), false)
  await waitForMainTex(win)

  // The versions are a git repository in the project folder, which is not listed among its files.
  assert.equal(await exists(path.join(projectDir, '.git', 'HEAD')), true)
  assert.equal(await win.locator('.tree-item:has-text(".git")').count(), 0)
  await fs.rm(path.join(projectDir, 'scratch.tex'), { force: true })
  await win.waitForFunction(
    () => ![...document.querySelectorAll('.tree-item')].some((e) => e.textContent?.includes('scratch.tex')),
    null,
    { timeout: 10_000 }
  )
  await waitForPdf(win)

  // -------------------------------------------- download zip and the PDF
  const zipPath = path.join(tmp, 'Demo Paper.zip')
  const pdfPath = path.join(tmp, 'Demo Paper.pdf')
  await stubDialogs({ save: pdfPath })
  await win.click('.pdf-tool[title="Download PDF"]')
  await win.waitForSelector('.toast.success')
  assert.equal((await fs.readFile(pdfPath)).subarray(0, 5).toString(), '%PDF-')

  // ------------------------------------------------- back to the dashboard
  await win.click('.toolbar-btn[title="Back to your projects"]')
  await win.waitForSelector('.dash-table')
  assert.match(await win.locator('.project-link').first().innerText(), /Demo Paper/)
  await shot(win, 'dashboard')
  await win.click('.dash-nav-btn')
  await win.waitForSelector('.settings-section')
  await shot(win, 'settings')
  await win.click('.modal-footer >> text=Done')

  // Searching filters the list; a project can be copied and deleted from here.
  await win.fill('.dash-search input', 'no such project')
  await win.waitForSelector('.dash-no-match')
  await win.fill('.dash-search input', 'demo')
  await win.waitForFunction(() => document.querySelectorAll('.project-link').length === 1)
  await win.fill('.dash-search input', '')
  await win.click('.row-actions button[title="Make a copy"]')
  await win.click('.modal-footer >> text=Copy')
  await win.waitForFunction(() => document.querySelectorAll('.project-link').length === 2)
  assert.deepEqual(
    await filesIn(path.join(library, 'Demo Paper (Copy)')),
    ['.underleaf.json', 'figures', 'main.tex', 'references.bib', 'todo.tex']
  )
  await win.click('tr:has-text("Demo Paper (Copy)") .row-actions button >> nth=4')
  await win.click('.modal-footer >> text=Delete')
  await win.waitForFunction(() => document.querySelectorAll('.project-link').length === 1)
  assert.equal(await exists(path.join(library, 'Demo Paper (Copy)')), false)

  await stubDialogs({ save: zipPath })
  await win.click('.row-actions button[title^="Download .zip"]')
  await win.waitForFunction(() => [...document.querySelectorAll('.toast.success')].some((t) => t.textContent?.includes('.zip')))
  assert.equal((await fs.stat(zipPath)).size > 1000, true, 'zip was written')

  // ----------------------- upload the same zip again: conflict, keep both
  await stubDialogs({ open: zipPath })
  await win.click('.dash-new button')
  await win.click('.dropdown-item >> text=Upload Project')
  await win.click('.upload-zone button')
  await win.waitForSelector('text=This project already exists')
  await shot(win, 'import-conflict')
  await win.click('.modal-footer >> text=Keep both')
  await win.waitForSelector('.ide .cm-content')
  await win.waitForFunction(() => document.querySelector('.project-name')?.textContent?.includes('Demo Paper (1)'))
  await waitForPdf(win)
  assert.deepEqual(await filesIn(path.join(library, 'Demo Paper (1)')), ['figures', 'main.tex', 'references.bib', 'todo.tex'])

  // ------------------------------------ rename the project from the editor
  await win.click('.project-name')
  await win.fill('.project-name-input', 'Renamed Paper')
  await win.keyboard.press('Enter')
  await win.waitForFunction(() => document.querySelector('.project-name')?.textContent?.includes('Renamed Paper'))
  await waitForMainTex(win)
  assert.equal((await fs.readdir(library)).sort().join(','), 'Demo Paper,Renamed Paper')
  // The editor followed the folder: what is typed now is saved under the new
  // name, and the old folder does not come back.
  await win.click('.cm-content')
  await win.keyboard.press(`${mod}+End`)
  await win.keyboard.type('\n% typed after the rename')
  await until(
    async () => (await fs.readFile(path.join(library, 'Renamed Paper', 'main.tex'), 'utf8')).includes('% typed after the rename'),
    'the edit to be saved in the renamed folder'
  )
  assert.equal((await fs.readdir(library)).sort().join(','), 'Demo Paper,Renamed Paper')
  await waitForPdf(win)
  assert.equal(await win.locator('.split-main').innerText(), 'Recompile', 'the compile button is usable again')

  // ------------------------- update the first project from the zip in place
  await win.click('.toolbar-btn[title="Back to your projects"]')
  await win.waitForSelector('.dash-table')
  await fs.writeFile(path.join(projectDir, 'local-only.tex'), 'will be replaced')
  await win.click('.dash-new button')
  await win.click('.dropdown-item >> text=Upload Project')
  await win.click('.upload-zone button')
  await win.waitForSelector('text=This project already exists')
  await win.click('.modal-footer >> text=Update existing project')
  await win.waitForSelector('.ide .cm-content')
  await win.waitForFunction(() => document.querySelector('.project-name')?.textContent?.trim().startsWith('Demo Paper'))
  // The files come from the archive; the project's own settings are kept.
  assert.deepEqual(
    await filesIn(projectDir),
    ['.underleaf.json', 'figures', 'main.tex', 'references.bib', 'todo.tex']
  )
  assert.equal((await readMeta()).compiler, 'pdflatex')
  await waitForPdf(win)
  // The history has both sides of the update, so what the archive changed can
  // be looked at: here, the file that only existed locally is gone.
  await win.click('.toolbar-btn >> text=History')
  await win.waitForSelector('.history .version.selected')
  const afterUpdate = await win.locator('.version-label').allInnerTexts()
  assert.deepEqual(afterUpdate.slice(0, 2), ['Updated from Demo Paper.zip', 'Before updating from Demo Paper.zip'])
  await win.waitForFunction(() => document.querySelectorAll('.change').length === 1)
  assert.deepEqual(await changeList(), ['local-only.tex deleted'])
  await win.click('.history-diff-header >> text=Back to editor')
  await win.waitForFunction(() => !document.querySelector('.history'))

  // ------------------------------------------------------ delete a project
  await win.click('.toolbar-btn[title="Back to your projects"]')
  await win.waitForSelector('.dash-table')
  assert.equal(await win.locator('.project-link').count(), 2)
  await win.click('tr:has-text("Renamed Paper") .row-actions button >> nth=4')
  await win.click('.modal-footer >> text=Delete')
  await win.waitForFunction(() => document.querySelectorAll('.project-link').length === 1)
  await shot(win, 'dashboard-final')

  // Everything that was "deleted" along the way is recoverable from the trash.
  if (trashDir) {
    const trashed = await fs.readdir(trashDir)
    const names = trashed.map((n) => n.replace(/^\d+-/, '')).sort()
    assert.deepEqual(
      names.filter((n) => !n.startsWith('Demo Paper (replaced ')),
      ['Demo Paper (Copy)', 'Renamed Paper', 'extra-figure.png', 'legacy.tex']
    )
    const replaced = trashed.find((n) => n.includes('Demo Paper (replaced '))
    assert.ok(replaced, 'the files replaced by the import were moved to the trash')
    assert.equal(await fs.readFile(path.join(trashDir, replaced, 'local-only.tex'), 'utf8'), 'will be replaced')
  }

  assert.deepEqual(problems, [], 'no errors were logged by the renderer')
  console.log(`Smoke test passed (${step} screenshots in ${path.relative(root, shots)})`)
} catch (err) {
  try {
    const win = app.windows()[0]
    if (win) await win.screenshot({ path: path.join(shots, 'FAILED.png') })
  } catch {
    /* the window is gone */
  }
  console.error(problems.join('\n'))
  throw err
} finally {
  await app.close().catch(() => undefined)
  await llm.close().catch(() => undefined)
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
}
