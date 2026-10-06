/**
 * The preview: a low-resolution render made by the same engine as the export, so the two cannot differ.
 *
 * The timeline is cut into 2-second chunks. Each chunk gets a hash of everything that can change its
 * pixels: the plan layers overlapping it (full JSON), the files those layers draw from (graphic and effect
 * code by content, media by size and modified time), the caption lines over it, output size and fps,
 * brand kit and engine version. A chunk whose hash already has a file in cache/preview/chunks/ is reused;
 * only the others are rendered. The chunks are then joined (concat, no re-encode) and muxed with the
 * preview mix into cache/preview/preview-<version>.mp4.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'
import type { ProjectDoc } from '@shared/project'
import type { PreviewState } from '@shared/ipc'
import type { ChunkJob, Layer, RenderPlan } from '@shared/plan'
import type { AppContext, PreviewService } from '../context'
import type { ProjectStore } from '../project/store'
import { buildPlan, planDuration } from './plan'
import { formatCommand, isCancelled, sizeForHeight, spawnLines } from './engine'
import { ensureProxies } from './media'

export const CHUNK_SECONDS = 2
const DEBOUNCE_MS = 400

/** Effects that draw picture from other moments of the timeline (time warps). */
const TIME_WARP_EFFECTS = new Set(['freeze', 'speed', 'replay'])
/** Code and small data files are hashed by content; media by size and modified time. */
const CONTENT_HASH_EXTS = new Set(['.py', '.json', '.txt', '.svg', '.glsl', '.ttf', '.otf', '.png', '.jpg', '.jpeg', '.webp'])
const CONTENT_HASH_MAX_BYTES = 8 * 1024 * 1024

export type FileStamp = (path: string) => string

/** What a file looks like right now. Missing files stamp as 'missing', so they re-render once they appear. */
export function fileStamp(path: string): string {
  let st
  try {
    st = statSync(path)
  } catch {
    return 'missing'
  }
  if (st.isDirectory()) return `dir:${Math.round(st.mtimeMs)}`
  if (CONTENT_HASH_EXTS.has(extname(path).toLowerCase()) && st.size <= CONTENT_HASH_MAX_BYTES) {
    try {
      return 'sha1:' + createHash('sha1').update(readFileSync(path)).digest('hex')
    } catch {
      return 'missing'
    }
  }
  return `${st.size}:${Math.round(st.mtimeMs)}`
}

/** Memoises stamps for one build, so a file used by many chunks is read once. */
export function memoStamp(stamp: FileStamp = fileStamp): FileStamp {
  const cache = new Map<string, string>()
  return (p) => {
    let v = cache.get(p)
    if (v === undefined) {
      v = stamp(p)
      cache.set(p, v)
    }
    return v
  }
}

function sha(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 24)
}

/** Files a layer draws from: its media or code file, plus any file named in its params. */
export function layerFiles(layer: Layer, projectDir: string): string[] {
  const files: string[] = []
  if (layer.kind === 'video') files.push(layer.path)
  if (layer.kind === 'graphic') files.push(layer.file)
  if (layer.kind === 'effect' && layer.file) files.push(layer.file)
  if (layer.kind !== 'video') collectParamFiles(layer.params, projectDir, files)
  return files
}

function collectParamFiles(value: unknown, projectDir: string, out: string[], depth = 0): void {
  if (depth > 4 || value === null || value === undefined) return
  if (typeof value === 'string') {
    if (value.length > 3 && value.length < 400 && /\.[a-z0-9]{2,5}$/i.test(value) && !/^https?:/i.test(value)) {
      const p = isAbsolute(value) ? value : join(projectDir, value)
      if (existsSync(p)) out.push(p)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) collectParamFiles(v, projectDir, out, depth + 1)
    return
  }
  if (typeof value === 'object') for (const v of Object.values(value as Record<string, unknown>)) collectParamFiles(v, projectDir, out, depth + 1)
}

function layerKey(layer: Layer, projectDir: string, stamp: FileStamp): unknown {
  return { layer, files: layerFiles(layer, projectDir).map((f) => [f, stamp(f)]) }
}

export interface ChunkSpec {
  index: number
  start: number
  end: number
  hash: string
}

/** Chunk boundaries on whole frames, so joined chunks keep exact timing. */
export function chunkRanges(duration: number, fps: number, chunkSeconds = CHUNK_SECONDS): { index: number; start: number; end: number }[] {
  const totalFrames = Math.round(duration * fps)
  const perChunk = Math.max(1, Math.round(chunkSeconds * fps))
  const out: { index: number; start: number; end: number }[] = []
  for (let f = 0, i = 0; f < totalFrames; f += perChunk, i++) {
    out.push({ index: i, start: f / fps, end: Math.min(totalFrames, f + perChunk) / fps })
  }
  return out
}

/** The part of the hash every chunk shares: output, brand kit, caption style, engine version. */
function globalKey(plan: RenderPlan, stamp: FileStamp): string {
  const brandFiles = [plan.brand.logo?.enabled ? plan.brand.logo.path : '', ...(plan.brand.fonts ?? []).map((f) => f.path), plan.captions.style.font]
    .filter(Boolean)
    .map((p) => [p, stamp(isAbsolute(p) ? p : join(plan.projectDir, p))])
  return sha({
    planVersion: plan.planVersion,
    engineVersion: plan.engineVersion,
    design: plan.design,
    output: plan.output,
    brand: plan.brand,
    brandFiles,
    captionStyle: plan.captions.style,
    burn: plan.captions.burn
  })
}

/** Hashes every chunk of a plan. A chunk's hash changes only when something that draws into it changes. */
export function previewChunks(plan: RenderPlan, opts: { stamp?: FileStamp; chunkSeconds?: number; duration?: number } = {}): ChunkSpec[] {
  const stamp = memoStamp(opts.stamp)
  const duration = opts.duration ?? planDuration(plan)
  const global = globalKey(plan, stamp)
  const keyCache = new Map<Layer, string>()
  const keyOf = (l: Layer) => {
    let k = keyCache.get(l)
    if (!k) {
      k = sha(layerKey(l, plan.projectDir, stamp))
      keyCache.set(l, k)
    }
    return k
  }
  const videoLayers = plan.layers.filter((l) => l.kind === 'video')
  return chunkRanges(duration, plan.output.fps, opts.chunkSeconds).map((c) => {
    const over = plan.layers.filter((l) => l.start < c.end && l.end > c.start)
    const warps = over.some((l) => l.kind === 'effect' && TIME_WARP_EFFECTS.has(l.effect))
    // A time warp shows picture from other moments, so every video layer counts for this chunk.
    const used = warps ? [...new Set([...over, ...videoLayers])] : over
    const captions = plan.captions.burn ? plan.captions.lines.filter((l) => l.start < c.end && l.end > c.start) : []
    const hash = sha({ global, start: c.start, end: c.end, layers: used.map(keyOf), captions })
    return { ...c, hash }
  })
}

/** Hash of everything that affects the mix. Preview and export share it, so the master gain can be reused. */
export function audioHash(plan: RenderPlan, stamp: FileStamp = fileStamp, duration = planDuration(plan)): string {
  const s = memoStamp(stamp)
  return sha({
    engineVersion: plan.engineVersion,
    audio: { ...plan.audio, masterGainDb: null },
    duration,
    files: [...new Set(plan.audio.clips.map((c) => c.path))].map((p) => [p, s(p)])
  })
}

export interface MixInfo {
  out: string
  lufs?: number
  truePeakDb?: number
  masterGainDb?: number
}

/** The measured mix for an audio hash, if a preview already made it (cache/preview/audio-<hash>.json). */
export function cachedMix(projectDir: string, hash: string): MixInfo | null {
  const file = join(previewDir(projectDir), `audio-${hash}.json`)
  try {
    const info = JSON.parse(readFileSync(file, 'utf8')) as MixInfo
    return existsSync(info.out) ? info : null
  } catch {
    return null
  }
}

export function previewDir(projectDir: string): string {
  return join(projectDir, 'cache', 'preview')
}

function concatList(files: string[]): string {
  // Names only: the list sits next to the chunks, and the concat demuxer resolves names from there.
  return files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n'
}

export interface BuildProgress {
  chunksTotal: number
  chunksDone: number
  chunksPending: number
  message: string
}

/**
 * Renders the preview file of a project document. Shared by the live preview and the Before view.
 * Returns the finished mp4 (named from the hash of all its parts, so an unchanged edit costs nothing).
 */
export async function buildPreviewFile(
  ctx: AppContext,
  store: ProjectStore,
  doc: ProjectDoc,
  opts: { signal: AbortSignal; onProgress: (p: BuildProgress) => void; outName: (hash: string) => string }
): Promise<{ file: string; hash: string; rendered: number; total: number }> {
  const settings = ctx.settings.get()
  const fps = settings.previewFps || 30
  const size = sizeForHeight(doc.project.output, settings.previewHeight || 540)
  const dir = previewDir(store.dir)
  const chunkDir = join(dir, 'chunks')
  mkdirSync(chunkDir, { recursive: true })

  opts.onProgress({ chunksTotal: 0, chunksDone: 0, chunksPending: 0, message: 'Preparing footage…' })
  const proxies = await ensureProxies(ctx, store, opts.signal)
  if (opts.signal.aborted) throw abortError()

  const plan = buildPlan(doc, { projectDir: store.dir, width: size.width, height: size.height, fps, burnCaptions: true, proxies })
  const duration = planDuration(plan)
  const stamp = memoStamp()
  const chunks = previewChunks(plan, { stamp, duration })
  const aHash = audioHash(plan, stamp, duration)
  const overall = sha({ chunks: chunks.map((c) => c.hash), aHash })
  const final = join(dir, opts.outName(overall))
  if (existsSync(final)) return { file: final, hash: overall, rendered: 0, total: chunks.length }

  const chunkFile = (c: ChunkSpec) => join(chunkDir, `${c.hash}.mp4`)
  const missing = chunks.filter((c) => !existsSync(chunkFile(c)))
  const planFile = ctx.engine.writePlan(plan, dir, `plan-${overall}`)
  let done = chunks.length - missing.length
  const report = (message: string) =>
    opts.onProgress({ chunksTotal: chunks.length, chunksDone: done, chunksPending: chunks.length - done, message })

  if (missing.length) {
    report(`Rendering ${missing.length} of ${chunks.length} preview chunks…`)
    const jobs: ChunkJob[] = missing.map((c) => ({ index: c.index, start: c.start, end: c.end, out: join(chunkDir, `${c.hash}.part.mp4`) }))
    const byIndex = new Map(missing.map((c) => [c.index, c]))
    const jobsFile = join(dir, `jobs-${overall}.json`)
    writeFileSync(jobsFile, JSON.stringify(jobs))
    const settle = (c: ChunkSpec) => {
      const part = join(chunkDir, `${c.hash}.part.mp4`)
      if (existsSync(part) && !existsSync(chunkFile(c))) renameSync(part, chunkFile(c))
    }
    try {
      await ctx.engine.run(plan.engineVersion, ['render-chunks', '--plan', planFile, '--jobs', jobsFile], {
        signal: opts.signal,
        onEvent: (e) => {
          if (e.event !== 'chunk_done') return
          const c = byIndex.get(Number(e.index))
          if (!c) return
          settle(c)
          done++
          report(`Rendering preview… ${done} of ${chunks.length}`)
        }
      })
      for (const c of missing) settle(c)
    } finally {
      for (const c of missing) rmSync(join(chunkDir, `${c.hash}.part.mp4`), { force: true })
      rmSync(jobsFile, { force: true })
    }
    const still = missing.filter((c) => !existsSync(chunkFile(c)))
    if (still.length) throw new Error(`The engine did not produce ${still.length} preview chunk(s).`)
  }
  if (opts.signal.aborted) throw abortError()

  // Preview audio: the same mix the export makes, cached by the audio plan.
  let wav: string | null = null
  if (plan.audio.clips.length) {
    const cached = cachedMix(store.dir, aHash)
    if (cached) wav = cached.out
    else {
      report('Mixing preview audio…')
      const out = join(dir, `audio-${aHash}.wav`)
      const tmp = join(dir, `audio-${aHash}.part.wav`)
      try {
        const r = (await ctx.engine.run(plan.engineVersion, ['mix', '--plan', planFile, '--out', tmp], { signal: opts.signal })) as MixInfo | null
        renameSync(tmp, out)
        writeFileSync(join(dir, `audio-${aHash}.json`), JSON.stringify({ ...(r ?? {}), out }))
        wav = out
      } finally {
        rmSync(tmp, { force: true })
      }
    }
  }

  report('Joining preview…')
  const listFile = join(chunkDir, `list-${overall}.txt`)
  writeFileSync(listFile, concatList(chunks.map((c) => `${c.hash}.mp4`)))
  const tmpOut = final.replace(/\.mp4$/, '.part.mp4')
  const args = ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', listFile]
  if (wav) args.push('-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k')
  else args.push('-map', '0:v:0', '-c:v', 'copy')
  args.push('-movflags', '+faststart', tmpOut)
  const ffmpeg = ctx.env.ffmpeg()
  try {
    const r = await spawnLines(ffmpeg, args, { signal: opts.signal })
    if (r.code !== 0) {
      store.log.write('render', 'Joining the preview failed', { command: formatCommand(ffmpeg, args), errorOutput: r.stderr.slice(-4000) })
      throw new Error('Joining the preview chunks failed. See the log for details.')
    }
    renameSync(tmpOut, final)
  } finally {
    rmSync(tmpOut, { force: true })
    rmSync(listFile, { force: true })
    rmSync(planFile, { force: true })
  }
  return { file: final, hash: overall, rendered: missing.length, total: chunks.length }
}

function abortError(): Error {
  const e = new Error('Cancelled')
  e.name = 'AbortError'
  return e
}

export function createPreviewService(ctx: AppContext): PreviewService {
  let state: PreviewState = { status: 'idle', version: 0, chunksTotal: 0, chunksDone: 0, chunksPending: 0 }
  const listeners = new Set<(s: PreviewState) => void>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let controller: AbortController | null = null
  let running: Promise<void> | null = null
  let generation = 0
  let lastHash = ''
  let lastDir = ''
  let envReady = false
  let beforeController: AbortController | null = null
  let beforeBusy = false

  const emit = (patch: Partial<PreviewState>) => {
    state = { ...state, ...patch }
    for (const cb of listeners) {
      try {
        cb(state)
      } catch {
        /* a listener problem must not stop the preview */
      }
    }
    ctx.send('preview:state', state)
  }

  /** Plain reason the preview cannot render on this PC, or null when it can. */
  const unavailableReason = async (): Promise<string | null> => {
    if (envReady) return null
    const s = await ctx.env.status()
    if (!s.gpu.ok) return s.gpu.message
    if (!s.python.ok) return s.python.installing ? 'The render engine is being installed. The preview appears when it is done.' : `The preview needs the render engine. ${s.python.message}`
    if (!s.ffmpeg.ok) return s.ffmpeg.message
    envReady = true
    return null
  }

  const nextVersionNumber = (dir: string): number => {
    let max = state.version
    try {
      for (const f of readdirSync(dir)) {
        const m = /^preview-(\d+)\.mp4$/.exec(f)
        if (m) max = Math.max(max, Number(m[1]))
      }
    } catch {
      /* no folder yet */
    }
    return max + 1
  }

  const removeOldPreviews = (dir: string, keep: string) => {
    try {
      for (const f of readdirSync(dir)) {
        if (/^preview-.*\.mp4$/.test(f) && join(dir, f) !== keep) rmSync(join(dir, f), { force: true })
      }
    } catch {
      /* a file still open in the player is removed next time */
    }
  }

  const build = async (gen: number, signal: AbortSignal): Promise<void> => {
    const store = ctx.projects.current()
    if (!store) {
      lastHash = ''
      emit({ status: 'idle', file: undefined, beforeFile: undefined, chunksTotal: 0, chunksDone: 0, chunksPending: 0, message: undefined })
      return
    }
    if (store.dir !== lastDir) {
      lastDir = store.dir
      lastHash = ''
      emit({ file: undefined, beforeFile: undefined })
    }
    const reason = await unavailableReason()
    if (gen !== generation) return
    if (reason) {
      emit({ status: 'unavailable', message: reason, chunksTotal: 0, chunksDone: 0, chunksPending: 0 })
      return
    }
    const doc = store.snapshotDoc()
    if (!doc.project.items.some((i) => i.type === 'segment')) {
      emit({ status: 'idle', file: undefined, message: 'Nothing on the timeline yet. The preview appears once Claude places the first cut.', chunksTotal: 0, chunksDone: 0, chunksPending: 0 })
      return
    }
    const missing = ctx.projects.missingSources()
    if (missing.length) {
      emit({ status: 'error', message: `Some footage files cannot be found (${missing.length}). Relink them to see the preview.` })
      return
    }
    const started = Date.now()
    const dir = previewDir(store.dir)
    mkdirSync(dir, { recursive: true })
    let target = ''
    const result = await buildPreviewFile(ctx, store, doc, {
      signal,
      onProgress: (p) => {
        if (gen === generation) emit({ status: 'rendering', ...p })
      },
      outName: (hash) => {
        if (hash === lastHash && state.file && existsSync(state.file)) {
          target = state.file
          return target.slice(dir.length + 1)
        }
        target = join(dir, `preview-${nextVersionNumber(dir)}.mp4`)
        return target.slice(dir.length + 1)
      }
    })
    if (gen !== generation) return
    const changed = result.hash !== lastHash || result.file !== state.file
    lastHash = result.hash
    if (changed) {
      removeOldPreviews(dir, result.file)
      const m = /preview-(\d+)\.mp4$/.exec(result.file)
      emit({
        status: 'ready',
        file: result.file,
        version: m ? Number(m[1]) : state.version + 1,
        chunksTotal: result.total,
        chunksDone: result.total,
        chunksPending: 0,
        message: undefined
      })
      store.log.write('render', `Preview updated: ${result.rendered} of ${result.total} chunks rendered in ${((Date.now() - started) / 1000).toFixed(1)} s`)
    } else {
      emit({ status: 'ready', chunksTotal: result.total, chunksDone: result.total, chunksPending: 0, message: undefined })
    }
  }

  const kick = () => {
    timer = null
    controller?.abort()
    const ctl = new AbortController()
    controller = ctl
    const gen = ++generation
    const prev = running
    const job = (async () => {
      // Let a cancelled build finish dying before starting, so they never write the same files.
      if (prev) await prev.catch(() => undefined)
      if (gen !== generation) return
      try {
        await build(gen, ctl.signal)
      } catch (err) {
        if (isCancelled(err) || gen !== generation) return
        const message = (err as Error).message || 'The preview could not be rendered.'
        ctx.projects.current()?.log.write('render', 'Preview failed', { error: message })
        emit({ status: 'error', message: `The preview could not be rendered: ${message}` })
      }
    })()
    running = job
    void job.finally(() => {
      if (running === job) {
        running = null
        if (controller === ctl) controller = null
      }
    })
  }

  return {
    state: () => state,
    onState(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    invalidate() {
      if (timer) clearTimeout(timer)
      // A change cancels the running build at once; the new one starts after the debounce.
      controller?.abort()
      timer = setTimeout(kick, DEBOUNCE_MS)
    },
    async showBefore(requestId) {
      beforeController?.abort()
      beforeController = null
      if (!requestId) {
        emit({ beforeFile: undefined })
        return
      }
      const store = ctx.projects.current()
      if (!store) return
      const request = store.project.requests.find((r) => r.id === requestId)
      if (!request?.beforeVersionId) throw new Error('This change has no Before version to show.')
      const reason = await unavailableReason()
      if (reason) throw new Error(reason)
      const doc = ctx.versions.load(request.beforeVersionId)
      const ctl = new AbortController()
      beforeController = ctl
      beforeBusy = true
      try {
        const r = await buildPreviewFile(ctx, store, doc, {
          signal: ctl.signal,
          onProgress: (p) => {
            if (state.status !== 'rendering') emit({ message: p.message })
          },
          outName: (hash) => `before-${hash}.mp4`
        })
        if (beforeController === ctl) emit({ beforeFile: r.file, message: state.status === 'ready' ? undefined : state.message })
      } catch (err) {
        if (isCancelled(err)) return
        store.log.write('render', 'Before preview failed', { error: (err as Error).message })
        throw err
      } finally {
        beforeBusy = false
        if (beforeController === ctl) beforeController = null
      }
    },
    isBusy: () => !!running || !!timer || beforeBusy
  }
}
