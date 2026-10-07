/** Editor actions shared by the timeline, inspector, keyboard and menus. */
import type { Item } from '@shared/project'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { call, openMenu, toast, type MenuEntry } from '../state/app'
import { applyOp, editor, isLockedOut, openDialog, select, setTab, undo, type SeamSel } from '../state/editor'
import { seek } from '../state/player'
import { currentDerived } from '../state/derived'
import { IMAGE_EXTS, VIDEO_EXTS, errorMessage, fmt, fmtRange, fmtShort } from '../util'

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
  const est = await window.api.claude.estimate('fix_audio').catch(() => null)
  const cost = est ? ` Estimated cost ≈ $${est.usd < 1 ? est.usd.toFixed(4) : est.usd.toFixed(2)}.` : ''
  toast(
    (runner.connected || runner.status === 'running' || runner.status === 'starting'
      ? `Asked Claude to fix the clipped audio at ${fmt(opts.time)}. It plays back here when done, with Undo if it is not right.`
      : `Fix for ${fmt(opts.time)} is queued. It runs as soon as Claude connects. You can also drag the cut edge yourself.`) + cost
  )
}

/** A-roll segments and B-roll clips that show moving footage (not stills) can be stabilized. */
export function canStabilize(item: Item): boolean {
  if (item.type !== 'segment' && item.type !== 'clip') return false
  const src = item.sourceId ? editor.get().snapshot?.doc.project.sources.find((s) => s.id === item.sourceId) : undefined
  if (src) return src.kind === 'video'
  return item.type === 'clip' && !!item.file && !/\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(item.file)
}

export async function stabilize(item: Item): Promise<void> {
  if (!canEdit(item.id)) return
  try {
    await window.api.project.requestStabilize({ itemId: item.id })
  } catch (e) {
    toast(`Could not send that: ${errorMessage(e)}`, { kind: 'error' })
    return
  }
  const runner = editor.get().runner
  const est = await window.api.claude.estimate('stabilize').catch(() => null)
  const cost = est ? ` Estimated cost ≈ $${est.usd < 1 ? est.usd.toFixed(4) : est.usd.toFixed(2)}.` : ''
  const what = item.label ? `"${item.label}"` : 'this clip'
  toast(
    (runner.connected || runner.status === 'running' || runner.status === 'starting'
      ? `Asked Claude to stabilize ${what}. It shows here with Before / After and Keep or Revert when done.`
      : `Stabilizing ${what} is queued. It runs as soon as Claude connects.`) + cost
  )
}

/** Back to the original frames. Undo brings the stabilized picture back. */
export async function removePicture(item: Item): Promise<void> {
  if (!canEdit(item.id)) return
  await applyOp({ op: 'updateItem', id: item.id, patch: { picture: undefined } })
  toast('Back to the original picture. Ctrl+Z brings the stabilized one back.')
}

/** Back to the clip's original settings, as one undo step. */
export async function resetClip(item: Item): Promise<void> {
  if (!canEdit(item.id)) return
  const ok = await applyOp({ op: 'resetItem', id: item.id })
  if (!ok) return
  const label = editor.get().snapshot?.undoLabel
  toast(`${label ?? 'Reset'}. Undo puts it back.`, { actions: [{ label: 'Undo', run: () => void undo() }] })
}

/**
 * "Send time to chat": puts "At 1:23.4: " (or the selected section, when the click is inside it) in the chat box,
 * moves the playhead there and opens the chat, so the request can be finished in words.
 */
export function sendTimeToChat(time: number): void {
  const range = editor.get().range
  const inRange = range && time >= range.start && time <= range.end
  const text = inRange ? `From ${fmtShort(range.start)} to ${fmtShort(range.end)}: ` : `At ${fmtShort(time)}: `
  seek(time)
  setTab('chat')
  editor.set({ chatDraft: { text, n: Date.now() } })
}

/** "Add clip here…": pick a photo or video, then choose how much around it Claude may re-edit. */
export async function addClipHere(time: number): Promise<void> {
  const snap = editor.get().snapshot
  if (!snap || snap.readOnly) {
    toast(snap?.readOnlyReason ?? 'This project is open read-only.')
    return
  }
  const files = await call(() =>
    window.api.app.pickFiles({ title: 'Choose a photo or video to add here', filters: [{ name: 'Photos and videos', extensions: [...VIDEO_EXTS, ...IMAGE_EXTS] }] })
  )
  if (files?.[0]) openDialog({ kind: 'insertClip', time, file: files[0] })
}

/** The entries every timeline right-click offers for the spot clicked. */
function timeEntries(time: number): MenuEntry[] {
  const range = editor.get().range
  const inRange = range && time >= range.start && time <= range.end
  return [
    { label: inRange ? `Send ${fmtShort(range.start)}–${fmtShort(range.end)} to chat` : `Send ${fmtShort(time)} to chat`, run: () => sendTimeToChat(time) },
    { label: 'Add clip here…', run: () => void addClipHere(time) }
  ]
}

/** Right-click on the ruler or an empty part of a track. */
export function timeMenu(e: ReactMouseEvent, time: number): void {
  e.preventDefault()
  openMenu(e, timeEntries(Math.max(0, time)))
}

export function itemMenu(e: ReactMouseEvent, item: Item, time: number): void {
  const entries: MenuEntry[] = [...timeEntries(time), { label: '', run: () => undefined, separator: true }]
  if (canStabilize(item)) {
    const pic = (item as { picture?: { kind?: string } }).picture
    entries.push({ label: pic?.kind === 'stabilized' ? 'Stabilize again' : 'Stabilize', run: () => void stabilize(item) })
    if (pic) entries.push({ label: pic.kind === 'stabilized' ? 'Remove stabilization' : 'Use the original picture', run: () => void removePicture(item) })
  }
  if (canHaveAudio(item)) {
    entries.push({ label: 'Fix clipped audio', run: () => void fixAudio({ itemId: item.id, segmentId: item.type === 'segment' ? item.id : undefined, time }) })
  }
  if (canSaveToLibrary(item)) entries.push({ label: 'Save to library…', run: () => openDialog({ kind: 'saveToLibrary', itemId: item.id }) })
  entries.push({ label: 'Leave a note for Claude…', run: () => openDialog({ kind: 'note', itemId: item.id }) })
  entries.push({ label: '', run: () => undefined, separator: true })
  if (item.type !== 'effect') entries.push({ label: 'Reset', run: () => void resetClip(item) })
  entries.push({ label: 'Delete', run: () => void deleteItems(editor.get().selection.includes(item.id) ? editor.get().selection : [item.id]) })
  openMenu(e, entries)
}

export function seamMenu(e: ReactMouseEvent, seam: SeamSel, time: number): void {
  openMenu(e, [
    ...timeEntries(time),
    { label: '', run: () => undefined, separator: true },
    { label: 'Fix clipped audio', run: () => void fixAudio({ segmentId: seam.segmentId, time }) },
    { label: 'Leave a note for Claude…', run: () => openDialog({ kind: 'note', range: { start: Math.max(0, time - 1), end: time + 1 }, time }) }
  ])
}
