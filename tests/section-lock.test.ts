import { afterEach, describe, expect, it } from 'vitest'
import { TimelineResolver } from '@shared/timeline'
import type { Item, SegmentItem } from '@shared/project'
import { ValidationError, type ProjectStore } from '../src/main/project/store'
import { applyUserOp } from '../src/main/project/userOps'
import { cleanupTemps, fakeContext, makeProject, type FakeContext } from './helpers/project'

afterEach(cleanupTemps)

function setup(range = { start: 10, end: 18 }): { store: ProjectStore; ctx: FakeContext; requestId: string } {
  const store = makeProject()
  const ctx = fakeContext({ store })
  const req = ctx.requests.enqueue({ kind: 'reedit', text: 'tighter', range })
  ctx.requests.begin(req.id)
  return { store, ctx, requestId: req.id }
}

const seg = (store: ProjectStore, id: string) => store.project.items.find((i) => i.id === id) as SegmentItem
const item = (store: ProjectStore, id: string) => store.project.items.find((i) => i.id === id) as Item
const startOf = (store: ProjectStore, id: string) => new TimelineResolver(store.project, store.transcript).resolveItem(item(store, id)).start

function claude(store: ProjectStore, fn: Parameters<ProjectStore['mutate']>[2]) {
  return () => store.mutate('Claude change', 'claude', fn)
}

describe('section re-edit lock', () => {
  it('locks the range when Claude begins the request', () => {
    const { store, requestId } = setup()
    expect(store.project.lock).toEqual({ requestId, range: { start: 10, end: 18 } })
  })

  it('rejects A-roll changes before and after the range', () => {
    const { store } = setup()
    expect(claude(store, (d) => { (d.project.items[0] as SegmentItem).out = 9.5 })).toThrow(/A-roll before/)
    expect(claude(store, (d) => { (d.project.items[3] as SegmentItem).in = 32.5 })).toThrow(/A-roll after/)
    expect(claude(store, (d) => { d.project.items.splice(2, 1) })).toThrow(ValidationError)
    expect(seg(store, 'seg_1').out).toBe(10)
    expect(seg(store, 'seg_4').in).toBe(32)
  })

  it('rejects changes to items outside the range', () => {
    const { store } = setup()
    expect(claude(store, (d) => { (d.project.items.find((i) => i.id === 'clip_before') as any).duration = 3 })).toThrow(/outside the section/)
    expect(claude(store, (d) => { d.project.items = d.project.items.filter((i) => i.id !== 'sfx_time') })).toThrow(/cannot be deleted/)
    expect(claude(store, (d) => { (d.project.items.find((i) => i.id === 'music_bed') as any).volume = -10 })).toThrow(/outside the section/)
    expect(
      claude(store, (d) => {
        d.project.items.push({ id: 'new_gfx', trackId: 'graphics', createdBy: 'claude', type: 'graphic', file: 'graphics/n.py', anchor: { kind: 'time', time: 2 }, duration: 1, params: {} })
      })
    ).toThrow(/outside the section/)
    expect(store.project.items.some((i) => i.id === 'new_gfx')).toBe(false)
  })

  it('rejects whole-video changes: tracks and settings', () => {
    const { store } = setup()
    expect(claude(store, (d) => { d.project.tracks[5].volume = -3 })).toThrow(/tracks/)
    expect(claude(store, (d) => { d.project.settings.mix.musicUnderSpeechDb = -20 })).toThrow(/settings/)
    expect(claude(store, (d) => { d.project.captions.enabled = false })).toThrow(/captions/)
  })

  it('accepts changes inside the range', () => {
    const { store } = setup()
    store.mutate('Shorter graphic', 'claude', (d) => { (d.project.items.find((i) => i.id === 'gfx_inside') as any).duration = 1.5 })
    expect((item(store, 'gfx_inside') as any).duration).toBe(1.5)
    store.mutate('New graphic', 'claude', (d) => {
      d.project.items.push({ id: 'gfx_new', trackId: 'graphics', createdBy: 'claude', type: 'graphic', file: 'graphics/n.py', anchor: { kind: 'word', wordId: 'src_a_w30', offset: 0 }, duration: 1, params: {} })
    })
    expect(startOf(store, 'gfx_new')).toBeCloseTo(13)
    // Re-cutting the section itself: drop 14–15 s of source from the middle piece.
    store.mutate('Recut', 'claude', (d) => {
      const i = d.project.items.findIndex((x) => x.id === 'seg_2')
      const s2 = d.project.items[i] as SegmentItem
      d.project.items.splice(i, 1, { ...s2, out: 14 }, { ...s2, id: 'seg_2b', in: 15, out: 20 })
    })
    expect(seg(store, 'seg_2b').in).toBe(15)
  })

  it('a section that shrinks or grows shifts time-anchored items after it; word-anchored items follow', () => {
    const { store } = setup()
    const gfxAfter = startOf(store, 'gfx_after')
    store.mutate('Tighten', 'claude', (d) => { (d.project.items.find((i) => i.id === 'seg_2') as SegmentItem).out = 18 })
    expect(store.project.lock?.range).toEqual({ start: 10, end: 16 })
    expect((item(store, 'sfx_time') as any).anchor.time).toBeCloseTo(28)
    expect(startOf(store, 'gfx_after')).toBeCloseTo(gfxAfter - 2)
    // A-roll after the section plays the same material, just earlier.
    expect(seg(store, 'seg_3')).toMatchObject({ in: 22, out: 30 })

    store.mutate('Loosen', 'claude', (d) => { (d.project.items.find((i) => i.id === 'seg_2') as SegmentItem).out = 21.5 })
    expect(store.project.lock?.range.end).toBeCloseTo(19.5)
    expect((item(store, 'sfx_time') as any).anchor.time).toBeCloseTo(31.5)
    expect(startOf(store, 'gfx_after')).toBeCloseTo(gfxAfter + 1.5)
  })

  it('does not restrict the user while Claude holds the lock', async () => {
    const { store, ctx } = setup()
    await applyUserOp(ctx, store, { op: 'nudgeSegment', id: 'seg_1', edge: 'out', delta: -0.2 })
    expect(seg(store, 'seg_1').out).toBeCloseTo(9.8)
    await applyUserOp(ctx, store, { op: 'deleteItem', id: 'clip_before' })
    expect(store.project.items.some((i) => i.id === 'clip_before')).toBe(false)
    await applyUserOp(ctx, store, { op: 'updateTrack', id: 'music', patch: { volume: -4 } })
    expect(store.project.tracks.find((t) => t.id === 'music')!.volume).toBe(-4)
    expect(ctx.recorded.map((r) => r.kind)).toEqual(['cuts_tighter', 'broll_deleted'])
  })

  it('bookkeeping (chat, requests) is allowed while locked', () => {
    const { store, ctx } = setup()
    ctx.requests.enqueue({ kind: 'chat', text: 'and also this', range: { start: 1, end: 2 } })
    expect(store.project.chat.at(-1)?.text).toBe('and also this')
  })

  it('finish releases the lock and Revert restores the section', () => {
    const { store, ctx, requestId } = setup()
    const before = store.snapshotDoc()
    store.mutate('Tighten', 'claude', (d) => { (d.project.items.find((i) => i.id === 'seg_2') as SegmentItem).out = 17 })
    store.mutate('Graphic', 'claude', (d) => { (d.project.items.find((i) => i.id === 'gfx_inside') as any).params = { text: 'new' } })
    const done = ctx.requests.finish(requestId, 'Tightened the middle')
    expect(done.review).toBe('pending')
    expect(store.project.lock).toBeNull()

    ctx.requests.review(requestId, 'revert')
    expect(store.project.items).toEqual(before.project.items)
    expect(store.transcript).toEqual(before.transcript)
    const req = store.project.requests.find((r) => r.id === requestId)!
    expect(req.review).toBe('reverted')
    expect(req.summary).toBe('Tightened the middle')
    // The restore saved the state it replaced, so the revert itself can be reversed.
    expect(ctx.versions.list().some((v) => v.reason === 'restore')).toBe(true)
  })

  it('Keep leaves the change in place', () => {
    const { store, ctx, requestId } = setup()
    store.mutate('Tighten', 'claude', (d) => { (d.project.items.find((i) => i.id === 'seg_2') as SegmentItem).out = 17 })
    ctx.requests.finish(requestId, 'done')
    ctx.requests.review(requestId, 'keep')
    expect(seg(store, 'seg_2').out).toBe(17)
    expect(store.project.requests.find((r) => r.id === requestId)!.review).toBe('kept')
  })

  it('continue after the intro keeps the approved intro exactly as it is', () => {
    const store = makeProject()
    const ctx = fakeContext({ store })
    const introEnd = 18
    const req = ctx.requests.enqueue({ kind: 'continue_intro', range: { start: introEnd, end: 1e9 } })
    ctx.requests.begin(req.id)
    expect(claude(store, (d) => { (d.project.items[1] as SegmentItem).out = 19 })).toThrow(/A-roll before/)
    expect(claude(store, (d) => { (d.project.items.find((i) => i.id === 'gfx_inside') as any).duration = 1 })).toThrow(/outside the section/)
    store.mutate('More A-roll', 'claude', (d) => {
      d.project.items.push({ id: 'seg_5', trackId: 'aroll', createdBy: 'claude', type: 'segment', sourceId: 'src_a', in: 42, out: 50, speed: 1, volume: 0, fadeIn: 0, fadeOut: 0 })
      ;(d.project.items.find((i) => i.id === 'gfx_after') as any).duration = 1
    })
    expect(new TimelineResolver(store.project, store.transcript).duration).toBeCloseTo(42)
  })
})
