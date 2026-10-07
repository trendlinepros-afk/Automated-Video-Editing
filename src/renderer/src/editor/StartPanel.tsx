/**
 * Start edit (new projects): optional inspiration, Whole video or Just the intro, and Start edit.
 * Intro ready: Continue with the rest, Redo the intro with new direction, or Stop there.
 */
import { useEffect, useState } from 'react'
import type { ClaudeEstimate } from '@shared/ipc'
import { EstimateNote, useEstimate } from './EstimateNote'
import { openSettings, toast } from '../state/app'
import { themeOneLine, type VideoTheme } from '@shared/videoTheme'
import { errorMessage } from '../util'
import { applyOp, editor } from '../state/editor'
import { useStore } from '../state/store'

export function StartPanel({ onStarted }: { onStarted: () => void }) {
  const project = useStore(editor, (s) => s.snapshot!.doc.project)
  const readOnly = useStore(editor, (s) => s.snapshot!.readOnly)
  const [inspiration, setInspiration] = useState(project.inspiration)
  const [scope, setScope] = useState<'whole' | 'intro'>(project.scope.mode)
  const [auto, setAuto] = useState(project.scope.introMaxSeconds === null)
  const [maxSeconds, setMaxSeconds] = useState(String(project.scope.introMaxSeconds ?? 60))
  const [busy, setBusy] = useState(false)
  const [est, setEst] = useState<ClaudeEstimate | null>(null)
  const [themes, setThemes] = useState<VideoTheme[]>([])
  const [themeId, setThemeId] = useState<string>(project.videoTheme?.id ?? '')
  useEffect(() => {
    void window.api.themes.list().then(setThemes, () => undefined)
  }, [])
  const theme = themes.find((t) => t.id === themeId)
  useEffect(() => {
    let live = true
    window.api.claude.estimate('start_edit', { scope }).then((e) => live && setEst(e), () => undefined)
    return () => {
      live = false
    }
  }, [scope])

  const saveInspiration = () => {
    if (inspiration !== project.inspiration) void applyOp({ op: 'setInspiration', text: inspiration })
  }

  const start = async () => {
    setBusy(true)
    const introMaxSeconds = scope === 'intro' && !auto ? Math.max(5, parseFloat(maxSeconds) || 60) : null
    try {
      await window.api.project.startEdit({ inspiration, scope, introMaxSeconds, videoThemeId: themeId || null })
      onStarted()
      toast(scope === 'intro' ? 'Claude is starting on the intro. It reads the whole video first.' : 'Claude is starting the edit. Watch it land on the timeline.')
    } catch (e) {
      toast(`Could not start the edit: ${errorMessage(e)}`, { kind: 'error' })
    }
    setBusy(false)
  }

  return (
    <div className="start-panel">
      <div className="card">
        <div>
          <h2>Start the edit</h2>
          <div className="muted small">Nothing here is required. Claude reads the footage, the channel's rules and the brand kit either way.</div>
        </div>
        <div className="field">
          <label>Inspiration (optional)</label>
          <textarea
            rows={6}
            value={inspiration}
            disabled={readOnly}
            onChange={(e) => setInspiration(e.target.value)}
            onBlur={saveInspiration}
            placeholder="Your vision: tone, pacing, jokes, moments to feature, videos to take after… (Win+H to speak)"
          />
        </div>
        <div className="field">
          <label>Video theme (optional)</label>
          <div className="row" style={{ gap: 8 }}>
            <select value={themeId} disabled={readOnly} onChange={(e) => setThemeId(e.target.value)} style={{ minWidth: 240 }}>
              <option value="">None: the channel's usual style</option>
              {themes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button className="btn small ghost" onClick={() => openSettings('themes')} title="Make a theme from a YouTube video or channel">
              {themes.length ? 'Manage…' : 'Make one from a YouTube link…'}
            </button>
          </div>
          {theme && <span className="hint">Claude edits to a similar pace and style: {themeOneLine(theme)}.</span>}
        </div>
        <div className="field">
          <label>Scope</label>
          <div className="seg" style={{ width: 'fit-content' }}>
            <button className={scope === 'whole' ? 'on' : ''} onClick={() => setScope('whole')}>
              Whole video
            </button>
            <button className={scope === 'intro' ? 'on' : ''} onClick={() => setScope('intro')}>
              Just the intro
            </button>
          </div>
          {scope === 'intro' && (
            <div className="row small" style={{ marginTop: 4 }}>
              <span className="muted">Intro length</span>
              <div className="seg">
                <button className={auto ? 'on' : ''} onClick={() => setAuto(true)}>
                  Auto
                </button>
                <button className={!auto ? 'on' : ''} onClick={() => setAuto(false)}>
                  At most
                </button>
              </div>
              {!auto && (
                <>
                  <input type="number" min={5} step={5} style={{ width: 70 }} value={maxSeconds} onChange={(e) => setMaxSeconds(e.target.value)} />
                  <span className="muted">seconds</span>
                </>
              )}
              {auto && <span className="faint">Claude judges where the intro ends.</span>}
            </div>
          )}
        </div>
        <div className="row">
          <EstimateNote estimate={est} />
          <span className="spacer" />
          <button className="btn primary" disabled={busy || readOnly} onClick={start}>
            {busy ? 'Starting…' : 'Start edit'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * After a Just the intro edit: continue, redo or stop. Watch first shrinks it to a button in the
 * corner, and after Stop there the same button stays so the rest of the edit can start any time.
 */
export function IntroPanel({ stopped = false }: { stopped?: boolean }) {
  const [mode, setMode] = useState<'choose' | 'redo' | 'min' | 'hidden'>(stopped ? 'min' : 'choose')
  const est = useEstimate('continue_intro')
  const [direction, setDirection] = useState('')
  const decide = async (decision: 'continue' | 'redo' | 'stop') => {
    try {
      await window.api.project.introDecision(decision, decision === 'redo' ? direction : undefined)
    } catch (e) {
      toast(`Could not send that: ${errorMessage(e)}`, { kind: 'error' })
      return
    }
    setMode(decision === 'stop' ? 'min' : 'hidden')
    if (decision === 'continue') toast('Claude keeps the intro exactly as it is and edits on from its last frame.')
    if (decision === 'redo') toast('Claude is redoing the intro with your direction.')
    if (decision === 'stop') toast('Stopped after the intro. You can export it, or press Continue with the rest of the edit any time.')
  }
  if (mode === 'hidden') return null
  if (mode === 'min')
    return (
      <div className="intro-pill">
        <button className="btn primary small" onClick={() => setMode('choose')} title="Continue the edit past the intro, or redo the intro">
          {stopped ? 'Continue with the rest of the edit…' : 'Intro ready: continue or redo…'}
        </button>
      </div>
    )
  return (
    <div className="start-panel" style={{ background: 'transparent', alignItems: 'flex-end', paddingBottom: 16, pointerEvents: 'none' }}>
      <div className="card" style={{ pointerEvents: 'auto', background: 'var(--bg-2)' }}>
        <div className="row">
          <h3 className="grow">{stopped ? 'Edit the rest of the video?' : 'The intro is ready'}</h3>
          <button className="btn ghost small" onClick={() => setMode('min')} title="Watch it first; the button in the corner of the preview brings this back">
            {stopped ? 'Not now' : 'Watch first'}
          </button>
        </div>
        {mode === 'choose' ? (
          <div className="row wrap">
            <button className="btn primary" onClick={() => void decide('continue')}>
              Continue with the rest
            </button>
            <button className="btn" onClick={() => setMode('redo')}>
              Redo the intro with new direction
            </button>
            {!stopped && (
              <button className="btn ghost" onClick={() => void decide('stop')}>
                Stop there
              </button>
            )}
            <span className="spacer" />
            <EstimateNote estimate={est} />
          </div>
        ) : (
          <>
            <textarea rows={3} autoFocus value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="What should change? e.g. faster, start with the crash (Win+H to speak)" />
            <div className="row">
              <button className="btn ghost" onClick={() => setMode('choose')}>
                Back
              </button>
              <span className="spacer" />
              <button className="btn primary" onClick={() => void decide('redo')}>
                Redo the intro
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
