/**
 * Builds the render plan the engine draws from. Pure bookkeeping: positions come from the cuts and
 * anchors Claude wrote; nothing is adjusted.
 */
import { isAbsolute, join } from 'node:path'
import { ENGINE_VERSION } from '@shared/appInfo'
import { PLAN_VERSION, type AudioClip, type Layer, type PlanKeyframe, type PlanTransform, type RenderPlan } from '@shared/plan'
import type { ProjectDoc, Track, Transform } from '@shared/project'
import { CaptionStyleSchema } from '@shared/project'
import { TimelineResolver, buildCaptions } from '@shared/timeline'

export interface PlanOptions {
  projectDir: string
  width: number
  height: number
  fps: number
  burnCaptions: boolean
  /** Use low-resolution proxies instead of the original footage (preview only). */
  proxies?: Map<string, string>
}

function toTransform(t: Transform | undefined): PlanTransform | null {
  if (!t) return null
  return { x: t.x ?? 0, y: t.y ?? 0, scale: t.scale ?? 1, rotation: t.rotation ?? 0, opacity: t.opacity ?? 1 }
}

function keyframes(k: { t: number; x: number; y: number; scale?: number }[] | undefined): PlanKeyframe[] {
  return (k ?? []).map((f) => ({ t: f.t, x: f.x, y: f.y, ...(f.scale !== undefined ? { scale: f.scale } : {}) }))
}

/** Track gain in dB including mute and solo. -Infinity means silent. */
export function trackGains(tracks: Track[]): Map<string, number> {
  const anySolo = tracks.some((t) => t.solo)
  const out = new Map<string, number>()
  for (const t of tracks) {
    const silent = t.muted || (anySolo && !t.solo)
    out.set(t.id, silent ? -Infinity : t.volume ?? 0)
  }
  return out
}

export function buildPlan(doc: ProjectDoc, opts: PlanOptions): RenderPlan {
  const { project } = doc
  const resolver = new TimelineResolver(project, doc.transcript)
  const tracks = new Map(project.tracks.map((t) => [t.id, t]))
  const gains = trackGains(project.tracks)
  const sources = new Map(project.sources.map((s) => [s.id, s]))
  const resolvePath = (p: string) => (isAbsolute(p) ? p : join(opts.projectDir, p))
  const sourcePath = (id: string) => {
    const proxy = opts.proxies?.get(id)
    if (proxy) return proxy
    const s = sources.get(id)
    if (!s) throw new Error(`Unknown source ${id}`)
    return s.path
  }

  const layers: Layer[] = []
  const audio: AudioClip[] = []
  // Draw order follows track order: A-roll, B-roll, Graphics, Effects... Extra tracks of a kind
  // draw with their kind.
  const kindOrder = ['aroll', 'broll', 'effects', 'graphics', 'captions', 'music', 'sfx']
  const trackRank = (trackId: string) => {
    const t = tracks.get(trackId)
    const idx = project.tracks.findIndex((x) => x.id === trackId)
    return (t ? kindOrder.indexOf(t.kind) : 99) * 1000 + idx
  }

  for (const seg of resolver.segments) {
    const s = seg.item
    const src = sources.get(s.sourceId)
    const track = tracks.get(s.trackId)
    if (track?.hidden) continue
    if (src?.kind !== 'audio') {
      layers.push({
        kind: 'video',
        id: s.id,
        trackId: s.trackId,
        role: 'aroll',
        path: s.picture ? resolvePath(s.picture.file) : sourcePath(s.sourceId),
        isImage: !s.picture && src?.kind === 'image',
        start: seg.start,
        end: seg.end,
        sourceIn: s.picture ? s.in - s.picture.sourceStart : s.in,
        speed: s.speed || 1,
        hold: !!s.hold,
        // A-roll pieces are full frame; a Short's pieces carry the crop that follows the subject.
        transform: toTransform((s as { transform?: Transform }).transform),
        keyframes: keyframes((s as { keyframes?: PlanKeyframe[] }).keyframes),
        fadeIn: 0,
        fadeOut: 0,
        ...(s.picture ? {} : { sourceWidth: src?.width, sourceHeight: src?.height })
      })
    }
    const g = gains.get(s.trackId) ?? 0
    if (!s.hold && !s.muted && Number.isFinite(g) && (src?.hasAudio || src?.kind === 'audio')) {
      audio.push({
        id: s.id,
        trackId: s.trackId,
        role: 'voice',
        path: src ? src.path : sourcePath(s.sourceId), // audio always from the original
        start: seg.start,
        end: seg.end,
        sourceIn: s.in,
        speed: s.speed || 1,
        gainDb: (s.volume ?? 0) + g,
        fadeIn: s.fadeIn ?? 0,
        fadeOut: s.fadeOut ?? 0,
        duck: false,
        loop: false
      })
    }
  }

  for (const r of resolver.resolveAll()) {
    const item = r.item
    if (item.type === 'segment') continue
    const track = tracks.get(item.trackId)
    if (!track) continue
    const g = gains.get(item.trackId) ?? 0
    if (item.type === 'clip') {
      const src = item.sourceId ? sources.get(item.sourceId) : undefined
      const path = item.sourceId ? sourcePath(item.sourceId) : resolvePath(item.file!)
      const isImage = src ? src.kind === 'image' : /\.(png|jpe?g|webp|bmp|gif)$/i.test(path)
      // A processed picture (stabilized) replaces the frames only; B-roll sound stays on the original.
      const pic = item.picture && !isImage ? item.picture : null
      if (!track.hidden) {
        layers.push({
          kind: 'video',
          id: item.id,
          trackId: item.trackId,
          role: 'broll',
          path: pic ? resolvePath(pic.file) : path,
          isImage,
          start: r.start,
          end: r.end,
          sourceIn: pic ? (item.in ?? 0) - pic.sourceStart : item.in ?? 0,
          speed: item.speed ?? 1,
          hold: false,
          transform: toTransform(item.transform),
          keyframes: keyframes(item.keyframes),
          fadeIn: item.fadeIn ?? 0,
          fadeOut: item.fadeOut ?? 0,
          ...(pic ? {} : { sourceWidth: src?.width, sourceHeight: src?.height })
        })
      }
      const vol = (item.volume ?? -120) + g
      if (!isImage && vol > -100 && (src ? src.hasAudio : true)) {
        audio.push({
          id: item.id,
          trackId: item.trackId,
          role: 'broll',
          path: src ? src.path : path,
          start: r.start,
          end: r.end,
          sourceIn: item.in ?? 0,
          speed: item.speed ?? 1,
          gainDb: vol,
          fadeIn: item.fadeIn ?? 0,
          fadeOut: item.fadeOut ?? 0,
          duck: false,
          loop: false
        })
      }
    } else if (item.type === 'graphic') {
      if (track.hidden) continue
      layers.push({
        kind: 'graphic',
        id: item.id,
        trackId: item.trackId,
        file: resolvePath(item.file),
        params: item.params ?? {},
        start: r.start,
        end: r.end,
        transform: toTransform(item.transform),
        keyframes: keyframes(item.keyframes),
        fadeIn: 0,
        fadeOut: 0
      })
    } else if (item.type === 'effect') {
      if (track.hidden) continue
      layers.push({
        kind: 'effect',
        id: item.id,
        trackId: item.trackId,
        effect: item.effect,
        ...(item.file ? { file: resolvePath(item.file) } : {}),
        params: item.params ?? {},
        start: r.start,
        end: r.end,
        fadeIn: 0,
        fadeOut: 0
      })
    } else if (item.type === 'audio') {
      if (!Number.isFinite(g)) continue
      const src = item.sourceId ? sources.get(item.sourceId) : undefined
      const path = src ? src.path : resolvePath(item.file!)
      audio.push({
        id: item.id,
        trackId: item.trackId,
        role: track.kind === 'music' ? 'music' : track.kind === 'aroll' ? 'voice' : 'sfx',
        path,
        start: r.start,
        end: r.end,
        sourceIn: item.in ?? 0,
        speed: 1,
        gainDb: (item.volume ?? 0) + g,
        fadeIn: item.fadeIn ?? 0,
        fadeOut: item.fadeOut ?? 0,
        duck: !!item.duck,
        loop: !!item.loop
      })
    }
  }

  layers.sort((a, b) => trackRank(a.trackId) - trackRank(b.trackId) || a.start - b.start)

  const brand = project.settings.brandKit
  const style = CaptionStyleSchema.parse({ ...brand.captionStyle, ...(project.captions.style ?? {}) })
  const captionTrack = project.tracks.find((t) => t.kind === 'captions')
  const lines = project.captions.enabled && !captionTrack?.hidden ? buildCaptions(resolver, style) : []

  return {
    planVersion: PLAN_VERSION,
    engineVersion: project.engineVersion || ENGINE_VERSION,
    projectDir: opts.projectDir,
    design: { width: project.output.width, height: project.output.height, fps: project.output.fps },
    output: { width: opts.width, height: opts.height, fps: opts.fps },
    duration: resolver.duration,
    layers,
    captions: {
      burn: opts.burnCaptions && lines.length > 0,
      style,
      lines: lines.map((l) => ({
        start: l.start,
        end: l.end,
        words: l.words.map((w) => ({ text: w.word.text.trim(), start: w.start, end: w.end, emphasis: !!w.word.emphasis }))
      }))
    },
    brand,
    audio: { sampleRate: 48000, clips: audio, mix: project.settings.mix, masterGainDb: null }
  }
}

/** Track duration covering the A-roll plus anything placed past its end. */
export function planDuration(plan: RenderPlan): number {
  let d = plan.duration
  for (const l of plan.layers) d = Math.max(d, l.end)
  for (const a of plan.audio.clips) if (a.role !== 'music') d = Math.max(d, a.end)
  return d
}
