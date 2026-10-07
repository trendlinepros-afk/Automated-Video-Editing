/**
 * Shorts: overlap rules, the vertical crop, Claude's tools, and a real render of a Short with the engine:
 * the subject (a white square moving left to right in 16:9 footage) stays centred in the 9:16 frame.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ProjectSettingsSchema, type Item } from '@shared/project'
import { overlapShare, shortDuration, type Short } from '@shared/shorts'
import type { AppContext } from '../src/main/context'
import { ActivityLog } from '../src/main/log'
import { ProjectStore } from '../src/main/project/store'
import { createEngineService } from '../src/main/engine/engine'
import { cropFor } from '../src/main/shorts/build'
import { createShortsService } from '../src/main/shorts/service'
import { buildRunPrompt } from '../src/main/runner/prompts'

const seg = (sourceId: string, a: number, b: number) => ({ sourceId, in: a, out: b })

describe('Shorts rules', () => {
  it('measures shared footage against the shorter Short', () => {
    const a = { segments: [seg('s1', 10, 30)] }
    expect(overlapShare(a, { segments: [seg('s1', 25, 35)] })).toBeCloseTo(0.5) // 5 of 10 s
    expect(overlapShare(a, { segments: [seg('s2', 10, 30)] })).toBe(0) // other footage
    expect(overlapShare(a, { segments: [seg('s1', 0, 5), seg('s1', 29, 40)] })).toBeCloseTo(1 / 16)
    expect(shortDuration({ segments: [seg('s1', 0, 5), seg('s1', 29, 40)] })).toBe(16)
  })

  it('crops wide footage to fill the vertical frame and keeps the subject centred, within the picture', () => {
    const out = { width: 1080, height: 1920 }
    const wide = { width: 1920, height: 1080 }
    const c = cropFor({ ...seg('s', 0, 4), track: [{ t: 0, x: 0.5, y: 0.5 }, { t: 2, x: 0.9, y: 0.5 }, { t: 4, x: 1, y: 0.5 }] }, wide, out)!
    expect(c.transform.scale).toBeCloseTo(3.1605, 3)
    expect(c.keyframes.map((k) => k.x)).toEqual([0, -1.0802, -1.0802]) // clamped: 1.08 is the edge of the picture
    expect(cropFor({ ...seg('s', 0, 4), focusX: 0.25 }, wide, out)!.transform.x).toBeCloseTo(0.7901, 3)
    expect(cropFor(seg('s', 0, 4), { width: 1080, height: 1920 }, out)).toBeNull() // vertical footage is used as it is
  })
})

const ENGINE_DIR = resolve('engine')
function engineAvailable(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    execFileSync('python3', ['-c', 'import numpy'], { stdio: 'ignore' })
  } catch {
    return false
  }
  const r = spawnSync('python3', ['-m', 'ave_engine', '--ffmpeg', 'ffmpeg', '--ffprobe', 'ffprobe', 'check'], { cwd: ENGINE_DIR, encoding: 'utf8', timeout: 120000 })
  return r.status === 0
}
const available = engineAvailable()
let root: string | undefined
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!available)('a Short rendered with the real engine', () => {
  it('follows the subject, renders 9:16 at the Short length, and exports it with its titles', async () => {
    root = mkdtempSync(join(tmpdir(), 'ave-shorts-'))
    const clip = join(root, 'move.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=0x202020:s=1280x720:r=30:d=8', '-f', 'lavfi', '-i', 'color=white:s=120x120:r=30:d=8',
      '-f', 'lavfi', '-i', 'sine=f=300:d=8', '-filter_complex', "[0:v][1:v]overlay=x='60+t*130':y=300,format=yuv420p", '-c:v', 'libx264', '-c:a', 'aac', '-shortest', clip])
    const store = ProjectStore.create(join(root, 'project'), {
      name: 'Shorts test', profileId: 'p1', footageFolder: root, settings: ProjectSettingsSchema.parse({}),
      thumbnails: { personaId: '', styleId: '', count: 1, direction: '' }, appVersion: '1'
    })
    const short: Short = {
      id: 'short_t', kind: 'highlight', title: 'Square run', reason: '', segments: [seg('src1', 1, 3.5), seg('src1', 5, 7)],
      youtubeTitle: 'Watch the square go', tiktokCaption: 'square 🔥', description: 'A test.', hashtags: ['test'], captions: true, createdAt: ''
    }
    store.mutate('setup', 'claude', (d) => {
      d.project.output = { width: 1920, height: 1080, fps: 30 }
      d.project.sources.push({ id: 'src1', path: clip, kind: 'video', duration: 8, width: 1280, height: 720, fps: 30, hasAudio: true, origin: 'footage' })
      d.project.items.push({ id: 'seg1', type: 'segment', trackId: 'aroll', sourceId: 'src1', in: 0, out: 8, speed: 1, volume: 0, fadeIn: 0, fadeOut: 0, createdBy: 'claude' } as Item)
      d.project.shorts = [short]
    })
    const states: string[] = []
    const ctx = {
      appVersion: '1', isPackaged: false, appLog: new ActivityLog(join(root, 'app.log')),
      settings: { get: () => ({ defaultExportsFolder: join(root!, 'exports'), previewHeight: 180, previewFps: 30 }) },
      env: { python: () => 'python3', ffmpeg: () => 'ffmpeg', ffprobe: () => 'ffprobe', engineDir: () => ENGINE_DIR, analysisScript: () => join(ENGINE_DIR, 'analysis', 'style.py') },
      projects: { current: () => store, missingSources: () => [] },
      send: (_ch: string, s: { working: Record<string, string> }) => states.push(...Object.values(s.working))
    } as unknown as AppContext
    ctx.engine = createEngineService(ctx)
    const svc = createShortsService(ctx)
    svc.prepare('short_t')
    const out = await svc.exportShort('short_t') // queued after the preview
    const saved = store.project.shorts![0]
    expect(saved.segments[0].track?.length).toBeGreaterThan(2)
    expect(saved.preview).toMatch(/^cache\/shorts\/short_t-.*\.mp4$/)
    expect(existsSync(join(store.dir, saved.preview!))).toBe(true)
    expect(states.some((s) => /Finding the subject|Rendering/.test(s))).toBe(true)

    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,codec_type:format=duration', '-of', 'json', out], { encoding: 'utf8' }))
    const v = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video')
    expect([v.width, v.height]).toEqual([1080, 1920])
    expect(Number(probe.format.duration)).toBeCloseTo(4.5, 0)
    expect(readFileSync(out.replace(/\.mp4$/, '.txt'), 'utf8')).toMatch(/YouTube Shorts title: Watch the square go[\s\S]*#test/)

    // The square stays near the middle of the vertical frame: brightest column at 1 s and 3.5 s into the Short.
    for (const at of [1, 3.5]) {
      const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', out, '-frames:v', '1', '-vf', 'scale=108:192,format=gray', '-f', 'rawvideo', '-'])
      const cols = new Array(108).fill(0)
      for (let y = 40; y < 120; y++) for (let x = 0; x < 108; x++) cols[x] += raw[y * 108 + x]
      const centre = cols.reduce((s, c, x) => s + c * x, 0) / cols.reduce((s, c) => s + c, 0)
      expect(Math.abs(centre / 108 - 0.5)).toBeLessThan(0.25)
    }
  }, 300000)
})

describe('asking for Shorts', () => {
  it('tells Claude how many, about the recap, and that fewer distinct Shorts beat copies', () => {
    const store = ProjectStore.create(join(mkdtempSync(join(tmpdir(), 'ave-sp-')), 'p'), {
      name: 'x', profileId: 'p1', footageFolder: tmpdir(), settings: ProjectSettingsSchema.parse({}), thumbnails: { personaId: '', styleId: '', count: 1, direction: '' }, appVersion: '1'
    })
    const req = { id: 'r', kind: 'make_shorts', status: 'queued', createdAt: '', text: '', context: { count: 15, recap: true } } as any
    const prompt = buildRunPrompt([req], store.project, { resumed: false })
    expect(prompt).toMatch(/up to 15 highlight Shorts/)
    expect(prompt).toMatch(/kind "recap", about 30 s/)
    expect(prompt).toMatch(/make 7 and say why/)
    expect(buildRunPrompt([{ ...req, context: { redoId: 'short_9', count: 1 }, text: 'start on the crash' }], store.project, { resumed: false })).toMatch(/replace_id "short_9".*start on the crash/s)
  })
})
