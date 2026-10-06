import { describe, expect, it } from 'vitest'
import { ProjectSchema, defaultChecklist, defaultTracks, type Project, type Transcript } from '@shared/project'
import { TimelineResolver, buildCaptions, findTimeRange, parseTime } from '@shared/timeline'
import { buildSrt, chapterLines } from '@shared/captions'

function project(items: unknown[]): Project {
  return ProjectSchema.parse({
    formatVersion: 2,
    id: 'p',
    name: 'T',
    createdAt: '',
    updatedAt: '',
    appVersion: '1.0.0',
    engineVersion: '1.0.0',
    profileId: 'x',
    footageFolder: '/f',
    scope: {},
    output: { width: 3840, height: 2160, fps: 60 },
    settings: {},
    sources: [{ id: 'a', path: '/f/a.mp4', kind: 'video', duration: 60, hasAudio: true }],
    transcript: {},
    tracks: defaultTracks(),
    items,
    checklist: defaultChecklist(),
    captions: {},
    thumbnails: {},
    publish: { chapters: [{ id: 'c1', title: 'Second part', anchor: { kind: 'word', wordId: 'w4', offset: 0 } }] }
  })
}

const transcript: Transcript = {
  formatVersion: 1,
  clips: {
    a: {
      words: [
        { id: 'w0', text: 'Hello', start: 1.0, end: 1.4 },
        { id: 'w1', text: 'there.', start: 1.5, end: 1.9 },
        { id: 'w2', text: 'um', start: 3.0, end: 3.3 },
        { id: 'w3', text: 'Today', start: 5.0, end: 5.4 },
        { id: 'w4', text: 'we', start: 5.5, end: 5.7 },
        { id: 'w5', text: 'race.', start: 5.8, end: 6.2 }
      ]
    }
  }
}

const segs = [
  { id: 's1', trackId: 'aroll', type: 'segment', sourceId: 'a', in: 0.9, out: 2.0 },
  { id: 's2', trackId: 'aroll', type: 'segment', sourceId: 'a', in: 4.9, out: 6.5 }
]

describe('TimelineResolver', () => {
  it('places segments back to back and maps words', () => {
    const r = new TimelineResolver(project(segs), transcript)
    expect(r.duration).toBeCloseTo(1.1 + 1.6)
    expect(r.wordTime('w0').time).toBeCloseTo(0.1)
    expect(r.wordTime('w3').time).toBeCloseTo(1.1 + 0.1)
    expect(r.wordTime('w3').orphaned).toBe(false)
  })

  it('a cut word follows the next kept word', () => {
    const r = new TimelineResolver(project(segs), transcript)
    const w = r.wordTime('w2')
    expect(w.orphaned).toBe(true)
    expect(w.time).toBeCloseTo(r.wordTime('w3').time)
  })

  it('anchored items move with their words when cuts change', () => {
    const item = { id: 'g', trackId: 'graphics', type: 'graphic', file: 'graphics/x.py', anchor: { kind: 'word', wordId: 'w4', offset: 0.2 }, duration: 2 }
    const before = new TimelineResolver(project([...segs, item]), transcript).resolveItem(project([...segs, item]).items[2])
    const tighter = [{ ...segs[0], out: 1.95 }, segs[1]]
    const p2 = project([...tighter, item])
    const after = new TimelineResolver(p2, transcript).resolveItem(p2.items[2])
    expect(after.start).toBeCloseTo(before.start - 0.05)
  })

  it('speed and hold segments change timing', () => {
    const p = project([{ ...segs[0], speed: 2 }, { id: 'h', trackId: 'aroll', type: 'segment', sourceId: 'a', in: 3, out: 3.1, hold: 1.5 }, segs[1]])
    const r = new TimelineResolver(p, transcript)
    expect(r.duration).toBeCloseTo(0.55 + 1.5 + 1.6)
    expect(r.wordTime('w1').time).toBeCloseTo((1.5 - 0.9) / 2)
  })

  it('anchorAt returns a word anchor that resolves back to the same time', () => {
    const r = new TimelineResolver(project(segs), transcript)
    const a = r.anchorAt(1.5)
    expect(a.kind).toBe('word')
    expect(r.anchorTime(a).time).toBeCloseTo(1.5)
  })
})

describe('captions and chapters', () => {
  it('builds caption lines from kept words only', () => {
    const r = new TimelineResolver(project(segs), transcript)
    const lines = buildCaptions(r, { maxWords: 4 })
    const text = lines.map((l) => l.words.map((w) => w.word.text).join(' '))
    expect(text).toEqual(['Hello there.', 'Today we race.'])
    const srt = buildSrt({ project: project(segs), transcript })
    expect(srt).toContain('00:00:00,100 --> ')
    expect(srt).not.toContain('um')
  })

  it('chapters follow their words and start at 0:00', () => {
    expect(chapterLines({ project: project(segs), transcript })).toEqual(['0:00 Intro', '0:01 Second part'])
  })
})

describe('time parsing', () => {
  it('finds typed ranges', () => {
    expect(findTimeRange('At 2:10 to 2:45, add an animation')).toEqual({ start: 130, end: 165 })
    expect(findTimeRange('from 1:05-1:20 please')).toEqual({ start: 65, end: 80 })
    expect(findTimeRange('make it funnier')).toBeNull()
    expect(parseTime('1:02:03')).toBe(3723)
    expect(parseTime('2m10s')).toBe(130)
  })
})
