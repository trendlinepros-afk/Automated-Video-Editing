import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppContext } from '../src/main/context'
import { saveNewAssetsToLibrary } from '../src/main/project/autoLibrary'
import { cleanupTemps, makeProject } from './helpers/project'

afterEach(() => cleanupTemps())

describe('everything Claude makes goes into the library', () => {
  it('saves new graphics, music and sound effects once, skips what is already there, and marks the items', async () => {
    const store = makeProject()
    for (const f of ['graphics/a.py', 'graphics/b.py', 'audio/pop.wav', 'audio/music.wav', 'audio/theme.wav']) {
      mkdirSync(join(store.dir, f, '..'), { recursive: true })
      writeFileSync(join(store.dir, f), 'x')
    }
    store.mutate('more', 'claude', (d) => {
      const g = d.project.items.find((i) => i.id === 'gfx_inside') as any
      g.label = 'Price pop $25'
      g.params = { text: '$25', color: '#ffd400' }
      // The same graphic used twice is one asset; one placed from the library is skipped; one the owner added is not saved.
      d.project.items.push({ ...g, id: 'gfx_again', anchor: { kind: 'time', time: 20 } })
      d.project.items.push({ id: 'theme_from_lib', trackId: 'music', createdBy: 'claude', type: 'audio', file: 'audio/theme.wav', libraryAssetId: 'asset_old', anchor: { kind: 'time', time: 0 }, duration: 5, in: 0, volume: 0, fadeIn: 0, fadeOut: 0, duck: true, loop: false } as any)
      ;(d.project.items.find((i) => i.id === 'gfx_after') as any).createdBy = 'user'
    })
    const saved: any[] = []
    const ctx = {
      library: {
        root: () => '/lib',
        saveFromFile: async (o: any) => {
          saved.push(o)
          return { id: `asset_${saved.length}` }
        }
      }
    } as unknown as AppContext

    expect(await saveNewAssetsToLibrary(ctx, store)).toBe(3) // a.py, pop.wav (sfx), music.wav (music)
    expect(saved.map((s) => [s.type, s.name])).toEqual([
      ['graphic', 'Price pop $25'],
      ['sound', 'pop'],
      ['music', 'music']
    ])
    expect(saved[0].inputs).toEqual({ text: { type: 'string', default: '$25' }, color: { type: 'string', default: '#ffd400' } })
    expect(saved[0].scope).toBe(store.project.profileId)
    const items = (id: string) => store.project.items.find((i) => i.id === id)!
    expect(items('gfx_inside').libraryAssetId).toBe('asset_1')
    expect(items('gfx_again').libraryAssetId).toBe('asset_1')
    expect(items('gfx_after').libraryAssetId).toBeUndefined()
    expect(items('theme_from_lib').libraryAssetId).toBe('asset_old')
    expect(store.canUndo).toBe(true) // bookkeeping: the marks are not an undo step of their own
    expect(store.undoLabel).not.toBe('Saved to the library')

    // Nothing new: nothing saved again.
    expect(await saveNewAssetsToLibrary(ctx, store)).toBe(0)
    expect(saved).toHaveLength(3)
  })

  it('does nothing without a library folder', async () => {
    const store = makeProject()
    const ctx = { library: { root: () => null } } as unknown as AppContext
    expect(await saveNewAssetsToLibrary(ctx, store)).toBe(0)
  })
})
