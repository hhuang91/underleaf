# Third-party software

Underleaf itself is licensed under the Apache License 2.0 (see `LICENSE`).

The source code in this repository is Underleaf's own. The apps built from it
also contain the open-source software listed below, each under its own
licence. Their full licence texts are gathered by
`scripts/collect-licenses.mjs` into `THIRD_PARTY_LICENSES.txt`, which is
installed with the app and opens from **Help → Open-Source Licenses**.

| Component | Used for | Licence |
| --- | --- | --- |
| [Electron](https://www.electronjs.org/) | Application shell | MIT |
| [Chromium](https://www.chromium.org/) | Rendering engine (part of Electron) | BSD-3-Clause and others, including LGPL components such as FFmpeg |
| [Tectonic](https://tectonic-typesetting.github.io/) | Built-in TeX engine (bundled program) | MIT, with parts under other licences including the GNU GPL (see below) |
| [PDF.js](https://mozilla.github.io/pdf.js/) | PDF preview | Apache-2.0 |
| Resources shipped with PDF.js | Character maps, stand-ins for the standard PDF fonts, image and colour decoders | BSD-style, Apache-2.0, MIT and CC0 licences; the Liberation Sans fonts are under the GNU GPL v2 with a font exception |
| [CodeMirror 6](https://codemirror.net/) and [Lezer](https://lezer.codemirror.net/) | Source editor | MIT |
| [@replit/codemirror-vim](https://github.com/replit/codemirror-vim), [@replit/codemirror-emacs](https://github.com/replit/codemirror-emacs) | Optional key bindings | MIT |
| [React](https://react.dev/) | User interface | MIT |
| [Zustand](https://github.com/pmndrs/zustand) | State management | MIT |
| [yauzl](https://github.com/thejoshwolfe/yauzl), [yazl](https://github.com/thejoshwolfe/yazl) | Reading and writing zip archives | MIT |
| [Material Design Icons](https://pictogrammers.com/library/mdi/) (`@mdi/js`) | Icons | Apache-2.0 |
| [Noto Sans](https://fonts.google.com/noto/specimen/Noto+Sans) (via Fontsource) | Interface font | SIL Open Font License 1.1 |

Smaller libraries that the ones above depend on are listed, with their
licences, in `THIRD_PARTY_LICENSES.txt`. The licences of Electron and Chromium
are installed in the application folder as `LICENSE.electron.txt` and
`LICENSES.chromium.html`.

## The built-in TeX engine

The bundled Tectonic program is the unmodified official release build (the
version and the checksums are pinned in `scripts/fetch-tectonic.mjs`); its
licence text is installed next to it as `LICENSE-tectonic.txt`. Underleaf runs
it as a separate program and does not link against it.

Tectonic's own code is under the MIT licence. The engine is derived from XeTeX
and dvipdfm-x and is built with further libraries, which keep their own
open-source licences; among them, the dvipdfm-x code is under the GNU General
Public License, version 2 or later. The source code of the engine, for exactly
the bundled version, is available from the
[Tectonic repository](https://github.com/tectonic-typesetting/tectonic) under
the release tag `tectonic@<version>`.

Tectonic downloads TeX packages from the Tectonic project's bundle server on
demand; those packages carry their own licences (mostly the LaTeX Project
Public License) and are not part of Underleaf.

## Trademarks

Underleaf is an independent project. It is not affiliated with, endorsed by or
connected to Overleaf or the company behind it. "Overleaf" is a trademark of
its owner and is used here only to describe compatibility.
