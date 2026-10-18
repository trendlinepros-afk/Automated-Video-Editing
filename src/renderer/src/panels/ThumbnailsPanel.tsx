/**
 * Thumbnails in the side panel: persona and style for this project, the Pikzels model, your own prompt (works without
 * Claude), count, "Use my direction", the other Pikzels tools (recreate, edit, face swap, titles),
 * the options side by side with scores, the full history with prompts, and what it all cost. The base picture
 * (a clean frame of the footage) and Claude's suggested description sit right under the prompt.
 * The full Thumbnails page (workspaces/ThumbnailsWorkspace) is built from the same pieces.
 */
import { editor } from '../state/editor'
import { seek } from '../state/player'
import { Icon } from '../components/Icon'
import { fmt, mediaUrl } from '../util'
import { GenerateRow, ModelFields, MoreTools, OptionsGrid, PikzelsKeyBanner, PromptBox, ThumbCosts, ThumbHistory, ThumbToggles, useThumbnails } from './ThumbnailsParts'

export function ThumbnailsPanel() {
  const c = useThumbnails()
  const { th, ro } = c

  return (
    <div className="panel">
      <PikzelsKeyBanner c={c} />
      <ModelFields c={c} />

      <div className="col" style={{ gap: 6 }}>
        <PromptBox c={c} />
        <GenerateRow c={c} />
        <div className="row">
          <button className="btn small" disabled={ro || c.grabbing} onClick={() => void c.grab(editor.get().playhead)} title="Use the frame at the playhead as the base picture">
            <Icon name="camera" size={13} /> {c.grabbing ? 'Grabbing…' : 'Grab screenshot'}
          </button>
          {th.base && (
            <>
              <img className="thumb-base" src={mediaUrl(th.base.file, c.dir)} alt="" title={th.base.image ? th.base.image : 'Go to this frame'} onClick={() => !th.base!.image && seek(th.base!.time)} />
              <div className="col small grow" style={{ gap: 0 }}>
                <span>Base picture</span>
                <span className="faint">{th.base.image ? `Your image ${th.base.image}` : `${fmt(th.base.time)} · ${th.base.by === 'user' ? 'from you' : 'picked by Claude'}`}</span>
              </div>
              <button className="btn small" disabled={ro} title="Stop using this picture" onClick={c.clearBase}>
                <Icon name="close" size={12} />
              </button>
            </>
          )}
        </div>
        <span className="hint">
          {th.base?.image
            ? 'Your own picture, cropped to the thumbnail format. Pikzels builds the thumbnail around it.'
            : th.base
            ? 'A clean frame from the footage: captions, graphics and effects are left out. Pikzels builds the thumbnail around it.'
            : 'Pick the frame that shows what the video is about, then Grab screenshot.'}
        </span>
        <ThumbToggles c={c} />
      </div>

      <MoreTools c={c} />

      <div className="col" style={{ gap: 6 }}>
        {c.latest && <h4>Options</h4>}
        <OptionsGrid c={c} />
      </div>

      {th.items.length > 0 && (
        <div className="col" style={{ gap: 0 }}>
          <h4 style={{ marginBottom: 6 }}>History</h4>
          <ThumbHistory c={c} />
        </div>
      )}

      <ThumbCosts c={c} />
    </div>
  )
}
