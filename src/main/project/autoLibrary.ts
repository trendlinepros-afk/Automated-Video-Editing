/**
 * Everything Claude makes for a video (graphics and animations, custom effects, composed music, sound effects)
 * ends up in the asset library, so later videos can find it. Claude saves each one itself with a proper
 * description (save_to_library); after every Claude run the app saves whatever was missed, described from its
 * label and the project, and marks the items so nothing is saved twice.
 */
import { existsSync } from 'node:fs'
import { basename, extname, isAbsolute } from 'node:path'
import type { Item, Project } from '@shared/project'
import type { LibraryAsset } from '@shared/ipc'
import type { AppContext } from '../context'
import { absInProject } from '../mcp/tools/common'
import type { ProjectStore } from './store'

type Kind = LibraryAsset['type']

function kindOf(project: Project, item: Item): Kind | null {
  const file = (item as { file?: string }).file
  if (!file || isAbsolute(file)) return null // only files Claude made inside the project
  if (item.type === 'graphic') return 'graphic'
  if (item.type === 'effect') return item.effect === 'custom' ? 'effect' : null
  if (item.type === 'audio') {
    const track = project.tracks.find((t) => t.id === item.trackId)?.kind
    return track === 'music' ? 'music' : track === 'sfx' ? 'sound' : null
  }
  return null
}

const KIND_WORD: Record<string, string> = { graphic: 'graphic', effect: 'effect', music: 'music track', sound: 'sound effect' }

/** Saves Claude-made files not in the library yet. Returns how many were saved. Never throws. */
export async function saveNewAssetsToLibrary(ctx: AppContext, store: ProjectStore): Promise<number> {
  try {
    if (store.readOnly || !ctx.library.root()) return 0
    const p = store.project
    const pending = new Map<string, { kind: Kind; items: Item[] }>()
    const known = new Map<string, string>() // file -> asset id already in the library
    for (const item of p.items) {
      const file = (item as { file?: string }).file
      if (!file) continue
      if (item.libraryAssetId) {
        known.set(file, item.libraryAssetId)
        continue
      }
      if (item.createdBy !== 'claude') continue
      const kind = kindOf(p, item)
      if (!kind) continue
      const entry = pending.get(file) ?? { kind, items: [] }
      entry.items.push(item)
      pending.set(file, entry)
    }
    const marks = new Map<string, string>() // item id -> asset id
    let saved = 0
    for (const [file, { kind, items }] of pending) {
      const already = known.get(file)
      if (already) {
        for (const i of items) marks.set(i.id, already)
        continue
      }
      const abs = absInProject(store.dir, file)
      if (!existsSync(abs)) continue
      const labels = [...new Set(items.map((i) => i.label?.trim()).filter(Boolean))] as string[]
      const first = items[0] as { params?: Record<string, unknown> }
      const inputs: LibraryAsset['inputs'] = {}
      for (const [k, v] of Object.entries(first.params ?? {})) inputs[k] = { type: Array.isArray(v) ? 'list' : typeof v, default: v }
      const asset = await ctx.library.saveFromFile({
        file: abs,
        type: kind,
        name: (labels[0] ?? basename(file, extname(file))).slice(0, 80),
        description: `${KIND_WORD[kind]} Claude made for the video "${p.name}"${labels.length ? `, used as: ${labels.join('; ')}` : ''}.`,
        whenToUse: `Saved automatically. First used in "${p.name}". Reuse only where it fits as well as something made fresh.`,
        tags: [kind, 'auto-saved', ...labels.flatMap((l) => l.toLowerCase().split(/\W+/)).filter((w) => w.length > 2)].slice(0, 12),
        scope: p.profileId,
        inputs
      })
      for (const i of items) marks.set(i.id, asset.id)
      saved++
    }
    if (marks.size) {
      store.mutate(
        'Saved to the library',
        'app',
        (d) => {
          for (const it of d.project.items) if (marks.has(it.id)) it.libraryAssetId = marks.get(it.id)
        },
        { bypassLock: true, noHistory: true }
      )
    }
    if (saved) store.log.write('app', `Saved ${saved} new asset${saved > 1 ? 's' : ''} Claude made to the library`)
    return saved
  } catch (err) {
    store.log.write('error', 'Could not save new assets to the library', { error: err instanceof Error ? err.message : String(err) })
    return 0
  }
}
