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
settings and its versions, and moves the previous files to the recycle bin, so
a round trip never loses anything. A version is saved before and after the
update, and the **History** screen then shows exactly what changed online.

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
- **Version history** – every project keeps its versions in a git repository
  inside its folder. Save one under a name whenever you like; Underleaf also
  saves them by itself while you work. Compare any two states, and put a file
  or the whole project back. See [Version history](#version-history).
- **Writing assistant** (optional, off by default) – suggestions from a
  language model that you run yourself (Ollama, LM Studio, llama.cpp or any
  other server with an OpenAI-compatible API): how the sentence goes on, in
  grey after the cursor, and proofreading of a passage, with each correction
  to accept or reject. See [Writing assistant](#writing-assistant).
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

## Version history

Click **History** in the toolbar to see the versions of a project, newest
first.

- **Save version** (also `Ctrl/⌘+Shift+S`) keeps the project as it is under a
  name of your choice.
- Underleaf saves versions by itself as well: after ten edits, when a project
  is opened or closed with changes, and before and after an archive updates
  it. An *edit* is any amount of changes followed by five seconds without one,
  so typing a paragraph is one edit, not hundreds. Both numbers, and whether
  this happens at all, are under **Settings → Version history**.
- Select a version to see the files it changed and, for each file, what
  changed in it. **Since this version** compares it with the project as it is
  now instead.
- **Restore this version** puts every file back the way it was, and
  **Restore this file** just one. What a restore replaces is saved as a
  version first, so a restore can be undone the same way. For that reason a
  restore only touches files that versions are kept of: a file that is left
  out of versions (see below) is neither replaced nor removed, and Underleaf
  tells you when that leaves something as it is.

Versions are git commits in a `.git` folder inside the project folder, so any
git tool can read them:

- In a project that had no repository, Underleaf creates one. The versions you
  save by name are ordinary commits on its branch, as `git log` shows. The
  automatic ones are kept beside the branch, under `refs/underleaf/`, where
  they do not clutter its history and can be thinned out: all of the last two
  days are kept, of older days the last one each. The copies made before a
  restore, and before and after an archive updates the project, are not
  thinned out.
- In a folder that already is a git repository, or is part of one, Underleaf
  never commits to your branches and never touches the index. All of its
  versions go under `refs/underleaf/`. The commits of your own branch are
  listed in the History screen as well (when the project is the top folder of
  the repository).
- `git log --all`, and tools that show every ref, list the versions under
  `refs/underleaf/` too.
- The `.git` folder is left out of **Download → Source** and of
  **Copy Project**.

Which files a version holds is decided the way git decides it: everything in
the folder except what `.gitignore` files, `.git/info/exclude` and your own
ignore file for all repositories rule out, and always the files that the
repository's branch already has. Also left out are files of more than 100 MB,
and folders that are repositories of their own (submodules, clones). A version
holds a compressed copy of every file, so a project folder grows when large
files change often.

Some things are for git itself: pushing to GitHub or to Overleaf's git access
is not built in; a file that a repository stores with Git LFS can be compared
but not restored; and Underleaf keeps no versions in a linked work tree, in a
project folder that is a submodule, or in a repository that uses SHA-256
object names or the reftable format (the History screen says so).

## Writing assistant

Underleaf can ask a language model for help, from a server that you run
yourself. It includes no model, and it talks to no service of its own: it
sends requests only while the assistant is turned on, and only to the address
you enter.

**Setting it up.** Start a model server with a model, for instance:

- [Ollama](https://ollama.com): `ollama pull qwen2.5:7b`. Its server runs at
  `http://localhost:11434/v1`.
- [LM Studio](https://lmstudio.ai): download a model, then start the server on
  the **Developer** tab. It runs at `http://localhost:1234/v1`.
- [llama.cpp](https://github.com/ggml-org/llama.cpp):
  `llama-server -hf Qwen/Qwen2.5-7B-Instruct-GGUF`. It listens on port 9931
  (8080 in versions before 1.0).

Then turn it on in **Settings → Writing assistant**. Underleaf looks for a
server on this computer and takes the first one that has a model; choose
another model if you like, and use **Test the connection**. Any other server
with an OpenAI-compatible API works too; enter its address, and its API key if
it wants one.

**Suggestions.** When you pause while typing, the model suggests how the
sentence goes on, in grey after the cursor. **Tab** takes the suggestion,
`Ctrl/⌘+→` takes its next word, typing the same text keeps the rest, and
**Esc** or anything else lets it go. Instead of after a pause, suggestions can
come only when you press `Alt+\` (`⌥\`), or not at all.

**Proofreading.** Select a passage (or put the cursor in a paragraph) and press
`Ctrl/⌘+Shift+P`, or right-click and choose **Proofread Selection**. The
corrections appear in the passage; click one to keep the original text there,
and apply the rest. Applying is one step, so **Undo** takes it back.

**What is sent.** For a suggestion, the text around the cursor (about 2,000
characters before it and 400 after) and the file's name; for proofreading,
the passage. Nothing else of your projects. Settings shows a warning when the
server is not on this computer. The API key is stored encrypted with the
system's key store (the Keychain on macOS, your account on Windows), apart from
the settings.

**Choosing a model.** Instruction-tuned models of a few billion parameters
(such as Qwen 2.5 or 3.5, Llama 3.1 or Gemma) are good at both. Smaller ones are
faster but make more mistakes. Some models, Qwen 3 and 3.5 among them, think
before they answer unless told not to; Underleaf tells llama.cpp, vLLM and
Ollama to leave the thinking out. With other servers, turn thinking off in the
server's settings (a model that thinks first is slow for suggestions). The
first request after a while can take longer, while the server loads the model.

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

Likewise, a stand-in model server takes the place of a real one. To run the
writing assistant's tests against real servers as well, name them as
`name|address|model`, separated by `;`:

```bash
UNDERLEAF_TEST_LLM="Ollama|http://localhost:11434/v1|qwen2.5:0.5b" npx vitest run tests/unit/assistant.test.ts
```

### Layout of the code

```
src/main/        Electron main process
  projects.ts      project library, zip import/export
  files.ts         file operations inside a project
  history.ts       versions of a project, kept in git
  assistant.ts     the writing assistant's requests to the model server
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
| Versions of a project | `.git` inside the project's folder | the same |
| Settings (and the assistant's API key, encrypted) | `%APPDATA%\Underleaf` | `~/Library/Application Support/Underleaf` |
| Build files (safe to delete) | `%LOCALAPPDATA%\Underleaf\build` | `~/Library/Caches/Underleaf/build` |
| Built-in engine's package cache | `%LOCALAPPDATA%\TectonicProject\Tectonic` | `~/Library/Caches/Tectonic` |

A project folder may contain a small `.underleaf.json` with its compiler and
main-document choice. It is never included in exported archives.

## Not included

Things that only make sense online, or that are out of scope for now:
real-time collaboration, comments and track changes, the visual (rich text)
editor, pushing versions to a git remote, and direct syncing with an Overleaf
account. Moving projects is done with `.zip` files as described above.

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
