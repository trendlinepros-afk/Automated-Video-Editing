/**
 * Shorts: vertical clips Claude cuts from this video for YouTube Shorts and TikTok. Make Shorts asks how many;
 * each Short shows its preview, why it was chosen, and its titles, with Export, Change and Delete.
 */
import { useEffect, useState } from 'react'
import { SHORT_COUNTS, shortDuration, type Short } from '@shared/shorts'
import type { ShortsState } from '@shared/ipc'
import { call, toast } from '../state/app'
import { editor, setTab } from '../state/editor'
import { useStore } from '../state/store'
import { Modal } from '../components/Modal'
import { CopyButton, Toggle } from '../components/bits'
import { EstimateNote, useEstimate } from '../editor/EstimateNote'
import { errorMessage, mediaUrl } from '../util'

export function ShortsPanel() {
  const shorts = useStore(editor, (s) => s.snapshot!.doc.project.shorts ?? [])
  const dir = useStore(editor, (s) => s.snapshot!.path)
  const readOnly = useStore(editor, (s) => s.snapshot!.readOnly)
  const working = useStore(editor, (s) => s.snapshot!.doc.project.requests.some((r) => r.kind === 'make_shorts' && (r.status === 'queued' || r.status === 'in_progress')))
  const [state, setState] = useState<ShortsState>({ working: {} })
  const [asking, setAsking] = useState<{ redo?: Short } | null>(null)
  const [exporting, setExporting] = useState(false)
  useEffect(() => {
    void window.api.shorts.state().then(setState, () => undefined)
    return window.api.shorts.onState(setState)
  }, [])

  const exportAll = async () => {
    setExporting(true)
    const files = await call(() => window.api.shorts.exportAll(), 'Could not export the Shorts')
    setExporting(false)
    if (files?.length) toast(`Exported ${files.length} Short${files.length > 1 ? 's' : ''} with a text file of titles and hashtags for each.`, { actions: [{ label: 'Show files', run: () => void window.api.app.showItemInFolder(files[0]) }] })
  }

  return (
    <div className="panel col" style={{ gap: 10 }}>
      <div className="row">
        <button className="btn primary" disabled={readOnly || working} onClick={() => setAsking({})}>
          {working ? 'Claude is making Shorts…' : shorts.length ? 'Make more Shorts' : 'Make Shorts'}
        </button>
        <span className="spacer" />
        {shorts.length > 1 && (
          <button className="btn" disabled={exporting} onClick={() => void exportAll()}>
            {exporting ? 'Exporting…' : `Export all ${shorts.length}`}
          </button>
        )}
      </div>
      {!shorts.length && (
        <div className="muted small">
          Claude finds the hook, the high-action moments and anything that stops a scroll, and cuts each into a vertical Short with big, bold
          captions and titles for YouTube Shorts and TikTok. For an unboxing or review it can also make one 30-second recap: box open, what is
          inside, it in use, done.
        </div>
      )}
      {shorts.map((s, i) => (
        <ShortCard key={s.id} n={i + 1} short={s} dir={dir} status={state.working[s.id]} readOnly={readOnly} onRedo={() => setAsking({ redo: s })} />
      ))}
      {asking && <MakeShortsDialog redo={asking.redo} existing={shorts.length} onClose={() => setAsking(null)} />}
    </div>
  )
}

function ShortCard({ n, short: s, dir, status, readOnly, onRedo }: { n: number; short: Short; dir: string; status?: string; readOnly: boolean; onRedo: () => void }) {
  const [busy, setBusy] = useState(false)
  const preview = s.preview ? mediaUrl(s.preview, dir) : undefined
  const exportOne = async () => {
    setBusy(true)
    const out = await call(() => window.api.shorts.exportShort(s.id), 'Could not export the Short')
    setBusy(false)
    if (out) toast(`Exported "${s.title}" (1080x1920) with its titles and hashtags.`, { actions: [{ label: 'Show file', run: () => void window.api.app.showItemInFolder(out) }] })
  }
  const tags = s.hashtags.map((h) => `#${h}`).join(' ')
  return (
    <div className="short-card">
      <div className="short-video">
        {preview ? <video src={preview} controls preload="metadata" /> : <div className="short-placeholder small muted">{status ?? 'Preview coming…'}</div>}
      </div>
      <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
        <div className="row" style={{ gap: 6 }}>
          <b className="grow ellipsis" title={s.title}>
            {n}. {s.title}
          </b>
          <span className={`chip${s.kind === 'recap' ? ' accent' : ''}`}>{s.kind === 'recap' ? '30 s recap' : 'Highlight'}</span>
          <span className="small muted">{shortDuration(s).toFixed(0)} s</span>
        </div>
        {s.reason && <div className="small muted">{s.reason}</div>}
        {status && preview && <div className="small warn">{status}</div>}
        <div className="short-meta small">
          <div className="row">
            <span className="muted">YouTube</span>
            <span className="grow selectable">{s.youtubeTitle || s.title}</span>
            <CopyButton text={s.youtubeTitle || s.title} />
          </div>
          <div className="row">
            <span className="muted">TikTok</span>
            <span className="grow selectable">{s.tiktokCaption || '—'}</span>
            {s.tiktokCaption && <CopyButton text={`${s.tiktokCaption} ${tags}`.trim()} />}
          </div>
          {tags && (
            <div className="row">
              <span className="muted">Tags</span>
              <span className="grow selectable">{tags}</span>
            </div>
          )}
        </div>
        <div className="row" style={{ gap: 6, marginTop: 4 }}>
          <button className="btn small primary" disabled={busy} onClick={() => void exportOne()}>
            {busy ? 'Exporting…' : 'Export'}
          </button>
          <button className="btn small" disabled={readOnly} onClick={onRedo} title="Ask Claude to change or remake this Short">
            Change…
          </button>
          <span className="spacer" />
          <button
            className="btn small ghost"
            disabled={readOnly}
            onClick={async () => {
              if (!confirm(`Delete the Short "${s.title}"?`)) return
              await call(() => window.api.shorts.remove(s.id))
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

function MakeShortsDialog({ redo, existing, onClose }: { redo?: Short; existing: number; onClose: () => void }) {
  const [count, setCount] = useState<number>(6)
  const [recap, setRecap] = useState(true)
  const [note, setNote] = useState('')
  const est = useEstimate('make_shorts')
  const send = async () => {
    try {
      await window.api.project.requestShorts({ count, recap: recap && !redo, note: note.trim() || undefined, redoId: redo?.id })
    } catch (e) {
      toast(`Could not ask Claude: ${errorMessage(e)}`, { kind: 'error' })
      return
    }
    onClose()
    setTab('chat')
    toast(redo ? `Asked Claude to change "${redo.title}".` : `Claude is finding the best moments for up to ${count} Short${count > 1 ? 's' : ''}. They appear in the Shorts tab as they are made.`)
  }
  return (
    <Modal
      title={redo ? `Change "${redo.title}"` : 'Make Shorts'}
      onClose={onClose}
      footer={
        <>
          <EstimateNote estimate={est} />
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void send()} disabled={!!redo && !note.trim()}>
            {redo ? 'Change it' : 'Make Shorts'}
          </button>
        </>
      }
    >
      {redo ? (
        <span className="hint">Tell Claude what to change: a different moment, a stronger hook, shorter, other titles…</span>
      ) : (
        <>
          <label className="small">How many highlight Shorts{existing ? ' more' : ''}?</label>
          <div className="row" style={{ gap: 6 }}>
            {SHORT_COUNTS.map((n) => (
              <button key={n} className={`btn${count === n ? ' primary' : ''}`} onClick={() => setCount(n)} style={{ minWidth: 44 }}>
                {n}
              </button>
            ))}
          </div>
          <span className="hint">
            Up to this many. Claude makes fewer when the video does not have that many distinct moments, so no two Shorts feel the same, and
            says why.
          </span>
          <Toggle checked={recap} onChange={setRecap} label="Also make a 30-second recap if this is an unboxing or review (box open, what is inside, it in use)" />
        </>
      )}
      <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={redo ? 'e.g. start on the crash, and make it shorter' : 'Anything Claude should know (optional), e.g. focus on the drifting'} />
    </Modal>
  )
}
