import { useState } from 'react'
import { mdiAlert, mdiAlertCircle, mdiCheckCircle, mdiChevronDown, mdiChevronRight, mdiInformation } from '@mdi/js'
import type { CompileResult, LogEntry, LogLevel } from '@shared/types'
import { Icon } from '../components/Icon'
import { cx } from '../lib/util'
import { notifyError } from '../stores/app'
import { useIde } from '../stores/ide'

const LEVEL_ORDER: LogLevel[] = ['error', 'warning', 'typesetting', 'info']
const LEVEL_ICON: Record<LogLevel, string> = {
  error: mdiAlertCircle,
  warning: mdiAlert,
  typesetting: mdiInformation,
  info: mdiInformation
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function summarise(result: CompileResult): { tone: 'ok' | 'error' | 'warn'; text: string } {
  const { errors, warnings } = result.counts
  switch (result.status) {
    case 'stopped':
      return { tone: 'warn', text: 'Compilation was stopped.' }
    case 'timedout':
      return { tone: 'error', text: 'Compilation timed out.' }
    case 'no-engine':
      return { tone: 'error', text: 'No TeX engine is available.' }
    case 'error':
      return { tone: 'error', text: 'The compiler could not be started.' }
    case 'success':
      return warnings > 0
        ? { tone: 'ok', text: `Compiled successfully with ${plural(warnings, 'warning')}.` }
        : { tone: 'ok', text: 'Compiled successfully.' }
    default:
      return result.hasPdf
        ? { tone: 'error', text: `Compiled with ${plural(Math.max(errors, 1), 'error')}. The PDF may be incomplete.` }
        : { tone: 'error', text: `Compilation failed with ${plural(Math.max(errors, 1), 'error')}. No PDF was produced.` }
  }
}

function Entry({ entry }: { entry: LogEntry }): React.JSX.Element {
  const openFile = useIde((s) => s.openFile)
  const [expanded, setExpanded] = useState(false)
  const long = (entry.content?.length ?? 0) > 400
  const content = entry.content && long && !expanded ? entry.content.slice(0, 400) + '…' : entry.content

  return (
    <div className={cx('log-entry', entry.level)}>
      <div className="log-entry-header">
        <Icon path={LEVEL_ICON[entry.level]} size={18} />
        <span className="log-entry-title selectable">{entry.message}</span>
        {entry.file && (
          <button
            type="button"
            className="log-entry-link"
            title="Go to this location in the source"
            onClick={() => void openFile(entry.file as string, entry.line ? { line: entry.line } : undefined).catch(notifyError)}
          >
            {entry.file}
            {entry.line ? `, ${entry.line}` : ''}
          </button>
        )}
      </div>
      {(content || entry.hint) && (
        <div className="log-entry-body">
          {entry.hint && <p className="log-entry-hint selectable">{entry.hint}</p>}
          {content && <pre className="selectable">{content}</pre>}
          {long && (
            <button type="button" className="btn btn-link" onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function LogsPane(): React.JSX.Element {
  const result = useIde((s) => s.result)
  const compiling = useIde((s) => s.compiling)
  const projectId = useIde((s) => s.projectId)
  const clearCache = useIde((s) => s.clearCache)
  const compile = useIde((s) => s.compile)
  const [rawOpen, setRawOpen] = useState(false)

  if (!result) {
    return (
      <div className="logs-pane">
        <div className="logs-empty muted">{compiling ? 'Compiling…' : 'Compile the project to see its logs.'}</div>
      </div>
    )
  }

  const summary = summarise(result)
  const sorted = [...result.entries].sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level))

  return (
    <div className="logs-pane">
      <div className={cx('logs-summary', summary.tone)}>
        <Icon path={summary.tone === 'ok' ? mdiCheckCircle : summary.tone === 'warn' ? mdiAlert : mdiAlertCircle} size={20} />
        <div>
          <div className="logs-summary-text">{summary.text}</div>
          <div className="logs-summary-meta">
            {result.engine ? `${result.engine.label} · ` : ''}
            {(result.durationMs / 1000).toFixed(1)} s{result.rootDoc ? ` · ${result.rootDoc}` : ''}
          </div>
        </div>
      </div>

      {sorted.map((entry, i) => (
        <Entry key={`${i}:${entry.level}:${entry.message}`} entry={entry} />
      ))}

      {result.rawLog && (
        <div className="log-entry raw">
          <button type="button" className="log-entry-header as-button" onClick={() => setRawOpen(!rawOpen)} aria-expanded={rawOpen}>
            <Icon path={rawOpen ? mdiChevronDown : mdiChevronRight} size={18} />
            <span className="log-entry-title">Raw logs</span>
          </button>
          {rawOpen && (
            <div className="log-entry-body">
              <pre className="selectable raw-log">{result.rawLog}</pre>
            </div>
          )}
        </div>
      )}

      <div className="logs-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={compiling}
          onClick={() => void clearCache().then(() => compile(true)).catch(notifyError)}
          title="Deletes all intermediate files and compiles from scratch"
        >
          Clear cached files
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => projectId && void window.api.compile.openBuildFolder(projectId).catch(notifyError)}
          title="Opens the folder with .log, .aux, .bbl and the other generated files"
        >
          Other logs and files
        </button>
      </div>
    </div>
  )
}
