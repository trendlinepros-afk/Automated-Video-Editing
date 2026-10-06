import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppContext } from '../src/main/context'
import { ActivityLog } from '../src/main/log'
import { createMusicService, searchTracks } from '../src/main/services/music'
import type { MusicFolder, Settings } from '@shared/settings'

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

let root: string
let master: string

function tone(file: string, seconds: number): void {
  mkdirSync(join(file, '..'), { recursive: true })
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-ac', '1', '-ar', '8000', file])
}

function fakeContext() {
  let settings = { musicFolders: [] as MusicFolder[] } as unknown as Settings
  const profiles: Record<string, { musicFolderIds: string[] }> = {}
  const ctx = {
    appLog: new ActivityLog(join(root, 'app.log')),
    settings: {
      get: () => settings,
      update: (patch: Partial<Settings>) => (settings = { ...settings, ...patch })
    },
    profiles: { get: (id: string) => profiles[id] ?? null },
    env: { ffprobe: () => 'ffprobe' }
  } as unknown as AppContext
  return { ctx, profiles }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ave-music-'))
  master = join(root, 'Music')
  if (!hasFfmpeg) return
  tone(join(master, 'intro sting.wav'), 0.5)
  tone(join(master, 'upbeat', 'Happy Drive.wav'), 1)
  tone(join(master, 'upbeat', 'chill', 'Sunset Cruise.wav'), 1.5)
  tone(join(master, 'dark', 'Tension Build.wav'), 0.75)
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe.skipIf(!hasFfmpeg)('music index', () => {
  it('indexes a master folder with subfolder names, lengths and formats', async () => {
    const { ctx } = fakeContext()
    const music = createMusicService(ctx, { indexFile: join(root, 'index-a.json') })
    const folders = await music.addFolder(master)
    expect(folders).toHaveLength(1)
    expect(folders[0].name).toBe('Music')

    const tracks = music.list()
    expect(tracks.map((t) => `${t.folder}|${t.name}`).sort()).toEqual(['dark|Tension Build', 'upbeat/chill|Sunset Cruise', 'upbeat|Happy Drive', '|intro sting'])
    const sunset = tracks.find((t) => t.name === 'Sunset Cruise')!
    expect(sunset.duration).toBeCloseTo(1.5, 1)
    expect(sunset.format).toBe('wav')
    expect(sunset.missing).toBe(false)
    expect(sunset.folderId).toBe(folders[0].id)
    expect(existsSync(join(root, 'index-a.json'))).toBe(true)

    // Adding the same folder twice does not duplicate it.
    expect(await music.addFolder(master)).toHaveLength(1)
  })

  it('rescan picks up new files and flags missing ones instead of dropping them', async () => {
    const { ctx } = fakeContext()
    const music = createMusicService(ctx, { indexFile: join(root, 'index-b.json') })
    await music.addFolder(master)
    const gone = join(master, 'dark', 'Tension Build.wav')
    const before = statSync(join(master, 'upbeat', 'Happy Drive.wav')).mtimeMs
    rmSync(gone)
    tone(join(master, 'upbeat', 'chill', 'Late Night.wav'), 1)

    const tracks = await music.rescan()
    const tension = tracks.find((t) => t.name === 'Tension Build')
    expect(tension?.missing).toBe(true)
    expect(tracks.find((t) => t.name === 'Late Night')?.folder).toBe('upbeat/chill')
    expect(tracks.filter((t) => !t.missing)).toHaveLength(4)
    // Read-only: the library never touches the files.
    expect(statSync(join(master, 'upbeat', 'Happy Drive.wav')).mtimeMs).toBe(before)

    // A fresh service reads the saved index, flags included.
    const again = createMusicService(ctx, { indexFile: join(root, 'index-b.json') })
    expect(again.list().find((t) => t.name === 'Tension Build')?.missing).toBe(true)

    // When the file comes back it is no longer flagged.
    tone(gone, 0.75)
    expect((await again.rescan()).find((t) => t.name === 'Tension Build')?.missing).toBe(false)
    const saved = JSON.parse(readFileSync(join(root, 'index-b.json'), 'utf8'))
    expect(saved.tracks.length).toBe(5)
  })

  it('filters by profile folders and searches names and folder words', async () => {
    const { ctx, profiles } = fakeContext()
    const music = createMusicService(ctx, { indexFile: join(root, 'index-c.json') })
    const second = join(root, 'Other')
    tone(join(second, 'calm', 'Piano Loop.wav'), 0.5)
    const [a, b] = await music.addFolder(master).then(() => music.addFolder(second))
    profiles.rc = { musicFolderIds: [b.id] }
    profiles.all = { musicFolderIds: [] }
    expect(music.list('rc').map((t) => t.name)).toEqual(['Piano Loop'])
    expect(music.list('all').length).toBe(music.list().length)

    expect(music.search('chill').map((t) => t.name)).toEqual(expect.arrayContaining(['Sunset Cruise', 'Late Night']))
    expect(music.search('upbeat drive').map((t) => t.name)).toEqual(['Happy Drive'])
    expect(music.search('piano', 'rc').map((t) => t.name)).toEqual(['Piano Loop'])
    expect(music.search('chill', 'rc')).toEqual([])

    music.removeFolder(b.id)
    expect(music.list().every((t) => t.folderId === a.id)).toBe(true)
  })
})

describe('music search ranking', () => {
  it('prefers tracks matching every word, then partial matches', () => {
    const t = (name: string, folder: string) => ({ path: `/m/${folder}/${name}.mp3`, name, folderId: 'f', folder, duration: 1, format: 'mp3', missing: false })
    const tracks = [t('Night Drive', 'synthwave'), t('Morning Coffee', 'chill'), t('Chill Night', 'lofi')]
    expect(searchTracks(tracks, 'night chill').map((x) => x.name)).toEqual(['Chill Night'])
    expect(searchTracks(tracks, 'night jazz').map((x) => x.name).sort()).toEqual(['Chill Night', 'Night Drive'])
    expect(searchTracks(tracks, '')).toHaveLength(3)
  })
})
