/**
 * The asset library: graphics, animations and sounds saved for reuse, in a folder the owner chooses.
 *
 * Layout (plain files, nothing locked inside the app):
 *   <root>/shared/<asset-id>/                 assets every channel can use
 *   <root>/profiles/<profileId>/<asset-id>/   assets for one channel
 * Each asset folder holds asset.json (description, inputs, tags, use count), the main file and preview.png.
 * asset.json carries a format version and is upgraded like a project, with a backup copy first.
 */
import { closeSync, copyFileSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { LIBRARY_FORMAT_VERSION } from '@shared/appInfo'
import type { LibraryAsset } from '@shared/ipc'
import { upgradeLibraryAsset } from '@shared/migrations'
import { BrandKitSchema } from '@shared/project'
import type { AppContext, LibraryService } from '../context'
import { paths } from '../paths'

const ASSET_FILE = 'asset.json'
const PREVIEW_FILE = 'preview.png'
const SEED_MARKER = '.starter-assets.json'
const TYPES: LibraryAsset['type'][] = ['graphic', 'sound', 'effect', 'music', 'clip']

/** Files in an asset folder that are bookkeeping, not part of the asset itself. */
const isMetaFile = (name: string) => name === ASSET_FILE || name === PREVIEW_FILE || name.startsWith(`${ASSET_FILE}.`) || name === SEED_MARKER

function newAssetId(): string {
  return `lib_${randomBytes(5).toString('hex')}`
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Flushed to the disk before it replaces the old file, so a power cut never leaves a half-written asset.json. */
function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, JSON.stringify(data, null, 2) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'asset'
  )
}

/** The asset as the app uses it: known fields with defaults, unknown fields kept. */
function normalise(raw: Record<string, any>, dir: string, scope: string): LibraryAsset {
  const now = new Date(0).toISOString()
  const type = TYPES.includes(raw.type) ? raw.type : 'graphic'
  return {
    ...raw,
    formatVersion: typeof raw.formatVersion === 'number' ? raw.formatVersion : LIBRARY_FORMAT_VERSION,
    id: typeof raw.id === 'string' && raw.id ? raw.id : basename(dir),
    name: typeof raw.name === 'string' && raw.name ? raw.name : basename(dir),
    type,
    description: String(raw.description ?? ''),
    whenToUse: String(raw.whenToUse ?? ''),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    scope,
    file: typeof raw.file === 'string' && raw.file ? raw.file : guessMainFile(dir),
    ...(raw.preview || existsSync(join(dir, PREVIEW_FILE)) ? { preview: raw.preview || PREVIEW_FILE } : {}),
    inputs: raw.inputs && typeof raw.inputs === 'object' ? raw.inputs : {},
    preferred: !!raw.preferred,
    uses: typeof raw.uses === 'number' ? raw.uses : 0,
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? raw.createdAt ?? now,
    dir
  }
}

function guessMainFile(dir: string): string {
  try {
    const files = readdirSync(dir).filter((f) => !isMetaFile(f) && !isDir(join(dir, f)))
    return files.find((f) => f.endsWith('.py')) ?? files[0] ?? ''
  } catch {
    return ''
  }
}

/** The asset.json content to write: everything except the read-time folder path. */
function toDisk(asset: LibraryAsset): Record<string, unknown> {
  const { dir: _dir, ...rest } = asset
  return rest
}

export interface LibraryOptions {
  /** Folder of starter assets (default: <resources>/engine/starter_assets). */
  starterDir?: string
}

export function createLibraryService(ctx: AppContext, opts: LibraryOptions = {}): LibraryService {
  let seededRoot: string | null = null

  const log = (msg: string, data?: unknown) => (ctx.projects.current()?.log ?? ctx.appLog).write('library', msg, data)

  const starterDir = (): string | null => {
    if (opts.starterDir) return opts.starterDir
    try {
      return join(paths.resources, 'engine', 'starter_assets')
    } catch {
      return null
    }
  }

  /** Copies the starter assets into shared/ the first time a library folder is used. Deleted ones stay deleted. */
  const seed = (root: string) => {
    if (seededRoot === root) return
    seededRoot = root
    mkdirSync(join(root, 'shared'), { recursive: true })
    mkdirSync(join(root, 'profiles'), { recursive: true })
    const src = starterDir()
    if (!src || !isDir(src)) return
    const marker = join(root, SEED_MARKER)
    let seeded: string[] = []
    try {
      if (existsSync(marker)) seeded = JSON.parse(readFileSync(marker, 'utf8')).seeded ?? []
    } catch {
      seeded = []
    }
    const added: string[] = []
    for (const name of readdirSync(src)) {
      const from = join(src, name)
      if (!isDir(from) || !existsSync(join(from, ASSET_FILE)) || seeded.includes(name)) continue
      const to = join(root, 'shared', name)
      if (!existsSync(to)) {
        cpSync(from, to, { recursive: true })
        added.push(name)
      }
      seeded.push(name)
    }
    try {
      writeJson(marker, { seeded })
    } catch {
      /* a read-only library still works */
    }
    if (added.length) log(`Added ${added.length} starter assets to the library`, { assets: added })
  }

  const root = (): string | null => {
    const r = ctx.settings.get().libraryFolder
    if (!r) return null
    try {
      mkdirSync(r, { recursive: true })
      seed(r)
    } catch (err) {
      ctx.appLog.write('error', 'The asset library folder cannot be used', { folder: r, error: String(err) })
      return null
    }
    return r
  }

  const scopeDir = (r: string, scope: string) => (scope === 'shared' ? join(r, 'shared') : join(r, 'profiles', scope))

  /** Reads asset.json, upgrading it (with a backup copy) when it has an older format. */
  const readAsset = (dir: string, scope: string): LibraryAsset | null => {
    const file = join(dir, ASSET_FILE)
    if (!existsSync(file)) return null
    let raw: Record<string, any>
    try {
      raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
    } catch {
      return null
    }
    try {
      const up = upgradeLibraryAsset(raw)
      if (up.upgraded) {
        const backup = join(dir, `${ASSET_FILE}.bak-${up.from}`)
        if (!existsSync(backup)) copyFileSync(file, backup)
        writeJson(file, up.doc)
        log(`Library asset upgraded from format ${up.from} to ${up.to}`, { dir, backup })
        raw = up.doc
      }
    } catch (err) {
      log('Library asset could not be upgraded; using it as it is', { dir, error: String(err) })
    }
    return normalise(raw, dir, scope)
  }

  const all = (): LibraryAsset[] => {
    const r = root()
    if (!r) return []
    const out: LibraryAsset[] = []
    const scan = (base: string, scope: string) => {
      if (!isDir(base)) return
      for (const name of readdirSync(base)) {
        const dir = join(base, name)
        if (!isDir(dir)) continue
        const a = readAsset(dir, scope)
        if (a) out.push(a)
      }
    }
    scan(join(r, 'shared'), 'shared')
    const profilesDir = join(r, 'profiles')
    if (isDir(profilesDir)) for (const pid of readdirSync(profilesDir)) scan(join(profilesDir, pid), pid)
    return out
  }

  const find = (id: string): LibraryAsset => {
    const a = all().find((x) => x.id === id)
    if (!a) throw new Error(`Library asset ${id} was not found`)
    return a
  }

  const save = (asset: LibraryAsset): LibraryAsset => {
    if (asset.formatVersion > LIBRARY_FORMAT_VERSION) throw new Error('This asset was saved by a newer version of the app. Update the app to change it.')
    writeJson(join(asset.dir!, ASSET_FILE), toDisk(asset))
    return asset
  }

  const sortAssets = (list: LibraryAsset[], score?: Map<string, number>) =>
    list.sort(
      (a, b) =>
        Number(b.preferred) - Number(a.preferred) ||
        (score ? (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) : 0) ||
        b.uses - a.uses ||
        a.name.localeCompare(b.name)
    )

  /** Match score of an asset for words in a query. 0 = no match. */
  const scoreOf = (a: LibraryAsset, words: string[]): number => {
    if (!words.length) return 1
    const fields: [string, number][] = [
      [a.name, 3],
      [a.tags.join(' '), 3],
      [a.type, 2],
      [a.whenToUse, 2],
      [a.description, 1]
    ]
    let score = 0
    for (const w of words) {
      let best = 0
      for (const [text, weight] of fields) if (text.toLowerCase().includes(w)) best = Math.max(best, weight)
      score += best
    }
    return score
  }

  const queryWords = (q: string) => q.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 1)

  /** A free folder for a new asset in a scope. */
  const newFolder = (r: string, scope: string): { id: string; dir: string } => {
    const base = scopeDir(r, scope)
    mkdirSync(base, { recursive: true })
    let id = newAssetId()
    while (existsSync(join(base, id))) id = newAssetId()
    return { id, dir: join(base, id) }
  }

  const service: LibraryService = {
    root,

    list(filter = {}) {
      let list = all()
      if (filter.scope) list = list.filter((a) => a.scope === filter.scope)
      if (filter.type) list = list.filter((a) => a.type === filter.type)
      if (filter.query?.trim()) {
        const words = queryWords(filter.query)
        const score = new Map(list.map((a) => [a.id, scoreOf(a, words)]))
        return sortAssets(list.filter((a) => (score.get(a.id) ?? 0) > 0), score)
      }
      return sortAssets(list)
    },

    search(query, o = {}) {
      let list = all().filter((a) => a.scope === 'shared' || (o.profileId ? a.scope === o.profileId : true))
      if (o.type) list = list.filter((a) => a.type === o.type)
      const words = queryWords(query)
      const score = new Map(list.map((a) => [a.id, scoreOf(a, words)]))
      list = list.filter((a) => (score.get(a.id) ?? 0) > 0)
      // Preferred first, and this channel's own assets before shared ones of the same standing.
      return list.sort(
        (a, b) =>
          Number(b.preferred) - Number(a.preferred) ||
          (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) ||
          Number(b.scope !== 'shared') - Number(a.scope !== 'shared') ||
          b.uses - a.uses ||
          a.name.localeCompare(b.name)
      )
    },

    get(id) {
      return all().find((a) => a.id === id) ?? null
    },

    async saveFromFile(o) {
      const r = root()
      if (!r) throw new Error('Choose an asset library folder in Settings first.')
      if (!existsSync(o.file)) throw new Error(`File not found: ${o.file}`)
      const { id, dir } = newFolder(r, o.scope || 'shared')
      mkdirSync(dir, { recursive: true })
      const fileName = basename(o.file)
      copyFileSync(o.file, join(dir, fileName))
      const now = new Date().toISOString()
      const asset: LibraryAsset = {
        formatVersion: LIBRARY_FORMAT_VERSION,
        id,
        name: o.name.trim() || basename(o.file, extname(o.file)),
        type: o.type,
        description: o.description,
        whenToUse: o.whenToUse,
        tags: [...new Set(o.tags.map((t) => t.trim()).filter(Boolean))],
        scope: o.scope || 'shared',
        file: fileName,
        inputs: o.inputs ?? {},
        preferred: false,
        uses: 0,
        createdAt: now,
        updatedAt: now,
        dir
      }
      if (o.previewImage && existsSync(o.previewImage)) {
        copyFileSync(o.previewImage, join(dir, PREVIEW_FILE))
        asset.preview = PREVIEW_FILE
      } else if (o.type === 'graphic' && fileName.endsWith('.py')) {
        // Best effort: a library entry without a preview is still usable.
        try {
          const params: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(asset.inputs)) if (v.default !== undefined) params[k] = v.default
          const store = ctx.projects.current()
          const brand = store?.project.settings.brandKit ?? BrandKitSchema.parse({})
          const outDir = join(dir, '.preview-tmp')
          mkdirSync(outDir, { recursive: true })
          const frames = await ctx.engine.graphicPreview(dir, fileName, { params, duration: 3, times: [1.5], width: 640, height: 360, brand, outDir })
          if (frames[0] && existsSync(frames[0])) {
            copyFileSync(frames[0], join(dir, PREVIEW_FILE))
            asset.preview = PREVIEW_FILE
          }
          rmSync(outDir, { recursive: true, force: true })
        } catch (err) {
          rmSync(join(dir, '.preview-tmp'), { recursive: true, force: true })
          log('No preview image for the new library asset', { name: asset.name, error: String(err) })
        }
      }
      save(asset)
      log(`Saved to library: ${asset.name}`, { id, type: asset.type, scope: asset.scope, tags: asset.tags })
      return asset
    },

    update(id, patch) {
      const r = root()
      if (!r) throw new Error('Choose an asset library folder in Settings first.')
      let asset = find(id)
      const { dir: _d, id: _i, formatVersion: _f, file: _file, createdAt: _c, ...allowed } = patch
      if (allowed.scope && allowed.scope !== asset.scope) {
        // Moving between shared and a channel moves the folder.
        const target = join(scopeDir(r, allowed.scope), basename(asset.dir!))
        if (existsSync(target)) throw new Error('An asset with the same folder name already exists there.')
        mkdirSync(scopeDir(r, allowed.scope), { recursive: true })
        try {
          renameSync(asset.dir!, target)
        } catch {
          cpSync(asset.dir!, target, { recursive: true })
          rmSync(asset.dir!, { recursive: true, force: true })
        }
        log(`Moved library asset ${asset.name} to ${allowed.scope === 'shared' ? 'shared' : `profile ${allowed.scope}`}`)
        asset = { ...asset, dir: target, scope: allowed.scope }
      }
      if (allowed.tags) allowed.tags = [...new Set(allowed.tags.map((t) => t.trim()).filter(Boolean))]
      const next = { ...asset, ...allowed, scope: asset.scope, updatedAt: new Date().toISOString() }
      save(next)
      log(`Updated library asset ${next.name}`, { id, changed: Object.keys(allowed) })
      return next
    },

    duplicate(id) {
      const r = root()
      if (!r) throw new Error('Choose an asset library folder in Settings first.')
      const src = find(id)
      const { id: newIdValue, dir } = newFolder(r, src.scope)
      cpSync(src.dir!, dir, { recursive: true, filter: (from) => !basename(from).startsWith(`${ASSET_FILE}.bak`) })
      const now = new Date().toISOString()
      const copy: LibraryAsset = { ...src, id: newIdValue, name: `${src.name} copy`, preferred: false, uses: 0, createdAt: now, updatedAt: now, dir }
      save(copy)
      log(`Duplicated library asset ${src.name}`, { from: id, to: newIdValue })
      return copy
    },

    remove(id) {
      const a = find(id)
      rmSync(a.dir!, { recursive: true, force: true })
      log(`Deleted library asset ${a.name}`, { id })
    },

    copyIntoProject(id, projectDir) {
      const a = find(id)
      if (!a.file || !existsSync(join(a.dir!, a.file))) throw new Error(`The library asset "${a.name}" has no main file.`)
      const folder = a.type === 'graphic' || a.type === 'effect' ? 'graphics' : a.type === 'clip' ? 'media' : 'audio'
      const destBase = join(projectDir, folder)
      mkdirSync(destBase, { recursive: true })
      const ext = extname(a.file)
      const stem = slug(a.name)
      const extras = readdirSync(a.dir!).filter((f) => !isMetaFile(f) && f !== a.file && !f.startsWith('.'))
      let rel: string
      if (!extras.length) {
        // One file: copy it under a unique name.
        let name = `${stem}${ext}`
        for (let n = 2; existsSync(join(destBase, name)); n++) name = `${stem}_${n}${ext}`
        copyFileSync(join(a.dir!, a.file), join(destBase, name))
        rel = `${folder}/${name}`
      } else {
        // Several files (helper modules, fonts, samples): copy them together so relative references keep working.
        let name = stem
        for (let n = 2; existsSync(join(destBase, name)); n++) name = `${stem}_${n}`
        cpSync(a.dir!, join(destBase, name), {
          recursive: true,
          filter: (from) => {
            const b = basename(from)
            return from === a.dir || !(isMetaFile(b) || b.startsWith('.'))
          }
        })
        rel = `${folder}/${name}/${a.file}`
      }
      if (a.formatVersion <= LIBRARY_FORMAT_VERSION) {
        try {
          save({ ...a, uses: a.uses + 1 })
        } catch {
          /* the use count is a nicety */
        }
      }
      log(`Placed library asset ${a.name} in the project`, { id, file: rel })
      return rel
    }
  }
  return service
}
