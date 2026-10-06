import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProjectSchema, defaultChecklist, defaultTracks, emptyTranscript, type ProjectDoc } from '@shared/project'
import { buildPlan } from '../src/main/engine/plan'
import { audioHash, chunkRanges, previewChunks } from '../src/main/engine/preview'

let dir: string
let footage: string
let graphic: string
let otherGraphic: string

function makeDoc(items: unknown[]): ProjectDoc {
  const project = ProjectSchema.parse({
    formatVersion: 2,
    id: 'prj_test',
    name: 'Chunk test',
    createdAt: '2026-10-06T00:00:00Z',
    updatedAt: '2026-10-06T00:00:00Z',
    appVersion: '0.9.0',
    engineVersion: '1.0.0',
    profileId: 'p1',
    footageFolder: dir,
    scope: {},
    output: { width: 1920, height: 1080, fps: 30 },
    settings: {},
    sources: [{ id: 'src1', path: footage, kind: 'video', duration: 20, width: 1920, height: 1080, fps: 30, hasAudio: true }],
    transcript: { file: 'transcript.json' },
    tracks: defaultTracks(),
    items,
    checklist: defaultChecklist(),
    captions: { enabled: false },
    thumbnails: {},
    publish: {}
  })
  return { project, transcript: emptyTranscript() }
}

const segment = { id: 'seg1', type: 'segment', trackId: 'aroll', sourceId: 'src1', in: 0, out: 10 }
const title = (start: number, params: Record<string, unknown> = { text: 'Hello' }, file = graphic) => ({
  id: 'gfx1',
  type: 'graphic',
  trackId: 'graphics',
  anchor: { kind: 'time', time: start },
  duration: 2,
  file,
  params
})

function hashes(doc: ProjectDoc): string[] {
  const plan = buildPlan(doc, { projectDir: dir, width: 960, height: 540, fps: 30, burnCaptions: true })
  return previewChunks(plan).map((c) => c.hash)
}

function changed(a: string[], b: string[]): number[] {
  const out: number[] = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(i)
  return out
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ave-chunks-'))
  footage = join(dir, 'clip.mp4')
  graphic = join(dir, 'title.py')
  otherGraphic = join(dir, 'other.py')
  writeFileSync(footage, 'not really a video, only its size and time matter here')
  writeFileSync(graphic, 'def render(t, ctx):\n    return None\n')
  writeFileSync(otherGraphic, 'def render(t, ctx):\n    return 1\n')
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('preview chunk hashing', () => {
  it('cuts the timeline into 2-second chunks on whole frames', () => {
    expect(chunkRanges(10, 30)).toEqual([
      { index: 0, start: 0, end: 2 },
      { index: 1, start: 2, end: 4 },
      { index: 2, start: 4, end: 6 },
      { index: 3, start: 6, end: 8 },
      { index: 4, start: 8, end: 10 }
    ])
    const odd = chunkRanges(5.01, 30)
    expect(odd).toHaveLength(3)
    expect(odd[2].end).toBeCloseTo(150 / 30)
    expect(chunkRanges(0, 30)).toEqual([])
  })

  it('is stable when nothing changes', () => {
    const doc = makeDoc([segment, title(3)])
    expect(hashes(doc)).toEqual(hashes(makeDoc([segment, title(3)])))
    expect(new Set(hashes(doc)).size).toBe(5)
  })

  it('a change to one item only invalidates the chunks it overlaps', () => {
    const before = hashes(makeDoc([segment, title(3)]))
    // The graphic covers 3..5, so chunks 1 (2..4) and 2 (4..6) change.
    expect(changed(before, hashes(makeDoc([segment, title(3, { text: 'Changed' })])))).toEqual([1, 2])
    // Moving it to 6.5..8.5 touches the chunks it left and the ones it entered.
    expect(changed(before, hashes(makeDoc([segment, title(6.5)])))).toEqual([1, 2, 3, 4])
    // Pointing at another code file changes the same chunks only.
    expect(changed(before, hashes(makeDoc([segment, title(3, { text: 'Hello' }, otherGraphic)])))).toEqual([1, 2])
  })

  it('a graphic file edit invalidates its chunks, and only those', () => {
    const doc = makeDoc([segment, title(3)])
    const before = hashes(doc)
    writeFileSync(graphic, 'def render(t, ctx):\n    return "edited"\n')
    expect(changed(before, hashes(doc))).toEqual([1, 2])
  })

  it('footage that changes on disk invalidates every chunk showing it', () => {
    const doc = makeDoc([segment, title(3)])
    const before = hashes(doc)
    const later = new Date(Date.now() + 60_000)
    utimesSync(footage, later, later)
    expect(changed(before, hashes(doc))).toEqual([0, 1, 2, 3, 4])
  })

  it('a time-warp effect makes its chunks depend on all footage', () => {
    const freeze = { id: 'fx1', type: 'effect', trackId: 'effects', effect: 'replay', anchor: { kind: 'time', time: 8.5 }, duration: 1 }
    const broll = (t: number) => ({ id: 'b1', type: 'clip', trackId: 'broll', file: footage, anchor: { kind: 'time', time: t }, duration: 1 })
    const before = hashes(makeDoc([segment, broll(0.5), freeze]))
    // B-roll moves inside chunk 0: chunk 0 changes, and the replay chunk (4) too, since it can show it.
    expect(changed(before, hashes(makeDoc([segment, broll(0.8), freeze])))).toEqual([0, 4])
  })

  it('audio changes leave picture chunks alone but change the audio hash', () => {
    const doc = makeDoc([segment, title(3)])
    const louder = makeDoc([{ ...segment, volume: -6 }, title(3)])
    const planA = buildPlan(doc, { projectDir: dir, width: 960, height: 540, fps: 30, burnCaptions: true })
    const planB = buildPlan(louder, { projectDir: dir, width: 960, height: 540, fps: 30, burnCaptions: true })
    expect(changed(hashes(doc), hashes(louder))).toEqual([])
    expect(audioHash(planA)).not.toEqual(audioHash(planB))
    // Output size changes picture, never the mix: preview and export share the measured loudness.
    const big = buildPlan(doc, { projectDir: dir, width: 3840, height: 2160, fps: 60, burnCaptions: true })
    expect(audioHash(big)).toEqual(audioHash(planA))
  })

  it('a different output size or engine version re-renders everything', () => {
    const doc = makeDoc([segment, title(3)])
    const a = buildPlan(doc, { projectDir: dir, width: 960, height: 540, fps: 30, burnCaptions: true })
    const b = buildPlan(doc, { projectDir: dir, width: 1280, height: 720, fps: 30, burnCaptions: true })
    const c = { ...a, engineVersion: '1.0.1' }
    const ha = previewChunks(a).map((x) => x.hash)
    expect(changed(ha, previewChunks(b).map((x) => x.hash))).toEqual([0, 1, 2, 3, 4])
    expect(changed(ha, previewChunks(c).map((x) => x.hash))).toEqual([0, 1, 2, 3, 4])
  })
})
