/**
 * Manual tweaks from the window. Each one is a single undoable change from 'user', logged with its
 * before and after values. User tweaks are never restricted by the section lock.
 *
 * Recognisable tweaks are reported to the learned-corrections service, which only records them.
 */
import { existsSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import type { UserOp } from '@shared/ipc'
import type { CorrectionKind } from '@shared/settings'
import {
  TRACK_LABELS,
  isAnchored,
  type AnchoredItem,
  type Item,
  type Project,
  type ProjectDoc,
  type SegmentItem,
  type Source,
  type Track,
  type TrackKind,
  type Word
} from '@shared/project'
import { TimelineResolver, placeSegments, round3, segmentDuration } from '@shared/timeline'
import type { AppContext } from '../context'
import { ValidationError, newId, type ProjectStore } from './store'

const MIN_LENGTH = 0.04
const MIN_SEGMENT = 0.01

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.mts', '.m2ts', '.wmv', '.mxf'])
const AUDIO_EXT = new Set(['.wav', '.mp3', '.flac', '.aac', '.m4a', '.ogg', '.opus', '.aif', '.aiff', '.wma'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif'])

export function mediaKindOf(path: string): Source['kind'] | null {
  const ext = extname(path).toLowerCase()
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (IMAGE_EXT.has(ext)) return 'image'
  return null
}

/**
 * A source entry for a file, probed by the engine. If the engine cannot probe it yet (for example
 * while the Python environment is still installing) the entry is kept with what the file name tells.
 */
export async function probeSource(ctx: AppContext, path: string, origin: Source['origin'], id = newId('src')): Promise<Source> {
  const st = existsSync(path) ? statSync(path) : null
  const base: Source = {
    id,
    path,
    kind: mediaKindOf(path) ?? 'video',
    duration: 0,
    hasAudio: false,
    origin,
    ...(st ? { size: st.size, mtimeMs: Math.round(st.mtimeMs) } : {})
  }
  try {
    const p = await ctx.engine.probe(path)
    return {
      ...base,
      kind: p.kind,
      duration: p.duration,
      hasAudio: p.hasAudio,
      ...(p.width ? { width: Math.round(p.width) } : {}),
      ...(p.height ? { height: Math.round(p.height) } : {}),
      ...(p.fps ? { fps: p.fps } : {})
    }
  } catch (err) {
    return { ...base, probeError: String((err as Error)?.message ?? err) } as Source
  }
}

function trackKindOf(project: Project, trackId: string): TrackKind | undefined {
  return project.tracks.find((t) => t.id === trackId)?.kind
}

function findItem(doc: ProjectDoc, id: string): Item {
  const item = doc.project.items.find((i) => i.id === id)
  if (!item) throw new ValidationError(`That item no longer exists (${id})`)
  return item
}

function findWord(doc: ProjectDoc, wordId: string): Word {
  for (const clip of Object.values(doc.transcript.clips)) {
    const w = clip.words.find((x) => x.id === wordId)
    if (w) return w
  }
  throw new ValidationError(`That word is not in the transcript (${wordId})`)
}

/** Music stays pinned to the timeline itself; everything else follows the words. */
function keepsTimeAnchor(project: Project, item: AnchoredItem): boolean {
  return item.anchor.kind === 'time' && trackKindOf(project, item.trackId) === 'music'
}

function anchorFor(project: Project, resolver: TimelineResolver, item: AnchoredItem, start: number): AnchoredItem['anchor'] {
  const t = Math.max(0, start)
  if (keepsTimeAnchor(project, item)) return { kind: 'time', time: round3(t) }
  return resolver.anchorAt(t)
}

function sourceDuration(project: Project, sourceId: string): number {
  return project.sources.find((s) => s.id === sourceId)?.duration ?? 0
}

/** Adjust one edge of a cut, clamped to the source and keeping out after in. */
function nudge(project: Project, seg: SegmentItem, edge: 'in' | 'out', delta: number): void {
  const max = sourceDuration(project, seg.sourceId) || Infinity
  if (edge === 'in') seg.in = round6(Math.min(Math.max(0, seg.in + delta), seg.out - MIN_SEGMENT))
  else seg.out = round6(Math.max(Math.min(max, seg.out + delta), seg.in + MIN_SEGMENT))
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

interface Tweak {
  label: string
  before: unknown
  after: unknown
  corrections: CorrectionKind[]
}

/** Apply one manual tweak. Throws ValidationError if the result is not a valid project. */
export async function applyUserOp(ctx: AppContext, store: ProjectStore, op: UserOp): Promise<void> {
  // Anything that needs the engine happens before the change, so the change itself is one step.
  let swapSource: Source | null = null
  if (op.op === 'swapFile') {
    const existing = store.project.sources.find((s) => s.path === op.path)
    const item = store.project.items.find((i) => i.id === op.id)
    const origin: Source['origin'] = item && trackKindOf(store.project, item.trackId) === 'music' ? 'music' : 'other'
    swapSource = existing ?? (await probeSource(ctx, op.path, origin))
  }

  const tweak = store.mutate(labelFor(op), 'user', (doc) => runOp(doc, op, swapSource))
  store.log.write('tweak', tweak.label, { op: op.op, before: tweak.before, after: tweak.after })

  const { id: projectId, profileId } = store.project
  for (const kind of tweak.corrections) {
    try {
      ctx.corrections.record(kind, projectId, profileId)
    } catch (err) {
      store.log.write('error', 'Could not record a learned correction', { kind, error: String(err) })
    }
  }
}

function labelFor(op: UserOp): string {
  switch (op.op) {
    case 'moveItem': return 'Move item'
    case 'trimItem': return op.edge === 'start' ? 'Trim start' : 'Trim end'
    case 'deleteItem': return 'Delete item'
    case 'nudgeSegment': return `Nudge cut ${op.edge === 'in' ? 'start' : 'end'}`
    case 'updateItem': return 'Change item'
    case 'updateTrack': return 'Change track'
    case 'addTrack': return `Add ${TRACK_LABELS[op.kind]} track`
    case 'editWord': return 'Fix transcript word'
    case 'setEmphasis': return op.emphasis ? 'Emphasise word' : 'Remove emphasis'
    case 'setInspiration': return 'Edit inspiration'
    case 'swapFile': return 'Swap file'
    case 'patchProject': return `Change ${op.path}`
  }
}

function runOp(doc: ProjectDoc, op: UserOp, swapSource: Source | null): Tweak {
  const project = doc.project
  const label = labelFor(op)
  const corrections: CorrectionKind[] = []

  switch (op.op) {
    case 'moveItem': {
      const item = findItem(doc, op.id)
      const before = structuredClone(item)
      if (item.type === 'segment') {
        moveSegment(project, item, op.start)
      } else {
        const resolver = new TimelineResolver(project, doc.transcript)
        item.anchor = anchorFor(project, resolver, item, op.start)
      }
      return { label, before, after: structuredClone(item), corrections }
    }

    case 'trimItem': {
      const item = findItem(doc, op.id)
      const before = structuredClone(item)
      const resolver = new TimelineResolver(project, doc.transcript)
      const span = resolver.resolveItem(item)
      if (item.type === 'segment') {
        const speed = item.speed || 1
        if (op.edge === 'start') nudge(project, item, 'in', (op.time - span.start) * speed)
        else nudge(project, item, 'out', (op.time - span.end) * speed)
        corrections.push(...cutCorrections(before as SegmentItem, item))
      } else {
        if (op.edge === 'start') {
          const newStart = Math.max(0, Math.min(op.time, span.end - MIN_LENGTH))
          const delta = newStart - span.start
          item.anchor = anchorFor(project, resolver, item, newStart)
          item.duration = round6(span.end - newStart)
          if ((item.type === 'clip' || item.type === 'audio') && !item.loop) {
            // The picture or sound under the item stays where it was; only its start edge moves.
            const speed = item.type === 'clip' ? item.speed || 1 : 1
            item.in = round6(Math.max(0, item.in + delta * speed))
          }
        } else {
          item.duration = round6(Math.max(MIN_LENGTH, op.time - span.start))
        }
        corrections.push(...lengthCorrections(project, before as AnchoredItem, item))
      }
      return { label, before, after: structuredClone(item), corrections }
    }

    case 'deleteItem': {
      const item = findItem(doc, op.id)
      project.items = project.items.filter((i) => i.id !== op.id)
      const kind = trackKindOf(project, item.trackId)
      if (kind === 'sfx') corrections.push('sfx_deleted')
      if (kind === 'broll') corrections.push('broll_deleted')
      return { label, before: item, after: null, corrections }
    }

    case 'nudgeSegment': {
      const item = findItem(doc, op.id)
      if (item.type !== 'segment') throw new ValidationError('Only A-roll cuts can be nudged')
      const before = structuredClone(item)
      nudge(project, item, op.edge, op.delta)
      corrections.push(...cutCorrections(before, item))
      return { label, before: { in: before.in, out: before.out }, after: { in: item.in, out: item.out }, corrections }
    }

    case 'updateItem': {
      const item = findItem(doc, op.id)
      const before = structuredClone(item)
      const patch = { ...op.patch } as Record<string, unknown>
      delete patch.id
      delete patch.type
      const index = project.items.indexOf(item)
      const next = { ...item, ...patch } as Item
      project.items[index] = next
      if (isAnchored(before) && isAnchored(next)) corrections.push(...lengthCorrections(project, before, next), ...volumeCorrections(project, before, next))
      if (before.type === 'segment' && next.type === 'segment') corrections.push(...cutCorrections(before, next))
      return { label, before: pick(before, Object.keys(patch)), after: pick(next, Object.keys(patch)), corrections }
    }

    case 'updateTrack': {
      const track = project.tracks.find((t) => t.id === op.id)
      if (!track) throw new ValidationError(`That track no longer exists (${op.id})`)
      const before = structuredClone(track)
      const patch = { ...op.patch } as Partial<Track>
      delete patch.id
      delete patch.kind
      Object.assign(track, patch)
      return { label, before: pick(before, Object.keys(patch)), after: pick(track, Object.keys(patch)), corrections }
    }

    case 'addTrack': {
      const taken = new Set(project.tracks.map((t) => t.id))
      let n = 2
      while (taken.has(`${op.kind}_${n}`)) n++
      const track: Track = {
        id: `${op.kind}_${n}`,
        kind: op.kind,
        name: op.name?.trim() || `${TRACK_LABELS[op.kind]} ${n}`,
        muted: false,
        solo: false,
        volume: 0,
        hidden: false
      }
      // New tracks sit after the last track of the same kind, so draw order stays by kind.
      let at = -1
      project.tracks.forEach((t, i) => {
        if (t.kind === op.kind) at = i
      })
      project.tracks.splice(at < 0 ? project.tracks.length : at + 1, 0, track)
      return { label, before: null, after: track, corrections }
    }

    case 'editWord': {
      const word = findWord(doc, op.wordId)
      const before = word.text
      word.text = op.text
      word.edited = true
      return { label, before: { id: word.id, text: before }, after: { id: word.id, text: word.text }, corrections }
    }

    case 'setEmphasis': {
      const word = findWord(doc, op.wordId)
      const before = !!word.emphasis
      word.emphasis = op.emphasis
      return { label, before: { id: word.id, emphasis: before }, after: { id: word.id, emphasis: op.emphasis }, corrections }
    }

    case 'setInspiration': {
      const before = project.inspiration
      project.inspiration = op.text
      return { label, before, after: op.text, corrections }
    }

    case 'swapFile': {
      const item = findItem(doc, op.id)
      const before = structuredClone(item)
      if (item.type === 'clip' || item.type === 'audio') {
        if (!swapSource) throw new ValidationError('No file to swap to')
        if (!project.sources.some((s) => s.id === swapSource.id)) project.sources.push(swapSource)
        item.sourceId = swapSource.id
        delete item.file
        item.in = 0
        // The item keeps its length; the new file plays from its start.
      } else if (item.type === 'graphic' || item.type === 'effect') {
        item.file = op.path
      } else {
        throw new ValidationError('A-roll cuts cannot swap files; relink the footage instead')
      }
      return { label, before: pick(before, ['sourceId', 'file']), after: { ...pick(item, ['sourceId', 'file']), path: op.path }, corrections }
    }

    case 'patchProject': {
      const target = project[op.path] as Record<string, unknown>
      const before = pick(target, Object.keys(op.patch))
      Object.assign(target, op.patch)
      if (op.path === 'captions' && op.patch.enabled === false && before.enabled !== false) corrections.push('captions_off')
      return { label, before, after: pick(target, Object.keys(op.patch)), corrections }
    }
  }
}

function pick(obj: unknown, keys: string[]): Record<string, unknown> {
  const o = (obj ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = structuredClone(o[k])
  return out
}

/** Moving an A-roll piece changes the cut order: it goes where its new start lands. */
function moveSegment(project: Project, seg: SegmentItem, start: number): void {
  const others = project.items.filter((i) => i !== seg)
  const temp = { ...project, items: others }
  const placed = placeSegments(temp)
  let insertBefore: string | null = null
  for (const p of placed) {
    if (start < p.start + segmentDuration(p.item) / 2) {
      insertBefore = p.item.id
      break
    }
  }
  const idx = insertBefore ? others.findIndex((i) => i.id === insertBefore) : others.length
  others.splice(idx, 0, seg)
  project.items = others
}

function cutCorrections(before: SegmentItem, after: SegmentItem): CorrectionKind[] {
  const looser = after.in < before.in - 1e-6 || after.out > before.out + 1e-6
  const tighter = after.in > before.in + 1e-6 || after.out < before.out - 1e-6
  if (looser && !tighter) return ['cuts_looser']
  if (tighter && !looser) return ['cuts_tighter']
  return []
}

function lengthCorrections(project: Project, before: AnchoredItem, after: AnchoredItem): CorrectionKind[] {
  const kind = trackKindOf(project, after.trackId)
  const shorter = after.duration < before.duration - 1e-3
  const longer = after.duration > before.duration + 1e-3
  if (after.type === 'graphic' || kind === 'graphics') {
    if (shorter) return ['graphics_shorter']
    if (longer) return ['graphics_longer']
  }
  if (kind === 'broll' && shorter) return ['broll_shorter']
  return []
}

function volumeCorrections(project: Project, before: AnchoredItem, after: AnchoredItem): CorrectionKind[] {
  if (after.type !== 'audio' || before.type !== 'audio') return []
  const kind = trackKindOf(project, after.trackId)
  const quieter = after.volume < before.volume - 0.1
  const louder = after.volume > before.volume + 0.1
  if (kind === 'music' && after.duck) {
    if (quieter) return ['music_quieter']
    if (louder) return ['music_louder']
  }
  if (kind === 'sfx' && quieter) return ['sfx_quieter']
  return []
}
