import { mdiAlertCircle, mdiCheckCircle, mdiClose, mdiInformation } from '@mdi/js'
import { useApp } from '../stores/app'
import { cx } from '../lib/util'
import { Icon } from './Icon'

const ICONS = { info: mdiInformation, success: mdiCheckCircle, error: mdiAlertCircle }

export function Toasts(): React.JSX.Element {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismiss)
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', t.kind)}>
          <Icon path={ICONS[t.kind]} size={20} className="toast-icon" />
          <span className="toast-message">{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="btn btn-link"
              onClick={() => {
                t.action?.run()
                dismiss(t.id)
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="icon-btn" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <Icon path={mdiClose} size={16} />
          </button>
        </div>
      ))}
    </div>
  )
}
