// The outcome of proofreading: the passage, with every correction the model
// proposes marked in it. A click on a correction keeps the original text
// there; "Apply" puts the passage back into the file with the others.

import { useMemo, useState } from 'react'
import { mdiAlertOutline, mdiLoading } from '@mdi/js'
import { Icon } from '../components/Icon'
import { Modal } from '../components/Modal'
import { applyCorrections, proposedCorrections, type Correction } from '../editor/assistant'
import { cx } from '../lib/util'
import { useAssistant, type ProofreadSession } from '../stores/assistant'

/** Line breaks that a correction adds or removes would not be seen otherwise. */
function visible(text: string): string {
  return text.replace(/\n/g, '↵\n')
}

function Passage(props: {
  original: string
  list: Correction[]
  rejected: ReadonlySet<number>
  onToggle: (index: number) => void
}): React.JSX.Element {
  const { original, list, rejected } = props
  const parts: React.ReactNode[] = []
  let pos = 0
  list.forEach((c, i) => {
    if (c.from > pos) parts.push(original.slice(pos, c.from))
    const off = rejected.has(i)
    const removed = original.slice(c.from, c.to)
    parts.push(
      <span
        key={i}
        role="button"
        tabIndex={0}
        className={cx('correction', off && 'rejected')}
        title={off ? 'Kept as it was. Click to take the correction.' : 'Click to keep the original text here.'}
        onClick={() => props.onToggle(i)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            props.onToggle(i)
          }
        }}
      >
        {off ? (
          removed || '·'
        ) : (
          <>
            {removed && <del>{visible(removed)}</del>}
            {c.insert && <ins>{visible(c.insert)}</ins>}
          </>
        )}
      </span>
    )
    pos = c.to
  })
  if (pos < original.length) parts.push(original.slice(pos))
  return <div className="proofread-passage selectable">{parts}</div>
}

function Outcome({ session }: { session: ProofreadSession }): React.JSX.Element {
  const close = useAssistant((s) => s.closeProofreading)
  const apply = useAssistant((s) => s.apply)
  const proposed = useMemo(
    () => proposedCorrections(session.original, session.text, session.truncated),
    [session.original, session.text, session.truncated]
  )
  const list = proposed.list
  const [rejected, setRejected] = useState<ReadonlySet<number>>(proposed.rejected)
  const [error, setError] = useState<string | null>(null)
  const kept = list.length - rejected.size
  const changed = list.reduce((n, c) => n + Math.max(c.to - c.from, c.insert.length), 0)

  const toggle = (index: number): void => {
    const next = new Set(rejected)
    if (next.has(index)) next.delete(index)
    else next.add(index)
    setRejected(next)
  }

  const footer =
    list.length === 0 ? (
      <button type="button" className="btn btn-primary" data-autofocus onClick={close}>
        Close
      </button>
    ) : (
      <>
        <button type="button" className="btn btn-secondary" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-autofocus
          disabled={kept === 0}
          onClick={() => {
            if (!apply(applyCorrections(session.original, list, rejected))) {
              setError('The passage is no longer as it was when it was proofread (the file was changed or closed). Proofread it again.')
            }
          }}
        >
          {kept === list.length ? 'Apply all' : `Apply ${kept} of ${list.length}`}
        </button>
      </>
    )

  return (
    <Modal title="Proofread" wide onClose={close} footer={footer}>
      {list.length === 0 ? (
        <p>The model found nothing to correct in this passage.</p>
      ) : (
        <>
          <p className="muted proofread-hint">
            {list.length === 1 ? 'One correction' : `${list.length} corrections`}. Click one to keep the original text
            there. Once applied, Undo takes them back.
          </p>
          {session.truncated && (
            <p className="proofread-warning">
              <Icon path={mdiAlertOutline} size={18} />
              The answer stopped before the end of the passage (a limit of the model server, or the connection), so
              the end of the passage was not proofread. It stays as it is.
            </p>
          )}
          {proposed.rejected.size > 0 && (
            <p className="proofread-warning">
              <Icon path={mdiAlertOutline} size={18} />
              The model would remove some text. Those changes are not taken unless you click them.
            </p>
          )}
          {!session.truncated && session.original.length > 200 && changed > session.original.length * 0.4 && (
            <p className="proofread-warning">
              <Icon path={mdiAlertOutline} size={18} />
              The model changed a large part of the passage. Look through the changes before you apply them.
            </p>
          )}
          <Passage original={session.original} list={list} rejected={rejected} onToggle={toggle} />
        </>
      )}
      {error && <div className="form-error">{error}</div>}
    </Modal>
  )
}

export function ProofreadModal(): React.JSX.Element | null {
  const session = useAssistant((s) => s.session)
  const close = useAssistant((s) => s.closeProofreading)
  const proofread = useAssistant((s) => s.proofread)
  if (!session) return null

  if (session.phase === 'done') return <Outcome key={session.id} session={session} />

  if (session.phase === 'failed') {
    return (
      <Modal
        title="Proofread"
        onClose={close}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={close}>
              Close
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-autofocus
              onClick={() => {
                close()
                void proofread()
              }}
            >
              Try again
            </button>
          </>
        }
      >
        <p>The passage could not be proofread.</p>
        <p className="form-error selectable">{session.error}</p>
      </Modal>
    )
  }

  return (
    <Modal
      title="Proofread"
      wide
      onClose={close}
      footer={
        <button type="button" className="btn btn-secondary" data-autofocus onClick={close}>
          Stop
        </button>
      }
    >
      <p className="proofread-progress">
        <Icon path={mdiLoading} size={18} spin />
        {session.thinking ? 'The model is thinking…' : session.text ? 'The model is writing…' : 'Waiting for the model…'}
      </p>
      <div className="proofread-passage live selectable">{session.text || session.original}</div>
    </Modal>
  )
}
