import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectSchema } from '../src/shared/project'
import {
  applyPublishDraft,
  cleanTags,
  parsePublishDraft,
  promptInputFor,
  publishPrompt,
  tagsLength,
  writePublishDraft,
  type PublishPromptInput
} from '../src/main/services/publishDraft'
import { cleanupTemps, fakeContext, makeProject } from './helpers/project'

afterEach(cleanupTemps)

/** A stand-in for Claude Code: records how it was started and answers with the given text. */
function fakeClaude(answer: string, seen: { file?: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv }) {
  return (file: string, args: string[], opts: any) => {
    seen.file = file
    seen.args = args
    seen.cwd = opts.cwd
    seen.env = opts.env
    const proc = new EventEmitter() as any
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.kill = () => true
    setTimeout(() => {
      proc.stdout.end(answer)
      proc.stderr.end()
      proc.emit('close', 0)
    }, 5)
    return proc
  }
}

const base: PublishPromptInput = {
  examples: ['I Bought the Cheapest Drift Car on Amazon', '', 'This $65 RC Car Shocked Me'],
  about: 'A cheap 4S LiPo run flat out until it gets too hot',
  inspiration: 'Fast and funny',
  channel: 'RC cars',
  channelRules: ['Never swear in titles'],
  channelNotes: 'Audience: RC bashers',
  duration: 612,
  spoken: 'so this battery is getting really hot',
  chapters: ['0:00 Intro', '4:08 First run'],
  current: { titles: ['Old title'], description: 'Old description', tags: ['rc'] },
  hasTemplate: true
}

const answer = {
  titles: { search: '4S LiPo Heat Test: How Hot Does It Get?', clickbait: '"I Pushed This LiPo Too Far"', mix: 'LiPo Torture Test: This $40 Battery Got Scary Hot' },
  description: 'How hot does a cheap LiPo get?\nRC battery heat test.\n\nGear: https://shop.example/gear and more.',
  tags: ['#4s lipo', 'LiPo test', 'lipo test', 'rc car, rc cars']
}

describe('publish draft prompt', () => {
  it('hands Claude the examples, the about text, what is said, the chapters, the channel rules and the title rules', () => {
    const p = publishPrompt(base)
    expect(p).toContain('"I Bought the Cheapest Drift Car on Amazon"')
    expect(p).toContain('"This $65 RC Car Shocked Me"')
    expect(p).not.toContain('- ""') // empty example fields are left out
    expect(p).toContain('A cheap 4S LiPo run flat out until it gets too hot')
    expect(p).toContain('Fast and funny')
    expect(p).toContain('so this battery is getting really hot')
    expect(p).toContain('0:00 Intro\n4:08 First run')
    expect(p).toContain('channel "RC cars"')
    expect(p).toContain('- Never swear in titles')
    expect(p).toContain('Audience: RC bashers')
    expect(p).toContain('Length of the edit: 10:12')
    expect(p).toMatch(/at most 70 characters \(ideally 40-60\)/)
    expect(p).toMatch(/"search".*Front-load the exact keywords/s)
    expect(p).toMatch(/"clickbait".*true to the video/s)
    expect(p).toMatch(/"mix".*best of both/s)
    expect(p).toMatch(/never invent times/)
    expect(p).toMatch(/No links/)
    expect(p).toMatch(/standing links and disclaimer are added after it/)
    expect(p).toMatch(/10-20 tags.*at most 500 characters/s)
    expect(p).toContain('{"titles": {"search": "...", "clickbait": "...", "mix": "..."}, "description": "...", "tags": ["...", "..."]}')
    expect(p).toMatch(/do not use or ask for any tools/)
  })

  it('asks for one part only when regenerating it, with the current one to beat and the direction', () => {
    const p = publishPrompt({ ...base, only: 'tags', direction: 'more about safety' })
    expect(p).toContain('Reply with ONLY this JSON, nothing before or after it: {"tags": ["...", "..."]}')
    expect(p).not.toMatch(/Titles: write exactly three/)
    expect(p).toContain('Current tags (improve on them): rc')
    expect(p).toContain('"more about safety"')
    expect(p).toContain('The video\'s title: "Old title"')
    const t = publishPrompt({ ...base, only: 'titles' })
    expect(t).toContain('Current titles (write new, better ones, not these): "Old title"')
    expect(t).not.toMatch(/Description: plain text/)
  })

  it('falls back to the inspiration when the owner has not said what the video is about', () => {
    const store = makeProject()
    store.mutate('i', 'user', (d) => void (d.project.inspiration = 'My vision for the LiPo video'))
    const ctx = fakeContext({ store })
    const input = promptInputFor(store.snapshotDoc(), ctx.profiles.get('prof_test'), {})
    expect(input.about).toBe('My vision for the LiPo video')
    expect(input.channel).toBe('Test channel')
    expect(input.spoken.startsWith('word0 word1')).toBe(true)
    expect(input.duration).toBeGreaterThan(30)
  })
})

describe('publish draft answer', () => {
  it('reads the JSON envelope or plain text, and cleans titles, links and tags', () => {
    const d = parsePublishDraft(JSON.stringify({ type: 'result', result: 'Sure:\n```json\n' + JSON.stringify(answer) + '\n```' }))
    expect(d.titles).toEqual({ search: answer.titles.search, clickbait: 'I Pushed This LiPo Too Far', mix: answer.titles.mix })
    expect(d.description).toBe('How hot does a cheap LiPo get?\nRC battery heat test.\n\nGear:  and more.')
    expect(d.tags).toEqual(['4s lipo', 'LiPo test', 'rc car', 'rc cars'])
    // A link the owner gave is kept.
    expect(parsePublishDraft(JSON.stringify(answer), undefined, 'my shop https://shop.example/gear').description).toContain('https://shop.example/gear')
    expect(parsePublishDraft(JSON.stringify({ tags: 'a, b' }), 'tags')).toEqual({ tags: ['a', 'b'] })
  })

  it('fails with a clear message on a bad answer', () => {
    expect(() => parsePublishDraft(JSON.stringify({ is_error: true, result: 'Credit balance is too low' }))).toThrow(/Credit balance/)
    expect(() => parsePublishDraft(JSON.stringify({ result: 'I cannot help with that' }))).toThrow(/did not answer with titles.*I cannot help/)
    expect(() => parsePublishDraft('{"titles": {}, "description": "x", "tags": ["a"]}')).toThrow(/did not write any titles/)
    expect(() => parsePublishDraft('{"titles": {"mix": "A"}}')).toThrow(/did not write a description/)
    expect(() => parsePublishDraft('{"description": ""}', 'description')).toThrow(/did not write a description/)
    expect(() => parsePublishDraft('{"titles": {"mix": "A"}, "description": "d", "tags": []}')).toThrow(/did not write any tags/)
    // One title missing borrows from the others.
    expect(parsePublishDraft('{"titles": {"mix": "A"}}', 'titles').titles).toEqual({ search: 'A', clickbait: 'A', mix: 'A' })
  })

  it('keeps all the tags under 500 characters as YouTube counts them', () => {
    const many = Array.from({ length: 60 }, (_, i) => `long tag number ${i}`)
    const tags = cleanTags(many)
    expect(tagsLength(tags)).toBeLessThanOrEqual(500)
    expect(tags.length).toBeLessThan(60)
    expect(tagsLength(['a b', 'c'])).toBe(7) // "a b",c
  })
})

describe('saving the draft', () => {
  const pub = () => ProjectSchema.shape.publish.parse({ titles: ['From the edit'], description: '', tags: [] })

  it('makes the mix title titles[0] by default and fills an empty description and tags', () => {
    const p = pub()
    applyPublishDraft(p, parsePublishDraft(JSON.stringify(answer)), undefined, 'now')
    expect(p.titles[0]).toBe(answer.titles.mix)
    expect(p.titles).toEqual([answer.titles.mix, answer.titles.search, 'I Pushed This LiPo Too Far', 'From the edit'])
    expect(p.generated).toMatchObject({ chosen: 'mix', at: 'now' })
    expect(p.description).toContain('How hot')
    expect(p.tags.length).toBe(4)
  })

  it('keeps the owner\'s pick, and leaves a written description and tags alone unless that part is regenerated', () => {
    const p = pub()
    p.description = 'Mine'
    p.tags = ['mine']
    p.generated = { search: 'S', clickbait: 'C', mix: 'M', chosen: 'clickbait', at: 'then' }
    applyPublishDraft(p, parsePublishDraft(JSON.stringify(answer)), undefined, 'now')
    expect(p.titles[0]).toBe('I Pushed This LiPo Too Far')
    expect(p.generated?.chosen).toBe('clickbait')
    expect(p.description).toBe('Mine')
    expect(p.tags).toEqual(['mine'])

    const titlesBefore = [...p.titles]
    const generatedBefore = structuredClone(p.generated)
    applyPublishDraft(p, parsePublishDraft(JSON.stringify(answer), 'description'), 'description', 'later')
    expect(p.description).toContain('How hot')
    expect(p.tags).toEqual(['mine'])
    expect(p.titles).toEqual(titlesBefore)
    expect(p.generated).toEqual(generatedBefore)

    applyPublishDraft(p, parsePublishDraft(JSON.stringify(answer), 'tags'), 'tags', 'later')
    expect(p.tags).toEqual(['4s lipo', 'LiPo test', 'rc car', 'rc cars'])
    expect(p.titles).toEqual(titlesBefore)
  })
})

describe('the quick call', () => {
  it('runs Claude Code once with no tools and the publish model, then saves the answer', async () => {
    const store = makeProject()
    store.mutate('brief', 'user', (d) => void (d.project.publish.brief = { examples: ['My Best Title Ever'], about: 'LiPo heat test' }))
    const ctx = fakeContext({ store }) as any
    ctx.settings = { get: () => ({ runner: { command: 'claude' }, claude: { models: { publish: 'claude-sonnet-x' } } }) }
    const seen: { file?: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv } = {}
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    try {
      const r = await writePublishDraft(ctx, store, {}, { platform: 'linux', spawn: fakeClaude(JSON.stringify({ result: JSON.stringify(answer) }), seen) as any })
      expect(r.titles?.mix).toBe(answer.titles.mix)
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
    expect(seen.file).toBe('claude')
    const args = seen.args!
    expect(args).toEqual(expect.arrayContaining(['-p', '--output-format', 'json', '--model', 'claude-sonnet-x']))
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args).not.toContain('--resume')
    expect(args).not.toContain('--mcp-config')
    const prompt = args[args.indexOf('-p') + 1]
    expect(prompt).toContain('"My Best Title Ever"')
    expect(prompt).toContain('LiPo heat test')
    expect(prompt).toContain('word0 word1')
    expect(seen.env?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(existsSync(seen.cwd!)).toBe(false) // the work folder is cleaned up
    expect(store.project.publish.titles[0]).toBe(answer.titles.mix)
    expect(store.project.publish.generated).toMatchObject({ search: answer.titles.search, chosen: 'mix' })
    expect(store.project.publish.tags.length).toBe(4)

    // Only the titles again: the description and tags stay.
    store.mutate('own', 'user', (d) => void (d.project.publish.description = 'Hand written'))
    await writePublishDraft(ctx, store, { only: 'titles' }, { platform: 'linux', spawn: fakeClaude('{"titles": {"search": "S2", "clickbait": "C2", "mix": "M2"}}', seen) as any })
    expect(store.project.publish.titles[0]).toBe('M2')
    expect(store.project.publish.description).toBe('Hand written')
    expect(seen.args![seen.args!.indexOf('-p') + 1]).toContain('{"titles": {"search": "...", "clickbait": "...", "mix": "..."}}')
  })

  it('says what went wrong when Claude cannot start', async () => {
    const store = makeProject()
    const ctx = fakeContext({ store }) as any
    ctx.settings = { get: () => ({ runner: { command: 'claude' }, claude: { models: {} } }) }
    const spawnFail = () => {
      const proc = new EventEmitter() as any
      proc.stdout = new PassThrough()
      proc.stderr = new PassThrough()
      proc.kill = () => true
      setTimeout(() => proc.emit('error', Object.assign(new Error('nope'), { code: 'ENOENT' })), 5)
      return proc
    }
    await expect(writePublishDraft(ctx, store, {}, { platform: 'linux', spawn: spawnFail as any })).rejects.toThrow(/could not be started \(ENOENT\)/)
  })
})
