import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { mdiClose } from '@mdi/js'
import { cx, errorMessage } from '../lib/util'
import { Icon } from './Icon'

interface ModalProps {
  title: string
  onClose: () => void
  footer?: React.ReactNode
  wide?: boolean
  /** Blocks closing while an operation is running. */
  busy?: boolean
  children: React.ReactNode
}

export function Modal({ title, onClose, footer, wide, busy, children }: ModalProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  useEffect(() => {
    // Focus the first field (or the dialog itself) so typing works right away.
    const el = ref.current
    if (!el) return
    const target = el.querySelector<HTMLElement>('[data-autofocus], input:not([type=hidden]), select, textarea')
    ;(target ?? el).focus()
    if (target instanceof HTMLInputElement) target.select()
  }, [])

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div ref={ref} className={cx('modal', wide && 'wide')} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close">
            <Icon path={mdiClose} size={20} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}

interface PromptModalProps {
  title: string
  label: string
  initialValue?: string
  placeholder?: string
  confirmLabel: string
  hint?: React.ReactNode
  onClose: () => void
  /** Throw to keep the dialog open and show the error. */
  onSubmit: (value: string) => Promise<void> | void
}

/** A one-field dialog: new project, rename, copy, new file, ... */
export function PromptModal(props: PromptModalProps): React.JSX.Element {
  const [value, setValue] = useState(props.initialValue ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    const trimmed = value.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      await props.onSubmit(trimmed)
      props.onClose()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={props.onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy || !value.trim()}>
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="prompt-input">{props.label}</label>
          <input
            id="prompt-input"
            className="input"
            value={value}
            placeholder={props.placeholder}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          {props.hint && <div className="hint">{props.hint}</div>}
          {error && <div className="form-error">{error}</div>}
        </div>
      </form>
    </Modal>
  )
}

interface ConfirmModalProps {
  title: string
  confirmLabel: string
  danger?: boolean
  onClose: () => void
  /**
   * Throw to keep the dialog open and show the error. Resolve with false when
   * the handler has taken care of the dialog itself (opened another one, say).
   */
  onConfirm: () => Promise<void | boolean> | void | boolean
  children: React.ReactNode
}

export function ConfirmModal(props: ConfirmModalProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if ((await props.onConfirm()) !== false) props.onClose()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={props.onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            data-autofocus
            className={cx('btn', props.danger ? 'btn-danger' : 'btn-primary')}
            onClick={() => void confirm()}
            disabled={busy}
          >
            {props.confirmLabel}
          </button>
        </>
      }
    >
      {props.children}
      {error && <div className="form-error">{error}</div>}
    </Modal>
  )
}
