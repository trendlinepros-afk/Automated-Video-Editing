/**
 * The timeline: one lane per track, a time ruler with zoom and a playhead.
 * Drag across the ruler to select a range (used by Re-edit section and Selected section export).
 * Drag items to move them, drag edges to trim, drag either side of a cut seam to nudge it while the seam audio loops.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { TRACK_KINDS, TRACK_LABELS, type Range, type TrackKind } from '@shared/project'
import type { PlacedSegment, ResolvedItem } from '@shared/timeline'
import { openMenu, toast } from '../state/app'
import { applyOp, editor, openDialog, select, selectSeam, setRange, setTab, type SeamSel } from '../state/editor'
import { useDerived } from '../state/derived'
import { pause, seek } from '../state/player'
import { useStore } from '../state/store'
import { Icon } from '../components/Icon'
import { canEdit, fixAudio, itemMenu, nudgeSeam, seamMenu, timeMenu } from '../editor/actions'
import { clamp, fmt, fmtRange, mediaUrl } from '../util'
import { HEADER_W, MAX_ZOOM, RULER_H, drag } from './drag'
import { Lane, type LaneHandlers } from './Lane'

export function Timeline() {
  const d = useDerived()
  const snap = useStore(editor, (s) => s.snapshot!)
  const zoomState = useStore(editor, (s) => s.zoom)
  const selection = useStore(editor, (s) => s.selection)
  const seam = useStore(editor, (s) => s.seam)
  const pulses = useStore(editor, (s) => s.pulses)
  const scroller = useRef<HTMLDivElement>(null)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewW, setViewW] = useState(1000)

  // An empty project still shows a minute of ruler, so the lanes do not look broken before Claude starts.
  const duration = d && d.resolved.size ? d.duration : 60
  const fitZoom = Math.max(0.05, (viewW - HEADER_W - 24) / duration)
  const minZoom = Math.min(fitZoom, 1)
  const zoom = zoomState > 0 ? clamp(zoomState, minZoom, MAX_ZOOM) : fitZoom
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewW(el.clientWidth))
    ro.observe(el)
    setViewW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const setZoom = useCallback((z: number, anchorClientX?: number) => {
    const el = scroller.current
    const old = zoomRef.current
    const next = clamp(z, minZoom, MAX_ZOOM)
    editor.set({ zoom: next })
    if (!el) return
    const rect = el.getBoundingClientRect()
    const x = anchorClientX !== undefined ? anchorClientX - rect.left : HEADER_W + (editor.get().playhead * old - el.scrollLeft)
    const t = (el.scrollLeft + x - HEADER_W) / old
    requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, t * next + HEADER_W - x)
    })
  }, [minZoom])

  // Ctrl + mouse wheel zooms around the pointer.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setZoom(zoomRef.current * Math.pow(1.0015, -e.deltaY), e.clientX)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setZoom])

  // Visible time window, quantised so lanes only re-render when you scroll a good distance.
  const span = Math.max(1, (viewW - HEADER_W) / zoom)
  const q = span / 2
  const t0 = Math.max(0, Math.floor(scrollLeft / zoom / q) * q - q)
  const t1 = t0 + span + 3 * q

  const handlers = useHandlers(zoomRef)
  const segmentsByTrack = useMemo(() => {
    const m = new Map<string, PlacedSegment[]>()
    for (const seg of d?.segments ?? []) {
      const l = m.get(seg.item.trackId) ?? []
      l.push(seg)
      m.set(seg.item.trackId, l)
    }
    return m
  }, [d])

  if (!d) return null
  const project = snap.doc.project
  const contentW = HEADER_W + duration * zoom + 160
  const lock = project.lock?.range ?? null

  return (
    <div className="timeline">
      <Toolbar zoom={zoom} minZoom={minZoom} setZoom={setZoom} fit={() => editor.set({ zoom: 0 })} />
      <div className="tl-scroll" ref={scroller} onScroll={(e) => setScrollLeft((e.target as HTMLDivElement).scrollLeft)}>
        <div className="tl-content" style={{ width: contentW }}>
          <Ruler zoom={zoom} t0={t0} t1={t1} width={contentW} />
          {d.tracks
            .filter((t) => !t.hidden)
            .map((track) => (
              <Lane
                key={track.id}
                track={track}
                items={d.byTrack.get(track.id) ?? EMPTY_ITEMS}
                segments={track.kind === 'aroll' ? segmentsByTrack.get(track.id) ?? EMPTY_SEGMENTS : null}
                captions={track.kind === 'captions' ? d.captions() : null}
                captionsEnabled={project.captions.enabled}
                sources={d.sources}
                zoom={zoom}
                t0={t0}
                t1={t1}
                selection={selection}
                seamId={seam?.segmentId ?? null}
                seamEdge={seam?.edge ?? null}
                pulses={pulses}
                lock={lock}
                readOnly={snap.readOnly}
                headerW={HEADER_W}
                width={contentW}
                h={handlers}
              />
            ))}
          <Overlays zoom={zoom} lock={lock} />
          <Playhead zoom={zoom} scroller={scroller} viewW={viewW} />
        </div>
      </div>
    </div>
  )
}

const EMPTY_ITEMS: ResolvedItem[] = []
const EMPTY_SEGMENTS: PlacedSegment[] = []

function timeAt(e: { clientX: number }, el: Element, zoom: number): number {
  return Math.max(0, (e.clientX - el.getBoundingClientRect().left) / zoom)
}

/** Pointer handling for items, seams and empty lane space. */
function useHandlers(zoomRef: { current: number }): LaneHandlers {
  return useMemo<LaneHandlers>(() => {
    const track = (e: ReactPointerEvent, onMove: (dx: number, ev: PointerEvent) => void, onUp: (moved: boolean, ev: PointerEvent) => void) => {
      const x0 = e.clientX
      let moved = false
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - x0
        if (!moved && Math.abs(dx) < 3) return
        moved = true
        onMove(dx, ev)
      }
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        onUp(moved, ev)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    }

    return {
      itemDown(e, r, mode) {
        if (e.button !== 0) return
        const id = r.item.id
        const s = editor.get()
        if (e.ctrlKey || e.shiftKey || e.metaKey) {
          select(s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id])
        } else if (!s.selection.includes(id) || s.seam) {
          select([id])
        }
        if (s.tab !== 'chat' && s.tab !== 'notes') setTab('inspector')
        const isSeg = r.item.type === 'segment'
        if (isSeg && mode === 'move') {
          track(e, () => undefined, (moved) => moved && toast('A-roll pieces play in order. Drag an edge to adjust a cut.'))
          return
        }
        let allowed: boolean | null = null
        track(
          e,
          (dx) => {
            if (allowed === null) allowed = canEdit(id)
            if (allowed) drag.set({ id, mode, dt: dx / zoomRef.current })
          },
          (moved) => {
            const dt = drag.get().dt
            drag.set({ id: null, mode: null, dt: 0 })
            if (!moved || !allowed || Math.abs(dt) < 1e-4) return
            if (r.item.type === 'segment') {
              const speed = r.item.speed || 1
              void applyOp({ op: 'nudgeSegment', id, edge: mode === 'trim-start' ? 'in' : 'out', delta: round(dt * speed) })
            } else if (mode === 'move') {
              void applyOp({ op: 'moveItem', id, start: round(Math.max(0, r.start + dt)) })
            } else if (mode === 'trim-start') {
              void applyOp({ op: 'trimItem', id, edge: 'start', time: round(clamp(r.start + dt, 0, r.end - 0.04)) })
            } else {
              void applyOp({ op: 'trimItem', id, edge: 'end', time: round(Math.max(r.start + 0.04, r.end + dt)) })
            }
          }
        )
      },
      itemMenu(e: ReactMouseEvent, r: ResolvedItem) {
        const s = editor.get()
        if (!s.selection.includes(r.item.id)) select([r.item.id])
        const body = (e.currentTarget as HTMLElement).parentElement!
        itemMenu(e, r.item, timeAt(e, body, zoomRef.current))
      },
      seamDown(e, seg: PlacedSegment, prev: PlacedSegment, edge) {
        if (e.button !== 0) return
        const sel: SeamSel = { segmentId: seg.item.id, prevId: prev.item.id, edge }
        selectSeam(sel)
        pause()
        let allowed: boolean | null = null
        const dragId = `seam:${seg.item.id}`
        track(
          e,
          (dx) => {
            if (allowed === null) allowed = canEdit(edge === 'out' ? prev.item.id : seg.item.id)
            if (allowed) drag.set({ id: dragId, mode: 'seam', dt: dx / zoomRef.current })
          },
          (moved) => {
            const dt = drag.get().dt
            drag.set({ id: null, mode: null, dt: 0 })
            if (!moved || !allowed || Math.abs(dt) < 1e-4) return
            const target = edge === 'out' ? prev.item : seg.item
            void nudgeSeam(sel, round(dt * (target.speed || 1)))
          }
        )
      },
      seamMenu(e, seg, prev) {
        const sel: SeamSel = { segmentId: seg.item.id, prevId: prev.item.id, edge: 'in' }
        selectSeam(sel)
        seamMenu(e, sel, seg.start)
      },
      laneDown(e) {
        if (e.button !== 0) return
        select([])
        seek(timeAt(e, e.currentTarget, zoomRef.current))
      },
      laneMenu(e) {
        if (e.target !== e.currentTarget) return // items and cuts have their own menus
        timeMenu(e, timeAt(e, e.currentTarget, zoomRef.current))
      }
    }
  }, [zoomRef])
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200]

function Ruler({ zoom, t0, t1, width }: { zoom: number; t0: number; t1: number; width: number }) {
  const requests = useStore(editor, (s) => s.snapshot!.doc.project.requests)
  const range = useStore(editor, (s) => s.range)
  const step = STEPS.find((s) => s * zoom >= 80) ?? 1200
  const minor = step / 5
  const ticks: { t: number; major: boolean }[] = []
  for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-6
    if (major || minor * zoom >= 12) ticks.push({ t, major })
  }

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const el = e.currentTarget
    const start = timeAt(e, el, zoom)
    let dragging = false
    const move = (ev: PointerEvent) => {
      const t = timeAt(ev, el, zoom)
      if (!dragging && Math.abs(t - start) * zoom < 4) return
      dragging = true
      setRange({ start: Math.min(start, t), end: Math.max(start, t) })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (!dragging) seek(start)
      else {
        const r = editor.get().range
        if (r) setRange({ start: round(r.start), end: round(r.end) })
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const marks = requests.filter((r) => r.range && (r.status === 'queued' || r.status === 'in_progress' || r.review === 'pending'))

  return (
    <div className="tl-ruler" style={{ width }}>
      <div className="tl-corner" style={{ width: HEADER_W }}>
        <PlayheadTime />
      </div>
      <div
        className="tl-ruler-body"
        onPointerDown={onDown}
        onContextMenu={(e) => timeMenu(e, timeAt(e, e.currentTarget, zoom))}
        title="Click to move the playhead. Drag to select a section. Right-click to send the time to the chat or add a clip here."
      >
        {range && <div className="tl-ruler-range" style={{ left: range.start * zoom, width: (range.end - range.start) * zoom }} />}
        {ticks.map(({ t, major }) => (
          <div key={t.toFixed(3)} className={`tl-tick${major ? '' : ' minor'}`} style={{ left: t * zoom }}>
            {major ? (step < 1 ? `${fmt(t)}.${Math.round((t % 1) * 10)}` : fmt(t)) : ''}
          </div>
        ))}
        <RulerPlayhead zoom={zoom} />
        {marks.map((r) => {
          const state = r.review === 'pending' && r.status === 'done' ? 'review' : r.status
          const label =
            state === 'review'
              ? 'Finished: Before / After with Keep and Revert below the preview'
              : state === 'in_progress'
                ? 'Claude is working on this section'
                : `Queued${r.waitingReason ? `: ${r.waitingReason}` : ''}`
          return (
            <div
              key={r.id}
              className={`tl-req ${state}`}
              style={{ left: r.range!.start * zoom, width: Math.max(4, (r.range!.end - r.range!.start) * zoom) }}
              title={`${fmtRange(r.range!)} · ${label}${r.text ? `\n“${r.text}”` : ''}`}
            />
          )
        })}
      </div>
    </div>
  )
}

function RulerPlayhead({ zoom }: { zoom: number }) {
  const t = useStore(editor, (s) => s.playhead)
  return <div className="tl-ruler-head" style={{ left: t * zoom }} />
}

function PlayheadTime() {
  const t = useStore(editor, (s) => s.playhead)
  return <span>{fmt(t, true)}</span>
}

function Overlays({ zoom, lock }: { zoom: number; lock: Range | null }) {
  const range = useStore(editor, (s) => s.range)
  const chatRange = useStore(editor, (s) => s.chatRange)
  const dragId = useStore(drag, (s) => (s.mode === 'seam' ? s.id : null))
  const dragDt = useStore(drag, (s) => (s.mode === 'seam' ? s.dt : 0))
  const d = useDerived()
  const seamSeg = dragId && d ? d.segments.find((s) => `seam:${s.item.id}` === dragId) : null
  const box = (r: Range) => ({ left: HEADER_W + r.start * zoom, width: Math.max(1, (r.end - r.start) * zoom), top: RULER_H })
  return (
    <>
      {lock && (
        <div className="tl-overlay tl-lock" style={box(lock)} title="Claude is re-editing this section. Everything outside it is locked until it finishes." />
      )}
      {range && <div className="tl-overlay tl-range" style={box(range)} />}
      {chatRange && <div className="tl-overlay tl-chatrange" style={box(chatRange)} />}
      {seamSeg && (
        <div className="tl-overlay" style={{ left: HEADER_W + (seamSeg.start + dragDt) * zoom, top: RULER_H, width: 2, background: 'var(--warn)', zIndex: 7 }}>
          <span className="chip warn" style={{ position: 'absolute', top: 4, left: 6, background: 'var(--bg-2)', border: '1px solid var(--warn)' }}>
            {dragDt > 0 ? '+' : ''}
            {Math.round(dragDt * 1000)} ms
          </span>
        </div>
      )}
    </>
  )
}

function Playhead({ zoom, scroller, viewW }: { zoom: number; scroller: { current: HTMLDivElement | null }; viewW: number }) {
  const t = useStore(editor, (s) => s.playhead)
  const playing = useStore(editor, (s) => s.playing)
  const x = HEADER_W + t * zoom
  useEffect(() => {
    const el = scroller.current
    if (!el || !playing) return
    if (x > el.scrollLeft + viewW - 40 || x < el.scrollLeft + HEADER_W) el.scrollLeft = Math.max(0, x - HEADER_W - 40)
  }, [x, playing, scroller, viewW])
  return <div className="tl-overlay tl-playhead" style={{ left: x }} />
}

function Toolbar({ zoom, minZoom, setZoom, fit }: { zoom: number; minZoom: number; setZoom: (z: number) => void; fit: () => void }) {
  const range = useStore(editor, (s) => s.range)
  const seam = useStore(editor, (s) => s.seam)
  const readOnly = useStore(editor, (s) => s.snapshot!.readOnly)
  const empty = useStore(editor, (s) => s.snapshot!.doc.project.items.length === 0)
  const lo = Math.log(minZoom)
  const hi = Math.log(MAX_ZOOM)
  const slider = Math.round(((Math.log(zoom) - lo) / (hi - lo || 1)) * 1000)

  const addTrack = (e: ReactMouseEvent) =>
    openMenu(
      e,
      TRACK_KINDS.filter((k) => k !== 'captions').map((kind: TrackKind) => ({
        label: `Add ${TRACK_LABELS[kind]} track`,
        run: () => void applyOp({ op: 'addTrack', kind })
      }))
    )

  return (
    <div className="tl-toolbar">
      <button className="btn ghost small" disabled={readOnly} onClick={addTrack}>
        <Icon name="plus" size={14} /> Add track
      </button>
      {seam ? (
        <SeamControls seam={seam} />
      ) : range ? (
        <div className="row" style={{ gap: 6 }}>
          <span className="chip accent">
            {fmtRange(range)} · {(range.end - range.start).toFixed(1)} s
          </span>
          <button className="btn small primary" disabled={readOnly} onClick={() => openDialog({ kind: 'reedit' })}>
            <Icon name="wand" size={14} /> Re-edit section
          </button>
          <button className="btn small" onClick={() => openDialog({ kind: 'export' })}>
            Export section
          </button>
          <button className="btn small ghost" disabled={readOnly} onClick={() => openDialog({ kind: 'note', range })} title="Leave a note for Claude on this range">
            <Icon name="note" size={14} />
          </button>
          <button className="btn small ghost icon" onClick={() => setRange(null)} title="Clear the selection (Esc)">
            <Icon name="close" size={14} />
          </button>
        </div>
      ) : empty ? (
        <span className="small faint">The edit appears here as Claude builds it.</span>
      ) : (
        <span className="small faint">Drag across the ruler to select a section.</span>
      )}
      <div className="spacer" />
      <button className="btn ghost small icon" onClick={() => setZoom(zoom / 1.5)} title="Zoom out (Ctrl + wheel)">
        <Icon name="zoomOut" size={15} />
      </button>
      <input
        type="range"
        min={0}
        max={1000}
        value={slider}
        style={{ width: 120 }}
        onChange={(e) => setZoom(Math.exp(lo + (parseInt(e.target.value) / 1000) * (hi - lo)))}
        title="Zoom"
      />
      <button className="btn ghost small icon" onClick={() => setZoom(zoom * 1.5)} title="Zoom in (Ctrl + wheel)">
        <Icon name="zoomIn" size={15} />
      </button>
      <button className="btn ghost small" onClick={fit} title="Show the whole video">
        <Icon name="fit" size={14} /> Fit
      </button>
    </div>
  )
}

/** The selected cut: which side you are adjusting, fine nudges, and the seam audio playing on loop. */
function SeamControls({ seam }: { seam: SeamSel }) {
  const d = useDerived()
  const seg = d?.segments.find((s) => s.item.id === seam.segmentId)
  const prev = d?.segments.find((s) => s.item.id === seam.prevId)
  const audio = useRef<HTMLAudioElement>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [looping, setLooping] = useState(true)
  const key = seg && prev ? `${prev.item.in}-${prev.item.out}-${seg.item.in}-${seg.item.out}` : ''

  useEffect(() => {
    let alive = true
    if (!key) return
    window.api.project.seamAudio(seam.segmentId).then(
      (path) => alive && setUrl(path ? `${mediaUrl(path)}${mediaUrl(path)!.includes('?') ? '&' : '?'}k=${encodeURIComponent(key)}` : null),
      () => alive && setUrl(null)
    )
    return () => {
      alive = false
    }
  }, [seam.segmentId, key])

  useEffect(() => {
    const a = audio.current
    if (!a) return
    if (looping && url) a.play().catch(() => undefined)
    else a.pause()
  }, [looping, url])

  if (!seg || !prev) return null
  const step = (ms: number) => void nudgeSeam(seam, ms / 1000)
  return (
    <div className="row" style={{ gap: 6 }}>
      <span className="chip warn">Cut at {fmt(seg.start, true)}</span>
      <div className="seg">
        <button className={seam.edge === 'out' ? 'on' : ''} onClick={() => selectSeam({ ...seam, edge: 'out' })} title="Adjust where the piece before the cut ends">
          End of before
        </button>
        <button className={seam.edge === 'in' ? 'on' : ''} onClick={() => selectSeam({ ...seam, edge: 'in' })} title="Adjust where the piece after the cut starts">
          Start of after
        </button>
      </div>
      <button className="btn small" onClick={(e) => step(e.shiftKey ? -50 : -10)} title="10 ms earlier (Shift: 50 ms). Arrow keys work too.">
        −10 ms
      </button>
      <button className="btn small" onClick={(e) => step(e.shiftKey ? 50 : 10)} title="10 ms later (Shift: 50 ms)">
        +10 ms
      </button>
      <button className={`btn small${looping ? ' on' : ''}`} onClick={() => setLooping(!looping)} title="The audio around the cut plays on loop while you adjust">
        <Icon name={looping ? 'pause' : 'play'} size={12} /> {url ? (looping ? 'Looping' : 'Loop') : 'Loading audio…'}
      </button>
      <button className="btn small" onClick={() => void fixAudio({ segmentId: seam.segmentId, time: seg.start })}>
        Fix clipped audio
      </button>
      <button className="btn small ghost icon" onClick={() => selectSeam(null)} title="Done (Esc)">
        <Icon name="close" size={14} />
      </button>
      {url && <audio ref={audio} src={url} loop autoPlay={looping} />}
    </div>
  )
}
