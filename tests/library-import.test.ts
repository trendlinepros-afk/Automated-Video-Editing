import { afterEach, describe, expect, it } from 'vitest'
import { buildPlan } from '../src/main/engine/plan'
import { importLibraryFiles, nameFromFile, tagsFromName } from '../src/main/services/libraryImport'
import { cleanupTemps, fakeContext, makeProject } from './helpers/project'

afterEach(cleanupTemps)

describe("the owner's own sounds in the library", () => {
  it('names Epidemic Sound downloads plainly and tags them', () => {
    expect(nameFromFile('C:\\dl\\ES_Car Tire Skid, Long 02 - Epidemic Sound.wav')).toEqual({ name: 'Car Tire Skid, Long 02', epidemic: true })
    expect(nameFromFile('/x/whoosh_fast_01.mp3')).toEqual({ name: 'whoosh fast 01', epidemic: false })
    expect(tagsFromName('Car Tire Skid, Long 02')).toEqual(['car', 'tire', 'skid'])
  })

  it('files short sounds as sound effects and long ones as music, and skips what is already there', async () => {
    const ctx = fakeContext() as any
    const saved: any[] = []
    ctx.library = {
      root: () => '/lib',
      list: () => [{ type: 'sound', name: 'Whoosh' }],
      saveFromFile: async (o: any) => (saved.push(o), { ...o, id: `a${saved.length}` })
    }
    ctx.engine = { probe: async (p: string) => ({ kind: 'audio', duration: p.includes('Music') ? 95 : 1.6, hasAudio: true }) }
    const r = await importLibraryFiles(ctx, ['/dl/ES_Tire Squeal - Epidemic Sound.wav', '/dl/ES_Upbeat Music - Epidemic Sound.mp3', '/dl/Whoosh.wav', '/dl/notes.txt'])
    expect(saved.map((s) => [s.name, s.type, s.scope])).toEqual([
      ['Tire Squeal', 'sound', 'shared'],
      ['Upbeat Music', 'music', 'shared']
    ])
    expect(saved[0].description).toBe("Sound effect: Tire Squeal, 1.6 s. From the owner's own files (Epidemic Sound, licensed).")
    expect(saved[0].tags).toEqual(['tire', 'squeal', 'epidemic sound', 'owner file'])
    expect(r.skipped).toEqual(['Whoosh.wav (already in the library)', 'notes.txt (not a sound file)'])
  })
})

describe('cleaned sound', () => {
  it("plays a source's cleaned copy in place of its original sound, keeping the picture", () => {
    const store = makeProject()
    store.mutate('clean', 'claude', (d) => {
      d.project.sources[0].cleanAudio = { file: 'media/clean/a001.wav' }
    })
    const plan = buildPlan(store.snapshotDoc(), { projectDir: store.dir, width: 640, height: 360, fps: 30, burnCaptions: false })
    const voice = plan.audio.clips.find((c) => c.id === 'seg_1')!
    expect(voice.path.replace(/\\/g, '/')).toMatch(/media\/clean\/a001\.wav$/)
    const picture = plan.layers.find((l) => l.id === 'seg_1') as { path: string }
    expect(picture.path).toMatch(/A001\.mp4$/)
  })
})
