/**
 * Integration: builds a real preview (and a quick export) of a tiny generated project with the Python
 * engine. Skipped when python3, numpy, ffmpeg or the engine are not available on this machine.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProjectSettingsSchema, type Item } from '@shared/project'
import type { PreviewState, RenderJobState } from '@shared/ipc'
import type { AppContext } from '../src/main/context'
import { ActivityLog } from '../src/main/log'
import { ProjectStore } from '../src/main/project/store'
import { createEngineService } from '../src/main/engine/engine'
import { createPreviewService } from '../src/main/engine/preview'
import { createRenderJobs } from '../src/main/engine/renders'
import { frameAt, seamAudio, waveform } from '../src/main/engine/media'

const ENGINE_DIR = resolve('engine')

function engineAvailable(): boolean {
  if (!existsSync(join(ENGINE_DIR, 'ave_engine', '__main__.py'))) return false
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    execFileSync('python3', ['-c', 'import numpy'], { stdio: 'ignore' })
  } catch {
    return false
  }
  const r = spawnSync('python3', ['-m', 'ave_engine', '--ffmpeg', 'ffmpeg', '--ffprobe', 'ffprobe', 'check'], {
    cwd: ENGINE_DIR,
    encoding: 'utf8',
    timeout: 120000
  })
  return r.status === 0 && r.stdout.includes('"result"')
}

const available = engineAvailable()

function probe(file: string): { duration: number; width?: number; height?: number; audio: boolean } {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file], {
    encoding: 'utf8'
  })
  const j = JSON.parse(out)
  const v = j.streams.find((s: { codec_type: string }) => s.codec_type === 'video')
  return {
    duration: Number(j.format.duration),
    width: v?.width,
    height: v?.height,
    audio: j.streams.some((s: { codec_type: string }) => s.codec_type === 'audio')
  }
}

let root: string
let store: ProjectStore
let ctx: AppContext

function waitFor<T>(subscribe: (cb: (v: T) => void) => () => void, test: (v: T) => boolean, ms = 240000): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error('timed out'))
    }, ms)
    const off = subscribe((v) => {
      if (test(v)) {
        clearTimeout(timer)
        off()
        resolvePromise(v)
      }
    })
  })
}

beforeAll(() => {
  if (!available) return
  root = mkdtempSync(join(tmpdir(), 'ave-preview-'))
  const clip = join(root, 'footage', 'clip.mp4')
  execFileSync('mkdir', ['-p', join(root, 'footage')])
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=5',
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=5:sample_rate=48000',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip
  ])
  store = ProjectStore.create(join(root, 'project'), {
    name: 'Tiny test',
    profileId: 'p1',
    footageFolder: join(root, 'footage'),
    settings: ProjectSettingsSchema.parse({ exportPreset: { width: 640, height: 360, fps: 30, quality: 'draft' } }),
    thumbnails: { personaId: '', styleId: '', count: 1, direction: '' },
    appVersion: '0.9.0'
  })
  store.mutate('setup', 'claude', (d) => {
    d.project.output = { width: 640, height: 360, fps: 30 }
    d.project.sources.push({ id: 'src1', path: clip, kind: 'video', duration: 5, width: 640, height: 360, fps: 30, hasAudio: true, origin: 'footage' })
    d.project.items.push(
      { id: 'seg1', type: 'segment', trackId: 'aroll', sourceId: 'src1', in: 0, out: 2, speed: 1, volume: 0, fadeIn: 0, fadeOut: 0, createdBy: 'claude' } as Item,
      { id: 'seg2', type: 'segment', trackId: 'aroll', sourceId: 'src1', in: 3, out: 5, speed: 1, volume: 0, fadeIn: 0, fadeOut: 0, createdBy: 'claude' } as Item
    )
  })
  const partial = {
    appVersion: '0.9.0',
    isPackaged: false,
    appLog: new ActivityLog(join(root, 'app.log')),
    settings: { get: () => ({ previewHeight: 180, previewFps: 30, defaultExportsFolder: '' }) },
    env: {
      python: () => 'python3',
      ffmpeg: () => 'ffmpeg',
      ffprobe: () => 'ffprobe',
      engineDir: () => ENGINE_DIR,
      status: async () => ({ gpu: { ok: true, message: '' }, python: { ok: true, installing: false, message: '' }, ffmpeg: { ok: true, nvenc: false, message: '' } })
    },
    projects: { current: () => store, missingSources: () => [] },
    versions: { save: () => ({ id: 'v1', name: 'x', createdAt: '', auto: true }) },
    send: () => undefined
  } as unknown as AppContext
  ctx = partial
  ctx.engine = createEngineService(ctx)
  ctx.preview = createPreviewService(ctx)
  ctx.renders = createRenderJobs(ctx)
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!available)('preview with the real engine', () => {
  it('renders the chunked preview and re-renders nothing for an audio-only change', async () => {
    const ready = waitFor<PreviewState>((cb) => ctx.preview.onState(cb), (s) => s.status === 'ready' || s.status === 'error')
    ctx.preview.invalidate()
    const s = await ready
    expect(s.message).toBeUndefined()
    expect(s.status).toBe('ready')
    expect(s.file && existsSync(s.file)).toBe(true)
    const info = probe(s.file!)
    expect(info.duration).toBeGreaterThan(3.8)
    expect(info.duration).toBeLessThan(4.3)
    expect(info.height).toBe(180)
    expect(info.width).toBe(320)
    expect(info.audio).toBe(true)

    const chunkDir = join(store.dir, 'cache', 'preview', 'chunks')
    const chunks = readdirSync(chunkDir).filter((f) => f.endsWith('.mp4'))
    expect(chunks).toHaveLength(2)

    store.mutate('quieter', 'user', (d) => {
      const seg = d.project.items.find((i) => i.id === 'seg2') as { volume: number }
      seg.volume = -6
    })
    const again = waitFor<PreviewState>((cb) => ctx.preview.onState(cb), (x) => (x.status === 'ready' && x.version > s.version) || x.status === 'error')
    ctx.preview.invalidate()
    const s2 = await again
    expect(s2.status).toBe('ready')
    expect(readdirSync(chunkDir).filter((f) => f.endsWith('.mp4')).sort()).toEqual(chunks.sort())
    expect(existsSync(s.file!)).toBe(false) // older preview files are removed
  })

  it('exports a quick check of the whole video', async () => {
    const done = waitFor<RenderJobState>((cb) => ctx.renders.onJob(cb), (j) => j.status !== 'running')
    await ctx.renders.start({ preset: { name: 'x', width: 640, height: 360, fps: 30, quality: 'draft', codec: 'h264' }, quick: true, captions: 'none' })
    const job = await done
    expect(job.error).toBeUndefined()
    expect(job.status).toBe('done')
    const info = probe(job.out!)
    expect(info.duration).toBeGreaterThan(3.8)
    expect(info.duration).toBeLessThan(4.3)
    expect(job.out).toMatch(/Tiny test_whole_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.mp4$/)
  })

  it('checks the finished picture and sound before export, on the preview', async () => {
    const { runExportCheck } = await import('../src/main/services/exportCheck')
    ;(ctx.env as any).analysisScript = () => resolve('engine/analysis/style.py')
    const steps: string[] = []
    const r = await runExportCheck(ctx, store, { onProgress: (m) => steps.push(m) })
    expect(r.skipped).toEqual([])
    expect(r.checked.join(' ')).toMatch(/picture.*sound/)
    // Two moving pieces with a steady tone: nothing black, frozen or silent.
    expect(r.problems.filter((p) => /Black|frozen|silence|no sound/i.test(p.title))).toEqual([])
    expect(steps).toContain('Checking the picture and sound…')
  })

  it('makes stills, waveforms and the seam audio around a cut', async () => {
    const png = await frameAt(ctx, 1.5)
    expect(png && existsSync(png)).toBe(true)
    const wave = await waveform(ctx, { sourceId: 'src1' })
    expect(wave?.peaks.length).toBeGreaterThan(400)
    const seam = await seamAudio(ctx, 'seg2')
    const info = probe(seam)
    expect(info.audio).toBe(true)
    expect(info.duration).toBeGreaterThan(1.9)
    expect(info.duration).toBeLessThan(2.1)
  })
})
