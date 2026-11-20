import { useEffect, useRef, useState } from 'react'
import {
  mdiBookOpenVariantOutline,
  mdiChevronDown,
  mdiChevronRight,
  mdiDeleteOutline,
  mdiFileDocumentOutline,
  mdiFileOutline,
  mdiFilePdfBox,
  mdiFilePlusOutline,
  mdiFolder,
  mdiFolderOpen,
  mdiFolderPlusOutline,
  mdiImageOutline,
  mdiPencilOutline,
  mdiTrayArrowUp
} from '@mdi/js'
import type { FileNode } from '@shared/types'
import { extensionOf, isTexFile, kindOfFile } from '@shared/fileTypes'
import { Icon } from '../components/Icon'
import { ContextMenu, type MenuEntry } from '../components/Menu'
import { ConfirmModal, PromptModal } from '../components/Modal'
import { baseName, cx, dirName, REVEAL, TRASH } from '../lib/util'
import { notifyError, useApp } from '../stores/app'
import { findNode, useIde } from '../stores/ide'

const DRAG_TYPE = 'application/x-underleaf-path'

type TreeModal =
  | { kind: 'new-file'; folder: string }
  | { kind: 'new-folder'; folder: string }
  | { kind: 'delete'; path: string; permanently?: boolean }
  | { kind: 'overwrite'; folder: string; sources: string[]; conflicts: string[] }

function iconFor(node: FileNode, expanded: boolean): string {
  if (node.type === 'folder') return expanded ? mdiFolderOpen : mdiFolder
  const ext = extensionOf(node.name)
  if (ext === 'bib') return mdiBookOpenVariantOutline
  const kind = kindOfFile(node.name)
  if (kind === 'image') return mdiImageOutline
  if (kind === 'pdf') return mdiFilePdfBox
  if (kind === 'text') return mdiFileDocumentOutline
  return mdiFileOutline
}

export function FileTree(): React.JSX.Element {
  const tree = useIde((s) => s.tree)
  const expanded = useIde((s) => s.expanded)
  const selected = useIde((s) => s.selected)
  const openPath = useIde((s) => s.open?.path ?? null)
  const rootDoc = useIde((s) => s.rootDoc)
  const projectId = useIde((s) => s.projectId)
  const ide = useIde.getState
  const notify = useApp((s) => s.notify)

  const [renaming, setRenaming] = useState<string | null>(null)
  const [modal, setModal] = useState<TreeModal | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; path: string | null } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  /** Folder that new files, folders and uploads go into: the selection or its parent. */
  const targetFolder = (path: string | null = selected): string => {
    if (!path) return ''
    const node = findNode(tree, path)
    if (!node) return ''
    return node.type === 'folder' ? node.path : dirName(node.path)
  }

  const finishImport = async (folder: string, sources: string[], overwrite: boolean): Promise<void> => {
    const result = await ide().importPaths(folder, sources, overwrite)
    if (Array.isArray(result)) {
      if (result.length > 0) notify('success', `Added ${result.length} file${result.length === 1 ? '' : 's'}.`)
    } else {
      setModal({ kind: 'overwrite', folder, sources, conflicts: result.conflicts })
    }
  }

  const upload = async (folder: string): Promise<void> => {
    if (!projectId) return
    try {
      const picked = await window.api.files.pickAndImport(projectId, folder)
      if (!picked) return
      if (picked.conflicts.length > 0) {
        setModal({ kind: 'overwrite', folder, sources: picked.sources, conflicts: picked.conflicts })
        return
      }
      await ide().refreshTree()
      if (folder) ide().toggleFolder(folder, true)
      if (picked.imported.length > 0) {
        notify('success', `Added ${picked.imported.length} file${picked.imported.length === 1 ? '' : 's'}.`)
      }
    } catch (err) {
      notifyError(err)
    }
  }

  const commitRename = async (path: string, name: string): Promise<void> => {
    setRenaming(null)
    const trimmed = name.trim()
    if (!trimmed || trimmed === baseName(path)) return
    try {
      await ide().renameEntry(path, trimmed)
    } catch (err) {
      notifyError(err)
    }
  }

  const menuEntries = (path: string | null): MenuEntry[] => {
    const node = path ? findNode(tree, path) : null
    const folder = targetFolder(path)
    const create: MenuEntry[] = [
      { label: 'New file', icon: mdiFilePlusOutline, onClick: () => setModal({ kind: 'new-file', folder }) },
      { label: 'New folder', icon: mdiFolderPlusOutline, onClick: () => setModal({ kind: 'new-folder', folder }) },
      { label: 'Upload…', icon: mdiTrayArrowUp, onClick: () => void upload(folder) }
    ]
    if (!node || !path) return create
    const entries: MenuEntry[] = [
      { label: 'Rename', icon: mdiPencilOutline, onClick: () => setRenaming(path) },
      { label: 'Delete', icon: mdiDeleteOutline, danger: true, onClick: () => setModal({ kind: 'delete', path }) },
      { type: 'divider' }
    ]
    if (node.type === 'file' && isTexFile(node.name) && path !== rootDoc) {
      entries.push({
        label: 'Set as main document',
        onClick: () => void ide().setRootDoc(path).catch(notifyError)
      })
    }
    entries.push({
      label: REVEAL,
      onClick: () => projectId && void window.api.files.reveal(projectId, path)
    })
    entries.push({ type: 'divider' }, ...create)
    return entries
  }

  // ---- drag and drop: move entries inside the tree, or drop files from the OS
  const acceptsDrop = (e: React.DragEvent): boolean => {
    const types = Array.from(e.dataTransfer.types)
    return types.includes(DRAG_TYPE) || types.includes('Files')
  }

  const onDropInto = (e: React.DragEvent, folder: string): void => {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    const moved = e.dataTransfer.getData(DRAG_TYPE)
    if (moved) {
      if (moved === folder || folder.startsWith(moved + '/')) return
      void ide().moveEntry(moved, folder).catch(notifyError)
      return
    }
    const sources = Array.from(e.dataTransfer.files)
      .map((f) => window.api.app.pathForFile(f))
      .filter(Boolean)
    if (sources.length > 0) void finishImport(folder, sources, false).catch(notifyError)
  }

  const renderNode = (node: FileNode, depth: number): React.JSX.Element => {
    const isFolder = node.type === 'folder'
    const isOpen = isFolder && !!expanded[node.path]
    const dropFolder = isFolder ? node.path : dirName(node.path)
    return (
      <li key={node.path} role="none">
        <div
          role="treeitem"
          aria-expanded={isFolder ? isOpen : undefined}
          aria-selected={selected === node.path}
          tabIndex={-1}
          className={cx(
            'tree-item',
            selected === node.path && 'selected',
            openPath === node.path && 'open',
            isFolder && dropTarget === node.path && 'drop-target'
          )}
          style={{ paddingLeft: 8 + depth * 16 }}
          draggable={renaming !== node.path}
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_TYPE, node.path)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragOver={(e) => {
            if (!acceptsDrop(e)) return
            e.preventDefault()
            e.stopPropagation()
            setDropTarget(dropFolder)
          }}
          onDrop={(e) => onDropInto(e, dropFolder)}
          onClick={() => {
            if (isFolder) {
              ide().select(node.path)
              ide().toggleFolder(node.path)
            } else {
              void ide().openFile(node.path)
            }
          }}
          onDoubleClick={() => !isFolder && setRenaming(node.path)}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation() // the surrounding panel has its own menu for empty space
            ide().select(node.path)
            setMenu({ x: e.clientX, y: e.clientY, path: node.path })
          }}
        >
          <span className="tree-chevron">
            {isFolder && <Icon path={isOpen ? mdiChevronDown : mdiChevronRight} size={16} />}
          </span>
          <Icon path={iconFor(node, isOpen)} size={16} className="tree-icon" />
          {renaming === node.path ? (
            <RenameInput initial={node.name} onCommit={(name) => void commitRename(node.path, name)} onCancel={() => setRenaming(null)} />
          ) : (
            <span className="tree-name truncate" title={node.name}>
              {node.name}
            </span>
          )}
          {node.path === rootDoc && renaming !== node.path && (
            <span className="tree-badge" title="Main document: this file is compiled">
              main
            </span>
          )}
        </div>
        {isFolder && isOpen && node.children && node.children.length > 0 && (
          <ul role="group">{node.children.map((child) => renderNode(child, depth + 1))}</ul>
        )}
      </li>
    )
  }

  const selectedNode = selected ? findNode(tree, selected) : null

  return (
    <div className="tree-panel">
      <div className="tree-toolbar">
        <button type="button" className="icon-btn" title="New file" onClick={() => setModal({ kind: 'new-file', folder: targetFolder() })}>
          <Icon path={mdiFilePlusOutline} />
        </button>
        <button type="button" className="icon-btn" title="New folder" onClick={() => setModal({ kind: 'new-folder', folder: targetFolder() })}>
          <Icon path={mdiFolderPlusOutline} />
        </button>
        <button type="button" className="icon-btn" title="Upload files" onClick={() => void upload(targetFolder())}>
          <Icon path={mdiTrayArrowUp} />
        </button>
        <span className="tree-toolbar-gap" />
        {selectedNode && (
          <>
            <button type="button" className="icon-btn" title="Rename" onClick={() => setRenaming(selectedNode.path)}>
              <Icon path={mdiPencilOutline} />
            </button>
            <button type="button" className="icon-btn" title="Delete" onClick={() => setModal({ kind: 'delete', path: selectedNode.path })}>
              <Icon path={mdiDeleteOutline} />
            </button>
          </>
        )}
      </div>

      <div
        className={cx('tree-scroll', dropTarget === '' && 'drop-target')}
        onDragOver={(e) => {
          if (!acceptsDrop(e)) return
          e.preventDefault()
          setDropTarget('')
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null)
        }}
        onDrop={(e) => onDropInto(e, '')}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, path: null })
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) ide().select(null)
        }}
        onKeyDown={(e) => {
          if (!selected || renaming) return
          if (e.key === 'F2') setRenaming(selected)
          else if (e.key === 'Delete') setModal({ kind: 'delete', path: selected })
        }}
        tabIndex={0}
      >
        <ul role="tree" className="tree-root">
          {tree.map((node) => renderNode(node, 0))}
        </ul>
        {tree.length === 0 && <div className="tree-empty">This project has no files yet.</div>}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.path)} onClose={() => setMenu(null)} />}

      {modal?.kind === 'new-file' && (
        <PromptModal
          title="New File"
          label="File Name"
          initialValue="name.tex"
          confirmLabel="Create"
          hint={modal.folder ? `Created in ${modal.folder}/` : undefined}
          onClose={() => setModal(null)}
          onSubmit={(name) => ide().createFile(modal.folder, name)}
        />
      )}

      {modal?.kind === 'new-folder' && (
        <PromptModal
          title="New Folder"
          label="Folder Name"
          placeholder="Folder name"
          confirmLabel="Create"
          hint={modal.folder ? `Created in ${modal.folder}/` : undefined}
          onClose={() => setModal(null)}
          onSubmit={(name) => ide().createFolder(modal.folder, name)}
        />
      )}

      {modal?.kind === 'delete' && (
        <ConfirmModal
          key={modal.permanently ? 'permanently' : 'to-trash'}
          title={modal.permanently ? `Delete ${baseName(modal.path)} permanently?` : `Delete ${baseName(modal.path)}`}
          confirmLabel={modal.permanently ? 'Delete permanently' : 'Delete'}
          danger
          onClose={() => setModal(null)}
          onConfirm={async () => {
            if (await ide().deleteEntry(modal.path, modal.permanently === true)) return true
            // There is no trash for this location. Nothing was deleted; ask
            // again, saying what deleting means here.
            setModal({ kind: 'delete', path: modal.path, permanently: true })
            return false
          }}
        >
          {modal.permanently ? (
            <p>
              <strong>{baseName(modal.path)}</strong> cannot be moved to the {TRASH} from where it is
              stored (a network drive, for example). Deleting it removes it for good.
            </p>
          ) : (
            <p>
              Are you sure you want to delete <strong>{baseName(modal.path)}</strong>? It will be moved to
              the {TRASH}.
            </p>
          )}
        </ConfirmModal>
      )}

      {modal?.kind === 'overwrite' && (
        <ConfirmModal
          title="Replace existing files?"
          confirmLabel="Replace"
          onClose={() => setModal(null)}
          onConfirm={() => finishImport(modal.folder, modal.sources, true)}
        >
          <p>These files already exist in the project and will be replaced:</p>
          <ul className="plain-list selectable">
            {modal.conflicts.slice(0, 8).map((c) => (
              <li key={c}>{c}</li>
            ))}
            {modal.conflicts.length > 8 && <li>… and {modal.conflicts.length - 8} more</li>}
          </ul>
        </ConfirmModal>
      )}
    </div>
  )
}

function RenameInput({
  initial,
  onCommit,
  onCancel
}: {
  initial: string
  onCommit: (name: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    // Select the name without its extension, as file managers do.
    const dot = initial.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [initial])

  const finish = (commit: boolean): void => {
    if (done.current) return
    done.current = true
    if (commit) onCommit(ref.current?.value ?? initial)
    else onCancel()
  }

  return (
    <input
      ref={ref}
      className="tree-rename"
      defaultValue={initial}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(true)
        else if (e.key === 'Escape') finish(false)
      }}
      onBlur={() => finish(true)}
    />
  )
}
