import { afterEach, describe, expect, it } from 'vitest'
import { TimelineResolver, buildCaptions, captionFilter, captionWordIds } from '@shared/timeline'
import { buildPlan } from '../src/main/engine/plan'
import { shortDoc } from '../src/main/shorts/build'
import { WORKFLOW, buildRunPrompt } from '../src/main/runner/prompts'
import { cleanupTemps, makeProject } from './helpers/project'

afterEach(() => cleanupTemps())

describe('captions at key moments', () => {
  it('burns in only the chosen spans, and every word in "all" mode', () => {
    const store = makeProject()
    const doc = () => store.snapshotDoc()
    const all = buildCaptions(new TimelineResolver(doc().project, doc().transcript), { maxWords: 4 })
    expect(all.length).toBeGreaterThan(5)

    store.mutate('moments', 'claude', (d) => {
      d.project.captions.mode = 'moments'
      d.project.captions.spans = [{ from: 'src_a_w0', to: 'src_a_w3' }]
    })
    const ids = captionWordIds(doc().transcript, doc().project.captions.spans!)
    expect([...ids]).toEqual(['src_a_w0', 'src_a_w1', 'src_a_w2', 'src_a_w3'])
    const some = buildCaptions(new TimelineResolver(doc().project, doc().transcript), { maxWords: 4 }, captionFilter(doc().project, doc().transcript))
    expect(some.flatMap((l) => l.words.map((w) => w.word.id))).toEqual(['src_a_w0', 'src_a_w1', 'src_a_w2', 'src_a_w3'].filter((id) => all.some((l) => l.words.some((w) => w.word.id === id))))
    const plan = buildPlan(doc(), { projectDir: store.dir, width: 640, height: 360, fps: 30, burnCaptions: true })
    expect(plan.captions.lines.length).toBe(some.length)

    // A span across two clips, or with unknown words, is ignored rather than captioning everything.
    expect(captionWordIds(doc().transcript, [{ from: 'nope', to: 'src_a_w3' }]).size).toBe(0)

    // Shorts are captioned throughout whatever the long video does.
    const short = shortDoc(doc(), { id: 's', kind: 'highlight', title: 't', reason: '', segments: [{ sourceId: 'src_a', in: 0, out: 20 }], youtubeTitle: '', tiktokCaption: '', description: '', hashtags: [], captions: true, createdAt: '' }, { width: 1080, height: 1920 })
    expect(captionFilter(short.project, short.transcript)).toBeUndefined()
  })

  it('tells Claude captions are for the hook and key moments, not the whole video', () => {
    const store = makeProject()
    expect(buildRunPrompt([], store.project, { resumed: false }).length).toBeGreaterThan(0)
    expect(WORKFLOW).toMatch(/caption the hook.*set_caption_spans.*Never caption a whole intro/s)
  })
})
