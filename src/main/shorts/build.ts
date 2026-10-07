/**
 * A Short as a timeline of its own: its pieces of footage in order, each with a crop that follows the subject
 * (wide footage in a vertical frame), and the project's captions made bigger and bolder. Rendered by the same
 * engine as the main video.
 */
import type { CaptionStyle, Item, Project, ProjectDoc, Source, Transform } from '@shared/project'

type Keyframe = { t: number; x: number; y: number; scale?: number }
import { SHORT_CAPTION_STYLE, type Short, type ShortSegment } from '@shared/shorts'

/** The crop for one piece: scale to fill the frame's height, then slide to keep the subject centred. */
export function cropFor(seg: ShortSegment, source: Pick<Source, 'width' | 'height'> | undefined, out: { width: number; height: number }): { transform: Transform; keyframes: Keyframe[] } | null {
  const sw = source?.width ?? 16
  const sh = source?.height ?? 9
  const a = sw / sh
  const b = out.width / out.height
  if (a <= b * 1.05) return null // already vertical (or close): the engine fills the frame as it is
  const scale = a / b
  const maxX = (scale - 1) / 2
  const xFor = (fx: number) => Math.round(Math.max(-maxX, Math.min(maxX, (0.5 - fx) * scale)) * 10000) / 10000
  const points = seg.focusX !== undefined ? [{ t: 0, x: seg.focusX, y: 0.5 }] : seg.track?.length ? seg.track : [{ t: 0, x: 0.5, y: 0.5 }]
  const length = Math.max(0, seg.out - seg.in)
  const keyframes = points.filter((p) => p.t <= length + 0.01).map((p) => ({ t: Math.max(0, p.t), x: xFor(p.x), y: 0, scale }))
  return { transform: { x: keyframes[0]?.x ?? 0, y: 0, scale, rotation: 0, opacity: 1 }, keyframes: keyframes.length > 1 ? keyframes : [] }
}

/** The project as this Short: same footage, transcript and brand, only the Short's pieces on the timeline. */
export function shortDoc(doc: ProjectDoc, short: Short, out: { width: number; height: number }): ProjectDoc {
  const project: Project = structuredClone(doc.project)
  const aroll = project.tracks.find((t) => t.kind === 'aroll')
  if (!aroll) throw new Error('The project has no A-roll track.')
  const sources = new Map(project.sources.map((s) => [s.id, s]))
  project.output = { width: out.width, height: out.height, fps: project.output.fps }
  project.items = short.segments.map((g, i) => {
    const crop = cropFor(g, sources.get(g.sourceId), out)
    return {
      id: `${short.id}_${i}`,
      type: 'segment',
      trackId: aroll.id,
      sourceId: g.sourceId,
      in: g.in,
      out: g.out,
      speed: 1,
      volume: 0,
      fadeIn: 0,
      fadeOut: 0,
      createdBy: 'claude',
      ...(crop ? { transform: crop.transform, ...(crop.keyframes.length ? { keyframes: crop.keyframes } : {}) } : {})
    } as Item
  })
  aroll.hidden = false
  for (const t of project.tracks) if (t.kind === 'captions') t.hidden = false
  // Bigger, bolder captions in the middle, a few words at a time; the brand's font and colours still apply.
  project.captions = { ...project.captions, enabled: short.captions, style: { ...(project.captions.style ?? {}), ...SHORT_CAPTION_STYLE } as unknown as CaptionStyle }
  return { project, transcript: doc.transcript }
}
