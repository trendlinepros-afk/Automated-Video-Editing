/**
 * Turns the stored project (cuts + anchors) into absolute timeline times.
 * This is bookkeeping only: it places things where Claude said they go. It makes no editing decisions.
 */
import type {
  Anchor,
  AnchoredItem,
  CaptionStyle,
  Item,
  Project,
  Range,
  SegmentItem,
  Transcript,
  Word
} from './project'
import { isAnchored } from './project'

export interface PlacedSegment {
  item: SegmentItem
  index: number
  start: number
  end: number
}

export interface WordRef {
  word: Word
  sourceId: string
  index: number
}

export interface PlacedWord {
  word: Word
  sourceId: string
  start: number
  end: number
  segmentId: string
}

export interface ResolvedItem {
  item: Item
  start: number
  end: number
  orphaned: boolean
}

export interface CaptionLine {
  id: string
  start: number
  end: number
  words: PlacedWord[]
}

const EPS = 1e-6

export function segmentDuration(s: SegmentItem): number {
  if (s.hold !== undefined && s.hold > 0) return s.hold
  return Math.max(0, (s.out - s.in) / (s.speed || 1))
}

export function arollSegments(project: Project): SegmentItem[] {
  const arollTrackIds = new Set(project.tracks.filter((t) => t.kind === 'aroll').map((t) => t.id))
  return project.items.filter(
    (i): i is SegmentItem => i.type === 'segment' && arollTrackIds.has(i.trackId)
  )
}

export function placeSegments(project: Project): PlacedSegment[] {
  let t = 0
  return arollSegments(project).map((item, index) => {
    const start = t
    t += segmentDuration(item)
    return { item, index, start, end: t }
  })
}

export function buildWordIndex(transcript: Transcript): Map<string, WordRef> {
  const map = new Map<string, WordRef>()
  for (const [sourceId, clip] of Object.entries(transcript.clips)) {
    clip.words.forEach((word, index) => map.set(word.id, { word, sourceId, index }))
  }
  return map
}

/** Timeline time of a source time, or null if that moment was cut. */
export function sourceToTimeline(
  segments: PlacedSegment[],
  sourceId: string,
  sourceTime: number
): { time: number; segment: PlacedSegment } | null {
  for (const seg of segments) {
    const s = seg.item
    if (s.sourceId !== sourceId || s.hold) continue
    if (sourceTime >= s.in - EPS && sourceTime < s.out - EPS) {
      return { time: seg.start + (sourceTime - s.in) / (s.speed || 1), segment: seg }
    }
  }
  return null
}

export function timelineToSource(
  segments: PlacedSegment[],
  t: number
): { segment: PlacedSegment; sourceTime: number } | null {
  for (const seg of segments) {
    if (t >= seg.start - EPS && t < seg.end - EPS) {
      const s = seg.item
      const sourceTime = s.hold ? s.in : s.in + (t - seg.start) * (s.speed || 1)
      return { segment: seg, sourceTime }
    }
  }
  return null
}

export class TimelineResolver {
  readonly segments: PlacedSegment[]
  readonly words: Map<string, WordRef>
  readonly duration: number
  private wordCache = new Map<string, { time: number; orphaned: boolean }>()

  constructor(
    readonly project: Project,
    readonly transcript: Transcript
  ) {
    this.segments = placeSegments(project)
    this.words = buildWordIndex(transcript)
    this.duration = this.segments.length ? this.segments[this.segments.length - 1].end : 0
  }

  /** Where a word lands on the timeline. A word that was cut follows the nearest kept word after it. */
  wordTime(wordId: string): { time: number; orphaned: boolean } {
    const cached = this.wordCache.get(wordId)
    if (cached) return cached
    const ref = this.words.get(wordId)
    let result: { time: number; orphaned: boolean }
    if (!ref) {
      result = { time: 0, orphaned: true }
    } else {
      const direct = sourceToTimeline(this.segments, ref.sourceId, ref.word.start)
      if (direct) {
        result = { time: direct.time, orphaned: false }
      } else {
        result = { time: this.nearestKept(ref), orphaned: true }
      }
    }
    this.wordCache.set(wordId, result)
    return result
  }

  private nearestKept(ref: WordRef): number {
    const words = this.transcript.clips[ref.sourceId]?.words ?? []
    for (let i = ref.index + 1; i < words.length; i++) {
      const hit = sourceToTimeline(this.segments, ref.sourceId, words[i].start)
      if (hit) return hit.time
    }
    for (let i = ref.index - 1; i >= 0; i--) {
      const hit = sourceToTimeline(this.segments, ref.sourceId, words[i].start)
      if (hit) return hit.time
    }
    return 0
  }

  anchorTime(anchor: Anchor): { time: number; orphaned: boolean } {
    if (anchor.kind === 'time') return { time: anchor.time, orphaned: false }
    const w = this.wordTime(anchor.wordId)
    return { time: Math.max(0, w.time + (anchor.offset ?? 0)), orphaned: w.orphaned }
  }

  resolveItem(item: Item): ResolvedItem {
    if (item.type === 'segment') {
      const seg = this.segments.find((s) => s.item.id === item.id)
      return { item, start: seg?.start ?? 0, end: seg?.end ?? 0, orphaned: false }
    }
    const { time, orphaned } = this.anchorTime(item.anchor)
    return { item, start: time, end: time + item.duration, orphaned }
  }

  resolveAll(): ResolvedItem[] {
    return this.project.items.map((i) => this.resolveItem(i))
  }

  /** Words in the order they are heard on the timeline. */
  placedWords(): PlacedWord[] {
    const out: PlacedWord[] = []
    for (const seg of this.segments) {
      const s = seg.item
      if (s.hold) continue
      const clip = this.transcript.clips[s.sourceId]
      if (!clip) continue
      for (const word of clip.words) {
        if (word.start >= s.in - EPS && word.start < s.out - EPS) {
          const speed = s.speed || 1
          const start = seg.start + (word.start - s.in) / speed
          const end = Math.min(seg.end, seg.start + (Math.min(word.end, s.out) - s.in) / speed)
          out.push({ word, sourceId: s.sourceId, start, end: Math.max(start, end), segmentId: s.id })
        }
      }
    }
    return out
  }

  /** Map a timeline anchor-able moment to the word anchor at or just before it, for anchoring new items. */
  anchorAt(t: number): Anchor {
    const words = this.placedWords()
    let best: PlacedWord | null = null
    for (const w of words) {
      if (w.start <= t + EPS) best = w
      else break
    }
    if (!best) return { kind: 'time', time: Math.max(0, t) }
    return { kind: 'word', wordId: best.word.id, offset: round3(t - best.start) }
  }
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** Which words get burned-in captions: undefined = every word; a set = only those (captions at key moments). */
export function captionFilter(project: Pick<Project, 'captions'>, transcript: Transcript): Set<string> | undefined {
  return project.captions.mode === 'moments' ? captionWordIds(transcript, project.captions.spans ?? []) : undefined
}

/** The words inside the caption spans (from one word to another in the same clip, inclusive). */
export function captionWordIds(transcript: Transcript, spans: { from: string; to: string }[]): Set<string> {
  const ids = new Set<string>()
  const where = new Map<string, { clip: string; index: number }>()
  for (const [clip, c] of Object.entries(transcript.clips)) c.words.forEach((w, index) => where.set(w.id, { clip, index }))
  for (const span of spans) {
    const a = where.get(span.from)
    const b = where.get(span.to)
    if (!a || !b || a.clip !== b.clip) continue
    const words = transcript.clips[a.clip].words
    for (let i = Math.min(a.index, b.index); i <= Math.max(a.index, b.index); i++) ids.add(words[i].id)
  }
  return ids
}

/**
 * Caption lines built from the transcript Claude saved, so they follow the words through every cut.
 * With only = a set of word ids (captions at key moments), lines are made from those words alone.
 */
export function buildCaptions(resolver: TimelineResolver, style: Pick<CaptionStyle, 'maxWords'>, only?: Set<string>): CaptionLine[] {
  const words = only ? resolver.placedWords().filter((w) => only.has(w.word.id)) : resolver.placedWords()
  const lines: CaptionLine[] = []
  let current: PlacedWord[] = []
  const flush = () => {
    if (!current.length) return
    lines.push({
      id: `cap_${current[0].word.id}`,
      start: current[0].start,
      end: current[current.length - 1].end,
      words: current
    })
    current = []
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const prev = current[current.length - 1]
    if (prev && (w.start - prev.end > 0.6 || w.segmentId !== prev.segmentId && w.start - prev.end > 0.25)) flush()
    current.push(w)
    const endsSentence = /[.!?]["']?$/.test(w.word.text.trim())
    if (current.length >= style.maxWords || endsSentence) flush()
  }
  flush()
  // Keep each line on screen until the next starts (up to 0.4 s) so captions do not flicker.
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1]
    const hold = next ? Math.min(next.start, lines[i].end + 0.4) : lines[i].end + 0.4
    lines[i].end = Math.max(lines[i].end, hold)
  }
  return lines
}

export function rangeContains(range: Range, start: number, end: number, eps = 1e-3): boolean {
  return start >= range.start - eps && end <= range.end + eps
}

export function rangesOverlap(a: Range, b: Range): boolean {
  return a.start < b.end && b.start < a.end
}

export function anchoredItems(project: Project): AnchoredItem[] {
  return project.items.filter(isAnchored)
}

export function formatTime(t: number, withMs = false): string {
  const sign = t < 0 ? '-' : ''
  t = Math.abs(t)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  const ms = Math.floor((t % 1) * 1000)
  const mm = h ? String(m).padStart(2, '0') : String(m)
  const base = `${sign}${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`
  return withMs ? `${base}.${String(ms).padStart(3, '0')}` : base
}

/** Parse "2:10", "1:02:03", "130s", "2m10s" into seconds. */
export function parseTime(text: string): number | null {
  const s = text.trim()
  let m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s)
  if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3]
  m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(s)
  if (m) return +m[1] * 60 + +m[2]
  m = /^(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec)?)?$/i.exec(s)
  if (m && (m[1] || m[2])) return (m[1] ? +m[1] * 60 : 0) + (m[2] ? +m[2] : 0)
  return null
}

const TIME_TOKEN = String.raw`\d+:\d{1,2}(?::\d{1,2})?(?:\.\d+)?|\d+\s*m(?:in)?\s*\d+\s*s(?:ec)?|\d+(?:\.\d+)?\s*s(?:ec)?`

/** Find a time range typed in a chat message, such as "At 2:10 to 2:45" or "from 1:05-1:20". */
export function findTimeRange(text: string): Range | null {
  const re = new RegExp(`(${TIME_TOKEN})\\s*(?:-|–|—|to|until|through|and)\\s*(${TIME_TOKEN})`, 'i')
  const m = re.exec(text)
  if (m) {
    const a = parseTime(m[1])
    const b = parseTime(m[2])
    if (a !== null && b !== null && b > a) return { start: a, end: b }
  }
  const single = new RegExp(`(?:at|around|@)\\s*(${TIME_TOKEN})`, 'i').exec(text)
  if (single) {
    const a = parseTime(single[1])
    if (a !== null) return { start: Math.max(0, a - 2), end: a + 3 }
  }
  return null
}
