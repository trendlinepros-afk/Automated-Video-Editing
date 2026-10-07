/**
 * The preview: a low-resolution render from the same compositor as the export, rebuilt in chunks.
 * Play, pause, scrub, frame step and full screen, Before/After for changes under review,
 * and the Start edit / intro panels for new projects.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { editor, review, showBefore } from '../state/editor'
import { useDerived } from '../state/derived'
import { attachVideo, seek, stepFrames, toggle, videoReloaded } from '../state/player'
import { useStore } from '../state/store'
import { Icon } from '../components/Icon'
import { fmt, fmtRange, mediaUrl } from '../util'
import { IntroPanel, StartPanel } from './StartPanel'
import { GraphicHandle } from './GraphicHandle'

export function Preview() {
  const preview = useStore(editor, (s) => s.preview)
  const beforeId = useStore(editor, (s) => s.beforeRequestId)
  const status = useStore(editor, (s) => s.snapshot!.doc.project.status)
  // Just the intro, stopped there (or not yet continued): the rest of the edit is still on offer.
  const introOnly = useStore(editor, (s) => s.snapshot!.doc.project.scope.mode === 'intro' && s.snapshot!.doc.project.scope.introEnd != null)
  const hasCuts = useStore(editor, (s) => s.snapshot!.doc.project.items.some((i) => i.type === 'segment'))
  const box = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [startHidden, setStartHidden] = useState(false)

  const showingBefore = !!beforeId && !!preview.beforeFile
  const file = showingBefore ? preview.beforeFile : preview.file
  const src = useMemo(() => {
    const u = mediaUrl(file)
    return u ? `${u}${u.includes('?') ? '&' : '?'}v=${preview.version}${showingBefore ? 'b' : ''}` : undefined
  }, [file, preview.version, showingBefore])

  useEffect(() => {
    attachVideo(video.current)
    return () => attachVideo(null)
  }, [])

  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void box.current?.requestFullscreen()
  }

  return (
    <div className="preview" ref={box}>
      <div className="preview-stage" ref={stage} onDoubleClick={fullscreen}>
        <video ref={video} src={src} preload="auto" onLoadedMetadata={videoReloaded} onClick={toggle} playsInline />
        {!src && (
          <div className="preview-empty">
            <EmptyPreview hasCuts={hasCuts} />
          </div>
        )}
        {preview.status === 'rendering' && (
          <div className="preview-overlay">
            <span className="spinner" />
            Updating preview… {preview.chunksDone} of {preview.chunksTotal}
          </div>
        )}
        {preview.status === 'error' && <div className="preview-overlay bad">Preview could not be rendered: {preview.message}</div>}
        {showingBefore && <div className="preview-badge">BEFORE</div>}
        {!showingBefore && <GraphicHandle stage={stage} video={video} />}
        {status === 'new' && !startHidden && <StartPanel onStarted={() => setStartHidden(true)} />}
        {status === 'intro_ready' && <IntroPanel />}
        {status === 'ready_for_review' && introOnly && <IntroPanel stopped />}
      </div>
      <ReviewBar />
      <ListenReminder />
      <Transport onFullscreen={fullscreen} />
    </div>
  )
}

function EmptyPreview({ hasCuts }: { hasCuts: boolean }) {
  const runner = useStore(editor, (s) => s.runner)
  const preview = useStore(editor, (s) => s.preview)
  if (hasCuts && (preview.status === 'unavailable' || preview.status === 'error')) {
    return (
      <div className="empty">
        <h3>No preview</h3>
        <div className="warn">{preview.message ?? 'The preview is not available on this PC.'}</div>
      </div>
    )
  }
  if (hasCuts) {
    return (
      <div className="empty">
        <span className="spinner" />
        <div>{preview.message ?? 'Building the preview…'}</div>
      </div>
    )
  }
  if (runner.status === 'running' || runner.status === 'starting') {
    return (
      <div className="empty">
        <span className="pulse-dot" />
        <h3>Claude is reviewing the footage</h3>
        <div className="muted ellipsis" style={{ maxWidth: 480 }}>
          {runner.lastActivity ?? 'The edit appears on the timeline as it is built.'}
        </div>
      </div>
    )
  }
  return (
    <div className="empty" style={{ maxWidth: 520 }}>
      <h3>Waiting for Claude to connect</h3>
      {runner.waitingReason ? <div className="warn">{runner.waitingReason}</div> : null}
      <ol className="muted">
        <li>Make sure Claude Code is installed and signed in (run <code>claude</code> once in a terminal).</li>
        <li>Press Start edit. The app starts Claude in the background, already connected to this project.</li>
        <li>
          Or connect by hand: Settings → Claude connection → Copy setup, then paste it into Claude Code or the Claude desktop app.
        </li>
      </ol>
      {runner.queue > 0 && <div className="small">{runner.queue} request(s) are waiting and run as soon as Claude connects.</div>}
    </div>
  )
}

function Transport({ onFullscreen }: { onFullscreen: () => void }) {
  const playhead = useStore(editor, (s) => s.playhead)
  const playing = useStore(editor, (s) => s.playing)
  const rate = useStore(editor, (s) => s.rate)
  const d = useDerived()
  const duration = d?.duration ?? 0
  return (
    <div className="preview-controls">
      <button className="btn ghost icon" onClick={() => stepFrames(-1)} title="Back one frame (←)">
        <Icon name="prev" size={14} />
      </button>
      <button className="btn ghost icon" onClick={toggle} title="Play / pause (Space)">
        <Icon name={playing ? 'pause' : 'play'} />
      </button>
      <button className="btn ghost icon" onClick={() => stepFrames(1)} title="Forward one frame (→)">
        <Icon name="next" size={14} />
      </button>
      <span className="time">
        {fmt(playhead, true)} / {fmt(duration)}
        {playing && rate !== 1 ? ` · ${rate > 0 ? '' : '◀ '}${Math.abs(rate)}×` : ''}
      </span>
      <input type="range" min={0} max={Math.max(duration, 0.01)} step={0.01} value={Math.min(playhead, duration)} onChange={(e) => seek(parseFloat(e.target.value))} />
      <button className="btn ghost icon" onClick={onFullscreen} title="Full screen (double-click the video)">
        <Icon name="full" />
      </button>
    </div>
  )
}

/** Before/After with Keep and Revert for finished changes waiting for your review. */
function ReviewBar() {
  const requests = useStore(editor, (s) => s.snapshot!.doc.project.requests)
  const beforeId = useStore(editor, (s) => s.beforeRequestId)
  const pending = requests.filter((r) => r.review === 'pending')
  if (!pending.length) return null
  const r = pending[pending.length - 1]
  const what = r.kind === 'reedit' ? 'Section re-edit' : r.kind === 'chat' ? 'Chat change' : r.kind === 'fix_audio' ? 'Audio fix' : r.kind === 'stabilize' ? 'Stabilize' : 'Change'
  return (
    <div className="review-bar">
      <b>{what}</b>
      {r.range && (
        <a onClick={() => seek(r.range!.start)} title="Jump there">
          {fmtRange(r.range)}
        </a>
      )}
      <span className="grow ellipsis muted" title={r.summary}>
        {r.summary ?? r.text}
      </span>
      {pending.length > 1 && <span className="chip">{pending.length - 1} more</span>}
      <div className="seg">
        <button className={beforeId === r.id ? 'on' : ''} onClick={() => void showBefore(r.id)}>
          Before
        </button>
        <button className={beforeId !== r.id ? 'on' : ''} onClick={() => void showBefore(null)}>
          After
        </button>
      </div>
      <button className="btn small primary" onClick={() => void review(r.id, 'keep')}>
        Keep
      </button>
      <button className="btn small" onClick={() => void review(r.id, 'revert')}>
        Revert
      </button>
    </div>
  )
}

function reminderKey(projectId: string) {
  return `ave.listenReminder.${projectId}`
}

export function listenReminderDismissed(projectId: string): boolean {
  try {
    return localStorage.getItem(reminderKey(projectId)) === '1'
  } catch {
    return false
  }
}

/** Claude cannot hear the result, so the app asks you to listen through once before export. */
function ListenReminder() {
  const id = useStore(editor, (s) => s.snapshot!.doc.project.id)
  const status = useStore(editor, (s) => s.snapshot!.doc.project.status)
  const [hidden, setHidden] = useState(() => listenReminderDismissed(id))
  useEffect(() => setHidden(listenReminderDismissed(id)), [id])
  if (hidden || (status !== 'ready_for_review' && status !== 'intro_ready')) return null
  return (
    <div className="reminder">
      <span className="grow">Claude cannot hear the result. Listen through once before you export.</span>
      <button
        className="btn ghost small"
        onClick={() => {
          try {
            localStorage.setItem(reminderKey(id), '1')
          } catch {
            /* the reminder simply shows again next time */
          }
          setHidden(true)
        }}
      >
        Got it
      </button>
    </div>
  )
}
