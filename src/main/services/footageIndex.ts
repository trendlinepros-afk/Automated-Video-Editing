/**
 * The footage index: every video source of the open project is looked through once, on this computer (no Claude
 * usage), by engine/analysis/index_footage.py. The result lists the shots of each file with how they look (sharp or
 * soft, steady or shaky, calm or busy, faces, colours, loudness) and one small picture per shot, so Claude can pick
 * B-roll and moments from a list and confirm with one look instead of rendering frame after frame.
 *
 * One source at a time, in the background, starting when a project opens and whenever footage is added. Results are
 * kept in the project folder (cache/index/<sourceId>-<size>-<mtime>.json and a folder of pictures of the same name)
 * and reused while the file is unchanged. Measurement only: Claude makes every choice.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { basename, join } from 'node:path'
import type { Source } from '@shared/project'
import { TimelineResolver, round3, sourceToTimeline, timelineToSource } from '@shared/timeline'
import type { AppContext } from '../context'
import type { ProjectStore } from '../project/store'
import { isCancelled, spawnLines } from '../engine/engine'

export interface IndexedShot {
  index: number
  start: number
  end: number
  /** Why the shot starts here: start of the file, a cut, the view changed (drift) or the 10 s limit (length). */
  boundary: 'start' | 'cut' | 'drift' | 'length'
  /** Detail (variance of the Laplacian at 320 px wide) and the same against the file's typical shot. */
  sharpness: number
  sharpRel: number
  /** Picture change between frames with the camera movement taken out (0..1). */
  motion: number
  /** Camera movement in frame widths a second, and how much it jitters (shake). */
  cameraMove: number
  shake: number
  brightness: number
  colors: string[]
  faces: number
  /** The largest face as a share of the picture. */
  faceShare: number
  subject: { x: number; y: number; w: number; h: number; by: 'face' | 'motion' | 'detail' } | null
  /** Source time of the best still: sharp, little motion. */
  best: number
  thumb: string | null
  audioDb?: number
  audioPeakDb?: number
}

export interface FootageIndex {
  version: number
  duration: number
  width: number
  height: number
  fps: number
  frames: number
  hasAudio: boolean
  facesChecked: boolean
  shots: IndexedShot[]
  audio: { step: number; db: number[] } | null
  seconds: number
}

export interface FootageIndexEntry {
  sourceId: string
  key: string
  /** Folder holding the shot pictures. */
  thumbs: string
  index: FootageIndex
}

export interface FootageIndexStatus {
  running: boolean
  current: { sourceId: string; name: string; percent: number } | null
  /** Video sources with an index, of all video sources whose file is there. */
  done: number
  total: number
  failed: { sourceId: string; name: string; error: string }[]
}

/** Runs the analysis of one file. Tests pass a fake. */
export type IndexRunner = (job: { video: string; outDir: string; onProgress: (percent: number) => void; signal: AbortSignal }) => Promise<FootageIndex>
/** Draws a numbered contact sheet of pictures. Tests pass a fake. */
export type SheetRunner = (items: { path: string; label: string }[], out: string) => Promise<string>

export interface FootageIndexService {
  /** Follows the open project: indexes its footage now and whenever sources are added. */
  start(): void
  status(): FootageIndexStatus
  /** The finished index of a source, or null (not a video, file missing, not indexed yet). */
  get(sourceId: string): FootageIndexEntry | null
  /** Looks for new or changed video files and indexes them in the background. */
  refresh(): void
  /** Resolves when nothing is left to index. */
  idle(): Promise<void>
  sheet: SheetRunner
}

// ------------------------------------------------------------------ cache files

/** The cache name of a source: changes when the file does. Null when the file is not there. */
export function indexKey(source: Source): string | null {
  try {
    const st = statSync(source.path)
    return st.isFile() ? `${source.id}-${st.size}-${Math.round(st.mtimeMs)}` : null
  } catch {
    return null
  }
}

export const indexDir = (store: ProjectStore): string => join(store.paths.cache, 'index')

function readIndex(file: string): FootageIndex | null {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as FootageIndex
    return Array.isArray(data?.shots) ? data : null
  } catch {
    return null
  }
}

/** Removes the index of older versions of a source's file. */
function removeStale(dir: string, sourceId: string, keep: string): void {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const n of names) {
    if (n.startsWith(`${sourceId}-`) && n !== keep && n !== `${keep}.json`) rmSync(join(dir, n), { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------ the scripts

function scriptPath(ctx: AppContext, name: string): string {
  return ctx.env.analysisScript().replace(/style\.py$/, name)
}

/** Half the processor for the decoder, so the app and the preview stay responsive. */
const decoderThreads = (): number => Math.max(2, Math.floor((cpus().length || 4) / 2))

async function runPython<T>(ctx: AppContext, args: string[], opts: { signal?: AbortSignal; onEvent?: (e: Record<string, unknown>) => void } = {}): Promise<T> {
  let result: T | null = null
  let error: string | null = null
  const r = await spawnLines(ctx.env.python(), args, {
    signal: opts.signal,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    onLine: (line) => {
      try {
        const e = JSON.parse(line)
        if (e.event === 'result') result = e.data
        else if (e.event === 'error') error = String(e.message)
        else opts.onEvent?.(e)
      } catch {
        /* not an event */
      }
    }
  })
  if (result === null) throw new Error(error ?? (r.stderr.trim().split('\n').pop() || 'the analysis did not finish'))
  return result
}

export function scriptRunner(ctx: AppContext): IndexRunner {
  return ({ video, outDir, onProgress, signal }) =>
    runPython<FootageIndex>(ctx, [scriptPath(ctx, 'index_footage.py'), '--ffmpeg', ctx.env.ffmpeg(), '--video', video, '--out-dir', outDir, '--threads', String(decoderThreads())], {
      signal,
      onEvent: (e) => {
        if (e.event === 'progress' && Number(e.total) > 0) onProgress(Math.round((Number(e.done) / Number(e.total)) * 100))
      }
    })
}

export function sheetRunner(ctx: AppContext): SheetRunner {
  return async (items, out) => {
    const list = `${out}.json`
    writeFileSync(list, JSON.stringify(items))
    try {
      await runPython(ctx, [scriptPath(ctx, 'shot_sheet.py'), '--items', list, '--out', out])
    } finally {
      rmSync(list, { force: true })
    }
    return out
  }
}

// ------------------------------------------------------------------ the service

export function createFootageIndexService(ctx: AppContext, deps: { run?: IndexRunner; sheet?: SheetRunner; pollMs?: number } = {}): FootageIndexService {
  const run = deps.run ?? scriptRunner(ctx)
  const pollMs = deps.pollMs ?? 5000
  let store: ProjectStore | null = null
  let entries = new Map<string, FootageIndexEntry>()
  /** Cache keys that failed in this session; tried again when the project is opened again or the file changes. */
  let failed = new Map<string, { sourceId: string; name: string; error: string }>()
  let current: { sourceId: string; name: string; percent: number; abort: AbortController } | null = null
  let pumping: Promise<void> | null = null
  let detach: (() => void) | null = null
  let started = false

  const videoSources = (s: ProjectStore) => s.project.sources.filter((x) => x.kind === 'video')

  const entryFor = (s: ProjectStore, source: Source): FootageIndexEntry | null => {
    const key = indexKey(source)
    if (!key) return null
    const known = entries.get(source.id)
    if (known && known.key === key) return known
    const dir = indexDir(s)
    const index = readIndex(join(dir, `${key}.json`))
    if (!index) return null
    const entry = { sourceId: source.id, key, thumbs: join(dir, key), index }
    entries.set(source.id, entry)
    return entry
  }

  const todo = (s: ProjectStore): Source[] =>
    videoSources(s).filter((x) => {
      const key = indexKey(x)
      return key !== null && !failed.has(key) && !entryFor(s, x)
    })

  /** Exports come first: wait while one is rendering. */
  const exportFree = async (s: ProjectStore) => {
    while (store === s && ctx.renders?.isBusy?.()) await new Promise((r) => setTimeout(r, pollMs))
  }

  const indexOne = async (s: ProjectStore, source: Source) => {
    const key = indexKey(source)
    if (!key) return
    const dir = indexDir(s)
    const thumbs = join(dir, key)
    rmSync(thumbs, { recursive: true, force: true })
    mkdirSync(thumbs, { recursive: true })
    const abort = new AbortController()
    const name = basename(source.path)
    current = { sourceId: source.id, name, percent: 0, abort }
    const t0 = Date.now()
    try {
      const index = await run({ video: source.path, outDir: thumbs, signal: abort.signal, onProgress: (p) => current && (current.percent = p) })
      if (store !== s) return
      const file = join(dir, `${key}.json`)
      writeFileSync(`${file}.tmp`, JSON.stringify(index))
      renameSync(`${file}.tmp`, file)
      removeStale(dir, source.id, key)
      entries.set(source.id, { sourceId: source.id, key, thumbs, index })
      s.log.write('app', `Footage index: ${name}, ${index.shots.length} shots in ${Math.round((Date.now() - t0) / 1000)} s`)
    } catch (err) {
      if (isCancelled(err) || store !== s) return
      const error = err instanceof Error ? err.message : String(err)
      failed.set(key, { sourceId: source.id, name, error })
      s.log.write('error', `Could not index the footage ${name}`, { error })
    } finally {
      if (current?.abort === abort) current = null
    }
  }

  const pump = (): Promise<void> => {
    if (pumping) return pumping
    let p: Promise<void> | null = null
    p = (async () => {
      await null // so `pumping` is set before the loop can finish and clear it
      try {
        for (;;) {
          const s = store
          if (!s) break
          const next = todo(s)[0]
          if (!next) break
          await exportFree(s)
          if (store !== s) continue
          await indexOne(s, next)
        }
      } finally {
        if (pumping === p) pumping = null
      }
    })()
    pumping = p
    return p
  }

  const follow = (s: ProjectStore | null) => {
    if (s === store) return
    current?.abort.abort()
    detach?.()
    detach = null
    store = s
    entries = new Map()
    failed = new Map()
    if (!s) return
    mkdirSync(indexDir(s), { recursive: true })
    // New footage: only a change in the list of video files starts work.
    let known = videoSources(s).map((x) => `${x.id}|${x.path}`).join('\n')
    const onChange = () => {
      const now = videoSources(s).map((x) => `${x.id}|${x.path}`).join('\n')
      if (now === known) return
      known = now
      void pump()
    }
    s.on('change', onChange)
    detach = () => s.off('change', onChange)
    void pump()
  }

  return {
    start() {
      if (started) return
      started = true
      ctx.projects.onOpened((s) => follow(s))
      follow(ctx.projects.current())
    },
    status() {
      const s = store ?? ctx.projects.current()
      const videos = s ? videoSources(s).filter((x) => indexKey(x) !== null) : []
      return {
        running: !!current || !!pumping,
        current: current ? { sourceId: current.sourceId, name: current.name, percent: current.percent } : null,
        done: s ? videos.filter((x) => entryFor(s, x)).length : 0,
        total: videos.length,
        failed: [...failed.values()]
      }
    },
    get(sourceId) {
      const s = store ?? ctx.projects.current()
      const source = s?.project.sources.find((x) => x.id === sourceId)
      return s && source && source.kind === 'video' ? entryFor(s, source) : null
    },
    refresh() {
      if (!store && ctx.projects.current()) follow(ctx.projects.current())
      else void pump()
    },
    idle: async () => {
      while (pumping) await pumping
    },
    sheet: deps.sheet ?? sheetRunner(ctx)
  }
}

// ------------------------------------------------------------------ reading the index (for Claude's tools)

/** Where a stretch of a source is used: A-roll pieces and B-roll clips, in timeline seconds. */
export interface ShotUse {
  as: 'aroll' | 'broll'
  itemId: string
  start: number
  end: number
}

export function shotUses(r: TimelineResolver, sourceId: string, a: number, b: number): ShotUse[] {
  const out: ShotUse[] = []
  for (const seg of r.segments) {
    const s = seg.item
    if (s.sourceId !== sourceId || s.hold) continue
    const lo = Math.max(a, s.in)
    const hi = Math.min(b, s.out)
    if (hi - lo < 0.05) continue
    const speed = s.speed || 1
    out.push({ as: 'aroll', itemId: s.id, start: round3(seg.start + (lo - s.in) / speed), end: round3(seg.start + (hi - s.in) / speed) })
  }
  for (const item of r.project.items) {
    if (item.type !== 'clip' || item.sourceId !== sourceId) continue
    const res = r.resolveItem(item)
    const speed = item.speed || 1
    const lo = Math.max(a, item.in)
    const hi = Math.min(b, item.in + (res.end - res.start) * speed)
    if (hi - lo < 0.05) continue
    out.push({ as: 'broll', itemId: item.id, start: round3(res.start + (lo - item.in) / speed), end: round3(res.start + (hi - item.in) / speed) })
  }
  return out.sort((x, y) => x.start - y.start)
}

/** Plain words for how a shot looks, from the measurements. */
export interface ShotLook {
  detail: 'sharp' | 'ok' | 'soft' | 'flat'
  camera: 'steady' | 'moving' | 'shaky'
  motion: 'calm' | 'some' | 'action'
  light: 'dark' | 'ok' | 'bright'
  faces: 'none' | 'face' | 'close' | 'unknown'
  loud: boolean
}

export function shotLook(s: IndexedShot, facesChecked: boolean): ShotLook {
  const detail = s.sharpness < 15 ? 'flat' : s.sharpness < 40 || s.sharpRel < 0.45 ? 'soft' : s.sharpRel >= 0.8 && s.sharpness >= 80 ? 'sharp' : 'ok'
  const camera = s.shake > 0.012 ? 'shaky' : s.cameraMove > 0.08 ? 'moving' : 'steady'
  const motion = s.motion >= 0.025 ? 'action' : s.motion >= 0.006 ? 'some' : 'calm'
  const light = s.brightness < 0.22 ? 'dark' : s.brightness > 0.72 ? 'bright' : 'ok'
  const faces = !facesChecked ? 'unknown' : s.faces === 0 ? 'none' : s.faceShare >= 0.03 ? 'close' : 'face'
  return { detail, camera, motion, light, faces, loud: (s.audioPeakDb ?? -99) >= -12 }
}

export function lookWords(l: ShotLook): string {
  const faces = { none: 'no face', face: 'face', close: 'close face', unknown: 'faces not checked' }[l.faces]
  const light = l.light === 'ok' ? '' : l.light
  return [l.detail, l.camera, l.motion, light, faces, l.loud ? 'loud' : ''].filter(Boolean).join(' ')
}

export const shotId = (sourceId: string, index: number): string => `${sourceId}#${index}`

export function parseShotId(id: string): { sourceId: string; index: number } | null {
  const i = id.lastIndexOf('#')
  const index = Number(id.slice(i + 1))
  return i > 0 && Number.isInteger(index) && index > 0 ? { sourceId: id.slice(0, i), index } : null
}

/** The part of a shot that is safe to use: cut times are only as exact as one analysed frame, so keep clear of them. */
export function usableRange(idx: FootageIndex, s: IndexedShot): { in: number; out: number } {
  const margin = Math.max(0.3, 1 / (idx.fps || 4))
  const next = idx.shots[s.index] // shots are numbered from 1, so this is the one after
  const a = s.boundary === 'cut' ? s.start + margin : s.start
  const b = next?.boundary === 'cut' ? s.end - margin : s.end
  return b - a > 0.2 ? { in: round3(a), out: round3(b) } : { in: s.start, out: s.end }
}

export interface ShotQuery {
  source_id?: string
  min_seconds?: number
  steady?: boolean
  faces?: 'none' | 'any' | 'close'
  sharp?: boolean
  bright?: boolean
  motion?: 'calm' | 'some' | 'action'
  loud?: boolean
  not_on_timeline?: boolean
  near_time?: number
  limit?: number
}

export interface ShotCandidate {
  shot: string
  source_id: string
  file: string
  start: number
  end: number
  seconds: number
  use: { in: number; out: number }
  best: number
  best_on_timeline?: number
  look: string
  colors: string[]
  on_timeline: ShotUse[]
  score: number
}

/** Shot quality for ranking, 0..1: detail, a steady camera, good light, enough length. */
function quality(s: IndexedShot, l: ShotLook): number {
  const detail = l.detail === 'flat' ? 0.1 : l.detail === 'soft' ? 0.25 : 0.6 + 0.4 * Math.min(1, Math.max(0, s.sharpRel - 0.45))
  const camera = { steady: 1, moving: 0.75, shaky: 0.2 }[l.camera]
  const light = 1 - Math.min(1, Math.abs(s.brightness - 0.5) * 2)
  const length = Math.min(1, (s.end - s.start) / 4)
  return 0.4 * detail + 0.25 * camera + 0.2 * light + 0.15 * length
}

/** Filters and ranks indexed shots. Shots that fail a filter are left out; the rest are sorted best first. */
export function findShots(sources: { source: Source; entry: FootageIndexEntry }[], r: TimelineResolver, q: ShotQuery): ShotCandidate[] {
  // near_time: the source moment playing at that timeline time; shots near it in the same file rank higher.
  const hit = q.near_time !== undefined ? timelineToSource(r.segments, q.near_time) : null
  const near = hit ? { sourceId: hit.segment.item.sourceId, time: hit.sourceTime } : null
  const out: ShotCandidate[] = []
  for (const { source, entry } of sources) {
    if (q.source_id && source.id !== q.source_id) continue
    const idx = entry.index
    for (const s of idx.shots) {
      const l = shotLook(s, idx.facesChecked)
      const seconds = s.end - s.start
      if (q.min_seconds !== undefined && seconds < q.min_seconds) continue
      if (q.steady === true && l.camera === 'shaky') continue
      if (q.steady === false && l.camera === 'steady') continue
      if (q.sharp === true && (l.detail === 'soft' || l.detail === 'flat')) continue
      if (q.sharp === false && l.detail !== 'soft') continue
      if (q.bright === true && (l.light === 'dark' || s.brightness < 0.3)) continue
      if (q.bright === false && l.light !== 'dark') continue
      if (q.motion && l.motion !== q.motion) continue
      if (q.loud === true && !l.loud) continue
      if (q.faces === 'none' && l.faces !== 'none' && l.faces !== 'unknown') continue
      if (q.faces === 'any' && l.faces !== 'face' && l.faces !== 'close') continue
      if (q.faces === 'close' && l.faces !== 'close') continue
      const uses = shotUses(r, source.id, s.start, s.end)
      if (q.not_on_timeline && uses.length) continue
      let score = quality(s, l)
      if (q.motion === 'action' || q.loud) score += Math.min(0.3, s.motion * 4) // the busiest moments first
      if (near) {
        const d = near.sourceId === source.id ? Math.max(0, near.time - s.end, s.start - near.time) : Infinity
        score -= Number.isFinite(d) ? Math.min(0.5, d / 120) : 0.6
      }
      const onTl = sourceToTimeline(r.segments, source.id, s.best)
      out.push({
        shot: shotId(source.id, s.index),
        source_id: source.id,
        file: basename(source.path),
        start: s.start,
        end: s.end,
        seconds: round3(seconds),
        use: usableRange(idx, s),
        best: s.best,
        ...(onTl ? { best_on_timeline: round3(onTl.time) } : {}),
        look: lookWords(l),
        colors: s.colors,
        on_timeline: uses,
        score: Math.round(score * 1000) / 1000
      })
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, Math.max(1, q.limit ?? 10))
}
