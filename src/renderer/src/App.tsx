import { useEffect } from 'react'
import { mdiLoading } from '@mdi/js'
import { Icon } from './components/Icon'
import { Toasts } from './components/Toasts'
import { Dashboard } from './dashboard/Dashboard'
import { editor } from './editor/controller'
import { Ide } from './ide/Ide'
import { emitMenuCommand } from './lib/menuBus'
import { useApp } from './stores/app'

export function App(): React.JSX.Element {
  const ready = useApp((s) => s.ready)
  const fatal = useApp((s) => s.fatal)
  const route = useApp((s) => s.route)

  useEffect(() => {
    void useApp.getState().init()
    const offMenu = window.api.app.onMenuCommand(emitMenuCommand)
    // The main process asks for this before the window closes. A false result
    // (something could not be saved) makes it ask the user first.
    const offFlush = window.api.app.onFlushRequest(() => editor.flush())
    return () => {
      offMenu()
      offFlush()
    }
  }, [])

  // Dropping a file anywhere else must not make the window navigate to it.
  useEffect(() => {
    const prevent = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  if (fatal) {
    return (
      <div className="splash">
        <div>
          <p>Underleaf could not start.</p>
          <p className="selectable">{fatal}</p>
        </div>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="splash">
        <Icon path={mdiLoading} size={24} spin />
      </div>
    )
  }

  return (
    <>
      {route.name === 'project' ? <Ide projectId={route.id} /> : <Dashboard />}
      <Toasts />
    </>
  )
}
