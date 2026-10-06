/**
 * Settings, channel profiles, secrets and the recent-projects list. All of it lives in the data
 * folder (%APPDATA%/AI Video Editor), which app updates never touch.
 *
 * Settings and profiles follow the project rules: a format version, an upgrade one step at a time,
 * a backup copy before any upgrade, unknown fields kept, and atomic writes.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { SETTINGS_FORMAT_VERSION } from '@shared/appInfo'
import { upgradeProfile, upgradeSettings } from '@shared/migrations'
import { ProfileSchema, SettingsSchema, newProfile, type Profile, type Settings } from '@shared/settings'
import type { RecentProject } from '@shared/ipc'
import type { AppContext, ProfileService, RecentService, SecretsService, SettingsService } from '../context'
import { registerSecret } from '../log'
import { paths } from '../paths'
import { newId, readJson, writeJsonAtomic } from '../project/store'

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** Keep a copy of a settings or profile file in the data folder's backups/ before it is upgraded. */
function backupBeforeUpgrade(file: string, label: string, fromVersion: number): string {
  const dir = join(paths.data, 'backups')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, `${label}.format${fromVersion}.${stamp()}.json`)
  copyFileSync(file, out)
  return out
}

function log(ctx: AppContext, msg: string, data?: unknown): void {
  try {
    ctx.appLog.write('app', msg, data)
  } catch {
    // The app log may not exist yet very early in startup.
  }
}

// ------------------------------------------------------------------ settings

export function createSettingsService(ctx: AppContext): SettingsService {
  let cache: Settings | null = null
  /** A settings file written by a newer app: used, never overwritten. */
  let readOnly = false
  const listeners = new Set<(s: Settings) => void>()

  function load(): Settings {
    if (cache) return cache
    const file = paths.settingsFile
    if (!existsSync(file)) {
      cache = SettingsSchema.parse({ formatVersion: SETTINGS_FORMAT_VERSION })
      writeJsonAtomic(file, cache)
      return cache
    }
    let raw: Record<string, unknown>
    try {
      raw = readJson(file)
    } catch (err) {
      // A damaged file is kept beside the new one so nothing is lost.
      const keep = join(paths.data, 'backups', `settings.damaged.${stamp()}.json`)
      mkdirSync(dirname(keep), { recursive: true })
      copyFileSync(file, keep)
      log(ctx, 'settings.json could not be read; started from defaults', { error: String(err), kept: keep })
      cache = SettingsSchema.parse({ formatVersion: SETTINGS_FORMAT_VERSION })
      writeJsonAtomic(file, cache)
      return cache
    }
    const up = upgradeSettings(raw)
    if (up.newer) {
      readOnly = true
      log(ctx, `Settings were saved by a newer version of the app (format ${up.from}); changes will not be saved until you update`)
      const parsed = SettingsSchema.safeParse(raw)
      cache = parsed.success ? parsed.data : SettingsSchema.parse({})
      return cache
    }
    if (up.upgraded) {
      const backup = backupBeforeUpgrade(file, 'settings', up.from)
      log(ctx, `Settings upgraded from format ${up.from} to ${up.to}`, { backup })
    }
    const parsed = SettingsSchema.safeParse(up.doc)
    if (!parsed.success) {
      const keep = backupBeforeUpgrade(file, 'settings.invalid', up.from)
      log(ctx, 'settings.json did not match the settings format; started from defaults', { kept: keep })
      cache = SettingsSchema.parse({ formatVersion: SETTINGS_FORMAT_VERSION })
    } else {
      cache = parsed.data
    }
    if (up.upgraded || !parsed.success) writeJsonAtomic(file, cache)
    return cache
  }

  return {
    get() {
      return structuredClone(load())
    },
    update(patch) {
      const current = load()
      const next = SettingsSchema.parse({ ...current, ...patch, formatVersion: current.formatVersion })
      cache = next
      if (!readOnly) writeJsonAtomic(paths.settingsFile, next)
      for (const cb of listeners) {
        try {
          cb(structuredClone(next))
        } catch (err) {
          log(ctx, 'A settings listener failed', { error: String(err) })
        }
      }
      return structuredClone(next)
    },
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}

// ------------------------------------------------------------------ profiles

const FIRST_PROFILE_NAME = 'My channel'

export function createProfileService(ctx: AppContext): ProfileService {
  let cache: Map<string, Profile> | null = null
  const readOnlyIds = new Set<string>()

  const fileFor = (id: string) => join(paths.profilesDir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)

  function readOne(file: string): Profile | null {
    let raw: Record<string, unknown>
    try {
      raw = readJson(file)
    } catch (err) {
      log(ctx, `Profile file could not be read: ${basename(file)}`, { error: String(err) })
      return null
    }
    const up = upgradeProfile(raw)
    if (up.newer) {
      const parsed = ProfileSchema.safeParse(raw)
      if (!parsed.success) return null
      readOnlyIds.add(parsed.data.id)
      log(ctx, `Profile "${parsed.data.name}" was saved by a newer version of the app; it opens read-only`)
      return parsed.data
    }
    if (up.upgraded) {
      const backup = backupBeforeUpgrade(file, `profile-${basename(file, '.json')}`, up.from)
      log(ctx, `Profile upgraded from format ${up.from} to ${up.to}`, { file: basename(file), backup })
    }
    const parsed = ProfileSchema.safeParse(up.doc)
    if (!parsed.success) {
      log(ctx, `Profile file does not match the profile format: ${basename(file)}`, {
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`)
      })
      return null
    }
    if (up.upgraded) writeJsonAtomic(file, parsed.data)
    return parsed.data
  }

  function load(): Map<string, Profile> {
    if (cache) return cache
    cache = new Map()
    mkdirSync(paths.profilesDir, { recursive: true })
    for (const f of readdirSync(paths.profilesDir).filter((f) => f.endsWith('.json')).sort()) {
      const p = readOne(join(paths.profilesDir, f))
      if (p) cache.set(p.id, p)
    }
    if (cache.size === 0) {
      const first = newProfile(newId('prof'), FIRST_PROFILE_NAME)
      writeJsonAtomic(fileFor(first.id), first)
      cache.set(first.id, first)
      log(ctx, `Created the first profile "${FIRST_PROFILE_NAME}"`)
    }
    return cache
  }

  function write(profile: Profile): Profile {
    const map = load()
    const parsed = ProfileSchema.parse(profile)
    if (readOnlyIds.has(parsed.id)) {
      throw new Error(`The profile "${parsed.name}" was saved by a newer version of the app. Update the app to change it.`)
    }
    writeJsonAtomic(fileFor(parsed.id), parsed)
    map.set(parsed.id, parsed)
    return structuredClone(parsed)
  }

  return {
    list() {
      return [...load().values()].map((p) => structuredClone(p)).sort((a, b) => a.name.localeCompare(b.name))
    },
    get(id) {
      const p = load().get(id)
      return p ? structuredClone(p) : null
    },
    save(profile) {
      // Unknown fields on the stored profile are kept even if the window sent a partial copy.
      const existing = load().get(profile.id)
      return write({ ...(existing ?? {}), ...profile } as Profile)
    },
    create(name) {
      const trimmed = name.trim() || FIRST_PROFILE_NAME
      const p = write(newProfile(newId('prof'), trimmed))
      log(ctx, `Profile created: ${trimmed}`)
      return p
    },
    delete(id) {
      const map = load()
      const p = map.get(id)
      if (!p) return
      rmSync(fileFor(id), { force: true })
      map.delete(id)
      log(ctx, `Profile deleted: ${p.name}`)
      if (map.size === 0) {
        // There is always at least one profile to make projects with.
        cache = null
        load()
      }
    }
  }
}

// ------------------------------------------------------------------ secrets

/** The parts of Electron's safeStorage the secrets store uses (Windows DPAPI on Windows). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

type SecretName = 'pikzels' | 'mcpToken' | 'githubToken'

interface SecretsFile {
  formatVersion: 1
  values: Partial<Record<SecretName, string>> // base64 of the encrypted bytes
}

export function createSecretsService(ctx: AppContext, safeStorage: SafeStorageLike): SecretsService {
  let cache: SecretsFile | null = null

  function load(): SecretsFile {
    if (cache) return cache
    try {
      const raw = existsSync(paths.secretsFile) ? readJson<SecretsFile>(paths.secretsFile) : null
      cache = raw && typeof raw.values === 'object' && raw.values ? { formatVersion: 1, values: { ...raw.values } } : { formatVersion: 1, values: {} }
    } catch {
      log(ctx, 'The saved keys file could not be read; keys need to be entered again')
      cache = { formatVersion: 1, values: {} }
    }
    return cache
  }

  return {
    get(name) {
      const stored = load().values[name]
      if (!stored) return null
      try {
        if (!safeStorage.isEncryptionAvailable()) return null
        const value = safeStorage.decryptString(Buffer.from(stored, 'base64'))
        registerSecret(value)
        return value
      } catch {
        log(ctx, `A saved key (${name}) could not be decrypted on this PC; enter it again in Settings`)
        return null
      }
    },
    set(name, value) {
      const file = load()
      if (value === null || value.trim() === '') {
        delete file.values[name]
        writeJsonAtomic(paths.secretsFile, file)
        log(ctx, `Key removed: ${name}`)
        return
      }
      const clean = value.trim()
      registerSecret(clean)
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error(
          'Windows credential protection is not available on this PC, so the key cannot be stored safely. It was not saved.'
        )
      }
      file.values[name] = safeStorage.encryptString(clean).toString('base64')
      writeJsonAtomic(paths.secretsFile, file)
      log(ctx, `Key saved: ${name}`)
    }
  }
}

// ------------------------------------------------------------------ recent projects

interface RecentFile {
  formatVersion: 1
  items: Omit<RecentProject, 'found' | 'thumbnail'>[]
}

const RECENT_LIMIT = 100

export function createRecentService(ctx: AppContext): RecentService {
  function load(): RecentFile {
    try {
      if (existsSync(paths.recentFile)) {
        const raw = readJson<RecentFile>(paths.recentFile)
        if (raw && Array.isArray(raw.items)) return { formatVersion: 1, items: raw.items }
      }
    } catch (err) {
      log(ctx, 'recent.json could not be read; the recent list starts empty', { error: String(err) })
    }
    return { formatVersion: 1, items: [] }
  }

  function save(file: RecentFile): void {
    file.items.sort((a, b) => (b.lastOpened ?? '').localeCompare(a.lastOpened ?? ''))
    file.items = file.items.slice(0, RECENT_LIMIT)
    writeJsonAtomic(paths.recentFile, file)
  }

  /** Accepts a project folder or a path to its project.json. */
  const folderOf = (p: string) => (basename(p).toLowerCase() === 'project.json' ? dirname(p) : p)

  return {
    list() {
      return load()
        .items.map((e) => {
          const cover = join(e.path, 'cache', 'cover.png')
          const entry: RecentProject = { ...e, found: existsSync(join(e.path, 'project.json')) }
          if (existsSync(cover)) entry.thumbnail = cover
          return entry
        })
        .sort((a, b) => b.lastOpened.localeCompare(a.lastOpened))
    },
    touch(entry) {
      const file = load()
      const path = folderOf(entry.path)
      const prev = file.items.find((e) => e.id === entry.id || e.path === path)
      const next = {
        ...(prev ?? {}),
        id: entry.id,
        name: entry.name,
        path,
        profileId: entry.profileId,
        status: entry.status,
        lastOpened: entry.lastOpened ?? new Date().toISOString()
      }
      file.items = file.items.filter((e) => e !== prev && e.id !== entry.id && e.path !== path)
      file.items.push(next)
      save(file)
    },
    remove(id) {
      const file = load()
      file.items = file.items.filter((e) => e.id !== id)
      save(file)
    },
    locate(id, newPath) {
      const file = load()
      const e = file.items.find((x) => x.id === id)
      if (!e) return
      const folder = folderOf(newPath)
      if (!existsSync(join(folder, 'project.json'))) {
        throw new Error('That folder has no project.json. Choose the project folder itself.')
      }
      e.path = folder
      save(file)
      log(ctx, `Project located at a new place`, { id, path: folder })
    }
  }
}
