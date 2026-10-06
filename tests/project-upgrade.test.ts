import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_FORMAT_VERSION, SETTINGS_FORMAT_VERSION } from '@shared/appInfo'
import { SETTINGS_STEPS, PROFILE_STEPS } from '@shared/migrations'
import { TimelineResolver } from '@shared/timeline'
import { isAnchored } from '@shared/project'
import { ProjectStore, ValidationError, readJson } from '../src/main/project/store'
import { createProjectManager } from '../src/main/project/manager'
import { createProfileService, createSettingsService } from '../src/main/services/settings'
import { initPaths } from '../src/main/paths'
import { cleanupTemps, fakeContext, tempDir } from './helpers/project'

afterEach(cleanupTemps)

const FIXTURES = join(__dirname, 'fixtures', 'projects')
const fixtureFolders = readdirSync(FIXTURES).filter((f) => statSync(join(FIXTURES, f)).isDirectory()).sort()

function copyFixture(name: string): string {
  const dir = join(tempDir(), name)
  cpSync(join(FIXTURES, name), dir, { recursive: true })
  return dir
}

describe('sample projects from every released format', () => {
  it('has a sample for every format up to the current one', () => {
    for (let v = 1; v <= PROJECT_FORMAT_VERSION; v++) expect(fixtureFolders).toContain(`format-${v}`)
  })

  for (const name of fixtureFolders) {
    describe(name, () => {
      it('opens, upgrades to the current format and resolves every anchor', () => {
        const dir = copyFixture(name)
        const { store } = ProjectStore.open(dir, '1.0.0')
        expect(store.readOnly).toBe(false)
        expect(store.project.formatVersion).toBe(PROJECT_FORMAT_VERSION)
        const onDisk = readJson(join(dir, 'project.json'))
        expect(onDisk.formatVersion).toBe(PROJECT_FORMAT_VERSION)

        const resolver = new TimelineResolver(store.project, store.transcript)
        expect(resolver.duration).toBeGreaterThan(0)
        for (const item of store.project.items) {
          if (!isAnchored(item) || item.anchor.kind !== 'word') continue
          expect(resolver.anchorTime(item.anchor).orphaned, `${item.id} anchor`).toBe(false)
        }
      })

      it('keeps undo history working after the upgrade, across a reopen', () => {
        const dir = copyFixture(name)
        const { store } = ProjectStore.open(dir, '1.0.0')
        const first = store.project.items.find(isAnchored)!
        const before = first.duration
        store.mutate('Longer', 'user', (d) => {
          const it = d.project.items.find((i) => i.id === first.id)!
          if (isAnchored(it)) it.duration = before + 1
        })
        const { store: again } = ProjectStore.open(dir, '1.0.0')
        expect(again.canUndo).toBe(true)
        again.undo()
        expect(again.project.items.find((i) => i.id === first.id)).toMatchObject({ duration: before })
        expect(again.canRedo).toBe(true)
      })

      it('a newer-format file opens read-only and refuses changes', () => {
        const dir = copyFixture(name)
        const file = join(dir, 'project.json')
        const raw = readJson(file)
        delete raw.version
        raw.formatVersion = PROJECT_FORMAT_VERSION + 7
        raw.fromTheFuture = { hello: 'world' }
        writeFileSync(file, JSON.stringify(raw, null, 2))
        const text = readFileSync(file, 'utf8')

        const { store, upgradedFrom } = ProjectStore.open(dir, '1.0.0')
        expect(upgradedFrom).toBeUndefined()
        expect(store.readOnly).toBe(true)
        expect(store.readOnlyReason).toMatch(/newer version/)
        expect(() => store.mutate('x', 'user', (d) => { d.project.name = 'changed' })).toThrow(ValidationError)
        expect(store.undo()).toBe(false)
        store.flush()
        expect(readFileSync(file, 'utf8')).toBe(text)
      })
    })
  }
})

describe('format 1 (0.x test builds) upgrade loses nothing', () => {
  const open = () => {
    const dir = copyFixture('format-1')
    const original = readFileSync(join(dir, 'project.json'), 'utf8')
    const result = ProjectStore.open(dir, '1.0.0')
    return { dir, original, ...result }
  }

  it('saves the old file in backups/ before upgrading', () => {
    const { dir, original, upgradedFrom, backupFile } = open()
    expect(upgradedFrom).toBe(1)
    expect(backupFile).toBeTruthy()
    expect(backupFile!.startsWith(join(dir, 'backups'))).toBe(true)
    expect(readFileSync(backupFile!, 'utf8')).toBe(original)
    expect(readdirSync(join(dir, 'backups')).some((f) => f.startsWith('project.format1.'))).toBe(true)
  })

  it('converts every field and keeps every item', () => {
    const { store } = open()
    const p = store.project
    expect(p.id).toBe('prj_0x_rc_bash')
    expect(p.name).toBe('RC basher first run')
    expect(p.createdAt).toBe('2026-09-12T18:04:11.000Z')
    expect(p.profileId).toBe('prof_rc')
    expect(p.status).toBe('ready_for_review')
    expect(p.scope).toEqual({ mode: 'whole', introMaxSeconds: null, introEnd: null, introApproved: false })
    expect(p.sources.map((s) => s.id)).toEqual(['src_a', 'src_b', 'src_m'])
    expect(p.items.map((i) => i.id)).toEqual(['seg_1', 'seg_2', 'seg_3', 'clip_jump', 'gfx_title', 'music_bed', 'sfx_whoosh'])

    const byId = Object.fromEntries(p.items.map((i) => [i.id, i])) as Record<string, any>
    expect(byId.seg_1).toMatchObject({ type: 'segment', sourceId: 'src_a', in: 1.2, out: 6.8 })
    expect(byId.seg_2.volume).toBeCloseTo(-0.92, 2) // linear 0.9
    expect(byId.clip_jump).toMatchObject({ anchor: { kind: 'word', wordId: 'w_a_9', offset: 0.25 }, duration: 3.5, in: 2 })
    expect(byId.clip_jump.anchorWord).toBeUndefined()
    expect(byId.gfx_title).toMatchObject({ anchor: { kind: 'word', wordId: 'w_a_1', offset: 0 }, file: 'graphics/title_card.py', params: { text: 'BASHER RUN' } })
    expect(byId.music_bed).toMatchObject({ anchor: { kind: 'time', time: 0 }, duration: 24, duck: true })
    expect(byId.music_bed.volume).toBeCloseTo(-12.04, 2) // linear 0.25
    expect(byId.music_bed.start).toBeUndefined()
    expect(byId.sfx_whoosh).toMatchObject({ anchor: { kind: 'word', wordId: 'w_a_9', offset: -0.1 }, file: 'audio/whoosh.wav' })

    const vol = Object.fromEntries(p.tracks.map((t) => [t.id, t.volume]))
    expect(vol.aroll).toBe(0)
    expect(vol.music).toBeCloseTo(-6.02, 2)
    expect(vol.sfx).toBeCloseTo(-1.94, 2)

    const check = Object.fromEntries(p.checklist.map((c) => [c.id, c.status]))
    expect(check).toMatchObject({ transcript: 'done', cuts: 'done', broll: 'done', graphics: 'in_progress', audio: 'in_progress', thumbnails: 'not_started' })
    expect(p.notes).toHaveLength(2)
    expect(p.notes[0]).toMatchObject({ text: 'Title card felt a bit long', itemId: 'gfx_title', status: 'open' })
    expect(p.notes[1]).toMatchObject({ text: 'Music too loud in the jump', status: 'done' })
    expect(p.transcript.file).toBe('transcript.json')
    expect(store.transcript.clips.src_a.words).toHaveLength(24)
  })

  it('keeps fields it does not know, on disk too', () => {
    const { dir, store } = open()
    const scratch = { model: 'claude', retakes: [['w_a_3', 'w_a_4']], plan: 'Tight cold open, then the jump.' }
    expect((store.project as any).aiScratch).toEqual(scratch)
    expect(readJson(join(dir, 'project.json')).aiScratch).toEqual(scratch)
    store.mutate('Rename', 'user', (d) => { d.project.name = 'Renamed' })
    expect(readJson(join(dir, 'project.json')).aiScratch).toEqual(scratch)
  })

  it('opens without upgrading the second time', () => {
    const { dir } = open()
    const again = ProjectStore.open(dir, '1.0.0')
    expect(again.upgradedFrom).toBeUndefined()
  })

  it('the project manager saves a "Before upgrade" version that still loads', async () => {
    const dir = copyFixture('format-1')
    const ctx = fakeContext()
    ctx.projects = createProjectManager(ctx)
    const store = await ctx.projects.open(dir)
    const versions = ctx.versions.list()
    const v = versions.find((x) => x.name === 'Before upgrade')
    expect(v?.auto).toBe(true)
    const doc = ctx.versions.load(v!.id)
    expect(doc.project.formatVersion).toBe(PROJECT_FORMAT_VERSION)
    expect(doc.project.items).toEqual(store.project.items)
    expect((doc.project as any).aiScratch).toBeTruthy()
    // The version holds the file as the old app wrote it.
    expect(readJson(join(dir, 'versions', v!.id, 'project.json')).version).toBe(1)
  })
})

describe('format 2 (1.0.0)', () => {
  it('opens unchanged, with every unknown field kept', () => {
    const dir = copyFixture('format-2')
    const raw = readJson(join(dir, 'project.json'))
    const rawTranscript = readJson(join(dir, 'transcript.json'))
    const { store, upgradedFrom } = ProjectStore.open(dir, '1.0.0')
    expect(upgradedFrom).toBeUndefined()
    expect(store.project).toEqual(raw)
    expect(store.transcript).toEqual(rawTranscript)
    expect((store.project as any).futureField).toEqual({ addedBy: 'a newer app', keep: [1, 2, 3] })
    expect((store.project.items.find((i) => i.id === 'seg_4') as any).claudeNote).toBe('best take of the outro line')
    expect((store.project.tracks.find((t) => t.id === 'sfx_2') as any).colorTag).toBe('purple')
    expect((store.transcript as any).whisperModel).toBe('large-v3')
    expect(new Set(store.project.items.map((i) => i.type))).toEqual(new Set(['segment', 'clip', 'graphic', 'effect', 'audio']))

    store.mutate('Tweak', 'user', (d) => { d.project.inspiration = 'changed' })
    const saved = readJson(join(dir, 'project.json'))
    expect(saved.futureField).toEqual(raw.futureField)
    expect(saved.items).toEqual(raw.items)
    expect(saved.tracks).toEqual(raw.tracks)
    expect(saved.publish).toEqual(raw.publish)
    expect(readdirSync(join(dir, 'backups')).length).toBeGreaterThan(0)
  })
})

describe('settings and profiles follow the same rules', () => {
  function freshData() {
    const data = tempDir('ave-data-')
    initPaths({ data, runtime: join(data, 'runtime'), resources: data })
    return { data, ctx: fakeContext({ logDir: data }) }
  }

  it('settings keep unknown fields when saved', () => {
    const { data, ctx } = freshData()
    writeFileSync(
      join(data, 'settings.json'),
      JSON.stringify({ formatVersion: SETTINGS_FORMAT_VERSION, defaultProjectsFolder: 'D:\\Videos', mysteryFeature: { a: 1 } })
    )
    const s = createSettingsService(ctx)
    expect(s.get().defaultProjectsFolder).toBe('D:\\Videos')
    s.update({ previewHeight: 720 })
    const saved = readJson(join(data, 'settings.json'))
    expect(saved.previewHeight).toBe(720)
    expect(saved.mysteryFeature).toEqual({ a: 1 })
    expect(saved.defaultProjectsFolder).toBe('D:\\Videos')
  })

  it('settings upgrade one step at a time with a backup, keeping unknown fields', () => {
    const { data, ctx } = freshData()
    // Simulate an older settings format (0) with a step that renames a field.
    SETTINGS_STEPS[0] = (d) => {
      const out: Record<string, any> = { ...d, defaultProjectsFolder: d.projectsDir }
      delete out.projectsDir
      return out
    }
    try {
      const original = JSON.stringify({ formatVersion: 0, projectsDir: 'E:\\Edits', oldThing: [1, 2] })
      writeFileSync(join(data, 'settings.json'), original)
      const s = createSettingsService(ctx)
      expect(s.get().defaultProjectsFolder).toBe('E:\\Edits')
      const saved = readJson(join(data, 'settings.json'))
      expect(saved.formatVersion).toBe(SETTINGS_FORMAT_VERSION)
      expect(saved.oldThing).toEqual([1, 2])
      const backups = readdirSync(join(data, 'backups')).filter((f) => f.startsWith('settings.format0.'))
      expect(backups).toHaveLength(1)
      expect(readFileSync(join(data, 'backups', backups[0]), 'utf8')).toBe(original)
    } finally {
      delete SETTINGS_STEPS[0]
    }
  })

  it('newer settings are used but never overwritten', () => {
    const { data, ctx } = freshData()
    const text = JSON.stringify({ formatVersion: SETTINGS_FORMAT_VERSION + 3, previewHeight: 360, newer: true })
    writeFileSync(join(data, 'settings.json'), text)
    const s = createSettingsService(ctx)
    expect(s.get().previewHeight).toBe(360)
    s.update({ previewHeight: 720 })
    expect(readFileSync(join(data, 'settings.json'), 'utf8')).toBe(text)
  })

  it('profiles keep unknown fields, upgrade with a backup, and a first profile is created', () => {
    const { data, ctx } = freshData()
    const empty = createProfileService(ctx)
    expect(empty.list().map((p) => p.name)).toEqual(['My channel'])

    PROFILE_STEPS[0] = (d) => ({ ...d, channelNotes: d.notes ?? '' })
    try {
      writeFileSync(
        join(data, 'profiles', 'prof_rc.json'),
        JSON.stringify({ formatVersion: 0, id: 'prof_rc', name: 'RC cars', notes: 'Loud and fast', channelMascot: { name: 'Bolt' } })
      )
      const profiles = createProfileService(ctx)
      const rc = profiles.get('prof_rc')!
      expect(rc.channelNotes).toBe('Loud and fast')
      expect((rc as any).channelMascot).toEqual({ name: 'Bolt' })
      expect(readdirSync(join(data, 'backups')).some((f) => f.startsWith('profile-prof_rc.format0.'))).toBe(true)

      profiles.save({ ...rc, color: '#00FF00' })
      const saved = readJson(join(data, 'profiles', 'prof_rc.json'))
      expect(saved.color).toBe('#00FF00')
      expect(saved.channelMascot).toEqual({ name: 'Bolt' })
      expect(saved.formatVersion).toBe(SETTINGS_FORMAT_VERSION)
      expect(existsSync(join(data, 'profiles', 'prof_rc.json'))).toBe(true)
    } finally {
      delete PROFILE_STEPS[0]
    }
  })
})
