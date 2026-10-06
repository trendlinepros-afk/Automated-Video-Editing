/**
 * The open project. Every change, from Claude or from you, goes through mutate():
 * it is checked against the project format (and the section lock), added to undo history,
 * written to disk at once, logged, and announced to the window.
 */
import { EventEmitter } from 'node:events'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import jsonpatch from 'fast-json-patch'
import type { Operation } from 'fast-json-patch'
import { ENGINE_VERSION, PROJECT_FORMAT_VERSION } from '@shared/appInfo'
import { upgradeProject } from '@shared/migrations'
import {
  ProjectSchema,
  TranscriptSchema,
  defaultChecklist,
  defaultTracks,
  emptyTranscript,
  type Project,
  type ProjectDoc,
  type ProjectSettings,
  type Transcript
} from '@shared/project'
import type { ChangeSource } from '@shared/ipc'
import { ActivityLog } from '../log'
import { projectPaths } from '../paths'
import { checkLock, shiftAfterRange } from './lock'

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString('hex')}`
}

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly details: string[] = []
  ) {
    super(details.length ? `${message}: ${details.join('; ')}` : message)
  }
}

interface HistoryEntry {
  id: string
  label: string
  source: ChangeSource
  ts: string
  forward: Operation[]
  backward: Operation[]
}

interface HistoryFile {
  formatVersion: 1
  undo: HistoryEntry[]
  redo: HistoryEntry[]
}

const HISTORY_LIMIT = 300
const BACKUP_LIMIT = 30

export interface ChangeEvent {
  source: ChangeSource
  label: string
  changedItemIds: string[]
}

export interface MutateOptions {
  /** Skip the section lock (used for the app's own bookkeeping, such as request status). */
  bypassLock?: boolean
  /** Do not add to undo history (request queue and chat bookkeeping). */
  noHistory?: boolean
}

/** Atomic write: a crash mid-write never leaves a half-written project.json. */
export function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  renameSync(tmp, file)
}

export function readJson<T = any>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export interface OpenResult {
  store: ProjectStore
  upgradedFrom?: number
  backupFile?: string
}

export class ProjectStore extends EventEmitter {
  private doc: ProjectDoc
  private history: HistoryFile = { formatVersion: 1, undo: [], redo: [] }
  private savedProjectText = ''
  private savedTranscriptText = ''
  readonly log: ActivityLog
  readonly paths: ReturnType<typeof projectPaths>

  private constructor(
    readonly dir: string,
    doc: ProjectDoc,
    readonly readOnly: boolean,
    readonly readOnlyReason: string | undefined,
    private readonly appVersion: string
  ) {
    super()
    this.doc = doc
    this.paths = projectPaths(dir)
    this.log = new ActivityLog(this.paths.activityLog)
  }

  // ---------------------------------------------------------------- open / create

  static create(
    dir: string,
    opts: {
      name: string
      profileId: string
      footageFolder: string
      settings: ProjectSettings
      thumbnails: { personaId: string; styleId: string; count: number; direction: string }
      appVersion: string
    }
  ): ProjectStore {
    mkdirSync(dir, { recursive: true })
    const p = projectPaths(dir)
    for (const d of [p.graphics, p.audio, p.media, p.thumbnails, p.exports, p.cache, p.logs, p.backups, p.history, p.versions]) {
      mkdirSync(d, { recursive: true })
    }
    const now = new Date().toISOString()
    const preset = opts.settings.exportPreset
    const project: Project = ProjectSchema.parse({
      formatVersion: PROJECT_FORMAT_VERSION,
      id: newId('prj'),
      name: opts.name,
      createdAt: now,
      updatedAt: now,
      appVersion: opts.appVersion,
      engineVersion: ENGINE_VERSION,
      profileId: opts.profileId,
      footageFolder: opts.footageFolder,
      status: 'new',
      inspiration: '',
      scope: { mode: 'whole', introMaxSeconds: null, introEnd: null, introApproved: false },
      output: { width: preset.width, height: preset.height, fps: preset.fps },
      settings: opts.settings,
      sources: [],
      transcript: { file: 'transcript.json' },
      tracks: defaultTracks(),
      items: [],
      checklist: defaultChecklist(),
      captions: { enabled: true },
      thumbnails: { ...opts.thumbnails, useMyDirection: false, format: '16:9', items: [] },
      publish: { titles: [], description: '', chapters: [], tags: [] },
      lock: null
    })
    const store = new ProjectStore(dir, { project, transcript: emptyTranscript() }, false, undefined, opts.appVersion)
    store.flush()
    store.saveHistory()
    store.log.write('app', `Project created: ${opts.name}`, { dir, profileId: opts.profileId })
    return store
  }

  static open(dir: string, appVersion: string): OpenResult {
    const p = projectPaths(dir)
    if (!existsSync(p.file)) throw new Error(`No project.json in ${dir}`)
    const raw = readJson(p.file)
    const up = upgradeProject(raw)
    let backupFile: string | undefined
    for (const d of [p.graphics, p.audio, p.media, p.thumbnails, p.exports, p.cache, p.logs, p.backups, p.history, p.versions]) {
      mkdirSync(d, { recursive: true })
    }

    if (up.newer) {
      const parsed = ProjectSchema.safeParse(raw)
      const project = (parsed.success ? parsed.data : raw) as Project
      const transcript = ProjectStore.readTranscript(dir, project)
      const store = new ProjectStore(
        dir,
        { project, transcript },
        true,
        `This project was saved by a newer version of the app (format ${up.from}). It is open read-only. Update the app to edit it.`,
        appVersion
      )
      store.log.write('upgrade', `Opened read-only: project format ${up.from} is newer than ${PROJECT_FORMAT_VERSION}`)
      return { store }
    }

    if (up.upgraded) {
      // Keep the old file before touching anything. An upgrade never deletes data.
      backupFile = join(p.backups, `project.format${up.from}.${stamp()}.json`)
      copyFileSync(p.file, backupFile)
    } else {
      ProjectStore.rotateBackup(dir)
    }

    const parsed = ProjectSchema.safeParse(up.doc)
    if (!parsed.success) {
      throw new ValidationError(
        'project.json does not match the project format',
        parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`)
      )
    }
    const project = parsed.data
    const transcript = ProjectStore.readTranscript(dir, project)
    const store = new ProjectStore(dir, { project, transcript }, false, undefined, appVersion)
    store.savedProjectText = up.upgraded ? '' : JSON.stringify(project)
    store.savedTranscriptText = JSON.stringify(transcript)
    store.loadHistory()
    if (up.upgraded) {
      store.flush()
      store.log.write('upgrade', `Project upgraded from format ${up.from} to ${up.to}`, { backup: backupFile })
    }
    return { store, upgradedFrom: up.upgraded ? up.from : undefined, backupFile }
  }

  private static readTranscript(dir: string, project: Project): Transcript {
    const file = join(dir, project.transcript?.file ?? 'transcript.json')
    if (!existsSync(file)) return emptyTranscript()
    const parsed = TranscriptSchema.safeParse(readJson(file))
    return parsed.success ? parsed.data : emptyTranscript()
  }

  /** Automatic copy of project.json each time it is opened; the last 30 are kept. */
  private static rotateBackup(dir: string): void {
    const p = projectPaths(dir)
    try {
      copyFileSync(p.file, join(p.backups, `project.${stamp()}.json`))
      const auto = readdirSync(p.backups)
        .filter((f) => /^project\.\d{4}-/.test(f))
        .sort()
      for (const f of auto.slice(0, Math.max(0, auto.length - BACKUP_LIMIT))) rmSync(join(p.backups, f), { force: true })
    } catch {
      /* backups are best effort */
    }
  }

  // ---------------------------------------------------------------- reading

  get project(): Project {
    return this.doc.project
  }

  get transcript(): Transcript {
    return this.doc.transcript
  }

  /** A deep copy, safe to hand out. */
  snapshotDoc(): ProjectDoc {
    return structuredClone(this.doc)
  }

  get canUndo(): boolean {
    return this.history.undo.length > 0
  }

  get canRedo(): boolean {
    return this.history.redo.length > 0
  }

  get undoLabel(): string | undefined {
    return this.history.undo[this.history.undo.length - 1]?.label
  }

  get redoLabel(): string | undefined {
    return this.history.redo[this.history.redo.length - 1]?.label
  }

  // ---------------------------------------------------------------- writing

  /**
   * Apply a change. `fn` edits a draft copy; nothing is kept unless the result is valid.
   * Returns whatever `fn` returns.
   */
  mutate<T>(label: string, source: ChangeSource, fn: (draft: ProjectDoc) => T, opts: MutateOptions = {}): T {
    if (this.readOnly) throw new ValidationError(this.readOnlyReason ?? 'Project is read-only')
    const before = this.doc
    const draft = structuredClone(before)
    const result = fn(draft)

    const parsedProject = ProjectSchema.safeParse(draft.project)
    if (!parsedProject.success) {
      throw new ValidationError(
        'Change rejected: it does not match the project format',
        parsedProject.error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`)
      )
    }
    const parsedTranscript = TranscriptSchema.safeParse(draft.transcript)
    if (!parsedTranscript.success) {
      throw new ValidationError(
        'Change rejected: transcript does not match the format',
        parsedTranscript.error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`)
      )
    }
    const next: ProjectDoc = { project: parsedProject.data, transcript: parsedTranscript.data }
    this.checkIntegrity(next)

    const lock = before.project.lock
    if (lock && source === 'claude' && !opts.bypassLock) {
      const res = checkLock(before, next, lock.range)
      if (!res.ok) {
        throw new ValidationError('Change rejected: a section re-edit is in progress and this touches the rest of the video', res.violations)
      }
      if (Math.abs(res.delta) > 1e-6) {
        shiftAfterRange(next, lock.range, res.delta)
        next.project.lock = { ...lock, range: { start: lock.range.start, end: Math.max(lock.range.start, lock.range.end + res.delta) } }
      }
    }

    const forward = jsonpatch.compare(before, next)
    if (forward.length === 0) return result
    const backward = jsonpatch.compare(next, before)
    this.doc = next
    if (!opts.noHistory) {
      this.history.undo.push({ id: newId('h'), label, source, ts: new Date().toISOString(), forward, backward })
      if (this.history.undo.length > HISTORY_LIMIT) this.history.undo.splice(0, this.history.undo.length - HISTORY_LIMIT)
      this.history.redo = []
    }
    this.flush()
    if (!opts.noHistory) this.saveHistory()
    this.emit('change', { source, label, changedItemIds: changedItems(before, next) } satisfies ChangeEvent)
    return result
  }

  /** References that the schema alone cannot check. */
  private checkIntegrity(doc: ProjectDoc): void {
    const problems: string[] = []
    const trackIds = new Set(doc.project.tracks.map((t) => t.id))
    const sourceIds = new Set(doc.project.sources.map((s) => s.id))
    const seen = new Set<string>()
    for (const item of doc.project.items) {
      if (seen.has(item.id)) problems.push(`duplicate item id ${item.id}`)
      seen.add(item.id)
      if (!trackIds.has(item.trackId)) problems.push(`item ${item.id}: unknown track ${item.trackId}`)
      const sid = (item as { sourceId?: string }).sourceId
      if (sid && !sourceIds.has(sid)) problems.push(`item ${item.id}: unknown source ${sid}`)
      if (item.type === 'segment') {
        if (!item.hold && item.out <= item.in) problems.push(`segment ${item.id}: out must be after in`)
        const track = doc.project.tracks.find((t) => t.id === item.trackId)
        if (track && track.kind !== 'aroll') problems.push(`segment ${item.id} must be on an A-roll track`)
      } else {
        const hasMedia = item.type === 'graphic' || item.type === 'effect' || sid || (item as { file?: string }).file
        if (!hasMedia) problems.push(`item ${item.id}: needs a sourceId or a file`)
      }
    }
    if (problems.length) throw new ValidationError('Change rejected', problems.slice(0, 10))
  }

  undo(): boolean {
    return this.step('undo')
  }

  redo(): boolean {
    return this.step('redo')
  }

  private step(dir: 'undo' | 'redo'): boolean {
    if (this.readOnly) return false
    const from = dir === 'undo' ? this.history.undo : this.history.redo
    const to = dir === 'undo' ? this.history.redo : this.history.undo
    const entry = from.pop()
    if (!entry) return false
    const before = this.doc
    try {
      const ops = dir === 'undo' ? entry.backward : entry.forward
      this.doc = jsonpatch.applyPatch(structuredClone(before), ops, false, true).newDocument
    } catch (err) {
      this.log.write('error', `Could not ${dir} "${entry.label}"`, { error: String(err) })
      return false
    }
    to.push(entry)
    this.flush()
    this.saveHistory()
    this.log.write('tweak', `${dir === 'undo' ? 'Undo' : 'Redo'}: ${entry.label}`)
    this.emit('change', { source: 'user', label: `${dir}: ${entry.label}`, changedItemIds: changedItems(before, this.doc) } satisfies ChangeEvent)
    return true
  }

  /** Replace the whole document (restoring a version). Recorded as one undoable step. */
  replaceDoc(label: string, doc: ProjectDoc, source: ChangeSource = 'user'): void {
    this.mutate(label, source, (draft) => {
      draft.project = structuredClone(doc.project)
      draft.transcript = structuredClone(doc.transcript)
    }, { bypassLock: true })
  }

  flush(): void {
    if (this.readOnly) return
    const projectText = JSON.stringify(this.doc.project)
    if (projectText !== this.savedProjectText) {
      this.doc.project.updatedAt = new Date().toISOString()
      this.doc.project.appVersion = this.appVersion
      writeJsonAtomic(this.paths.file, this.doc.project)
      this.savedProjectText = JSON.stringify(this.doc.project)
    }
    const transcriptText = JSON.stringify(this.doc.transcript)
    if (transcriptText !== this.savedTranscriptText) {
      writeJsonAtomic(join(this.dir, this.doc.project.transcript.file || 'transcript.json'), this.doc.transcript)
      this.savedTranscriptText = transcriptText
    }
  }

  private historyFile(): string {
    return join(this.paths.history, 'history.json')
  }

  private loadHistory(): void {
    try {
      if (existsSync(this.historyFile())) {
        const h = readJson<HistoryFile>(this.historyFile())
        if (h && Array.isArray(h.undo) && Array.isArray(h.redo)) this.history = h
      }
    } catch {
      this.history = { formatVersion: 1, undo: [], redo: [] }
    }
  }

  private saveHistory(): void {
    try {
      mkdirSync(this.paths.history, { recursive: true })
      writeJsonAtomic(this.historyFile(), this.history)
    } catch (err) {
      this.log.write('error', 'Could not save undo history', { error: String(err) })
    }
  }
}

function changedItems(a: ProjectDoc, b: ProjectDoc): string[] {
  const am = new Map(a.project.items.map((i) => [i.id, JSON.stringify(i)]))
  const out: string[] = []
  for (const item of b.project.items) {
    if (am.get(item.id) !== JSON.stringify(item)) out.push(item.id)
  }
  return out
}
