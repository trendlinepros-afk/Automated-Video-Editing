/**
 * Undo in the top bar. Clicking it says in words what it will take back ("Move B-roll clip "Charger screen",
 * made by Claude 2 minutes ago") and undoes it when you confirm. Ctrl+Z undoes at once and says what it undid.
 */
import { useEffect, useRef, useState } from 'react'
import { editor, redo, undo } from '../state/editor'
import { useStore } from '../state/store'
import { Icon } from '../components/Icon'

function ago(iso?: string): string {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 45) return 'just now'
  if (s < 90) return 'a minute ago'
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`
  if (s < 5400) return 'an hour ago'
  if (s < 86400) return `${Math.round(s / 3600)} hours ago`
  return new Date(iso).toLocaleString()
}

const BY: Record<string, string> = { user: 'you', claude: 'Claude', app: 'the app' }

export function UndoButton() {
  const snap = useStore(editor, (s) => s.snapshot!)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
      if (e.key === 'Enter') {
        e.preventDefault()
        setOpen(false)
        void undo()
      }
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', key)
    }
  }, [open])
  // Nothing left to undo (or the change was undone elsewhere): close.
  useEffect(() => {
    if (!snap.canUndo) setOpen(false)
  }, [snap.canUndo])

  return (
    <div ref={ref} className="row" style={{ gap: 2, position: 'relative' }}>
      <button
        className="btn ghost small"
        disabled={!snap.canUndo || snap.readOnly}
        onClick={() => setOpen(!open)}
        title={snap.undoLabel ? `Undo: ${snap.undoLabel} (Ctrl+Z)` : 'Nothing to undo'}
      >
        <Icon name="undo" size={15} /> Undo
      </button>
      <button
        className="btn ghost small icon"
        disabled={!snap.canRedo || snap.readOnly}
        onClick={() => void redo()}
        title={snap.redoLabel ? `Redo: ${snap.redoLabel} (Ctrl+Y)` : 'Nothing to redo'}
      >
        <Icon name="redo" size={15} />
      </button>
      {open && snap.undoLabel && (
        <div className="popover undo-pop small" style={{ top: 34, left: 0 }}>
          <div className="hint">This will undo the last change:</div>
          <div className="undo-what selectable">{snap.undoLabel}</div>
          <div className="hint">
            Made by {BY[snap.undoBy ?? 'user'] ?? snap.undoBy} {ago(snap.undoAt)}. Redo puts it back.
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <button className="btn small ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              className="btn small primary"
              autoFocus
              onClick={() => {
                setOpen(false)
                void undo()
              }}
            >
              Undo it
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
