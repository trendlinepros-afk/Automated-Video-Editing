/**
 * The footage index: built once per file in the background and kept in the project folder, rebuilt when the file
 * changes; shots mapped to where they are on the timeline; find_shots filtering and ranking; the shot sheet; and a
 * real run of engine/analysis/index_footage.py through the service when Python with OpenCV is available.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Item } from '@shared/project'
import { TimelineResolver } from '@shared/timeline'
import type { AppContext } from '../src/main/context'
import type { ProjectStore } from '../src/main/project/store'
import {
  createFootageIndexService,
  findShots,
  indexKey,
  shotLook,
  shotUses,
  usableRange,
  type FootageIndex,
  type FootageIndexService,
  type IndexRunner,
  type IndexedShot
} from '../src/main/services/footageIndex'
import { footageTools } from '../src/main/mcp/tools/footage'
import type { ToolEnv, ToolResult } from '../src/main/mcp/tools/common'
import { WORKFLOW } from '../src/main/runner/prompts'
import { cleanupTemps, makeProject, tempDir } from './helpers/project'

afterEach(() => cleanupTemps())

function shot(index: number, start: number, end: number, o: Partial<IndexedShot> = {}): IndexedShot {
  return {
    index, start, end, boundary: index === 1 ? 'start' : 'cut', sharpness: 300, sharpRel: 1, motion: 0.01, cameraMove: 0, shake: 0.002,
    brightness: 0.5, colors: ['#336699'], faces: 0, faceShare: 0, subject: null, best: start + (end - start) / 2, thumb: `shot${index}.jpg`, ...o
  }
}

function fakeIndex(shots: IndexedShot[], o: Partial<FootageIndex> = {}): FootageIndex {
  const duration = shots.length ? shots[shots.length - 1].end : 0
  return { version: 1, duration, width: 1920, height: 1080, fps: 4, frames: duration * 4, hasAudio: true, facesChecked: true, shots, audio: { step: 1, db: [] }, seconds: 1, ...o }
}

/** A fake analysis that records each call and writes one picture per shot, as the script does. */
function fakeRunner(make: (video: string) => FootageIndex = () => fakeIndex([shot(1, 0, 5), shot(2, 5, 9)])) {
  const calls: string[] = []
  const run: IndexRunner = async ({ video, outDir, onProgress }) => {
    calls.push(video)
    onProgress(50)
    const idx = make(video)
    for (const s of idx.shots) if (s.thumb) writeFileSync(join(outDir, s.thumb), 'jpg')
    return idx
  }
  return { calls, run }
}

function fakeCtx(store: ProjectStore, o: { busy?: () => boolean } = {}): AppContext {
  const listeners: ((s: ProjectStore | null) => void)[] = []
  return {
    projects: { current: () => store, onOpened: (cb: (s: ProjectStore | null) => void) => (listeners.push(cb), () => undefined), missingSources: () => [] },
    renders: { isBusy: o.busy ?? (() => false) },
    env: { python: () => 'python3', ffmpeg: () => 'ffmpeg', analysisScript: () => resolve('engine/analysis/style.py') }
  } as unknown as AppContext
}

/** A project whose source file exists (the index keys on its size and time). */
function projectWithFile(): { store: ProjectStore; file: string } {
  const store = makeProject()
  const file = store.project.sources[0].path
  writeFileSync(file, 'x'.repeat(1000))
  return { store, file }
}

describe('footage index service', () => {
  it('indexes each video once, keeps the result in the project folder and reuses it after reopening', async () => {
    const { store, file } = projectWithFile()
    const fake = fakeRunner()
    const svc = createFootageIndexService(fakeCtx(store), { run: fake.run })
    svc.start()
    await svc.idle()
    expect(fake.calls).toEqual([file])
    const key = indexKey(store.project.sources[0])!
    expect(key).toMatch(/^src_a-1000-\d+$/)
    expect(existsSync(join(store.paths.cache, 'index', `${key}.json`))).toBe(true)
    expect(existsSync(join(store.paths.cache, 'index', key, 'shot1.jpg'))).toBe(true)
    expect(svc.get('src_a')!.index.shots).toHaveLength(2)
    expect(svc.status()).toMatchObject({ running: false, done: 1, total: 1, failed: [] })

    // The app opens the project again: nothing is analysed twice.
    const again = fakeRunner()
    const svc2 = createFootageIndexService(fakeCtx(store), { run: again.run })
    svc2.start()
    await svc2.idle()
    expect(again.calls).toEqual([])
    expect(svc2.get('src_a')!.key).toBe(key)
  })

  it('indexes the file again when it changes, and removes the old index', async () => {
    const { store, file } = projectWithFile()
    const fake = fakeRunner()
    const svc = createFootageIndexService(fakeCtx(store), { run: fake.run })
    svc.start()
    await svc.idle()
    const oldKey = svc.get('src_a')!.key
    appendFileSync(file, 'more')
    utimesSync(file, new Date(), new Date(Date.now() + 5000))
    expect(svc.get('src_a')).toBeNull() // the old index no longer describes the file
    svc.refresh()
    await svc.idle()
    expect(fake.calls).toHaveLength(2)
    expect(svc.get('src_a')!.key).not.toBe(oldKey)
    expect(readdirSync(join(store.paths.cache, 'index')).filter((n) => n.startsWith(oldKey))).toEqual([])
  })

  it('picks up footage added later, skips files that are not video or missing, and does not retry a failure', async () => {
    const { store } = projectWithFile()
    const fake = fakeRunner((video) => {
      if (video.endsWith('broken.mp4')) throw new Error('ffmpeg could not read the video')
      return fakeIndex([shot(1, 0, 3)])
    })
    const svc = createFootageIndexService(fakeCtx(store), { run: fake.run })
    svc.start()
    await svc.idle()
    const dir = store.dir
    for (const n of ['B001.mp4', 'broken.mp4', 'song.wav']) writeFileSync(join(dir, n), 'data')
    store.mutate('Add footage', 'claude', (d) => {
      d.project.sources.push({ id: 'src_b', path: join(dir, 'B001.mp4'), kind: 'video', duration: 3, hasAudio: false, origin: 'footage' })
      d.project.sources.push({ id: 'src_x', path: join(dir, 'broken.mp4'), kind: 'video', duration: 3, hasAudio: false, origin: 'footage' })
      d.project.sources.push({ id: 'src_m', path: join(dir, 'song.wav'), kind: 'audio', duration: 3, hasAudio: true, origin: 'music' })
      d.project.sources.push({ id: 'src_gone', path: join(dir, 'gone.mp4'), kind: 'video', duration: 3, hasAudio: false, origin: 'footage' })
    })
    await svc.idle()
    expect(fake.calls.map((c) => c.slice(dir.length + 1))).toEqual(['A001.mp4', 'B001.mp4', 'broken.mp4'])
    expect(svc.get('src_b')).not.toBeNull()
    expect(svc.get('src_m')).toBeNull()
    const st = svc.status()
    expect(st).toMatchObject({ done: 2, total: 3 })
    expect(st.failed).toEqual([{ sourceId: 'src_x', name: 'broken.mp4', error: 'ffmpeg could not read the video' }])
    svc.refresh()
    await svc.idle()
    expect(fake.calls).toHaveLength(3)
  })

  it('waits while an export is rendering', async () => {
    const { store } = projectWithFile()
    let busy = true
    const fake = fakeRunner()
    const svc = createFootageIndexService(fakeCtx(store, { busy: () => busy }), { run: fake.run, pollMs: 5 })
    svc.start()
    await new Promise((r) => setTimeout(r, 30))
    expect(fake.calls).toHaveLength(0)
    expect(svc.status().running).toBe(true)
    busy = false
    await svc.idle()
    expect(fake.calls).toHaveLength(1)
  })
})

describe('reading the index', () => {
  it('maps a stretch of a source to the A-roll pieces and B-roll clips that use it', () => {
    const store = makeProject()
    const r = new TimelineResolver(store.project, store.transcript)
    // A-roll: source 0-10 plays at 0-10, source 12-20 at 10-18.
    expect(shotUses(r, 'src_a', 8, 14)).toEqual([
      { as: 'aroll', itemId: 'seg_1', start: 8, end: 10 },
      { as: 'aroll', itemId: 'seg_2', start: 10, end: 12 }
    ])
    // Source 10-12 was cut.
    expect(shotUses(r, 'src_a', 10.2, 11.8)).toEqual([])
    // B-roll clip_before shows source 50-52 at timeline 2-4 (anchored to the word at 2.0).
    expect(shotUses(r, 'src_a', 49, 51)).toEqual([{ as: 'broll', itemId: 'clip_before', start: 2, end: 3 }])
    expect(shotUses(r, 'src_other', 0, 100)).toEqual([])
  })

  it('describes shots in plain words and keeps the usable part clear of cuts', () => {
    expect(shotLook(shot(1, 0, 4, { sharpness: 500, sharpRel: 1.2, shake: 0.03, motion: 0.05, brightness: 0.1, faces: 1, faceShare: 0.08, audioPeakDb: -6 }), true))
      .toEqual({ detail: 'sharp', camera: 'shaky', motion: 'action', light: 'dark', faces: 'close', loud: true })
    expect(shotLook(shot(1, 0, 4, { sharpness: 8, cameraMove: 0.2 }), false)).toMatchObject({ detail: 'flat', camera: 'moving', faces: 'unknown' })
    const idx = fakeIndex([shot(1, 0, 4), shot(2, 4, 9), shot(3, 9, 12, { boundary: 'length' })])
    expect(usableRange(idx, idx.shots[0])).toEqual({ in: 0, out: 3.7 })
    expect(usableRange(idx, idx.shots[1])).toEqual({ in: 4.3, out: 9 })
    expect(usableRange(idx, idx.shots[2])).toEqual({ in: 9, out: 12 })
  })

  it('find_shots filters and ranks: steady, sharp, faces, unused footage, near a moment', () => {
    const store = makeProject()
    const r = new TimelineResolver(store.project, store.transcript)
    const a = { source: store.project.sources[0], entry: { sourceId: 'src_a', key: 'k', thumbs: '', index: fakeIndex([
      shot(1, 0, 6),                                                    // on the timeline (seg_1)
      shot(2, 60, 66, { sharpRel: 1.3, sharpness: 600 }),               // unused, sharp, steady: the best
      shot(3, 66, 70, { shake: 0.04 }),                                 // shaky
      shot(4, 70, 71, { sharpness: 20, sharpRel: 0.2 }),                // soft and short
      shot(5, 80, 86, { faces: 1, faceShare: 0.1, brightness: 0.15 }),  // a close face, dark
      shot(6, 90, 96, { motion: 0.06, audioPeakDb: -4 })                // action with a loud bang
    ]) } }
    const ids = (q: Parameters<typeof findShots>[2]) => findShots([a], r, q).map((c) => c.shot)
    expect(ids({ limit: 2 })).toEqual(['src_a#2', 'src_a#1'])
    expect(ids({ steady: true, sharp: true, not_on_timeline: true, min_seconds: 3 })).toEqual(['src_a#2', 'src_a#6', 'src_a#5'])
    expect(ids({ steady: false })).toEqual(['src_a#3'])
    expect(ids({ faces: 'close' })).toEqual(['src_a#5'])
    expect(ids({ faces: 'none', bright: true }).includes('src_a#5')).toBe(false)
    expect(ids({ motion: 'action', loud: true })).toEqual(['src_a#6'])
    // Near timeline 3.0 (source 3.0 in seg_1): the shot playing there comes first even though #2 is sharper.
    expect(ids({ near_time: 3, limit: 1 })).toEqual(['src_a#1'])
    const first = findShots([a], r, { limit: 1 })[0]
    expect(first).toMatchObject({ source_id: 'src_a', file: 'A001.mp4', use: { in: 60.3, out: 65.7 }, best: 63, on_timeline: [] })
    const onTl = findShots([a], r, { near_time: 3, limit: 1 })[0]
    expect(onTl.best_on_timeline).toBe(3)
    expect(onTl.on_timeline).toEqual([{ as: 'aroll', itemId: 'seg_1', start: 0, end: 6 }])
  })
})

describe('footage tools', () => {
  async function setup(sheet?: FootageIndexService['sheet']) {
    const { store } = projectWithFile()
    const fake = fakeRunner(() => fakeIndex([shot(1, 0, 6), shot(2, 60, 66, { sharpRel: 1.4 }), shot(3, 66, 70, { shake: 0.04 })], { audio: { step: 1, db: [-30, -8, -30, -30, -2] } }))
    const ctx = fakeCtx(store)
    const svc = createFootageIndexService(ctx, { run: fake.run, ...(sheet ? { sheet } : {}) })
    ;(ctx as { footage: FootageIndexService }).footage = svc
    svc.start()
    await svc.idle()
    const env = { ctx, store, dir: store.dir, mutate: () => undefined, resolver: () => new TimelineResolver(store.project, store.transcript) } as unknown as ToolEnv
    const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
      const tool = footageTools.find((t) => t.name === name)!
      const { z } = await import('zod')
      return tool.run(z.object(tool.input).parse(args), env)
    }
    return { store, svc, call }
  }
  const textOf = (r: ToolResult) => JSON.parse((r.content[0] as { text: string }).text)

  it('get_footage_index summarises each file, then lists its shots one line each', async () => {
    const { call } = await setup()
    const summary = textOf(await call('get_footage_index', {}))
    expect(summary.indexing).toBeUndefined()
    expect(summary.sources).toEqual([{ source_id: 'src_a', file: 'A001.mp4', status: 'indexed', duration: 70, shots: 3, sharp: 3, steady: 2, shaky: 1, action: 0, with_faces: 0, dark: 0, on_timeline: 1 }])
    const one = textOf(await call('get_footage_index', { source_id: 'src_a' }))
    expect(one.shots[0]).toBe('#1 0.0-6.0 (6.0s) best 3 | sharp steady some no face | #336699 | on timeline 0.0-6.0 aroll')
    expect(one.shots[2]).toContain('shaky')
    expect(one.loudest_seconds).toEqual([{ time: 1, db: -8 }, { time: 4, db: -2 }])
    const found = textOf(await call('find_shots', { not_on_timeline: true, steady: true }))
    expect(found.candidates.map((c: { shot: string }) => c.shot)).toEqual(['src_a#2'])
  })

  it('get_shot_sheet sends the pictures of the chosen shots, numbered, as one image', async () => {
    const sheets: { path: string; label: string }[][] = []
    const { call } = await setup(async (items, out) => {
      sheets.push(items)
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=gray:s=64x36', '-frames:v', '1', out])
      return out
    })
    const res = await call('get_shot_sheet', { shot_ids: ['src_a#2', 'src_a#1'] })
    expect(sheets[0].map((i) => i.path.split(/[\\/]/).pop())).toEqual(['shot2.jpg', 'shot1.jpg'])
    expect(sheets[0][0].label).toMatch(/^1:03/)
    expect((res.content[0] as { text: string }).text).toContain('1: src_a#2 A001.mp4 60.0-66.0s, best 63s')
    expect(res.content[1]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' })
    const page = await call('get_shot_sheet', { source_id: 'src_a' })
    expect(sheets[1]).toHaveLength(3)
    expect(page.content).toHaveLength(2)
    await expect(call('get_shot_sheet', { shot_ids: ['src_a#9'] })).rejects.toThrow(/has 3 shots/)
    await expect(call('get_shot_sheet', { shot_ids: ['nonsense'] })).rejects.toThrow(/not a shot id/)
  })

  it('the workflow tells Claude to choose from the index and confirm with one frame', () => {
    expect(WORKFLOW).toMatch(/find_shots.*get_shot_sheet.*get_frame only to confirm/s)
  })
})

function pythonWithOpenCv(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    execFileSync('python3', ['-c', 'import cv2, numpy, PIL'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!pythonWithOpenCv())('the real analysis through the service', () => {
  it('indexes a generated clip with a cut and draws a shot sheet', async () => {
    const store = makeProject()
    const clip = join(tempDir(), 'cut.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3', '-f', 'lavfi', '-i', 'color=0x3060c0:s=640x360:r=30:d=3',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]', '-map', '[v]', '-c:v', 'libx264', clip])
    store.mutate('footage', 'claude', (d) => {
      d.project.sources[0] = { ...d.project.sources[0], path: clip, duration: 6 }
      d.project.items = d.project.items.filter((i: Item) => i.type !== 'clip')
    })
    const ctx = fakeCtx(store)
    const svc = createFootageIndexService(ctx)
    svc.start()
    await svc.idle()
    expect(svc.status().failed).toEqual([])
    const e = svc.get('src_a')!
    expect(e.index.shots.map((s) => [s.start, s.end, s.boundary])).toEqual([[0, 3, 'start'], [3, 6, 'cut']])
    const out = join(store.dir, 'sheet.jpg')
    await svc.sheet(e.index.shots.map((s) => ({ path: join(e.thumbs, s.thumb!), label: `#${s.index}` })), out)
    expect(existsSync(out)).toBe(true)
  }, 60000)
})
