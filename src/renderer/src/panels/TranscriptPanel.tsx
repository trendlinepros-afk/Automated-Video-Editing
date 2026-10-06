/**
 * Transcript: the kept words in the order they are heard. Click a word to jump there; the current word
 * highlights during playback. Double-click to type over a misheard word; Alt+click toggles emphasis.
 * Captions follow these words, so a fix here updates the captions at once.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PlacedWord } from '@shared/timeline'
import { applyOp, editor } from '../state/editor'
import { useDerived } from '../state/derived'
import { seek } from '../state/player'
import { useStore } from '../state/store'
import { Empty, Toggle } from '../components/bits'
import { fmtShort } from '../util'

function findWord(words: PlacedWord[], t: number): number {
  let lo = 0
  let hi = words.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (words[mid].start <= t + 1e-3) {
      best = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  if (best >= 0 && t > words[best].end + 0.25) return -1
  return best
}

export function TranscriptPanel() {
  const d = useDerived()
  const readOnly = useStore(editor, (s) => s.snapshot!.readOnly)
  const flags = useStore(editor, (s) => s.snapshot!.doc.project.selfCheck.flags)
  const words = useMemo(() => d?.words() ?? [], [d])
  const box = useRef<HTMLDivElement>(null)
  const [sel, setSel] = useState<number | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [follow, setFollow] = useState(true)
  const followRef = useRef(follow)
  followRef.current = follow

  // Highlight the current word without re-rendering the whole transcript.
  useEffect(() => {
    let cur = -1
    const apply = () => {
      const s = editor.get()
      const i = findWord(words, s.playhead)
      if (i === cur) return
      const root = box.current
      if (!root) return
      if (cur >= 0) root.querySelector(`[data-i="${cur}"]`)?.classList.remove('cur')
      cur = i
      if (i >= 0) {
        const el = root.querySelector(`[data-i="${i}"]`)
        el?.classList.add('cur')
        if (el && s.playing && followRef.current) {
          const r = el.getBoundingClientRect()
          const pr = root.getBoundingClientRect()
          if (r.top < pr.top || r.bottom > pr.bottom) (el as HTMLElement).scrollIntoView({ block: 'center' })
        }
      }
    }
    apply()
    return editor.subscribe(apply)
  }, [words, editing])

  const flagged = useMemo(() => {
    const set = new Set<number>()
    for (const f of flags) {
      const i = findWord(words, f.time)
      if (i >= 0) set.add(i)
    }
    return set
  }, [flags, words])

  if (!words.length) {
    return (
      <div className="panel">
        <Empty title="No transcript yet">
          <div className="small">Claude transcribes the footage at the start of the edit. The words appear here, in the order they are heard.</div>
        </Empty>
      </div>
    )
  }

  const commitEdit = () => {
    if (editing === null) return
    const w = words[editing]
    const text = draft.trim()
    setEditing(null)
    if (text && text !== w.word.text.trim()) void applyOp({ op: 'editWord', wordId: w.word.id, text })
  }

  const toggleEmphasis = (i: number) => {
    const w = words[i]
    void applyOp({ op: 'setEmphasis', wordId: w.word.id, emphasis: !w.word.emphasis })
  }

  const s = sel !== null ? words[sel] : null

  return (
    <div className="panel flush" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="row small" style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', minHeight: 40 }}>
        {s && sel !== null ? (
          <>
            <b className="ellipsis">“{s.word.text.trim()}”</b>
            <span className="mono faint">{fmtShort(s.start)}</span>
            <span className="spacer" />
            <button className={`btn small${s.word.emphasis ? ' on' : ''}`} disabled={readOnly} onClick={() => toggleEmphasis(sel)} title="Emphasis shows in the captions (Alt+click a word)">
              Emphasis
            </button>
            <button
              className="btn small"
              disabled={readOnly}
              onClick={() => {
                setEditing(sel)
                setDraft(s.word.text.trim())
              }}
            >
              Fix word
            </button>
          </>
        ) : (
          <>
            <span className="muted grow">Click a word to jump. Double-click to fix it. Alt+click for emphasis.</span>
            <Toggle checked={follow} onChange={setFollow} label="Follow" />
          </>
        )}
      </div>
      <div className="panel transcript" ref={box} style={{ display: 'block' }}>
        {words.map((w, i) => {
          const brk = i > 0 && words[i - 1].segmentId !== w.segmentId ? <span className="seg-break" title="A cut" /> : null
          if (editing === i) {
            return (
              <span key={w.word.id}>
                {brk}
                <input
                  type="text"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit()
                    if (e.key === 'Escape') setEditing(null)
                  }}
                />{' '}
              </span>
            )
          }
          const cls = ['w']
          if (w.word.emphasis) cls.push('emph')
          if (w.word.edited) cls.push('edited')
          if (flagged.has(i)) cls.push('flag')
          if (sel === i) cls.push('sel')
          return (
            <span key={w.word.id}>
              {brk}
              <span
                className={cls.join(' ')}
                data-i={i}
                title={`${fmtShort(w.start)}${flagged.has(i) ? ' · flagged by the self-check' : ''}${w.word.edited ? ' · fixed by you' : ''}`}
                onClick={(e) => {
                  if (e.altKey) {
                    if (!readOnly) toggleEmphasis(i)
                    return
                  }
                  setSel(i)
                  seek(w.start)
                }}
                onDoubleClick={() => {
                  if (readOnly) return
                  setEditing(i)
                  setDraft(w.word.text.trim())
                }}
              >
                {w.word.text.trim()}
              </span>{' '}
            </span>
          )
        })}
      </div>
    </div>
  )
}
