/**
 * Timeline data derived from a project document (resolved times, words, captions).
 * Computed once per document and shared by every component that needs it.
 */
import type { ProjectDoc, Source, Track } from '@shared/project'
import { CaptionStyleSchema } from '@shared/project'
import {
  TimelineResolver,
  buildCaptions,
  type CaptionLine,
  type PlacedSegment,
  type PlacedWord,
  type ResolvedItem
} from '@shared/timeline'
import { useStore } from './store'
import { editor } from './editor'

export interface Derived {
  resolver: TimelineResolver
  /** Every item with its timeline start and end. */
  resolved: Map<string, ResolvedItem>
  /** Items of each track, sorted by start. */
  byTrack: Map<string, ResolvedItem[]>
  segments: PlacedSegment[]
  /** Length of the timeline: the A-roll, or the last item if something runs past it. */
  duration: number
  fps: number
  sources: Map<string, Source>
  tracks: Track[]
  words(): PlacedWord[]
  captions(): CaptionLine[]
}

const cache = new WeakMap<ProjectDoc, Derived>()

export function derive(doc: ProjectDoc): Derived {
  const hit = cache.get(doc)
  if (hit) return hit
  const { project, transcript } = doc
  const resolver = new TimelineResolver(project, transcript)
  const resolved = new Map<string, ResolvedItem>()
  const byTrack = new Map<string, ResolvedItem[]>()
  let end = resolver.duration
  for (const item of project.items) {
    const r = resolver.resolveItem(item)
    resolved.set(item.id, r)
    let list = byTrack.get(item.trackId)
    if (!list) byTrack.set(item.trackId, (list = []))
    list.push(r)
    if (r.end > end) end = r.end
  }
  for (const list of byTrack.values()) list.sort((a, b) => a.start - b.start)
  let words: PlacedWord[] | null = null
  let captions: CaptionLine[] | null = null
  const d: Derived = {
    resolver,
    resolved,
    byTrack,
    segments: resolver.segments,
    duration: Math.max(end, 1),
    fps: project.output.fps || 30,
    sources: new Map(project.sources.map((s) => [s.id, s])),
    tracks: project.tracks,
    words: () => (words ??= resolver.placedWords()),
    captions: () => {
      if (!captions) {
        const style = CaptionStyleSchema.parse({
          ...project.settings.brandKit.captionStyle,
          ...(project.captions.style ?? {})
        })
        captions = buildCaptions(resolver, style)
      }
      return captions
    }
  }
  cache.set(doc, d)
  return d
}

export function useSnapshot() {
  return useStore(editor, (s) => s.snapshot)
}

/** The open project's derived timeline data (null when no project is open). */
export function useDerived(): Derived | null {
  const doc = useStore(editor, (s) => s.snapshot?.doc ?? null)
  return doc ? derive(doc) : null
}

export function currentDerived(): Derived | null {
  const doc = editor.get().snapshot?.doc
  return doc ? derive(doc) : null
}
