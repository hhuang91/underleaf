// A stand-in for the Tectonic binary, used by the automated tests so that the
// whole compile pipeline (mirror, engine run, log parsing, PDF, SyncTeX) can be
// exercised on machines without any TeX installation.
//
// It understands the command line the app uses:
//   fake-tectonic -X compile <main.tex> --synctex --keep-logs ... [--only-cached]
//
// and reacts to a few markers in the document:
//   \badcommand            -> "Undefined control sequence" error on that line
//   \ref{missing}          -> undefined-reference warning
//   \usepackage{notcached} -> fails with --only-cached, works without (download)
//   % fake:sleep=1500      -> waits that many milliseconds (to test Stop)
//   % fake:partial-pdf     -> writes a truncated PDF first (use with fake:sleep)

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { makePdf } from './pdf.mjs'

const args = process.argv.slice(2)
const input = args[2]
if (args[0] !== '-X' || args[1] !== 'compile' || !input) {
  console.error('error: unsupported arguments: ' + args.join(' '))
  process.exit(2)
}

const onlyCached = args.includes('--only-cached')
const keepGoing = args.some((a, i) => a === 'continue-on-errors' && args[i - 1] === '-Z')
const job = input.replace(/\.[^.]+$/, '')
const cwd = process.cwd()

/**
 * Reads a file and follows \input{...}. Returns what TeX goes through, in
 * order: { open } when a file is opened, one entry per line, { close } at its
 * end. `as` is the file's name the way the document wrote it: like Tectonic,
 * this engine reports \input{chapter} as "chapter", without ".tex".
 */
function load(file, as = file) {
  const out = [{ open: as }]
  const text = fs.readFileSync(path.join(cwd, file), 'utf8')
  text.split(/\r?\n/).forEach((line, i) => {
    const m = /\\input\{([^}]+)\}/.exec(line)
    if (m) {
      const child = /\.[a-z]+$/i.test(m[1]) ? m[1] : `${m[1]}.tex`
      if (fs.existsSync(path.join(cwd, child))) {
        out.push(...load(child, m[1]))
        return
      }
      out.push({ file, as, line: i + 1, text: line, missing: child })
      return
    }
    out.push({ file, as, line: i + 1, text: line })
  })
  out.push({ close: true })
  return out
}

const events = load(input)
const source = events.filter((e) => e.text !== undefined)
const full = source.map((s) => s.text).join('\n')

// "% fake:partial-pdf" leaves a PDF that is cut short, as an engine does when
// it is killed while writing its output.
if (/%\s*fake:partial-pdf/.test(full)) fs.writeFileSync(path.join(cwd, `${job}.pdf`), '%PDF-1.4\n% cut short')

const sleep = /%\s*fake:sleep=(\d+)/.exec(full)
if (sleep) await new Promise((resolve) => setTimeout(resolve, Number(sleep[1])))

console.error('note: Running TeX ...')

// The log follows Tectonic's: "(name" when a file is opened and ")" when it
// ends, errors as "! message" followed by the source line as "l.<n> ...".
let log = `This is a fake TeX engine (Underleaf test fixture)\n**${input}\n`
const errors = []
const consoleErrors = []

for (const s of events) {
  if (s.open) {
    log += `(${s.open}\n`
    continue
  }
  if (s.close) {
    log += ')\n'
    continue
  }
  if (/\\usepackage\{notcached\}/.test(s.text) && onlyCached) {
    log += `! LaTeX Error: File \`notcached.sty' not found.\n\nl.${s.line} ${s.text}\n\n`
    consoleErrors.push(`error: ${s.as}:${s.line}: LaTeX Error: File \`notcached.sty' not found.`)
    errors.push(s)
  }
  if (s.missing) {
    log += `! LaTeX Error: File \`${s.missing}' not found.\n\nl.${s.line} ${s.text}\n\n`
    consoleErrors.push(`error: ${s.as}:${s.line}: LaTeX Error: File \`${s.missing}' not found.`)
    errors.push(s)
  }
  const bad = s.text.indexOf('\\badcommand')
  if (bad >= 0 && !s.text.trimStart().startsWith('%')) {
    // TeX shows the source line broken right after the offending command.
    const head = `l.${s.line} ${s.text.slice(0, bad + '\\badcommand'.length)}`
    log += `! Undefined control sequence.\n${head}\n${' '.repeat(head.length)}${s.text.slice(bad + '\\badcommand'.length)}\n\n`
    consoleErrors.push(`error: ${s.as}:${s.line}: Undefined control sequence`)
    errors.push(s)
  }
  const ref = /\\ref\{missing[^}]*\}/.exec(s.text)
  if (ref) {
    log += `\nLaTeX Warning: Reference \`missing' on page 1 undefined on input line ${s.line}.\n\n`
  }
}

for (const line of consoleErrors) console.error(line)

const fatal = errors.length > 0 && !keepGoing
if (fatal) {
  log += '!  ==> Fatal error occurred, no output PDF file produced!\n'
  fs.writeFileSync(path.join(cwd, `${job}.log`), log)
  console.error('error: halted on potentially-recoverable error as specified')
  process.exit(1)
}

// ---- typeset: every non-empty body line becomes one line of text
const begin = source.findIndex((s) => /\\begin\{document\}/.test(s.text))
const end = source.findIndex((s) => /\\end\{document\}/.test(s.text))
const body = source
  .slice(begin < 0 ? 0 : begin + 1, end < 0 ? source.length : end)
  .filter((s) => s.text.trim() && !s.text.trimStart().startsWith('%'))

const LINES_PER_PAGE = 40
const LEFT = 72
const TOP = 90
const LEADING = 16
const SIZE = 11
const SP = 65781.76

const pages = []
const inputs = [...new Set(source.map((s) => s.file))]
let synctex = 'SyncTeX Version:1\n'
// Like real engines, record absolute paths based on the working directory as
// the operating system reports it, that is with symbolic links resolved.
const physicalCwd = fs.realpathSync.native(cwd)
inputs.forEach((file, i) => {
  synctex += `Input:${i + 1}:${path.join(physicalCwd, '.', file).split(path.sep).join('/')}\n`
})
synctex += 'Output:pdf\nMagnification:1000\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n'

for (let p = 0; p * LINES_PER_PAGE < Math.max(body.length, 1); p++) {
  const items = []
  synctex += `{${p + 1}\n[1,1:${Math.round(LEFT * SP)},${Math.round(740 * SP)}:${Math.round(468 * SP)},${Math.round(670 * SP)},0\n`
  body.slice(p * LINES_PER_PAGE, (p + 1) * LINES_PER_PAGE).forEach((s, row) => {
    const y = TOP + row * LEADING
    const text = s.text.replace(/\\[a-zA-Z]+\*?/g, '').replace(/[{}$]/g, '').trim() || s.text.trim()
    items.push({ x: LEFT, y, size: SIZE, text: text.slice(0, 90) })
    const tag = inputs.indexOf(s.file) + 1
    const h = Math.round(LEFT * SP)
    const v = Math.round(y * SP)
    synctex += `(${tag},${s.line}:${h},${v}:${Math.round(468 * SP)},${Math.round(SIZE * SP)},${Math.round(3 * SP)}\n`
    synctex += `x${tag},${s.line}:${h},${v}\n`
    synctex += `g${tag},${s.line}:${Math.round((LEFT + 200) * SP)},${v}\n`
    synctex += ')\n'
  })
  synctex += `]\n}${p + 1}\n`
  pages.push(items)
}
synctex += 'Postamble:\nCount:0\nPost scriptum:\n'

log += `Output written on ${job}.pdf (${pages.length} page${pages.length === 1 ? '' : 's'}).\n`

fs.writeFileSync(path.join(cwd, `${job}.pdf`), makePdf(pages))
fs.writeFileSync(path.join(cwd, `${job}.log`), log)
if (args.includes('--synctex')) {
  fs.writeFileSync(path.join(cwd, `${job}.synctex.gz`), zlib.gzipSync(Buffer.from(synctex, 'utf8')))
}
console.error(`note: Writing \`${job}.pdf\``)
process.exit(0)
