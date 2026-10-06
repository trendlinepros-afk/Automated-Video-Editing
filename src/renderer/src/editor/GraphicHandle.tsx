/**
 * A handle on the preview for the selected graphic or picture while the playhead is over it.
 * Drag it to correct the placement; with motion points it moves the point nearest the playhead.
 */
import { useEffect, useState, type RefObject, type PointerEvent as ReactPointerEvent } from 'react'
import { applyOp, editor } from '../state/editor'
import { useDerived } from '../state/derived'
import { useStore } from '../state/store'
import { canEdit } from './actions'

export function GraphicHandle({ stage, video }: { stage: RefObject<HTMLDivElement | null>; video: RefObject<HTMLVideoElement | null> }) {
  const selection = useStore(editor, (s) => s.selection)
  const playhead = useStore(editor, (s) => s.playhead)
  const output = useStore(editor, (s) => s.snapshot!.doc.project.output)
  const ro = useStore(editor, (s) => s.snapshot!.readOnly)
  const d = useDerived()
  const [, setTick] = useState(0)
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null)

  useEffect(() => {
    const el = stage.current
    if (!el) return
    const ro = new ResizeObserver(() => setTick((t) => t + 1))
    ro.observe(el)
    return () => ro.disconnect()
  }, [stage])

  const r = selection.length === 1 ? d?.resolved.get(selection[0]) : undefined
  const item = r?.item
  if (!r || !item || (item.type !== 'graphic' && item.type !== 'clip') || playhead < r.start || playhead > r.end || ro) return null
  const st = stage.current
  if (!st) return null

  // Where the picture is drawn inside the stage (the video keeps its aspect ratio).
  const sr = st.getBoundingClientRect()
  const v = video.current
  const vr = v && v.src ? v.getBoundingClientRect() : null
  const aspect = output.width / output.height
  let box = { x: 0, y: 0, w: sr.width, h: sr.height }
  const fit = (w: number, h: number, ox: number, oy: number) => {
    const bw = Math.min(w, h * aspect)
    const bh = bw / aspect
    return { x: ox + (w - bw) / 2, y: oy + (h - bh) / 2, w: bw, h: bh }
  }
  box = vr && vr.width > 0 ? fit(vr.width, vr.height, vr.left - sr.left, vr.top - sr.top) : fit(sr.width, sr.height, 0, 0)

  const t = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, ...(item.transform ?? {}) }
  const kfs = item.keyframes ?? []
  const local = playhead - r.start
  let k = -1
  if (kfs.length) {
    k = 0
    for (let i = 1; i < kfs.length; i++) if (Math.abs(kfs[i].t - local) < Math.abs(kfs[k].t - local)) k = i
  }
  const px = k >= 0 ? kfs[k].x : t.x
  const py = k >= 0 ? kfs[k].y : t.y
  const cx = box.x + box.w / 2 + px * box.w + (drag?.dx ?? 0)
  const cy = box.y + box.h / 2 + py * box.h + (drag?.dy ?? 0)

  const onDown = (e: ReactPointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    if (!canEdit(item.id)) return
    const x0 = e.clientX
    const y0 = e.clientY
    const move = (ev: PointerEvent) => setDrag({ dx: ev.clientX - x0, dy: ev.clientY - y0 })
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      const nx = round(px + (ev.clientX - x0) / box.w)
      const ny = round(py + (ev.clientY - y0) / box.h)
      if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 2) return
      if (k >= 0) {
        void applyOp({ op: 'updateItem', id: item.id, patch: { keyframes: kfs.map((f, i) => (i === k ? { ...f, x: nx, y: ny } : f)) } })
      } else {
        void applyOp({ op: 'updateItem', id: item.id, patch: { transform: { ...t, x: nx, y: ny } } })
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      onPointerDown={onDown}
      title={k >= 0 ? `Drag to move motion point ${k + 1} of ${kfs.length}` : 'Drag to move it'}
      style={{
        position: 'absolute',
        left: cx - 11,
        top: cy - 11,
        width: 22,
        height: 22,
        borderRadius: '50%',
        border: '2px solid #fff',
        background: 'rgba(79,140,255,0.55)',
        boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
        cursor: 'move',
        zIndex: 3
      }}
    />
  )
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}
