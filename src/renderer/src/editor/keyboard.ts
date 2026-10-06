/**
 * Editor keys: Space play/pause, J K L shuttle, ←/→ nudge the selected item or cut (or step a frame),
 * Shift for bigger steps, Delete removes, Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) undo and redo, Esc clears.
 * Ignored while you type in a text field.
 */
import { useEffect } from 'react'
import { app } from '../state/app'
import { editor, redo, select, selectSeam, setRange, undo } from '../state/editor'
import { currentDerived } from '../state/derived'
import { shuttle, stepFrames, toggle } from '../state/player'
import { isTyping } from '../util'
import { deleteItems, nudgeItems, nudgeSeam } from './actions'

export function useEditorKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (app.get().screen !== 'editor' || isTyping(e)) return
      const s = editor.get()
      if (s.dialog || app.get().updateDialog || app.get().menu) return
      const ctrl = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (ctrl && key === 'z') {
        e.preventDefault()
        void (e.shiftKey ? redo() : undo())
        return
      }
      if (ctrl && key === 'y') {
        e.preventDefault()
        void redo()
        return
      }
      if (ctrl || e.altKey) return
      const fps = currentDerived()?.fps ?? 30
      switch (e.key) {
        case ' ':
          e.preventDefault()
          toggle()
          break
        case 'j':
        case 'J':
        case 'k':
        case 'K':
        case 'l':
        case 'L':
          e.preventDefault()
          shuttle(key as 'j' | 'k' | 'l')
          break
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault()
          const dir = e.key === 'ArrowLeft' ? -1 : 1
          if (s.seam) {
            void nudgeSeam(s.seam, dir * (e.shiftKey ? 0.05 : 0.005))
            break
          }
          const d = currentDerived()
          const movable = s.selection.filter((id) => d?.resolved.get(id)?.item.type !== 'segment')
          if (movable.length && !s.snapshot?.readOnly) void nudgeItems(movable, (dir * (e.shiftKey ? 10 : 1)) / fps)
          else stepFrames(dir * (e.shiftKey ? 10 : 1))
          break
        }
        case 'Delete':
        case 'Backspace':
          if (s.selection.length && !s.snapshot?.readOnly) {
            e.preventDefault()
            void deleteItems(s.selection)
          }
          break
        case 'Escape':
          if (s.seam) selectSeam(null)
          else if (s.selection.length) select([])
          else if (s.range) setRange(null)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
