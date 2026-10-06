/**
 * Named versions: saved snapshots of the whole edit. A version holds project.json, transcript.json
 * and a copy of graphics/ (never footage), in <project>/versions/<id>/, listed in versions/index.json.
 *
 * Automatic versions are trimmed to the newest 20. Named versions are kept until deleted.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { upgradeProject } from '@shared/migrations'
import { ProjectSchema, TranscriptSchema, emptyTranscript, type ProjectDoc } from '@shared/project'
import type { VersionInfo } from '@shared/ipc'
import type { AppContext, VersionService } from '../context'
import { newId, readJson, writeJsonAtomic, type ProjectStore } from './store'

export const AUTO_VERSION_LIMIT = 20

/**
 * Conversation and bookkeeping that a restore leaves as it is: restoring the edit must not erase
 * the chat, the request queue (with its Before/After reviews), notes or Claude's handoff notes.
 */
const KEPT_ON_RESTORE = ['requests', 'chat', 'notes', 'handoffNotes', 'lock'] as const

interface VersionIndex {
  formatVersion: 1
  versions: VersionInfo[]
}

const indexFile = (store: ProjectStore) => join(store.paths.versions, 'index.json')

export function readIndex(store: ProjectStore): VersionIndex {
  try {
    if (existsSync(indexFile(store))) {
      const raw = readJson<VersionIndex>(indexFile(store))
      if (raw && Array.isArray(raw.versions)) return { formatVersion: 1, versions: raw.versions }
    }
  } catch {
    store.log.write('error', 'versions/index.json could not be read; rebuilding the list from the folders')
  }
  // Rebuild from whatever version folders exist, so a damaged index loses nothing.
  const versions: VersionInfo[] = []
  if (existsSync(store.paths.versions)) {
    for (const name of readdirSync(store.paths.versions)) {
      const dir = join(store.paths.versions, name)
      if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'project.json'))) continue
      versions.push({ id: name, name: `Recovered ${name}`, createdAt: statSync(dir).mtime.toISOString(), auto: false })
    }
  }
  return { formatVersion: 1, versions }
}

function writeIndex(store: ProjectStore, index: VersionIndex): void {
  mkdirSync(store.paths.versions, { recursive: true })
  index.versions.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  writeJsonAtomic(indexFile(store), index)
}

function copyGraphics(from: string, to: string): void {
  if (!existsSync(from)) return
  cpSync(from, to, { recursive: true, force: true })
}

/**
 * Save a version. `projectText` lets a caller store a file exactly as it was on disk (the backup
 * made before an upgrade); otherwise the store's current document is saved.
 */
export function saveVersion(
  store: ProjectStore,
  name: string,
  opts: { auto?: boolean; reason?: string; projectText?: string } = {}
): VersionInfo {
  const id = newId('ver')
  const dir = join(store.paths.versions, id)
  mkdirSync(dir, { recursive: true })
  const doc = store.snapshotDoc()
  if (opts.projectText !== undefined) writeFileSync(join(dir, 'project.json'), opts.projectText)
  else writeJsonAtomic(join(dir, 'project.json'), doc.project)
  writeJsonAtomic(join(dir, 'transcript.json'), doc.transcript)
  copyGraphics(store.paths.graphics, join(dir, 'graphics'))

  const info: VersionInfo = { id, name: name.trim() || 'Untitled version', createdAt: new Date().toISOString(), auto: !!opts.auto }
  if (opts.reason) info.reason = opts.reason
  const index = readIndex(store)
  index.versions.push(info)
  // Trim automatic versions to the newest 20; named versions stay until deleted.
  const autos = index.versions.filter((v) => v.auto).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  for (const old of autos.slice(0, Math.max(0, autos.length - AUTO_VERSION_LIMIT))) {
    rmSync(join(store.paths.versions, old.id), { recursive: true, force: true })
    index.versions = index.versions.filter((v) => v.id !== old.id)
  }
  writeIndex(store, index)
  store.log.write('version', `Version saved: ${info.name}`, { id, auto: info.auto, reason: info.reason })
  return info
}

/** A version's document, upgraded to the current format if it was saved by an older app. */
export function loadVersion(store: ProjectStore, id: string): ProjectDoc {
  const dir = join(store.paths.versions, id)
  const file = join(dir, 'project.json')
  if (!/^[A-Za-z0-9_-]+$/.test(id) || !existsSync(file)) throw new Error('That version no longer exists.')
  const up = upgradeProject(readJson(file))
  if (up.newer) throw new Error('That version was saved by a newer version of the app. Update the app to restore it.')
  const project = ProjectSchema.parse(up.doc)
  const tFile = join(dir, 'transcript.json')
  const parsed = existsSync(tFile) ? TranscriptSchema.safeParse(readJson(tFile)) : null
  return { project, transcript: parsed?.success ? parsed.data : emptyTranscript() }
}

export function restoreVersion(store: ProjectStore, id: string): VersionInfo {
  const info = readIndex(store).versions.find((v) => v.id === id)
  const target = loadVersion(store, id)
  // Restoring first saves the current state, so a restore can always be reversed.
  const safety = saveVersion(store, `Before restoring "${info?.name ?? id}"`, { auto: true, reason: 'restore' })
  const current = store.snapshotDoc()
  const next: ProjectDoc = structuredClone(target)
  // The project keeps its identity and its conversation; only the edit itself goes back.
  next.project.id = current.project.id
  next.project.formatVersion = current.project.formatVersion
  next.project.transcript = current.project.transcript
  for (const key of KEPT_ON_RESTORE) (next.project as Record<string, unknown>)[key] = structuredClone(current.project[key])
  copyGraphics(join(store.paths.versions, id, 'graphics'), store.paths.graphics)
  store.replaceDoc(`Restore version "${info?.name ?? id}"`, next, 'user')
  store.log.write('version', `Version restored: ${info?.name ?? id}`, { id, savedCurrentAs: safety.id })
  return safety
}

export function removeVersion(store: ProjectStore, id: string): void {
  const index = readIndex(store)
  const info = index.versions.find((v) => v.id === id)
  if (/^[A-Za-z0-9_-]+$/.test(id)) rmSync(join(store.paths.versions, id), { recursive: true, force: true })
  index.versions = index.versions.filter((v) => v.id !== id)
  writeIndex(store, index)
  store.log.write('version', `Version deleted: ${info?.name ?? id}`, { id })
}

export function createVersionService(ctx: AppContext): VersionService {
  const store = (): ProjectStore => {
    const s = ctx.projects.current()
    if (!s) throw new Error('No project is open.')
    return s
  }
  return {
    list() {
      return readIndex(store()).versions.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },
    save(name, opts) {
      return saveVersion(store(), name, opts)
    },
    restore(id) {
      restoreVersion(store(), id)
    },
    remove(id) {
      removeVersion(store(), id)
    },
    load(id) {
      return loadVersion(store(), id)
    }
  }
}
