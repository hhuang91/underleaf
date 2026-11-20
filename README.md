# Underleaf

A local LaTeX editor that works the way Overleaf does: file tree on the left,
source in the middle, PDF on the right, a green **Recompile** button. Projects
are ordinary folders on your computer, everything compiles offline, and a
project moves between Overleaf and Underleaf as a `.zip` file in either
direction.

It ships as a double-clickable app for Windows and macOS with a TeX engine
built in, so nothing else has to be installed.

> Underleaf is an independent project and is not affiliated with Overleaf.

## Moving between Overleaf and Underleaf

**Overleaf → Underleaf**

1. In Overleaf, open the project and choose **Menu → Download → Source**.
2. In Underleaf, choose **New Project → Upload Project** and pick the `.zip`,
   or drop the `.zip` anywhere on the project list.

The main document is detected the same way Overleaf does it (the `.tex` file
with `\documentclass`, preferring `main.tex`). Overleaf archives do not record
the compiler, so Underleaf picks one from the source (`% !TEX program = …`, a
`latexmkrc`, or packages such as `fontspec`); you can change it under
**Menu → Settings → Compiler**.

**Underleaf → Overleaf**

1. Click the download icon next to a project (or **Menu → Download → Source**
   inside the editor).
2. In Overleaf, choose **New Project → Upload Project** and pick that `.zip`.

The archive contains only your sources: no build files, no editor settings, no
`.git` folder.

**Going back and forth.** When you upload a `.zip` whose name matches a project
you already have, Underleaf asks whether to **update the existing project** or
**keep both**. Updating replaces the files in place, keeps the project's
settings and git history, and moves the previous files to the recycle bin, so
a round trip never loses anything. If the folder is a git repository,
`git diff` then shows exactly what changed online.

## What is in the box

- **Editor** – syntax highlighting for LaTeX and BibTeX, autocomplete for
  commands, environments, `\ref` labels, `\cite` keys and file names,
  automatic `\end{…}` and `\item`, bracket matching, find and replace, a light
  syntax check, spell check that skips commands and maths, optional Vim and
  Emacs key bindings, several editor themes.
- **PDF preview** – PDF.js with zoom, fit to width or height, text selection
  and clickable links. A recompile swaps the PDF without flicker and keeps
  your scroll position.
- **SyncTeX** – double-click the PDF to jump to the source; use the arrow
  button between the panes to jump from the cursor to the PDF.
- **Logs** – errors and warnings as cards with file and line; click one to go
  there. Problems are also marked in the editor's gutter.
- **Projects** – create, copy, rename, delete (to the recycle bin), search,
  word count, file outline, upload by dialog or drag and drop, move files by
  dragging them in the tree, set the main document.
- **Plain folders** – no database. A project is a folder inside the library
  (by default `Documents/Underleaf`); folders you copy or `git clone` there
  show up automatically, and **New Project → Open Existing Folder** links a
  folder anywhere else. Changes made by other programs appear immediately.
- **Clean projects** – compilation happens in a private mirror of the project,
  so `.aux`, `.log` and friends never land next to your sources.
- **Careful with your files** – edits are saved automatically; if a save fails
  (a read-only or locked file, a full disk) the text stays in the editor, is
  retried every few seconds, and you are asked before anything would be lost.
  Deleted files and the previous version of an updated project go to the
  system trash. A file that is not UTF-8 opens read-only until you choose to
  convert it.

Keyboard shortcuts match Overleaf where it matters: `Ctrl/⌘+Enter` or
`Ctrl/⌘+S` recompiles, `Ctrl/⌘+F` searches, `Ctrl/⌘+B` / `Ctrl/⌘+I` make text
bold or italic, `Ctrl/⌘+/` toggles a comment. **Menu → Help → Show Hotkeys**
lists the rest.

## TeX engines

Underleaf can compile in two ways (**Settings → TeX engine**):

| | Installed TeX (TeX Live, MacTeX, MiKTeX) | Built-in engine (Tectonic) |
| --- | --- | --- |
| Setup | Install the distribution once | None, it is part of the app |
| Compilers | pdfLaTeX, XeLaTeX, LuaLaTeX, LaTeX via `latexmk` | XeTeX-based, used for every compiler choice |
| Compatibility with Overleaf | Same tools and flags as Overleaf, including `latexmkrc`, glossaries, nomenclature, biber | Very good for typical documents; things that need pdfTeX or LuaTeX specifically, `biber`, or shell escape may not work |
| Offline | Always | After a document's packages have been downloaded once |

With the default setting **Automatic**, an installed distribution is used when
one is found and the built-in engine otherwise. The pill in the top-right
corner of the project list shows which one is active.

A project can carry its own `latexmkrc`, as on Overleaf. Such a file is code
that `latexmk` runs on your computer, so Underleaf leaves it out until you
click **Use it** in the notice above the PDF, and asks again if the file
changes outside the app. Only do that for projects whose origin you trust.

The built-in engine downloads TeX packages on demand the first time a document
needs them (the very first compile fetches a few dozen megabytes) and keeps
them in a cache. After that it compiles from the cache and does not touch the
network.

If a project compiles on Overleaf but not with the built-in engine, install
[TeX Live](https://tug.org/texlive/) (Windows, Linux),
[MacTeX](https://tug.org/mactex/) (macOS) or [MiKTeX](https://miktex.org/),
then click **Settings → Detect again**.

### Troubleshooting

- **"File `something.sty' not found" with the built-in engine.** The package
  has not been downloaded yet and the engine could not reach the internet.
  Reconnect and recompile; from then on it works offline. (The engine reports
  a file it could not fetch the same way as one that does not exist, so also
  check the spelling.)
- **The very first compile fails.** The built-in engine needs to download its
  support files once. Check the connection and press **Recompile**.
- **Something looks stale or stuck.** Open the logs (the document icon next to
  **Recompile**) and click **Clear cached files**, or choose **Recompile from
  scratch** in the menu next to the button.
- **You need the `.log`, `.aux` or `.bbl` files.** **Other logs and files** in
  the logs panel opens the build folder.
- **A compile never finishes.** Stop it from the menu next to **Recompile**;
  compiles are also stopped automatically after ten minutes.

## Installing

Download the file for your system from the Releases page (or from the
artifacts of a workflow run):

| System | File | Notes |
| --- | --- | --- |
| Windows | `Underleaf-<version>-windows-x64-setup.exe` | Installs for the current user and starts the app. |
| Windows | `Underleaf-<version>-windows-x64-portable.exe` | Runs without installing. |
| macOS (Apple silicon) | `Underleaf-<version>-mac-arm64.dmg` | Drag to Applications. |
| macOS (Intel) | `Underleaf-<version>-mac-x64.dmg` | Drag to Applications. |

The builds are not signed with a paid developer certificate unless you add one
(see below), so both systems ask for confirmation the first time:

- **Windows** shows "Windows protected your PC". Click **More info → Run anyway**.
- **macOS** says the app is from an unidentified developer, or that it "is
  damaged and can't be opened" (its way of saying the same about a download
  that is not notarized). Run `xattr -cr /Applications/Underleaf.app` once in
  Terminal; in the first case **System Settings → Privacy & Security →
  Open Anyway** works as well.

## Building from source

Requirements: [Node.js](https://nodejs.org/) 22.12 or newer.

```bash
npm install
npm run fetch:tectonic   # downloads the built-in engine (checksum-verified)
npm run dev              # start the app with live reload
```

Packaging:

```bash
npm run dist:win         # on Windows: installer + portable .exe in dist/
npm run dist:mac         # on macOS: .dmg and .zip for arm64 and x64 in dist/
```

A macOS app can only be built on a Mac. If you do not have one, push the
repository to GitHub: the workflow in `.github/workflows/build.yml` builds both
platforms on every push and attaches the files to the run, and pushing a tag
such as `v0.1.0` publishes them as a release. To sign and notarize the macOS
build, add the secrets named at the top of that workflow file.

### Tests

```bash
npm run typecheck
npm test                 # unit tests (no TeX needed)
npm run build && npm run test:e2e   # drives the real app with Playwright
```

The end-to-end test keeps to a temporary folder: settings, projects, build
files and even its "trash" live there, so it never touches your own projects
or your recycle bin.

The tests use a small fake engine so they run anywhere. To also exercise the
real one:

```bash
UNDERLEAF_TEST_REAL_ENGINE=1 npm test
UNDERLEAF_E2E_REAL_ENGINE=1 npm run test:e2e
```

(PowerShell: `$env:UNDERLEAF_TEST_REAL_ENGINE = '1'; npm test`.)

### Layout of the code

```
src/main/        Electron main process
  projects.ts      project library, zip import/export
  files.ts         file operations inside a project
  compile/         build mirror, engines, log parser, SyncTeX reader
src/preload/     the bridge exposed to the UI as window.api
src/renderer/    React UI (dashboard, editor, PDF viewer)
src/shared/      types and tables shared by all three
resources/       files shipped next to the app (latexmkrc, engine binaries)
scripts/         build helpers: engine download, licence collection, icons
tests/           unit tests, the fake engine, the end-to-end smoke test
```

## Where things are stored

| What | Windows | macOS |
| --- | --- | --- |
| Projects | `Documents\Underleaf` (changeable in Settings) | `~/Documents/Underleaf` |
| Settings | `%APPDATA%\Underleaf` | `~/Library/Application Support/Underleaf` |
| Build files (safe to delete) | `%LOCALAPPDATA%\Underleaf\build` | `~/Library/Caches/Underleaf/build` |
| Built-in engine's package cache | `%LOCALAPPDATA%\TectonicProject\Tectonic` | `~/Library/Caches/Tectonic` |

A project folder may contain a small `.underleaf.json` with its compiler and
main-document choice. It is never included in exported archives.

## Not included

Things that only make sense online, or that are out of scope for now:
real-time collaboration, comments and track changes, project history (use git
in the project folder), the visual (rich text) editor, and direct syncing with
an Overleaf account. Moving projects is done with `.zip` files as described
above.

## License

Underleaf is licensed under the [Apache License 2.0](LICENSE).

The apps you download also contain open-source software from other projects
(Electron, the Tectonic engine, PDF.js, CodeMirror and more), each under its
own licence; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Their full
licence texts are installed with the app and open from
**Help → Open-Source Licenses**.

Underleaf is an independent project and is not affiliated with Overleaf.
"Overleaf" is a trademark of its owner and is used here only to describe
compatibility.
