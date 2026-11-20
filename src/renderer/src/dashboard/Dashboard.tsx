import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  mdiAlert,
  mdiArrowDown,
  mdiArrowUp,
  mdiCheckCircle,
  mdiChevronDown,
  mdiCog,
  mdiContentCopy,
  mdiDeleteOutline,
  mdiDownload,
  mdiFileDocumentOutline,
  mdiFolderOpenOutline,
  mdiFolderZipOutline,
  mdiLinkVariant,
  mdiMagnify,
  mdiPencilOutline,
  mdiPlus,
  mdiTrayArrowUp
} from '@mdi/js'
import type { ProjectTemplate } from '@shared/api'
import type { ImportResult, ProjectSummary } from '@shared/types'
import { Icon, Logo } from '../components/Icon'
import { Dropdown, type MenuEntry } from '../components/Menu'
import { ConfirmModal, Modal, PromptModal } from '../components/Modal'
import { engineSummary, SettingsModal } from '../components/SettingsModal'
import { useMenuCommands } from '../lib/menuBus'
import { cx, errorMessage, formatDateTime, relativeTime, REVEAL, TRASH } from '../lib/util'
import { notifyError, useApp, useSettings } from '../stores/app'

type DashModal =
  | { kind: 'new'; template: ProjectTemplate }
  | { kind: 'upload' }
  | { kind: 'conflict'; result: Extract<ImportResult, { status: 'conflict' }> }
  | { kind: 'rename'; project: ProjectSummary }
  | { kind: 'copy'; project: ProjectSummary }
  | { kind: 'delete'; project: ProjectSummary }
  | { kind: 'settings' }

type SortKey = 'name' | 'modifiedAt'

export function Dashboard(): React.JSX.Element {
  const settings = useSettings()
  const tex = useApp((s) => s.tex)
  const navigate = useApp((s) => s.navigate)
  const notify = useApp((s) => s.notify)

  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'modifiedAt', asc: false })
  const [modal, setModal] = useState<DashModal | null>(null)
  const [dragging, setDragging] = useState(false)
  const [importing, setImporting] = useState(false)
  const dragDepth = useRef(0)

  const reload = useCallback(async (): Promise<void> => {
    try {
      setProjects(await window.api.projects.list())
    } catch (err) {
      notifyError(err)
      setProjects([])
    }
  }, [])

  useEffect(() => {
    void reload()
    // Folders may be added or changed outside the app; refresh when we get focus back.
    const onFocus = (): void => void reload()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [reload, settings.libraryPath])

  const openProject = (p: ProjectSummary): void => navigate({ name: 'project', id: p.id })

  const importZip = useCallback(
    async (zipPath: string, mode: 'ask' | 'keep-both' | 'replace'): Promise<void> => {
      setImporting(true)
      try {
        const result = await window.api.projects.importZip(zipPath, mode)
        if (result.status === 'conflict') {
          setModal({ kind: 'conflict', result })
          return
        }
        setModal(null)
        notify(
          'success',
          result.replaced
            ? `Updated "${result.project.name}". The previous version is in the ${TRASH}.`
            : `Imported "${result.project.name}".`
        )
        navigate({ name: 'project', id: result.project.id })
      } catch (err) {
        notify('error', `Import failed: ${errorMessage(err)}`)
        void reload()
      } finally {
        setImporting(false)
      }
    },
    [navigate, notify, reload]
  )

  const pickZip = async (): Promise<void> => {
    const zip = await window.api.projects.pickZip()
    if (zip) await importZip(zip, 'ask')
  }

  const addFolder = async (): Promise<void> => {
    try {
      const project = await window.api.projects.addFolder()
      if (project) navigate({ name: 'project', id: project.id })
    } catch (err) {
      notifyError(err)
    }
  }

  const downloadZip = async (p: ProjectSummary): Promise<void> => {
    try {
      const saved = await window.api.projects.exportZip(p.id)
      if (saved) {
        notify('success', `Saved ${saved.split(/[\\/]/).pop()}. Upload it to Overleaf with New Project > Upload Project.`, {
          label: 'Show in folder',
          run: () => void window.api.app.showItemInFolder(saved)
        })
      }
    } catch (err) {
      notifyError(err)
    }
  }

  useMenuCommands((command) => {
    if (command === 'new-project') setModal({ kind: 'new', template: 'blank' })
    else if (command === 'upload-project') setModal({ kind: 'upload' })
    else if (command === 'open-folder') void addFolder()
    else if (command === 'settings') setModal({ kind: 'settings' })
  })

  // ---- drag a .zip from the file manager onto the window
  const hasFiles = (e: React.DragEvent): boolean => Array.from(e.dataTransfer.types).includes('Files')
  const onDragEnter = (e: React.DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth.current++
    setDragging(true)
  }
  const onDragLeave = (e: React.DragEvent): void => {
    if (!hasFiles(e)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const onDrop = (e: React.DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const zips = Array.from(e.dataTransfer.files)
      .map((f) => window.api.app.pathForFile(f))
      .filter((p) => /\.zip$/i.test(p))
    if (zips.length === 0) {
      notify('info', 'Drop a .zip file to import it as a project.')
      return
    }
    void importZip(zips[0], 'ask')
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = (projects ?? []).filter((p) => !q || p.name.toLowerCase().includes(q))
    const dir = sort.asc ? 1 : -1
    return list.sort((a, b) =>
      sort.key === 'name'
        ? dir * a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        : dir * (a.modifiedAt - b.modifiedAt)
    )
  }, [projects, query, sort])

  const toggleSort = (key: SortKey): void =>
    setSort((s) => (s.key === key ? { key, asc: !s.asc } : { key, asc: key === 'name' }))

  const newProjectEntries: MenuEntry[] = [
    { label: 'Blank Project', icon: mdiFileDocumentOutline, onClick: () => setModal({ kind: 'new', template: 'blank' }) },
    { label: 'Example Project', icon: mdiFileDocumentOutline, onClick: () => setModal({ kind: 'new', template: 'example' }) },
    { label: 'Upload Project', icon: mdiTrayArrowUp, onClick: () => setModal({ kind: 'upload' }) },
    { type: 'divider' },
    { label: 'Open Existing Folder…', icon: mdiFolderOpenOutline, onClick: () => void addFolder() }
  ]

  const engine = engineSummary(tex, settings.engineBackend)
  const sortIcon = (key: SortKey): React.ReactNode =>
    sort.key === key ? <Icon path={sort.asc ? mdiArrowUp : mdiArrowDown} size={14} /> : null

  return (
    <div
      className="dash"
      onDragEnter={onDragEnter}
      onDragOver={(e) => hasFiles(e) && e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="dash-nav">
        <Logo />
        <div className="dash-nav-right">
          <button
            type="button"
            className={cx('engine-pill', !engine.ok && 'warn')}
            onClick={() => setModal({ kind: 'settings' })}
            title="TeX engine used for compiling. Click to change."
          >
            <Icon path={engine.ok ? mdiCheckCircle : mdiAlert} size={16} />
            {engine.text}
          </button>
          <button type="button" className="dash-nav-btn" onClick={() => setModal({ kind: 'settings' })}>
            <Icon path={mdiCog} size={18} />
            Settings
          </button>
        </div>
      </header>

      <div className="dash-body">
        <aside className="dash-side">
          <Dropdown entries={newProjectEntries} className="dash-new">
            {(toggle) => (
              <button type="button" className="btn btn-primary btn-lg btn-block" onClick={toggle}>
                New Project
                <Icon path={mdiChevronDown} size={18} />
              </button>
            )}
          </Dropdown>

          <nav className="dash-filters">
            <div className="dash-filter active">
              <span>All Projects</span>
              <span className="count">{projects?.length ?? ''}</span>
            </div>
          </nav>

          <div className="dash-side-section">
            <div className="dash-side-label">Library folder</div>
            <div className="dash-side-path selectable" title={settings.libraryPath}>
              {settings.libraryPath}
            </div>
            <button
              type="button"
              className="dash-side-link"
              onClick={() => void window.api.app.showItemInFolder(settings.libraryPath)}
            >
              <Icon path={mdiFolderOpenOutline} size={16} />
              {REVEAL}
            </button>
          </div>

          <div className="dash-tip">
            <div className="dash-tip-title">Moving between Overleaf and Underleaf</div>
            <ol>
              <li>
                In Overleaf, choose <em>Menu → Download → Source</em>.
              </li>
              <li>
                Here, choose <em>New Project → Upload Project</em> or drop the .zip on this window.
              </li>
              <li>
                To go back, use <em>Download .zip</em> here and <em>New Project → Upload Project</em>{' '}
                in Overleaf.
              </li>
            </ol>
          </div>
        </aside>

        <main className="dash-main">
          <div className="dash-main-inner">
            <h1>All Projects</h1>
            <div className="dash-search">
              <Icon path={mdiMagnify} size={20} />
              <input
                className="input"
                placeholder="Search in all projects…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                spellCheck={false}
              />
            </div>

            {projects === null ? (
              <div className="dash-empty muted">Loading projects…</div>
            ) : projects.length === 0 ? (
              <div className="dash-welcome">
                <h2>Create your first project</h2>
                <p className="muted">
                  Start from scratch, try the example, or bring a project over from Overleaf as a .zip
                  file. You can also drop a .zip anywhere on this window.
                </p>
                <div className="dash-welcome-actions">
                  <button type="button" className="btn btn-primary" onClick={() => setModal({ kind: 'new', template: 'blank' })}>
                    <Icon path={mdiPlus} size={18} />
                    Blank Project
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => setModal({ kind: 'new', template: 'example' })}>
                    Example Project
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => setModal({ kind: 'upload' })}>
                    <Icon path={mdiTrayArrowUp} size={18} />
                    Upload Project
                  </button>
                </div>
              </div>
            ) : (
              <div className="dash-table-card">
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th>
                        <button type="button" className="th-sort" onClick={() => toggleSort('name')}>
                          Title {sortIcon('name')}
                        </button>
                      </th>
                      <th className="col-location">Location</th>
                      <th className="col-modified">
                        <button type="button" className="th-sort" onClick={() => toggleSort('modifiedAt')}>
                          Last Modified {sortIcon('modifiedAt')}
                        </button>
                      </th>
                      <th className="col-actions">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((p) => (
                      <tr key={p.id}>
                        <td className="col-title">
                          <a
                            className="project-link"
                            onClick={() => openProject(p)}
                            onKeyDown={(e) => e.key === 'Enter' && openProject(p)}
                            tabIndex={0}
                            role="link"
                          >
                            {p.name}
                          </a>
                        </td>
                        <td className="col-location">
                          {p.location === 'external' ? (
                            <span className="tag" title={p.path}>
                              <Icon path={mdiLinkVariant} size={13} />
                              &nbsp;Linked folder
                            </span>
                          ) : (
                            <span className="muted">Library</span>
                          )}
                        </td>
                        <td className="col-modified" title={formatDateTime(p.modifiedAt)}>
                          {relativeTime(p.modifiedAt)}
                        </td>
                        <td className="col-actions">
                          <div className="row-actions">
                            <button type="button" className="icon-btn" title="Make a copy" onClick={() => setModal({ kind: 'copy', project: p })}>
                              <Icon path={mdiContentCopy} />
                            </button>
                            <button type="button" className="icon-btn" title="Download .zip (ready to upload to Overleaf)" onClick={() => void downloadZip(p)}>
                              <Icon path={mdiDownload} />
                            </button>
                            <button type="button" className="icon-btn" title="Rename" onClick={() => setModal({ kind: 'rename', project: p })}>
                              <Icon path={mdiPencilOutline} />
                            </button>
                            <button type="button" className="icon-btn" title={REVEAL} onClick={() => void window.api.projects.reveal(p.id)}>
                              <Icon path={mdiFolderOpenOutline} />
                            </button>
                            <button
                              type="button"
                              className="icon-btn"
                              title={p.location === 'external' ? 'Remove from list' : `Move to ${TRASH}`}
                              onClick={() => setModal({ kind: 'delete', project: p })}
                            >
                              <Icon path={mdiDeleteOutline} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {visible.length === 0 && (
                      <tr>
                        <td colSpan={4} className="dash-no-match muted">
                          No projects match “{query}”.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {projects !== null && projects.length > 0 && (
              <p className="dash-count muted">
                Showing {visible.length} of {projects.length} project{projects.length === 1 ? '' : 's'}.
              </p>
            )}
          </div>
        </main>
      </div>

      {dragging && (
        <div className="drop-overlay">
          <Icon path={mdiFolderZipOutline} size={48} />
          Drop a project .zip to import it
        </div>
      )}

      {modal?.kind === 'new' && (
        <PromptModal
          title="New Project"
          label="Project Name"
          placeholder="Project Name"
          confirmLabel="Create"
          onClose={() => setModal(null)}
          onSubmit={async (name) => {
            const project = await window.api.projects.create(name, modal.template)
            navigate({ name: 'project', id: project.id })
          }}
        />
      )}

      {modal?.kind === 'upload' && (
        <Modal title="Upload Project" onClose={() => setModal(null)} busy={importing}>
          <div className="upload-zone">
            <Icon path={mdiFolderZipOutline} size={40} />
            <button type="button" className="btn btn-primary" onClick={() => void pickZip()} disabled={importing}>
              {importing ? 'Importing…' : 'Select a .zip file'}
            </button>
            <p className="muted">or drag a .zip file onto this window</p>
          </div>
          <p className="muted" style={{ marginTop: 12 }}>
            To export a project from Overleaf, open it and choose <em>Menu → Download → Source</em>.
          </p>
        </Modal>
      )}

      {modal?.kind === 'conflict' && (
        <Modal
          title="This project already exists"
          onClose={() => setModal(null)}
          busy={importing}
          footer={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setModal(null)} disabled={importing}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={importing}
                onClick={() => void importZip(modal.result.zipPath, 'keep-both')}
              >
                Keep both
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={importing}
                onClick={() => void importZip(modal.result.zipPath, 'replace')}
              >
                Update existing project
              </button>
            </>
          }
        >
          <p>
            You already have a project named <strong>{modal.result.existing.name}</strong>.
          </p>
          <p>
            <strong>Update existing project</strong> replaces its files with the contents of the .zip
            and keeps its settings (and its git history, if it has one). The current files are moved to
            the {TRASH}, so nothing is lost.
          </p>
          <p>
            <strong>Keep both</strong> imports the .zip as a separate project.
          </p>
        </Modal>
      )}

      {modal?.kind === 'rename' && (
        <PromptModal
          title="Rename Project"
          label="New Name"
          initialValue={modal.project.name}
          confirmLabel="Rename"
          onClose={() => setModal(null)}
          onSubmit={async (name) => {
            await window.api.projects.rename(modal.project.id, name)
            await reload()
          }}
        />
      )}

      {modal?.kind === 'copy' && (
        <PromptModal
          title="Copy Project"
          label="New Name"
          initialValue={`${modal.project.name} (Copy)`}
          confirmLabel="Copy"
          onClose={() => setModal(null)}
          onSubmit={async (name) => {
            await window.api.projects.copy(modal.project.id, name)
            await reload()
          }}
        />
      )}

      {modal?.kind === 'delete' && (
        <ConfirmModal
          title={modal.project.location === 'external' ? 'Remove project from list' : 'Delete project'}
          confirmLabel={modal.project.location === 'external' ? 'Remove' : 'Delete'}
          danger
          onClose={() => setModal(null)}
          onConfirm={async () => {
            await window.api.projects.remove(modal.project.id)
            await reload()
          }}
        >
          {modal.project.location === 'external' ? (
            <p>
              <strong>{modal.project.name}</strong> will be removed from the project list. The folder and
              its files stay where they are.
            </p>
          ) : (
            <p>
              <strong>{modal.project.name}</strong> will be moved to the {TRASH}. You can restore it from
              there if you change your mind.
            </p>
          )}
        </ConfirmModal>
      )}

      {modal?.kind === 'settings' && <SettingsModal onClose={() => setModal(null)} />}
    </div>
  )
}
