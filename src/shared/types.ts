// Types shared between the main process, the preload bridge and the renderer.

export type Compiler = 'pdflatex' | 'latex' | 'xelatex' | 'lualatex'

export const COMPILERS: ReadonlyArray<{ id: Compiler; label: string }> = [
  { id: 'pdflatex', label: 'pdfLaTeX' },
  { id: 'latex', label: 'LaTeX' },
  { id: 'xelatex', label: 'XeLaTeX' },
  { id: 'lualatex', label: 'LuaLaTeX' }
]

export function compilerLabel(c: Compiler): string {
  return COMPILERS.find((x) => x.id === c)?.label ?? c
}

/** Where the TeX engine comes from. */
export type EngineBackend = 'auto' | 'system' | 'tectonic'

export type OverallTheme = 'default' | 'light'
export type Keybindings = 'default' | 'vim' | 'emacs'
export type LayoutView = 'split' | 'editor' | 'pdf'
export type LineHeight = 'compact' | 'normal' | 'wide'
export type EditorFontFamily = 'monaco' | 'lucida'

export interface EditorSettings {
  fontSize: number
  fontFamily: EditorFontFamily
  lineHeight: LineHeight
  theme: string
  keybindings: Keybindings
  autoComplete: boolean
  autoCloseBrackets: boolean
  codeCheck: boolean
  spellCheck: boolean
}

export interface LayoutSettings {
  view: LayoutView
  fileTreeWidth: number
  /** Fraction (0..1) of the editor+PDF area given to the editor in split view. */
  editorRatio: number
  outlineOpen: boolean
}

export interface WindowBounds {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

export interface AppSettings {
  /** Folder that holds one sub-folder per project. */
  libraryPath: string
  /** Folders outside the library that were added with "Open existing folder". */
  externalProjects: string[]
  engineBackend: EngineBackend
  /** Optional override: folder that contains pdflatex/latexmk. Empty = auto-detect. */
  texBinPath: string
  autoCompile: boolean
  stopOnFirstError: boolean
  overallTheme: OverallTheme
  editor: EditorSettings
  layout: LayoutSettings
  /** 'page-width', 'page-height' or a numeric scale such as '1.25'. */
  pdfZoom: string
  /** Project folder -> file that was open last time. */
  lastOpenFile: Record<string, string>
  /**
   * Project folder -> fingerprint of the latexmkrc the user allowed for it.
   * Kept here, not in the project, so that an archive or a repository cannot
   * bring its own permission along.
   */
  trustedRc: Record<string, string>
  windowBounds: WindowBounds | null
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends ReadonlyArray<unknown>
    ? T[K]
    : T[K] extends Record<string, unknown> | object
      ? DeepPartial<T[K]>
      : T[K]
}

// ---------------------------------------------------------------- projects

export interface ProjectSummary {
  /** Opaque identifier (derived from the folder path). */
  id: string
  name: string
  /** Absolute folder path. */
  path: string
  /** 'library' = lives in the library folder, 'external' = linked folder elsewhere. */
  location: 'library' | 'external'
  modifiedAt: number
}

export interface FileNode {
  name: string
  /** POSIX-style path relative to the project root. */
  path: string
  type: 'file' | 'folder'
  children?: FileNode[]
}

export interface ProjectState {
  summary: ProjectSummary
  tree: FileNode[]
  /** The main document that is compiled (explicit setting or auto-detected). */
  rootDoc: string | null
  /** True when the main document was chosen by the user rather than detected. */
  rootDocExplicit: boolean
  compiler: Compiler
  lastOpenFile: string | null
}

export type ReadFileResult =
  | {
      kind: 'text'
      content: string
      eol: '\n' | '\r\n'
      mtimeMs: number
      size: number
      /** The file was not valid UTF-8 and was decoded as Latin-1. */
      transcoded: boolean
    }
  | {
      kind: 'image' | 'pdf' | 'binary'
      size: number
      mtimeMs: number
      reason?: 'too-large'
    }

export type ImportResult =
  | { status: 'imported'; project: ProjectSummary; replaced: boolean }
  | { status: 'conflict'; zipPath: string; proposedName: string; existing: ProjectSummary }

export interface ImportFilesResult {
  imported: string[]
  /** Relative paths that already exist; nothing was copied when this is non-empty. */
  conflicts: string[]
  /** The absolute source paths, so the caller can retry with overwrite enabled. */
  sources: string[]
}

export interface BibEntryInfo {
  key: string
  type: string
  title?: string
  author?: string
  year?: string
  file: string
}

/** Project-wide symbols used for autocompletion. */
export interface ProjectIndex {
  labels: Array<{ name: string; file: string }>
  bibEntries: BibEntryInfo[]
  commands: string[]
  environments: string[]
}

export interface WordCount {
  words: number
  headers: number
  mathInline: number
  mathDisplay: number
  files: number
}

// ----------------------------------------------------------------- compile

export type LogLevel = 'error' | 'warning' | 'typesetting' | 'info'

export interface LogEntry {
  level: LogLevel
  message: string
  /** Extra context taken from the log. */
  content?: string
  /** Advice from the app on what to do about it, in plain language. */
  hint?: string
  /** Project-relative path when the file belongs to the project. */
  file?: string
  line?: number
  source: 'latex' | 'bibtex' | 'engine'
}

export type CompileStatus =
  | 'success' // PDF produced, no errors
  | 'failure' // LaTeX errors (a PDF may still have been produced)
  | 'stopped'
  | 'timedout'
  | 'no-engine'
  | 'error' // unexpected internal problem

export interface EngineInfo {
  backend: 'system' | 'tectonic'
  /** Human readable, e.g. "pdfLaTeX via latexmk (TeX Live)". */
  label: string
}

export interface CompileResult {
  status: CompileStatus
  /** A PDF from this (or an earlier, still valid) run is available. */
  hasPdf: boolean
  /** Changes whenever a new PDF was written. */
  pdfVersion: number
  entries: LogEntry[]
  rawLog: string
  engine: EngineInfo | null
  durationMs: number
  rootDoc: string | null
  counts: { errors: number; warnings: number; typesetting: number }
  /**
   * The project has a latexmkrc that was left out of this compile because the
   * user has not allowed it yet. (Such a file can run commands.)
   */
  rcIgnored?: boolean
}

export interface TexStatus {
  system: {
    found: boolean
    binDir?: string
    distribution?: string
    hasLatexmk: boolean
    engines: Compiler[]
  }
  tectonic: {
    found: boolean
    path?: string
  }
}

/** Rectangle on a PDF page in PDF points, measured from the top-left corner. */
export interface PdfRect {
  page: number
  x: number
  y: number
  width: number
  height: number
}

export interface SourceLocation {
  file: string
  line: number
  column: number
}

export interface AppInfo {
  version: string
  platform: 'win32' | 'darwin' | 'linux'
  isPackaged: boolean
}
