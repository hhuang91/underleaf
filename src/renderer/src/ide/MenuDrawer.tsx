import { useEffect, useMemo, useState } from 'react'
import {
  mdiClose,
  mdiCog,
  mdiContentCopy,
  mdiContentSaveOutline,
  mdiCounter,
  mdiCreationOutline,
  mdiFilePdfBox,
  mdiFolderOpenOutline,
  mdiFolderZipOutline,
  mdiHistory,
  mdiKeyboardOutline,
  mdiOpenInNew
} from '@mdi/js'
import {
  COMPILERS,
  type Compiler,
  type EditorFontFamily,
  type EditorSettings,
  type FileNode,
  type Keybindings,
  type LineHeight,
  type OverallTheme,
  type WordCount
} from '@shared/types'
import { isTexFile } from '@shared/fileTypes'
import { Icon } from '../components/Icon'
import { Modal, PromptModal } from '../components/Modal'
import { engineSummary } from '../components/SettingsModal'
import { editor } from '../editor/controller'
import { EDITOR_THEMES } from '../editor/themes'
import { errorMessage, isMac, MOD } from '../lib/util'
import { notifyError, useApp, useSettings } from '../stores/app'
import { useAssistant } from '../stores/assistant'
import { useIde } from '../stores/ide'

function texFiles(nodes: FileNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === 'file' && isTexFile(n.name)) out.push(n.path)
    if (n.children) texFiles(n.children, out)
  }
  return out
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="menu-row">
      <span>{label}</span>
      {children}
    </label>
  )
}

function OnOff({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <select className="select select-sm" value={value ? 'on' : 'off'} onChange={(e) => onChange(e.target.value === 'on')}>
      <option value="on">On</option>
      <option value="off">Off</option>
    </select>
  )
}

export function WordCountModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const projectId = useIde((s) => s.projectId)
  const [count, setCount] = useState<WordCount | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) return
    window.api.projects
      .wordCount(projectId)
      .then(setCount)
      .catch((err: unknown) => setError(errorMessage(err)))
  }, [projectId])

  return (
    <Modal
      title="Word Count"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
      }
    >
      {error && <p className="form-error">{error}</p>}
      {!count && !error && <p className="muted">Counting…</p>}
      {count && (
        <>
          <dl className="word-count">
            <dt>Total words</dt>
            <dd>{count.words.toLocaleString()}</dd>
            <dt>Headers</dt>
            <dd>{count.headers}</dd>
            <dt>Math inline</dt>
            <dd>{count.mathInline}</dd>
            <dt>Math display</dt>
            <dd>{count.mathDisplay}</dd>
            <dt>Files counted</dt>
            <dd>{count.files}</dd>
          </dl>
          <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
            Counted from the main document and the files it includes. This is an estimate; commands,
            comments and mathematics are not counted as words.
          </p>
        </>
      )}
    </Modal>
  )
}

const HOTKEYS: Array<{ group: string; keys: Array<[string, string]> }> = [
  {
    group: 'Common',
    keys: [
      [`${MOD} + Enter`, 'Recompile'],
      [`${MOD} + S`, 'Recompile'],
      [`${MOD} + F`, 'Find and replace'],
      [`${MOD} + Z`, 'Undo'],
      [isMac ? '⇧ ⌘ Z' : 'Ctrl + Y', 'Redo'],
      [`${MOD} + /`, 'Toggle comment']
    ]
  },
  {
    group: 'Editing',
    keys: [
      [`${MOD} + B`, 'Bold'],
      [`${MOD} + I`, 'Italic'],
      [`${MOD} + Space`, 'Show autocomplete'],
      ['Tab', 'Indent selection / next snippet field'],
      [`${MOD} + D`, 'Select next occurrence'],
      [isMac ? '⌥ ↑ / ↓' : 'Alt + ↑ / ↓', 'Move line up / down']
    ]
  },
  {
    group: 'Navigation',
    keys: [
      [`${MOD} + Shift + L`, 'Go to line'],
      ['Double-click in PDF', 'Jump to the source'],
      [`${MOD} + scroll in PDF`, 'Zoom the PDF']
    ]
  },
  {
    group: 'Versions',
    keys: [
      [`${MOD} + Shift + S`, 'Save a version under a name'],
      [`${MOD} + Shift + H`, 'Show or leave the history']
    ]
  },
  {
    group: 'Writing assistant',
    keys: [
      ['Tab', 'Take the suggestion'],
      [`${MOD} + →`, 'Take its next word'],
      ['Esc', 'Let it go'],
      [isMac ? '⌥ \\' : 'Alt + \\', 'Suggest how the text goes on'],
      [`${MOD} + Shift + P`, 'Proofread the selection or paragraph']
    ]
  }
]

export function HotkeysModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <Modal
      title="Hotkeys"
      wide
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="hotkeys">
        {HOTKEYS.map((g) => (
          <section key={g.group}>
            <h3>{g.group}</h3>
            {g.keys.map(([keys, action]) => (
              <div key={keys} className="hotkey">
                <kbd>{keys}</kbd>
                <span>{action}</span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  )
}

interface MenuDrawerProps {
  onClose: () => void
  onDownloadZip: () => void
  onDownloadPdf: () => void
  onShowHotkeys: () => void
  onShowWordCount: () => void
  onShowEngineSettings: () => void
  onShowHistory: () => void
  onSaveVersion: () => void
}

/** The left-hand "Menu": downloads, project actions and settings. */
export function MenuDrawer(props: MenuDrawerProps): React.JSX.Element {
  const settings = useSettings()
  const tex = useApp((s) => s.tex)
  const patchSettings = useApp((s) => s.patchSettings)
  const navigate = useApp((s) => s.navigate)
  const summary = useIde((s) => s.summary)
  const tree = useIde((s) => s.tree)
  const rootDoc = useIde((s) => s.rootDoc)
  const rootDocExplicit = useIde((s) => s.rootDocExplicit)
  const compiler = useIde((s) => s.compiler)
  const result = useIde((s) => s.result)
  const hasPdf = useIde((s) => s.pdf !== null)
  const projectId = useIde((s) => s.projectId)
  const [copying, setCopying] = useState(false)

  const docs = useMemo(() => texFiles(tree), [tree])
  const engine = engineSummary(tex, settings.engineBackend)
  const usesBuiltIn = result?.engine?.backend === 'tectonic' || (!tex?.system.found && tex?.tectonic.found === true)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !copying) props.onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props, copying])

  const setEditor = (patch: Partial<EditorSettings>): void => void patchSettings({ editor: patch })

  return (
    <>
      <div className="drawer-backdrop" onMouseDown={props.onClose} />
      <aside className="drawer" aria-label="Menu">
        <div className="drawer-header">
          <strong>Menu</strong>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close menu">
            <Icon path={mdiClose} size={20} />
          </button>
        </div>

        <div className="drawer-body">
          <h4>Download</h4>
          <div className="drawer-tiles">
            <button type="button" className="drawer-tile" onClick={props.onDownloadZip}>
              <Icon path={mdiFolderZipOutline} size={28} />
              Source
            </button>
            <button type="button" className="drawer-tile" onClick={props.onDownloadPdf} disabled={!hasPdf}>
              <Icon path={mdiFilePdfBox} size={28} />
              PDF
            </button>
          </div>
          <p className="drawer-hint">
            The source .zip can be uploaded to Overleaf with <em>New Project → Upload Project</em>.
          </p>

          <h4>Versions</h4>
          <button
            type="button"
            className="drawer-link"
            onClick={() => {
              props.onClose()
              props.onSaveVersion()
            }}
          >
            <Icon path={mdiContentSaveOutline} />
            Save Version…
          </button>
          <button
            type="button"
            className="drawer-link"
            onClick={() => {
              props.onClose()
              props.onShowHistory()
            }}
          >
            <Icon path={mdiHistory} />
            History
          </button>

          <h4>Actions</h4>
          <button type="button" className="drawer-link" onClick={() => setCopying(true)}>
            <Icon path={mdiContentCopy} />
            Copy Project
          </button>
          <button type="button" className="drawer-link" onClick={props.onShowWordCount}>
            <Icon path={mdiCounter} />
            Word Count
          </button>
          {settings.assistant.enabled && (
            <button
              type="button"
              className="drawer-link"
              onClick={() => {
                props.onClose()
                void useAssistant.getState().proofread()
              }}
            >
              <Icon path={mdiCreationOutline} />
              Proofread Selection
            </button>
          )}
          <button
            type="button"
            className="drawer-link"
            onClick={() => projectId && void window.api.projects.reveal(projectId)}
          >
            <Icon path={mdiFolderOpenOutline} />
            {isMac ? 'Reveal Project in Finder' : 'Show Project Folder'}
          </button>

          <h4>Settings</h4>
          <Row label="Compiler">
            <select
              className="select select-sm"
              value={compiler}
              onChange={(e) => void useIde.getState().setCompiler(e.target.value as Compiler).catch(notifyError)}
            >
              {COMPILERS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </Row>
          {usesBuiltIn && (
            <p className="drawer-hint">
              The built-in engine is XeTeX-based and is used for every compiler choice. Install TeX
              Live, MacTeX or MiKTeX for pdfLaTeX and LuaLaTeX.
            </p>
          )}
          <Row label="TeX engine">
            <button type="button" className="btn btn-secondary btn-sm drawer-engine" onClick={props.onShowEngineSettings}>
              <Icon path={mdiCog} size={16} />
              <span className="truncate">{engine.text}</span>
            </button>
          </Row>
          <Row label="Writing assistant">
            <button type="button" className="btn btn-secondary btn-sm drawer-engine" onClick={props.onShowEngineSettings}>
              <Icon path={mdiCog} size={16} />
              <span className="truncate">
                {settings.assistant.enabled ? settings.assistant.model || 'On, no model chosen' : 'Off'}
              </span>
            </button>
          </Row>
          <Row label="Main document">
            <select
              className="select select-sm"
              value={rootDocExplicit && rootDoc ? rootDoc : ''}
              onChange={(e) => void useIde.getState().setRootDoc(e.target.value || null).catch(notifyError)}
            >
              <option value="">{rootDoc && !rootDocExplicit ? `Automatic (${rootDoc})` : 'Automatic'}</option>
              {docs.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Spell check">
            <OnOff value={settings.editor.spellCheck} onChange={(v) => setEditor({ spellCheck: v })} />
          </Row>
          <Row label="Auto-complete">
            <OnOff value={settings.editor.autoComplete} onChange={(v) => setEditor({ autoComplete: v })} />
          </Row>
          <Row label="Auto-close brackets">
            <OnOff value={settings.editor.autoCloseBrackets} onChange={(v) => setEditor({ autoCloseBrackets: v })} />
          </Row>
          <Row label="Code check">
            <OnOff value={settings.editor.codeCheck} onChange={(v) => setEditor({ codeCheck: v })} />
          </Row>
          <Row label="Editor theme">
            <select className="select select-sm" value={settings.editor.theme} onChange={(e) => setEditor({ theme: e.target.value })}>
              {EDITOR_THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Overall theme">
            <select
              className="select select-sm"
              value={settings.overallTheme}
              onChange={(e) => void patchSettings({ overallTheme: e.target.value as OverallTheme })}
            >
              <option value="default">Default</option>
              <option value="light">Light</option>
            </select>
          </Row>
          <Row label="Keybindings">
            <select
              className="select select-sm"
              value={settings.editor.keybindings}
              onChange={(e) => setEditor({ keybindings: e.target.value as Keybindings })}
            >
              <option value="default">None</option>
              <option value="vim">Vim</option>
              <option value="emacs">Emacs</option>
            </select>
          </Row>
          <Row label="Font size">
            <select
              className="select select-sm"
              value={settings.editor.fontSize}
              onChange={(e) => setEditor({ fontSize: Number(e.target.value) })}
            >
              {[10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24].map((n) => (
                <option key={n} value={n}>
                  {n}px
                </option>
              ))}
            </select>
          </Row>
          <Row label="Font family">
            <select
              className="select select-sm"
              value={settings.editor.fontFamily}
              onChange={(e) => setEditor({ fontFamily: e.target.value as EditorFontFamily })}
            >
              <option value="monaco">Monaco / Menlo / Consolas</option>
              <option value="lucida">Lucida / Source Code Pro</option>
            </select>
          </Row>
          <Row label="Line height">
            <select
              className="select select-sm"
              value={settings.editor.lineHeight}
              onChange={(e) => setEditor({ lineHeight: e.target.value as LineHeight })}
            >
              <option value="compact">Compact</option>
              <option value="normal">Normal</option>
              <option value="wide">Wide</option>
            </select>
          </Row>

          <h4>Help</h4>
          <button type="button" className="drawer-link" onClick={props.onShowHotkeys}>
            <Icon path={mdiKeyboardOutline} />
            Show Hotkeys
          </button>
          <button
            type="button"
            className="drawer-link"
            onClick={() => void window.api.app.openExternal('https://www.overleaf.com/learn')}
          >
            <Icon path={mdiOpenInNew} />
            LaTeX Documentation
          </button>
        </div>
      </aside>

      {copying && summary && (
        <PromptModal
          title="Copy Project"
          label="New Name"
          initialValue={`${summary.name} (Copy)`}
          confirmLabel="Copy"
          onClose={() => setCopying(false)}
          onSubmit={async (name) => {
            // Copy what is on screen, not what was last saved; and since the
            // copy is opened next, nothing may be left unsaved here.
            if (!(await editor.flush())) {
              throw new Error('The latest changes could not be saved. Copy the project once they are.')
            }
            const copy = await window.api.projects.copy(summary.id, name)
            props.onClose()
            await useIde.getState().unload()
            navigate({ name: 'project', id: copy.id })
          }}
        />
      )}
    </>
  )
}
