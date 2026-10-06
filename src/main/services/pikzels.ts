/**
 * Every Pikzels API feature the app uses: thumbnails from text, recreate from an image, edit, face swap,
 * score, titles, and the personas and styles ("pikzonalities") thumbnails are made with.
 *
 * Rules from the API:
 *  - one image per request: three options are three requests, run two at a time;
 *  - image links expire after 24 hours: each image is downloaded into thumbnails/ as soon as it is made;
 *  - personas and styles work only on the newest models (pkz_4, pkz_4_5);
 *  - prompts over 750 characters may be shortened, and links are not allowed: the app warns and strips them;
 *  - busy responses ask the client to wait: retried with increasing delays, never more than three times.
 * Every successful call is priced (shared/pikzelsPricing.ts) and added to the project and all-time spend.
 * The API key lives in the secrets store and never reaches a project file or a log.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'
import type { EditThumbnailRequest, FaceSwapRequest, PikzelsPricing, RecreateRequest, ThumbnailScore, TitlesRequest } from '@shared/ipc'
import {
  PIKZELS_PRICES_UPDATED,
  addSpend,
  costFor,
  defaultPrices,
  effectivePrices,
  formatUsd,
  priceKey,
  supportsPikzonality,
  type PikzelsAction
} from '@shared/pikzelsPricing'
import type { Thumbnail } from '@shared/project'
import type { Pikzonality } from '@shared/settings'
import { TimelineResolver } from '@shared/timeline'
import type { AppContext, PikzelsService } from '../context'
import { registerSecret, type ActivityLog } from '../log'
import { paths } from '../paths'
import { newId, type ProjectStore } from '../project/store'

// ---------------------------------------------------------------- API shape (correct here if Pikzels changes it)

export const PIKZELS_API = {
  baseUrl: 'https://api.pikzels.com',
  keyHeader: 'X-Api-Key',
  thumbnailFromText: '/v2/thumbnail/text', // POST
  thumbnailFromImage: '/v2/thumbnail/image', // POST ("Recreate")
  thumbnailEdit: '/v2/thumbnail/edit', // POST
  /** Unverified: the docs could not be read when this was written. A 404/400 shows "update the app". */
  thumbnailFaceSwap: '/v2/thumbnail/faceswap', // POST
  thumbnailScore: '/v2/thumbnail/score', // POST
  titleFromText: '/v2/title/text', // POST
  createPersona: '/v2/pikzonality/persona', // POST
  createStyle: '/v2/pikzonality/style', // POST
  pikzonality: (id: string) => `/v2/pikzonality/${encodeURIComponent(id)}`, // GET status, PATCH name/instructions, DELETE
  request: {
    prompt: 'prompt',
    model: 'model',
    format: 'format',
    persona: 'persona',
    style: 'style',
    supportImage: 'support_image_base64',
    imageUrl: 'image_url',
    imageBase64: 'image_base64',
    imageWeight: 'image_weight',
    maskBase64: 'mask_base64',
    faceImageBase64: 'face_image_base64',
    title: 'title',
    name: 'name',
    images: 'image_base64s',
    imageUrls: 'image_urls',
    specialInstructions: 'special_instructions'
  },
  response: {
    output: 'output',
    outputs: 'outputs',
    reasoning: 'reasoning',
    requestId: 'request_id',
    promptCompacted: 'prompt_compacted',
    model: 'model',
    mainScore: 'main_score',
    subscores: 'subscores',
    suggestion: 'suggestion',
    id: 'id',
    status: 'status',
    progress: 'progress',
    error: 'error' // { code, message }
  },
  /** Only pkz_2 accepts image_weight. */
  imageWeightModels: ['pkz_2'],
  defaultModel: 'pkz_4_5',
  maxPromptChars: 750,
  maxNameChars: 25,
  /** Waits before each retry of a busy or failed request. Never more than three retries. */
  retryDelaysMs: [2000, 5000, 12000],
  concurrency: 2,
  pollMs: 15000
} as const

export const FEATURE_CHANGED = "Pikzels changed this feature's API; update the app"

export class PikzelsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly requestId?: string,
    /** Pikzels' own error body (trimmed), kept for the log so a rejected request can be diagnosed. */
    readonly details?: unknown
  ) {
    super(message)
  }
}

export interface PikzelsDeps {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

type What = 'persona' | 'style' | 'thumbnail'
type Source = 'claude' | 'user'

/** Remove links from a prompt (the API does not accept them) and tidy the spaces. */
export function stripLinks(prompt: string): string {
  return prompt
    .replace(/\bhttps?:\/\/[^\s)]+/gi, '')
    .replace(/\bwww\.[^\s)]+/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
}

/** A plain-words message for an API failure. */
export function plainError(status: number, code = '', message = '', what: What = 'thumbnail'): string {
  const text = `${code} ${message}`
  if (status === 401 || status === 403 || /unauthori[sz]ed|invalid[_ ]?(api[_ ]?)?key|missing[_ ]?(api[_ ]?)?key/i.test(code)) return 'Pikzels API key is missing or wrong'
  if (status === 402 || /credit|insufficient|balance|payment/i.test(text)) return 'Out of Pikzels credits'
  if (/training|still processing|not[_ ]ready|pikzonality[_ ]processing/i.test(text)) return /style/i.test(text) || what === 'style' ? 'Style still training' : 'Persona still training'
  if (status === 429) return 'Pikzels is busy right now. Try again in a minute.'
  if (status >= 500) return 'Pikzels had a problem on its side. Try again later.'
  if (status === 0) return 'Could not reach Pikzels. Check the internet connection.'
  if (status === 400 || status === 422) {
    const why = [message.replace(/\.$/, ''), code && !message.toLowerCase().includes(code.toLowerCase()) ? `(${code})` : ''].filter(Boolean).join(' ')
    return `Pikzels rejected the request: ${why || 'it was not valid'}.`
  }
  return message || `Pikzels error (HTTP ${status})`
}

const isBusy = (status: number, code?: string) => status === 429 || status >= 500 || /busy|overloaded|rate[_ ]?limit/i.test(code ?? '')

function imageExt(contentType: string | null, url: string): string {
  if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return '.jpg'
  if (contentType?.includes('webp')) return '.webp'
  if (contentType?.includes('png')) return '.png'
  let e = ''
  try {
    e = extname(new URL(url).pathname).toLowerCase()
  } catch {
    e = ''
  }
  return ['.png', '.jpg', '.jpeg', '.webp'].includes(e) ? (e === '.jpeg' ? '.jpg' : e) : '.png'
}

const b64 = (path: string) => readFileSync(path).toString('base64')

const IMAGE_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }
const dataUri = (path: string) => `data:${IMAGE_TYPES[extname(path).toLowerCase()] ?? 'image/jpeg'};base64,${b64(path)}`

/** A thumbnail picked from YouTube is saved as <videoId>__<size>.jpg; its public link is rebuilt from that name. */
export function youtubeThumbnailUrl(path: string): string | null {
  const m = /^([A-Za-z0-9_-]{11})__(maxresdefault|sddefault|hqdefault)\.jpg$/.exec(basename(path))
  return m ? `https://i.ytimg.com/vi/${m[1]}/${m[2]}.jpg` : null
}

/** Any web link is passed to Pikzels as image_url (YouTube watch links work there). */
const isWebUrl = (s: string) => /^https?:\/\//i.test(s.trim())

export function createPikzelsService(ctx: AppContext, deps: PikzelsDeps = {}): PikzelsService {
  const doFetch: typeof fetch = deps.fetch ?? ((...a) => globalThis.fetch(...a))
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let pollTimer: NodeJS.Timeout | null = null
  let pollStarted = 0

  const log = (): ActivityLog => ctx.projects.current()?.log ?? ctx.appLog

  const apiKey = (): string | null => {
    const k = ctx.secrets.get('pikzels')
    if (k) registerSecret(k)
    return k?.trim() || null
  }

  const openStore = (): ProjectStore => {
    const s = ctx.projects.current()
    if (!s) throw new Error('Open a project first.')
    return s
  }

  /** One API call with retries on busy answers. Returns the parsed JSON body. */
  async function call(method: string, path: string, body?: unknown, what: What = 'thumbnail'): Promise<Record<string, any>> {
    const key = apiKey()
    if (!key) throw new PikzelsError('Pikzels API key is missing or wrong', 401, 'missing_key')
    const delays = PIKZELS_API.retryDelaysMs
    for (let attempt = 0; ; attempt++) {
      let status = 0
      let data: Record<string, any> = {}
      let retryAfter = 0
      try {
        const res = await doFetch(`${PIKZELS_API.baseUrl}${path}`, {
          method,
          headers: { [PIKZELS_API.keyHeader]: key, 'Content-Type': 'application/json', Accept: 'application/json' },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        })
        status = res.status
        retryAfter = Number(res.headers.get('retry-after')) || 0
        const raw = await res.text()
        try {
          data = raw ? JSON.parse(raw) : {}
        } catch {
          data = { error: { message: raw.slice(0, 200) } }
        }
        if (res.ok) return data
      } catch (err) {
        status = 0
        data = { error: { code: 'network', message: err instanceof Error ? err.message : String(err) } }
      }
      const err = data?.[PIKZELS_API.response.error] ?? {}
      const code = typeof err === 'object' ? String(err.code ?? '') : String(err)
      const message = typeof err === 'object' ? String(err.message ?? '') : ''
      const requestId = data?.[PIKZELS_API.response.requestId]
      if ((isBusy(status, code) || status === 0) && attempt < delays.length) {
        const wait = Math.min(30000, Math.max(delays[attempt], retryAfter * 1000))
        log().write('thumbnail', `Pikzels busy (HTTP ${status || 'no connection'}), retry ${attempt + 1} of ${delays.length} in ${Math.round(wait / 1000)} s`, { code, requestId })
        await sleep(wait)
        continue
      }
      // Keep Pikzels' whole error answer (minus anything huge) so the log says exactly what it rejected.
      const details = JSON.parse(JSON.stringify(data, (_k, v) => (typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v)))
      throw new PikzelsError(plainError(status, code, message, what), status, code || undefined, requestId, details)
    }
  }

  // ---------------------------------------------------------------- prices and spend

  const overrides = () => ctx.settings.get().pikzels.prices ?? {}

  const pricing = (): PikzelsPricing => {
    const s = ctx.settings.get().pikzels
    return {
      prices: effectivePrices(s.prices),
      defaults: defaultPrices(),
      overrides: { ...(s.prices ?? {}) },
      updated: PIKZELS_PRICES_UPDATED,
      spend: { total: s.spend?.total ?? 0, byAction: { ...(s.spend?.byAction ?? {}) } }
    }
  }

  /** Adds a successful call to the project's and the all-time spend. Returns its cost in USD. */
  const recordSpend = (store: ProjectStore | null, action: PikzelsAction, model?: string): number => {
    const usd = costFor(action, model, overrides())
    const key = priceKey(action, model)
    try {
      const s = ctx.settings.get()
      ctx.settings.update({ pikzels: { ...s.pikzels, spend: addSpend(s.pikzels.spend, key, usd) } })
    } catch (err) {
      ctx.appLog.write('error', 'Could not record the Pikzels spend', { error: String(err) })
    }
    if (store && !store.readOnly) {
      try {
        store.mutate('Pikzels spend', 'app', (d) => {
          d.project.thumbnails.spend = addSpend(d.project.thumbnails.spend, key, usd)
        }, { bypassLock: true, noHistory: true })
      } catch (err) {
        store.log.write('error', 'Could not record the Pikzels spend', { error: String(err) })
      }
    }
    return usd
  }

  // ---------------------------------------------------------------- thumbnail records

  const saveList = (list: Pikzonality[]) => {
    const s = ctx.settings.get()
    ctx.settings.update({ pikzels: { ...s.pikzels, pikzonalities: list } })
  }

  const list = (): Pikzonality[] => [...(ctx.settings.get().pikzels.pikzonalities ?? [])]

  const updateThumb = (store: ProjectStore, id: string, patch: Partial<Thumbnail> & Record<string, unknown>) => {
    try {
      store.mutate('Thumbnail', 'app', (d) => {
        const t = d.project.thumbnails.items.find((x) => x.id === id)
        if (t) Object.assign(t, patch)
      }, { bypassLock: true, noHistory: true })
    } catch (err) {
      store.log.write('error', 'Could not record the thumbnail', { id, error: String(err) })
    }
  }

  const addRecords = (store: ProjectStore, items: Thumbnail[]) => {
    store.mutate('Thumbnails requested', 'app', (d) => {
      d.project.thumbnails.items.push(...items)
    }, { bypassLock: true, noHistory: true })
  }

  const thumbOf = (store: ProjectStore, id: string): Thumbnail => {
    const t = store.project.thumbnails.items.find((x) => x.id === id)
    if (!t) throw new Error('That thumbnail is no longer in the project.')
    return t
  }

  /** The image file of a project thumbnail, or a chosen image file. */
  const sourceImage = (store: ProjectStore, o: { thumbnailId?: string; imagePath?: string }): string => {
    if (o.thumbnailId) {
      const t = thumbOf(store, o.thumbnailId)
      if (!t.file || t.status !== 'done') throw new Error('That thumbnail has no image yet.')
      return isAbsolute(t.file) ? t.file : join(store.dir, t.file)
    }
    if (o.imagePath) {
      if (!existsSync(o.imagePath)) throw new Error(`Image not found: ${o.imagePath}`)
      return o.imagePath
    }
    throw new Error('Choose an image first.')
  }

  const frameImage = async (store: ProjectStore, time: number, tag: string): Promise<string> => {
    const out = join(store.paths.cache, `pikzels_${tag}.png`)
    return ctx.engine.frame(store.snapshotDoc(), store.dir, time, { width: 1280, out })
  }

  /** Training status that blocks using a persona or style, in plain words. */
  const notReady = (id: string | undefined, kind: 'persona' | 'style'): string | null => {
    if (!id) return null
    const p = list().find((x) => x.id === id)
    if (!p) return null // created elsewhere or removed from the list: let the API decide
    const label = kind === 'persona' ? 'Persona' : 'Style'
    if (p.status === 'processing') return `${label} still training`
    if (p.status === 'failed') return `${label} training failed. Create it again in Settings.`
    return null
  }

  /** The persona and style of the project, if the model takes them. */
  const pikzonalities = (store: ProjectStore, model: string) => {
    const t = store.project.thumbnails
    const ok = supportsPikzonality(model)
    return {
      persona: ok ? t.personaId || undefined : undefined,
      style: ok ? t.styleId || undefined : undefined,
      dropped: !ok && !!(t.personaId || t.styleId)
    }
  }

  /**
   * One image-making call: send it, download the image at once (links expire), write the sidecar, mark the
   * record done and count the cost. A failure marks the record failed with a plain message.
   */
  async function imageJob(
    store: ProjectStore,
    record: Thumbnail,
    job: { path: string; body: Record<string, unknown>; action: PikzelsAction; model?: string; logData: Record<string, unknown>; mapError?: (e: PikzelsError) => string }
  ): Promise<Thumbnail> {
    const logData = { action: job.action, ...job.logData }
    try {
      const data = await call('POST', job.path, job.body, 'thumbnail')
      const url = data[PIKZELS_API.response.output]
      const requestId = data[PIKZELS_API.response.requestId]
      if (typeof url !== 'string' || !url) throw new PikzelsError('Pikzels returned no image', 200, 'no_output', requestId)
      // Links expire after 24 hours: download now. The key is never sent to the image host.
      const img = await doFetch(url)
      if (!img.ok) throw new PikzelsError(`The image could not be downloaded (HTTP ${img.status})`, img.status, 'download_failed', requestId)
      const bytes = Buffer.from(await img.arrayBuffer())
      const name = `${record.id}${imageExt(img.headers.get('content-type'), url)}`
      mkdirSync(store.paths.thumbnails, { recursive: true })
      writeFileSync(join(store.paths.thumbnails, name), bytes)
      const model = data[PIKZELS_API.response.model] ?? job.model
      const cost = recordSpend(store, job.action, job.model)
      const sidecar = {
        id: record.id,
        kind: record.kind,
        prompt: record.prompt,
        persona: record.personaId ?? null,
        style: record.styleId ?? null,
        model: model ?? null,
        format: record.format,
        requestId: requestId ?? null,
        promptCompacted: data[PIKZELS_API.response.promptCompacted] ?? null,
        parentId: record.parentId ?? null,
        source: record.source,
        costUsd: cost,
        createdAt: record.createdAt
      }
      writeFileSync(join(store.paths.thumbnails, `${record.id}.json`), JSON.stringify(sidecar, null, 2) + '\n')
      updateThumb(store, record.id, { status: 'done', file: `thumbnails/${name}`, requestId, ...(model ? { model } : {}), cost })
      store.log.write('thumbnail', `${actionName(job.action)} made (${formatUsd(cost)})`, { ...logData, requestId, file: `thumbnails/${name}`, costUsd: cost })
    } catch (err) {
      const e = err instanceof PikzelsError ? err : new PikzelsError(err instanceof Error ? err.message : String(err), 0)
      const message = job.mapError ? job.mapError(e) : e.message
      updateThumb(store, record.id, { status: 'failed', error: message, ...(e.requestId ? { requestId: e.requestId } : {}) })
      store.log.write('thumbnail', `${actionName(job.action)} failed: ${message}`, { ...logData, requestId: e.requestId ?? null, errorCode: e.code ?? null, httpStatus: e.status, costUsd: 0 })
    }
    return thumbOf(store, record.id)
  }

  const actionName = (a: PikzelsAction) =>
    ({ thumbnail: 'Thumbnail', recreate: 'Recreated thumbnail', edit: 'Edited thumbnail', faceswap: 'Face swap', score: 'Score', title: 'Titles', style_training: 'Style', persona_training: 'Persona' })[a]

  /** A new pending record, failed at once when something blocks the call. */
  const newRecord = (store: ProjectStore, fields: Partial<Thumbnail> & { prompt: string; source: Source; kind: Thumbnail['kind'] }): Thumbnail => ({
    id: newId('thumb'),
    format: store.project.thumbnails.format,
    createdAt: new Date().toISOString(),
    status: 'pending',
    ...fields
  })

  const failRecord = (store: ProjectStore, record: Thumbnail, reason: string, logData: Record<string, unknown>) => {
    updateThumb(store, record.id, { status: 'failed', error: reason })
    store.log.write('thumbnail', `Not requested: ${reason}`, { ...logData, costUsd: 0 })
    return thumbOf(store, record.id)
  }

  /** Why a call cannot be made right now, or null. */
  const blockedReason = (persona?: string, style?: string): string | null =>
    !apiKey() ? 'Pikzels API key is missing or wrong' : notReady(persona, 'persona') ?? notReady(style, 'style')

  const promptWarnings = (original: string, cleaned: string): string[] => {
    const w: string[] = []
    if (cleaned.length > PIKZELS_API.maxPromptChars) w.push(`This prompt is ${cleaned.length} characters. Pikzels may shorten prompts over ${PIKZELS_API.maxPromptChars}.`)
    if (/https?:\/\/|www\./i.test(original)) w.push('Links were removed from the prompt.')
    return w
  }

  // ---------------------------------------------------------------- from text

  async function generate(o: { prompts: string[]; source: Source; referenceTime?: number; model?: string }): Promise<void> {
    const store = openStore()
    const t = store.project.thumbnails
    const model = o.model || ctx.settings.get().pikzels.model || PIKZELS_API.defaultModel
    const { persona, style, dropped } = pikzonalities(store, model)
    const batchId = newId('tb')
    const items: Thumbnail[] = o.prompts
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, 3)
      .map((original) => {
        const prompt = stripLinks(original)
        const warnings = promptWarnings(original, prompt)
        if (dropped) warnings.push(`Persona and style only work on PKZ-4 and PKZ-4.5; ${model} was used without them.`)
        return newRecord(store, {
          kind: 'text',
          prompt,
          source: o.source,
          model,
          batchId,
          ...(persona ? { personaId: persona } : {}),
          ...(style ? { styleId: style } : {}),
          ...(warnings.length ? { warning: warnings.join(' ') } : {})
        })
      })
    if (!items.length) throw new Error('Write a prompt first.')
    addRecords(store, items)
    store.log.write('thumbnail', `Thumbnail request: ${items.length} option${items.length > 1 ? 's' : ''} (${formatUsd(items.length * costFor('thumbnail', model, overrides()))})`, {
      source: o.source,
      persona: persona ?? null,
      style: style ?? null,
      model,
      prompts: items.map((i) => i.prompt)
    })

    const blocked = blockedReason(persona, style)
    if (blocked) {
      for (const it of items) failRecord(store, it, blocked, { prompt: it.prompt, persona: persona ?? null, style: style ?? null })
      return
    }

    let supportImage: string | undefined
    if (o.referenceTime !== undefined) {
      try {
        supportImage = b64(await frameImage(store, o.referenceTime, `ref_${batchId}`))
      } catch (err) {
        store.log.write('thumbnail', 'The reference frame could not be made; generating without it', { time: o.referenceTime, error: String(err) })
      }
    }

    const r = PIKZELS_API.request
    // One image per request, a few at a time.
    const queue = [...items]
    const worker = async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        const body: Record<string, unknown> = { [r.prompt]: it.prompt, [r.model]: model, [r.format]: t.format }
        if (persona) body[r.persona] = persona
        if (style) body[r.style] = style
        if (supportImage) body[r.supportImage] = supportImage
        await imageJob(store, it, {
          path: PIKZELS_API.thumbnailFromText,
          body,
          action: 'thumbnail',
          model,
          logData: { prompt: it.prompt, persona: persona ?? null, style: style ?? null, model, format: t.format }
        })
      }
    }
    await Promise.all(Array.from({ length: Math.min(PIKZELS_API.concurrency, items.length) }, worker))
  }

  // ---------------------------------------------------------------- recreate, edit, face swap

  async function recreate(o: RecreateRequest & { source: Source }): Promise<Thumbnail> {
    const store = openStore()
    const model = o.model || ctx.settings.get().pikzels.model || PIKZELS_API.defaultModel
    const { persona, style, dropped } = pikzonalities(store, model)
    const r = PIKZELS_API.request
    const original = (o.prompt ?? '').trim()
    const prompt = stripLinks(original)
    const warnings = promptWarnings(original, prompt)
    if (dropped) warnings.push(`Persona and style only work on PKZ-4 and PKZ-4.5; ${model} was used without them.`)
    const body: Record<string, unknown> = { [r.model]: model, [r.format]: store.project.thumbnails.format }
    let from = ''
    const record = newRecord(store, {
      kind: 'recreate',
      prompt: prompt || '(recreated from an image)',
      source: o.source,
      model,
      ...(o.from.thumbnailId ? { parentId: o.from.thumbnailId } : {}),
      ...(persona ? { personaId: persona } : {}),
      ...(style ? { styleId: style } : {}),
      ...(warnings.length ? { warning: warnings.join(' ') } : {})
    })
    // Check the image before anything is recorded or charged.
    if (o.from.url) {
      if (!isWebUrl(o.from.url)) throw new Error('Paste a full web link, such as a YouTube video link.')
      body[r.imageUrl] = o.from.url.trim()
      from = o.from.url.trim()
    } else if (o.from.time !== undefined) {
      body[r.imageBase64] = b64(await frameImage(store, o.from.time, record.id))
      from = `video frame at ${o.from.time.toFixed(2)}s`
    } else {
      const path = sourceImage(store, { thumbnailId: o.from.thumbnailId, imagePath: o.from.path })
      body[r.imageBase64] = b64(path)
      from = o.from.thumbnailId ? `thumbnail ${o.from.thumbnailId}` : path
    }
    if (prompt) body[r.prompt] = prompt
    if (o.imageWeight && (PIKZELS_API.imageWeightModels as readonly string[]).includes(model)) body[r.imageWeight] = o.imageWeight
    if (persona) body[r.persona] = persona
    if (style) body[r.style] = style
    addRecords(store, [record])
    const logData = { prompt, from, model, persona: persona ?? null, style: style ?? null, source: o.source }
    const blocked = blockedReason(persona, style)
    if (blocked) return failRecord(store, record, blocked, logData)
    return imageJob(store, record, { path: PIKZELS_API.thumbnailFromImage, body, action: 'recreate', model, logData })
  }

  async function edit(o: EditThumbnailRequest & { source: Source }): Promise<Thumbnail> {
    const store = openStore()
    const r = PIKZELS_API.request
    const original = o.prompt.trim()
    if (!original) throw new Error('Describe the change first.')
    const prompt = stripLinks(original)
    const image = sourceImage(store, o)
    const body: Record<string, unknown> = { [r.prompt]: prompt, [r.imageBase64]: b64(image), [r.format]: store.project.thumbnails.format }
    if (o.maskBase64) body[r.maskBase64] = o.maskBase64.replace(/^data:image\/\w+;base64,/, '')
    if (o.supportImagePath) {
      if (!existsSync(o.supportImagePath)) throw new Error(`Image not found: ${o.supportImagePath}`)
      body[r.supportImage] = b64(o.supportImagePath)
    }
    const warnings = promptWarnings(original, prompt)
    const record = newRecord(store, {
      kind: 'edit',
      prompt,
      source: o.source,
      ...(o.thumbnailId ? { parentId: o.thumbnailId } : {}),
      ...(warnings.length ? { warning: warnings.join(' ') } : {})
    })
    addRecords(store, [record])
    const logData = { prompt, from: o.thumbnailId ?? image, mask: !!o.maskBase64, supportImage: !!o.supportImagePath, source: o.source }
    const blocked = blockedReason()
    if (blocked) return failRecord(store, record, blocked, logData)
    return imageJob(store, record, { path: PIKZELS_API.thumbnailEdit, body, action: 'edit', logData })
  }

  async function faceSwap(o: FaceSwapRequest): Promise<Thumbnail> {
    const store = openStore()
    const r = PIKZELS_API.request
    const image = sourceImage(store, o)
    if (!o.facePath || !existsSync(o.facePath)) throw new Error('Choose a photo of the face first.')
    const body = { [r.imageBase64]: b64(image), [r.faceImageBase64]: b64(o.facePath) }
    const record = newRecord(store, { kind: 'faceswap', prompt: 'Face swap', source: 'user', ...(o.thumbnailId ? { parentId: o.thumbnailId } : {}) })
    addRecords(store, [record])
    const logData = { from: o.thumbnailId ?? image, face: o.facePath }
    const blocked = blockedReason()
    if (blocked) return failRecord(store, record, blocked, logData)
    return imageJob(store, record, {
      path: PIKZELS_API.thumbnailFaceSwap,
      body,
      action: 'faceswap',
      logData,
      // The face swap request shape could not be checked against the docs: a 404 or 400 means it differs.
      mapError: (e) => (e.status === 404 || e.status === 400 ? FEATURE_CHANGED : e.message)
    })
  }

  // ---------------------------------------------------------------- score and titles

  async function score(thumbnailId: string, title?: string): Promise<ThumbnailScore> {
    const store = openStore()
    const image = sourceImage(store, { thumbnailId })
    const r = PIKZELS_API.request
    const cleanTitle = title?.trim() || store.project.publish.titles[0] || ''
    const body: Record<string, unknown> = { [r.imageBase64]: b64(image) }
    if (cleanTitle) body[r.title] = cleanTitle
    const logData = { action: 'score', thumbnailId, title: cleanTitle || null }
    let data: Record<string, any>
    try {
      data = await call('POST', PIKZELS_API.thumbnailScore, body)
    } catch (err) {
      const e = err as PikzelsError
      store.log.write('thumbnail', `Score failed: ${e.message}`, { ...logData, requestId: e.requestId ?? null, errorCode: e.code ?? null, costUsd: 0 })
      throw new Error(e.message)
    }
    const main = Number(data[PIKZELS_API.response.mainScore])
    if (!Number.isFinite(main)) throw new Error(FEATURE_CHANGED)
    const result: ThumbnailScore = {
      main,
      subscores: (data[PIKZELS_API.response.subscores] as Record<string, unknown>) ?? {},
      ...(data[PIKZELS_API.response.suggestion] ? { suggestion: String(data[PIKZELS_API.response.suggestion]) } : {}),
      ...(cleanTitle ? { title: cleanTitle } : {}),
      ...(data[PIKZELS_API.response.requestId] ? { requestId: String(data[PIKZELS_API.response.requestId]) } : {}),
      at: new Date().toISOString()
    }
    const cost = recordSpend(store, 'score')
    updateThumb(store, thumbnailId, { score: result })
    store.log.write('thumbnail', `Score ${main} (${formatUsd(cost)})`, { ...logData, requestId: result.requestId ?? null, subscores: result.subscores, costUsd: cost })
    return result
  }

  /** The start of the edited dialogue, as Pikzels' title prompt when you give none. */
  const transcriptPrompt = (store: ProjectStore): string => {
    const words = new TimelineResolver(store.project, store.transcript).placedWords().map((w) => w.word.text.trim())
    let text = ''
    for (const w of words) {
      if ((text + ' ' + w).length > PIKZELS_API.maxPromptChars - 40) break
      text = text ? `${text} ${w}` : w
    }
    return text ? `YouTube video. What is said at the start: ${text}` : store.project.name
  }

  async function titles(o: TitlesRequest & { source: Source }): Promise<string[]> {
    const store = openStore()
    const r = PIKZELS_API.request
    const own = stripLinks(o.prompt?.trim() ?? '')
    const prompt = own || transcriptPrompt(store)
    const body: Record<string, unknown> = { [r.prompt]: prompt }
    if (o.thumbnailId) body[r.supportImage] = b64(sourceImage(store, { thumbnailId: o.thumbnailId }))
    const logData = { action: 'title', prompt, thumbnailId: o.thumbnailId ?? null, fromTranscript: !own, source: o.source }
    let data: Record<string, any>
    try {
      data = await call('POST', PIKZELS_API.titleFromText, body)
    } catch (err) {
      const e = err as PikzelsError
      store.log.write('thumbnail', `Titles failed: ${e.message}`, { ...logData, requestId: e.requestId ?? null, errorCode: e.code ?? null, costUsd: 0 })
      throw new Error(e.message)
    }
    const raw = data[PIKZELS_API.response.outputs]
    const out: string[] = Array.isArray(raw) ? raw.map((x) => String(x).trim()).filter(Boolean) : []
    if (!out.length) throw new Error('Pikzels returned no titles.')
    const cost = recordSpend(store, 'title')
    store.mutate('Titles from Pikzels', o.source === 'claude' ? 'claude' : 'user', (d) => {
      const pub = d.project.publish
      pub.titles = [...out, ...pub.titles.filter((x) => !out.includes(x))]
      pub.updatedAt = new Date().toISOString()
    }, { bypassLock: true })
    store.log.write('thumbnail', `Titles: ${out.length} options (${formatUsd(cost)})`, {
      ...logData,
      titles: out,
      reasoning: data[PIKZELS_API.response.reasoning] ?? null,
      requestId: data[PIKZELS_API.response.requestId] ?? null,
      costUsd: cost
    })
    return out
  }

  // ---------------------------------------------------------------- personas and styles

  /** Polls training status in the background while any persona or style is still training. */
  const schedulePoll = () => {
    if (pollTimer) return
    if (!pollStarted) pollStarted = Date.now()
    pollTimer = setTimeout(async () => {
      pollTimer = null
      try {
        await service.refresh()
      } catch {
        /* next round */
      }
      const training = list().some((p) => p.status === 'processing')
      if (training && Date.now() - pollStarted < 2 * 3600_000) schedulePoll()
      else pollStarted = 0
    }, PIKZELS_API.pollMs)
    pollTimer.unref?.()
  }

  /** Keep a copy of the sample image with the app data, so it survives the original being moved. */
  const keepSample = (id: string, path: string): string => {
    try {
      const dir = join(paths.data, 'pikzels')
      mkdirSync(dir, { recursive: true })
      const dest = join(dir, `${id}${extname(path) || '.png'}`)
      copyFileSync(path, dest)
      return dest
    } catch {
      return path
    }
  }

  const checkName = (name: string): string => {
    const clean = name.trim()
    if (!clean) throw new Error('Give it a name.')
    if (clean.length > PIKZELS_API.maxNameChars) throw new Error(`Names are limited to ${PIKZELS_API.maxNameChars} characters.`)
    return clean
  }

  /** PATCH a persona or style (name and/or special instructions). */
  const patchPikzonality = async (id: string, patch: { name?: string; specialInstructions?: string }): Promise<Pikzonality> => {
    const p = list().find((x) => x.id === id)
    if (!p) throw new Error('That persona or style is not in the list.')
    const r = PIKZELS_API.request
    const body: Record<string, unknown> = {}
    if (patch.name !== undefined) body[r.name] = patch.name
    if (patch.specialInstructions !== undefined) body[r.specialInstructions] = patch.specialInstructions
    try {
      await call('PATCH', PIKZELS_API.pikzonality(id), body, p.kind)
    } catch (err) {
      const e = err as PikzelsError
      ctx.appLog.write('thumbnail', `Could not update ${p.kind} "${p.name}": ${e.message}`, { id, requestId: e.requestId ?? null, errorCode: e.code ?? null })
      throw new Error(e.message)
    }
    const updated: Pikzonality = { ...p, ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.specialInstructions !== undefined ? { specialInstructions: patch.specialInstructions } : {}) }
    saveList(list().map((x) => (x.id === id ? updated : x)))
    return updated
  }

  const service: PikzelsService = {
    hasKey: () => !!apiKey(),

    generate,

    async regenerate(thumbnailId) {
      const store = openStore()
      const item = thumbOf(store, thumbnailId)
      if (item.kind && item.kind !== 'text') throw new Error('Only thumbnails made from a prompt can be regenerated. Make a new one with the same tool.')
      await generate({ prompts: [item.prompt], source: item.source, model: item.model })
    },

    recreate,
    edit,
    faceSwap,
    score,
    titles,

    list,

    async create(kind, name, imagePaths) {
      const clean = checkName(name)
      if (imagePaths.length !== 3) throw new Error(kind === 'persona' ? 'Choose exactly three face photos.' : 'Choose exactly three reference thumbnails.')
      const missing = imagePaths.find((p) => !existsSync(p))
      if (missing) throw new Error(`Image not found: ${missing}`)
      const r = PIKZELS_API.request
      const action: PikzelsAction = kind === 'persona' ? 'persona_training' : 'style_training'
      // The images can go as web links (thumbnails picked from YouTube) or as image data. Each form
      // is tried in turn only while Pikzels rejects the request as invalid; a rejected request costs nothing.
      const urls = imagePaths.map(youtubeThumbnailUrl)
      const attempts: { label: string; body: Record<string, unknown> }[] = []
      if (urls.every((u): u is string => !!u)) attempts.push({ label: 'image links', body: { [r.name]: clean, [r.imageUrls]: urls } })
      attempts.push({ label: 'image data', body: { [r.name]: clean, [r.images]: imagePaths.map(b64) } })
      attempts.push({ label: 'image data with type', body: { [r.name]: clean, [r.images]: imagePaths.map(dataUri) } })
      let data: Record<string, any> | null = null
      let lastError: PikzelsError | null = null
      for (const attempt of attempts) {
        try {
          data = await call('POST', kind === 'persona' ? PIKZELS_API.createPersona : PIKZELS_API.createStyle, attempt.body, kind)
          if (attempt !== attempts[0]) ctx.appLog.write('thumbnail', `Pikzels accepted the ${kind} images as ${attempt.label}`)
          break
        } catch (err) {
          const e = err as PikzelsError
          lastError = e
          ctx.appLog.write('thumbnail', `Could not create ${kind} "${clean}" (sent as ${attempt.label}): ${e.message}`, {
            status: e.status ?? null,
            requestId: e.requestId ?? null,
            errorCode: e.code ?? null,
            pikzelsAnswer: e.details ?? null,
            costUsd: 0
          })
          if (e.status !== 400 && e.status !== 422) break
        }
      }
      if (!data) throw new Error(lastError?.message ?? `Could not create the ${kind}`)
      const id = String(data[PIKZELS_API.response.id] ?? '')
      if (!id) throw new Error('Pikzels did not return an id for the new ' + kind)
      const cost = recordSpend(null, action)
      const entry: Pikzonality = {
        id,
        kind,
        name: clean,
        status: 'processing',
        progress: 0,
        sampleImage: keepSample(id, imagePaths[0]),
        specialInstructions: '',
        createdAt: new Date().toISOString()
      }
      saveList([...list().filter((p) => p.id !== id), entry])
      ctx.appLog.write('thumbnail', `Created ${kind} "${clean}"; training at Pikzels (${formatUsd(cost)})`, { id, requestId: data[PIKZELS_API.response.requestId] ?? null, costUsd: cost })
      schedulePoll()
      return entry
    },

    async refresh() {
      const current = list()
      const next: Pikzonality[] = []
      for (const p of current) {
        if (p.status !== 'processing') {
          next.push(p)
          continue
        }
        try {
          const data = await call('GET', PIKZELS_API.pikzonality(p.id), undefined, p.kind)
          const status = data[PIKZELS_API.response.status]
          const progress = Number(data[PIKZELS_API.response.progress])
          next.push({
            ...p,
            status: status === 'completed' || status === 'failed' ? status : 'processing',
            progress: Number.isFinite(progress) ? progress : status === 'completed' ? 100 : p.progress,
            ...(status === 'failed' ? { error: 'Training failed at Pikzels' } : {})
          })
          if (status === 'completed' || status === 'failed') ctx.appLog.write('thumbnail', `${p.kind} "${p.name}" training ${status}`, { id: p.id })
        } catch (err) {
          const e = err as PikzelsError
          next.push(e.status === 404 ? { ...p, status: 'failed', error: 'Pikzels no longer has this one. Create it again.' } : { ...p, error: e.message })
        }
      }
      // Keep entries added while the refresh was running.
      const seen = new Set(next.map((p) => p.id))
      saveList([...next, ...list().filter((p) => !seen.has(p.id))])
      if (next.some((p) => p.status === 'processing')) schedulePoll()
      return list()
    },

    async updateInstructions(id, text) {
      const u = await patchPikzonality(id, { specialInstructions: text })
      ctx.appLog.write('thumbnail', `Updated special instructions of ${u.kind} "${u.name}"`, { id })
      return u
    },

    async rename(id, name) {
      const clean = checkName(name)
      const before = list().find((x) => x.id === id)?.name
      const u = await patchPikzonality(id, { name: clean })
      ctx.appLog.write('thumbnail', `Renamed ${u.kind} "${before}" to "${clean}"`, { id })
      return u
    },

    async remove(id) {
      const p = list().find((x) => x.id === id)
      try {
        await call('DELETE', PIKZELS_API.pikzonality(id), undefined, p?.kind ?? 'persona')
      } catch (err) {
        const e = err as PikzelsError
        if (e.status !== 404) throw new Error(e.message)
      }
      saveList(list().filter((x) => x.id !== id))
      ctx.appLog.write('thumbnail', `Deleted ${p?.kind ?? 'persona/style'} "${p?.name ?? id}"`, { id })
    },

    pricing,

    setPrices(next) {
      const defaults = defaultPrices()
      const clean: Record<string, number> = {}
      for (const [k, v] of Object.entries(next ?? {})) {
        if (!(k in defaults)) continue
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0) throw new Error('Prices must be numbers of zero or more.')
        if (Math.abs(n - defaults[k]) > 1e-9) clean[k] = Math.round(n * 10000) / 10000
      }
      const s = ctx.settings.get()
      ctx.settings.update({ pikzels: { ...s.pikzels, prices: clean } })
      ctx.appLog.write('thumbnail', next ? 'Pikzels prices updated' : 'Pikzels prices reset to the published list', { overrides: clean })
      return pricing()
    }
  }
  return service
}
