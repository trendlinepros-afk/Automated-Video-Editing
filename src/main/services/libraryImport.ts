/**
 * The owner's own sound and music files into the asset library (for example downloads from Epidemic Sound), so Claude
 * can use one when it fits a moment as well as a sound it would make itself.
 */
import { basename, extname } from 'node:path'
import type { LibraryAsset } from '@shared/ipc'
import type { AppContext } from '../context'

export const AUDIO_EXTS = ['wav', 'mp3', 'aiff', 'aif', 'flac', 'ogg', 'm4a']
/** With type 'auto', files at least this long are music, shorter ones sound effects. */
export const MUSIC_MIN_SECONDS = 30

/** "ES_Car Tire Skid, Long 02 - Epidemic Sound.wav" -> { name: "Car Tire Skid, Long 02", epidemic: true }. */
export function nameFromFile(file: string): { name: string; epidemic: boolean } {
  // Either slash: the app runs on Windows, the tests on Linux.
  const base = file.split(/[\\/]/).pop() ?? file
  let name = base.slice(0, base.length - extname(base).length)
  const epidemic = /^ES_/i.test(name) || /epidemic\s*sound/i.test(name)
  name = name
    .replace(/^ES_/i, '')
    .replace(/\s*[-–]\s*epidemic\s*sound\s*$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { name: name || base, epidemic }
}

/** Search words from the name (lowercase, no numbers or tiny words). */
export function tagsFromName(name: string): string[] {
  const words = name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && !['the', 'and', 'with', 'for', 'long', 'short'].includes(w))
  return [...new Set(words)].slice(0, 8)
}

export async function importLibraryFiles(
  ctx: AppContext,
  paths: string[],
  opts: { type?: 'auto' | 'sound' | 'music'; scope?: string } = {}
): Promise<{ added: LibraryAsset[]; skipped: string[] }> {
  if (!ctx.library.root()) throw new Error('Choose where the asset library is kept first (Settings > General).')
  const added: LibraryAsset[] = []
  const skipped: string[] = []
  const existing = ctx.library.list()
  for (const file of paths) {
    if (!AUDIO_EXTS.includes(extname(file).slice(1).toLowerCase())) {
      skipped.push(`${basename(file)} (not a sound file)`)
      continue
    }
    const { name, epidemic } = nameFromFile(file)
    let duration = 0
    try {
      duration = (await ctx.engine.probe(file)).duration || 0
    } catch {
      skipped.push(`${basename(file)} (could not be read)`)
      continue
    }
    const type = opts.type && opts.type !== 'auto' ? opts.type : duration >= MUSIC_MIN_SECONDS ? 'music' : 'sound'
    if (existing.some((a) => a.type === type && a.name.toLowerCase() === name.toLowerCase())) {
      skipped.push(`${basename(file)} (already in the library)`)
      continue
    }
    const kind = type === 'music' ? 'Music track' : 'Sound effect'
    added.push(
      await ctx.library.saveFromFile({
        file,
        type,
        name,
        description: `${kind}: ${name}, ${duration.toFixed(1)} s. From the owner's own files${epidemic ? ' (Epidemic Sound, licensed)' : ''}.`,
        whenToUse: '',
        tags: [...tagsFromName(name), ...(epidemic ? ['epidemic sound'] : []), 'owner file'],
        scope: opts.scope || 'shared'
      })
    )
  }
  return { added, skipped }
}
