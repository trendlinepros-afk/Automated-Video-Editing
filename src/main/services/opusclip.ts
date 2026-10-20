/**
 * OpusClip: short clips made from the finished video by OpusClip, and posted or scheduled to the social accounts
 * connected in OpusClip. Everything OpusClip's API offers is here: clipping with all its options (model, clip
 * lengths, keywords or prompt, genre, part of the video, layout, filler words, language, brand template, email or
 * webhook when done), the clips with preview and download, bleeping swear words, sharing the project, collections,
 * titles/descriptions/hashtags written per platform, posting now or scheduled, and cancelling a scheduled post.
 *
 *  - The video goes up with OpusClip's upload link (Google Cloud resumable upload). Over 10 GB, a smaller copy at
 *    the same resolution is made first, so the vertical crops stay sharp.
 *  - The state of each run is kept in the project folder (opusclip/state.json); clips download into Export/Shorts.
 *  - The API key lives in the secrets store and never reaches a project file or a log.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type {
  OpusAccount,
  OpusClipItem,
  OpusClipOptions,
  OpusCollection,
  OpusPostRecord,
  OpusPostRequest,
  OpusRun,
  OpusSocialCopy,
  OpusSourceInfo,
  OpusState,
  OpusTemplate
} from '@shared/opusclip'
import type { AppContext } from '../context'
import { formatCommand, spawnLines } from '../engine/engine'
import { registerSecret } from '../log'
import { writeJsonAtomic, type ProjectStore } from '../project/store'
import { FINISH_FOLDER, safeFileName } from './finishExport'

// ---------------------------------------------------------------- API shape (correct here if OpusClip changes it)

export const OPUS_API = {
  baseUrl: 'https://api.opus.pro',
  uploadLinks: '/api/upload-links', // POST { video: { usecase: 'LocalUpload' } } -> { url, uploadId }
  projects: '/api/clip-projects', // POST { videoUrl, brandTemplateId?, curationPref?, renderPref?, importPref?, uploadedVideoAttr?, conclusionActions? }
  project: (id: string) => `/api/clip-projects/${encodeURIComponent(id)}`, // GET -> { id, stage, error? }
  visibility: (id: string) => `/api/clip-projects/${encodeURIComponent(id)}/update-visibility`, // POST { visibility }
  clips: '/api/exportable-clips', // GET ?q=findByProjectId&projectId&pageNum&pageSize
  brandTemplates: '/api/brand-templates?q=mine',
  socialAccounts: '/api/social-accounts?q=mine', // -> { data: [{ postAccountId, subAccountId?, platform, extUserName }] }
  socialCopyJobs: '/api/social-copy-jobs', // POST { projectId, clipId, postAccountId, subAccountId, prompt?, forceRegenerate? } -> { data: { jobId } }
  socialCopyJob: (id: string) => `/api/social-copy-jobs/${encodeURIComponent(id)}`, // GET -> { data: { status, title, description, hashtags } }
  postTasks: '/api/post-tasks', // POST { projectId, clipId, postAccountId, subAccountId?, postDetail } -> { data: { postId } }
  schedules: '/api/publish-schedules', // POST (same + publishAt) -> { data: { scheduleId } }
  schedule: (id: string) => `/api/publish-schedules/${encodeURIComponent(id)}`, // DELETE
  censorJobs: '/api/censor-jobs', // POST { projectId, clipId, options: { beepSound } } -> { jobId } (none: no swear words)
  censorJob: (id: string) => `/api/censor-jobs/${encodeURIComponent(id)}`,
  collections: '/api/collections', // POST { collectionName }; GET ?q=mine
  collection: (id: string) => `/api/collections/${encodeURIComponent(id)}`, // DELETE
  collectionExport: (id: string) => `/api/collections/${encodeURIComponent(id)}/export`, // POST {} -> { data: { contentList: [{ contentId, uriForExport }] } }
  collectionContents: '/api/collection-contents', // POST { collectionId, contentId }
  collectionContentsDelete: '/api/collection-contents/delete-collection-contents' // POST { q: 'findByCollectionIdAndContentId', collectionId, contentId }
} as const

/** OpusClip takes videos up to 10 GB; above this the app sends a smaller copy. */
export const MAX_UPLOAD_BYTES = 9.5e9
const POLL_MS = 15_000

export class OpusError extends Error {
  constructor(
    message: string,
    readonly status = 0
  ) {
    super(message)
  }
}

/** A plain message for an OpusClip answer that is not a success. */
export function plainOpusError(status: number, body: string): string {
  if (status === 401) return 'The OpusClip API key is missing or wrong. Paste it again in Settings > API keys.'
  if (status === 403) return 'OpusClip refused this for your account. Check that your OpusClip plan includes API access.'
  if (status === 404) return 'OpusClip could not find that (it may have been deleted in OpusClip).'
  if (status === 429) return 'OpusClip is busy (too many requests). Try again in a minute.'
  if (status >= 500) return `OpusClip had a problem on its side (${status}). Try again later.`
  let detail = ''
  try {
    const j = JSON.parse(body)
    detail = String(j?.message ?? j?.error?.message ?? j?.error ?? '').slice(0, 300)
  } catch {
    detail = body.slice(0, 300)
  }
  return `OpusClip rejected the request (${status})${detail ? `: ${detail}` : ''}.`
}

// ---------------------------------------------------------------- pure helpers (tested)

/** The project body OpusClip expects, from the options in the Shorts tab. */
export function projectBody(videoUrl: string, o: OpusClipOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { videoUrl }
  if (o.brandTemplateId) body.brandTemplateId = o.brandTemplateId
  const cur: Record<string, unknown> = {}
  if (o.model) cur.model = o.model
  if (o.clipDurations?.length) cur.clipDurations = o.clipDurations.map(([a, b]) => [Math.max(0, a), Math.max(a, b)])
  const keywords = (o.topicKeywords ?? []).map((k) => k.trim()).filter(Boolean)
  if (keywords.length) cur.topicKeywords = keywords
  if (o.customPrompt?.trim()) cur.customPrompt = o.customPrompt.trim()
  if (o.genre?.trim()) cur.genre = o.genre.trim()
  if (o.rangeStart !== undefined || o.rangeEnd !== undefined) {
    const range: Record<string, number> = {}
    if (o.rangeStart !== undefined) range.startSec = Math.max(0, o.rangeStart)
    if (o.rangeEnd !== undefined) range.endSec = Math.max(0, o.rangeEnd)
    cur.range = range
  }
  if (o.skipCurate) cur.skipCurate = true
  if (Object.keys(cur).length) body.curationPref = cur
  const render: Record<string, unknown> = {}
  if (o.layoutAspectRatio) render.layoutAspectRatio = o.layoutAspectRatio
  if (o.removeFillerWords !== undefined) render.quickstartConfig = { enableRemoveFillerWords: o.removeFillerWords }
  if (Object.keys(render).length) body.renderPref = render
  if (o.sourceLang) body.importPref = { sourceLang: o.sourceLang }
  if (o.title?.trim()) body.uploadedVideoAttr = { title: o.title.trim() }
  const actions: Record<string, unknown>[] = []
  if (o.notifyEmail?.trim()) actions.push({ type: 'EMAIL', email: o.notifyEmail.trim(), ...(o.notifyOnFailure ? { notifyFailure: true } : {}) })
  if (o.webhookUrl?.trim()) actions.push({ type: 'WEBHOOK', url: o.webhookUrl.trim(), ...(o.notifyOnFailure ? { notifyFailure: true } : {}) })
  if (actions.length) body.conclusionActions = actions
  return body
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined)

/** One clip from OpusClip's list, whatever extra fields it carries. */
export function parseClip(raw: Record<string, any>, projectId: string): OpusClipItem | null {
  const id = String(raw.id ?? raw.clipId ?? raw.contentId ?? '')
  if (!id) return null
  const full = id.includes('.') ? id : `${projectId}.${id}`
  const curationId = full.slice(full.indexOf('.') + 1)
  const ms = num(raw.durationMs) ?? num(raw.durationInMs)
  const sec = ms !== undefined ? ms / 1000 : num(raw.durationSec) ?? num(raw.duration) ?? num(raw.durationSeconds)
  const scoreKey = Object.keys(raw).find((k) => /score/i.test(k) && num(raw[k]) !== undefined)
  const tags = Array.isArray(raw.hashtags) ? raw.hashtags.join(' ') : typeof raw.hashtags === 'string' ? raw.hashtags : undefined
  const known = new Set(['id', 'clipId', 'contentId', 'title', 'uriForPreview', 'uriForExport', 'durationMs', 'durationInMs', 'durationSec', 'duration', 'durationSeconds', 'hashtags', 'description'])
  const extra: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (known.has(k) || k === scoreKey || /url|uri/i.test(k)) continue
    if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 300)) extra[k] = v
  }
  return {
    id: full,
    curationId,
    title: String(raw.title ?? '').trim() || `Clip ${curationId}`,
    ...(raw.uriForPreview ? { previewUrl: String(raw.uriForPreview) } : {}),
    ...(raw.uriForExport ? { exportUrl: String(raw.uriForExport) } : {}),
    ...(sec !== undefined ? { durationSeconds: sec } : {}),
    ...(scoreKey ? { score: num(raw[scoreKey]) } : {}),
    ...(typeof raw.description === 'string' && raw.description ? { description: raw.description } : {}),
    ...(tags ? { hashtags: tags } : {}),
    extra
  }
}

/** OpusClip's stage names in plain words, with how far along it is. */
export function stageInfo(stage: string | undefined): { label: string; percent: number } {
  const order = ['PENDING', 'QUEUED', 'IMPORT', 'CURATE', 'REFINE', 'RENDER', 'UPLOAD', 'COMPLETE']
  const labels: Record<string, string> = {
    PENDING: 'Waiting to start',
    QUEUED: 'In the queue at OpusClip',
    IMPORT: 'OpusClip is reading the video',
    CURATE: 'Finding the best moments',
    REFINE: 'Refining the clips',
    RENDER: 'Rendering the clips',
    UPLOAD: 'Saving the clips',
    COMPLETE: 'Clips ready'
  }
  const s = (stage ?? '').toUpperCase()
  const i = order.indexOf(s)
  return { label: labels[s] ?? (s ? `OpusClip: ${s.toLowerCase()}` : 'Waiting for OpusClip'), percent: i < 0 ? 0 : Math.round((i / (order.length - 1)) * 100) }
}

/** Bits per second for a copy that fits under the upload limit (never above the source's own rate). */
export function copyBitrate(durationSeconds: number, sourceBitrate: number, limitBytes = MAX_UPLOAD_BYTES): number {
  const audio = 192_000
  const fit = Math.floor(((limitBytes * 0.9 * 8) / Math.max(1, durationSeconds)) - audio)
  return Math.max(4_000_000, Math.min(fit, sourceBitrate || fit, 80_000_000))
}

// ---------------------------------------------------------------- the service

export interface OpusClipService {
  state(): OpusState
  check(): Promise<{ ok: boolean; message: string }>
  defaultSource(): OpusSourceInfo | null
  start(options: OpusClipOptions): Promise<OpusRun>
  refresh(runId: string): Promise<OpusRun>
  cancel(runId: string): void
  removeRun(runId: string): void
  download(runId: string, clipId: string): Promise<string>
  share(runId: string, visibility: 'DEFAULT' | 'PUBLIC'): Promise<OpusRun>
  censor(runId: string, clipId: string, beep: boolean): Promise<OpusRun>
  brandTemplates(): Promise<OpusTemplate[]>
  socialAccounts(): Promise<OpusAccount[]>
  socialCopy(o: { runId: string; clipId: string; postAccountId: string; subAccountId?: string; prompt?: string; forceRegenerate?: boolean }): Promise<OpusSocialCopy>
  post(req: OpusPostRequest): Promise<OpusPostRecord>
  cancelSchedule(scheduleId: string): Promise<void>
  collections(): Promise<OpusCollection[]>
  createCollection(name: string): Promise<OpusCollection>
  deleteCollection(id: string): Promise<void>
  addToCollection(collectionId: string, clipId: string): Promise<void>
  removeFromCollection(collectionId: string, clipId: string): Promise<void>
  exportCollection(id: string): Promise<{ files: string[]; dir: string }>
}

export interface OpusDeps {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** Polling of running projects (off in tests). */
  poll?: boolean
}

interface StateFile {
  formatVersion: 1
  runs: OpusRun[]
  posts: OpusPostRecord[]
}

export function createOpusClipService(ctx: AppContext, deps: OpusDeps = {}): OpusClipService {
  const doFetch = deps.fetch ?? fetch
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const pollers = new Map<string, ReturnType<typeof setTimeout>>()
  const uploads = new Map<string, AbortController>()

  const apiKey = (): string | null => {
    const k = ctx.secrets.get('opusclip')
    if (k) registerSecret(k)
    return k
  }
  const store = (): ProjectStore => {
    const s = ctx.projects.current()
    if (!s) throw new Error('Open a project first.')
    return s
  }
  const stateFile = (s: ProjectStore) => join(s.dir, 'opusclip', 'state.json')
  const load = (s: ProjectStore): StateFile => {
    try {
      const raw = JSON.parse(readFileSync(stateFile(s), 'utf8'))
      return { formatVersion: 1, runs: Array.isArray(raw.runs) ? raw.runs : [], posts: Array.isArray(raw.posts) ? raw.posts : [] }
    } catch {
      return { formatVersion: 1, runs: [], posts: [] }
    }
  }
  const save = (s: ProjectStore, f: StateFile) => {
    mkdirSync(join(s.dir, 'opusclip'), { recursive: true })
    writeJsonAtomic(stateFile(s), f)
  }
  const snapshot = (s: ProjectStore | null): OpusState => {
    const f = s ? load(s) : { runs: [], posts: [] }
    return { hasKey: !!apiKey(), runs: f.runs, posts: f.posts }
  }
  const emit = (s: ProjectStore) => ctx.send('opusclip:state', snapshot(s))
  const updateRun = (s: ProjectStore, id: string, patch: Partial<OpusRun> | ((r: OpusRun) => Partial<OpusRun>)): OpusRun => {
    const f = load(s)
    const i = f.runs.findIndex((r) => r.id === id)
    if (i < 0) throw new Error('That OpusClip run is no longer in this project.')
    const p = typeof patch === 'function' ? patch(f.runs[i]) : patch
    f.runs[i] = { ...f.runs[i], ...p, updatedAt: new Date().toISOString() }
    save(s, f)
    emit(s)
    return f.runs[i]
  }
  const runOf = (s: ProjectStore, id: string): OpusRun => {
    const r = load(s).runs.find((x) => x.id === id)
    if (!r) throw new Error('That OpusClip run is no longer in this project.')
    return r
  }
  const log = (s: ProjectStore | null, msg: string, data?: Record<string, unknown>) => s?.log.write('shorts', msg, data)

  async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const key = apiKey()
    if (!key) throw new OpusError('Paste your OpusClip API key in Settings > API keys first.', 401)
    for (let attempt = 1; ; attempt++) {
      const res = await doFetch(`${OPUS_API.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      })
      const text = await res.text().catch(() => '')
      if (res.ok) {
        if (!text.trim()) return {} as T
        try {
          return JSON.parse(text) as T
        } catch {
          throw new OpusError('OpusClip sent an answer the app could not read.', res.status)
        }
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const after = Number(res.headers.get('retry-after'))
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 3000 * attempt)
        continue
      }
      throw new OpusError(plainOpusError(res.status, text), res.status)
    }
  }

  // ---- the video to send

  function defaultSource(): OpusSourceInfo | null {
    const s = ctx.projects.current()
    if (!s) return null
    const dirs = [join(s.dir, FINISH_FOLDER), s.paths.exports, ctx.settings.get().defaultExportsFolder].filter((d): d is string => !!d && existsSync(d))
    const base = safeFileName(s.project.name).toLowerCase()
    let best: OpusSourceInfo | null = null
    for (const dir of dirs) {
      for (const name of readdirSync(dir)) {
        if (extname(name).toLowerCase() !== '.mp4' || /QUICK-CHECK/i.test(name) || name.startsWith('.')) continue
        // Whole-video exports of this project (a section export is named with its range).
        if (!name.toLowerCase().startsWith(base) || /_\d\d-\d\d_to_\d\d-\d\d/.test(name)) continue
        const st = statSync(join(dir, name))
        if (!best || st.mtimeMs > Date.parse(best.modified)) best = { path: join(dir, name), sizeBytes: st.size, modified: new Date(st.mtimeMs).toISOString() }
      }
    }
    return best
  }

  /** A copy under the upload limit at the same resolution, made with the graphics card when it can. */
  async function smallerCopy(s: ProjectStore, run: OpusRun, signal: AbortSignal): Promise<string> {
    const info = await ctx.engine.probe(run.sourceFile)
    const size = statSync(run.sourceFile).size
    const rate = copyBitrate(info.duration, (size * 8) / Math.max(1, info.duration))
    const out = join(s.dir, 'opusclip', `upload-${run.id}.mp4`)
    const ffmpeg = ctx.env.ffmpeg()
    const common = ['-hide_banner', '-y', '-i', run.sourceFile, '-map', '0:v:0', '-map', '0:a?', '-b:v', String(rate), '-maxrate', String(Math.round(rate * 1.5)), '-bufsize', String(rate * 2), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out]
    const encoders = [['-c:v', 'h264_nvenc', '-preset', 'p5'], ['-c:v', 'libx264', '-preset', 'veryfast']]
    for (const enc of encoders) {
      const args = [...common.slice(0, 4), ...enc, ...common.slice(4)]
      const r = await spawnLines(ffmpeg, args, {
        signal,
        onLine: (line) => {
          const m = /^out_time_(?:ms|us)=(\d+)/.exec(line)
          if (m && info.duration > 0) {
            const pct = Math.min(99, Math.round((Number(m[1]) / 1e6 / info.duration) * 100))
            updateRun(s, run.id, { message: `Making a copy under 10 GB for the upload… ${pct}%`, percent: pct })
          }
        }
      })
      if (r.code === 0 && existsSync(out)) return out
      log(s, 'Could not make the upload copy with this encoder', { command: formatCommand(ffmpeg, args), errorOutput: r.stderr.slice(-1500) })
    }
    throw new Error('Could not make a copy of the video small enough for OpusClip (10 GB). See the log for details.')
  }

  /** Google Cloud resumable upload of the file to OpusClip's upload link, with progress. */
  async function upload(s: ProjectStore, run: OpusRun, file: string, signal: AbortSignal): Promise<string> {
    const link = await api<{ url?: string; uploadId?: string; data?: { url?: string; uploadId?: string } }>('POST', OPUS_API.uploadLinks, { video: { usecase: 'LocalUpload' } })
    const url = link.url ?? link.data?.url
    const uploadId = link.uploadId ?? link.data?.uploadId
    if (!url || !uploadId || !/^https:\/\/([a-z0-9-]+\.)*(googleapis\.com|storage\.googleapis\.com|opus\.pro)\//i.test(url)) {
      throw new Error('OpusClip did not give a usable upload link. Try again.')
    }
    const start = await doFetch(url, { method: 'POST', headers: { 'x-goog-resumable': 'start', 'Content-Length': '0' }, redirect: 'manual', signal })
    const session = start.headers.get('location')
    if (!session || (start.status !== 200 && start.status !== 201)) throw new Error(`OpusClip's upload could not start (${start.status}). Try again.`)
    const total = statSync(file).size
    let offset = 0
    for (let attempt = 1; attempt <= 4; attempt++) {
      let sent = offset
      let lastEmit = 0
      const from = offset
      async function* chunks() {
        for await (const chunk of createReadStream(file, { start: from, highWaterMark: 4 * 1024 * 1024 })) {
          sent += (chunk as Buffer).length
          const now = Date.now()
          if (now - lastEmit > 1000) {
            lastEmit = now
            const pct = Math.round((sent / total) * 100)
            updateRun(s, run.id, { percent: pct, message: `Uploading to OpusClip… ${pct}% (${(sent / 1e9).toFixed(2)} of ${(total / 1e9).toFixed(2)} GB)` })
          }
          yield chunk as Buffer
        }
      }
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', 'Content-Length': String(total - from) }
        if (from > 0) headers['Content-Range'] = `bytes ${from}-${total - 1}/${total}`
        const res = await doFetch(session, { method: 'PUT', headers, body: chunks() as any, duplex: 'half', redirect: 'manual', signal } as RequestInit)
        if (res.status === 200 || res.status === 201) return uploadId
        if (res.status !== 308) throw new Error(`upload answered ${res.status}`)
      } catch (err) {
        if (signal.aborted) throw err
        log(s, `Upload interrupted, resuming (try ${attempt})`, { error: (err as Error).message })
      }
      // Ask how much arrived and go on from there.
      const q = await doFetch(session, { method: 'PUT', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${total}` }, redirect: 'manual', signal })
      if (q.status === 200 || q.status === 201) return uploadId
      const m = /bytes=\d+-(\d+)/.exec(q.headers.get('range') ?? '')
      offset = m ? Number(m[1]) + 1 : 0
      await sleep(2000 * attempt)
    }
    throw new Error('The upload to OpusClip kept failing. Check the internet connection and try again.')
  }

  // ---- runs

  async function pollOnce(s: ProjectStore, id: string): Promise<OpusRun> {
    const run = runOf(s, id)
    if (!run.projectId) return run
    const p = await api<Record<string, any>>('GET', OPUS_API.project(run.projectId))
    const proj = p.data && !p.stage ? p.data : p
    const stage = String(proj.stage ?? '')
    if (proj.error || stage === 'STALLED' || stage === 'FAILED') {
      const error = typeof proj.error === 'string' ? proj.error : proj.error?.message ? String(proj.error.message) : `OpusClip stopped at ${stage || 'an unknown stage'}.`
      log(s, 'OpusClip project failed', { projectId: run.projectId, stage, error })
      return updateRun(s, id, { phase: 'failed', stage, error, message: undefined })
    }
    if (stage !== 'COMPLETE') {
      const info = stageInfo(stage)
      return updateRun(s, id, { phase: 'processing', stage, percent: info.percent, message: info.label })
    }
    const clips = await fetchClips(run.projectId)
    const old = new Map(run.clips.map((c) => [c.id, c]))
    const merged = clips.map((c) => ({ ...c, ...(old.get(c.id)?.file ? { file: old.get(c.id)!.file } : {}), ...(old.get(c.id)?.censor ? { censor: old.get(c.id)!.censor } : {}) }))
    log(s, `OpusClip clips ready: ${merged.length}`, { projectId: run.projectId })
    return updateRun(s, id, { phase: 'complete', stage, percent: 100, message: `${merged.length} clip${merged.length === 1 ? '' : 's'} ready`, clips: merged })
  }

  async function fetchClips(projectId: string): Promise<OpusClipItem[]> {
    const out: OpusClipItem[] = []
    for (let page = 1; page <= 20; page++) {
      const q = new URLSearchParams({ q: 'findByProjectId', projectId, pageNum: String(page), pageSize: '50' })
      const raw = await api<any>('GET', `${OPUS_API.clips}?${q}`)
      const list: any[] = Array.isArray(raw) ? raw : raw?.data?.list ?? (Array.isArray(raw?.data) ? raw.data : raw?.list ?? [])
      for (const c of list) {
        const clip = c && typeof c === 'object' ? parseClip(c, projectId) : null
        if (clip && !out.some((x) => x.id === clip.id)) out.push(clip)
      }
      const total = num(raw?.total ?? raw?.data?.total)
      if (list.length < 50 || (total !== undefined && out.length >= total)) break
    }
    return out
  }

  function schedulePoll(s: ProjectStore, id: string) {
    if (deps.poll === false || pollers.has(id)) return
    const tick = async () => {
      pollers.delete(id)
      if (ctx.projects.current() !== s) return
      try {
        const r = await pollOnce(s, id)
        if (r.phase === 'processing') pollers.set(id, setTimeout(() => void tick(), POLL_MS))
      } catch (err) {
        log(s, 'Could not check the OpusClip project', { error: (err as Error).message })
        pollers.set(id, setTimeout(() => void tick(), POLL_MS * 4))
      }
    }
    pollers.set(id, setTimeout(() => void tick(), POLL_MS))
  }

  async function start(options: OpusClipOptions): Promise<OpusRun> {
    const s = store()
    if (!apiKey()) throw new Error('Paste your OpusClip API key in Settings > API keys first.')
    if (!options.sourcePath || !existsSync(options.sourcePath)) throw new Error('Choose the video to send (export the edit first).')
    const now = new Date().toISOString()
    const run: OpusRun = {
      id: `opus_${randomBytes(4).toString('hex')}`,
      title: options.title?.trim() || s.project.name,
      createdAt: now,
      updatedAt: now,
      sourceFile: options.sourcePath,
      options,
      phase: 'preparing',
      message: 'Getting ready…',
      clips: []
    }
    const f = load(s)
    f.runs.unshift(run)
    save(s, f)
    emit(s)
    log(s, 'OpusClip run started', { file: basename(options.sourcePath), options: { ...options, sourcePath: basename(options.sourcePath) } })
    const controller = new AbortController()
    uploads.set(run.id, controller)
    void (async () => {
      let copy: string | null = null
      try {
        let file = options.sourcePath
        if (statSync(file).size > MAX_UPLOAD_BYTES) {
          updateRun(s, run.id, { message: 'Making a copy under 10 GB for the upload…', percent: 0 })
          copy = await smallerCopy(s, run, controller.signal)
          file = copy
        }
        updateRun(s, run.id, { phase: 'uploading', percent: 0, message: 'Uploading to OpusClip…' })
        const uploadId = await upload(s, run, file, controller.signal)
        updateRun(s, run.id, { phase: 'processing', percent: 0, message: 'Sent. OpusClip is starting…' })
        const p = await api<Record<string, any>>('POST', OPUS_API.projects, projectBody(uploadId, options))
        const projectId = String(p.id ?? p.projectId ?? p.data?.id ?? p.data?.projectId ?? '')
        if (!projectId) throw new Error('OpusClip did not return a project id.')
        log(s, 'OpusClip project created', { projectId })
        updateRun(s, run.id, { projectId, stage: String(p.stage ?? p.data?.stage ?? 'PENDING'), message: stageInfo(p.stage).label })
        schedulePoll(s, run.id)
      } catch (err) {
        const message = controller.signal.aborted ? 'Cancelled.' : (err as Error).message
        log(s, `OpusClip run failed: ${message}`)
        try {
          updateRun(s, run.id, { phase: 'failed', error: message, message: undefined })
        } catch {
          /* the run was removed */
        }
      } finally {
        uploads.delete(run.id)
        if (copy) rmSync(copy, { force: true })
      }
    })()
    return run
  }

  async function download(runId: string, clipId: string): Promise<string> {
    const s = store()
    const run = runOf(s, runId)
    let clip = run.clips.find((c) => c.id === clipId)
    if (!clip) throw new Error('That clip is no longer in this run.')
    if (!clip.exportUrl && run.projectId) {
      const fresh = (await fetchClips(run.projectId)).find((c) => c.id === clipId)
      if (fresh) clip = { ...clip, ...fresh }
    }
    if (!clip.exportUrl) throw new Error('OpusClip has no download for this clip yet.')
    const res = await doFetch(clip.exportUrl)
    if (!res.ok) throw new Error(`The clip could not be downloaded (${res.status}). Refresh the clips and try again.`)
    const dir = join(s.dir, FINISH_FOLDER, 'Shorts')
    mkdirSync(dir, { recursive: true })
    let out = join(dir, `${safeFileName(clip.title).slice(0, 80)}.mp4`)
    for (let i = 2; existsSync(out); i++) out = join(dir, `${safeFileName(clip.title).slice(0, 80)} (${i}).mp4`)
    writeFileSync(out, Buffer.from(await res.arrayBuffer()))
    updateRun(s, runId, (r) => ({ clips: r.clips.map((c) => (c.id === clipId ? { ...c, file: out } : c)) }))
    log(s, 'Clip downloaded', { clipId, file: basename(out) })
    return out
  }

  async function censor(runId: string, clipId: string, beep: boolean): Promise<OpusRun> {
    const s = store()
    const run = runOf(s, runId)
    const clip = run.clips.find((c) => c.id === clipId)
    if (!clip || !run.projectId) throw new Error('That clip is no longer in this run.')
    const setCensor = (censor: OpusClipItem['censor']) => updateRun(s, runId, (r) => ({ clips: r.clips.map((c) => (c.id === clipId ? { ...c, censor } : c)) }))
    const r = await api<any>('POST', OPUS_API.censorJobs, { projectId: run.projectId, clipId: clip.curationId, options: { beepSound: beep } })
    const jobId = r.jobId ?? r.data?.jobId
    if (!jobId) return setCensor({ status: 'No swear words found', beep })
    setCensor({ jobId, status: 'Working…', beep })
    for (let i = 0; i < 120; i++) {
      await sleep(i === 0 ? 3000 : 5000)
      const j = await api<any>('GET', OPUS_API.censorJob(jobId))
      const status = String(j.status ?? j.data?.status ?? '').toUpperCase()
      if (status === 'CONCLUDED' || status === 'COMPLETED') {
        setCensor({ jobId, status: beep ? 'Swear words bleeped' : 'Swear words muted', beep })
        // The clip's download now has the change.
        try {
          return await refresh(runId)
        } catch {
          return runOf(s, runId)
        }
      }
      if (status === 'FAILED') return setCensor({ jobId, status: 'Failed', beep, error: String(j.error ?? j.data?.error ?? 'OpusClip could not censor this clip.') })
    }
    return setCensor({ jobId, status: 'Still working at OpusClip; refresh later', beep })
  }

  async function refresh(runId: string): Promise<OpusRun> {
    const s = store()
    const r = await pollOnce(s, runId)
    if (r.phase === 'processing') schedulePoll(s, runId)
    return r
  }

  async function socialCopy(o: { runId: string; clipId: string; postAccountId: string; subAccountId?: string; prompt?: string; forceRegenerate?: boolean }): Promise<OpusSocialCopy> {
    const s = store()
    const run = runOf(s, o.runId)
    const clip = run.clips.find((c) => c.id === o.clipId)
    if (!clip || !run.projectId) throw new Error('That clip is no longer in this run.')
    const body: Record<string, unknown> = { projectId: run.projectId, clipId: clip.curationId, postAccountId: o.postAccountId, subAccountId: o.subAccountId || o.postAccountId }
    if (o.prompt?.trim()) body.prompt = o.prompt.trim()
    if (o.forceRegenerate) body.forceRegenerate = true
    const r = await api<any>('POST', OPUS_API.socialCopyJobs, body)
    const jobId = r.data?.jobId ?? r.jobId
    if (!jobId) throw new Error('OpusClip did not start writing the post text.')
    for (let i = 0; i < 60; i++) {
      await sleep(i === 0 ? 2000 : 4000)
      const j = await api<any>('GET', OPUS_API.socialCopyJob(jobId))
      const d = j.data ?? j
      const status = String(d.status ?? '').toUpperCase()
      if (status === 'COMPLETED') {
        const tags = Array.isArray(d.hashtags) ? d.hashtags.join(' ') : String(d.hashtags ?? '')
        return { title: String(d.title ?? ''), description: String(d.description ?? ''), hashtags: tags, ...(d.cached !== undefined ? { cached: !!d.cached } : {}) }
      }
      if (status === 'FAILED') throw new Error('OpusClip could not write the post text for this clip.')
    }
    throw new Error('OpusClip is taking too long to write the post text. Try again.')
  }

  async function post(req: OpusPostRequest): Promise<OpusPostRecord> {
    const s = store()
    const run = runOf(s, req.runId)
    const clip = run.clips.find((c) => c.id === req.clipId)
    if (!clip || !run.projectId) throw new Error('That clip is no longer in this run.')
    if (!req.title.trim()) throw new Error('Give the post a title.')
    const accounts = await socialAccounts().catch(() => [] as OpusAccount[])
    const acc = accounts.find((a) => a.postAccountId === req.postAccountId && (a.subAccountId ?? '') === (req.subAccountId ?? ''))
    const custom: Record<string, unknown> = {}
    if (req.description?.trim()) custom.description = req.description.trim()
    if (req.privacy) custom.privacy = req.privacy
    const body: Record<string, unknown> = {
      projectId: run.projectId,
      clipId: clip.curationId,
      postAccountId: req.postAccountId,
      ...(req.subAccountId ? { subAccountId: req.subAccountId } : {}),
      postDetail: { title: req.title.trim(), ...(req.mediaType ? { mediaType: req.mediaType } : {}), ...(Object.keys(custom).length ? { custom } : {}) }
    }
    let record: OpusPostRecord
    const base = { runId: run.id, clipId: clip.id, clipTitle: clip.title, account: acc?.name ?? req.postAccountId, platform: acc?.platform ?? '', title: req.title.trim(), createdAt: new Date().toISOString() }
    if (req.publishAt) {
      const when = new Date(req.publishAt)
      if (!(when.getTime() > Date.now() + 60_000)) throw new Error('Pick a time at least a minute from now.')
      const r = await api<any>('POST', OPUS_API.schedules, { ...body, publishAt: when.toISOString() })
      record = { kind: 'scheduled', scheduleId: r.data?.scheduleId ?? r.scheduleId, publishAt: when.toISOString(), ...base }
    } else {
      const r = await api<any>('POST', OPUS_API.postTasks, body)
      record = { kind: 'posted', postId: r.data?.postId ?? r.postId, ...base }
    }
    const f = load(s)
    f.posts.unshift(record)
    save(s, f)
    emit(s)
    log(s, record.kind === 'scheduled' ? 'Clip scheduled' : 'Clip posted', { clipId: clip.id, platform: record.platform, publishAt: record.publishAt ?? null })
    return record
  }

  async function socialAccounts(): Promise<OpusAccount[]> {
    const r = await api<any>('GET', OPUS_API.socialAccounts)
    const list: any[] = Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : r?.data?.list ?? []
    return list
      .filter((a) => a && a.postAccountId)
      .map((a) => ({
        postAccountId: String(a.postAccountId),
        ...(a.subAccountId ? { subAccountId: String(a.subAccountId) } : {}),
        platform: String(a.platform ?? a.platformName ?? ''),
        name: String(a.subAccountName ?? a.extUserName ?? a.extUserId ?? a.postAccountId)
      }))
  }

  const collectionList = (r: any): any[] => (Array.isArray(r) ? r : r?.data?.list ?? (Array.isArray(r?.data) ? r.data : []))

  return {
    state() {
      const s = ctx.projects.current()
      if (s) for (const r of load(s).runs) if (r.phase === 'processing' && r.projectId) schedulePoll(s, r.id)
      return snapshot(s)
    },
    async check() {
      if (!apiKey()) return { ok: false, message: 'No OpusClip key yet.' }
      try {
        const t = await this.brandTemplates()
        return { ok: true, message: `Connected to OpusClip (${t.length} brand template${t.length === 1 ? '' : 's'}).` }
      } catch (err) {
        return { ok: false, message: (err as Error).message }
      }
    },
    defaultSource,
    start,
    refresh,
    cancel(runId) {
      uploads.get(runId)?.abort()
    },
    removeRun(runId) {
      const s = store()
      uploads.get(runId)?.abort()
      const t = pollers.get(runId)
      if (t) clearTimeout(t)
      pollers.delete(runId)
      const f = load(s)
      f.runs = f.runs.filter((r) => r.id !== runId)
      save(s, f)
      emit(s)
    },
    download,
    async share(runId, visibility) {
      const s = store()
      const run = runOf(s, runId)
      if (!run.projectId) throw new Error('This run has not reached OpusClip yet.')
      await api('POST', OPUS_API.visibility(run.projectId), { visibility })
      return updateRun(s, runId, { visibility })
    },
    censor,
    async brandTemplates() {
      const r = await api<any>('GET', OPUS_API.brandTemplates)
      const list: any[] = Array.isArray(r) ? r : r?.brand_templates ?? (Array.isArray(r?.data) ? r.data : r?.data?.list ?? [])
      return list.filter((t) => t && (t.id ?? t.templateId)).map((t) => ({ id: String(t.id ?? t.templateId), name: String(t.name ?? t.id ?? t.templateId) }))
    },
    socialAccounts,
    socialCopy,
    post,
    async cancelSchedule(scheduleId) {
      const s = store()
      await api('DELETE', OPUS_API.schedule(scheduleId))
      const f = load(s)
      f.posts = f.posts.map((p) => (p.scheduleId === scheduleId ? { ...p, cancelled: true } : p))
      save(s, f)
      emit(s)
      log(s, 'Scheduled post cancelled', { scheduleId })
    },
    async collections() {
      return collectionList(await api<any>('GET', `${OPUS_API.collections}?q=mine`))
        .filter((c) => c && (c.id ?? c.collectionId))
        .map((c) => ({ id: String(c.id ?? c.collectionId), name: String(c.collectionName ?? c.name ?? c.id) }))
    },
    async createCollection(name) {
      if (!name.trim()) throw new Error('Name the collection.')
      const r = await api<any>('POST', OPUS_API.collections, { collectionName: name.trim() })
      const c = r.data ?? r
      return { id: String(c.id ?? c.collectionId ?? ''), name: String(c.collectionName ?? name.trim()) }
    },
    async deleteCollection(id) {
      await api('DELETE', OPUS_API.collection(id))
    },
    async addToCollection(collectionId, clipId) {
      await api('POST', OPUS_API.collectionContents, { collectionId, contentId: clipId })
    },
    async removeFromCollection(collectionId, clipId) {
      await api('POST', OPUS_API.collectionContentsDelete, { q: 'findByCollectionIdAndContentId', collectionId, contentId: clipId })
    },
    async exportCollection(id) {
      const s = store()
      const r = await api<any>('POST', OPUS_API.collectionExport(id), {})
      const list: any[] = r.data?.contentList ?? r.contentList ?? []
      const dir = join(s.dir, FINISH_FOLDER, 'Shorts', 'Collections', safeFileName(id))
      mkdirSync(dir, { recursive: true })
      const files: string[] = []
      for (const item of list) {
        if (!item?.uriForExport) continue
        const res = await doFetch(String(item.uriForExport))
        if (!res.ok) continue
        const out = join(dir, `${safeFileName(String(item.contentId ?? files.length + 1))}.mp4`)
        writeFileSync(out, Buffer.from(await res.arrayBuffer()))
        files.push(out)
      }
      log(s, `Collection exported: ${files.length} clip(s)`, { collectionId: id })
      return { files, dir }
    }
  }
}
