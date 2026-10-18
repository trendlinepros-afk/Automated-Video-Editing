/**
 * Instructions: everything Claude should know before (and while) it edits. The video theme, how much to edit, and a
 * free field for the direction of the video, specific things to do and things to be aware of. Saved as you type, and
 * Claude reads it from the next request; once the edit is under way, Re-edit following this applies changes.
 */
import { useEffect, useRef, useState } from 'react'
import type { Range } from '@shared/project'
import { themeOneLine, type VideoTheme } from '@shared/videoTheme'
import { openSettings, toast } from '../state/app'
import { applyOp, editor, setWorkspace } from '../state/editor'
import { currentDerived } from '../state/derived'
import { useStore } from '../state/store'
import { errorMessage } from '../util'
import { FlowFooter } from './FlowFooter'

/** Quick additions for the direction field: a click appends the line. */
const IDEAS = [
  'Fast paced, no dead air.',
  'Keep my jokes and reactions.',
  'Make the price reveal a big moment.',
  'Show the product up close whenever I talk about it.',
  'Explain specs with simple animated graphics.',
  'End on a clear verdict.'
]

export function InstructionsWorkspace() {
  const project = useStore(editor, (s) => s.snapshot!.doc.project)
  const readOnly = useStore(editor, (s) => s.snapshot!.readOnly)
  const started = project.status !== 'new'
  const [text, setText] = useState(project.inspiration)
  const [themes, setThemes] = useState<VideoTheme[]>([])
  const [saving, setSaving] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const latest = useRef(text)
  latest.current = text

  useEffect(() => {
    void window.api.themes.list().then(setThemes, () => undefined)
  }, [])
  // Text typed here is saved shortly after you stop typing, and when you leave the page.
  const saveText = async (value = latest.current) => {
    clearTimeout(timer.current)
    if (readOnly || value === editor.get().snapshot?.doc.project.inspiration) return true
    setSaving(true)
    const ok = await applyOp({ op: 'setInspiration', text: value })
    setSaving(false)
    return ok
  }
  useEffect(() => () => void saveText(), []) // eslint-disable-line react-hooks/exhaustive-deps
  const onText = (value: string) => {
    setText(value)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void saveText(value), 900)
  }
  const addIdea = (line: string) => onText(text.trim() ? `${text.trim()}\n${line}` : line)

  const themeId = project.videoTheme?.id ?? ''
  const theme = themes.find((t) => t.id === themeId)
  const setTheme = async (id: string) => {
    try {
      await window.api.project.setVideoTheme(id || null)
    } catch (e) {
      toast(`Could not change the video theme: ${errorMessage(e)}`, { kind: 'error' })
    }
  }

  const scope = project.scope
  const setScope = (patch: { mode?: 'whole' | 'intro'; introMaxSeconds?: number | null }) =>
    void applyOp({ op: 'patchProject', path: 'scope', patch })

  const reedit = async () => {
    if (!(await saveText())) return
    const range: Range = { start: 0, end: currentDerived()?.duration ?? 0 }
    const direction = [text.trim() && `Re-edit the video following the updated instructions:\n${text.trim()}`, theme && `Match the pace and style of the video theme "${theme.name}" (get_video_theme).`]
      .filter(Boolean)
      .join('\n')
    try {
      await window.api.project.requestReedit({ range, direction })
      toast('Asked Claude to re-edit following the new instructions. You get Before and After with Keep and Revert.')
      setWorkspace('edit')
    } catch (e) {
      toast(`Could not send the re-edit: ${errorMessage(e)}`, { kind: 'error' })
    }
  }

  const next = async () => {
    await saveText()
    setWorkspace('edit')
  }

  return (
    <div className="workspace">
      <div className="workspace-body">
        <div className="page" style={{ maxWidth: 820 }}>
          <div>
            <h2 style={{ margin: 0 }}>Instructions</h2>
            <div className="muted">
              Tell Claude what this video should be. Nothing here is required: Claude also reads the footage, your channel's rules and
              the brand kit. You can come back and change this at any time.
            </div>
          </div>

          <div className="section col" style={{ gap: 8 }}>
            <div className="row">
              <h3 className="grow" style={{ margin: 0 }}>Direction and things to know</h3>
              <span className="tiny faint">{saving ? 'Saving…' : text !== project.inspiration ? 'Not saved yet' : text ? 'Saved' : ''}</span>
            </div>
            <textarea
              rows={12}
              value={text}
              disabled={readOnly}
              onChange={(e) => onText(e.target.value)}
              onBlur={() => void saveText()}
              placeholder={
                'Write freely: the direction of the video, specific things you want done, and anything Claude should just be aware of.\n\n' +
                'e.g. "Budget drift car review. Keep it under 12 minutes, open on the best drift, the gyro test is the highlight, my friend Dave ' +
                'is the one filming, ignore the clip where the battery dies." (Win+H to speak)'
              }
            />
            <div className="row wrap" style={{ gap: 6 }}>
              <span className="tiny faint">Add:</span>
              {IDEAS.map((idea) => (
                <button key={idea} className="chip-button" disabled={readOnly} onClick={() => addIdea(idea)}>
                  + {idea}
                </button>
              ))}
            </div>
          </div>

          <div className="section col" style={{ gap: 8 }}>
            <h3 style={{ margin: 0 }}>Inspiration</h3>
            <div className="field">
              <label>Video theme</label>
              <div className="row" style={{ gap: 8 }}>
                <select value={themeId} disabled={readOnly} onChange={(e) => void setTheme(e.target.value)} style={{ minWidth: 260 }}>
                  <option value="">None: the channel's usual style</option>
                  {themes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <button className="btn small ghost" onClick={() => openSettings('themes')} title="Make a theme from a YouTube video or channel">
                  {themes.length ? 'Manage themes…' : 'Make one from a YouTube link…'}
                </button>
              </div>
              <span className="hint">{theme ? `Claude edits to a similar pace and style: ${themeOneLine(theme)}.` : 'Edit like a video you admire: make a theme from its link in Settings > Video themes.'}</span>
            </div>
            <div className="field">
              <label>How much to edit</label>
              <div className="seg" style={{ width: 'fit-content' }}>
                <button className={scope.mode === 'whole' ? 'on' : ''} disabled={readOnly || started} onClick={() => setScope({ mode: 'whole' })}>
                  Whole video
                </button>
                <button className={scope.mode === 'intro' ? 'on' : ''} disabled={readOnly || started} onClick={() => setScope({ mode: 'intro' })}>
                  Just the intro first
                </button>
              </div>
              {scope.mode === 'intro' && !started && (
                <div className="row small" style={{ marginTop: 4 }}>
                  <span className="muted">Intro length</span>
                  <div className="seg">
                    <button className={scope.introMaxSeconds === null ? 'on' : ''} onClick={() => setScope({ introMaxSeconds: null })}>
                      Auto
                    </button>
                    <button className={scope.introMaxSeconds !== null ? 'on' : ''} onClick={() => setScope({ introMaxSeconds: scope.introMaxSeconds ?? 60 })}>
                      At most
                    </button>
                  </div>
                  {scope.introMaxSeconds !== null && (
                    <>
                      <input
                        type="number"
                        min={5}
                        step={5}
                        style={{ width: 70 }}
                        value={scope.introMaxSeconds}
                        onChange={(e) => setScope({ introMaxSeconds: Math.max(5, parseFloat(e.target.value) || 60) })}
                      />
                      <span className="muted">seconds</span>
                    </>
                  )}
                </div>
              )}
              <span className="hint">
                {started
                  ? 'The edit has started; the scope is set. Intro choices are in the Editing tab.'
                  : 'Just the intro first: Claude edits the intro, you approve it, then it edits the rest the same way.'}
              </span>
            </div>
          </div>
        </div>
      </div>
      <FlowFooter hint={started ? 'Changed something? Re-edit applies it to the whole video, with Before and After.' : 'Next, start the edit.'}>
        {started && (
          <button className="btn" disabled={readOnly || !text.trim()} onClick={() => void reedit()}>
            Re-edit following this
          </button>
        )}
        <button className="btn primary" onClick={() => void next()}>
          Next: Editing →
        </button>
      </FlowFooter>
    </div>
  )
}
