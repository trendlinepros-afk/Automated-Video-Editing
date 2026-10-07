import { afterEach, describe, expect, it } from 'vitest'
import { introVersions, saveIntroVersion, useIntro } from '../src/main/project/intros'
import { cleanupTemps, fakeContext, makeProject } from './helpers/project'

afterEach(() => cleanupTemps())

describe('intro A/B', () => {
  it('keeps each intro when it is redone, switches between them, and leaves the chat alone', () => {
    const store = makeProject()
    const ctx = fakeContext({ store })
    const seg = () => store.project.items.find((i) => i.type === 'segment') as { out: number }
    const first = seg().out

    saveIntroVersion(ctx, store) // redo #1 keeps "Intro 1"
    saveIntroVersion(ctx, store) // the same intro is not saved twice
    expect(introVersions(ctx, store).versions.map((v) => v.name)).toEqual(['Intro 1'])
    expect(introVersions(ctx, store).currentId).not.toBeNull()

    // Claude makes a new intro, and the owner chats.
    store.mutate('new intro', 'claude', (d) => {
      ;(d.project.items.find((i) => i.type === 'segment') as { out: number }).out = first - 0.5
      d.project.chat.push({ id: 'c1', role: 'user', text: 'nice', ts: new Date().toISOString() } as never)
    })
    expect(introVersions(ctx, store).currentId).toBeNull() // the new intro is not saved yet

    // Switching back to Intro 1 first keeps the new one as "Intro 2".
    const intro1 = introVersions(ctx, store).versions[0].id
    useIntro(ctx, store, intro1)
    expect(seg().out).toBe(first)
    expect(store.project.chat.map((c) => c.id)).toContain('c1')
    const list = introVersions(ctx, store)
    expect(list.versions.map((v) => v.name)).toEqual(['Intro 1', 'Intro 2'])
    expect(list.currentId).toBe(intro1)

    // And to Intro 2 again; Undo goes back.
    useIntro(ctx, store, list.versions[1].id)
    expect(seg().out).toBe(first - 0.5)
    store.undo()
    expect(seg().out).toBe(first)
    expect(() => useIntro(ctx, store, 'nope')).toThrow(/no longer saved/)
  })
})

describe('versions', () => {
  it('lists the first version of a project once, and tidies lists older apps saved with a duplicate', async () => {
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const store = makeProject()
    const ctx = fakeContext({ store })
    const v = ctx.versions.save('My first')
    expect(ctx.versions.list().map((x) => x.name)).toEqual(['My first'])
    writeFileSync(join(store.paths.versions, 'index.json'), JSON.stringify({ formatVersion: 1, versions: [{ ...v, name: `Recovered ${v.id}` }, v] }))
    expect(ctx.versions.list().map((x) => x.name)).toEqual(['My first'])
  })
})
