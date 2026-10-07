/**
 * The intro stage in the top bar: Continue editing (the rest of the video), Redo intro…, and, once there is more
 * than one intro, a picker to switch between them (A/B). Each redo keeps the previous intro as "Intro N".
 */
import { useEffect, useRef, useState } from 'react'
import { call, toast } from '../state/app'
import { editor } from '../state/editor'
import { useStore } from '../state/store'
import { errorMessage } from '../util'

type IntroList = { versions: { id: string; name: string; createdAt: string }[]; currentId: string | null }

export function IntroBar() {
  const p = useStore(editor, (s) => s.snapshot!.doc.project)
  const readOnly = useStore(editor, (s) => s.snapshot!.readOnly)
  const [list, setList] = useState<IntroList | null>(null)
  const [redo, setRedo] = useState(false)
  const [direction, setDirection] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const show = p.scope.mode === 'intro' && p.status !== 'new' && !!p.scope.introEnd
  const working = p.requests.some((r) => (r.kind === 'start_edit' || r.kind === 'redo_intro') && (r.status === 'queued' || r.status === 'in_progress'))
  const itemsKey = p.items.length + ':' + p.updatedAt

  useEffect(() => {
    if (!show) return
    void window.api.project.introVersions().then(setList, () => undefined)
  }, [show, itemsKey])
  useEffect(() => {
    if (!redo) return
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setRedo(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [redo])
  if (!show) return null

  const decide = async (decision: 'continue' | 'redo') => {
    try {
      await window.api.project.introDecision(decision, decision === 'redo' ? direction.trim() : undefined)
    } catch (e) {
      toast(`Could not send that: ${errorMessage(e)}`, { kind: 'error' })
      return
    }
    setRedo(false)
    setDirection('')
    toast(
      decision === 'continue'
        ? 'Claude keeps the intro exactly as it is and edits the rest of the video from its last frame.'
        : 'Claude is redoing the intro. The one you had is saved: switch between them with the Intro picker at the top.'
    )
  }
  const versions = list?.versions ?? []
  return (
    <div className="row intro-bar" style={{ gap: 6, position: 'relative' }} ref={box}>
      <button className="btn small primary" disabled={readOnly || working} onClick={() => void decide('continue')} title="Keep this intro and have Claude edit the rest of the video">
        Continue editing
      </button>
      <button className="btn small" disabled={readOnly || working} onClick={() => setRedo(!redo)} title="Tell Claude what to change; this intro is kept so you can compare">
        Redo intro…
      </button>
      {versions.length > 0 && (
        <select
          className="small"
          value={list?.currentId ?? 'current'}
          disabled={readOnly || working}
          title="Switch between the intros to compare them (A/B). Each one stays saved."
          onChange={async (e) => {
            if (e.target.value === 'current') return
            const name = versions.find((v) => v.id === e.target.value)?.name
            await call(() => window.api.project.useIntro(e.target.value))
            setList(await window.api.project.introVersions())
            toast(`Now showing ${name}. Undo switches back.`)
          }}
        >
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
          {!list?.currentId && <option value="current">Intro {versions.length + 1} (newest)</option>}
        </select>
      )}
      {redo && (
        <div className="popover small" style={{ top: 34, left: 0, width: 340 }}>
          <div className="hint">What should change in the intro? The current one is kept, so you can compare the two.</div>
          <textarea rows={3} autoFocus value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="e.g. faster, start with the crash, less talking before the first drift (Win+H to speak)" />
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
            <button className="btn small ghost" onClick={() => setRedo(false)}>
              Cancel
            </button>
            <button className="btn small primary" disabled={!direction.trim()} onClick={() => void decide('redo')}>
              Redo the intro
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
