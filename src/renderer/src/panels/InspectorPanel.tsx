/** Inspector: options for the selected item only. Every change is one undo step. */
import { useEffect, useState, type ReactNode } from 'react'
import type { Item, Transform } from '@shared/project'
import type { ResolvedItem } from '@shared/timeline'
import { call } from '../state/app'
import { applyOp, editor, openDialog } from '../state/editor'
import { useDerived, type Derived } from '../state/derived'
import { seek } from '../state/player'
import { useStore } from '../state/store'
import { CommitSlider, Empty, NumberInput, TimeInput, Toggle } from '../components/bits'
import { Icon } from '../components/Icon'
import { canEdit, canHaveAudio, canSaveToLibrary, deleteItems, fixAudio, nudgeSeam } from '../editor/actions'
import { AUDIO_EXTS, basename, fmt, itemLabel, joinPath } from '../util'

const TYPE_LABELS: Record<Item['type'], string> = { segment: 'A-roll piece', clip: 'Picture', graphic: 'Graphic', effect: 'Effect', audio: 'Audio' }

export function InspectorPanel() {
  const selection = useStore(editor, (s) => s.selection)
  const seam = useStore(editor, (s) => s.seam)
  const d = useDerived()
  if (!d) return null
  if (seam) return <SeamInspector d={d} />
  if (!selection.length) {
    return (
      <div className="panel">
        <Empty title="Nothing selected">
          <div className="small">Click something on the timeline to change it. Click a cut seam in the A-roll to adjust the cut by ear.</div>
        </Empty>
      </div>
    )
  }
  if (selection.length > 1) {
    return (
      <div className="panel">
        <h3>{selection.length} items selected</h3>
        <div className="row">
          <button className="btn danger" onClick={() => void deleteItems(selection)}>
            <Icon name="trash" size={14} /> Delete all
          </button>
        </div>
        <span className="hint">Arrow keys move them together. Shift moves further.</span>
      </div>
    )
  }
  const r = d.resolved.get(selection[0])
  if (!r) return null
  return <ItemInspector key={r.item.id} r={r} d={d} />
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field-row" style={{ gridTemplateColumns: '96px 1fr' }}>
      <span className="label">{label}</span>
      <div className="row wrap">{children}</div>
    </div>
  )
}

function ItemInspector({ r, d }: { r: ResolvedItem; d: Derived }) {
  const snap = useStore(editor, (s) => s.snapshot!)
  const item = r.item
  const ro = snap.readOnly
  const sourcePath = (id: string) => d.sources.get(id)?.path
  const [label, setLabel] = useState(itemLabel(item, sourcePath))
  useEffect(() => setLabel(itemLabel(item, sourcePath)), [item.label]) // eslint-disable-line react-hooks/exhaustive-deps
  const update = (patch: Record<string, unknown>) => {
    if (canEdit(item.id)) void applyOp({ op: 'updateItem', id: item.id, patch })
  }
  const anchorWord = item.type !== 'segment' && item.anchor.kind === 'word' ? d.resolver.words.get(item.anchor.wordId)?.word : undefined

  return (
    <div className="panel">
      <div className="col" style={{ gap: 4 }}>
        <input
          type="text"
          value={label}
          disabled={ro}
          style={{ fontWeight: 600 }}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label.trim() && label !== itemLabel(item, sourcePath) && update({ label: label.trim() })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <div className="row wrap small muted">
          <span className="tag">{item.type === 'effect' ? `Effect: ${item.effect.replace('_', ' ')}` : TYPE_LABELS[item.type]}</span>
          <span>{d.tracks.find((t) => t.id === item.trackId)?.name}</span>
          <span>· made by {item.createdBy === 'user' ? 'you' : item.createdBy === 'claude' ? 'Claude' : 'the app'}</span>
          {item.libraryAssetId && <span>· in the library</span>}
        </div>
        {r.orphaned && <div className="small warn">The word this was tied to was cut. It now follows the next kept word; move it if that is wrong.</div>}
      </div>

      <div className="section col" style={{ paddingTop: 6 }}>
        <h4>Timing</h4>
        {item.type === 'segment' ? (
          <>
            <Row label="Source">
              <span className="small ellipsis" title={sourcePath(item.sourceId)}>
                {basename(sourcePath(item.sourceId) ?? item.sourceId)}
              </span>
            </Row>
            <Row label="Starts in source">
              <TimeInput value={item.in} disabled={ro} onCommit={(t) => canEdit(item.id) && void applyOp({ op: 'nudgeSegment', id: item.id, edge: 'in', delta: round(t - item.in) })} />
            </Row>
            <Row label="Ends in source">
              <TimeInput value={item.out} disabled={ro} onCommit={(t) => canEdit(item.id) && void applyOp({ op: 'nudgeSegment', id: item.id, edge: 'out', delta: round(t - item.out) })} />
            </Row>
            <Row label="On timeline">
              <a onClick={() => seek(r.start)}>{fmt(r.start, true)}</a>
              <span className="small muted">for {(r.end - r.start).toFixed(2)} s{item.speed !== 1 ? ` at ${item.speed}×` : ''}{item.hold ? ' (freeze frame)' : ''}</span>
            </Row>
          </>
        ) : (
          <>
            <Row label="Start">
              <TimeInput value={r.start} disabled={ro} onCommit={(t) => canEdit(item.id) && void applyOp({ op: 'moveItem', id: item.id, start: t })} />
              <button className="btn ghost small" onClick={() => seek(r.start)} title="Move the playhead here">
                Go
              </button>
            </Row>
            <Row label="Length">
              <NumberInput value={item.duration} step={0.1} min={0.04} disabled={ro} onCommit={(v) => update({ duration: v })} />
              <span className="small muted">seconds</span>
            </Row>
            <div className="hint">
              {anchorWord
                ? `Tied to the word “${anchorWord.text.trim()}”${item.anchor.kind === 'word' && item.anchor.offset ? ` ${item.anchor.offset > 0 ? '+' : ''}${item.anchor.offset.toFixed(2)} s` : ''}, so it moves with that word when cuts change.`
                : 'Tied to a fixed time on the timeline.'}
            </div>
          </>
        )}
      </div>

      {(item.type === 'segment' || item.type === 'audio' || item.type === 'clip') && (
        <div className="section col">
          <h4>Sound</h4>
          <Row label="Volume">
            <CommitSlider value={item.volume} min={-60} max={12} step={0.5} disabled={ro} onCommit={(v) => update({ volume: v })} format={(v) => (v <= -60 ? 'Off' : `${v > 0 ? '+' : ''}${v} dB`)} />
          </Row>
          <Row label="Fade in">
            <NumberInput value={item.fadeIn} step={0.1} min={0} disabled={ro} onCommit={(v) => update({ fadeIn: v })} />
            <span className="small muted">s</span>
          </Row>
          <Row label="Fade out">
            <NumberInput value={item.fadeOut} step={0.1} min={0} disabled={ro} onCommit={(v) => update({ fadeOut: v })} />
            <span className="small muted">s</span>
          </Row>
          {item.type === 'segment' && <Toggle checked={!!item.muted} disabled={ro} onChange={(v) => update({ muted: v })} label="Mute this piece" />}
          {item.type === 'audio' && (
            <>
              <Toggle checked={item.duck} disabled={ro} onChange={(v) => update({ duck: v })} label="Lower under speech" />
              <Toggle checked={item.loop} disabled={ro} onChange={(v) => update({ loop: v })} label="Loop" />
              <Row label="File">
                <span className="small ellipsis grow" title={item.file ?? sourcePath(item.sourceId ?? '')}>
                  {basename(item.file ?? sourcePath(item.sourceId ?? '') ?? '')}
                </span>
                <button
                  className="btn small"
                  disabled={ro}
                  onClick={async () => {
                    if (!canEdit(item.id)) return
                    const files = await call(() => window.api.app.pickFiles({ title: 'Swap the audio file', filters: [{ name: 'Audio', extensions: AUDIO_EXTS }] }))
                    if (files?.[0]) void applyOp({ op: 'swapFile', id: item.id, path: files[0] })
                  }}
                >
                  Swap file
                </button>
              </Row>
            </>
          )}
        </div>
      )}

      {(item.type === 'graphic' || item.type === 'clip') && (
        <TransformEditor value={item.transform} disabled={ro} keyframes={item.keyframes?.length ?? 0} onChange={(t) => update({ transform: t })} />
      )}

      {(item.type === 'graphic' || item.type === 'effect') && (
        <div className="section col">
          <h4>{item.type === 'graphic' ? 'Inputs' : 'Settings'}</h4>
          <ParamsEditor params={item.params} disabled={ro} onChange={(params) => update({ params })} />
          {item.file && (
            <div className="row small">
              <code className="grow ellipsis">{item.file}</code>
              <button className="btn ghost small" onClick={() => void window.api.app.showItemInFolder(joinPath(snap.path, item.file!))} title="Show the code file">
                <Icon name="folder" size={13} />
              </button>
            </div>
          )}
        </div>
      )}

      <div className="section col">
        {canHaveAudio(item) && (
          <button className="btn" disabled={ro} onClick={() => void fixAudio({ itemId: item.id, segmentId: item.type === 'segment' ? item.id : undefined, time: editor.get().playhead >= r.start && editor.get().playhead <= r.end ? editor.get().playhead : r.start })}>
            <Icon name="wand" size={14} /> Fix clipped audio
          </button>
        )}
        {canSaveToLibrary(item) && (
          <button className="btn" onClick={() => openDialog({ kind: 'saveToLibrary', itemId: item.id })}>
            Save to library…
          </button>
        )}
        <button className="btn" disabled={ro} onClick={() => openDialog({ kind: 'note', itemId: item.id })}>
          <Icon name="note" size={14} /> Leave a note for Claude
        </button>
        <button className="btn danger" disabled={ro} onClick={() => void deleteItems([item.id])}>
          <Icon name="trash" size={14} /> Delete
        </button>
      </div>
    </div>
  )
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }

function TransformEditor({ value, onChange, disabled, keyframes }: { value?: Transform; onChange: (t: Transform) => void; disabled: boolean; keyframes: number }) {
  const t = { ...DEFAULT_TRANSFORM, ...(value ?? {}) }
  const set = (patch: Partial<Transform>) => onChange({ ...t, ...patch })
  return (
    <div className="section col">
      <h4>Position and size</h4>
      <Row label="Left / right">
        <CommitSlider value={t.x} min={-0.5} max={0.5} step={0.005} disabled={disabled} onCommit={(v) => set({ x: v })} format={(v) => `${Math.round(v * 100)}%`} />
      </Row>
      <Row label="Up / down">
        <CommitSlider value={t.y} min={-0.5} max={0.5} step={0.005} disabled={disabled} onCommit={(v) => set({ y: v })} format={(v) => `${Math.round(v * 100)}%`} />
      </Row>
      <Row label="Scale">
        <CommitSlider value={t.scale} min={0.1} max={3} step={0.01} disabled={disabled} onCommit={(v) => set({ scale: v })} format={(v) => `${Math.round(v * 100)}%`} />
      </Row>
      <Row label="Rotation">
        <CommitSlider value={t.rotation} min={-180} max={180} step={1} disabled={disabled} onCommit={(v) => set({ rotation: v })} format={(v) => `${v}°`} />
      </Row>
      <Row label="Opacity">
        <CommitSlider value={t.opacity} min={0} max={1} step={0.01} disabled={disabled} onCommit={(v) => set({ opacity: v })} format={(v) => `${Math.round(v * 100)}%`} />
      </Row>
      <span className="hint">
        {keyframes > 0
          ? `It follows ${keyframes} points along the way. Drag the handle on the preview to correct the point nearest the playhead.`
          : 'You can also drag the handle on the preview while the playhead is over it.'}
      </span>
    </div>
  )
}

function ParamsEditor({ params, onChange, disabled }: { params: Record<string, unknown>; onChange: (p: Record<string, unknown>) => void; disabled: boolean }) {
  const keys = Object.keys(params)
  if (!keys.length) return <span className="small muted">No settings to change.</span>
  const set = (k: string, v: unknown) => onChange({ ...params, [k]: v })
  return (
    <>
      {keys.map((k) => {
        const v = params[k]
        const label = k.replace(/[_-]+/g, ' ')
        let control: ReactNode
        if (typeof v === 'number') control = <NumberInput value={v} step={Math.abs(v) < 2 ? 0.05 : 1} disabled={disabled} onCommit={(n) => set(k, n)} />
        else if (typeof v === 'boolean') control = <input type="checkbox" checked={v} disabled={disabled} onChange={(e) => set(k, e.target.checked)} />
        else if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) control = <input type="color" value={v} disabled={disabled} onChange={(e) => set(k, e.target.value)} />
        else if (typeof v === 'string') control = <TextParam value={v} disabled={disabled} onCommit={(s) => set(k, s)} />
        else control = <JsonParam value={v} disabled={disabled} onCommit={(j) => set(k, j)} />
        return (
          <Row key={k} label={label}>
            {control}
          </Row>
        )
      })}
    </>
  )
}

function TextParam({ value, onCommit, disabled }: { value: string; onCommit: (s: string) => void; disabled: boolean }) {
  const [s, setS] = useState(value)
  useEffect(() => setS(value), [value])
  const long = value.length > 40 || value.includes('\n')
  const props = {
    value: s,
    disabled,
    className: 'grow',
    onChange: (e: { target: { value: string } }) => setS(e.target.value),
    onBlur: () => s !== value && onCommit(s)
  }
  return long ? <textarea rows={3} {...props} /> : <input type="text" {...props} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
}

function JsonParam({ value, onCommit, disabled }: { value: unknown; onCommit: (v: unknown) => void; disabled: boolean }) {
  const text = JSON.stringify(value, null, 1)
  const [s, setS] = useState(text)
  const [bad, setBad] = useState(false)
  useEffect(() => setS(text), [text])
  return (
    <textarea
      rows={Math.min(6, text.split('\n').length)}
      className="mono small grow"
      value={s}
      disabled={disabled}
      style={bad ? { borderColor: 'var(--bad)' } : undefined}
      onChange={(e) => setS(e.target.value)}
      onBlur={() => {
        try {
          const v = JSON.parse(s)
          setBad(false)
          if (JSON.stringify(v) !== JSON.stringify(value)) onCommit(v)
        } catch {
          setBad(true)
        }
      }}
    />
  )
}

function SeamInspector({ d }: { d: Derived }) {
  const seam = useStore(editor, (s) => s.seam)!
  const seg = d.segments.find((s) => s.item.id === seam.segmentId)
  const prev = d.segments.find((s) => s.item.id === seam.prevId)
  if (!seg || !prev) return null
  const name = (id: string) => basename(d.sources.get(id)?.path ?? id)
  return (
    <div className="panel">
      <h3>Cut at {fmt(seg.start, true)}</h3>
      <div className="small muted">The audio around this cut plays on loop while it is selected. Nudge until no word is clipped.</div>
      <div className="section col">
        <Row label="Before ends">
          <span className="mono small">{fmt(prev.item.out, true)}</span>
          <span className="small faint ellipsis">in {name(prev.item.sourceId)}</span>
        </Row>
        <Row label="After starts">
          <span className="mono small">{fmt(seg.item.in, true)}</span>
          <span className="small faint ellipsis">in {name(seg.item.sourceId)}</span>
        </Row>
        <Row label="Adjusting">
          <span className="small">{seam.edge === 'out' ? 'the end of the piece before' : 'the start of the piece after'}</span>
        </Row>
        <div className="row wrap">
          {[-50, -10, -5, 5, 10, 50].map((ms) => (
            <button key={ms} className="btn small" onClick={() => void nudgeSeam(seam, ms / 1000)}>
              {ms > 0 ? '+' : '−'}
              {Math.abs(ms)} ms
            </button>
          ))}
        </div>
        <span className="hint">Arrow keys nudge 5 ms, Shift + arrows 50 ms. Esc when done.</span>
      </div>
      <div className="section col">
        <button className="btn" onClick={() => void fixAudio({ segmentId: seg.item.id, time: seg.start })}>
          <Icon name="wand" size={14} /> Fix clipped audio
        </button>
        <span className="hint">Claude restores the missing part of the word and adjusts the cut. It uses a little Claude usage.</span>
        <button className="btn" onClick={() => openDialog({ kind: 'note', range: { start: Math.max(0, seg.start - 1), end: seg.start + 1 }, time: seg.start })}>
          <Icon name="note" size={14} /> Leave a note for Claude
        </button>
      </div>
    </div>
  )
}
