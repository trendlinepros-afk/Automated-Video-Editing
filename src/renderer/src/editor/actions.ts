/** Editor actions shared by the timeline, inspector, keyboard and menus. */
import type { Item } from '@shared/project'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { openMenu, toast, type MenuEntry } from '../state/app'
import { applyOp, editor, isLockedOut, openDialog, select, type SeamSel } from '../state/editor'
import { currentDerived } from '../state/derived'
import { errorMessage, fmt, fmtRange } from '../util'

export function canHaveAudio(item: Item): boolean {
  return item.type === 'segment' || item.type === 'audio'
}

export function canSaveToLibrary(item: Item): boolean {
  return item.type === 'graphic' || item.type === 'audio' || item.type === 'effect'
}

function lockedMessage(): void {
  const lock = editor.get().snapshot?.doc.project.lock
  toast(lock ? `Claude is re-editing ${fmtRange(lock.range)}. Everything outside it is locked until it finishes.` : 'Locked.')
}

/** Returns true if the item can be changed now (not read-only, not outside a re-edit lock). */
export function canEdit(itemId: string): boolean {
  const snap = editor.get().snapshot
  if (!snap || snap.readOnly) {
    toast(snap?.readOnlyReason ?? 'This project is open read-only.')
    return false
  }
  const r = currentDerived()?.resolved.get(itemId)
  if (r && isLockedOut(r.start, r.end)) {
    lockedMessage()
    return false
  }
  return true
}

export async function deleteItems(ids: string[]): Promise<void> {
  const ok = ids.filter(canEdit)
  for (const id of ok) await applyOp({ op: 'deleteItem', id })
  if (ok.length) {
    select([])
    toast(ok.length === 1 ? 'Deleted. Ctrl+Z brings it back.' : `Deleted ${ok.length} items. Ctrl+Z brings them back.`)
  }
}

/** Move anchored items by `delta` seconds (arrow keys). */
export async function nudgeItems(ids: string[], delta: number): Promise<void> {
  const d = currentDerived()
  if (!d) return
  for (const id of ids) {
    const r = d.resolved.get(id)
    if (!r || r.item.type === 'segment' || !canEdit(id)) continue
    await applyOp({ op: 'moveItem', id, start: Math.max(0, r.start + delta) })
  }
}

export async function nudgeSeam(seam: SeamSel, delta: number): Promise<void> {
  if (!canEdit(seam.edge === 'out' ? seam.prevId : seam.segmentId)) return
  await applyOp({ op: 'nudgeSegment', id: seam.edge === 'out' ? seam.prevId : seam.segmentId, edge: seam.edge, delta })
}

export async function fixAudio(opts: { itemId?: string; segmentId?: string; time: number }): Promise<void> {
  try {
    await window.api.project.requestFixAudio(opts)
  } catch (e) {
    toast(`Could not send the fix: ${errorMessage(e)}`, { kind: 'error' })
    return
  }
  const runner = editor.get().runner
  toast(
    runner.connected || runner.status === 'running' || runner.status === 'starting'
      ? `Asked Claude to fix the clipped audio at ${fmt(opts.time)}. It plays back here when done, with Undo if it is not right.`
      : `Fix for ${fmt(opts.time)} is queued. It runs as soon as Claude connects. You can also drag the cut edge yourself.`
  )
}

export function itemMenu(e: ReactMouseEvent, item: Item, time: number): void {
  const entries: MenuEntry[] = []
  if (canHaveAudio(item)) {
    entries.push({ label: 'Fix clipped audio', run: () => void fixAudio({ itemId: item.id, segmentId: item.type === 'segment' ? item.id : undefined, time }) })
  }
  if (canSaveToLibrary(item)) entries.push({ label: 'Save to library…', run: () => openDialog({ kind: 'saveToLibrary', itemId: item.id }) })
  entries.push({ label: 'Leave a note for Claude…', run: () => openDialog({ kind: 'note', itemId: item.id }) })
  entries.push({ label: '', run: () => undefined, separator: true })
  entries.push({ label: 'Delete', run: () => void deleteItems(editor.get().selection.includes(item.id) ? editor.get().selection : [item.id]) })
  openMenu(e, entries)
}

export function seamMenu(e: ReactMouseEvent, seam: SeamSel, time: number): void {
  openMenu(e, [
    { label: 'Fix clipped audio', run: () => void fixAudio({ segmentId: seam.segmentId, time }) },
    { label: 'Leave a note for Claude…', run: () => openDialog({ kind: 'note', range: { start: Math.max(0, time - 1), end: time + 1 }, time }) }
  ])
}
