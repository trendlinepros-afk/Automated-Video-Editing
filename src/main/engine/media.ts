/**
 * Media the editor needs around the timeline: preview proxies, waveforms, seam audio for nudging a cut,
 * and stills of the composite. All of it lives in the project's cache/ folder and is rebuilt when missing.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { placeSegments } from '@shared/timeline'
import type { AppContext } from '../context'
import type { ProjectStore } from '../project/store'
import { EngineError, formatCommand, spawnLines } from './engine'

export const PROXY_HEIGHT = 540
export const WAVEFORM_PEAKS_PER_SECOND = 100
/** Seconds of audio on each side of a cut played while nudging it. */
export const SEAM_SECONDS = 1.0

export function hashText(text: string, len = 16): string {
  return createHash('sha1').update(text).digest('hex').slice(0, len)
}

/** Identity of a media file that changes whenever the file does: path, size and modified time. */
export function mediaKey(path: string): string | null {
  try {
    const st = statSync(path)
    return hashText(`${path}|${st.size}|${Math.round(st.mtimeMs)}`)
  } catch {
    return null
  }
}

const inflight = new Map<string, Promise<string | null>>()

/** One task per output file at a time, however many callers ask for it. */
function once(key: string, fn: () => Promise<string | null>): Promise<string | null> {
  const running = inflight.get(key)
  if (running) return running
  const p = fn().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/**
 * Builds a 540p proxy of every video source (cache/proxies/<hash of path+size+mtime>.mp4).
 * Sources whose files are missing are left out; the map holds only proxies that exist.
 */
export async function ensureProxies(ctx: AppContext, store: ProjectStore, signal?: AbortSignal): Promise<Map<string, string>> {
  const dir = join(store.paths.cache, 'proxies')
  mkdirSync(dir, { recursive: true })
  const out = new Map<string, string>()
  const engineVersion = store.project.engineVersion
  for (const src of store.project.sources) {
    if (src.kind !== 'video') continue
    if (signal?.aborted) break
    const key = mediaKey(src.path)
    if (!key) continue
    const file = join(dir, `${key}.mp4`)
    if (existsSync(file)) {
      out.set(src.id, file)
      continue
    }
    const made = await once(file, async () => {
      const tmp = join(dir, `${key}.part.mp4`)
      rmSync(tmp, { force: true })
      try {
        await ctx.engine.run(engineVersion, ['proxy', '--path', src.path, '--out', tmp, '--height', String(PROXY_HEIGHT)], { signal })
        renameSync(tmp, file)
        return file
      } catch (err) {
        rmSync(tmp, { force: true })
        throw err
      }
    })
    if (made) out.set(src.id, made)
  }
  return out
}

function resolveMediaPath(store: ProjectStore, key: { sourceId?: string; file?: string }): string | null {
  if (key.sourceId) {
    const src = store.project.sources.find((s) => s.id === key.sourceId)
    return src ? src.path : null
  }
  if (key.file) return isAbsolute(key.file) ? key.file : join(store.dir, key.file)
  return null
}

/** Peaks for drawing an audio waveform, cached in cache/waveforms/. Null when the file cannot be found. */
export async function waveform(
  ctx: AppContext,
  key: { sourceId?: string; file?: string }
): Promise<{ peaksPerSecond: number; peaks: number[] } | null> {
  const store = ctx.projects.current()
  if (!store) return null
  const path = resolveMediaPath(store, key)
  if (!path) return null
  const mk = mediaKey(path)
  if (!mk) return null
  const dir = join(store.paths.cache, 'waveforms')
  const file = join(dir, `${mk}-${WAVEFORM_PEAKS_PER_SECOND}.json`)
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      rmSync(file, { force: true })
    }
  }
  const made = await once(file, async () => {
    const peaks = await ctx.engine.peaks(path, WAVEFORM_PEAKS_PER_SECOND)
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify({ peaksPerSecond: WAVEFORM_PEAKS_PER_SECOND, peaks }))
    renameSync(`${file}.tmp`, file)
    return file
  })
  return made ? JSON.parse(readFileSync(made, 'utf8')) : null
}

interface SeamPart {
  path: string | null // null = silence (freeze frame, muted, no audio)
  sourceStart: number
  sourceEnd: number
  speed: number
  gainDb: number
  seconds: number
}

/**
 * The audio around the cut before a segment, as it will play: the last second of the previous segment,
 * then the first second of this one. Built from the source files, for loop playback while nudging.
 */
export async function seamAudio(ctx: AppContext, segmentId: string): Promise<string> {
  const store = ctx.projects.current()
  if (!store) throw new Error('No project is open.')
  const placed = placeSegments(store.project)
  const idx = placed.findIndex((p) => p.item.id === segmentId)
  if (idx < 0) throw new Error('That cut is no longer on the timeline.')
  const sources = new Map(store.project.sources.map((s) => [s.id, s]))
  const track = new Map(store.project.tracks.map((t) => [t.id, t]))

  const part = (i: number, side: 'tail' | 'head'): SeamPart => {
    const s = placed[i].item
    const src = sources.get(s.sourceId)
    const speed = s.speed || 1
    const length = Math.min(SEAM_SECONDS, placed[i].end - placed[i].start)
    const t = track.get(s.trackId)
    const silent = !!s.hold || !!s.muted || !src || !(src.hasAudio || src.kind === 'audio') || !!t?.muted
    const sourceStart = side === 'tail' ? Math.max(s.in, s.out - length * speed) : s.in
    const sourceEnd = side === 'tail' ? s.out : Math.min(s.out, s.in + length * speed)
    return { path: silent ? null : src!.path, sourceStart, sourceEnd, speed, gainDb: (s.volume ?? 0) + (t?.volume ?? 0), seconds: length }
  }
  const parts: SeamPart[] = idx > 0 ? [part(idx - 1, 'tail'), part(idx, 'head')] : [part(idx, 'head')]

  const dir = join(store.paths.cache, 'seams')
  mkdirSync(dir, { recursive: true })
  const stamp = parts.map((p) => (p.path ? mediaKey(p.path) : 'silence'))
  const key = hashText(JSON.stringify({ parts, stamp }))
  const out = join(dir, `seam-${key}.wav`)
  if (existsSync(out)) return out

  const made = await once(out, async () => {
    const inputs: string[] = []
    const filters: string[] = []
    const snippets: string[] = []
    try {
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]
        const label = `a${i}`
        if (p.path) {
          const snip = join(dir, `part-${key}-${i}.wav`)
          snippets.push(snip)
          await ctx.engine.snippet(p.path, p.sourceStart, p.sourceEnd, snip)
          inputs.push('-i', snip)
          const tempo = Math.abs(p.speed - 1) > 1e-3 ? `,${atempoChain(p.speed)}` : ''
          filters.push(`[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo${tempo},volume=${p.gainDb.toFixed(2)}dB[${label}]`)
        } else {
          inputs.push('-f', 'lavfi', '-t', p.seconds.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo')
          filters.push(`[${i}:a]anull[${label}]`)
        }
      }
      const tmp = join(dir, `seam-${key}.part.wav`)
      const args = [
        '-hide_banner',
        '-y',
        ...inputs,
        '-filter_complex',
        `${filters.join(';')};${parts.map((_, i) => `[a${i}]`).join('')}concat=n=${parts.length}:v=0:a=1[out]`,
        '-map',
        '[out]',
        '-c:a',
        'pcm_s16le',
        tmp
      ]
      const ffmpeg = ctx.env.ffmpeg()
      const r = await spawnLines(ffmpeg, args, {})
      if (r.code !== 0) {
        store.log.write('render', 'Could not build the seam audio', { command: formatCommand(ffmpeg, args), errorOutput: r.stderr.slice(-4000) })
        throw new EngineError('Could not build the audio around this cut.', r.stderr)
      }
      renameSync(tmp, out)
      return out
    } finally {
      for (const s of snippets) rmSync(s, { force: true })
    }
  })
  return made ?? out
}

/** atempo accepts 0.5..2 per stage; chain stages for other speeds. */
export function atempoChain(speed: number): string {
  const stages: string[] = []
  let s = speed
  while (s > 2) {
    stages.push('atempo=2')
    s /= 2
  }
  while (s < 0.5) {
    stages.push('atempo=0.5')
    s /= 0.5
  }
  stages.push(`atempo=${s.toFixed(5)}`)
  return stages.join(',')
}

/** A still of the current composite (graphics, effects and captions included), 960 pixels wide. */
export async function frameAt(ctx: AppContext, time: number): Promise<string | null> {
  const store = ctx.projects.current()
  if (!store) return null
  return ctx.engine.frame(store.snapshotDoc(), store.dir, Math.max(0, time), { width: 960 })
}
