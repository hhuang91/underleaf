// File classification by extension, shared by the main process and the UI.

export type FileKind = 'text' | 'image' | 'pdf' | 'binary' | 'unknown'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'])

const BINARY_EXTS = new Set([
  'eps', 'ps', 'tif', 'tiff', 'zip', 'gz', 'tar', '7z', 'rar', 'xz', 'bz2',
  'ttf', 'otf', 'woff', 'woff2', 'pfb', 'tfm', 'vf',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  'mp3', 'mp4', 'mov', 'avi', 'wav', 'ogg', 'webm',
  'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'dvi', 'xdv', 'fmt'
])

const TEXT_EXTS = new Set([
  'tex', 'ltx', 'latex', 'bib', 'cls', 'sty', 'bst', 'bbx', 'cbx', 'lbx', 'dtx', 'ins', 'def',
  'cfg', 'clo', 'fd', 'ldf', 'tikz', 'pgf', 'bbl', 'ist', 'gst', 'mf', 'mp', 'asy',
  'txt', 'md', 'markdown', 'rst', 'csv', 'tsv', 'json', 'yml', 'yaml', 'xml', 'html', 'css',
  'js', 'ts', 'py', 'r', 'rnw', 'rtex', 'rmd', 'm', 'jl', 'c', 'h', 'cpp', 'hpp', 'java', 'sh',
  'bat', 'ps1', 'lua', 'pl', 'rb', 'gnuplot', 'gp', 'plt', 'log', 'ini', 'toml', 'gitignore',
  'gitattributes', 'latexmkrc', 'editorconfig'
])

export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot < 0) return ''
  // ".gitignore" / ".latexmkrc": treat the whole name (minus the dot) as the extension.
  return base.slice(dot + 1).toLowerCase()
}

export function kindOfFile(name: string): FileKind {
  const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase()
  if (base === 'latexmkrc' || base === 'makefile' || base === 'readme' || base === 'license') {
    return 'text'
  }
  const ext = extensionOf(base)
  if (ext === 'pdf') return 'pdf'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (BINARY_EXTS.has(ext)) return 'binary'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'unknown'
}

export function mimeOfImage(name: string): string {
  switch (extensionOf(name)) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'bmp': return 'image/bmp'
    case 'webp': return 'image/webp'
    case 'svg': return 'image/svg+xml'
    case 'ico': return 'image/x-icon'
    default: return 'application/octet-stream'
  }
}

export function isTexFile(name: string): boolean {
  const ext = extensionOf(name)
  return ext === 'tex' || ext === 'ltx' || ext === 'latex'
}

/** Names that never show up in the file tree and are never exported. */
export const IGNORED_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.svn',
  '.hg',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '__MACOSX',
  '.underleaf.json'
])

const ARTIFACT_SUFFIXES = [
  '.synctex.gz', '.synctex(busy)', '.run.xml', '.fdb_latexmk', '.aux', '.log', '.fls', '.blg',
  '.bcf', '.out', '.toc', '.lof', '.lot', '.nav', '.snm', '.vrb', '.xdv', '.dvi', '.idx', '.ilg',
  '.ind', '.glo', '.gls', '.glg', '.acn', '.acr', '.alg'
]

/**
 * If `name` looks like a LaTeX build product ("main.aux", "main.synctex.gz"),
 * returns the stem it was generated from ("main"); otherwise null.
 *
 * Other tools may leave such files next to the sources. A file only counts as
 * an artifact when a .tex file with the same stem sits in the same folder, so
 * unrelated data files such as "results.out" are never dropped from an export.
 */
export function artifactStem(name: string): string | null {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const lower = base.toLowerCase()
  for (const suffix of ARTIFACT_SUFFIXES) {
    if (lower.endsWith(suffix) && base.length > suffix.length) {
      return base.slice(0, base.length - suffix.length)
    }
  }
  return null
}
