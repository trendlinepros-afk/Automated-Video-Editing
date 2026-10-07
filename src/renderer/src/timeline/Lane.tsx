/**
 * One timeline lane: the track header (mute, solo, volume) and the visible items.
 * Only items inside the visible time window are rendered, so a 12-minute edit with ~1000 items stays quick.
 */
import { memo, type ReactElement, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { Range, Source, Track } from '@shared/project'
import type { CaptionLine, PlacedSegment, ResolvedItem } from '@shared/timeline'
import { applyOp } from '../state/editor'
import { seek } from '../state/player'
import { useStore } from '../state/store'
import { CommitSlider } from '../components/bits'
import { TRACK_COLORS, itemLabel } from '../util'
import { drag, laneHeight } from './drag'
import { Waveform } from './Waveform'

export interface LaneHandlers {
  itemDown(e: ReactPointerEvent, r: ResolvedItem, mode: 'move' | 'trim-start' | 'trim-end'): void
  itemMenu(e: ReactMouseEvent, r: ResolvedItem): void
  seamDown(e: ReactPointerEvent, seg: PlacedSegment, prev: PlacedSegment, edge: 'in' | 'out'): void
  seamMenu(e: ReactMouseEvent, seg: PlacedSegment, prev: PlacedSegment): void
  laneDown(e: ReactPointerEvent): void
}

interface LaneProps {
  track: Track
  items: ResolvedItem[]
  segments: PlacedSegment[] | null
  captions: CaptionLine[] | null
  captionsEnabled: boolean
  sources: Map<string, Source>
  zoom: number
  t0: number
  t1: number
  selection: string[]
  seamId: string | null
  seamEdge: 'in' | 'out' | null
  pulses: ReadonlySet<string>
  lock: Range | null
  readOnly: boolean
  headerW: number
  width: number
  h: LaneHandlers
}

export const Lane = memo(function Lane(p: LaneProps) {
  const color = TRACK_COLORS[p.track.kind] ?? 'var(--accent)'
  const height = laneHeight(p.track.kind)
  const visible = p.items.filter((r) => r.end >= p.t0 && r.start <= p.t1)
  const sourcePath = (id: string) => p.sources.get(id)?.path
  const locked = (r: ResolvedItem) => !!p.lock && (r.start < p.lock.start - 1e-3 || r.end > p.lock.end + 1e-3)
  return (
    <div className="tl-lane" style={{ height, width: p.width }}>
      <TrackHeader track={p.track} color={color} width={p.headerW} readOnly={p.readOnly} captionsEnabled={p.captionsEnabled} />
      <div className="tl-body" onPointerDown={p.h.laneDown}>
        {p.captions &&
          p.captions
            .filter((c) => c.end >= p.t0 && c.start <= p.t1)
            .map((c) => (
              <div
                key={c.id}
                className="tl-item caption"
                style={{ left: c.start * p.zoom, width: Math.max(2, (c.end - c.start) * p.zoom), ['--c' as string]: color, opacity: p.captionsEnabled ? 1 : 0.4 }}
                title={`${c.words.map((w) => w.word.text.trim()).join(' ')}\nCaptions come from the transcript. Fix a word in the Transcript tab.`}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  seek(c.start)
                }}
              >
                <span className="lbl">{c.words.map((w) => w.word.text.trim()).join(' ')}</span>
              </div>
            ))}
        {visible.map((r) => (
          <ItemBlock
            key={r.item.id}
            r={r}
            color={color}
            zoom={p.zoom}
            t0={p.t0}
            t1={p.t1}
            label={itemLabel(r.item, sourcePath)}
            selected={p.selection.includes(r.item.id)}
            pulsing={p.pulses.has(r.item.id)}
            locked={locked(r)}
            sources={p.sources}
            showWave={p.track.kind === 'aroll' || p.track.kind === 'music' || p.track.kind === 'sfx' || r.item.type === 'audio' || r.item.type === 'segment'}
            h={p.h}
          />
        ))}
        {p.segments &&
          p.segments.map((seg, i) => {
            if (i === 0 || seg.start < p.t0 || seg.start > p.t1) return null
            const prev = p.segments![i - 1]
            const sel = p.seamId === seg.item.id
            return (
              <Seam
                key={`seam_${seg.item.id}`}
                seg={seg}
                prev={prev}
                x={seg.start * p.zoom}
                selected={sel}
                edge={sel ? p.seamEdge : null}
                locked={!!p.lock && (seg.start < p.lock.start - 1e-3 || seg.start > p.lock.end + 1e-3)}
                h={p.h}
              />
            )
          })}
      </div>
    </div>
  )
})

function TrackHeader({ track, color, width, readOnly, captionsEnabled }: { track: Track; color: string; width: number; readOnly: boolean; captionsEnabled: boolean }) {
  const set = (patch: Partial<Track>) => void applyOp({ op: 'updateTrack', id: track.id, patch })
  const isCaptions = track.kind === 'captions'
  const hasAudio = track.kind === 'aroll' || track.kind === 'broll' || track.kind === 'music' || track.kind === 'sfx'
  return (
    <div className="tl-head" style={{ width }}>
      <div className="name" title={track.name}>
        <span className="swatch" style={{ background: color }} />
        <span className="ellipsis">{track.name}</span>
      </div>
      {isCaptions ? (
        <button
          className={`ms${captionsEnabled ? ' on-s' : ''}`}
          style={{ width: 30 }}
          disabled={readOnly}
          title={captionsEnabled ? 'Captions on. Click to turn them off for this project.' : 'Captions off. Click to turn them on.'}
          onClick={() => void applyOp({ op: 'patchProject', path: 'captions', patch: { enabled: !captionsEnabled } })}
        >
          CC
        </button>
      ) : (
        <>
          <button className={`ms${track.muted ? ' on-m' : ''}`} disabled={readOnly} title={track.muted ? 'Unmute' : 'Mute'} onClick={() => set({ muted: !track.muted })}>
            M
          </button>
          <button className={`ms${track.solo ? ' on-s' : ''}`} disabled={readOnly} title={track.solo ? 'Stop solo' : 'Solo'} onClick={() => set({ solo: !track.solo })}>
            S
          </button>
          {hasAudio && (
            <CommitSlider
              value={track.volume}
              min={-40}
              max={12}
              step={0.5}
              width={54}
              disabled={readOnly}
              title={`Track volume ${track.volume > 0 ? '+' : ''}${track.volume} dB`}
              onCommit={(v) => set({ volume: v })}
            />
          )}
        </>
      )}
    </div>
  )
}

const ItemBlock = memo(function ItemBlock(p: {
  r: ResolvedItem
  color: string
  zoom: number
  t0: number
  t1: number
  label: string
  selected: boolean
  pulsing: boolean
  locked: boolean
  sources: Map<string, Source>
  showWave: boolean
  h: LaneHandlers
}) {
  const { r, zoom } = p
  const d = useStore(drag, (s) => (s.id === r.item.id ? s.dt : 0))
  const mode = useStore(drag, (s) => (s.id === r.item.id ? s.mode : null))
  let start = r.start
  let end = r.end
  if (mode === 'move') {
    start += d
    end += d
  } else if (mode === 'trim-start') start = Math.min(end - 0.02, start + d)
  else if (mode === 'trim-end') end = Math.max(start + 0.02, end + d)

  const item = r.item
  let wave: ReactElement | null = null
  if (p.showWave && (item.type === 'segment' || item.type === 'audio')) {
    const visStart = Math.max(start, p.t0)
    const visEnd = Math.min(end, p.t1)
    if (visEnd > visStart) {
      const speed = item.type === 'segment' ? item.speed || 1 : 1
      const srcIn = item.in ?? 0
      const source = item.type === 'segment' ? { sourceId: item.sourceId } : item.sourceId ? { sourceId: item.sourceId } : { file: item.file }
      const loopLen = item.type === 'audio' && item.loop && item.sourceId ? p.sources.get(item.sourceId)?.duration : undefined
      const holdFrozen = item.type === 'segment' && item.hold
      if (!holdFrozen && (source.sourceId || source.file)) {
        wave = (
          <Waveform
            source={source}
            left={(visStart - start) * zoom}
            width={(visEnd - visStart) * zoom}
            srcStart={srcIn + (visStart - start) * speed}
            srcPerPx={speed / zoom}
            loopLength={loopLen}
            gainDb={item.volume ?? 0}
          />
        )
      }
    }
  }

  const picture = (item as { picture?: { kind?: string; note?: string } }).picture
  const cls = ['tl-item']
  if (p.selected) cls.push('sel')
  if (r.orphaned) cls.push('orphan')
  if (p.locked) cls.push('locked')
  if (mode) cls.push('dragging')
  if (p.pulsing) cls.push('pulse')
  const title =
    `${p.label}` +
    (r.orphaned ? '\nThe word this was tied to was cut. It now follows the next kept word.' : '') +
    (p.locked ? '\nLocked while Claude re-edits another section.' : '') +
    (picture ? `\n${picture.kind === 'stabilized' ? 'Stabilized' : 'Processed picture'}${picture.note ? `: ${picture.note}` : ''}. Right-click to go back to the original.` : '') +
    (item.type === 'segment' ? '\nDrag an edge to adjust the cut. Right-click to fix clipped audio or stabilize.' : '')
  return (
    <div
      className={cls.join(' ')}
      style={{ left: start * zoom, width: Math.max(2, (end - start) * zoom), ['--c' as string]: p.color }}
      title={title}
      onPointerDown={(e) => {
        e.stopPropagation()
        const t = e.target as HTMLElement
        p.h.itemDown(e, r, t.classList.contains('l') ? 'trim-start' : t.classList.contains('r') ? 'trim-end' : 'move')
      }}
      onContextMenu={(e) => {
        e.stopPropagation()
        p.h.itemMenu(e, r)
      }}
    >
      <span className="lbl">
        {r.orphaned ? '⚠ ' : ''}
        {picture?.kind === 'stabilized' ? '◎ ' : ''}
        {p.label}
      </span>
      {wave}
      {(end - start) * zoom > 14 && (
        <>
          <div className="edge l" />
          <div className="edge r" />
        </>
      )}
    </div>
  )
})

function Seam(p: { seg: PlacedSegment; prev: PlacedSegment; x: number; selected: boolean; edge: 'in' | 'out' | null; locked: boolean; h: LaneHandlers }) {
  return (
    <div
      className={`tl-seam${p.selected ? ' sel' : ''}`}
      style={{ left: p.x, opacity: p.locked ? 0.3 : 1 }}
      title="A cut. Drag the left half to move the end of the piece before, the right half to move the start of the piece after. Audio at the cut loops while you adjust."
      onContextMenu={(e) => {
        e.stopPropagation()
        p.h.seamMenu(e, p.seg, p.prev)
      }}
    >
      <div className={`half-l${p.edge === 'out' ? ' on' : ''}`} onPointerDown={(e) => (e.stopPropagation(), p.h.seamDown(e, p.seg, p.prev, 'out'))} />
      <div className={`half-r${p.edge === 'in' ? ' on' : ''}`} onPointerDown={(e) => (e.stopPropagation(), p.h.seamDown(e, p.seg, p.prev, 'in'))} />
    </div>
  )
}
