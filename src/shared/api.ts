import type {
  AppInfo,
  AppSettings,
  Compiler,
  CompileResult,
  DeepPartial,
  FileNode,
  ImportFilesResult,
  ImportResult,
  PdfRect,
  ProjectIndex,
  ProjectState,
  ProjectSummary,
  ReadFileResult,
  SourceLocation,
  TexStatus,
  WordCount
} from './types'

export type ImportMode = 'ask' | 'keep-both' | 'replace'
export type ProjectTemplate = 'blank' | 'example'

export interface ProjectChangedEvent {
  id: string
  /** Project-relative paths that changed on disk. */
  paths: string[]
}

export interface CompileProgressEvent {
  id: string
  line: string
  /** A status notice from the app itself; stays visible until the compile ends. */
  sticky: boolean
}

/** The API exposed to the renderer as `window.api`. */
export interface UnderleafApi {
  app: {
    info(): Promise<AppInfo>
    getSettings(): Promise<AppSettings>
    updateSettings(patch: DeepPartial<AppSettings>): Promise<AppSettings>
    chooseDirectory(title: string): Promise<string | null>
    openExternal(url: string): Promise<void>
    showItemInFolder(path: string): Promise<void>
    texStatus(refresh: boolean): Promise<TexStatus>
    /** Absolute path of a file dropped onto the window. */
    pathForFile(file: File): string
    onMenuCommand(cb: (command: string) => void): () => void
    /**
     * Registers the handler that saves pending edits before the window closes.
     * The window waits for the returned promise (with a timeout). Resolving
     * with false means that something could not be saved; the user is then
     * asked before the window closes.
     */
    onFlushRequest(cb: () => Promise<boolean>): () => void
  }
  projects: {
    list(): Promise<ProjectSummary[]>
    create(name: string, template: ProjectTemplate): Promise<ProjectSummary>
    pickZip(): Promise<string | null>
    importZip(zipPath: string, mode: ImportMode): Promise<ImportResult>
    addFolder(): Promise<ProjectSummary | null>
    /** Shows a save dialog; resolves with the saved path or null when cancelled. */
    exportZip(id: string): Promise<string | null>
    rename(id: string, name: string): Promise<ProjectSummary>
    copy(id: string, name: string): Promise<ProjectSummary>
    remove(id: string): Promise<void>
    reveal(id: string): Promise<void>
    open(id: string): Promise<ProjectState>
    close(id: string): Promise<void>
    setCompiler(id: string, compiler: Compiler): Promise<void>
    /** Pass null to go back to auto-detection. Resolves with the effective main document. */
    setRootDoc(id: string, path: string | null): Promise<string | null>
    /** Allows the project's latexmkrc, as it is now, to be used when compiling. */
    trustRc(id: string): Promise<void>
    index(id: string): Promise<ProjectIndex>
    wordCount(id: string): Promise<WordCount>
    onChanged(cb: (event: ProjectChangedEvent) => void): () => void
  }
  files: {
    tree(id: string): Promise<FileNode[]>
    read(id: string, path: string): Promise<ReadFileResult>
    readBinary(id: string, path: string): Promise<Uint8Array>
    write(id: string, path: string, content: string, eol: '\n' | '\r\n'): Promise<number>
    createFile(id: string, path: string, content: string): Promise<void>
    createFolder(id: string, path: string): Promise<void>
    rename(id: string, path: string, newName: string): Promise<string>
    move(id: string, path: string, destFolder: string): Promise<string>
    /**
     * Moves the entry to the system trash. Resolves with false, having deleted
     * nothing, when there is no trash for its location; call again with
     * `permanently` once the user has agreed to delete it for good.
     */
    remove(id: string, path: string, permanently: boolean): Promise<boolean>
    pickAndImport(id: string, destFolder: string): Promise<ImportFilesResult | null>
    /**
     * Copies files into the project. Only paths that the user handed over are
     * accepted: ones picked in a dialog, or dropped on the window and resolved
     * with `app.pathForFile`.
     */
    importPaths(
      id: string,
      destFolder: string,
      absPaths: string[],
      overwrite: boolean
    ): Promise<ImportFilesResult>
    reveal(id: string, path: string): Promise<void>
  }
  compile: {
    run(id: string, fromScratch: boolean): Promise<CompileResult>
    stop(id: string): Promise<void>
    clearCache(id: string): Promise<void>
    /** The latest PDF, with the same version number that compile results carry. */
    readPdf(id: string): Promise<{ data: Uint8Array; version: number } | null>
    savePdf(id: string): Promise<string | null>
    openBuildFolder(id: string): Promise<void>
    syncToPdf(id: string, file: string, line: number, column: number): Promise<PdfRect[]>
    syncToSource(id: string, page: number, x: number, y: number): Promise<SourceLocation | null>
    onProgress(cb: (event: CompileProgressEvent) => void): () => void
  }
}
