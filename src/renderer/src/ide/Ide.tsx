import { useCallback, useEffect, useRef, useState } from 'react'
import {
  mdiAlertCircleOutline,
  mdiCheck,
  mdiChevronDown,
  mdiFolderOpenOutline,
  mdiHomeOutline,
  mdiLoading,
  mdiMenu,
  mdiPencilOutline,
  mdiViewSplitVertical
} from '@mdi/js'
import type { LayoutView } from '@shared/types'
import { Icon, LogoMark } from '../components/Icon'
import { Dropdown, type MenuEntry } from '../components/Menu'
import { ConfirmModal } from '../components/Modal'
import { SettingsModal } from '../components/SettingsModal'
import { Splitter } from '../components/Splitter'
import { editor } from '../editor/controller'
import { deferMenuCommand, useMenuCommands } from '../lib/menuBus'
import { cx, errorMessage, isMac } from '../lib/util'
import { notifyError, useApp, useSettings } from '../stores/app'
import { useIde } from '../stores/ide'
import { EditorPane } from './EditorPane'
import { FileTree } from './FileTree'
import { HotkeysModal, MenuDrawer, WordCountModal } from './MenuDrawer'
import { Outline } from './Outline'
import { PdfPane } from './PdfPane'

type IdeModal = 'hotkeys' | 'word-count' | 'settings' | 'unsaved' | null

function ProjectName(): React.JSX.Element {
  const name = useIde((s) => s.summary?.name ?? '')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commit = async (): Promise<void> => {
    const next = inputRef.current?.value.trim() ?? ''
    if (!next || next === name) {
      setEditing(false)
      return
    }
    setBusy(true)
    try {
      await useIde.getState().renameProject(next)
    } catch (err) {
      useApp.getState().notify('error', `Could not rename the project: ${errorMessage(err)}`)
    } finally {
      setBusy(false)
      setEditing(false)
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="project-name-input"
        defaultValue={name}
        disabled={busy}
        spellCheck={false}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setEditing(false)
        }}
      />
    )
  }
  return (
    <button type="button" className="project-name" onClick={() => setEditing(true)} title="Rename project">
      <span className="truncate">{name}</span>
      <Icon path={mdiPencilOutline} size={14} className="project-name-edit" />
    </button>
  )
}

function SaveIndicator(): React.JSX.Element | null {
  const saveState = useIde((s) => s.saveState)
  const hasText = useIde((s) => s.open?.kind === 'text')
  if (!hasText) return null
  if (saveState === 'error') {
    return (
      <span className="save-indicator error" title="The last change could not be written to disk">
        <Icon path={mdiAlertCircleOutline} size={16} />
        Not saved
      </span>
    )
  }
  return (
    <span className="save-indicator" title="Changes are saved to disk automatically">
      <Icon path={saveState === 'dirty' ? mdiLoading : mdiCheck} size={14} spin={saveState === 'dirty'} />
      {saveState === 'dirty' ? 'Saving…' : 'Saved'}
    </span>
  )
}

export function Ide({ projectId }: { projectId: string }): React.JSX.Element {
  const settings = useSettings()
  const patchSettings = useApp((s) => s.patchSettings)
  const navigate = useApp((s) => s.navigate)
  const notify = useApp((s) => s.notify)
  const loading = useIde((s) => s.loading)
  const loadError = useIde((s) => s.loadError)

  const [menuOpen, setMenuOpen] = useState(false)
  const [modal, setModal] = useState<IdeModal>(null)

  // Pane sizes follow the pointer locally and are persisted when a drag ends.
  const [treeWidth, setTreeWidth] = useState(settings.layout.fileTreeWidth)
  const [ratio, setRatio] = useState(settings.layout.editorRatio)
  const dragStart = useRef({ treeWidth: 0, ratio: 0 })
  const contentRef = useRef<HTMLDivElement>(null)
  const view = settings.layout.view

  useEffect(() => {
    // A rename gives the project a new id while it stays loaded; only load on a real switch.
    if (useIde.getState().projectId !== projectId) void useIde.getState().load(projectId)
  }, [projectId])

  useEffect(
    () => () => {
      void useIde.getState().unload()
    },
    []
  )

  useEffect(() => {
    const offChanged = window.api.projects.onChanged((event) => {
      if (event.id === useIde.getState().projectId) void useIde.getState().handleExternalChange(event.paths)
    })
    const offProgress = window.api.compile.onProgress((event) => {
      if (event.id === useIde.getState().projectId && useIde.getState().compiling) {
        useIde.setState(event.sticky ? { progressNote: event.line, progress: '' } : { progress: event.line })
      }
    })
    return () => {
      offChanged()
      offProgress()
    }
  }, [])

  /** Back to the project list; `thenRun` is a menu command for it to carry out. */
  const goHome = useCallback(
    async (thenRun?: string): Promise<void> => {
      if (!(await useIde.getState().unload())) {
        // Something could not be saved: ask before leaving it behind.
        setModal('unsaved')
        return
      }
      if (thenRun) deferMenuCommand(thenRun)
      navigate({ name: 'dashboard' })
    },
    [navigate]
  )

  const downloadZip = useCallback(async (): Promise<void> => {
    const id = useIde.getState().projectId
    if (!id) return
    try {
      // The archive is made from the files on disk; include what was just typed.
      if (!(await editor.flush())) {
        notify('error', 'The latest changes could not be saved, so the archive would be out of date. Try again once they are saved.')
        return
      }
      const saved = await window.api.projects.exportZip(id)
      if (saved) {
        notify('success', `Saved ${saved.split(/[\\/]/).pop()}. Upload it to Overleaf with New Project > Upload Project.`, {
          label: 'Show in folder',
          run: () => void window.api.app.showItemInFolder(saved)
        })
      }
    } catch (err) {
      notifyError(err)
    }
  }, [notify])

  const downloadPdf = useCallback(async (): Promise<void> => {
    const id = useIde.getState().projectId
    if (!id) return
    try {
      const saved = await window.api.compile.savePdf(id)
      if (saved) {
        notify('success', `Saved ${saved.split(/[\\/]/).pop()}.`, {
          label: 'Show in folder',
          run: () => void window.api.app.showItemInFolder(saved)
        })
      }
    } catch (err) {
      notifyError(err)
    }
  }, [notify])

  useMenuCommands((command) => {
    switch (command) {
      case 'recompile':
        void useIde.getState().compile()
        break
      case 'download-zip':
        void downloadZip()
        break
      case 'download-pdf':
        void downloadPdf()
        break
      case 'go-home':
        void goHome()
        break
      case 'hotkeys':
        setModal('hotkeys')
        break
      case 'settings':
        setModal('settings')
        break
      case 'new-project':
      case 'upload-project':
      case 'open-folder':
        // These belong to the project list: go there and let it handle them.
        void goHome(command)
        break
    }
  })

  // Recompile shortcuts must also work when the focus is outside the editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (mod && !e.altKey && (e.key === 'Enter' || e.key.toLowerCase() === 's')) {
        e.preventDefault()
        void useIde.getState().compile()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const setView = (next: LayoutView): void => void patchSettings({ layout: { view: next } })

  const layoutEntries: MenuEntry[] = [
    { label: 'Editor & PDF', checked: view === 'split', onClick: () => setView('split') },
    { label: 'Editor only', checked: view === 'editor', onClick: () => setView('editor') },
    { label: 'PDF only', checked: view === 'pdf', onClick: () => setView('pdf') }
  ]

  return (
    <div className={cx('ide', `theme-${settings.overallTheme}`)}>
      <header className="ide-toolbar">
        <div className="ide-toolbar-group">
          <button type="button" className="toolbar-btn" onClick={() => setMenuOpen(true)} title="Menu">
            <Icon path={mdiMenu} size={20} />
            Menu
          </button>
          <button type="button" className="toolbar-btn icon-only" onClick={() => void goHome()} title="Back to your projects">
            <Icon path={mdiHomeOutline} size={20} />
          </button>
        </div>

        <div className="ide-toolbar-center">
          <LogoMark size={20} baseline={settings.overallTheme === 'light' ? '#1b222c' : '#ffffff'} />
          <ProjectName />
          <SaveIndicator />
        </div>

        <div className="ide-toolbar-group right">
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => void window.api.projects.reveal(projectId)}
            title={isMac ? 'Reveal the project folder in Finder' : 'Open the project folder'}
          >
            <Icon path={mdiFolderOpenOutline} size={18} />
            Folder
          </button>
          <Dropdown entries={layoutEntries} align="right">
            {(toggle) => (
              <button type="button" className="toolbar-btn" onClick={toggle} title="Layout">
                <Icon path={mdiViewSplitVertical} size={18} />
                Layout
                <Icon path={mdiChevronDown} size={16} />
              </button>
            )}
          </Dropdown>
        </div>
      </header>

      {loadError ? (
        <div className="ide-error">
          <p>This project could not be opened.</p>
          <p className="muted selectable">{loadError}</p>
          <button type="button" className="btn btn-primary" onClick={() => void goHome()}>
            Back to your projects
          </button>
        </div>
      ) : (
        <div className="ide-main">
          <aside className="ide-side" style={{ width: treeWidth }}>
            <FileTree />
            <Outline />
          </aside>
          <Splitter
            className="side-splitter"
            onStart={() => (dragStart.current.treeWidth = treeWidth)}
            onDrag={(dx) => setTreeWidth(Math.min(600, Math.max(140, dragStart.current.treeWidth + dx)))}
            onEnd={() => void patchSettings({ layout: { fileTreeWidth: treeWidth } })}
          />
          <div className="ide-content" ref={contentRef}>
            <section
              className="ide-editor"
              style={{
                display: view === 'pdf' ? 'none' : undefined,
                flex: view === 'split' ? `0 0 ${ratio * 100}%` : '1 1 auto'
              }}
            >
              <EditorPane />
            </section>
            {view === 'split' && (
              <Splitter
                className="main-splitter"
                onStart={() => (dragStart.current.ratio = ratio)}
                onDrag={(dx) => {
                  const width = contentRef.current?.clientWidth ?? 1
                  setRatio(Math.min(0.85, Math.max(0.15, dragStart.current.ratio + dx / width)))
                }}
                onEnd={() => void patchSettings({ layout: { editorRatio: ratio } })}
                onDoubleClick={() => {
                  setRatio(0.5)
                  void patchSettings({ layout: { editorRatio: 0.5 } })
                }}
              />
            )}
            <section className="ide-pdf" style={{ display: view === 'editor' ? 'none' : undefined }}>
              <PdfPane showSync={view === 'split'} />
            </section>
          </div>
          {loading && (
            <div className="ide-loading">
              <Icon path={mdiLoading} size={28} spin />
              Loading project…
            </div>
          )}
        </div>
      )}

      {menuOpen && (
        <MenuDrawer
          onClose={() => setMenuOpen(false)}
          onDownloadZip={() => void downloadZip()}
          onDownloadPdf={() => void downloadPdf()}
          onShowHotkeys={() => setModal('hotkeys')}
          onShowWordCount={() => setModal('word-count')}
          onShowEngineSettings={() => setModal('settings')}
        />
      )}
      {modal === 'hotkeys' && <HotkeysModal onClose={() => setModal(null)} />}
      {modal === 'word-count' && <WordCountModal onClose={() => setModal(null)} />}
      {modal === 'settings' && <SettingsModal insideProject onClose={() => setModal(null)} />}
      {modal === 'unsaved' && (
        <ConfirmModal
          title="Changes could not be saved"
          confirmLabel="Leave anyway"
          danger
          onClose={() => setModal(null)}
          onConfirm={async () => {
            await useIde.getState().unload(true)
            navigate({ name: 'dashboard' })
          }}
        >
          <p>
            The latest changes to the open file could not be written to disk. If you leave the project
            now, they are lost.
          </p>
          <p className="muted">
            Saving is tried again every few seconds. Check that the file is not read-only or in use by
            another program.
          </p>
        </ConfirmModal>
      )}
    </div>
  )
}
