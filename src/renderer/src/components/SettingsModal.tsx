import { useState } from 'react'
import { mdiAlert, mdiCheckCircle, mdiRefresh } from '@mdi/js'
import type { EngineBackend, TexStatus } from '@shared/types'
import { useApp, useSettings } from '../stores/app'
import { AssistantSettings } from './AssistantSettings'
import { Icon } from './Icon'
import { Modal } from './Modal'

/** One-line description of what will compile documents with the current settings. */
export function engineSummary(tex: TexStatus | null, backend: EngineBackend): { ok: boolean; text: string } {
  if (!tex) return { ok: true, text: 'Detecting TeX…' }
  const system = tex.system.found ? `${tex.system.distribution ?? 'TeX'}${tex.system.hasLatexmk ? ' · latexmk' : ''}` : null
  if (backend === 'system') {
    return system ? { ok: true, text: system } : { ok: false, text: 'No TeX distribution found' }
  }
  if (backend === 'tectonic') {
    return tex.tectonic.found ? { ok: true, text: 'Built-in engine' } : { ok: false, text: 'Built-in engine missing' }
  }
  if (system) return { ok: true, text: system }
  if (tex.tectonic.found) return { ok: true, text: 'Built-in engine' }
  return { ok: false, text: 'No TeX engine found' }
}

interface SettingsModalProps {
  onClose: () => void
  /** Opened from inside a project: the library cannot be moved from under it. */
  insideProject?: boolean
}

export function SettingsModal({ onClose, insideProject }: SettingsModalProps): React.JSX.Element {
  const settings = useSettings()
  const tex = useApp((s) => s.tex)
  const patchSettings = useApp((s) => s.patchSettings)
  const refreshTex = useApp((s) => s.refreshTex)
  const [detecting, setDetecting] = useState(false)

  const chooseLibrary = async (): Promise<void> => {
    const dir = await window.api.app.chooseDirectory('Choose the folder that holds your projects')
    if (dir) await patchSettings({ libraryPath: dir })
  }

  const chooseTexBin = async (): Promise<void> => {
    const dir = await window.api.app.chooseDirectory('Choose the folder that contains pdflatex and latexmk')
    if (!dir) return
    await patchSettings({ texBinPath: dir })
    await redetect()
  }

  const redetect = async (): Promise<void> => {
    setDetecting(true)
    try {
      await refreshTex(true)
    } finally {
      setDetecting(false)
    }
  }

  return (
    <Modal
      title="Settings"
      wide
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <section className="settings-section">
        <h3>Project library</h3>
        <p className="muted">
          Every project is an ordinary folder inside this directory. Folders you copy here (or clone
          with git) appear in the project list automatically.
        </p>
        <div className="settings-path selectable">{settings.libraryPath}</div>
        <div className="settings-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void chooseLibrary()}
            disabled={insideProject}
            title={insideProject ? 'Go back to the project list to choose another library folder' : undefined}
          >
            Change…
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void window.api.app.showItemInFolder(settings.libraryPath)}
          >
            Open folder
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h3>TeX engine</h3>
        <div className="field">
          <label htmlFor="engine-backend">Compile with</label>
          <select
            id="engine-backend"
            className="select"
            value={settings.engineBackend}
            onChange={(e) => void patchSettings({ engineBackend: e.target.value as EngineBackend })}
          >
            <option value="auto">Automatic (installed TeX if available, otherwise built-in)</option>
            <option value="system">Installed TeX distribution (TeX Live, MacTeX, MiKTeX)</option>
            <option value="tectonic">Built-in engine (Tectonic)</option>
          </select>
          <div className="hint">
            An installed distribution behaves exactly like Overleaf (pdfLaTeX, XeLaTeX, LuaLaTeX via
            latexmk). The built-in engine needs no installation: it is XeTeX-based and downloads
            packages the first time a document uses them.
          </div>
        </div>

        <div className="engine-status">
          <div className={tex?.system.found ? 'ok' : 'missing'}>
            <Icon path={tex?.system.found ? mdiCheckCircle : mdiAlert} size={18} />
            <div>
              <strong>Installed TeX: </strong>
              {tex === null
                ? 'detecting…'
                : tex.system.found
                  ? `${tex.system.distribution} ${tex.system.hasLatexmk ? 'with latexmk' : '(latexmk unavailable, using the built-in build driver)'}`
                  : 'not found'}
              {tex?.system.binDir && <div className="settings-path small selectable">{tex.system.binDir}</div>}
            </div>
          </div>
          <div className={tex?.tectonic.found ? 'ok' : 'missing'}>
            <Icon path={tex?.tectonic.found ? mdiCheckCircle : mdiAlert} size={18} />
            <div>
              <strong>Built-in engine: </strong>
              {tex === null ? 'detecting…' : tex.tectonic.found ? 'available' : 'not included in this build'}
            </div>
          </div>
        </div>

        <div className="settings-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void redetect()} disabled={detecting}>
            <Icon path={mdiRefresh} size={16} spin={detecting} />
            Detect again
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void chooseTexBin()}>
            Locate TeX manually…
          </button>
          {settings.texBinPath && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void patchSettings({ texBinPath: '' }).then(redetect)}
            >
              Reset location
            </button>
          )}
        </div>
      </section>

      <section className="settings-section">
        <h3>Version history</h3>
        <p className="muted">
          Versions of a project are kept in a git repository inside its folder. Save one under a name whenever
          you like; Underleaf can also save them by itself while you work.
        </p>
        <label className="settings-toggle">
          <span className="switch">
            <input
              type="checkbox"
              checked={settings.history.auto}
              onChange={(e) => void patchSettings({ history: { auto: e.target.checked } })}
            />
            <span className="track" />
          </span>
          Save versions automatically
        </label>
        <div className="settings-numbers">
          <div className="field">
            <label htmlFor="history-edits">Save a version after this many edits</label>
            <NumberInput
              id="history-edits"
              value={settings.history.editsPerVersion}
              min={1}
              max={1000}
              disabled={!settings.history.auto}
              onCommit={(n) => void patchSettings({ history: { editsPerVersion: n } })}
            />
          </div>
          <div className="field">
            <label htmlFor="history-pause">Seconds without a change that end an edit</label>
            <NumberInput
              id="history-pause"
              value={settings.history.editPauseSeconds}
              min={1}
              max={600}
              disabled={!settings.history.auto}
              onCommit={(n) => void patchSettings({ history: { editPauseSeconds: n } })}
            />
          </div>
        </div>
        <div className="hint">
          Typing, a pause, and typing again are two edits; keystrokes are not counted one by one. A version is
          also saved when a project is opened or closed with changes, and before anything replaces its files.
        </div>
      </section>

      <AssistantSettings />
    </Modal>
  )
}

/** A whole number that is applied when the field is left (or Enter is pressed), within its limits. */
function NumberInput(props: {
  id: string
  value: number
  min: number
  max: number
  disabled?: boolean
  onCommit: (value: number) => void
}): React.JSX.Element {
  const [text, setText] = useState(String(props.value))
  const [shown, setShown] = useState(props.value)
  // Follow a value that changed elsewhere (it is clamped when it is saved).
  if (shown !== props.value) {
    setShown(props.value)
    setText(String(props.value))
  }
  const commit = (): void => {
    const n = Math.round(Number(text))
    if (!Number.isFinite(n)) {
      setText(String(props.value))
      return
    }
    const clamped = Math.min(props.max, Math.max(props.min, n))
    setText(String(clamped))
    if (clamped !== props.value) props.onCommit(clamped)
  }
  return (
    <input
      id={props.id}
      className="input settings-number"
      type="number"
      inputMode="numeric"
      min={props.min}
      max={props.max}
      value={text}
      disabled={props.disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}
