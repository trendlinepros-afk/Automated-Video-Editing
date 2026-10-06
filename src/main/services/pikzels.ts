/**
 * Thumbnails through the Pikzels API, and the personas and styles ("pikzonalities") they use.
 *
 * Rules from the API:
 *  - one image per request: three options are three requests, run two at a time;
 *  - image links expire after 24 hours: each image is downloaded into thumbnails/ as soon as it is made;
 *  - personas and styles work only on the newest models: the app always uses settings.pikzels.model;
 *  - prompts over 750 characters may be shortened, and links are not allowed: the app warns and strips them;
 *  - busy responses ask the client to wait: retried with increasing delays, never more than three times.
 * The API key lives in the secrets store and never reaches a project file or a log.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { Thumbnail } from '@shared/project'
import type { Pikzonality } from '@shared/settings'
import type { AppContext, PikzelsService } from '../context'
import { registerSecret, type ActivityLog } from '../log'
import { paths } from '../paths'
import { newId, type ProjectStore } from '../project/store'

// ---------------------------------------------------------------- API shape (correct here if Pikzels changes it)

export const PIKZELS_API = {
  baseUrl: 'https://api.pikzels.com',
  keyHeader: 'X-Api-Key',
  thumbnailFromText: '/v2/thumbnail/text', // POST
  createPersona: '/v2/pikzonality/persona', // POST
  createStyle: '/v2/pikzonality/style', // POST
  pikzonality: (id: string) => `/v2/pikzonality/${encodeURIComponent(id)}`, // GET status, PATCH instructions, DELETE
  request: {
    prompt: 'prompt',
    model: 'model',
    format: 'format',
    persona: 'persona',
    style: 'style',
    supportImage: 'support_image_base64',
    name: 'name',
    images: 'image_base64s',
    specialInstructions: 'special_instructions'
  },
  response: {
    output: 'output',
    requestId: 'request_id',
    promptCompacted: 'prompt_compacted',
    model: 'model',
    id: 'id',
    status: 'status',
    progress: 'progress',
    error: 'error' // { code, message }
  },
  /** Models that accept a persona or style. */
  pikzonalityModels: ['pkz_4', 'pkz_4_5'],
  defaultModel: 'pkz_4_5',
  maxPromptChars: 750,
  maxNameChars: 25,
  /** Waits before each retry of a busy or failed request. Never more than three retries. */
  retryDelaysMs: [2000, 5000, 12000],
  concurrency: 2,
  pollMs: 15000
} as const

export class PikzelsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly requestId?: string
  ) {
    super(message)
  }
}

export interface PikzelsDeps {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

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
export function plainError(status: number, code = '', message = '', what: 'persona' | 'style' | 'thumbnail' = 'thumbnail'): string {
  const text = `${code} ${message}`
  if (status === 401 || status === 403 || /unauthori[sz]ed|invalid[_ ]?(api[_ ]?)?key|missing[_ ]?(api[_ ]?)?key/i.test(code)) return 'Pikzels API key is missing or wrong'
  if (status === 402 || /credit|insufficient|balance|payment/i.test(text)) return 'Out of Pikzels credits'
  if (/training|still processing|not[_ ]ready|pikzonality[_ ]processing/i.test(text)) return /style/i.test(text) || what === 'style' ? 'Style still training' : 'Persona still training'
  if (status === 429) return 'Pikzels is busy right now. Try again in a minute.'
  if (status >= 500) return 'Pikzels had a problem on its side. Try again later.'
  if (status === 0) return 'Could not reach Pikzels. Check the internet connection.'
  return message || `Pikzels error (HTTP ${status})`
}

const isBusy = (status: number, code?: string) => status === 429 || status >= 500 || /busy|overloaded|rate[_ ]?limit/i.test(code ?? '')

function imageExt(contentType: string | null, url: string): string {
  if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return '.jpg'
  if (contentType?.includes('webp')) return '.webp'
  if (contentType?.includes('png')) return '.png'
  const e = extname(new URL(url).pathname).toLowerCase()
  return ['.png', '.jpg', '.jpeg', '.webp'].includes(e) ? (e === '.jpeg' ? '.jpg' : e) : '.png'
}

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

  /** One API call with retries on busy answers. Returns the parsed JSON body. */
  async function call(method: string, path: string, body?: unknown, what: 'persona' | 'style' | 'thumbnail' = 'thumbnail'): Promise<Record<string, any>> {
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
      throw new PikzelsError(plainError(status, code, message, what), status, code || undefined, requestId)
    }
  }

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

  async function generateOne(store: ProjectStore, thumb: Thumbnail, opts: { supportImage?: string; persona?: string; style?: string; model: string; format: string }): Promise<void> {
    const r = PIKZELS_API.request
    const body: Record<string, unknown> = { [r.prompt]: thumb.prompt, [r.model]: opts.model, [r.format]: opts.format }
    if (opts.persona) body[r.persona] = opts.persona
    if (opts.style) body[r.style] = opts.style
    if (opts.supportImage) body[r.supportImage] = opts.supportImage
    const logData = { prompt: thumb.prompt, persona: opts.persona ?? null, style: opts.style ?? null, model: opts.model, format: opts.format }
    try {
      const data = await call('POST', PIKZELS_API.thumbnailFromText, body, 'thumbnail')
      const url = data[PIKZELS_API.response.output]
      const requestId = data[PIKZELS_API.response.requestId]
      if (typeof url !== 'string' || !url) throw new PikzelsError('Pikzels returned no image', 200, 'no_output', requestId)
      // Links expire after 24 hours: download now. The key is never sent to the image host.
      const img = await doFetch(url)
      if (!img.ok) throw new PikzelsError(`The image could not be downloaded (HTTP ${img.status})`, img.status, 'download_failed', requestId)
      const bytes = Buffer.from(await img.arrayBuffer())
      const name = `${thumb.id}${imageExt(img.headers.get('content-type'), url)}`
      mkdirSync(store.paths.thumbnails, { recursive: true })
      writeFileSync(join(store.paths.thumbnails, name), bytes)
      const sidecar = {
        id: thumb.id,
        prompt: thumb.prompt,
        persona: opts.persona ?? null,
        style: opts.style ?? null,
        model: data[PIKZELS_API.response.model] ?? opts.model,
        format: opts.format,
        requestId: requestId ?? null,
        promptCompacted: data[PIKZELS_API.response.promptCompacted] ?? null,
        source: thumb.source,
        createdAt: thumb.createdAt
      }
      writeFileSync(join(store.paths.thumbnails, `${thumb.id}.json`), JSON.stringify(sidecar, null, 2) + '\n')
      updateThumb(store, thumb.id, { status: 'done', file: `thumbnails/${name}`, requestId, model: sidecar.model })
      store.log.write('thumbnail', 'Thumbnail made', { ...logData, requestId, file: `thumbnails/${name}` })
    } catch (err) {
      const e = err instanceof PikzelsError ? err : new PikzelsError(err instanceof Error ? err.message : String(err), 0)
      updateThumb(store, thumb.id, { status: 'failed', error: e.message, ...(e.requestId ? { requestId: e.requestId } : {}) })
      store.log.write('thumbnail', `Thumbnail failed: ${e.message}`, { ...logData, requestId: e.requestId ?? null, errorCode: e.code ?? null, httpStatus: e.status })
    }
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

  async function generate(o: { prompts: string[]; source: 'claude' | 'user'; referenceTime?: number }): Promise<void> {
    const store = ctx.projects.current()
    if (!store) throw new Error('Open a project first.')
    const t = store.project.thumbnails
    const model = ctx.settings.get().pikzels.model || PIKZELS_API.defaultModel
    const canUsePikzonality = (PIKZELS_API.pikzonalityModels as readonly string[]).includes(model)
    const persona = canUsePikzonality ? t.personaId || undefined : undefined
    const style = canUsePikzonality ? t.styleId || undefined : undefined
    const batchId = newId('tb')
    const now = new Date().toISOString()
    const items: Thumbnail[] = o.prompts
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, 3)
      .map((original) => {
        const prompt = stripLinks(original)
        const warnings: string[] = []
        if (prompt.length > PIKZELS_API.maxPromptChars) warnings.push(`This prompt is ${prompt.length} characters. Pikzels may shorten prompts over ${PIKZELS_API.maxPromptChars}.`)
        if (prompt !== original.replace(/[ \t]{2,}/g, ' ').trim() && /https?:\/\/|www\./i.test(original)) warnings.push('Links were removed from the prompt.')
        if (!canUsePikzonality && (t.personaId || t.styleId)) warnings.push(`Persona and style only work on the newest models; ${model} was used without them.`)
        return {
          id: newId('thumb'),
          prompt,
          ...(persona ? { personaId: persona } : {}),
          ...(style ? { styleId: style } : {}),
          model,
          format: t.format,
          createdAt: now,
          source: o.source,
          status: 'pending' as const,
          batchId,
          ...(warnings.length ? { warning: warnings.join(' ') } : {})
        }
      })
    if (!items.length) throw new Error('Write a prompt first.')
    store.mutate('Thumbnails requested', 'app', (d) => {
      d.project.thumbnails.items.push(...items)
    }, { bypassLock: true, noHistory: true })
    store.log.write('thumbnail', `Thumbnail request: ${items.length} option${items.length > 1 ? 's' : ''}`, {
      source: o.source,
      persona: persona ?? null,
      style: style ?? null,
      model,
      prompts: items.map((i) => i.prompt)
    })

    const blocked = !apiKey() ? 'Pikzels API key is missing or wrong' : notReady(persona, 'persona') ?? notReady(style, 'style')
    if (blocked) {
      for (const it of items) {
        updateThumb(store, it.id, { status: 'failed', error: blocked })
        store.log.write('thumbnail', `Thumbnail not requested: ${blocked}`, { prompt: it.prompt, persona: persona ?? null, style: style ?? null })
      }
      return
    }

    let supportImage: string | undefined
    if (o.referenceTime !== undefined) {
      try {
        const out = join(store.paths.cache, `thumb_ref_${batchId}.png`)
        const file = await ctx.engine.frame(store.snapshotDoc(), store.dir, o.referenceTime, { width: 1280, out })
        supportImage = readFileSync(file).toString('base64')
      } catch (err) {
        store.log.write('thumbnail', 'The reference frame could not be made; generating without it', { time: o.referenceTime, error: String(err) })
      }
    }

    // One image per request, a few at a time.
    const queue = [...items]
    const worker = async () => {
      for (let it = queue.shift(); it; it = queue.shift()) await generateOne(store, it, { supportImage, persona, style, model, format: t.format })
    }
    await Promise.all(Array.from({ length: Math.min(PIKZELS_API.concurrency, items.length) }, worker))
  }

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

  const service: PikzelsService = {
    hasKey: () => !!apiKey(),

    generate,

    async regenerate(thumbnailId) {
      const store = ctx.projects.current()
      const item = store?.project.thumbnails.items.find((t) => t.id === thumbnailId)
      if (!item) throw new Error('That thumbnail is no longer in the project.')
      await generate({ prompts: [item.prompt], source: item.source })
    },

    list,

    async create(kind, name, imagePaths) {
      const clean = name.trim()
      if (!clean) throw new Error('Give it a name.')
      if (clean.length > PIKZELS_API.maxNameChars) throw new Error(`Names are limited to ${PIKZELS_API.maxNameChars} characters.`)
      if (imagePaths.length !== 3) throw new Error(kind === 'persona' ? 'Choose exactly three face photos.' : 'Choose exactly three reference thumbnails.')
      const missing = imagePaths.find((p) => !existsSync(p))
      if (missing) throw new Error(`Image not found: ${missing}`)
      const r = PIKZELS_API.request
      const body = { [r.name]: clean, [r.images]: imagePaths.map((p) => readFileSync(p).toString('base64')) }
      let data: Record<string, any>
      try {
        data = await call('POST', kind === 'persona' ? PIKZELS_API.createPersona : PIKZELS_API.createStyle, body, kind)
      } catch (err) {
        const e = err as PikzelsError
        ctx.appLog.write('thumbnail', `Could not create ${kind} "${clean}": ${e.message}`, { requestId: e.requestId ?? null, errorCode: e.code ?? null })
        throw new Error(e.message)
      }
      const id = String(data[PIKZELS_API.response.id] ?? '')
      if (!id) throw new Error('Pikzels did not return an id for the new ' + kind)
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
      ctx.appLog.write('thumbnail', `Created ${kind} "${clean}"; training at Pikzels`, { id, requestId: data[PIKZELS_API.response.requestId] ?? null })
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
      saveList(next)
      if (next.some((p) => p.status === 'processing')) schedulePoll()
      return next
    },

    async updateInstructions(id, text) {
      const p = list().find((x) => x.id === id)
      if (!p) throw new Error('That persona or style is not in the list.')
      try {
        await call('PATCH', PIKZELS_API.pikzonality(id), { [PIKZELS_API.request.specialInstructions]: text }, p.kind)
      } catch (err) {
        throw new Error((err as Error).message)
      }
      const updated = { ...p, specialInstructions: text }
      saveList(list().map((x) => (x.id === id ? updated : x)))
      ctx.appLog.write('thumbnail', `Updated special instructions of ${p.kind} "${p.name}"`, { id })
      return updated
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
    }
  }
  return service
}
