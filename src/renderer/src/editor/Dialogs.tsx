/** The editor's dialogs: Export, Export log, Re-edit section, Inspiration, Save to library, Leave a note, Compare versions. */
import type { VideoTheme } from '@shared/videoTheme'
import { blocking, type ExportCheckResult } from '@shared/exportCheck'
import { useEffect, useRef, useState } from 'react'
import type { ExportPreset, Range } from '@shared/project'
import { call, toast } from '../state/app'
import { editor, openDialog, applyOp, setRange, setTab, type Dialog } from '../state/editor'
import { seek } from '../state/player'
import { currentDerived, useDerived } from '../state/derived'
import { useStore } from '../state/store'
import { Modal } from '../components/Modal'
import { Spinner, Toggle } from '../components/bits'
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
    case 'insertClip':
      return <InsertClipDialog time={dialog.time} file={dialog.file} onClose={close} />
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
  const [checking, setChecking] = useState<string | null>(null)
  const [check, setCheck] = useState<ExportCheckResult | null>(null)
  useEffect(() => window.api.project.onCheckProgress((m) => setChecking(m)), [])
  const exportRange = what === 'section' && range ? range : undefined

  const doExport = async (note?: string) => {
    try {
      await window.api.project.exportVideo({ range: exportRange, preset, quick, captions })
      onClose()
      toast(`${note ? `${note} ` : ''}Exporting. Progress shows in the top bar; you can keep working.`)
    } catch (e) {
      toast(`Could not start the export: ${errorMessage(e)}`, { kind: 'error' })
    }
  }
  // Export runs the check first (not for a quick low-resolution check export).
  const start = async () => {
    if (quick) return doExport()
    setChecking('Checking the video…')
    let result: ExportCheckResult
    try {
      result = await window.api.project.exportCheck(exportRange)
    } catch (e) {
      setChecking(null)
      setCheck({ problems: [], checked: [], skipped: [`the whole check: ${errorMessage(e)}`] })
      return
    }
    setChecking(null)
    if (!blocking(result).length && !result.skipped.length) {
      const infos = result.problems.length
      return doExport(`Check passed: no problems found${infos ? ` (${infos} note${infos > 1 ? 's' : ''})` : ''}.`)
    }
    setCheck(result)
  }
  const askClaude = async () => {
    if (!check) return
    const list = blocking(check)
      .map((p) => `- ${p.title}${p.detail ? `: ${p.detail}` : ''}`)
      .join('\n')
    try {
      await window.api.project.sendChat({
        text: `The check before export found these problems. Please fix them (or tell me if one is intended):\n${list}`,
        playhead: editor.get().playhead,
        selectedItemIds: []
      })
    } catch (e) {
      toast(`Could not send it to Claude: ${errorMessage(e)}`, { kind: 'error' })
      return
    }
    onClose()
    setTab('chat')
    toast('Sent the problems to Claude. Export again when it is done; the check runs again.')
  }
  const goTo = (r: Range) => {
    onClose()
    setRange(r)
    seek(r.start)
  }

  if (checking) {
    return (
      <Modal title="Checking before export" onClose={onClose}>
        <div className="row" style={{ gap: 10 }}>
          <Spinner />
          <span>{checking}</span>
        </div>
        <span className="hint">Looks for missing files, black or frozen picture, silence, and loudness, so nothing broken gets uploaded. No Claude usage.</span>
      </Modal>
    )
  }
  if (check) {
    const blockers = blocking(check)
    return (
      <Modal
        title={blockers.length ? `The check found ${blockers.length} problem${blockers.length > 1 ? 's' : ''}` : 'Check before export'}
        onClose={onClose}
        footer={
          <>
            <button className="btn" onClick={() => setCheck(null)}>
              Back
            </button>
            <span className="spacer" />
            {blockers.length > 0 && (
              <button className="btn" onClick={() => void askClaude()}>
                Ask Claude to fix these
              </button>
            )}
            <button className="btn primary" disabled={busy || check.problems.some((p) => p.severity === 'error')} onClick={() => void doExport()} title={check.problems.some((p) => p.severity === 'error') ? 'Fix the missing files first: the export would fail.' : ''}>
              Export anyway
            </button>
          </>
        }
      >
        <div className="col check-list">
          {check.problems.map((p) => (
            <div key={p.id} className={`check-item ${p.severity}`}>
              <span className="check-dot" />
              <div className="grow">
                <div>{p.title}</div>
                {p.detail && <div className="small muted selectable">{p.detail}</div>}
              </div>
              {p.range && (
                <button className="btn small ghost" onClick={() => goTo(p.range!)} title="Show this spot on the timeline">
                  Go to {fmt(p.range.start)}
                </button>
              )}
            </div>
          ))}
          {!check.problems.length && <div className="muted">No problems found.</div>}
        </div>
        {check.skipped.length > 0 && <div className="warn small">Not checked: {check.skipped.join('; ')}.</div>}
      </Modal>
    )
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

const INSERT_PRESETS = [5, 10, 25]

/** "Add clip here": how the new photo or video goes in, and how much around it Claude may re-edit so it flows. */
function InsertClipDialog({ time, file, onClose }: { time: number; file: string; onClose: () => void }) {
  const connected = useStore(editor, (s) => s.runner.connected || s.runner.status === 'running')
  const [seconds, setSeconds] = useState<number>(10)
  const [custom, setCustom] = useState('')
  const [mode, setMode] = useState<'insert' | 'overlay'>('insert')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const est = useEstimate('insert_clip')
  const customSeconds = parseFloat(custom)
  const each = custom.trim() ? customSeconds : seconds
  const valid = Number.isFinite(each) && each >= 1 && each <= 600
  const name = file.split(/[\\/]/).pop()
  const isImage = /\.(png|jpe?g|webp|bmp|gif)$/i.test(file)
  const send = async () => {
    if (!valid) return
    setBusy(true)
    try {
      await window.api.project.requestInsertClip({ file, time, seconds: each, mode, note: note.trim() || undefined })
    } catch (e) {
      toast(`Could not add the clip: ${errorMessage(e)}`, { kind: 'error' })
      setBusy(false)
      return
    }
    onClose()
    const span = fmtRange({ start: Math.max(0, time - each), end: time + each })
    toast(connected ? `Claude is adding ${name} at ${fmt(time)} and re-editing ${span} around it.` : `Adding ${name} at ${fmt(time)} is queued until Claude connects.`)
  }
  return (
    <Modal
      title={`Add ${isImage ? 'a photo' : 'a clip'} at ${fmt(time)}`}
      onClose={onClose}
      footer={
        <>
          <EstimateNote estimate={est} />
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid || busy} onClick={() => void send()}>
            Add it
          </button>
        </>
      }
    >
      <div className="small">
        <b>{name}</b> <span className="muted selectable">{file}</span>
      </div>
      <label className="small">How it goes in</label>
      <div className="seg" style={{ width: 'fit-content' }}>
        <button className={mode === 'insert' ? 'on' : ''} onClick={() => setMode('insert')} title="Cut it into the video here; the video gets longer">
          Cut it in here
        </button>
        <button className={mode === 'overlay' ? 'on' : ''} onClick={() => setMode('overlay')} title="Show it over the video here; the talking carries on underneath">
          Show it over the video
        </button>
      </div>
      <label className="small">How much around it should Claude look at and re-edit so it flows?</label>
      <div className="row wrap" style={{ gap: 6 }}>
        {INSERT_PRESETS.map((n) => (
          <button
            key={n}
            className={`btn small${!custom.trim() && seconds === n ? ' primary' : ''}`}
            onClick={() => {
              setSeconds(n)
              setCustom('')
            }}
          >
            {n} s each side
          </button>
        ))}
        <input
          type="number"
          min={1}
          max={600}
          step={1}
          style={{ width: 90 }}
          placeholder="Other"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
        />
        <span className="small muted">seconds each side</span>
      </div>
      <span className="hint">
        {valid
          ? `Claude may change ${fmtRange({ start: Math.max(0, time - each), end: time + each })}; nothing outside it changes. More room lets it re-pace the lead-in and the follow-up; less keeps the rest exactly as it is.`
          : 'Type a number of seconds from 1 to 600.'}
      </span>
      <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything Claude should know (optional), e.g. use the part where the car jumps. Win+H to speak." />
      <span className="hint">You get Before and After with Keep and Revert.</span>
    </Modal>
  )
}

function InspirationDialog({ onClose }: { onClose: () => void }) {
  const project = useStore(editor, (s) => s.snapshot!.doc.project)
  const readOnly = useStore(editor, (s) => s.snapshot!.readOnly)
  const [text, setText] = useState(project.inspiration)
  const [themes, setThemes] = useState<VideoTheme[]>([])
  const [themeId, setThemeId] = useState(project.videoTheme?.id ?? '')
  useEffect(() => {
    void window.api.themes.list().then(setThemes, () => undefined)
  }, [])
  const save = async () => {
    if ((project.videoTheme?.id ?? '') !== themeId) {
      try {
        await window.api.project.setVideoTheme(themeId || null)
      } catch (e) {
        toast(`Could not change the video theme: ${errorMessage(e)}`, { kind: 'error' })
        return false
      }
    }
    if (text !== project.inspiration) return applyOp({ op: 'setInspiration', text })
    return true
  }
  const reedit = async () => {
    if (!(await save())) return
    const d = currentDerived()
    const range: Range = { start: 0, end: d?.duration ?? 0 }
    try {
      const themeName = themes.find((t) => t.id === themeId)?.name
      const direction = [text.trim() && `Re-edit the video following the updated inspiration:\n${text.trim()}`, themeName && `Match the pace and style of the video theme "${themeName}" (get_video_theme).`].filter(Boolean).join('\n')
      await window.api.project.requestReedit({ range, direction })
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
          <button className="btn primary" onClick={reedit} disabled={readOnly || project.status === 'new' || (!text.trim() && !themeId)}>
            Re-edit following this
          </button>
        </>
      }
    >
      <div className="muted small">Your vision for this video: tone, pacing, jokes, moments to feature, videos to take after. It is saved in the project.</div>
      <textarea rows={8} value={text} disabled={readOnly} onChange={(e) => setText(e.target.value)} placeholder="Leave empty and Claude does its best from the footage, the channel's rules and the brand kit. (Win+H to speak)" />
      <label className="small">Video theme</label>
      <select value={themeId} disabled={readOnly} onChange={(e) => setThemeId(e.target.value)}>
        <option value="">None: the channel's usual style</option>
        {themes.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <div className="muted small">Make themes from YouTube videos or channels in Settings &gt; Video themes. Claude follows the theme from the next request.</div>
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
