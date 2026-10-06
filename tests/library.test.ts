import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LIBRARY_FORMAT_VERSION } from '@shared/appInfo'
import { LIBRARY_STEPS } from '@shared/migrations'
import { SettingsSchema } from '@shared/settings'
import type { AppContext } from '../src/main/context'
import { ActivityLog } from '../src/main/log'
import { createLibraryService } from '../src/main/services/library'

let dir: string
let root: string
let starter: string
let previews: number

function makeLibrary() {
  const settings = SettingsSchema.parse({ libraryFolder: root })
  const ctx = {
    appLog: new ActivityLog(join(dir, 'app.log')),
    settings: { get: () => settings },
    projects: { current: () => null },
    engine: {
      graphicPreview: async (_d: string, _f: string, o: { outDir: string }) => {
        previews++
        const p = join(o.outDir, 'f0.png')
        writeFileSync(p, 'png')
        return [p]
      }
    }
  } as unknown as AppContext
  return createLibraryService(ctx, { starterDir: starter })
}

function file(name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ave-lib-'))
  root = join(dir, 'library')
  starter = join(dir, 'starter')
  previews = 0
  const s = join(starter, 'like_subscribe')
  mkdirSync(s, { recursive: true })
  writeFileSync(join(s, 'like_subscribe.py'), 'def render(t, ctx):\n    return None\n')
  writeFileSync(
    join(s, 'asset.json'),
    JSON.stringify({ formatVersion: 1, id: 'starter_like_subscribe', name: 'Like and subscribe', type: 'graphic', description: 'Animated like button', whenToUse: 'End of video', tags: ['cta'], scope: 'shared', file: 'like_subscribe.py', inputs: {}, preferred: false, uses: 0, createdAt: '', updatedAt: '' })
  )
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('asset library', () => {
  it('seeds starter assets once, and a deleted starter asset stays deleted', () => {
    const lib = makeLibrary()
    expect(lib.list().map((a) => a.id)).toEqual(['starter_like_subscribe'])
    lib.remove('starter_like_subscribe')
    expect(makeLibrary().list()).toHaveLength(0)
  })

  it('saves a file with a preview, finds it by words, and keeps channel assets to their channel', async () => {
    const lib = makeLibrary()
    const lower = await lib.saveFromFile({
      file: file('lower_third.py', 'def render(t, ctx):\n    return None\n'),
      type: 'graphic',
      name: 'Lower third',
      description: 'Name and title bar sliding in from the left',
      whenToUse: 'When a person is introduced',
      tags: ['name', 'title'],
      scope: 'rc',
      inputs: { text: { type: 'string', default: 'Name' } }
    })
    expect(previews).toBe(1)
    expect(existsSync(join(root, 'profiles', 'rc', lower.id, 'asset.json'))).toBe(true)
    expect(existsSync(join(root, 'profiles', 'rc', lower.id, 'preview.png'))).toBe(true)
    const whoosh = await lib.saveFromFile({ file: file('whoosh.wav', 'RIFF'), type: 'sound', name: 'Whoosh', description: 'Fast swish', whenToUse: 'Transitions', tags: ['transition'], scope: 'shared' })
    expect(previews).toBe(1) // sounds get no rendered preview

    expect(lib.search('introduced person', { profileId: 'rc' }).map((a) => a.id)).toEqual([lower.id])
    expect(lib.search('introduced', { profileId: 'finance' })).toHaveLength(0)
    expect(lib.search('transition', { profileId: 'finance' }).map((a) => a.id)).toEqual([whoosh.id])
    expect(lib.search('', { type: 'sound' }).map((a) => a.id)).toEqual([whoosh.id])

    // Preferred assets come first.
    lib.update(whoosh.id, { preferred: true })
    expect(lib.search('', { profileId: 'rc' })[0].id).toBe(whoosh.id)
  })

  it('renames, retags, moves between shared and a channel, and duplicates', async () => {
    const lib = makeLibrary()
    const a = await lib.saveFromFile({ file: file('pop.wav', 'RIFF'), type: 'sound', name: 'Pop', description: '', whenToUse: '', tags: [], scope: 'shared' })
    const moved = lib.update(a.id, { scope: 'finance', name: 'Soft pop', tags: ['ui', 'ui', ' click '] })
    expect(moved.dir).toBe(join(root, 'profiles', 'finance', a.id))
    expect(existsSync(join(root, 'shared', a.id))).toBe(false)
    expect(lib.get(a.id)).toMatchObject({ name: 'Soft pop', scope: 'finance', tags: ['ui', 'click'] })
    const copy = lib.duplicate(a.id)
    expect(copy.id).not.toBe(a.id)
    expect(copy.name).toBe('Soft pop copy')
    expect(existsSync(join(copy.dir!, 'pop.wav'))).toBe(true)
  })

  it('copies into a project so later library edits never change it, and counts the use', async () => {
    const lib = makeLibrary()
    const a = await lib.saveFromFile({ file: file('title.py', 'VERSION = 1\n'), type: 'graphic', name: 'Big Title', description: '', whenToUse: '', tags: [], scope: 'shared' })
    const project = join(dir, 'project')
    const rel1 = lib.copyIntoProject(a.id, project)
    const rel2 = lib.copyIntoProject(a.id, project)
    expect(rel1).toBe('graphics/big_title.py')
    expect(rel2).toBe('graphics/big_title_2.py')
    expect(lib.get(a.id)!.uses).toBe(2)
    writeFileSync(join(a.dir!, 'title.py'), 'VERSION = 2\n')
    lib.remove(a.id)
    expect(readFileSync(join(project, rel1), 'utf8')).toBe('VERSION = 1\n')
  })

  it('upgrades an older asset.json with a backup first and keeps fields it does not know', () => {
    const d = join(root, 'shared', 'old_asset')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'sting.wav'), 'RIFF')
    const original = { formatVersion: 0, id: 'old_asset', name: 'Sting', type: 'sound', file: 'sting.wav', futureField: { keep: true } }
    writeFileSync(join(d, 'asset.json'), JSON.stringify(original))
    const prevStep = LIBRARY_STEPS[0]
    LIBRARY_STEPS[0] = (doc) => ({ ...doc, tags: doc.tags ?? [] })
    try {
      const asset = makeLibrary().get('old_asset') as any
      expect(asset.formatVersion).toBe(LIBRARY_FORMAT_VERSION)
      expect(asset.futureField).toEqual({ keep: true })
      expect(JSON.parse(readFileSync(join(d, 'asset.json.bak-0'), 'utf8'))).toEqual(original)
      const onDisk = JSON.parse(readFileSync(join(d, 'asset.json'), 'utf8'))
      expect(onDisk.futureField).toEqual({ keep: true })
      expect(onDisk.formatVersion).toBe(LIBRARY_FORMAT_VERSION)
      // Saving through the service keeps the unknown field too.
      makeLibrary().update('old_asset', { tags: ['sting'] })
      expect(JSON.parse(readFileSync(join(d, 'asset.json'), 'utf8')).futureField).toEqual({ keep: true })
    } finally {
      if (prevStep) LIBRARY_STEPS[0] = prevStep
      else delete LIBRARY_STEPS[0]
    }
  })
})
