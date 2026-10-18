/**
 * Start edit (new projects): what the Instructions tab says, and Start edit.
 * Intro ready: Continue with the rest, Redo the intro with new direction, or Stop there.
 */
import { useEffect, useState } from 'react'
import type { ClaudeEstimate } from '@shared/ipc'
import { EstimateNote, useEstimate } from './EstimateNote'
import { openSettings, toast } from '../state/app'
import { themeOneLine, type VideoTheme } from '@shared/videoTheme'
import { errorMessage } from '../util'
import { editor, setWorkspace } from '../state/editor'
import { useStore } from '../state/store'
import { useDerived } from '../state/derived'

export function StartPanel({ onStarted }: { onStarted: () => void }) {
  const project = useStore(editor, (s) => s.snapshot!.doc.project)
  const readOnly = useStore(editor, (s) => s.snapshot!.readOnly)
  const scope = project.scope.mode
  const [busy, setBusy] = useState(false)
  const [est, setEst] = useState<ClaudeEstimate | null>(null)
  const [themes, setThemes] = useState<VideoTheme[]>([])
  useEffect(() => {
    void window.api.themes.list().then(setThemes, () => undefined)
  }, [])
  const theme = themes.find((t) => t.id === project.videoTheme?.id)
  useEffect(() => {
    let live = true
    window.api.claude.estimate('start_edit', { scope }).then((e) => live && setEst(e), () => undefined)
    return () => {
      live = false
    }
  }, [scope])

  // Everything comes from the Instructions tab, saved in the project.
  const start = async () => {
    setBusy(true)
    try {
      await window.api.project.startEdit({
        inspiration: project.inspiration,
        scope,
        introMaxSeconds: scope === 'intro' ? project.scope.introMaxSeconds : null,
        videoThemeId: project.videoTheme?.id ?? null
      })
      onStarted()
      toast(scope === 'intro' ? 'Claude is starting on the intro. It reads the whole video first.' : 'Claude is starting the edit. Watch it land on the timeline.')
    } catch (e) {
      toast(`Could not start the edit: ${errorMessage(e)}`, { kind: 'error' })
    }
    setBusy(false)
  }

  const lines = project.inspiration.trim().split('\n').filter(Boolean)
  return (
    <div className="start-panel">
      <div className="card">
        <div>
          <h2>Start the edit</h2>
          <div className="muted small">Claude reads the footage, your instructions, the channel's rules and the brand kit, then edits stage by stage.</div>
        </div>
        <div className="col small" style={{ gap: 6 }}>
          <div>
            <span className="muted">Instructions: </span>
            {lines.length ? (
              <span className="selectable">
                {lines.slice(0, 3).join(' · ')}
                {lines.length > 3 ? ' …' : ''}
              </span>
            ) : (
              <span className="faint">none (Claude does its best from the footage)</span>
            )}
          </div>
          <div>
            <span className="muted">Video theme: </span>
            {theme ? `${theme.name} (${themeOneLine(theme)})` : project.videoTheme?.name ?? "the channel's usual style"}
          </div>
          <div>
            <span className="muted">Scope: </span>
            {scope === 'intro' ? `just the intro first${project.scope.introMaxSeconds ? ` (at most ${project.scope.introMaxSeconds} s)` : ''}` : 'the whole video'}
          </div>
          <div>
            <button className="btn small ghost" onClick={() => setWorkspace('instructions')} style={{ paddingLeft: 0 }}>
              ← Change instructions
            </button>
            <button className="btn small ghost" onClick={() => openSettings('themes')}>
              Video themes…
            </button>
          </div>
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
  // When the intro has played to its end, ask right there in the viewer.
  const derived = useDerived()
  const end = derived?.duration ?? 0
  const atEnd = useStore(editor, (s) => !s.playing && end > 1 && s.playhead >= end - 0.35)
  useEffect(() => {
    if (atEnd) setMode((m) => (m === 'min' ? 'choose' : m))
  }, [atEnd])
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
          <h3 className="grow">{atEnd || stopped ? 'Like the intro?' : 'The intro is ready'}</h3>
          <button className="btn ghost small" onClick={() => setMode('min')} title="Watch it first; this comes back when the intro ends, or from the button in the corner">
            {stopped || atEnd ? 'Not now' : 'Watch first'}
          </button>
        </div>
        {mode === 'choose' ? (
          <>
            <div className="muted small">Keep it and have Claude edit the rest of the video, or tell Claude what to change in the intro first.</div>
            <div className="row wrap">
              <button className="btn primary" onClick={() => void decide('continue')} title="The intro stays exactly as it is; Claude edits the rest of the video from its last frame">
                Yes, edit the rest of the video
              </button>
              <button className="btn" onClick={() => setMode('redo')} title="Tell Claude what to change; it redoes the intro and asks you again">
                Change the intro…
              </button>
              {!stopped && (
                <button className="btn ghost" onClick={() => void decide('stop')} title="Keep just the intro for now; you can continue later">
                  Stop after the intro
                </button>
              )}
              <span className="spacer" />
              <EstimateNote estimate={est} />
            </div>
          </>
        ) : (
          <>
            <textarea rows={3} autoFocus value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="What should change? e.g. faster, start with the crash (Win+H to speak)" />
            <div className="row">
              <button className="btn ghost" onClick={() => setMode('choose')}>
                Back
              </button>
              <span className="spacer" />
              <button className="btn primary" onClick={() => void decide('redo')} disabled={!direction.trim()}>
                Redo the intro with these changes
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
