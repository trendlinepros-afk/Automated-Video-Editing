/**
 * Editor state: the open project, Claude, the preview, exports, and what you have selected.
 * The project itself lives in the main process; every change goes through window.api and comes back
 * as a new snapshot.
 */
import type { PreviewState, ProjectChangeEvent, ProjectSnapshot, RenderJobState, RunnerState, UserOp } from '@shared/ipc'
import type { Range } from '@shared/project'
import { createStore } from './store'
import { call, toast } from './app'

export type SideTab = 'chat' | 'inspector' | 'transcript' | 'thumbnails' | 'publish' | 'versions' | 'notes'

export interface OutputLine {
  ts: string
  text: string
  kind: 'text' | 'tool' | 'error' | 'info'
}

/** A cut seam: the boundary before segment `segmentId`. `edge` picks which side you are adjusting. */
export interface SeamSel {
  segmentId: string
  prevId: string
  edge: 'in' | 'out'
}

export type Dialog =
  | { kind: 'export' }
  | { kind: 'exportLog' }
  | { kind: 'reedit' }
  | { kind: 'inspiration' }
  | { kind: 'saveToLibrary'; itemId: string }
  | { kind: 'note'; itemId?: string; range?: Range; time?: number }
  | { kind: 'compare'; a: string; b: string }

export interface EditorState {
  snapshot: ProjectSnapshot | null
  runner: RunnerState
  preview: PreviewState
  job: RenderJobState | null
  output: OutputLine[]
  playhead: number
  playing: boolean
  /** Playback rate while shuttling with J/L (negative = reverse). */
  rate: number
  selection: string[]
  seam: SeamSel | null
  range: Range | null
  /** A time range recognised in the chat box as you type. */
  chatRange: Range | null
  tab: SideTab
  /** Item ids Claude just added or changed (they pulse briefly). */
  pulses: ReadonlySet<string>
  /** The request whose Before is showing in the preview. */
  beforeRequestId: string | null
  dialog: Dialog | null
  /** Pixels per second on the timeline. */
  zoom: number
}

const idleRunner: RunnerState = { status: 'idle', connected: false, queue: 0 }
const idlePreview: PreviewState = { status: 'idle', version: 0, chunksTotal: 0, chunksDone: 0, chunksPending: 0 }

export const editor = createStore<EditorState>({
  snapshot: null,
  runner: idleRunner,
  preview: idlePreview,
  job: null,
  output: [],
  playhead: 0,
  playing: false,
  rate: 1,
  selection: [],
  seam: null,
  range: null,
  chatRange: null,
  tab: 'chat',
  pulses: new Set(),
  beforeRequestId: null,
  dialog: null,
  zoom: 0
})

const EMPTY: string[] = []
let subscribed = false

function subscribe(): void {
  if (subscribed) return
  subscribed = true
  const api = window.api
  api.project.onChange(onProjectChange)
  api.claude.onState((runner) => editor.set({ runner }))
  api.claude.onOutput((line) => editor.set((s) => ({ output: [...s.output.slice(-299), line] })))
  api.preview.onState((preview) => editor.set({ preview }))
  api.project.onRenderJob((job) => {
    editor.set({ job })
    if (job.status === 'error') toast(`Export failed: ${job.error ?? 'unknown error'}`, { kind: 'error' })
  })
  void api.claude.state().then((runner) => editor.set({ runner }), () => undefined)
  void api.preview.state().then((preview) => editor.set({ preview }), () => undefined)
}

function onProjectChange(e: ProjectChangeEvent): void {
  const s = editor.get()
  if (!s.snapshot || e.snapshot.doc.project.id !== s.snapshot.doc.project.id) {
    // A different project was opened (or reopened after an update restart).
    if (s.snapshot) openSnapshot(e.snapshot)
    return
  }
  const ids = new Set(e.snapshot.doc.project.items.map((i) => i.id))
  const selection = s.selection.filter((id) => ids.has(id))
  editor.set({
    snapshot: e.snapshot,
    selection: selection.length === s.selection.length ? s.selection : selection,
    seam: s.seam && ids.has(s.seam.segmentId) && ids.has(s.seam.prevId) ? s.seam : null
  })
  if (e.source === 'claude' && e.changedItemIds.length) pulse(e.changedItemIds)
}

const pulseTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function pulse(ids: string[]): void {
  const next = new Set(editor.get().pulses)
  for (const id of ids) {
    next.add(id)
    clearTimeout(pulseTimers.get(id))
    pulseTimers.set(
      id,
      setTimeout(() => {
        pulseTimers.delete(id)
        const after = new Set(editor.get().pulses)
        after.delete(id)
        editor.set({ pulses: after })
      }, 1700)
    )
  }
  editor.set({ pulses: next })
}

export function openSnapshot(snapshot: ProjectSnapshot | null): void {
  subscribe()
  editor.set({
    snapshot,
    selection: EMPTY,
    seam: null,
    range: null,
    chatRange: null,
    playhead: 0,
    playing: false,
    rate: 1,
    output: [],
    beforeRequestId: null,
    dialog: null,
    zoom: 0,
    pulses: new Set(),
    tab: snapshot && snapshot.doc.project.status === 'ready_for_review' ? 'chat' : editor.get().tab
  })
}

/** Applies one of your tweaks. Returns false (and says why) if the app refused it. */
export async function applyOp(op: UserOp): Promise<boolean> {
  const snap = await call(() => window.api.project.apply(op))
  if (!snap) return false
  editor.set({ snapshot: snap })
  return true
}

export async function undo(): Promise<void> {
  const snap = await call(() => window.api.project.undo())
  if (snap) editor.set({ snapshot: snap })
}

export async function redo(): Promise<void> {
  const snap = await call(() => window.api.project.redo())
  if (snap) editor.set({ snapshot: snap })
}

export function select(ids: string[]): void {
  editor.set({ selection: ids.length ? ids : EMPTY, seam: null })
}

export function selectSeam(seam: SeamSel | null): void {
  editor.set({ seam, selection: EMPTY })
}

export function setRange(range: Range | null): void {
  editor.set({ range })
}

export function setTab(tab: SideTab): void {
  editor.set({ tab })
}

export function openDialog(dialog: Dialog | null): void {
  editor.set({ dialog })
}

export async function showBefore(requestId: string | null): Promise<void> {
  editor.set({ beforeRequestId: requestId })
  await call(() => window.api.preview.showBefore(requestId))
}

export async function review(requestId: string, decision: 'keep' | 'revert'): Promise<void> {
  if (editor.get().beforeRequestId === requestId) await showBefore(null)
  await call(() => window.api.project.reviewRequest(requestId, decision))
  toast(decision === 'keep' ? 'Kept the change.' : 'Reverted. The section is back to how it was.')
}

export function isLockedOut(start: number, end: number): boolean {
  const lock = editor.get().snapshot?.doc.project.lock
  if (!lock) return false
  return start < lock.range.start - 1e-3 || end > lock.range.end + 1e-3
}
