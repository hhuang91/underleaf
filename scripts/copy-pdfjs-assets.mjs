// Copies the static resources PDF.js loads at runtime (character maps, the
// standard 14 fonts, WebAssembly decoders, colour profiles) into the renderer's
// public folder, from where Vite serves and bundles them.

import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'node_modules', 'pdfjs-dist')
const target = path.join(root, 'src', 'renderer', 'public', 'pdfjs')

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })

for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const from = path.join(source, dir)
  if (!existsSync(from)) continue
  await cp(from, path.join(target, dir), { recursive: true })
}

console.log(`PDF.js assets copied to ${path.relative(root, target)}`)
