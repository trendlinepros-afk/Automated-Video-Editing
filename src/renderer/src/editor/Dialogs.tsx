/** The editor's dialogs: Export, Export log, Re-edit section, Inspiration, Save to library, Leave a note, Compare versions. */
import { useEffect, useRef, useState } from 'react'
import type { ExportPreset, Range } from '@shared/project'
import { call, toast } from '../state/app'
import { editor, openDialog, applyOp, type Dialog } from '../state/editor'
import { currentDerived, useDerived } from '../state/derived'
import { useStore } from '../state/store'
import { Modal } from '../components/Modal'
import { Toggle } from '../components/bits'
import { CAPTION_EXPORT_LABELS, PresetEditor } from '../components/PresetEditor'
import { errorMessage, fmt, fmtRange, itemLabel, mediaUrl } from '../util'
import { listenReminderDismissed } from './Preview'
import { EstimateNote, useEstimate } from './EstimateNote'

export function EditorDialogs() {
  const dialog = useStore(editor, (s) => s.dialog)
  if (!dialog) return null
  const close = () => openDialog(null)
  switch (dialog.kind) {
    case 'export':
      return <ExportDialog onClose={close} />
    case 'exportLog':
      return <ExportLogDialog onClose={close} />
    case 'reedit':
      return <ReeditDialog onClose={close} />
    case 'inspiration':
      return <InspirationDialog onClose={close} />
    case 'saveToLibrary':
      return <SaveToLibraryDialog itemId={dialog.itemId} onClose={close} />
    case 'note':
      return <NoteDialog d={dialog} onClose={close} />
    case 'compare':
      return <CompareDialog a={dialog.a} b={dialog.b} onClose={close} />
  }
}

function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useStore(editor, (s) => s.snapshot!.doc.project)
  const range = useStore(editor, (s) => s.range)
  const job = useStore(editor, (s) => s.job)
  const [what, setWhat] = useState<'whole' | 'section'>(range ? 'section' : 'whole')
  const [preset, setPreset] = useState<ExportPreset>(project.settings.exportPreset)
  const [quick, setQuick] = useState(false)
  const [captions, setCaptions] = useState(project.settings.captionExport)
  const busy = job?.status === 'running'
  const start = async () => {
    try {
      await window.api.project.exportVideo({ range: what === 'section' && range ? range : undefined, preset, quick, captions })
      onClose()
      toast('Exporting. Progress shows in the top bar; you can keep working.')
    } catch (e) {
      toast(`Could not start the export: ${errorMessage(e)}`, { kind: 'error' })
    }
  }
  return (
    <Modal
      title="Export"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={start}>
            {busy ? 'An export is running' : 'Export'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>What</label>
        <div className="seg" style={{ width: 'fit-content' }}>
          <button className={what === 'whole' ? 'on' : ''} onClick={() => setWhat('whole')}>
            Whole video
          </button>
          <button className={what === 'section' ? 'on' : ''} disabled={!range} onClick={() => setWhat('section')} title={range ? '' : 'Drag across the time ruler to select a section first'}>
            Selected section{range ? ` (${fmtRange(range)})` : ''}
          </button>
        </div>
        {what === 'section' && <span className="hint">Every track in that range, with clean audio fades at both ends.</span>}
      </div>
      <div className="field">
        <label>Format</label>
        <PresetEditor value={preset} onChange={setPreset} disabled={quick} />
        <Toggle checked={quick} onChange={setQuick} label="Quick low-resolution export for a fast check" />
      </div>
      <div className="field">
        <label>Captions</label>
        <select value={captions} onChange={(e) => setCaptions(e.target.value as typeof captions)}>
          {Object.entries(CAPTION_EXPORT_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <span className="hint">Files go to the project's exports folder, named with the project, the range and the time. Rendering uses your graphics card, not Claude.</span>
      {!listenReminderDismissed(project.id) && <div className="banner info" style={{ borderRadius: 6 }}>Claude cannot hear the result. Listen through once before you export.</div>}
    </Modal>
  )
}

function ExportLogDialog({ onClose }: { onClose: () => void }) {
  const [filter, setFilter] = useState<'all' | 'last_session'>('all')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    const path = await call(() => window.api.project.exportLog(filter), 'Could not save the log')
    setBusy(false)
    if (path) {
      onClose()
      toast('Saved the log and opened its folder. Hand the file to Claude if something went wrong.', {
        actions: [{ label: 'Show file', run: () => void window.api.app.showItemInFolder(path) }]
      })
    }
  }
  return (
    <Modal
      title="Export log"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Save log'}
          </button>
        </>
      }
    >
      <div className="muted">Saves a text file of everything the app did on this project: Claude's tool calls, your tweaks, renders, thumbnails and errors. API keys are never included.</div>
      <div className="seg" style={{ width: 'fit-content' }}>
        <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
          Everything
        </button>
        <button className={filter === 'last_session' ? 'on' : ''} onClick={() => setFilter('last_session')}>
          Last session
        </button>
      </div>
      <span className="hint">Last session keeps the file small when the problem is recent.</span>
    </Modal>
  )
}

function ReeditDialog({ onClose }: { onClose: () => void }) {
  const range = useStore(editor, (s) => s.range)
  const connected = useStore(editor, (s) => s.runner.connected || s.runner.status === 'running')
  const [direction, setDirection] = useState('')
  const est = useEstimate('reedit')
  if (!range) {
    return (
      <Modal title="Re-edit section" onClose={onClose}>
        <div className="muted">Drag across the time ruler to select the section first.</div>
      </Modal>
    )
  }
  const send = async () => {
    try {
      await window.api.project.requestReedit({ range, direction: direction.trim() })
    } catch (e) {
      toast(`Could not send the re-edit: ${errorMessage(e)}`, { kind: 'error' })
      return
    }
    onClose()
    toast(connected ? `Claude is re-editing ${fmtRange(range)}. Nothing outside it can change.` : `Re-edit of ${fmtRange(range)} is queued until Claude connects.`)
  }
  return (
    <Modal
      title={`Re-edit ${fmtRange(range)}`}
      onClose={onClose}
      footer={
        <>
          <EstimateNote estimate={est} />
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={send}>
            Re-edit section
          </button>
        </>
      }
    >
      <textarea
        rows={4}
        autoFocus
        value={direction}
        onChange={(e) => setDirection(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && void send()}
        placeholder="Direction (optional), e.g. tighter, and add a graphic for the price. Win+H to speak."
      />
      <span className="hint">Claude changes only this range. If it gets shorter or longer, everything after it moves to stay in sync. You get Before and After with Keep and Revert.</span>
    </Modal>
  )
}

function InspirationDialog({ onClose }: { onClose: () => void }) {
  const project = useStore(editor, (s) => s.snapshot!.doc.project)
  const readOnly = useStore(editor, (s) => s.snapshot!.readOnly)
  const [text, setText] = useState(project.inspiration)
  const save = async () => {
    if (text !== project.inspiration) return applyOp({ op: 'setInspiration', text })
    return true
  }
  const reedit = async () => {
    if (!(await save())) return
    const d = currentDerived()
    const range: Range = { start: 0, end: d?.duration ?? 0 }
    try {
      await window.api.project.requestReedit({ range, direction: `Re-edit the video following the updated inspiration:\n${text.trim()}` })
    } catch (e) {
      toast(`Could not send the re-edit: ${errorMessage(e)}`, { kind: 'error' })
      return
    }
    onClose()
    toast('Asked Claude to re-edit following the new inspiration. You get Before and After with Keep and Revert.')
  }
  return (
    <Modal
      title="Inspiration"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={async () => (await save()) && onClose()} disabled={readOnly}>
            Save
          </button>
          <button className="btn primary" onClick={reedit} disabled={readOnly || project.status === 'new' || !text.trim()}>
            Re-edit following the new inspiration
          </button>
        </>
      }
    >
      <div className="muted small">Your vision for this video: tone, pacing, jokes, moments to feature, videos to take after. It is saved in the project.</div>
      <textarea rows={8} value={text} disabled={readOnly} onChange={(e) => setText(e.target.value)} placeholder="Leave empty and Claude does its best from the footage, the channel's rules and the brand kit. (Win+H to speak)" />
    </Modal>
  )
}

function SaveToLibraryDialog({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const snap = useStore(editor, (s) => s.snapshot!)
  const item = snap.doc.project.items.find((i) => i.id === itemId)
  const d = useDerived()
  const [name, setName] = useState(item ? itemLabel(item, (id) => d?.sources.get(id)?.path) : '')
  const [tags, setTags] = useState('')
  const [description, setDescription] = useState('')
  const [whenToUse, setWhenToUse] = useState('')
  const [scope, setScope] = useState<string>(snap.doc.project.profileId || 'shared')
  const [busy, setBusy] = useState(false)
  if (!item) return null
  const save = async () => {
    setBusy(true)
    const asset = await call(
      () =>
        window.api.project.saveToLibrary(itemId, {
          name: name.trim(),
          tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
          description: description.trim(),
          whenToUse: whenToUse.trim(),
          scope
        }),
      'Could not save to the library'
    )
    setBusy(false)
    if (asset) {
      onClose()
      toast(`Saved "${asset.name}" to the library. Claude can reuse it on later videos.`)
    }
  }
  return (
    <Modal
      title="Save to library"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Name</label>
        <input type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>Tags</label>
        <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. lower third, subscribe, whoosh" />
      </div>
      <div className="field">
        <label>What it is</label>
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field">
        <label>When to use it</label>
        <textarea rows={2} value={whenToUse} onChange={(e) => setWhenToUse(e.target.value)} placeholder="e.g. at the end of every video, when asking people to subscribe" />
      </div>
      <div className="field">
        <label>Who can use it</label>
        <div className="seg" style={{ width: 'fit-content' }}>
          <button className={scope === 'shared' ? 'on' : ''} onClick={() => setScope('shared')}>
            Every channel
          </button>
          <button className={scope !== 'shared' ? 'on' : ''} disabled={!snap.doc.project.profileId} onClick={() => setScope(snap.doc.project.profileId)}>
            Only {snap.profile?.name ?? 'this profile'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function NoteDialog({ d, onClose }: { d: Extract<Dialog, { kind: 'note' }>; onClose: () => void }) {
  const project = useStore(editor, (s) => s.snapshot!.doc.project)
  const derived = useDerived()
  const [text, setText] = useState('')
  const item = d.itemId ? project.items.find((i) => i.id === d.itemId) : undefined
  const target = item
    ? `On “${itemLabel(item, (id) => derived?.sources.get(id)?.path)}”`
    : d.range
      ? `On ${fmtRange(d.range)}`
      : 'On the whole video'
  const save = async () => {
    try {
      await window.api.project.addNote({ text: text.trim(), itemId: d.itemId, range: d.range })
    } catch (e) {
      toast(`Could not save the note: ${errorMessage(e)}`, { kind: 'error' })
      return
    }
    onClose()
    toast('Note left for Claude. It reads open notes, makes the change and marks the note done.')
  }
  return (
    <Modal
      title="Leave a note for Claude"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!text.trim()} onClick={save}>
            Leave note
          </button>
        </>
      }
    >
      <div className="small muted">{target}</div>
      <textarea
        rows={4}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim() && void save()}
        placeholder='e.g. "make this one funnier" (Win+H to speak)'
      />
    </Modal>
  )
}

function CompareDialog({ a, b, onClose }: { a: string; b: string; onClose: () => void }) {
  const d = useDerived()
  const playhead = useStore(editor, (s) => s.playhead)
  const [time, setTime] = useState(playhead)
  const [frames, setFrames] = useState<{ a: string | null; b: string | null } | null>(null)
  const [names, setNames] = useState<{ a: string; b: string }>({ a: '', b: '' })
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    void call(() => window.api.project.versions.list()).then((list) => {
      if (!list) return
      setNames({ a: list.find((v) => v.id === a)?.name ?? 'Version A', b: list.find((v) => v.id === b)?.name ?? 'Version B' })
    })
  }, [a, b])

  useEffect(() => {
    const n = ++seq.current
    setLoading(true)
    const t = setTimeout(async () => {
      const f = await call(() => window.api.project.versions.compareFrames(a, b, time), 'Could not render the frames')
      if (n !== seq.current) return
      setLoading(false)
      if (f) setFrames(f)
    }, 200)
    return () => clearTimeout(t)
  }, [a, b, time])

  return (
    <Modal title="Compare versions" onClose={onClose} wide>
      <div className="compare">
        {(['a', 'b'] as const).map((k) => (
          <div key={k} className="col" style={{ gap: 6 }}>
            <b>{names[k]}</b>
            <div className="frame">{frames?.[k] ? <img src={mediaUrl(frames[k]!)} alt="" /> : loading ? <span className="spinner" /> : 'Nothing at this moment'}</div>
          </div>
        ))}
      </div>
      <div className="row">
        <span className="mono small" style={{ minWidth: 90 }}>
          {fmt(time, true)}
        </span>
        <input type="range" className="grow" min={0} max={Math.max(1, d?.duration ?? 1)} step={0.1} value={time} onChange={(e) => setTime(parseFloat(e.target.value))} />
        {loading && <span className="spinner" />}
      </div>
      <span className="hint">Both versions at the same moment in the video.</span>
    </Modal>
  )
}
