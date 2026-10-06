import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TimelineResolver } from '@shared/timeline'
import { newProfile } from '@shared/settings'
import type { SegmentItem } from '@shared/project'
import { ProjectStore, ValidationError, readJson, writeJsonAtomic } from '../src/main/project/store'
import { applyUserOp } from '../src/main/project/userOps'
import { createCorrectionsService } from '../src/main/services/corrections'
import { cleanupTemps, fakeContext, makeProject, tempDir } from './helpers/project'

afterEach(cleanupTemps)

const gfx = (id: string, trackId = 'graphics') => ({
  id, trackId, createdBy: 'claude' as const, type: 'graphic' as const, file: 'graphics/x.py',
  anchor: { kind: 'time' as const, time: 1 }, duration: 1, params: {}
})

describe('ProjectStore', () => {
  it('undo and redo survive closing and reopening the project', () => {
    const store = makeProject()
    store.mutate('Add graphic', 'claude', (d) => { d.project.items.push(gfx('g1')) })
    store.mutate('Rename', 'user', (d) => { d.project.name = 'Second name' })

    const r1 = ProjectStore.open(store.dir, '1.0.0').store
    expect(r1.project.name).toBe('Second name')
    expect(r1.undoLabel).toBe('Rename')
    expect(r1.undo()).toBe(true)
    expect(r1.project.name).toBe('Test project')

    const r2 = ProjectStore.open(store.dir, '1.0.0').store
    expect(r2.project.name).toBe('Test project')
    expect(r2.redoLabel).toBe('Rename')
    expect(r2.undo()).toBe(true)
    expect(r2.project.items.some((i) => i.id === 'g1')).toBe(false)

    const r3 = ProjectStore.open(store.dir, '1.0.0').store
    expect(r3.redo()).toBe(true)
    expect(r3.redo()).toBe(true)
    expect(r3.project.name).toBe('Second name')
    expect(r3.project.items.some((i) => i.id === 'g1')).toBe(true)
    expect(r3.canRedo).toBe(false)
  })

  it('bookkeeping changes are saved but not undoable', () => {
    const store = makeProject()
    const undoBefore = store.undoLabel
    store.mutate('Chat', 'app', (d) => {
      d.project.chat.push({ id: 'm1', role: 'user', text: 'hi', ts: new Date().toISOString() })
    }, { noHistory: true })
    expect(store.undoLabel).toBe(undoBefore)
    expect(readJson(join(store.dir, 'project.json')).chat).toHaveLength(1)
  })

  it('saves atomically: no temp files left, and a refused change leaves the file untouched', () => {
    const store = makeProject()
    for (let i = 0; i < 5; i++) store.mutate(`n${i}`, 'user', (d) => { d.project.inspiration = `v${i}` })
    const leftovers = (dir: string) => readdirSync(dir).filter((f) => f.includes('.tmp'))
    expect(leftovers(store.dir)).toEqual([])
    expect(leftovers(join(store.dir, 'history'))).toEqual([])
    expect(readJson(join(store.dir, 'project.json')).inspiration).toBe('v4')

    const text = readFileSync(join(store.dir, 'project.json'), 'utf8')
    expect(() => store.mutate('bad', 'user', (d) => { (d.project.items[0] as SegmentItem).out = -1 })).toThrow(ValidationError)
    expect(readFileSync(join(store.dir, 'project.json'), 'utf8')).toBe(text)
    expect(store.project.inspiration).toBe('v4')

    const f = join(tempDir(), 'x.json')
    writeFileSync(f, '{"old":true}')
    writeJsonAtomic(f, { fresh: 1 })
    expect(readJson(f)).toEqual({ fresh: 1 })
    expect(leftovers(join(f, '..'))).toEqual([])
  })

  it('validation rejects bad items', () => {
    const store = makeProject()
    const items = () => store.project.items.length
    const n = items()
    expect(() => store.mutate('x', 'claude', (d) => { d.project.items.push(gfx('g_bad', 'no_such_track')) })).toThrow(/unknown track/)
    expect(() => store.mutate('x', 'claude', (d) => {
      d.project.items.push({ id: 'c', trackId: 'broll', createdBy: 'claude', type: 'clip', sourceId: 'src_missing', anchor: { kind: 'time', time: 0 }, duration: 1, in: 0, speed: 1, volume: -120, fadeIn: 0, fadeOut: 0 })
    })).toThrow(/unknown source/)
    expect(() => store.mutate('x', 'claude', (d) => { const s = d.project.items[1] as SegmentItem; s.out = s.in - 1 })).toThrow(/out must be after in/)
    expect(() => store.mutate('x', 'claude', (d) => { d.project.items.push(gfx('seg_1')) })).toThrow(/duplicate item id/)
    expect(() => store.mutate('x', 'claude', (d) => { (d.project.items[0] as any).trackId = 'broll' })).toThrow(/A-roll track/)
    expect(() => store.mutate('x', 'claude', (d) => { (d.project.items[5] as any).duration = -2 })).toThrow(ValidationError)
    expect(() => store.mutate('x', 'claude', (d) => { (d.project as any).status = 'nonsense' })).toThrow(ValidationError)
    expect(() => store.mutate('x', 'claude', (d) => {
      d.project.items.push({ id: 'a1', trackId: 'sfx', createdBy: 'claude', type: 'audio', anchor: { kind: 'time', time: 0 }, duration: 1, in: 0, volume: 0, fadeIn: 0, fadeOut: 0, duck: false, loop: false })
    })).toThrow(/needs a sourceId or a file/)
    expect(items()).toBe(n)
  })

  it('keeps unknown fields on items, the project and the transcript when saving', () => {
    const store = makeProject()
    store.mutate('Extras', 'claude', (d) => {
      ;(d.project as any).claudeMemo = { plan: ['a', 'b'] }
      ;(d.project.items[0] as any).takeScore = 0.92
      ;(d.project.tracks[0] as any).lane = { color: 'red' }
      ;(d.transcript as any).engine = 'faster-whisper'
    })
    store.mutate('Other change', 'user', (d) => { d.project.inspiration = 'x' })
    const reopened = ProjectStore.open(store.dir, '1.0.0').store
    expect((reopened.project as any).claudeMemo).toEqual({ plan: ['a', 'b'] })
    expect((reopened.project.items[0] as any).takeScore).toBe(0.92)
    expect((reopened.project.tracks[0] as any).lane).toEqual({ color: 'red' })
    expect((reopened.transcript as any).engine).toBe('faster-whisper')
  })
})

describe('manual tweaks', () => {
  const setup = () => {
    const store = makeProject()
    const ctx = fakeContext({ store })
    return { store, ctx, r: () => new TimelineResolver(store.project, store.transcript) }
  }
  const find = (store: ProjectStore, id: string) => store.project.items.find((i) => i.id === id) as any

  it('moving an item anchors it to the word at its new start', async () => {
    const { store, ctx, r } = setup()
    await applyUserOp(ctx, store, { op: 'moveItem', id: 'gfx_inside', start: 21.3 })
    expect(find(store, 'gfx_inside').anchor.kind).toBe('word')
    expect(r().resolveItem(find(store, 'gfx_inside')).start).toBeCloseTo(21.3, 3)
    // Music stays pinned to the timeline.
    await applyUserOp(ctx, store, { op: 'moveItem', id: 'music_bed', start: 2 })
    expect(find(store, 'music_bed').anchor).toEqual({ kind: 'time', time: 2 })
  })

  it('trimming the start edge moves the anchor and shortens; the end edge changes the length', async () => {
    const { store, ctx, r } = setup()
    await applyUserOp(ctx, store, { op: 'trimItem', id: 'clip_before', edge: 'start', time: 2.5 })
    const clip = find(store, 'clip_before')
    expect(r().resolveItem(clip).start).toBeCloseTo(2.5)
    expect(clip.duration).toBeCloseTo(1.5)
    expect(clip.in).toBeCloseTo(50.5)
    await applyUserOp(ctx, store, { op: 'trimItem', id: 'gfx_inside', edge: 'end', time: 13 })
    expect(find(store, 'gfx_inside').duration).toBeCloseTo(1)
    expect(ctx.recorded.map((x) => x.kind)).toEqual(['broll_shorter', 'graphics_shorter'])
  })

  it('nudging a cut clamps to the source and keeps out after in', async () => {
    const { store, ctx } = setup()
    await applyUserOp(ctx, store, { op: 'nudgeSegment', id: 'seg_1', edge: 'in', delta: -5 })
    expect(find(store, 'seg_1').in).toBe(0)
    await applyUserOp(ctx, store, { op: 'nudgeSegment', id: 'seg_1', edge: 'out', delta: -50 })
    expect(find(store, 'seg_1').out).toBeGreaterThan(find(store, 'seg_1').in)
    await applyUserOp(ctx, store, { op: 'nudgeSegment', id: 'seg_4', edge: 'out', delta: 500 })
    expect(find(store, 'seg_4').out).toBe(100)
    expect(ctx.recorded.map((x) => x.kind)).toEqual(['cuts_tighter', 'cuts_looser'])
  })

  it('edits words, emphasis, tracks and project parts, and logs before and after', async () => {
    const { store, ctx } = setup()
    await applyUserOp(ctx, store, { op: 'editWord', wordId: 'src_a_w3', text: 'LiPo' })
    await applyUserOp(ctx, store, { op: 'setEmphasis', wordId: 'src_a_w3', emphasis: true })
    expect(store.transcript.clips.src_a.words[3]).toMatchObject({ text: 'LiPo', edited: true, emphasis: true })
    await applyUserOp(ctx, store, { op: 'addTrack', kind: 'sfx' })
    await applyUserOp(ctx, store, { op: 'addTrack', kind: 'sfx' })
    expect(store.project.tracks.map((t) => t.id).slice(-3)).toEqual(['sfx', 'sfx_2', 'sfx_3'])
    await applyUserOp(ctx, store, { op: 'updateItem', id: 'music_bed', patch: { volume: -12 } })
    await applyUserOp(ctx, store, { op: 'patchProject', path: 'captions', patch: { enabled: false } })
    expect(store.project.captions.enabled).toBe(false)
    expect(ctx.recorded.map((x) => x.kind)).toEqual(['music_quieter', 'captions_off'])
    const tweak = store.log.read().filter((e) => e.cat === 'tweak').at(-2)!
    expect(tweak.data).toMatchObject({ before: { volume: -6 }, after: { volume: -12 } })
    expect(() => store.undo()).not.toThrow()
    expect(store.project.captions.enabled).toBe(true)
  })

  it('a bad tweak is refused and nothing changes', async () => {
    const { store, ctx } = setup()
    await expect(applyUserOp(ctx, store, { op: 'updateItem', id: 'gfx_inside', patch: { trackId: 'nope' } })).rejects.toThrow(/unknown track/)
    expect(find(store, 'gfx_inside').trackId).toBe('graphics')
  })
})

describe('learned corrections', () => {
  it('suggests after two different projects, and only a yes makes a rule', () => {
    const ctx = fakeContext({ profiles: [newProfile('p1', 'RC')] })
    const corrections = createCorrectionsService(ctx)
    corrections.record('music_quieter', 'prj_a', 'p1')
    corrections.record('music_quieter', 'prj_a', 'p1')
    expect(corrections.suggestions()).toEqual([])
    corrections.record('music_quieter', 'prj_b', 'p1')
    expect(corrections.suggestions()).toEqual([{ profileId: 'p1', kind: 'music_quieter', text: 'Keep music quieter under speech on this channel?' }])
    expect(ctx.sent.filter((s) => s.channel === 'profiles:suggestion')).toHaveLength(1)
    expect(ctx.profiles.get('p1')!.rules).toEqual([])

    corrections.answer('p1', 'music_quieter', true)
    const rules = ctx.profiles.get('p1')!.rules
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ text: 'Keep music quieter under speech.', source: 'learned', enabled: true })
    expect(corrections.suggestions()).toEqual([])
  })

  it('a dismissed kind is not suggested again', () => {
    const ctx = fakeContext({ profiles: [newProfile('p1', 'RC')] })
    const corrections = createCorrectionsService(ctx)
    corrections.record('sfx_deleted', 'a', 'p1')
    corrections.record('sfx_deleted', 'b', 'p1')
    corrections.answer('p1', 'sfx_deleted', false)
    corrections.record('sfx_deleted', 'c', 'p1')
    corrections.record('sfx_deleted', 'd', 'p1')
    expect(corrections.suggestions()).toEqual([])
    expect(ctx.profiles.get('p1')!.rules).toEqual([])
    expect(ctx.sent.filter((s) => s.channel === 'profiles:suggestion')).toHaveLength(1)
  })
})
