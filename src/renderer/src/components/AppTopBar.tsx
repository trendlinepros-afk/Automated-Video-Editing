/** Top bar for Home, Settings, Library and Personas & Styles. The editor has its own. */
import type { ReactNode } from 'react'
import { app, go, goBack, leaveEditor, type Screen } from '../state/app'
import { editor } from '../state/editor'
import { useStore } from '../state/store'
import { Icon } from './Icon'
import { UpdateButton } from './Updates'

export function AppTopBar({ children }: { children?: ReactNode }) {
  const screen = useStore(app, (s) => s.screen)
  const returnTo = useStore(app, (s) => s.returnTo)
  const projectName = useStore(editor, (s) => s.snapshot?.doc.project.name)
  const name = useStore(app, (s) => s.info?.name ?? 'AI Video Editor')
  const nav: [Screen, string][] = [
    ['home', 'Projects'],
    ['library', 'Library'],
    ['personas', 'Personas & Styles'],
    ['settings', 'Settings']
  ]
  return (
    <div className="topbar">
      {screen !== 'home' && screen !== 'setup' && returnTo === 'editor' && projectName ? (
        <button className="btn ghost small" onClick={goBack} title="Back to the editor">
          <Icon name="back" size={14} /> {projectName}
        </button>
      ) : (
        <span className="brand">{name}</span>
      )}
      {screen !== 'setup' && (
        <nav className="nav">
          {nav.map(([s, label]) => (
            <button
              key={s}
              className={screen === s ? 'on' : ''}
              onClick={() => (s !== 'home' ? go(s) : editor.get().snapshot ? void leaveEditor() : app.set({ screen: 'home' }))}
            >
              {label}
            </button>
          ))}
        </nav>
      )}
      <div className="spacer" />
      {children}
      <UpdateButton />
    </div>
  )
}
