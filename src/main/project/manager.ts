/**
 * Opens, creates and closes projects, and keeps the window, the preview and the recent list in
 * step with every change to the open one.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ProjectSettingsSchema, type ProjectStatus, type Source } from '@shared/project'
import type { ProjectChangeEvent, ProjectSnapshot } from '@shared/ipc'
import { TimelineResolver } from '@shared/timeline'
import type { AppContext, ProjectManager } from '../context'
import { ProjectStore, type ChangeEvent } from './store'
import { saveVersion } from './versions'
import { mediaKindOf, probeSource } from './userOps'

export const DEFAULT_PROJECTS_FOLDER_NAME = 'AI Video Editor Projects'

/** A project or file name that is safe on Windows. */
export function safeName(name: string): string {
  const clean = name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i
  const out = clean.slice(0, 80) || 'Untitled'
  return reserved.test(out) ? `${out}_` : out
}

/** Every media file in the footage folder (and its subfolders), in name order. */
export function listMediaFiles(folder: string): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number) => {
    let names: string[]
    try {
      names = readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith('.')) continue
      const p = join(dir, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (depth < 3) walk(p, depth + 1)
      } else if (mediaKindOf(p)) {
        out.push(p)
      }
    }
  }
  walk(folder, 0)
  return out
}

export function snapshotOf(ctx: AppContext, store: ProjectStore): ProjectSnapshot {
  const doc = store.snapshotDoc()
  return {
    path: store.dir,
    doc,
    readOnly: store.readOnly,
    ...(store.readOnlyReason ? { readOnlyReason: store.readOnlyReason } : {}),
    canUndo: store.canUndo,
    canRedo: store.canRedo,
    ...(store.undoLabel ? { undoLabel: store.undoLabel } : {}),
    ...(store.redoLabel ? { redoLabel: store.redoLabel } : {}),
    missingSources: missingSourceIds(store),
    profile: ctx.profiles.get(doc.project.profileId)
  }
}

function missingSourceIds(store: ProjectStore): string[] {
  return store.project.sources.filter((s) => !existsSync(s.path)).map((s) => s.id)
}

export function createProjectManager(ctx: AppContext, opts: { documentsDir?: string } = {}): ProjectManager {
  let current: ProjectStore | null = null
  let detach: (() => void) | null = null
  const openedListeners = new Set<(s: ProjectStore | null) => void>()

  const announce = (s: ProjectStore | null) => {
    for (const cb of openedListeners) {
      try {
        cb(s)
      } catch (err) {
        ctx.appLog.write('error', 'A project-opened listener failed', { error: String(err) })
      }
    }
  }

  const touchRecent = (s: ProjectStore) => {
    try {
      ctx.recent.touch({ id: s.project.id, name: s.project.name, path: s.dir, profileId: s.project.profileId, status: s.project.status })
    } catch (err) {
      ctx.appLog.write('error', 'Could not update the recent projects list', { error: String(err) })
    }
  }

  /** A frame from the video for the home page card (best effort). */
  const refreshCover = async (s: ProjectStore) => {
    try {
      const doc = s.snapshotDoc()
      const duration = new TimelineResolver(doc.project, doc.transcript).duration
      if (duration <= 0) return
      mkdirSync(s.paths.cache, { recursive: true })
      const out = join(s.paths.cache, 'cover.png')
      const tmp = join(s.paths.cache, 'cover.new.png')
      const file = await ctx.engine.frame(doc, s.dir, duration * 0.2, { width: 640, out: tmp })
      if (existsSync(file)) {
        renameSync(file, out)
        touchRecent(s)
      }
    } catch (err) {
      s.log.write('render', 'Could not make the cover frame for the home page', { error: String((err as Error)?.message ?? err) })
    }
  }

  const attach = (s: ProjectStore) => {
    let lastStatus: ProjectStatus = s.project.status
    const onChange = (e: ChangeEvent) => {
      const status = s.project.status
      if (status !== lastStatus) {
        if (status === 'ready_for_review') {
          try {
            saveVersion(s, 'Ready for review', { auto: true, reason: 'ready_for_review' })
          } catch (err) {
            s.log.write('error', 'Could not save the Ready for review version', { error: String(err) })
          }
        }
        if (status === 'ready_for_review' || status === 'exported') void refreshCover(s)
        lastStatus = status
        touchRecent(s)
      }
      const payload: ProjectChangeEvent = { snapshot: snapshotOf(ctx, s), source: e.source, label: e.label, changedItemIds: e.changedItemIds }
      ctx.send('project:change', payload)
      try {
        ctx.preview.invalidate()
      } catch (err) {
        s.log.write('error', 'Could not update the preview', { error: String(err) })
      }
    }
    s.on('change', onChange)
    detach = () => s.off('change', onChange)
  }

  const setCurrent = (s: ProjectStore) => {
    current = s
    attach(s)
    touchRecent(s)
    s.log.write('app', `Project opened in app ${ctx.appVersion}`, { dir: s.dir, readOnly: s.readOnly })
    announce(s)
    if (!existsSync(join(s.paths.cache, 'cover.png')) && s.project.items.length) void refreshCover(s)
  }

  const manager: ProjectManager = {
    current() {
      return current
    },

    async open(dir) {
      if (current && current.dir === dir) return current
      if (current) await manager.close()
      const { store, upgradedFrom, backupFile } = ProjectStore.open(dir, ctx.appVersion)
      if (upgradedFrom !== undefined) {
        ctx.appLog.write('upgrade', `Project upgraded from format ${upgradedFrom}`, { dir, backup: backupFile })
        if (backupFile) {
          try {
            // The version holds the file exactly as the older app left it; loading it upgrades it again.
            saveVersion(store, 'Before upgrade', {
              auto: true,
              reason: `upgrade from format ${upgradedFrom}`,
              projectText: readFileSync(backupFile, 'utf8')
            })
          } catch (err) {
            store.log.write('error', 'Could not save the Before upgrade version', { error: String(err) })
          }
        }
      }
      setCurrent(store)
      return store
    },

    async create({ name, profileId, footageFolder, parentFolder }) {
      if (!existsSync(footageFolder)) throw new Error('The footage folder could not be found.')
      const profile = ctx.profiles.get(profileId)
      if (!profile) throw new Error('Pick a profile for this project.')
      const parent =
        parentFolder || ctx.settings.get().defaultProjectsFolder || join(opts.documentsDir ?? join(homedir(), 'Documents'), DEFAULT_PROJECTS_FOLDER_NAME)
      mkdirSync(parent, { recursive: true })
      const base = safeName(name)
      let dir = join(parent, base)
      for (let n = 2; existsSync(dir) && (existsSync(join(dir, 'project.json')) || readdirSync(dir).length > 0); n++) {
        dir = join(parent, `${base} (${n})`)
      }
      if (current) await manager.close()

      // A new project copies its profile's defaults; later changes to either never touch the other.
      const settings = ProjectSettingsSchema.parse({
        exportPreset: profile.exportPreset,
        mix: profile.mix,
        brandKit: profile.brandKit,
        musicFolderIds: profile.musicFolderIds,
        descriptionTemplate: profile.descriptionTemplate,
        captionExport: profile.captionExport
      })
      const store = ProjectStore.create(dir, {
        name: name.trim() || base,
        profileId,
        footageFolder,
        settings: structuredClone(settings),
        thumbnails: { ...profile.thumbnail },
        appVersion: ctx.appVersion
      })

      const files = listMediaFiles(footageFolder)
      // A few probes at a time; the list keeps the folder's name order.
      const sources: Source[] = new Array(files.length)
      let next = 0
      const worker = async () => {
        while (next < files.length) {
          const i = next++
          const src = await probeSource(ctx, files[i], 'footage')
          const problem = (src as { probeError?: string }).probeError
          if (problem) store.log.write('error', `Could not read ${files[i]}; it is listed with what its name tells`, { error: problem })
          sources[i] = src
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker))
      if (sources.length) {
        store.mutate(`Add ${sources.length} footage files`, 'app', (d) => {
          d.project.sources.push(...sources)
        }, { noHistory: true })
      }
      store.log.write('app', `Footage folder: ${footageFolder}`, { files: files.length })
      ctx.appLog.write('app', `Project created: ${name}`, { dir })
      setCurrent(store)
      return store
    },

    async close() {
      const s = current
      if (!s) return
      try {
        s.flush()
      } catch (err) {
        s.log.write('error', 'Could not save the project while closing', { error: String(err) })
      }
      detach?.()
      detach = null
      current = null
      s.log.write('app', 'Project closed')
      announce(null)
    },

    onOpened(cb) {
      openedListeners.add(cb)
      return () => openedListeners.delete(cb)
    },

    missingSources() {
      return current ? missingSourceIds(current) : []
    }
  }
  return manager
}
