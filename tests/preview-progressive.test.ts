/**
 * The first preview of a longer video can be watched while it renders, and changes made while a preview renders
 * no longer throw the render away. Real engine; skipped when it is not available.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ProjectSettingsSchema, type Item } from '@shared/project'
import type { PreviewState } from '@shared/ipc'
import type { AppContext } from '../src/main/context'
import { ActivityLog } from '../src/main/log'
import { ProjectStore } from '../src/main/project/store'
import { createEngineService } from '../src/main/engine/engine'
import { createPreviewService } from '../src/main/engine/preview'

const ENGINE_DIR = resolve('engine')
const ok = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  } catch {
    return false
  }
  return spawnSync('python3', ['-m', 'ave_engine', '--ffmpeg', 'ffmpeg', '--ffprobe', 'ffprobe', 'check'], { cwd: ENGINE_DIR, encoding: 'utf8', timeout: 120000 }).status === 0
})()

let root: string | undefined
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!ok)('the preview while it renders', () => {
  it('plays the start of the first preview early, and finishes a render that changes interrupt', async () => {
    root = mkdtempSync(join(tmpdir(), 'ave-prog-'))
    const clip = join(root, 'clip.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=30', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=30:sample_rate=48000',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip])
    const store = ProjectStore.create(join(root, 'project'), {
      name: 'Progressive', profileId: 'p1', footageFolder: root, settings: ProjectSettingsSchema.parse({}),
      thumbnails: { personaId: '', styleId: '', count: 1, direction: '' }, appVersion: '1'
    })
    store.mutate('setup', 'claude', (d) => {
      d.project.output = { width: 640, height: 360, fps: 30 }
      d.project.sources.push({ id: 'src1', path: clip, kind: 'video', duration: 30, width: 640, height: 360, fps: 30, hasAudio: true, origin: 'footage' })
      d.project.items.push({ id: 'seg1', type: 'segment', trackId: 'aroll', sourceId: 'src1', in: 0, out: 30, speed: 1, volume: 0, fadeIn: 0, fadeOut: 0, createdBy: 'claude' } as Item)
    })
    const ctx = {
      appVersion: '1', isPackaged: false, appLog: new ActivityLog(join(root, 'app.log')),
      settings: { get: () => ({ previewHeight: 180, previewFps: 30 }) },
      env: {
        python: () => 'python3', ffmpeg: () => 'ffmpeg', ffprobe: () => 'ffprobe', engineDir: () => ENGINE_DIR,
        status: async () => ({ gpu: { ok: true, message: '' }, python: { ok: true, installing: false, message: '' }, ffmpeg: { ok: true, nvenc: false, message: '' } })
      },
      projects: { current: () => store, missingSources: () => [] },
      send: () => undefined
    } as unknown as AppContext
    ctx.engine = createEngineService(ctx)
    const preview = createPreviewService(ctx)
    const states: PreviewState[] = []
    preview.onState((s) => states.push({ ...s }))
    preview.invalidate()
    // A change soon after the build starts used to cancel it.
    await new Promise((r) => setTimeout(r, 1500))
    store.mutate('quieter', 'user', (d) => {
      ;(d.project.items[0] as { volume: number }).volume = -3
    })
    preview.invalidate()
    const until = Date.now() + 240000
    while (Date.now() < until && !(states.at(-1)?.status === 'ready' && !preview.isBusy())) await new Promise((r) => setTimeout(r, 200))

    const partial = states.find((s) => s.status === 'rendering' && s.partialUntil)
    expect(partial?.partialUntil).toBeGreaterThanOrEqual(8)
    expect(partial?.file).toMatch(/preview-partial-/)
    const last = states.at(-1)!
    expect(last.status).toBe('ready')
    expect(last.partialUntil).toBeUndefined()
    expect(existsSync(last.file!)).toBe(true)
    // The first build finished its picture, so the second only re-mixed the sound: no chunk rendered twice.
    const log = readFileSync(store.log.file, 'utf8')
    const updates = [...log.matchAll(/Preview updated: (\d+) of (\d+) chunks/g)].map((m) => Number(m[1]))
    expect(updates[0]).toBe(15)
    expect(updates.slice(1).every((n) => n === 0)).toBe(true)
  }, 300000)
})
