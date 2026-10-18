/**
 * Thumbnails, as a full page of the editor. Works at any time, also while Claude is still editing.
 * Left: the base picture, a frame picked in a small player of the preview (or an image of your own, like a blank
 * thumbnail template). Right: model, persona and style, the description (Claude can write it), 1 to 3 options as big
 * cards with Pick, score, again, edit and save, then More tools and History. Next goes on to Title, desc, tags.
 */
import { useEffect, useMemo, useRef } from 'react'
import { editor, setWorkspace } from '../state/editor'
import { useDerived } from '../state/derived'
import { attachVideo, seek, stepFrames, toggle, videoReloaded } from '../state/player'
import { useStore } from '../state/store'
import { Icon } from '../components/Icon'
import { fmt, mediaUrl } from '../util'
import { GenerateRow, ModelFields, MoreTools, OptionsGrid, PikzelsKeyBanner, PromptBox, ThumbCosts, ThumbHistory, ThumbToggles, useThumbnails, type Thumbs } from '../panels/ThumbnailsParts'
import { FlowFooter } from './FlowFooter'

export function ThumbnailsWorkspace() {
  const c = useThumbnails()
  const { th } = c
  const chosen = th.items.some((t) => t.id === th.chosenId && t.status === 'done')
  const hint = c.ro
    ? 'This project is read-only.'
    : chosen
      ? 'Thumbnail picked. You can still change it at any time.'
      : 'Make up to 3 options and Pick the one you like. Works while Claude is still editing.'

  return (
    <div className="workspace">
      <div className="workspace-body">
        <div className="thumbs-page">
          <aside className="col thumbs-left">
            <BaseSection c={c} />
          </aside>
          <div className="col thumbs-main">
            <PikzelsKeyBanner c={c} />
            <section className="card thumbs-card">
              <h3>Describe the thumbnail</h3>
              <ModelFields c={c} wide />
              <PromptBox c={c} rows={4} />
              <GenerateRow c={c} label="Options" />
              <div className="col" style={{ gap: 4 }}>
                <ThumbToggles c={c} />
              </div>
            </section>
            <section className="card thumbs-card">
              <div className="row">
                <h3 className="grow">Options</h3>
                {c.latest && <span className="small faint">The newest {c.latest.items.length === 1 ? 'one' : c.latest.items.length}. Older ones are in History.</span>}
              </div>
              <OptionsGrid c={c} large />
            </section>
            <section className="card thumbs-card">
              <MoreTools c={c} title="More tools" />
            </section>
            {th.items.length > 0 && (
              <details className="card thumbs-card thumbs-history">
                <summary>
                  <h3>History</h3>
                  <span className="small faint">{th.items.length} made for this video</span>
                </summary>
                <ThumbHistory c={c} />
              </details>
            )}
            <ThumbCosts c={c} />
          </div>
        </div>
      </div>
      <FlowFooter hint={hint}>
        <button className="btn primary" onClick={() => setWorkspace('publish')}>
          Next: Title, desc, tags →
        </button>
      </FlowFooter>
    </div>
  )
}

/** The base picture: pick a frame of the video or upload an image, and what is in use now. */
function BaseSection({ c }: { c: Thumbs }) {
  const { th, ro } = c
  const playhead = useStore(editor, (s) => s.playhead)
  const base = th.base
  return (
    <>
      <section className="card thumbs-card">
        <h3>Base picture</h3>
        <span className="hint">Pikzels builds the thumbnail around this picture. Pick a frame of the video, or upload a blank thumbnail or any image.</span>
        <FramePicker />
        <div className="row">
          <button className="btn primary grow" disabled={ro || c.grabbing} onClick={() => void c.grab(playhead)} title="A clean frame of the footage: captions, graphics and effects are left out">
            <Icon name="camera" size={14} /> {c.grabbing ? 'Working…' : `Use this frame (${fmt(playhead)})`}
          </button>
          <button className="btn" disabled={ro || c.grabbing} onClick={() => void c.uploadBase()} title="A blank thumbnail template, a photo or any picture. It is copied and cropped to 16:9; your file is not changed.">
            <Icon name="image" size={14} /> Upload an image…
          </button>
        </div>
      </section>

      <section className="card thumbs-card">
        <div className="row">
          <h3 className="grow">In use</h3>
          {base && (
            <button className="btn small ghost" disabled={ro} title="Stop using this picture" onClick={c.clearBase}>
              <Icon name="close" size={12} /> Remove
            </button>
          )}
        </div>
        {base ? (
          <>
            <img className="thumbs-base-big" src={mediaUrl(base.file, c.dir)} alt="Base picture" />
            <span className="small faint">
              {base.image ? `Your image ${base.image}, cropped to the thumbnail format` : `Frame at ${fmt(base.time)} · ${base.by === 'user' ? 'picked by you' : 'picked by Claude'} · captions and graphics left out`}
            </span>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {!base.image && (
                <button className="btn small" onClick={() => seek(base.time)} title="Show this frame in the player">
                  Go to frame
                </button>
              )}
              <button className="btn small" disabled={ro || !c.baseFile} onClick={() => c.openTool('edit', { file: c.baseFile! })} title="Change part of this picture with Pikzels (More tools)">
                <Icon name="wand" size={13} /> Edit it
              </button>
              <button className="btn small" disabled={ro || !c.baseFile} onClick={() => c.openTool('recreate', { file: c.baseFile! })} title="Make a thumbnail that looks like this picture (More tools)">
                <Icon name="sparkle" size={13} /> Recreate from it
              </button>
            </div>
          </>
        ) : (
          <div className="thumbs-base-empty">
            <Icon name="image" size={26} />
            <span className="small">No base picture yet</span>
            <span className="tiny faint">Thumbnails are made from the description alone.</span>
          </div>
        )}
      </section>
    </>
  )
}

/** A small player of the preview with a scrubber and frame steps, to pick the frame for the base picture. */
function FramePicker() {
  const preview = useStore(editor, (s) => s.preview)
  const playhead = useStore(editor, (s) => s.playhead)
  const playing = useStore(editor, (s) => s.playing)
  const d = useDerived()
  const duration = d?.duration ?? 0
  const video = useRef<HTMLVideoElement>(null)
  const src = useMemo(() => {
    const u = mediaUrl(preview.file)
    return u ? `${u}${u.includes('?') ? '&' : '?'}v=${preview.version}` : undefined
  }, [preview.file, preview.version])

  // The editor's preview is not on this page: this player stands in for it, so the playhead stays the same in both.
  useEffect(() => {
    attachVideo(video.current)
    return () => attachVideo(null)
  }, [])

  const partial = preview.partialUntil
  const beyond = !!partial && playhead > partial
  return (
    <div className="frame-picker">
      <div className="stage">
        <video ref={video} src={src} preload="auto" onLoadedMetadata={videoReloaded} onClick={toggle} playsInline />
        {(!src || beyond) && (
          <div className="frame-picker-empty">
            <span className="small">{!src ? (duration > 0 ? 'No preview yet' : 'No edit yet') : 'This part of the preview is still rendering'}</span>
            {!src && duration > 0 && preview.message && <span className="tiny warn">{preview.message}</span>}
            <span className="tiny faint">
              {duration > 0 ? 'You can still pick a time: the frame is taken from the footage.' : 'Upload an image, or wait for Claude to build the edit.'}
            </span>
          </div>
        )}
        {preview.status === 'rendering' && src && !beyond && (
          <div className="frame-picker-badge">
            <span className="spinner" style={{ width: 10, height: 10 }} /> {partial ? `First ${fmt(partial)} ready` : 'Updating'}
          </div>
        )}
      </div>
      <div className="frame-picker-controls">
        <button className="btn ghost icon" disabled={!duration} onClick={() => stepFrames(-1)} title="Back one frame (←)">
          <Icon name="prev" size={14} />
        </button>
        <button className="btn ghost icon" disabled={!duration} onClick={toggle} title="Play / pause (Space)">
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <button className="btn ghost icon" disabled={!duration} onClick={() => stepFrames(1)} title="Forward one frame (→)">
          <Icon name="next" size={14} />
        </button>
        <input type="range" min={0} max={Math.max(duration, 0.01)} step={0.01} value={Math.min(playhead, duration)} disabled={!duration} onChange={(e) => seek(parseFloat(e.target.value))} aria-label="Pick the time" />
        <span className="time">
          {fmt(playhead, true)} / {fmt(duration)}
        </span>
      </div>
    </div>
  )
}
