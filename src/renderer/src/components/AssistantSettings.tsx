// Settings → Writing assistant: which model server to use, and when.

import { useEffect, useRef, useState } from 'react'
import { mdiAlertOutline, mdiCheckCircle, mdiLoading, mdiMagnifyScan, mdiRefresh } from '@mdi/js'
import type { DetectedServer, InlineSuggestions } from '@shared/types'
import { errorMessage, isMac } from '../lib/util'
import { useApp, useSettings } from '../stores/app'
import { Icon } from './Icon'

/** Whether an address points at this computer (the same rule as in the main process). */
function isLocal(address: string): boolean {
  const text = address.trim()
  if (!text) return true
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`)
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host === '::'
    )
  } catch {
    return true
  }
}

type Check = { state: 'running' } | { state: 'ok'; text: string } | { state: 'failed'; text: string } | null

export function AssistantSettings(): React.JSX.Element {
  const settings = useSettings().assistant
  const patchSettings = useApp((s) => s.patchSettings)
  const [url, setUrl] = useState(settings.url)
  const [model, setModel] = useState(settings.model)
  const [models, setModels] = useState<string[]>([])
  const [key, setKey] = useState('')
  /** For which server a key is stored (it is sent to that one only). */
  const [keyFor, setKeyFor] = useState<{ origin: string | null; forThisServer: boolean }>({ origin: null, forThisServer: false })
  const [found, setFound] = useState<DetectedServer[] | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [check, setCheck] = useState<Check>(null)
  const latest = useRef(0)

  // Whenever the address changes: which key goes with it, and the models of the server.
  useEffect(() => {
    void window.api.assistant.keyStatus().then(setKeyFor, () => setKeyFor({ origin: null, forThisServer: false }))
    if (!settings.url) {
      setModels([])
      return
    }
    const mine = ++latest.current
    window.api.assistant.models().then(
      (list) => mine === latest.current && setModels(list),
      () => mine === latest.current && setModels([])
    )
  }, [settings.url, keyFor.forThisServer])

  const save = async (patch: { url?: string; model?: string }): Promise<void> => {
    await patchSettings({ assistant: patch })
    setCheck(null)
  }

  /** Uses a server that was found; its first model too, unless the chosen one is among its models. */
  const chooseServer = async (server: DetectedServer): Promise<void> => {
    setUrl(server.url)
    const keep = server.models.includes(model)
    const next = keep ? model : (server.models[0] ?? '')
    setModel(next)
    await save({ url: server.url, model: next })
  }

  const detect = async (): Promise<DetectedServer[]> => {
    setDetecting(true)
    try {
      const servers = await window.api.assistant.detect()
      setFound(servers)
      return servers
    } catch {
      setFound([])
      return []
    } finally {
      setDetecting(false)
    }
  }

  const turnOn = async (on: boolean): Promise<void> => {
    await patchSettings({ assistant: { enabled: on } })
    // The first time: look for a server, and take the first that has a model.
    if (on && !settings.url) {
      const servers = await detect()
      const usable = servers.find((s) => s.models.length > 0) ?? servers[0]
      if (usable) await chooseServer(usable)
    }
  }

  const test = async (): Promise<void> => {
    setCheck({ state: 'running' })
    try {
      const result = await window.api.assistant.check()
      setModels(result.models)
      setCheck({ state: 'ok', text: `${result.model} answered in ${(result.ms / 1000).toFixed(1)} s.` })
    } catch (err) {
      setCheck({ state: 'failed', text: errorMessage(err) })
    }
  }

  const saveKey = async (value: string): Promise<void> => {
    setKey('')
    try {
      await window.api.assistant.setKey(value)
      setCheck(null)
    } catch (err) {
      setCheck({ state: 'failed', text: errorMessage(err) })
    }
    setKeyFor(await window.api.assistant.keyStatus())
  }

  const chooseModel = (next: string): void => {
    setModel(next)
    if (next !== settings.model) void save({ model: next })
  }

  const remote = settings.url && !isLocal(settings.url)
  const unencrypted = remote && /^\s*http:\/\//i.test(settings.url)

  return (
    <section className="settings-section assistant-settings">
      <h3>Writing assistant</h3>
      <p className="muted">
        Suggestions from a language model that you run yourself, for instance with Ollama, LM Studio or llama.cpp.
        Underleaf includes no model: it talks to the server you choose, through its OpenAI-compatible API.
      </p>
      <label className="settings-toggle">
        <span className="switch">
          <input type="checkbox" checked={settings.enabled} onChange={(e) => void turnOn(e.target.checked)} />
          <span className="track" />
        </span>
        Use a language model
      </label>
      <div className="hint">While this is off, nothing of your projects is sent anywhere.</div>

      <div className="field">
        <label htmlFor="assistant-url">Server address</label>
        <div className="settings-inline">
          <input
            id="assistant-url"
            className="input"
            placeholder="http://localhost:11434/v1"
            spellCheck={false}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => url.trim() !== settings.url && void save({ url: url.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void detect()} disabled={detecting}>
            <Icon path={detecting ? mdiLoading : mdiMagnifyScan} size={16} spin={detecting} />
            Find on this computer
          </button>
        </div>
        {found && (
          <div className="assistant-found">
            {found.length === 0 ? (
              <span className="muted">
                No model server answers on this computer at the usual ports. Start one (for instance Ollama or LM
                Studio&apos;s server), or enter its address.
              </span>
            ) : (
              found.map((server) => (
                <button
                  key={server.url}
                  type="button"
                  className="btn btn-ghost btn-sm assistant-server"
                  onClick={() => void chooseServer(server)}
                  title={server.url}
                >
                  {server.name} · {server.url.replace(/^http:\/\//, '')} ·{' '}
                  {server.models.length === 0
                    ? 'no model loaded'
                    : server.models.length === 1
                      ? server.models[0]
                      : `${server.models.length} models`}
                </button>
              ))
            )}
          </div>
        )}
        {remote && (
          <div className="assistant-remote">
            <Icon path={mdiAlertOutline} size={16} />
            <span>
              This server is not on this computer. The text around the cursor, and the passages you proofread, are sent
              to it{unencrypted ? ', over an unencrypted connection' : ''}.
            </span>
          </div>
        )}
      </div>

      <div className="settings-numbers">
        <div className="field">
          <label htmlFor="assistant-model">Model</label>
          <div className="settings-inline">
            {models.length > 0 ? (
              <select id="assistant-model" className="select" value={model} onChange={(e) => chooseModel(e.target.value)}>
                {!models.includes(model) && <option value={model}>{model ? `${model} (not on this server)` : 'Choose a model'}</option>}
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="assistant-model"
                className="input"
                placeholder="The name the server gives it"
                spellCheck={false}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onBlur={() => chooseModel(model.trim())}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm icon-only"
              title="Ask the server for its models again"
              aria-label="Load the list of models again"
              disabled={!settings.url}
              onClick={() => {
                const mine = ++latest.current
                window.api.assistant.models().then(
                  (list) => mine === latest.current && setModels(list),
                  (err: unknown) => mine === latest.current && setCheck({ state: 'failed', text: errorMessage(err) })
                )
              }}
            >
              <Icon path={mdiRefresh} size={16} />
            </button>
          </div>
        </div>
        <div className="field">
          <label htmlFor="assistant-key">API key (if the server wants one)</label>
          <input
            id="assistant-key"
            className="input"
            type="password"
            autoComplete="off"
            disabled={!settings.url}
            placeholder={
              keyFor.forThisServer ? 'A key is stored. Type a new one to replace it.' : 'Not needed for Ollama or LM Studio'
            }
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onBlur={() => key.trim() && void saveKey(key)}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          {keyFor.origin && !keyFor.forThisServer && (
            <div className="hint">The stored key is for {keyFor.origin}. It is not sent to this server.</div>
          )}
          {keyFor.origin && (
            <button type="button" className="btn btn-ghost btn-sm assistant-key-remove" onClick={() => void saveKey('')}>
              Remove the stored key
            </button>
          )}
        </div>
      </div>

      <div className="field">
        <label htmlFor="assistant-inline">Suggest how the text goes on</label>
        <select
          id="assistant-inline"
          className="select"
          value={settings.inline}
          onChange={(e) => void patchSettings({ assistant: { inline: e.target.value as InlineSuggestions } })}
        >
          <option value="auto">When I pause while typing</option>
          <option value="manual">Only when I press {isMac ? '⌥\\' : 'Alt+\\'}</option>
          <option value="off">Never</option>
        </select>
        <div className="hint">
          A suggestion appears in grey after the cursor: Tab takes it, Esc lets it go. To proofread, select a passage
          and press {isMac ? '⌘⇧P' : 'Ctrl+Shift+P'}; the corrections are shown for you to accept or reject. Small
          models are fast; models that think before they answer are slow for suggestions.
        </div>
      </div>

      <div className="settings-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void test()}
          disabled={check?.state === 'running' || !settings.url}
        >
          <Icon path={check?.state === 'running' ? mdiLoading : mdiCheckCircle} size={16} spin={check?.state === 'running'} />
          Test the connection
        </button>
        {check && check.state !== 'running' && (
          <span className={check.state === 'ok' ? 'assistant-check ok' : 'assistant-check failed selectable'}>{check.text}</span>
        )}
        {check?.state === 'running' && (
          <span className="assistant-check muted">Asking the model… (the first time, the server may have to load it)</span>
        )}
      </div>
    </section>
  )
}
