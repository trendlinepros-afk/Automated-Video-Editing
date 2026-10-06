/** Toasts and the right-click menu, drawn once at the top of the app. */
import { useEffect } from 'react'
import { app, dismissToast } from '../state/app'
import { useStore } from '../state/store'
import { Icon } from './Icon'

export function Toasts() {
  const toasts = useStore(app, (s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="msg selectable">{t.text}</span>
          {t.actions?.map((a) => (
            <button
              key={a.label}
              className={`btn small${a.primary ? ' primary' : ''}`}
              onClick={() => {
                a.run()
                dismissToast(t.id)
              }}
            >
              {a.label}
            </button>
          ))}
          {!t.actions?.length || !t.sticky ? (
            <button className="btn ghost small icon" onClick={() => dismissToast(t.id)} title="Dismiss">
              <Icon name="close" size={14} />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
}

export function ContextMenu() {
  const menu = useStore(app, (s) => s.menu)
  useEffect(() => {
    if (!menu) return
    const close = () => app.set({ menu: null })
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])
  if (!menu) return null
  const x = Math.min(menu.x, window.innerWidth - 200)
  const y = Math.min(menu.y, window.innerHeight - menu.entries.length * 32 - 10)
  return (
    <div className="menu" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
      {menu.entries.map((m, i) =>
        m.separator ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            disabled={m.disabled}
            onClick={() => {
              app.set({ menu: null })
              m.run()
            }}
          >
            {m.label}
          </button>
        )
      )}
    </div>
  )
}
