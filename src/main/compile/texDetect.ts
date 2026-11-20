// Finds a TeX distribution (TeX Live, MacTeX, MiKTeX, TinyTeX) on this machine.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Compiler } from '@shared/types'
import { envWithPath, runProcess } from './proc'

export type ToolName =
  | 'latexmk'
  | 'pdflatex'
  | 'xelatex'
  | 'lualatex'
  | 'latex'
  | 'bibtex'
  | 'biber'
  | 'makeindex'
  | 'dvipdfmx'

const TOOLS: ToolName[] = [
  'latexmk', 'pdflatex', 'xelatex', 'lualatex', 'latex', 'bibtex', 'biber', 'makeindex', 'dvipdfmx'
]

const ENGINES: ReadonlySet<ToolName> = new Set<ToolName>(['pdflatex', 'xelatex', 'lualatex', 'latex'])

export interface TexInstall {
  binDir: string
  distribution: 'TeX Live' | 'MiKTeX' | 'TeX'
  tools: Partial<Record<ToolName, string>>
  /** latexmk is present and actually runs (it needs Perl, which MiKTeX does not ship). */
  latexmkWorks: boolean
}

const EXE = process.platform === 'win32' ? '.exe' : ''

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile()
  } catch {
    return false
  }
}

async function yearDirs(root: string): Promise<string[]> {
  try {
    const names = await fs.readdir(root)
    return names
      .filter((n) => /^\d{4}$/.test(n))
      .sort((a, b) => Number(b) - Number(a))
      .map((n) => path.join(root, n))
  } catch {
    return []
  }
}

async function binSubdirs(yearDir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(path.join(yearDir, 'bin'))
    return names.map((n) => path.join(yearDir, 'bin', n))
  } catch {
    return []
  }
}

/** Places to look, most specific first. GUI apps on macOS do not inherit the shell PATH. */
export async function candidateBinDirs(override: string): Promise<string[]> {
  const dirs: string[] = []
  if (override.trim()) dirs.push(override.trim())
  const pathVar = process.env.PATH ?? process.env.Path ?? ''
  for (const p of pathVar.split(path.delimiter)) if (p) dirs.push(p)

  const home = os.homedir()
  const texliveRoots: string[] = []
  if (process.platform === 'win32') {
    const drive = (process.env.SystemDrive ?? 'C:') + '\\'
    texliveRoots.push(path.join(drive, 'texlive'), path.join(home, 'texlive'))
    const local = process.env.LOCALAPPDATA
    const roaming = process.env.APPDATA
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    if (local) dirs.push(path.join(local, 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'))
    dirs.push(path.join(programFiles, 'MiKTeX', 'miktex', 'bin', 'x64'))
    dirs.push(path.join(programFiles, 'MiKTeX 2.9', 'miktex', 'bin', 'x64'))
    if (roaming) {
      dirs.push(path.join(roaming, 'TinyTeX', 'bin', 'windows'))
      dirs.push(path.join(roaming, 'TinyTeX', 'bin', 'win32'))
    }
  } else if (process.platform === 'darwin') {
    dirs.push('/Library/TeX/texbin')
    texliveRoots.push('/usr/local/texlive')
    dirs.push(path.join(home, 'Library', 'TinyTeX', 'bin', 'universal-darwin'))
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin')
  } else {
    texliveRoots.push('/usr/local/texlive', path.join(home, 'texlive'))
    dirs.push(path.join(home, '.TinyTeX', 'bin', 'x86_64-linux'), path.join(home, 'bin'))
    dirs.push('/usr/local/bin', '/usr/bin')
  }
  for (const root of texliveRoots) {
    for (const year of await yearDirs(root)) dirs.push(...(await binSubdirs(year)))
  }

  const seen = new Set<string>()
  return dirs.filter((d) => {
    const key = process.platform === 'win32' ? d.toLowerCase() : d
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function distributionOf(binDir: string): TexInstall['distribution'] {
  const lower = binDir.toLowerCase()
  if (lower.includes('miktex')) return 'MiKTeX'
  if (lower.includes('texlive') || lower.includes('tinytex') || lower.includes('/library/tex')) {
    return 'TeX Live'
  }
  return 'TeX'
}

export async function detectTex(override = ''): Promise<TexInstall | null> {
  const dirs = await candidateBinDirs(override)

  let binDir: string | null = null
  for (const dir of dirs) {
    if (
      (await isFile(path.join(dir, `pdflatex${EXE}`))) ||
      (await isFile(path.join(dir, `xelatex${EXE}`))) ||
      (await isFile(path.join(dir, `lualatex${EXE}`)))
    ) {
      binDir = dir
      break
    }
  }
  if (!binDir) return null

  const tools: TexInstall['tools'] = {}
  for (const tool of TOOLS) {
    // The engines must come from the distribution that was found. Helpers such
    // as latexmk or biber are sometimes installed separately, so for those the
    // rest of the search path is tried as well.
    for (const dir of ENGINES.has(tool) ? [binDir] : [binDir, ...dirs]) {
      const candidate = path.join(dir, `${tool}${EXE}`)
      if (await isFile(candidate)) {
        tools[tool] = candidate
        break
      }
    }
  }

  let latexmkWorks = false
  if (tools.latexmk) {
    const probe = await runProcess(tools.latexmk, ['-v'], {
      cwd: os.tmpdir(),
      env: envWithPath(process.env, binDir),
      timeoutMs: 20000
    })
    latexmkWorks = probe.code === 0 && /latexmk/i.test(probe.output)
  }

  return { binDir, distribution: distributionOf(binDir), tools, latexmkWorks }
}

export function enginesOf(install: TexInstall): Compiler[] {
  const out: Compiler[] = []
  if (install.tools.pdflatex) out.push('pdflatex')
  if (install.tools.latex) out.push('latex')
  if (install.tools.xelatex) out.push('xelatex')
  if (install.tools.lualatex) out.push('lualatex')
  return out
}
