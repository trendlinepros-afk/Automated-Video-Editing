import { useEffect } from 'react'
import { app, startApp } from './state/app'
import { editor } from './state/editor'
import { useStore } from './state/store'
import { ContextMenu, Toasts } from './components/Overlays'
import { UpdateDialog } from './components/Updates'
import { SetupScreen } from './screens/SetupScreen'
import { HomeScreen } from './screens/HomeScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { LibraryScreen } from './screens/LibraryScreen'
import { PersonasScreen } from './screens/PersonasScreen'
import { EditorScreen } from './editor/EditorScreen'
import { AppTopBar } from './components/AppTopBar'
import { Spinner } from './components/bits'

export function App() {
  const screen = useStore(app, (s) => s.screen)
  const appName = useStore(app, (s) => s.info?.name ?? 'AI Video Editor')
  const projectName = useStore(editor, (s) => s.snapshot?.doc.project.name)

  useEffect(() => {
    void startApp()
  }, [])

  useEffect(() => {
    document.title = screen === 'editor' && projectName ? `${projectName} · ${appName}` : appName
  }, [screen, projectName, appName])

  let body
  switch (screen) {
    case 'loading':
      body = (
        <>
          <AppTopBar />
          <div className="screen empty">
            <Spinner label="Starting…" />
          </div>
        </>
      )
      break
    case 'setup':
      body = <SetupScreen />
      break
    case 'home':
      body = <HomeScreen />
      break
    case 'editor':
      body = <EditorScreen />
      break
    case 'settings':
      body = <SettingsScreen />
      break
    case 'library':
      body = <LibraryScreen />
      break
    case 'personas':
      body = <PersonasScreen />
      break
  }
  return (
    <div className="app">
      {body}
      <UpdateDialog />
      <ContextMenu />
      <Toasts />
    </div>
  )
}
