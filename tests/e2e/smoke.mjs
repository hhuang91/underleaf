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

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

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

try {
  const win = await app.firstWindow()
  win.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`)
  })
  win.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`))

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
  assert.deepEqual((await fs.readdir(projectDir)).sort(), ['figures', 'main.tex', 'references.bib'])

  // ------------------------------------------------ typing is auto-saved
  await win.click('.cm-content')
  await win.keyboard.press(`${mod}+End`)
  await win.keyboard.type('\n% typed by the smoke test')
  await win.waitForFunction(() => document.querySelector('.save-indicator')?.textContent?.includes('Saved'))
  await win.waitForTimeout(700)
  assert.match(await fs.readFile(path.join(projectDir, 'main.tex'), 'utf8'), /% typed by the smoke test/)

  // -------------------------------- autocomplete and \begin ... \end help
  await win.keyboard.type('\n\\begin{itemize}')
  await win.keyboard.press('Escape')
  await win.keyboard.press('Enter')
  await win.keyboard.type('first item')
  await win.waitForTimeout(700)
  const typed = await fs.readFile(path.join(projectDir, 'main.tex'), 'utf8')
  assert.match(typed, /\\begin\{itemize\}\n\s+\\item first item\n\\end\{itemize\}/, '\\end and \\item are inserted')

  await win.keyboard.press(`${mod}+End`)
  await win.keyboard.type('\n\\sec')
  await win.waitForSelector('.cm-tooltip-autocomplete')
  await shot(win, 'autocomplete')
  await win.keyboard.press('Escape')
  for (let i = 0; i < 5; i++) await win.keyboard.press('Backspace')
  // Let the editor write its own changes first: unsaved local edits
  // deliberately take precedence over a change made on disk.
  await win.waitForFunction(() => document.querySelector('.save-indicator')?.textContent?.includes('Saved'))
  await win.waitForTimeout(700)

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
  await win.waitForFunction(() => document.querySelector('.tree-item.selected')?.textContent?.includes('notes.tex'))
  await win.keyboard.type('Some notes')
  await win.waitForTimeout(800)
  assert.equal(await fs.readFile(path.join(projectDir, 'notes.tex'), 'utf8'), 'Some notes')

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
  await win.waitForFunction(() => document.querySelector('.save-indicator')?.textContent?.includes('Saved'))
  await win.waitForTimeout(700)
  assert.equal(await fs.readFile(path.join(projectDir, 'notes.tex'), 'utf8'), 'Some notes')

  // Rename through the context menu, then find-and-replace in the editor.
  await win.click('.tree-item >> text=notes.tex', { button: 'right' })
  await shot(win, 'context-menu')
  await win.click('.dropdown-item >> text=Rename')
  await win.fill('.tree-rename', 'todo.tex')
  await win.keyboard.press('Enter')
  await win.waitForFunction(() => [...document.querySelectorAll('.tree-item')].some((e) => e.textContent?.includes('todo.tex')))
  assert.deepEqual((await fs.readdir(projectDir)).sort(), ['figures', 'main.tex', 'references.bib', 'todo.tex'])
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
  await win.waitForFunction(() => document.querySelector('.save-indicator')?.textContent?.includes('Saved'))
  await win.waitForTimeout(700)

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
  await win.click('.toolbar-btn >> text=Layout')
  await win.click('.dropdown-item >> text=Editor & PDF')

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
    (await fs.readdir(path.join(library, 'Demo Paper (Copy)'))).sort(),
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
  assert.deepEqual((await fs.readdir(path.join(library, 'Demo Paper (1)'))).sort(), ['figures', 'main.tex', 'references.bib', 'todo.tex'])

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
    (await fs.readdir(projectDir)).sort(),
    ['.underleaf.json', 'figures', 'main.tex', 'references.bib', 'todo.tex']
  )
  assert.equal((await readMeta()).compiler, 'pdflatex')
  await waitForPdf(win)

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
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
}
