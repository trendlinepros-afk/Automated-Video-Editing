/** Notes for Claude: leave a note on the selected item or range. Claude reads open notes, makes the change and marks them done. */
import { useState } from 'react'
import type { Note } from '@shared/project'
import { toast } from '../state/app'
import { editor, select } from '../state/editor'
import { useDerived } from '../state/derived'
import { seek } from '../state/player'
import { useStore } from '../state/store'
import { Empty } from '../components/bits'
import { errorMessage, fmtRange, itemLabel, relativeTime } from '../util'

export function NotesPanel() {
  const notes = useStore(editor, (s) => s.snapshot!.doc.project.notes)
  const ro = useStore(editor, (s) => s.snapshot!.readOnly)
  const open = notes.filter((n) => n.status === 'open')
  const done = notes.filter((n) => n.status === 'done')
  return (
    <div className="panel">
      {!ro && <AddNote />}
      {notes.length === 0 && (
        <Empty title="No notes">
          <div className="small">Leave a note on anything, such as “make this one funnier”. Claude picks it up the next time it works on the project.</div>
        </Empty>
      )}
      {open.length > 0 && (
        <div className="col" style={{ gap: 0 }}>
          <h4 style={{ marginBottom: 4 }}>Open</h4>
          {open
            .slice()
            .reverse()
            .map((n) => (
              <NoteRow key={n.id} n={n} />
            ))}
        </div>
      )}
      {done.length > 0 && (
        <div className="col" style={{ gap: 0 }}>
          <h4 style={{ marginBottom: 4 }}>Done</h4>
          {done
            .slice()
            .reverse()
            .map((n) => (
              <NoteRow key={n.id} n={n} />
            ))}
        </div>
      )}
    </div>
  )
}

function AddNote() {
  const selection = useStore(editor, (s) => s.selection)
  const range = useStore(editor, (s) => s.range)
  const d = useDerived()
  const [text, setText] = useState('')
  const [target, setTarget] = useState<'item' | 'range' | 'video'>('item')
  const item = selection.length === 1 ? d?.resolved.get(selection[0])?.item : undefined
  const effective: 'item' | 'range' | 'video' =
    target === 'video' ? 'video' : target === 'item' && item ? 'item' : target === 'range' && range ? 'range' : item ? 'item' : range ? 'range' : 'video'
  const save = async () => {
    try {
      await window.api.project.addNote({
        text: text.trim(),
        itemId: effective === 'item' ? item?.id : undefined,
        range: effective === 'range' && range ? range : undefined
      })
      setText('')
      toast('Note left for Claude.')
    } catch (e) {
      toast(errorMessage(e), { kind: 'error' })
    }
  }
  return (
    <div className="col" style={{ gap: 6 }}>
      <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="A note for Claude, e.g. make this one funnier (Win+H to speak)" />
      <div className="row wrap">
        <div className="seg">
          <button className={effective === 'item' ? 'on' : ''} disabled={!item} onClick={() => setTarget('item')} title={item ? '' : 'Select an item on the timeline first'}>
            {item ? `On “${truncate(itemLabel(item, (id) => d?.sources.get(id)?.path), 16)}”` : 'On selected item'}
          </button>
          <button className={effective === 'range' ? 'on' : ''} disabled={!range} onClick={() => setTarget('range')} title={range ? '' : 'Drag across the ruler to select a range first'}>
            {range ? `On ${fmtRange(range)}` : 'On selected range'}
          </button>
          <button className={effective === 'video' ? 'on' : ''} onClick={() => setTarget('video')}>
            Whole video
          </button>
        </div>
        <span className="spacer" />
        <button className="btn primary small" disabled={!text.trim()} onClick={save}>
          Leave note
        </button>
      </div>
    </div>
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function NoteRow({ n }: { n: Note }) {
  const d = useDerived()
  const ro = useStore(editor, (s) => s.snapshot!.readOnly)
  const r = n.itemId ? d?.resolved.get(n.itemId) : undefined
  const saveRule = async () => {
    try {
      await window.api.project.noteToRule(n.id)
      toast('Saved as a channel rule. Claude follows it on every video of this channel.')
    } catch (e) {
      toast(errorMessage(e), { kind: 'error' })
    }
  }
  return (
    <div className="list-row" style={{ alignItems: 'flex-start' }}>
      <span className={n.status === 'done' ? 'ok' : 'warn'} style={{ width: 12 }}>
        {n.status === 'done' ? '✓' : '•'}
      </span>
      <div className="grow col" style={{ gap: 2, minWidth: 0 }}>
        <div className="selectable" style={{ opacity: n.status === 'done' ? 0.7 : 1 }}>
          {n.text}
        </div>
        <div className="row tiny faint wrap">
          {r ? (
            <a
              onClick={() => {
                select([r.item.id])
                seek(r.start)
              }}
            >
              {itemLabel(r.item, (id) => d?.sources.get(id)?.path)}
            </a>
          ) : n.itemId ? (
            <span>an item that was removed</span>
          ) : n.range ? (
            <a onClick={() => seek(n.range!.start)}>{fmtRange(n.range)}</a>
          ) : (
            <span>whole video</span>
          )}
          <span>· {relativeTime(n.createdAt)}</span>
        </div>
        {n.response && <div className="small muted">Claude: {n.response}</div>}
      </div>
      <button className="btn ghost small" disabled={ro} onClick={saveRule} title="Make this a standing rule for the channel">
        Save as rule
      </button>
    </div>
  )
}
