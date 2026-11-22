// Gathers the licence texts of the third-party software inside the app and
// writes them to resources/THIRD_PARTY_LICENSES.txt, which is installed next to
// the app (see electron-builder.yml) and opened by Help > Open-Source Licences.
//
//   node scripts/collect-licenses.mjs              (part of `npm run build`)
//   node scripts/collect-licenses.mjs --out <file>
//
// Why this is needed: the app ships no node_modules. Its JavaScript
// dependencies are compiled into out/ by Vite, which leaves their licence
// files behind, and most of those licences (MIT, BSD, Apache-2.0, OFL) ask for
// the notice to travel with every copy.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Entries of package.json that only build or test the app. Everything else
// listed there is treated as part of the app, so that a new dependency is
// covered without anyone having to remember this script.
const TOOLS = new Set([
  '@vitejs/plugin-react',
  'electron', // ships its own licence files, see the notes below
  'electron-builder',
  'electron-vite',
  'playwright',
  'typescript',
  'vite',
  'vitest'
])
const isTool = (name) => name.startsWith('@types/') || TOOLS.has(name)

const LICENCE_FILE = /^(licen[cs]e|copying|notice|unlicense)([._-].*)?$/i
const RULE = '-'.repeat(78)

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trimEnd()
}

/** Finds an installed package the way Node does: nearest node_modules first. */
function findPackage(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    if (dir === root || path.dirname(dir) === dir) return null
  }
}

function licenceFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENCE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

function licenceName(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ')
  return ''
}

const MIT_TERMS = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

function authorOf(pkg) {
  const a = pkg.author
  const name = typeof a === 'string' ? a.replace(/\s*[<(].*$/, '') : (a?.name ?? '')
  return name.trim()
}

/**
 * Some packages name their licence in package.json but do not ship its text.
 * For the licences below the text is the same for everybody, so it is given
 * here together with the author the package names. Null for anything else,
 * which then needs a person to look at it.
 */
function standardLicence(pkg) {
  const id = licenceName(pkg).trim().toLowerCase()
  const who = authorOf(pkg) || `the authors of ${pkg.name}`
  if (id === 'mit') return `MIT License\n\nCopyright (c) ${who}\n\n${MIT_TERMS}`
  if (id === 'apache-2.0') {
    return `Copyright ${who}\n\nLicensed under the Apache License, Version 2.0, the text of which follows.\n\n${readText(path.join(root, 'LICENSE'))}`
  }
  return null
}

function homepage(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  const url = pkg.homepage || repo || ''
  return url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '')
}

/** The app's JavaScript dependencies and everything they depend on. */
export function bundledPackages() {
  const manifest = readJson(path.join(root, 'package.json'))
  const queue = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((name) => !isTool(name))
    .map((name) => ({ name, from: root, required: true }))
  const byDir = new Map()

  while (queue.length > 0) {
    const { name, from, required } = queue.shift()
    if (name.startsWith('@types/')) continue // declarations only, nothing to ship
    const dir = findPackage(name, from)
    if (!dir) {
      if (required) throw new Error(`${name} is not installed. Run "npm install" first.`)
      continue
    }
    if (byDir.has(dir)) continue
    const pkg = readJson(path.join(dir, 'package.json'))
    const texts = licenceFiles(dir).map((file) => ({ file, text: readText(path.join(dir, file)) }))
    byDir.set(dir, {
      name: pkg.name ?? name,
      version: pkg.version ?? '',
      license: licenceName(pkg),
      url: homepage(pkg),
      texts,
      // Only for a package that brings no licence file of its own.
      standard: texts.length === 0 ? standardLicence(pkg) : null
    })
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, from: dir, required: true })
    // A peer that the package cannot work without is installed alongside it;
    // optional peers are only part of the app when package.json lists them.
    for (const dep of Object.keys(pkg.peerDependencies ?? {})) {
      if (pkg.peerDependenciesMeta?.[dep]?.optional) continue
      queue.push({ name: dep, from: dir, required: false })
    }
  }

  const unique = new Map()
  for (const entry of byDir.values()) unique.set(`${entry.name}@${entry.version}`, entry)
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'))
}

/** Resources PDF.js loads at runtime; each folder carries its own licence files. */
const PDFJS_RESOURCES = [
  { dir: 'cmaps', title: 'character maps (cmaps)' },
  { dir: 'standard_fonts', title: 'substitutes for the standard PDF fonts (Foxit fonts, Liberation Sans)' },
  { dir: 'wasm', title: 'image and colour decoders (OpenJPEG, JBIG2, qcms, QuickJS)' },
  { dir: 'iccs', title: 'colour profiles' }
]

function pdfjsResources() {
  const base = path.join(root, 'node_modules', 'pdfjs-dist')
  const out = []
  for (const { dir, title } of PDFJS_RESOURCES) {
    const folder = path.join(base, dir)
    if (!fs.existsSync(folder)) continue
    for (const file of licenceFiles(folder)) out.push({ title, file: `${dir}/${file}`, text: readText(path.join(folder, file)) })
  }
  return out
}

function tectonicVersion() {
  const script = fs.readFileSync(path.join(root, 'scripts', 'fetch-tectonic.mjs'), 'utf8')
  const match = /^const VERSION = '([^']+)'/m.exec(script)
  if (!match) throw new Error('Could not read the Tectonic version from scripts/fetch-tectonic.mjs')
  return match[1]
}

export function render() {
  const packages = bundledPackages()
  const missing = packages.filter((p) => p.texts.length === 0 && !p.standard)
  if (missing.length > 0) {
    throw new Error(
      `No licence text for: ${missing.map((p) => `${p.name}@${p.version} (${p.license || 'no licence named'})`).join(', ')}. ` +
        'These packages ship without a licence file and name a licence whose text this script does not know; have a look and add it.'
    )
  }
  const resources = pdfjsResources()
  const tectonic = tectonicVersion()

  const lines = [
    'UNDERLEAF: THIRD-PARTY SOFTWARE',
    '',
    'Underleaf itself is licensed under the Apache License, Version 2.0; see the',
    'files LICENSE.txt and NOTICE.txt in this folder.',
    '',
    'The app contains the software listed below, which remains under its own',
    'licences. Their notices and full texts follow.',
    '',
    '',
    RULE,
    'PROGRAMS THAT ARE PART OF THE APP',
    RULE,
    '',
    'Electron (MIT) and Chromium (BSD-3-Clause and others)',
    '  The application shell. Their licences are the files LICENSE.electron.txt',
    '  and LICENSES.chromium.html in the application folder.',
    '',
    `Tectonic ${tectonic}`,
    '  The built-in TeX engine: the unmodified official build, run as a separate',
    '  program. Tectonic itself is under the MIT licence (LICENSE-tectonic.txt in',
    '  the "bin" folder next to this file). The engine is derived from XeTeX and',
    '  dvipdfm-x and is built with further libraries, which keep their own',
    '  open-source licences. Among them, the dvipdfm-x code is under the GNU',
    '  General Public License, version 2 or later; the text of version 2 is',
    '  reproduced further down in this file. Source code for this build:',
    `  https://github.com/tectonic-typesetting/tectonic/tree/tectonic%40${tectonic}`,
    '',
    '',
    RULE,
    'JAVASCRIPT LIBRARIES COMPILED INTO THE APP',
    RULE,
    ''
  ]

  for (const p of packages) {
    lines.push(RULE, `${p.name} ${p.version}`.trim())
    if (p.license) lines.push(`Licence: ${p.license}`)
    if (p.url) lines.push(p.url)
    lines.push(RULE, '')
    if (p.standard) {
      lines.push(
        `(The package contains no licence file. Its package.json names the licence "${p.license}";`,
        'the standard text of that licence follows, with the author the package names.)',
        '',
        p.standard,
        ''
      )
    }
    for (const { file, text } of p.texts) {
      if (p.texts.length > 1) lines.push(`[${file}]`, '')
      lines.push(text, '')
    }
    lines.push('')
  }

  lines.push(RULE, 'RESOURCES OF PDF.JS (pdfjs-dist)', RULE, '')
  for (const r of resources) {
    lines.push(RULE, `PDF.js ${r.title}`, `[${r.file}]`, RULE, '', r.text, '', '')
  }

  const text = lines.join('\n').trimEnd() + '\n'
  // The note on Tectonic above promises the text of the GPL, which so far
  // arrives with the licence of the Liberation fonts.
  if (!/GNU GENERAL PUBLIC LICENSE\s+Version 2, June 1991/.test(text)) {
    throw new Error('The GNU GPL v2 text is no longer among the collected licences; add it for the Tectonic engine.')
  }
  return { text, packages, resources }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out')
  const out = i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(root, 'resources', 'THIRD_PARTY_LICENSES.txt')
  const { text, packages, resources } = render()
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, text, 'utf8')
  const bare = packages.filter((p) => p.standard).map((p) => p.name)
  console.log(
    `Licences of ${packages.length} packages and ${resources.length} PDF.js resource files written to ${path.relative(root, out) || out}` +
      (bare.length > 0 ? ` (standard text used for packages without a licence file: ${bare.join(', ')})` : '')
  )
}
