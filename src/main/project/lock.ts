/**
 * The section re-edit lock. While Claude re-edits a range, any change outside it is refused.
 *
 * What "outside" means:
 *  - The A-roll before the range must play exactly the same source material as before.
 *  - The A-roll after the range must play the same material, allowed only to shift in time.
 *  - Every other item whose span was not fully inside the range must be stored exactly as it was.
 *  - New, changed or deleted items must be fully inside the range (which grows or shrinks with the section).
 *  - Whole-video settings (tracks, mix, output format) cannot change.
 * After a valid change, items pinned to fixed times after the range are shifted so they stay in sync.
 */
import type { Project, ProjectDoc, Range, SegmentItem } from '@shared/project'
import { TimelineResolver, placeSegments } from '@shared/timeline'

const EPS = 1e-3

interface Piece {
  sourceId: string
  srcIn: number
  srcOut: number
  speed: number
  hold: boolean
  muted: boolean
  volume: number
  length: number
}

/** The A-roll material that plays inside [from, to) of the timeline, as a list of source pieces. */
export function arollPieces(project: Project, from: number, to: number): Piece[] {
  const pieces: Piece[] = []
  for (const seg of placeSegments(project)) {
    const a = Math.max(from, seg.start)
    const b = Math.min(to, seg.end)
    if (b - a <= EPS) continue
    const s: SegmentItem = seg.item
    const speed = s.speed || 1
    const srcIn = s.hold ? s.in : s.in + (a - seg.start) * speed
    const srcOut = s.hold ? s.in : s.in + (b - seg.start) * speed
    const piece: Piece = {
      sourceId: s.sourceId,
      srcIn,
      srcOut,
      speed,
      hold: !!s.hold,
      muted: !!s.muted,
      volume: s.volume ?? 0,
      length: b - a
    }
    const prev = pieces[pieces.length - 1]
    // Two adjacent segments that continue the same source play identically to one segment.
    if (
      prev &&
      !prev.hold &&
      !piece.hold &&
      prev.sourceId === piece.sourceId &&
      Math.abs(prev.srcOut - piece.srcIn) < EPS &&
      prev.speed === piece.speed &&
      prev.muted === piece.muted &&
      prev.volume === piece.volume
    ) {
      prev.srcOut = piece.srcOut
      prev.length += piece.length
    } else {
      pieces.push(piece)
    }
  }
  return pieces
}

function samePieces(a: Piece[], b: Piece[]): boolean {
  if (a.length !== b.length) return false
  return a.every((p, i) => {
    const q = b[i]
    return (
      p.sourceId === q.sourceId &&
      Math.abs(p.srcIn - q.srcIn) < EPS &&
      Math.abs(p.srcOut - q.srcOut) < EPS &&
      Math.abs(p.length - q.length) < EPS &&
      p.speed === q.speed &&
      p.hold === q.hold &&
      p.muted === q.muted &&
      p.volume === q.volume
    )
  })
}

const stable = (v: unknown) => JSON.stringify(v)

export interface LockResult {
  ok: boolean
  violations: string[]
  /** How much longer (+) or shorter (-) the section became. */
  delta: number
}

export function checkLock(before: ProjectDoc, after: ProjectDoc, range: Range): LockResult {
  const violations: string[] = []
  const rb = new TimelineResolver(before.project, before.transcript)
  const ra = new TimelineResolver(after.project, after.transcript)
  const delta = ra.duration - rb.duration
  const end = Math.min(range.end, rb.duration)
  const newRange: Range = { start: range.start, end: range.end + delta }

  if (!samePieces(arollPieces(before.project, 0, range.start), arollPieces(after.project, 0, range.start))) {
    violations.push(`The A-roll before ${range.start.toFixed(2)}s changed`)
  }
  if (end < rb.duration - EPS || ra.duration > newRange.end + EPS) {
    const tailBefore = arollPieces(before.project, end, rb.duration)
    const tailAfter = arollPieces(after.project, end + delta, ra.duration)
    if (!samePieces(tailBefore, tailAfter)) {
      violations.push(`The A-roll after ${range.end.toFixed(2)}s changed`)
    }
  }

  const beforeItems = new Map(before.project.items.filter((i) => i.type !== 'segment').map((i) => [i.id, i]))
  const afterItems = new Map(after.project.items.filter((i) => i.type !== 'segment').map((i) => [i.id, i]))
  const inside = (r: Range, s: number, e: number) => s >= r.start - EPS && e <= r.end + EPS

  for (const [id, item] of beforeItems) {
    const span = rb.resolveItem(item)
    const wasInside = inside(range, span.start, span.end)
    const next = afterItems.get(id)
    if (!next) {
      if (!wasInside) violations.push(`Item ${id} is outside the section and cannot be deleted`)
      continue
    }
    if (stable(next) === stable(item)) continue
    if (!wasInside) {
      violations.push(`Item ${id} is outside the section and cannot be changed`)
      continue
    }
    const ns = ra.resolveItem(next)
    if (!inside(newRange, ns.start, ns.end)) violations.push(`Item ${id} would move outside the section`)
  }
  for (const [id, item] of afterItems) {
    if (beforeItems.has(id)) continue
    const ns = ra.resolveItem(item)
    if (!inside(newRange, ns.start, ns.end)) {
      violations.push(`New item ${id} (${ns.start.toFixed(2)}–${ns.end.toFixed(2)}s) is outside the section`)
    }
  }

  const frozen: (keyof Project)[] = ['tracks', 'output', 'settings', 'captions', 'engineVersion']
  for (const key of frozen) {
    if (stable(before.project[key]) !== stable(after.project[key])) violations.push(`"${key}" applies to the whole video and cannot change during a section re-edit`)
  }

  return { ok: violations.length === 0, violations, delta }
}

/** After a section grew or shrank, keep items pinned to fixed times after it in sync. Mutates `doc`. */
export function shiftAfterRange(doc: ProjectDoc, range: Range, delta: number): string[] {
  if (Math.abs(delta) < EPS) return []
  const moved: string[] = []
  for (const item of doc.project.items) {
    if (item.type === 'segment') continue
    if (item.anchor.kind === 'time' && item.anchor.time >= range.end - EPS) {
      item.anchor.time = Math.max(0, item.anchor.time + delta)
      moved.push(item.id)
    }
  }
  for (const ch of doc.project.publish.chapters) {
    if (ch.anchor.kind === 'time' && ch.anchor.time >= range.end - EPS) ch.anchor.time = Math.max(0, ch.anchor.time + delta)
  }
  return moved
}
