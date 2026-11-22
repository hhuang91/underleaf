// The History screen: the project's versions on the right, the files that
// differ on the left, and the differences of one file in between.

import { useEffect, useMemo, useRef, useState } from 'react'
import { unifiedMergeView } from '@codemirror/merge'
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import {
  mdiArrowLeft,
  mdiClockOutline,
  mdiContentSaveOutline,
  mdiFileRestoreOutline,
  mdiLoading,
  mdiRestore,
  mdiTagOutline
} from '@mdi/js'
import type { HistoryList, RestoreResult, VersionChange, VersionFile, VersionInfo } from '@shared/types'
import { Icon } from '../components/Icon'
import { ConfirmModal, Modal, PromptModal } from '../components/Modal'
import { languageFor } from '../editor/controller'
import { editorTheme } from '../editor/themes'
import { baseName, cx, dirName, formatBytes, formatDateTime } from '../lib/util'
import { useApp, useSettings } from '../stores/app'
import { useHistory, type CompareMode, type RestoreReport } from '../stores/history'

const STATUS_WORD: Record<VersionChange['status'], string> = { added: 'new', modified: 'edited', deleted: 'deleted' }

function dayLabel(time: number, now: number): string {
  const startOfDay = (ms: number): number => {
    const d = new Date(ms)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const days = Math.round((startOfDay(now) - startOfDay(time)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear()
  return new Date(time).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: sameYear ? undefined : 'numeric'
  })
}

function timeLabel(time: number): string {
  return new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function byLine(version: VersionInfo, repository: HistoryList['repository']): string {
  if (version.kind === 'auto') return 'Automatic'
  // In a repository of the user's own, the commits of its branch are theirs.
  if (version.onBranch && repository === 'yours') return `Commit by ${version.author}`
  return `Saved by ${version.author}`
}

/** The two sides of a comparison, in words. */
function sides(compare: CompareMode): { before: string; after: string } {
  return compare === 'previous'
    ? { before: 'Before this version', after: 'In this version' }
    : { before: 'In this version', after: 'Now' }
}

function TextDiff({ file, path }: { file: Extract<VersionFile, { kind: 'text' }>; path: string }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const { theme, fontSize, fontFamily, lineHeight } = useSettings().editor

  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: file.after ?? '',
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          lineNumbers(),
          EditorView.lineWrapping,
          languageFor(path),
          editorTheme(theme, { fontSize, fontFamily, lineHeight }),
          unifiedMergeView({
            original: file.before ?? '',
            mergeControls: false,
            gutter: true,
            highlightChanges: true,
            collapseUnchanged: { margin: 3, minSize: 8 }
          })
        ]
      })
    })
    return () => view.destroy()
  }, [file, path, theme, fontSize, fontFamily, lineHeight])

  return <div ref={host} className="history-text selectable" />
}

function ImageDiff({ file, compare }: { file: Extract<VersionFile, { kind: 'image' }>; compare: CompareMode }): React.JSX.Element {
  const [urls, setUrls] = useState<{ before: string | null; after: string | null }>({ before: null, after: null })
  useEffect(() => {
    const make = (bytes: Uint8Array | null): string | null =>
      bytes ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.mime })) : null
    const next = { before: make(file.before), after: make(file.after) }
    setUrls(next)
    return () => {
      if (next.before) URL.revokeObjectURL(next.before)
      if (next.after) URL.revokeObjectURL(next.after)
    }
  }, [file])
  const labels = sides(compare)
  const side = (label: string, url: string | null, bytes: Uint8Array | null): React.JSX.Element => (
    <figure className="history-image">
      <figcaption>
        {label}
        {bytes && <span className="muted"> · {formatBytes(bytes.length)}</span>}
      </figcaption>
      {url ? <img src={url} alt={label} draggable={false} /> : <div className="history-image-none muted">No such file</div>}
    </figure>
  )
  return (
    <div className="history-images">
      {side(labels.before, urls.before, file.before)}
      {side(labels.after, urls.after, file.after)}
    </div>
  )
}

function Timeline({ list, selected, onSelect }: { list: HistoryList; selected: string | null; onSelect: (id: string) => void }): React.JSX.Element {
  const groups = useMemo(() => {
    const now = Date.now()
    const out: Array<{ day: string; versions: VersionInfo[] }> = []
    for (const v of list.versions) {
      const day = dayLabel(v.time, now)
      if (out.length === 0 || out[out.length - 1].day !== day) out.push({ day, versions: [] })
      out[out.length - 1].versions.push(v)
    }
    return out
  }, [list])

  return (
    <div className="history-versions">
      {groups.map((group) => (
        <section key={group.day}>
          <h4>{group.day}</h4>
          <ul>
            {group.versions.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  className={cx('version', v.kind, selected === v.id && 'selected')}
                  onClick={() => onSelect(v.id)}
                  title={formatDateTime(v.time)}
                  aria-pressed={selected === v.id}
                >
                  <Icon path={v.kind === 'auto' ? mdiClockOutline : mdiTagOutline} size={16} className="version-icon" />
                  <span className="version-text">
                    <span className="version-label">{v.label}</span>
                    <span className="version-meta">
                      {timeLabel(v.time)} · {byLine(v, list.repository)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

const LEFT_BECAUSE: Record<RestoreResult['left'][number]['reason'], string> = {
  unversioned:
    'Not replaced, because Underleaf keeps no versions of what is there now (git ignores it, it is too large, or it belongs to another repository), so replacing it could not be undone:',
  lfs: 'Stored with Git LFS, so only git can bring them back:',
  link: 'Symbolic links, which a restore leaves as they are:',
  name: 'Names that cannot be used on this computer:'
}

function PathList({ paths }: { paths: string[] }): React.JSX.Element {
  return (
    <ul className="plain-list selectable">
      {paths.slice(0, 12).map((p) => (
        <li key={p}>{p}</li>
      ))}
      {paths.length > 12 && <li>… and {paths.length - 12} more</li>}
    </ul>
  )
}

/** What a restore did not do, and why. */
function RestoreReportModal({ report, onClose }: { report: RestoreReport; onClose: () => void }): React.JSX.Element {
  const { left, failed } = report.result
  const reasons = (Object.keys(LEFT_BECAUSE) as Array<keyof typeof LEFT_BECAUSE>).filter((r) => left.some((l) => l.reason === r))
  return (
    <Modal
      title="Not everything was restored"
      onClose={onClose}
      footer={
        <button type="button" data-autofocus className="btn btn-primary" onClick={onClose}>
          Close
        </button>
      }
    >
      <p>
        {report.path === null ? (
          <>
            The project was put back the way it was in <strong>{report.label}</strong>, except for the files below.
          </>
        ) : (
          <>
            <strong className="selectable">{report.path}</strong> was left as it is.
          </>
        )}
      </p>
      {reasons.map((reason) => (
        <div key={reason} className="restore-report-group">
          <p className="muted">{LEFT_BECAUSE[reason]}</p>
          <PathList paths={left.filter((l) => l.reason === reason).map((l) => l.path)} />
        </div>
      ))}
      {failed.length > 0 && (
        <div className="restore-report-group">
          <p className="muted">Could not be changed (they may be open in another program, or protected):</p>
          <PathList paths={failed.map((f) => `${f.path} — ${f.message}`)} />
        </div>
      )}
      <p className="muted">How the project was before is saved in the history, so nothing is lost by trying again.</p>
    </Modal>
  )
}

type Dialog =
  | { kind: 'save' }
  // The version is the one that the dialog was opened for, whatever is selected by the time it is confirmed.
  | { kind: 'restore'; version: VersionInfo }
  | { kind: 'restore-file'; version: VersionInfo; path: string }

export function HistoryView(): React.JSX.Element {
  const h = useHistory()
  const notify = useApp((s) => s.notify)
  const [modal, setModal] = useState<Dialog | null>(null)
  const dialogOpen = modal !== null || h.report !== null

  // Escape leaves the screen, unless a dialog is open (which takes it first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented && !dialogOpen) useHistory.getState().hide()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [dialogOpen])

  const version = h.list?.versions.find((v) => v.id === h.selected) ?? null
  const change = h.changes?.find((c) => c.path === h.path) ?? null
  const labels = sides(h.compare)
  // The file can be put back when the selected version has it: on the "after"
  // side when looking at what the version changed, on the "before" side when
  // looking at what changed since.
  const fileInVersion = change !== null && change.status !== (h.compare === 'previous' ? 'deleted' : 'added')
  const empty = h.list !== null && h.list.versions.length === 0

  return (
    <div className="history">
      <aside className="history-files">
        <div className="history-compare" role="group" aria-label="Compare">
          <button
            type="button"
            className={cx(h.compare === 'previous' && 'active')}
            onClick={() => void h.setCompare('previous')}
            title="What this version changed, compared with the one before it"
          >
            In this version
          </button>
          <button
            type="button"
            className={cx(h.compare === 'current' && 'active')}
            onClick={() => void h.setCompare('current')}
            title="What has changed between this version and the project as it is now"
          >
            Since this version
          </button>
        </div>
        <div className="history-changes">
          {h.changesError ? (
            <p className="history-note error selectable">{h.changesError}</p>
          ) : !h.selected ? null : h.changes === null ? (
            <p className="history-note">
              <Icon path={mdiLoading} size={16} spin /> Comparing…
            </p>
          ) : h.changes.length === 0 ? (
            <p className="history-note">
              {h.compare === 'previous'
                ? 'This version is the same as the one before it.'
                : 'The project is exactly as it was in this version.'}
            </p>
          ) : (
            <ul>
              {h.changes.map((c) => (
                <li key={c.path}>
                  <button
                    type="button"
                    className={cx('change', h.path === c.path && 'selected')}
                    onClick={() => void h.selectPath(c.path)}
                    title={c.path}
                  >
                    {/* The name first, so that it is what stays visible in a narrow panel. */}
                    <span className="change-path truncate">
                      {baseName(c.path)}
                      {dirName(c.path) && <span className="change-dir">{dirName(c.path)}</span>}
                    </span>
                    <span className={cx('change-status', c.status)}>{STATUS_WORD[c.status]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <section className="history-diff">
        <header className="history-diff-header">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => h.hide()}>
            <Icon path={mdiArrowLeft} size={16} />
            Back to editor
          </button>
          {h.path && (
            <>
              <strong className="history-diff-path truncate selectable">{h.path}</strong>
              {change && <span className={cx('change-status', change.status)}>{STATUS_WORD[change.status]}</span>}
            </>
          )}
          <span className="history-gap" />
          {h.path && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={!fileInVersion || !version || h.busy}
              onClick={() => version && h.path && setModal({ kind: 'restore-file', version, path: h.path })}
              title={fileInVersion ? 'Put this file back the way it was in the selected version' : 'The selected version has no such file'}
            >
              <Icon path={mdiFileRestoreOutline} size={16} />
              Restore this file
            </button>
          )}
        </header>
        <div className="history-diff-body">
          {h.loading ? (
            <div className="history-placeholder">
              <Icon path={mdiLoading} size={28} spin />
              Reading the history…
            </div>
          ) : h.error ? (
            <div className="history-placeholder">
              <p>The history could not be read.</p>
              <p className="muted selectable">{h.error}</p>
            </div>
          ) : h.list?.repository === 'unsupported' ? (
            <div className="history-placeholder">
              <p>Underleaf cannot keep versions of this project.</p>
              <p className="muted selectable">{h.list.reason}</p>
            </div>
          ) : empty ? (
            <div className="history-placeholder">
              <p>
                <strong>No versions yet</strong>
              </p>
              <p className="muted">
                Save one now with <em>Save version</em>. Underleaf also saves versions by itself while you work, unless
                that is turned off in the settings.
              </p>
            </div>
          ) : h.fileError ? (
            <div className="history-placeholder">
              <p>This file could not be shown.</p>
              <p className="muted selectable">{h.fileError}</p>
            </div>
          ) : h.path && h.file === null ? (
            <div className="history-placeholder">
              <Icon path={mdiLoading} size={28} spin />
            </div>
          ) : h.path && h.file?.kind === 'text' ? (
            <TextDiff file={h.file} path={h.path} />
          ) : h.path && h.file?.kind === 'image' ? (
            <ImageDiff file={h.file} compare={h.compare} />
          ) : h.path && h.file?.kind === 'binary' ? (
            <div className="history-placeholder">
              <p>This file is not text, so its changes cannot be shown.</p>
              <p className="muted">
                {labels.before}: {h.file.before === null ? 'no such file' : formatBytes(h.file.before)} · {labels.after}:{' '}
                {h.file.after === null ? 'no such file' : formatBytes(h.file.after)}
              </p>
            </div>
          ) : h.selected && h.changes?.length === 0 ? (
            <div className="history-placeholder">
              <p className="muted">Nothing differs.</p>
            </div>
          ) : null}
        </div>
      </section>

      <aside className="history-timeline">
        <header>
          <strong>History</strong>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setModal({ kind: 'save' })}
            disabled={h.list?.repository === 'unsupported' || h.busy}
          >
            <Icon path={mdiContentSaveOutline} size={16} />
            Save version
          </button>
        </header>
        {h.list && <Timeline list={h.list} selected={h.selected} onSelect={(id) => void h.select(id)} />}
        {h.list?.more && (
          <button type="button" className="btn btn-ghost btn-sm history-more" onClick={() => void h.loadMore()}>
            Show older versions
          </button>
        )}
        {h.list?.repository === 'yours' && (
          <p className="history-repo-note">
            This folder is a git repository of your own. Underleaf keeps its versions beside your branches and never
            commits to them.
          </p>
        )}
        <footer>
          <button
            type="button"
            className="btn btn-secondary btn-block"
            disabled={!version || h.busy}
            onClick={() => version && setModal({ kind: 'restore', version })}
          >
            <Icon path={h.busy ? mdiLoading : mdiRestore} size={18} spin={h.busy} />
            Restore this version
          </button>
        </footer>
      </aside>

      {modal?.kind === 'save' && (
        <PromptModal
          title="Save version"
          label="Name of the version"
          placeholder="For example: Sent to co-authors"
          confirmLabel="Save"
          hint="The project is saved as it is now. You can come back to it, or compare with it, at any time."
          onClose={() => setModal(null)}
          onSubmit={async (label) => {
            const saved = await useHistory.getState().saveVersion(label)
            notify('success', `Saved the version "${saved.label}".`)
          }}
        />
      )}
      {modal?.kind === 'restore' && (
        <ConfirmModal
          title="Restore this version?"
          confirmLabel="Restore"
          onClose={() => setModal(null)}
          onConfirm={() => useHistory.getState().restore(modal.version.id, null)}
        >
          <p>
            Every file of the project is put back the way it was in <strong>{modal.version.label}</strong> (
            {formatDateTime(modal.version.time)}). Files that were added since then are removed.
          </p>
          <p className="muted">
            The project as it is now is saved as a version first, so you can return to it from this screen. Files that
            Underleaf keeps no versions of (those that git ignores, for one) are left as they are.
          </p>
        </ConfirmModal>
      )}
      {modal?.kind === 'restore-file' && (
        <ConfirmModal
          title="Restore this file?"
          confirmLabel="Restore"
          onClose={() => setModal(null)}
          onConfirm={() => useHistory.getState().restore(modal.version.id, modal.path)}
        >
          <p>
            <strong className="selectable">{modal.path}</strong> is put back the way it was in{' '}
            <strong>{modal.version.label}</strong> ({formatDateTime(modal.version.time)}). The rest of the project stays
            as it is.
          </p>
          <p className="muted">The project as it is now is saved as a version first.</p>
        </ConfirmModal>
      )}
      {h.report && modal === null && (
        <RestoreReportModal report={h.report} onClose={() => useHistory.getState().dismissReport()} />
      )}
    </div>
  )
}

/** The dialog for saving a version, for use outside the History screen. */
export function SaveVersionModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const notify = useApp((s) => s.notify)
  return (
    <PromptModal
      title="Save version"
      label="Name of the version"
      placeholder="For example: Sent to co-authors"
      confirmLabel="Save"
      hint="The project is saved as it is now. You find it under History, where you can compare with it or go back to it."
      onClose={onClose}
      onSubmit={async (label) => {
        const saved = await useHistory.getState().saveVersion(label)
        notify('success', `Saved the version "${saved.label}".`)
      }}
    />
  )
}
