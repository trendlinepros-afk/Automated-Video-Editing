/**
 * The music library: master folders you add in Settings, indexed with their subfolders.
 * The app only reads these files. It never moves, renames or changes them.
 * A rescan picks up new files and flags missing ones instead of dropping them.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import type { MusicTrack } from '@shared/ipc'
import type { MusicFolder } from '@shared/settings'
import type { AppContext, MusicService } from '../context'
import { paths } from '../paths'

export const MUSIC_EXTENSIONS = ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.aiff', '.aif']

interface IndexedTrack extends MusicTrack {
  size: number
  mtimeMs: number
}

interface MusicIndex {
  formatVersion: 1
  scannedAt: string
  tracks: IndexedTrack[]
}

export interface MusicDeps {
  /** Where the index is stored (paths.musicIndexFile by default). */
  indexFile?: string
  /** ffprobe program (ctx.env.ffprobe() by default). */
  ffprobe?: () => string
}

/** Length of an audio file in seconds, read with ffprobe. 0 when it cannot be read. */
export function probeDuration(ffprobe: string, file: string): Promise<number> {
  return new Promise((resolvePromise) => {
    let out = ''
    let child
    try {
      child = spawn(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { windowsHide: true })
    } catch {
      resolvePromise(0)
      return
    }
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.on('error', () => resolvePromise(0))
    child.on('close', () => {
      const n = parseFloat(out.trim())
      resolvePromise(Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0)
    })
  })
}

/** Every audio file under a folder, recursively. Unreadable subfolders are skipped. */
export function walkAudio(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string, depth: number) => {
    if (depth > 20) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) visit(full, depth + 1)
      else if (e.isFile() && MUSIC_EXTENSIONS.includes(extname(e.name).toLowerCase())) out.push(full)
    }
  }
  visit(root, 0)
  return out.sort()
}

function folderId(path: string): string {
  return 'mf_' + createHash('sha1').update(resolve(path).toLowerCase()).digest('hex').slice(0, 10)
}

/** Lower-case words of a name or folder path ("Upbeat/Chill_Beats-02" -> upbeat chill beats 02). */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s/\\_\-.,()[\]&+]+/)
    .filter(Boolean)
}

/** Tracks matching every word of the query (name or folder); if none do, the best partial matches. */
export function searchTracks(tracks: MusicTrack[], query: string): MusicTrack[] {
  const q = words(query)
  if (!q.length) return tracks
  const scored = tracks.map((t) => {
    const nameWords = words(t.name)
    const folderWords = words(t.folder)
    let hits = 0
    let score = 0
    for (const w of q) {
      const inName = nameWords.some((x) => x.includes(w))
      const inFolder = folderWords.some((x) => x.includes(w))
      if (inName || inFolder) hits++
      score += (inName ? 2 : 0) + (inFolder ? 1.5 : 0) + (nameWords.includes(w) || folderWords.includes(w) ? 0.5 : 0)
    }
    return { t, hits, score }
  })
  const all = scored.filter((s) => s.hits === q.length)
  const pick = all.length ? all : scored.filter((s) => s.hits > 0)
  return pick.sort((a, b) => b.hits - a.hits || b.score - a.score || a.t.name.localeCompare(b.t.name)).map((s) => s.t)
}

const strip = ({ size: _s, mtimeMs: _m, ...t }: IndexedTrack): MusicTrack => t

export function createMusicService(ctx: AppContext, deps: MusicDeps = {}): MusicService {
  let index: MusicIndex | null = null
  let scanning: Promise<MusicTrack[]> | null = null

  const indexFile = () => deps.indexFile ?? paths.musicIndexFile
  const ffprobe = () => (deps.ffprobe ? deps.ffprobe() : ctx.env.ffprobe())

  const load = (): MusicIndex => {
    if (index) return index
    try {
      const raw = JSON.parse(readFileSync(indexFile(), 'utf8')) as MusicIndex
      index = { formatVersion: 1, scannedAt: raw.scannedAt ?? '', tracks: Array.isArray(raw.tracks) ? raw.tracks : [] }
    } catch {
      index = { formatVersion: 1, scannedAt: '', tracks: [] }
    }
    return index
  }

  const save = () => {
    const file = indexFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(load(), null, 1))
    renameSync(`${file}.tmp`, file)
  }

  const folders = (): MusicFolder[] => ctx.settings.get().musicFolders ?? []

  /** Rescans one master folder: new files are added, changed files re-read, vanished ones flagged missing. */
  const scanFolder = async (folder: MusicFolder): Promise<void> => {
    const idx = load()
    const existing = new Map(idx.tracks.filter((t) => t.folderId === folder.id).map((t) => [t.path, t]))
    const reachable = existsSync(folder.path)
    const found = reachable ? walkAudio(folder.path) : []
    const foundSet = new Set(found)
    const probe = ffprobe()
    const next: IndexedTrack[] = []
    const queue = [...found]
    const work = async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        let st
        try {
          st = statSync(file)
        } catch {
          continue
        }
        const old = existing.get(file)
        const rel = relative(folder.path, dirname(file))
        const entry: IndexedTrack = {
          path: file,
          name: basename(file, extname(file)),
          folderId: folder.id,
          folder: rel && rel !== '.' ? rel.split(sep).join('/') : '',
          duration: old && old.size === st.size && old.mtimeMs === Math.round(st.mtimeMs) && old.duration > 0 ? old.duration : await probeDuration(probe, file),
          format: extname(file).slice(1).toLowerCase(),
          missing: false,
          size: st.size,
          mtimeMs: Math.round(st.mtimeMs)
        }
        next.push(entry)
      }
    }
    await Promise.all([work(), work(), work(), work()])
    // Files that were indexed before but are gone now stay in the index, flagged.
    for (const [p, t] of existing) if (!foundSet.has(p)) next.push({ ...t, missing: true })
    next.sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name))
    idx.tracks = [...idx.tracks.filter((t) => t.folderId !== folder.id), ...next]
    if (!reachable) ctx.appLog.write('app', `Music folder not found: ${folder.path}. Its tracks are flagged missing.`)
  }

  const rescan = async (): Promise<MusicTrack[]> => {
    if (scanning) return scanning
    scanning = (async () => {
      const started = Date.now()
      const list = folders()
      for (const f of list) await scanFolder(f)
      const idx = load()
      // Tracks of folders that were removed from Settings are dropped with their folder.
      const ids = new Set(list.map((f) => f.id))
      idx.tracks = idx.tracks.filter((t) => ids.has(t.folderId))
      idx.scannedAt = new Date().toISOString()
      save()
      const missing = idx.tracks.filter((t) => t.missing).length
      ctx.appLog.write('app', `Music library scanned: ${idx.tracks.length} tracks in ${list.length} folders (${missing} missing) in ${((Date.now() - started) / 1000).toFixed(1)} s`)
      return idx.tracks.map(strip)
    })()
    try {
      return await scanning
    } finally {
      scanning = null
    }
  }

  const list = (profileId?: string): MusicTrack[] => {
    const known = new Set(folders().map((f) => f.id))
    let allowed: Set<string> | null = null
    if (profileId) {
      const ids = ctx.profiles.get(profileId)?.musicFolderIds ?? []
      if (ids.length) allowed = new Set(ids)
    }
    return load()
      .tracks.filter((t) => known.has(t.folderId) && (!allowed || allowed.has(t.folderId)))
      .map(strip)
  }

  return {
    folders,
    async addFolder(path: string) {
      const abs = resolve(path)
      if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`The folder ${path} cannot be found.`)
      const current = folders()
      const id = folderId(abs)
      if (!current.some((f) => f.id === id)) {
        const folder: MusicFolder = { id, path: abs, name: basename(abs) || abs }
        ctx.settings.update({ musicFolders: [...current, folder] })
        await scanFolder(folder)
        load().scannedAt = new Date().toISOString()
        save()
        ctx.appLog.write('app', `Music folder added: ${abs}`)
      }
      return folders()
    },
    removeFolder(id: string) {
      const remaining = folders().filter((f) => f.id !== id)
      ctx.settings.update({ musicFolders: remaining })
      const idx = load()
      idx.tracks = idx.tracks.filter((t) => t.folderId !== id)
      save()
      return remaining
    },
    list,
    search: (query: string, profileId?: string) => searchTracks(list(profileId), query),
    rescan
  }
}
