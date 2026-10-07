/**
 * Editor top bar: Back to home, project name, profile chip, Claude status, progress checklist,
 * then on the right: export progress, Export, Export log, Check for updates.
 */
import { useEffect, useRef, useState } from 'react'
import type { ChecklistEntry } from '@shared/project'
import { call, leaveEditor } from '../state/app'
import { editor, openDialog } from '../state/editor'
import { UndoButton } from './UndoButton'
import { useStore } from '../state/store'
import { ProfileChip } from '../components/bits'
import { Icon } from '../components/Icon'
import { UpdateButton } from '../components/Updates'
import { CostChip } from './CostChip'
import { relativeTime } from '../util'

export function EditorTopBar() {
  const snap = useStore(editor, (s) => s.snapshot)!
  const p = snap.doc.project
  return (
    <div className="topbar">
      <button className="btn ghost small" onClick={() => void leaveEditor()} title="Back to home">
        <Icon name="back" size={14} /> Home
      </button>
      <b className="ellipsis" style={{ maxWidth: 240 }} title={snap.path}>
        {p.name}
      </b>
      <ProfileChip name={snap.profile?.name} color={snap.profile?.color} />
      <ClaudeStatus />
      <Checklist />
      <button className="btn ghost small" onClick={() => openDialog({ kind: 'inspiration' })} title="Your vision for this video">
        Inspiration
      </button>
      <UndoButton />
      <div className="spacer" />
      <JobChip />
      <CostChip />
      <button className="btn small primary" onClick={() => openDialog({ kind: 'export' })}>
        <Icon name="export" size={14} /> Export
      </button>
      <button className="btn small" onClick={() => openDialog({ kind: 'exportLog' })} title="Save a text file of everything the app did on this project">
        <Icon name="log" size={14} /> Export log
      </button>
      <UpdateButton />
    </div>
  )
}

function ClaudeStatus() {
  const r = useStore(editor, (s) => s.runner)
  const stop = () => void call(() => window.api.claude.stop())
  const resume = () => void call(() => window.api.claude.resume())
  const queue = r.queue > 0 ? <span className="chip">{r.queue} queued</span> : null

  if (r.status === 'running' || r.status === 'starting' || r.status === 'stopping') {
    return (
      <div className="claude-status" title={r.lastActivity}>
        <span className="pulse-dot" />
        <b className="small">{r.status === 'starting' ? 'Starting Claude' : r.status === 'stopping' ? 'Stopping' : 'Claude is working'}</b>
        {r.lastActivity && <span className="activity ellipsis">{r.lastActivity}</span>}
        {queue}
        {r.status !== 'stopping' && (
          <button className="btn small" onClick={stop} title="Stop Claude. Nothing is lost; finished work stays.">
            <Icon name="stop" size={12} /> Stop
          </button>
        )}
      </div>
    )
  }
  if (r.status === 'waiting' || r.status === 'error') {
    return (
      <div className="claude-status" title={r.waitingReason}>
        <span className={`status-dot ${r.status === 'error' ? 'bad' : 'warn'}`} />
        <span className="small ellipsis">{r.waitingReason ?? (r.status === 'error' ? 'Claude could not start' : 'Waiting')}</span>
        {queue}
        <button className="btn small" onClick={resume}>
          Resume
        </button>
      </div>
    )
  }
  if (r.pausedAt && !r.connected) {
    return (
      <div className="claude-status">
        <span className="status-dot warn" />
        <span className="small ellipsis">Claude disconnected, edit paused at: {r.pausedAt}</span>
        {queue}
        <button className="btn small" onClick={resume}>
          Resume
        </button>
      </div>
    )
  }
  return (
    <div className="claude-status">
      <span className={`status-dot ${r.connected ? 'ok' : ''}`} />
      <span className="small muted">{r.connected ? 'Claude connected' : 'Claude not connected'}</span>
      {queue}
      {r.queue > 0 && (
        <button className="btn small" onClick={resume}>
          Resume
        </button>
      )}
    </div>
  )
}

const STATUS_ICON: Record<ChecklistEntry['status'], string> = { not_started: '○', in_progress: '◐', done: '●' }
const STATUS_TEXT: Record<ChecklistEntry['status'], string> = { not_started: 'Not started', in_progress: 'In progress', done: 'Done' }

function Checklist() {
  const checklist = useStore(editor, (s) => s.snapshot!.doc.project.checklist)
  const handoff = useStore(editor, (s) => s.snapshot!.doc.project.handoffNotes)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const done = checklist.filter((c) => c.status === 'done').length
  const current = checklist.find((c) => c.status === 'in_progress')
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="btn ghost small" onClick={() => setOpen(!open)} title="Progress of the edit">
        <Icon name="list" size={14} />
        {current ? current.label : 'Progress'} · {done}/{checklist.length}
      </button>
      {open && (
        <div className="popover" style={{ top: 34, left: 0, width: 340 }}>
          <h4 style={{ marginBottom: 8 }}>Progress</h4>
          <div className="col" style={{ gap: 4 }}>
            {checklist.map((c) => (
              <div key={c.id} className="row top">
                <span className={c.status === 'done' ? 'ok' : c.status === 'in_progress' ? 'warn' : 'faint'} style={{ width: 14 }}>
                  {STATUS_ICON[c.status]}
                </span>
                <div className="grow">
                  <div className="row">
                    <span className="grow">{c.label}</span>
                    <span className="tiny faint">{STATUS_TEXT[c.status]}</span>
                  </div>
                  {c.detail && <div className="tiny muted">{c.detail}</div>}
                </div>
              </div>
            ))}
          </div>
          {handoff.length > 0 && (
            <>
              <h4 style={{ margin: '12px 0 6px' }}>Claude's latest notes</h4>
              <div className="col small" style={{ gap: 6, maxHeight: 200, overflow: 'auto' }}>
                {handoff
                  .slice(-4)
                  .reverse()
                  .map((n) => (
                    <div key={n.id}>
                      <div className="tiny faint">
                        {relativeTime(n.ts)}
                        {n.stage ? ` · ${n.stage}` : ''}
                      </div>
                      <div className="selectable">{n.text}</div>
                    </div>
                  ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function JobChip() {
  const job = useStore(editor, (s) => s.job)
  const [hidden, setHidden] = useState<string | null>(null)
  if (!job || hidden === job.id + job.status) return null
  if (job.status === 'running') {
    return (
      <div className="job-chip" title={job.message}>
        <span className="spinner" />
        <span>{job.kind === 'quick_export' ? 'Quick export' : job.kind === 'section_export' ? 'Exporting section' : 'Exporting'}</span>
        <div className="progress">
          <div style={{ width: `${job.percent}%` }} />
        </div>
        <span className="mono">{Math.round(job.percent)}%</span>
        {job.fps ? <span className="faint">{job.fps.toFixed(0)} fps</span> : null}
        <button className="btn small" onClick={() => void call(() => window.api.project.cancelExport())}>
          Cancel
        </button>
      </div>
    )
  }
  return (
    <div className="job-chip">
      {job.status === 'done' && (
        <>
          <span className="ok">Export finished</span>
          {job.out && <a onClick={() => void window.api.app.showItemInFolder(job.out!)}>Open folder</a>}
        </>
      )}
      {job.status === 'cancelled' && <span className="muted">Export cancelled</span>}
      {job.status === 'error' && (
        <span className="bad ellipsis" style={{ maxWidth: 260 }} title={job.error}>
          Export failed: {job.error}
        </span>
      )}
      <button className="btn ghost small icon" onClick={() => setHidden(job.id + job.status)} title="Dismiss">
        <Icon name="close" size={12} />
      </button>
    </div>
  )
}
