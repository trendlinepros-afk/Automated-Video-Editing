/**
 * The handler table behind window.api: one ipcMain.handle per name in API_METHODS, each mapped to
 * the services in the AppContext, plus the glue that turns window actions into Claude requests.
 */
import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'
import { APP_NAME, MCP_SERVER_NAME } from '@shared/appInfo'
import { API_METHODS, type ApiMethod } from '@shared/ipcChannels'
import type { EditThumbnailRequest, FaceSwapRequest, LibraryAsset, ProjectSnapshot, RecreateRequest, ThumbnailRequest, TitlesRequest, UserOp } from '@shared/ipc'
import type { ExportPreset, Item, Range, RequestKind, TrackKind } from '@shared/project'
import type { Profile, Settings } from '@shared/settings'
import { TimelineResolver, findTimeRange, formatTime, placeSegments } from '@shared/timeline'
import type { AppContext } from './context'
import { paths } from './paths'
import { frameAt, seamAudio, waveform } from './engine/media'
import { snapshotOf } from './project/manager'
import { newId, type ProjectStore } from './project/store'
import { applyUserOp, probeSource } from './project/userOps'
import { exportLog, exportPack } from './services/publish'
import { themeSheets } from './services/videoThemes'
import { fetchYouTubeThumbnails } from './services/youtube'
import { estimate } from './runner/costs'

type Handler = (...args: any[]) => unknown

/** Seconds of source audio on each side of a cut sent with a clipped-audio fix. */
const SEAM_SECONDS = 3

const BOOKKEEPING = { bypassLock: true, noHistory: true } as const

export function registerIpc(ctx: AppContext, getWindow: () => BrowserWindow | null): void {
  const store = (): ProjectStore => {
    const s = ctx.projects.current()
    if (!s) throw new Error('No project is open.')
    return s
  }
  const snap = (): ProjectSnapshot => snapshotOf(ctx, store())
  const absPath = (s: ProjectStore, p: string) => (isAbsolute(p) ? p : join(s.dir, p))

  const handlers: Record<ApiMethod, Handler> = {
    // ---------------------------------------------------------------- app
    'app.info': () => ({
      name: APP_NAME,
      version: ctx.appVersion,
      platform: process.platform,
      isPackaged: ctx.isPackaged,
      userDataPath: paths.data,
      appLogPath: paths.appLog
    }),
    'app.openPath': async (p: string) => {
      const err = await shell.openPath(p)
      if (err) throw new Error(err)
    },
    'app.showItemInFolder': (p: string) => shell.showItemInFolder(p),
    'app.openExternal': async (url: string) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('Only web links can be opened.')
      await shell.openExternal(url)
    },
    'app.pickFolder': async (title?: string, defaultPath?: string) => {
      const win = getWindow()
      const opts: Electron.OpenDialogOptions = { title, defaultPath, properties: ['openDirectory', 'createDirectory'] }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
    },
    'app.pickFiles': async (o: { title?: string; filters?: { name: string; extensions: string[] }[]; multi?: boolean }) => {
      const win = getWindow()
      const opts: Electron.OpenDialogOptions = {
        title: o?.title,
        filters: o?.filters,
        properties: o?.multi ? ['openFile', 'multiSelections'] : ['openFile']
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return r.canceled ? [] : r.filePaths
    },
    'app.saveFile': async (o: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => {
      const win = getWindow()
      const opts: Electron.SaveDialogOptions = { title: o?.title, defaultPath: o?.defaultPath, filters: o?.filters }
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      return r.canceled || !r.filePath ? null : r.filePath
    },
    'app.copyText': (text: string) => clipboard.writeText(String(text ?? '')),

    // ---------------------------------------------------------------- updates
    'updates.state': () => ctx.updater.state(),
    'updates.check': () => ctx.updater.check({ quiet: false }),
    'updates.restartNow': async () => {
      // Every open project is saved before the installer runs.
      ctx.projects.current()?.flush()
      await ctx.updater.restartNow()
    },
    'updates.later': () => ctx.updater.later(),

    // ---------------------------------------------------------------- setup
    'setup.status': () => ctx.env.status(),
    'setup.installEnvironment': () => ctx.env.install((p) => ctx.send('setup:progress', p)),

    // ---------------------------------------------------------------- settings
    'settings.get': () => ctx.settings.get(),
    'settings.update': (patch: Partial<Settings>) => ctx.settings.update(patch),
    'settings.setPikzelsKey': (key: string | null) => ctx.secrets.set('pikzels', key),
    'settings.hasPikzelsKey': () => !!ctx.secrets.get('pikzels'),
    'settings.openAppLog': () => {
      if (existsSync(paths.appLog)) shell.showItemInFolder(paths.appLog)
      else void shell.openPath(join(paths.data, 'logs'))
    },
    'settings.claudeSetup': () => {
      const url = ctx.mcp.url()
      const token = ctx.mcp.token()
      const server: Record<string, unknown> = { type: 'http', url }
      if (token) server.headers = { Authorization: `Bearer ${token}` }
      const json = JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: server } }, null, 2)
      const header = token ? ` --header "Authorization: Bearer ${token}"` : ''
      const command = `claude mcp add --transport http ${MCP_SERVER_NAME} ${url}${header}`
      return { command, json, url }
    },

    // ---------------------------------------------------------------- profiles
    'profiles.list': () => ctx.profiles.list(),
    'profiles.save': (p: Profile) => ctx.profiles.save(p),
    'profiles.create': (name: string) => ctx.profiles.create(name),
    'profiles.delete': (id: string) => ctx.profiles.delete(id),
    'profiles.suggestions': () => ctx.corrections.suggestions(),
    'profiles.answerSuggestion': (profileId: string, kind: string, accept: boolean) => ctx.corrections.answer(profileId, kind, accept),

    // ---------------------------------------------------------------- music
    'music.list': (profileId?: string) => ctx.music.list(profileId),
    'music.rescan': () => ctx.music.rescan(),
    'music.addFolder': (p: string) => ctx.music.addFolder(p),
    'music.removeFolder': (id: string) => ctx.music.removeFolder(id),

    // ---------------------------------------------------------------- projects
    'projects.recent': () => ctx.recent.list(),
    'projects.create': async (o: { name: string; profileId: string; footageFolder: string; parentFolder?: string }) => {
      const s = await ctx.projects.create(o)
      return snapshotOf(ctx, s)
    },
    'projects.open': async (p: string) => {
      const dir = basename(p).toLowerCase() === 'project.json' ? join(p, '..') : p
      const s = await ctx.projects.open(dir)
      return snapshotOf(ctx, s)
    },
    'projects.locate': (id: string, newPath: string) => {
      ctx.recent.locate(id, newPath)
      return ctx.recent.list()
    },
    'projects.removeRecent': (id: string) => {
      ctx.recent.remove(id)
      return ctx.recent.list()
    },
    'projects.close': () => ctx.projects.close(),

    // ---------------------------------------------------------------- project
    'project.get': () => {
      const s = ctx.projects.current()
      return s ? snapshotOf(ctx, s) : null
    },
    'project.apply': async (op: UserOp) => {
      await applyUserOp(ctx, store(), op)
      return snap()
    },
    'project.undo': () => {
      store().undo()
      return snap()
    },
    'project.redo': () => {
      store().redo()
      return snap()
    },
    'project.relinkSource': async (sourceId: string, newPath: string) => {
      const s = store()
      const src = s.project.sources.find((x) => x.id === sourceId)
      if (!src) throw new Error('That footage is no longer in the project.')
      if (!existsSync(newPath)) throw new Error('That file could not be found.')
      const probed = await probeSource(ctx, newPath, src.origin, src.id)
      // Other missing files from the same folder are relinked too when they sit beside the new one.
      const oldDir = src.path.replace(/[\\/][^\\/]*$/, '')
      const newDir = newPath.replace(/[\\/][^\\/]*$/, '')
      const siblings = s.project.sources.filter(
        (x) => x.id !== sourceId && !existsSync(x.path) && x.path.replace(/[\\/][^\\/]*$/, '') === oldDir
      )
      const moved = siblings
        .map((x) => ({ id: x.id, path: join(newDir, x.path.split(/[\\/]/).pop()!) }))
        .filter((x) => existsSync(x.path))
      s.mutate('Relink footage', 'user', (d) => {
        const target = d.project.sources.find((x) => x.id === sourceId)!
        // Fields the app does not know stay; what the engine read about the new file replaces the old.
        Object.assign(target, probed.duration > 0 ? probed : { path: newPath })
        for (const m of moved) {
          const x = d.project.sources.find((y) => y.id === m.id)
          if (x) x.path = m.path
        }
      })
      s.log.write('tweak', 'Footage relinked', { sourceId, from: src.path, to: newPath, alsoRelinked: moved })
      return snap()
    },
    'project.setVideoTheme': (id: string | null) => {
      const t = id ? ctx.themes.get(id) : null
      if (id && !t) throw new Error('That video theme no longer exists.')
      store().mutate(t ? `Video theme: ${t.name}` : 'No video theme', 'user', (d) => {
        d.project.videoTheme = t ? { id: t.id, name: t.name } : null
      }, BOOKKEEPING)
    },
    'project.startEdit': (o: { inspiration: string; scope: 'whole' | 'intro'; introMaxSeconds: number | null; videoThemeId?: string | null }) => {
      const s = store()
      const theme = o.videoThemeId ? ctx.themes.get(o.videoThemeId) : null
      s.mutate('Start edit', 'user', (d) => {
        d.project.videoTheme = theme ? { id: theme.id, name: theme.name } : null
        d.project.inspiration = o.inspiration ?? ''
        d.project.scope.mode = o.scope === 'intro' ? 'intro' : 'whole'
        d.project.scope.introMaxSeconds = o.scope === 'intro' && o.introMaxSeconds && o.introMaxSeconds > 0 ? o.introMaxSeconds : null
        d.project.scope.introApproved = false
        d.project.status = 'editing'
      }, BOOKKEEPING)
      ctx.requests.enqueue({
        kind: 'start_edit',
        text: o.inspiration ?? '',
        context: { scope: o.scope, introMaxSeconds: o.introMaxSeconds ?? null }
      })
    },
    'project.sendChat': (o: { text: string; range?: Range; playhead: number; selectedItemIds: string[] }) => {
      const typed = o.range ? null : findTimeRange(o.text)
      const range = o.range ?? typed ?? undefined
      ctx.requests.enqueue({
        kind: 'chat',
        text: o.text,
        range,
        context: {
          playhead: o.playhead,
          selectedItemIds: o.selectedItemIds ?? [],
          ...(typed ? { rangeFromText: true } : {})
        }
      })
    },
    'project.requestReedit': (o: { range: Range; direction: string }) => {
      if (!o.range || o.range.end <= o.range.start) throw new Error('Select a range on the time ruler first.')
      ctx.requests.enqueue({ kind: 'reedit', text: o.direction ?? '', range: o.range, context: {} })
    },
    'project.requestFixAudio': async (o: { segmentId?: string; itemId?: string; time: number }) => fixAudio(ctx, store(), o),
    'project.requestStabilize': (o: { itemId: string; direction?: string }) => requestStabilize(ctx, store(), o),
    'project.addNote': (o: { text: string; itemId?: string; range?: Range }) => {
      const s = store()
      const text = (o.text ?? '').trim()
      if (!text) throw new Error('Write the note first.')
      s.mutate('Note for Claude', 'user', (d) => {
        d.project.notes.push({
          id: newId('note'),
          text,
          status: 'open',
          createdAt: new Date().toISOString(),
          ...(o.itemId ? { itemId: o.itemId } : {}),
          ...(o.range ? { range: o.range } : {})
        })
      }, BOOKKEEPING)
      s.log.write('request', 'Note for Claude', { text, itemId: o.itemId, range: o.range })
    },
    'project.noteToRule': (noteId: string) => {
      const s = store()
      const note = s.project.notes.find((n) => n.id === noteId)
      if (!note) throw new Error('That note no longer exists.')
      const profile = ctx.profiles.get(s.project.profileId)
      if (!profile) throw new Error('This project has no profile to save the rule to.')
      profile.rules.push({ id: newId('rule'), text: note.text, enabled: true, source: 'note', createdAt: new Date().toISOString() })
      ctx.profiles.save(profile)
      s.log.write('app', `Note saved as a rule for "${profile.name}"`, { text: note.text })
    },
    'project.reviewRequest': (requestId: string, decision: 'keep' | 'revert') => ctx.requests.review(requestId, decision),
    'project.introDecision': (decision: 'continue' | 'redo' | 'stop', direction?: string) => {
      const s = store()
      const doc = s.snapshotDoc()
      const resolver = new TimelineResolver(doc.project, doc.transcript)
      const introEnd = doc.project.scope.introEnd ? resolver.anchorTime(doc.project.scope.introEnd).time : resolver.duration
      if (decision === 'continue') {
        s.mutate('Intro approved', 'user', (d) => {
          d.project.scope.introApproved = true
          // From here on it is a whole-video edit (thumbnails and publishing pack included).
          d.project.scope.mode = 'whole'
          d.project.status = 'editing'
        }, BOOKKEEPING)
        // The approved intro is locked by allowing changes only from its last frame on.
        ctx.requests.enqueue({ kind: 'continue_intro', text: direction ?? '', range: { start: introEnd, end: 1e9 }, context: { introEnd } })
      } else if (decision === 'redo') {
        s.mutate('Redo intro', 'user', (d) => {
          d.project.scope.introApproved = false
          d.project.status = 'editing'
        }, BOOKKEEPING)
        ctx.requests.enqueue({ kind: 'redo_intro', text: direction ?? '', range: { start: 0, end: introEnd }, context: { introEnd } })
      } else {
        s.mutate('Stop after the intro', 'user', (d) => {
          d.project.scope.introApproved = true
          d.project.status = 'ready_for_review'
        }, BOOKKEEPING)
      }
      s.log.write('request', `Intro decision: ${decision}`, { direction, introEnd })
    },
    'project.regeneratePublish': (part: 'titles' | 'description' | 'chapters' | 'tags', direction: string) => {
      ctx.requests.enqueue({ kind: 'publish_regen', text: direction ?? '', context: { part } })
    },
    'project.seamAudio': (segmentId: string) => seamAudio(ctx, segmentId),
    'project.waveform': (key: { sourceId?: string; file?: string }) => waveform(ctx, key),
    'project.frameAt': (time: number) => frameAt(ctx, time),

    'project.versions.list': () => ctx.versions.list(),
    'project.versions.save': (name: string) => ctx.versions.save(name, { auto: false }),
    'project.versions.restore': (id: string) => {
      ctx.versions.restore(id)
      return snap()
    },
    'project.versions.remove': (id: string) => ctx.versions.remove(id),
    'project.versions.compareFrames': async (aId: string, bId: string, time: number) => {
      const s = store()
      const outDir = join(s.paths.cache, 'compare')
      mkdirSync(outDir, { recursive: true })
      const one = async (id: string) => {
        try {
          const doc = ctx.versions.load(id)
          return await ctx.engine.frame(doc, s.dir, time, { width: 960, out: join(outDir, `${id}-${Math.round(time * 1000)}.png`) })
        } catch (err) {
          s.log.write('render', 'Could not draw a frame for Compare', { version: id, time, error: String((err as Error)?.message ?? err) })
          return null
        }
      }
      const [a, b] = await Promise.all([one(aId), one(bId)])
      return { a, b }
    },

    'project.exportVideo': async (o: { range?: Range; preset: ExportPreset; quick: boolean; captions: 'burn' | 'srt' | 'both' | 'none' }) => {
      const s = store()
      const where = o.range ? ` (${formatTime(o.range.start)}–${formatTime(o.range.end)})` : ''
      ctx.versions.save(`Before export${where}`, { auto: true, reason: 'export' })
      const outDir = ctx.settings.get().defaultExportsFolder || undefined
      s.log.write('export', `Export requested${where}`, { preset: o.preset, quick: o.quick, captions: o.captions })
      return ctx.renders.start({ range: o.range, preset: o.preset, quick: o.quick, captions: o.captions, ...(outDir ? { outDir } : {}) })
    },
    'project.cancelExport': () => ctx.renders.cancel(),
    'project.exportLog': (filter: 'all' | 'last_session') => {
      const file = exportLog(ctx, filter === 'last_session' ? 'last_session' : 'all')
      shell.showItemInFolder(file)
      return file
    },
    'project.exportPack': () => {
      const dir = exportPack(ctx)
      void shell.openPath(dir)
      return dir
    },
    'project.saveToLibrary': (itemId: string, meta: { name: string; tags: string[]; description: string; whenToUse: string; scope: string }) =>
      saveToLibrary(ctx, store(), itemId, meta),

    // ---------------------------------------------------------------- thumbnails
    'thumbnails.generate': async (req: ThumbnailRequest) => {
      const s = store()
      const prompt = (req.prompt ?? '').trim()
      if (!prompt) throw new Error('Type how you want the thumbnail to look first.')
      if (s.project.thumbnails.useMyDirection) {
        // Use my direction: Claude's next thumbnail prompts follow this text.
        s.mutate('Thumbnail direction', 'user', (d) => {
          d.project.thumbnails.direction = prompt
        }, BOOKKEEPING)
      }
      const count = Math.min(3, Math.max(1, Math.round(req.count || 1)))
      await ctx.pikzels.generate({ prompts: Array.from({ length: count }, () => prompt), source: 'user', referenceTime: req.referenceTime, model: req.model })
    },
    'thumbnails.regenerate': (id: string) => ctx.pikzels.regenerate(id),
    'thumbnails.recreate': async (req: RecreateRequest) => void (await ctx.pikzels.recreate({ ...req, source: 'user' })),
    'thumbnails.edit': async (req: EditThumbnailRequest) => void (await ctx.pikzels.edit({ ...req, source: 'user' })),
    'thumbnails.faceSwap': async (req: FaceSwapRequest) => void (await ctx.pikzels.faceSwap(req)),
    'thumbnails.score': (id: string, title?: string) => ctx.pikzels.score(id, title),
    'thumbnails.titles': (req: TitlesRequest) => ctx.pikzels.titles({ ...req, source: 'user' }),
    'thumbnails.choose': (id: string) => {
      store().mutate('Choose thumbnail', 'user', (d) => {
        if (!d.project.thumbnails.items.some((t) => t.id === id)) throw new Error('That thumbnail no longer exists.')
        d.project.thumbnails.chosenId = id
      })
    },
    'thumbnails.exportImage': async (id: string) => {
      const s = store()
      const t = s.project.thumbnails.items.find((x) => x.id === id)
      if (!t?.file) throw new Error('That thumbnail has no image yet.')
      const src = absPath(s, t.file)
      const win = getWindow()
      const opts: Electron.SaveDialogOptions = {
        title: 'Save thumbnail',
        defaultPath: `${s.project.name}-thumbnail${extname(src) || '.png'}`,
        filters: [{ name: 'Image', extensions: [extname(src).slice(1) || 'png'] }]
      }
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return null
      copyFileSync(src, r.filePath)
      s.log.write('thumbnail', 'Thumbnail image exported', { id, to: r.filePath })
      return r.filePath
    },

    // ---------------------------------------------------------------- preview
    'preview.state': () => ctx.preview.state(),
    'preview.showBefore': (requestId: string | null) => ctx.preview.showBefore(requestId),

    // ---------------------------------------------------------------- claude
    'claude.state': () => ctx.runner.state(),
    'claude.stop': () => ctx.runner.stop(),
    'claude.resume': () => ctx.runner.resume(),
    'claude.estimate': (kind: RequestKind, opts?: { scope?: 'whole' | 'intro' }) => estimate(ctx, ctx.projects.current()?.project ?? null, kind, opts),

    // ---------------------------------------------------------------- library
    'library.list': (filter?: { scope?: string; type?: string; query?: string }) => ctx.library.list(filter),
    'library.update': (id: string, patch: Partial<LibraryAsset>) => ctx.library.update(id, patch),
    'library.duplicate': (id: string) => ctx.library.duplicate(id),
    'library.remove': (id: string) => ctx.library.remove(id),
    'library.placeInProject': (id: string, time: number) => placeFromLibrary(ctx, store(), id, time),

    // ---------------------------------------------------------------- pikzels
    'pikzels.list': () => ctx.pikzels.list(),
    'pikzels.thumbnailsFromLink': async (links: string) => {
      const list = await fetchYouTubeThumbnails(links, { cacheDir: join(paths.data, 'cache', 'youtube') })
      ctx.appLog.write('thumbnail', `Listed ${list.items.length} YouTube thumbnails for training`, { source: list.source })
      return list
    },
    'themes.list': () => ctx.themes.list(),
    'themes.analyze': (input: { link?: string; file?: string; name?: string }) => ctx.themes.analyze(input, (p) => ctx.send('themes:progress', p)),
    'themes.cancel': () => ctx.themes.cancel(),
    'themes.update': (id: string, patch: { name?: string; notes?: string }) => ctx.themes.update(id, { name: patch?.name, notes: patch?.notes }),
    'themes.remove': (id: string) => ctx.themes.remove(id),
    'themes.sheets': (id: string) => {
      const t = ctx.themes.get(id)
      return t ? themeSheets(ctx.themes.dir(id), t) : []
    },
    'pikzels.create': (kind: 'persona' | 'style', name: string, imagePaths: string[]) => ctx.pikzels.create(kind, name, imagePaths),
    'pikzels.refresh': () => ctx.pikzels.refresh(),
    'pikzels.updateInstructions': (id: string, text: string) => ctx.pikzels.updateInstructions(id, text),
    'pikzels.remove': (id: string) => ctx.pikzels.remove(id),
    'pikzels.rename': (id: string, name: string) => ctx.pikzels.rename(id, name),
    'pikzels.pricing': () => ctx.pikzels.pricing(),
    'pikzels.setPrices': (overrides: Record<string, number> | null) => ctx.pikzels.setPrices(overrides)
  }

  for (const name of API_METHODS) {
    const fn = handlers[name]
    ipcMain.removeHandler(name)
    ipcMain.handle(name, async (_e, ...args) => {
      try {
        return await fn(...args)
      } catch (err) {
        const e = err as Error
        const log = ctx.projects.current()?.log
        // Ordinary refusals (a rejected change, a missing file) are logged briefly; the window shows the message.
        ;(log ?? ctx.appLog).write('error', `${name} failed: ${e?.message ?? String(err)}`, e?.stack ? { stack: e.stack } : undefined)
        throw err instanceof Error ? err : new Error(String(err))
      }
    })
  }
}

// ------------------------------------------------------------------ Stabilize

/** Seconds of source on each side of the clip that the stabilizer may read, for smoother motion at the edges. */
const STABILIZE_PAD = 1

/**
 * Asks Claude to stabilize one A-roll segment or B-roll clip. The app only describes the clip; Claude
 * renders the stabilized picture its own way and attaches it with set_item_picture.
 */
function requestStabilize(ctx: AppContext, s: ProjectStore, o: { itemId: string; direction?: string }): void {
  const doc = s.snapshotDoc()
  const item = doc.project.items.find((i) => i.id === o.itemId)
  if (!item || (item.type !== 'segment' && item.type !== 'clip')) throw new Error('Only video clips on the A-roll or B-roll can be stabilized.')
  const src = item.sourceId ? doc.project.sources.find((x) => x.id === item.sourceId) : undefined
  const file = src ? src.path : item.type === 'clip' && item.file ? (isAbsolute(item.file) ? item.file : join(s.dir, item.file)) : null
  if (!file || src?.kind === 'image' || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(file)) throw new Error('A still image has nothing to stabilize.')
  const span = new TimelineResolver(doc.project, doc.transcript).resolveItem(item)
  const length = item.type === 'segment' ? item.out - item.in : item.duration * (item.speed ?? 1)
  const sourceIn = item.in
  const sourceOut = item.in + length
  ctx.requests.enqueue({
    kind: 'stabilize',
    text: o.direction ?? '',
    range: { start: span.start, end: span.end },
    context: {
      itemId: item.id,
      itemType: item.type,
      label: item.label ?? null,
      sourceId: item.sourceId ?? null,
      sourcePath: file,
      sourceIn,
      sourceOut,
      readFrom: Math.max(0, sourceIn - STABILIZE_PAD),
      readTo: src?.duration ? Math.min(src.duration, sourceOut + STABILIZE_PAD) : sourceOut + STABILIZE_PAD,
      fps: src?.fps ?? null,
      width: src?.width ?? null,
      height: src?.height ?? null,
      currentPicture: item.picture ?? null,
      saveAs: `media/stabilized/${item.id}.mp4`
    }
  })
}

// ------------------------------------------------------------------ Fix clipped audio

/**
 * Builds a request scoped to one spot: the seam before a segment, with a few seconds of the SOURCE
 * audio on both sides of each edge of the cut and the cut times. The app does not look for the word
 * boundary itself; Claude makes the fix.
 */
async function fixAudio(ctx: AppContext, s: ProjectStore, o: { segmentId?: string; itemId?: string; time: number }): Promise<void> {
  const doc = s.snapshotDoc()
  const placed = placeSegments(doc.project)
  const sources = new Map(doc.project.sources.map((x) => [x.id, x]))
  const dir = join(s.paths.requests, newId('fix'))
  mkdirSync(dir, { recursive: true })

  const snippet = async (sourceId: string, start: number, end: number, name: string): Promise<string | null> => {
    const src = sources.get(sourceId)
    if (!src) return null
    const a = Math.max(0, start)
    const b = src.duration > 0 ? Math.min(src.duration, end) : end
    if (b <= a) return null
    try {
      return await ctx.engine.snippet(src.path, a, b, join(dir, name))
    } catch (err) {
      s.log.write('error', 'Could not cut an audio snippet for the fix request', { sourceId, start: a, end: b, error: String((err as Error)?.message ?? err) })
      return null
    }
  }

  const item = o.itemId ? doc.project.items.find((i) => i.id === o.itemId) : undefined
  let segIndex = -1
  if (o.segmentId) segIndex = placed.findIndex((p) => p.item.id === o.segmentId)
  else if (item?.type === 'segment') segIndex = placed.findIndex((p) => p.item.id === item.id)

  if (segIndex < 0 && item && item.type !== 'segment') {
    // A music or sound effect item: the spot is inside that item.
    const resolver = new TimelineResolver(doc.project, doc.transcript)
    const span = resolver.resolveItem(item)
    const range = { start: Math.max(0, o.time - SEAM_SECONDS), end: o.time + SEAM_SECONDS }
    const local = Math.max(0, o.time - span.start)
    const srcId = (item as { sourceId?: string }).sourceId
    const inPoint = (item as { in?: number }).in ?? 0
    const audio = srcId ? await snippet(srcId, inPoint + local - SEAM_SECONDS, inPoint + local + SEAM_SECONDS, 'item.wav') : null
    ctx.requests.enqueue({
      kind: 'fix_audio',
      text: 'Fix clipped audio',
      range,
      context: { itemId: item.id, time: o.time, itemStart: span.start, itemIn: inPoint, ...(audio ? { audio } : {}), snippetDir: dir }
    })
    return
  }

  if (segIndex < 0) {
    // No segment named: use the cut nearest the clicked time.
    let best = -1
    let bestDist = Infinity
    placed.forEach((p, i) => {
      if (i === 0) return
      const dist = Math.abs(p.start - o.time)
      if (dist < bestDist) {
        bestDist = dist
        best = i
      }
    })
    segIndex = best >= 0 ? best : placed.findIndex((p) => o.time >= p.start && o.time < p.end)
  }
  if (segIndex < 0) throw new Error('There is no A-roll cut at that spot.')

  const next = placed[segIndex]
  const prev = segIndex > 0 ? placed[segIndex - 1] : null
  const seamTime = next.start
  const before = prev ? await snippet(prev.item.sourceId, prev.item.out - SEAM_SECONDS, prev.item.out + SEAM_SECONDS, 'before-cut.wav') : null
  const after = await snippet(next.item.sourceId, next.item.in - SEAM_SECONDS, next.item.in + SEAM_SECONDS, 'after-cut.wav')
  ctx.requests.enqueue({
    kind: 'fix_audio',
    text: 'Fix clipped audio',
    range: { start: Math.max(0, seamTime - SEAM_SECONDS), end: seamTime + SEAM_SECONDS },
    context: {
      seamTime,
      clickedTime: o.time,
      snippetSeconds: SEAM_SECONDS,
      snippetDir: dir,
      before: prev
        ? {
            segmentId: prev.item.id,
            sourceId: prev.item.sourceId,
            out: prev.item.out,
            ...(before ? { audio: before, audioStartsAt: Math.max(0, prev.item.out - SEAM_SECONDS) } : {})
          }
        : null,
      after: {
        segmentId: next.item.id,
        sourceId: next.item.sourceId,
        in: next.item.in,
        ...(after ? { audio: after, audioStartsAt: Math.max(0, next.item.in - SEAM_SECONDS) } : {})
      }
    }
  })
}

// ------------------------------------------------------------------ asset library

const LIBRARY_TYPE_TRACK: Record<LibraryAsset['type'], TrackKind> = {
  graphic: 'graphics',
  sound: 'sfx',
  music: 'music',
  effect: 'effects',
  clip: 'broll'
}

async function saveToLibrary(
  ctx: AppContext,
  s: ProjectStore,
  itemId: string,
  meta: { name: string; tags: string[]; description: string; whenToUse: string; scope: string }
): Promise<LibraryAsset> {
  const item = s.project.items.find((i) => i.id === itemId)
  if (!item || item.type === 'segment') throw new Error('Only graphics, sounds, effects and B-roll can be saved to the library.')
  const kind = s.project.tracks.find((t) => t.id === item.trackId)?.kind
  const sourceId = (item as { sourceId?: string }).sourceId
  const fileRef = (item as { file?: string }).file
  const file = fileRef ? (isAbsolute(fileRef) ? fileRef : join(s.dir, fileRef)) : s.project.sources.find((x) => x.id === sourceId)?.path
  if (!file || !existsSync(file)) throw new Error('The file for this item could not be found.')

  const type: LibraryAsset['type'] =
    item.type === 'graphic' ? 'graphic' : item.type === 'effect' ? 'effect' : item.type === 'clip' ? 'clip' : kind === 'music' ? 'music' : 'sound'
  const inputs: LibraryAsset['inputs'] = {}
  if (item.type === 'graphic' || item.type === 'effect') {
    for (const [k, v] of Object.entries(item.params ?? {})) inputs[k] = { type: Array.isArray(v) ? 'array' : typeof v, default: v }
  }
  inputs.duration = { type: 'number', default: item.duration, description: 'Seconds on screen' }

  let previewImage: string | undefined
  if (item.type === 'graphic') {
    try {
      const out = join(s.paths.cache, 'library-preview', item.id)
      mkdirSync(out, { recursive: true })
      const frames = await ctx.engine.graphicPreview(s.dir, item.file, {
        params: item.params ?? {},
        duration: item.duration,
        times: [item.duration / 2],
        width: 640,
        height: 360,
        brand: s.project.settings.brandKit,
        outDir: out
      })
      previewImage = frames[0]
    } catch (err) {
      s.log.write('library', 'Could not draw a preview image for the library', { error: String((err as Error)?.message ?? err) })
    }
  }

  const asset = await ctx.library.saveFromFile({
    file,
    type,
    name: meta.name,
    description: meta.description,
    whenToUse: meta.whenToUse,
    tags: meta.tags ?? [],
    scope: meta.scope || 'shared',
    inputs,
    ...(previewImage ? { previewImage } : {})
  })
  s.mutate('Saved to library', 'app', (d) => {
    const it = d.project.items.find((i) => i.id === itemId)
    if (it) it.libraryAssetId = asset.id
  }, BOOKKEEPING)
  s.log.write('library', `Saved to library: ${asset.name}`, { itemId, assetId: asset.id, scope: asset.scope })
  return asset
}

/** Copies a library asset into the project and places it at a time on the matching track. */
async function placeFromLibrary(ctx: AppContext, s: ProjectStore, id: string, time: number): Promise<void> {
  const asset = ctx.library.get(id)
  if (!asset) throw new Error('That asset is no longer in the library.')
  const rel = ctx.library.copyIntoProject(id, s.dir)
  const abs = isAbsolute(rel) ? rel : join(s.dir, rel)
  const trackKind = LIBRARY_TYPE_TRACK[asset.type]
  const track = s.project.tracks.find((t) => t.kind === trackKind)
  if (!track) throw new Error(`This project has no ${trackKind} track.`)

  const defaults: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(asset.inputs ?? {})) if (v.default !== undefined && k !== 'duration') defaults[k] = v.default
  const declared = Number(asset.inputs?.duration?.default)
  let duration = Number.isFinite(declared) && declared > 0 ? declared : 3
  if (asset.type === 'sound' || asset.type === 'music' || asset.type === 'clip') {
    try {
      const p = await ctx.engine.probe(abs)
      if (p.duration > 0) duration = asset.type === 'clip' ? Math.min(p.duration, Number.isFinite(declared) && declared > 0 ? declared : 4) : p.duration
    } catch (err) {
      s.log.write('library', 'Could not read the asset length; using a default', { error: String((err as Error)?.message ?? err) })
    }
  }

  s.mutate(`Place ${asset.name}`, 'user', (d) => {
    const resolver = new TimelineResolver(d.project, d.transcript)
    const anchor = asset.type === 'music' ? { kind: 'time' as const, time: Math.max(0, time) } : resolver.anchorAt(time)
    const common = { id: newId('itm'), trackId: track.id, label: asset.name, createdBy: 'user' as const, libraryAssetId: asset.id, anchor, duration }
    let item: Item
    switch (asset.type) {
      case 'graphic':
        item = { ...common, type: 'graphic', file: rel, params: defaults }
        break
      case 'effect':
        item = { ...common, type: 'effect', effect: 'custom', file: rel, params: defaults }
        break
      case 'clip':
        item = { ...common, type: 'clip', file: rel, in: 0, speed: 1, volume: -120, fadeIn: 0, fadeOut: 0 }
        break
      case 'music':
        item = { ...common, type: 'audio', file: rel, in: 0, volume: 0, fadeIn: 1, fadeOut: 2, duck: true, loop: false }
        break
      default:
        item = { ...common, type: 'audio', file: rel, in: 0, volume: 0, fadeIn: 0, fadeOut: 0, duck: false, loop: false }
    }
    d.project.items.push(item)
  })
  s.log.write('library', `Placed from library: ${asset.name}`, { assetId: id, time, file: rel })
}
