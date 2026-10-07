/**
 * Settings > Video themes: paste a YouTube video or channel link (or choose a video file) and the app measures
 * its editing style: cuts per minute, shot lengths, speech pace, loudness, and contact sheets of its shots.
 * Pick a theme when starting an edit and Claude edits to a similar pace and look.
 */
import { useCallback, useEffect, useState } from 'react'
import { themeOneLine, type VideoTheme, type VideoThemeProgress } from '@shared/videoTheme'
import { call, toast } from '../state/app'
import { Empty, Spinner } from '../components/bits'
import { Icon } from '../components/Icon'
import { VIDEO_EXTS, dateTime, mediaUrl } from '../util'

export function VideoThemesSection() {
  const [list, setList] = useState<VideoTheme[] | null>(null)
  const [link, setLink] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<VideoThemeProgress | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    const l = await call(() => window.api.themes.list())
    if (l) setList(l)
  }, [])
  useEffect(() => {
    void refresh()
    return window.api.themes.onProgress(setProgress)
  }, [refresh])

  const analyze = async (input: { link?: string; file?: string }) => {
    setBusy(true)
    setError('')
    setProgress({ step: 'listing', message: 'Starting…', percent: 0 })
    try {
      const t = await window.api.themes.analyze({ ...input, name: name.trim() || undefined })
      toast(`Video theme "${t.name}" is ready: ${themeOneLine(t)}.`)
      setLink('')
      setName('')
      await refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
      if (msg !== 'Cancelled') setError(msg)
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }
  const pickFile = async () => {
    const files = await call(() => window.api.app.pickFiles({ title: 'Choose a reference video', filters: [{ name: 'Video', extensions: VIDEO_EXTS }] }))
    if (files?.[0]) await analyze({ file: files[0] })
  }

  return (
    <div className="col" style={{ gap: 0 }}>
      <div className="section col">
        <h3>Video themes</h3>
        <span className="hint">
          Give the app a YouTube video or channel whose editing you like. It measures the pace (cuts per minute, shot lengths, how fast
          the opening is), the speech pace and loudness, and keeps a contact sheet of the shots. Choose the theme when you start an edit
          and Claude edits to a similar pace and style. For a channel, its newest 3 long-form videos are measured (Shorts and live streams
          are skipped). Only the first 12 minutes of each are read, at low resolution; the downloads are deleted afterwards. Making a
          theme uses no Claude usage.
        </span>
        <div className="row wrap" style={{ gap: 8, marginTop: 6 }}>
          <input
            className="grow"
            style={{ minWidth: 280 }}
            placeholder="YouTube video or channel link, e.g. https://www.youtube.com/@channel"
            value={link}
            disabled={busy}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && link.trim() && !busy && void analyze({ link })}
          />
          <input style={{ width: 200 }} placeholder="Name (optional)" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
          <button className="btn primary" disabled={busy || !link.trim()} onClick={() => void analyze({ link })}>
            Analyze
          </button>
          <button className="btn" disabled={busy} onClick={() => void pickFile()} title="Use a video file on this PC instead of a link">
            Choose a video file…
          </button>
        </div>
        {busy && progress && (
          <div className="row" style={{ gap: 10, marginTop: 8 }}>
            <Spinner />
            <span className="small grow">{progress.message}</span>
            {progress.percent !== undefined && <span className="small muted">{progress.percent}%</span>}
            <button className="btn small" onClick={() => void window.api.themes.cancel()}>
              Cancel
            </button>
          </div>
        )}
        {error && <div className="warn small selectable" style={{ marginTop: 6 }}>{error}</div>}
      </div>

      {!list ? (
        <Spinner label="Loading themes…" />
      ) : !list.length ? (
        <Empty title="No video themes yet">Paste a link above to make one.</Empty>
      ) : (
        list.map((t) => <ThemeCard key={t.id} theme={t} onChanged={refresh} />)
      )}
    </div>
  )
}

function ThemeCard({ theme: t, onChanged }: { theme: VideoTheme; onChanged: () => Promise<void> }) {
  const [name, setName] = useState(t.name)
  const [notes, setNotes] = useState(t.notes)
  const [sheets, setSheets] = useState<{ label: string; path: string }[] | null>(null)
  useEffect(() => {
    setName(t.name)
    setNotes(t.notes)
  }, [t.name, t.notes])
  const save = async (patch: { name?: string; notes?: string }) => {
    await call(() => window.api.themes.update(t.id, patch))
    await onChanged()
  }
  const a = t.averages
  const speech = t.videos.find((v) => v.stats.speech?.firstWords)?.stats.speech
  return (
    <div className="section col theme-card">
      <div className="row" style={{ gap: 8 }}>
        <input className="grow theme-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== t.name && void save({ name })} />
        <span className="small muted">{dateTime(t.createdAt)}</span>
        <button
          className="btn small ghost"
          title="Delete this theme. Projects that use it edit without it from then on."
          onClick={async () => {
            if (!confirm(`Delete the video theme "${t.name}"?`)) return
            await call(() => window.api.themes.remove(t.id))
            await onChanged()
          }}
        >
          <Icon name="trash" size={14} /> Delete
        </button>
      </div>
      <div className="small muted">
        From {t.source.kind === 'file' ? 'the file' : `the ${t.source.kind}`} {t.source.title ? `"${t.source.title}"` : t.source.input} ·{' '}
        {t.videos.length} video{t.videos.length > 1 ? 's' : ''} measured
        {t.videos.length > 1 ? `: ${t.videos.map((v) => v.title).filter(Boolean).join(' · ')}` : ''}
      </div>
      <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
        <span className="chip" title="Cuts per minute over the measured part">{a.cutsPerMinute} cuts/min</span>
        <span className="chip" title="Cuts per minute in the first 30 seconds: how fast the hook is">{a.cutsPerMinuteFirst30s} cuts/min in the first 30 s</span>
        <span className="chip" title="Half of the shots are shorter than this">shots ~{a.medianShotSeconds} s</span>
        {a.wordsPerMinute !== undefined && <span className="chip">{a.wordsPerMinute} words/min</span>}
        {a.loudnessLufs !== undefined && <span className="chip">{a.loudnessLufs} LUFS</span>}
      </div>
      {speech?.firstWords && <div className="small muted" style={{ marginTop: 6 }}>Opens with: “{speech.firstWords.slice(0, 160)}{speech.firstWords.length > 160 ? '…' : ''}”</div>}
      <div className="small" style={{ marginTop: 6 }}>
        <b>Claude's read of the style: </b>
        {t.summary ? <span className="selectable">{t.summary}</span> : <span className="muted">written the first time Claude edits with this theme.</span>}
      </div>
      <label className="small" style={{ marginTop: 6 }}>Your notes for Claude (what to copy, what to leave out)</label>
      <textarea rows={2} value={notes} placeholder="e.g. Copy the pace and the zoom punch-ins. Skip the meme sound effects." onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== t.notes && void save({ notes })} />
      {sheets === null ? (
        <button className="btn small ghost" style={{ alignSelf: 'flex-start' }} onClick={async () => setSheets((await call(() => window.api.themes.sheets(t.id))) ?? [])}>
          Show the contact sheets
        </button>
      ) : (
        <div className="col" style={{ gap: 6 }}>
          {sheets.map((s) => (
            <div key={s.path} className="col" style={{ gap: 2 }}>
              <span className="small muted">{s.label}</span>
              <img className="theme-sheet" src={mediaUrl(s.path)} alt={s.label} />
            </div>
          ))}
          {!sheets.length && <span className="small muted">No contact sheets were kept for this theme.</span>}
        </div>
      )}
    </div>
  )
}
