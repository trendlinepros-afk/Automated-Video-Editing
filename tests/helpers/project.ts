/**
 * Test helpers: a temporary project with real footage-like data, and an AppContext with just enough
 * services for the project modules (no Electron).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectSettingsSchema, type Word } from '@shared/project'
import { newProfile, type CorrectionKind, type Profile } from '@shared/settings'
import type { AppContext } from '../../src/main/context'
import { ActivityLog } from '../../src/main/log'
import { ProjectStore } from '../../src/main/project/store'
import { createRequestService } from '../../src/main/project/requests'
import { createVersionService } from '../../src/main/project/versions'

const temps: string[] = []

export function tempDir(prefix = 'ave-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

export function cleanupTemps(): void {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
}

/** Words every 0.5 s across a 60 s clip: w0 at 0.0, w1 at 0.5, ... */
export function words(sourceId: string, count = 120): Word[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${sourceId}_w${i}`, text: `word${i}`, start: i * 0.5, end: i * 0.5 + 0.4 }))
}

/**
 * A project with four A-roll pieces (timeline 0–10, 10–18, 18–26, 26–34) and items around them.
 * Word ids are "src_a_w<n>" with word n at source time n*0.5.
 */
export function makeProject(dir = tempDir()): ProjectStore {
  const store = ProjectStore.create(dir, {
    name: 'Test project',
    profileId: 'prof_test',
    footageFolder: dir,
    settings: ProjectSettingsSchema.parse({}),
    thumbnails: { personaId: '', styleId: '', count: 3, direction: '' },
    appVersion: '1.0.0'
  })
  store.mutate('Setup', 'claude', (d) => {
    d.project.sources.push({ id: 'src_a', path: join(dir, 'A001.mp4'), kind: 'video', duration: 100, hasAudio: true, origin: 'footage' })
    d.transcript.clips.src_a = { language: 'en', words: words('src_a') }
    const seg = (id: string, a: number, b: number) => ({
      id, trackId: 'aroll', createdBy: 'claude' as const, type: 'segment' as const, sourceId: 'src_a',
      in: a, out: b, speed: 1, volume: 0, fadeIn: 0, fadeOut: 0
    })
    d.project.items.push(
      seg('seg_1', 0, 10),
      seg('seg_2', 12, 20),
      seg('seg_3', 22, 30),
      seg('seg_4', 32, 40),
      // B-roll at word 4 (source 2.0 -> timeline 2.0): before the section
      { id: 'clip_before', trackId: 'broll', createdBy: 'claude', type: 'clip', sourceId: 'src_a', anchor: { kind: 'word', wordId: 'src_a_w4', offset: 0 }, duration: 2, in: 50, speed: 1, volume: -120, fadeIn: 0, fadeOut: 0 },
      // Graphic at word 28 (source 14.0 -> timeline 12.0): inside the section 10–18
      { id: 'gfx_inside', trackId: 'graphics', createdBy: 'claude', type: 'graphic', file: 'graphics/a.py', anchor: { kind: 'word', wordId: 'src_a_w28', offset: 0 }, duration: 2, params: {} },
      // Sound pinned to a fixed time after the section
      { id: 'sfx_time', trackId: 'sfx', createdBy: 'claude', type: 'audio', file: 'audio/pop.wav', anchor: { kind: 'time', time: 30 }, duration: 0.5, in: 0, volume: 0, fadeIn: 0, fadeOut: 0, duck: false, loop: false },
      // Graphic at word 66 (source 33.0 -> timeline 27.0): after the section
      { id: 'gfx_after', trackId: 'graphics', createdBy: 'claude', type: 'graphic', file: 'graphics/b.py', anchor: { kind: 'word', wordId: 'src_a_w66', offset: 0 }, duration: 2, params: {} },
      // Music across the whole video
      { id: 'music_bed', trackId: 'music', createdBy: 'claude', type: 'audio', file: 'audio/music.wav', anchor: { kind: 'time', time: 0 }, duration: 34, in: 0, volume: -6, fadeIn: 0, fadeOut: 0, duck: true, loop: false }
    )
  })
  return store
}

export interface FakeContext extends AppContext {
  sent: { channel: string; payload: unknown }[]
  recorded: { kind: CorrectionKind; projectId: string; profileId: string }[]
  setStore(s: ProjectStore | null): void
}

/** An AppContext with real requests and versions services and simple fakes for the rest. */
export function fakeContext(opts: { store?: ProjectStore | null; logDir?: string; profiles?: Profile[] } = {}): FakeContext {
  let store = opts.store ?? null
  const profiles = new Map((opts.profiles ?? [newProfile('prof_test', 'Test channel')]).map((p) => [p.id, structuredClone(p)]))
  const ctx = {
    appVersion: '1.0.0',
    isPackaged: false,
    appLog: new ActivityLog(join(opts.logDir ?? tempDir(), 'app.log')),
    sent: [] as { channel: string; payload: unknown }[],
    recorded: [] as { kind: CorrectionKind; projectId: string; profileId: string }[],
    setStore(s: ProjectStore | null) {
      store = s
    },
    send(channel: string, payload: unknown) {
      ctx.sent.push({ channel, payload })
    },
    settings: {
      get: () => ({ runner: { autoStart: false } }),
      update: () => {
        throw new Error('not in tests')
      },
      onChange: () => () => undefined
    },
    profiles: {
      list: () => [...profiles.values()].map((p) => structuredClone(p)),
      get: (id: string) => (profiles.has(id) ? structuredClone(profiles.get(id)!) : null),
      save: (p: Profile) => {
        profiles.set(p.id, structuredClone(p))
        return p
      },
      create: (name: string) => newProfile(`prof_${name}`, name),
      delete: (id: string) => void profiles.delete(id)
    },
    recent: { list: () => [], touch: () => undefined, remove: () => undefined, locate: () => undefined },
    projects: {
      current: () => store,
      open: async () => {
        throw new Error('not in tests')
      },
      create: async () => {
        throw new Error('not in tests')
      },
      close: async () => undefined,
      onOpened: () => () => undefined,
      missingSources: () => []
    },
    corrections: {
      record: (kind: CorrectionKind, projectId: string, profileId: string) => ctx.recorded.push({ kind, projectId, profileId }),
      suggestions: () => [],
      answer: () => undefined
    },
    runner: { kick: () => undefined },
    preview: { invalidate: () => undefined },
    engine: {
      probe: async () => {
        throw new Error('engine not available in tests')
      },
      frame: async () => {
        throw new Error('engine not available in tests')
      }
    }
  } as unknown as FakeContext
  ctx.versions = createVersionService(ctx)
  ctx.requests = createRequestService(ctx)
  return ctx
}
