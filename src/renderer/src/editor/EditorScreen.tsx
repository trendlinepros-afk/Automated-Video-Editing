/** The editor: top bar, preview, side panel and timeline in one window. */
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { call } from '../state/app'
import { editor } from '../state/editor'
import { useStore } from '../state/store'
import { pause } from '../state/player'
import { SidePanel } from '../panels/SidePanel'
import { Timeline } from '../timeline/Timeline'
import { clearPeaks } from '../timeline/peaks'
import { EditorDialogs } from './Dialogs'
import { EditorTopBar } from './EditorTopBar'
import { Preview } from './Preview'
import { useEditorKeys } from './keyboard'
import { IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS, basename, clamp } from '../util'

function stored(key: string, fallback: number): number {
  try {
    const v = parseFloat(localStorage.getItem(key) ?? '')
    return isFinite(v) ? v : fallback
  } catch {
    return fallback
  }
}

function store(key: string, v: number): void {
  try {
    localStorage.setItem(key, String(Math.round(v)))
  } catch {
    /* sizes simply reset next time */
  }
}

export function EditorScreen() {
  const snap = useStore(editor, (s) => s.snapshot)
  const projectId = snap?.doc.project.id
  const [sideW, setSideW] = useState(() => stored('ave.sideWidth', 400))
  const [tlH, setTlH] = useState(() => stored('ave.timelineHeight', 300))
  useEditorKeys()

  useEffect(() => {
    clearPeaks()
    return () => pause()
  }, [projectId])

  if (!snap) return null

  const dragSplit = (e: ReactPointerEvent, axis: 'x' | 'y') => {
    e.preventDefault()
    const start = axis === 'x' ? e.clientX : e.clientY
    const base = axis === 'x' ? sideW : tlH
    let last = base
    const move = (ev: PointerEvent) => {
      const delta = (axis === 'x' ? ev.clientX : ev.clientY) - start
      last = axis === 'x' ? clamp(base - delta, 300, window.innerWidth * 0.6) : clamp(base - delta, 140, window.innerHeight * 0.7)
      if (axis === 'x') setSideW(last)
      else setTlH(last)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      store(axis === 'x' ? 'ave.sideWidth' : 'ave.timelineHeight', last)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="editor" style={{ ['--tl-h' as string]: `${tlH}px` }}>
      <EditorTopBar />
      <Banners />
      <div className="editor-main" style={{ ['--side-w' as string]: `${sideW}px` }}>
        <Preview />
        <div className="splitter-x" onPointerDown={(e) => dragSplit(e, 'x')} />
        <SidePanel />
      </div>
      <div className="splitter-y" onPointerDown={(e) => dragSplit(e, 'y')} />
      <Timeline />
      <EditorDialogs />
    </div>
  )
}

/** Read-only and missing-footage messages under the top bar. */
function Banners() {
  const snap = useStore(editor, (s) => s.snapshot!)
  const lock = snap.doc.project.lock
  const missing = snap.missingSources
  const sources = snap.doc.project.sources
  return (
    <div>
      {snap.readOnly && (
        <div className="banner">
          <b>Read-only.</b> {snap.readOnlyReason ?? 'This project was saved by a newer version of the app. Update the app to edit it.'}
        </div>
      )}
      {lock && (
        <div className="banner info">
          Claude is re-editing one section. Everything outside it is locked until it finishes, so the rest of the video cannot change.
        </div>
      )}
      {missing.map((id) => {
        const src = sources.find((s) => s.id === id)
        const relink = async () => {
          const exts = src?.kind === 'audio' ? AUDIO_EXTS : src?.kind === 'image' ? IMAGE_EXTS : VIDEO_EXTS
          const files = await call(() => window.api.app.pickFiles({ title: `Where is ${src ? basename(src.path) : 'this file'} now?`, filters: [{ name: 'Media', extensions: exts }] }))
          if (!files?.[0]) return
          const next = await call(() => window.api.project.relinkSource(id, files[0]), 'Could not relink')
          if (next) editor.set({ snapshot: next })
        }
        return (
          <div key={id} className="banner">
            <span className="grow ellipsis" title={src?.path}>
              A file has moved or is missing: <b>{src ? basename(src.path) : id}</b>
              {src ? <span className="faint"> ({src.path})</span> : null}
            </span>
            <button className="btn small" onClick={relink} disabled={snap.readOnly}>
              Relink
            </button>
          </div>
        )
      })}
    </div>
  )
}
