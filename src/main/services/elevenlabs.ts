/**
 * Voiceovers in the owner's own voice, made with ElevenLabs.
 *
 *  - Always the one voice named in Settings (default "Adam V3 Pro"): its id is looked up by name once and remembered,
 *    and looked up again if ElevenLabs no longer knows it (the voice was recreated).
 *  - No voice settings are sent, so the voice's own settings at ElevenLabs apply.
 *  - eleven_v3 and eleven_v4 perform audio tags ([excited], [laughs], [pause]); the other models would speak them, so
 *    they are removed for those models.
 *  - The mp3 goes into the project's audio/voiceover/ folder and onto a Voiceover track, anchored to the nearest
 *    word so it follows cuts. Music ducks under it like under the A-roll.
 * The API key lives in the secrets store and never reaches a project file or a log.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VoiceApproval, VoiceBudget, VoiceStatus, VoiceoverRequest, VoiceoverResult } from '@shared/ipc'
import type { Anchor, Item, Project, Track } from '@shared/project'
import { TimelineResolver } from '@shared/timeline'
import type { AppContext } from '../context'
import { registerSecret } from '../log'
import { paths } from '../paths'
import { newId, type ProjectStore } from '../project/store'

// ---------------------------------------------------------------- API shape (correct here if ElevenLabs changes it)

export const ELEVENLABS_API = {
  baseUrl: 'https://api.elevenlabs.io',
  keyHeader: 'xi-api-key',
  voices: '/v1/voices', // GET -> { voices: [{ voice_id, name, category }] }
  speech: (voiceId: string) => `/v1/text-to-speech/${encodeURIComponent(voiceId)}`, // POST { text, model_id } -> audio bytes
  subscription: '/v1/user/subscription', // GET -> { tier, character_count, character_limit, next_character_count_reset_unix }
  /** Best quality first; 192 kbps needs the Creator plan or higher. */
  outputFormats: ['mp3_44100_192', 'mp3_44100_128'],
  defaultModel: 'eleven_v3',
  /** The steady model used when a newer one refuses a line. */
  fallbackModel: 'eleven_multilingual_v2'
} as const

export const VOICE_MODELS = ['eleven_v3', 'eleven_v4', 'eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5'] as const
/** Models that perform audio tags in [brackets]. */
export const TAG_MODELS: readonly string[] = ['eleven_v3', 'eleven_v4']
/** Most characters in one request per model (the API refuses longer text). */
export function maxChars(model: string): number {
  return TAG_MODELS.includes(model) ? 3000 : model === 'eleven_multilingual_v2' ? 10000 : 40000
}

export const VOICE_TRACK: Track = { id: 'voiceover', kind: 'sfx', name: 'Voiceover', muted: false, solo: false, volume: 0, hidden: false }

/** The text as the model should get it: tags removed for models that would read them out, spaces tidied. */
export function textForModel(text: string, model: string): string {
  const t = TAG_MODELS.includes(model) ? text : text.replace(/\[[^\]\n]{1,40}\]/g, ' ')
  return t.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim()
}

/** The text without audio tags, for labels and logs. */
export const spokenWords = (text: string) => text.replace(/\[[^\]\n]{1,40}\]/g, ' ').replace(/\s+/g, ' ').trim()

// ---------------------------------------------------------------- the voiceover limit per video

export const DEFAULT_VOICE_LIMIT_SECONDS = 120
/** How long the owner has to answer before Claude is told to do without the line. */
export const APPROVAL_TIMEOUT_MS = 10 * 60_000

/** Seconds of voiceover in the project (every voiceover item on the timeline). */
export function voiceSecondsUsed(project: Project): number {
  return project.items.reduce((sum, i) => sum + (i.type === 'audio' && i.voiceover ? i.duration : 0), 0)
}

/** The limit for this video: Settings, or more if the owner approved more for it. */
export function voiceLimitSeconds(project: Project, settingsLimit: number | undefined): number {
  return Math.max(settingsLimit ?? DEFAULT_VOICE_LIMIT_SECONDS, project.voiceAllowanceSeconds ?? 0)
}

/** About how long a line takes to say: words at a relaxed talking pace, plus pauses. */
export function estimateSeconds(text: string): number {
  const words = spokenWords(text).split(' ').filter(Boolean).length
  const pauses = (text.match(/\[(long )?pause\]/gi) ?? []).length * 0.7 + (text.match(/…|\.\.\./g) ?? []).length * 0.4
  return Math.max(0.5, Math.round((words / 2.6 + pauses) * 10) / 10)
}

export class ElevenLabsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message)
  }
}

/** ElevenLabs' error answer in plain words. */
export function plainVoiceError(status: number, body: unknown): { message: string; code: string } {
  const detail = (body as { detail?: unknown })?.detail
  let code = ''
  let text = ''
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const d = detail as Record<string, unknown>
    code = String(d.status ?? d.code ?? '')
    text = String(d.message ?? '')
  } else if (Array.isArray(detail)) {
    text = detail.map((d) => (d && typeof d === 'object' ? `${[].concat((d as any).loc ?? []).slice(1).join('.')} ${(d as any).msg ?? ''}`.trim() : String(d))).join('; ')
  } else if (typeof detail === 'string') text = detail
  const all = `${code} ${text}`
  let message: string
  // Running out of characters also answers 401, so it is checked before the key.
  if (/quota_exceeded|insufficient|credits? remaining|character limit/i.test(all)) message = `Out of ElevenLabs characters for this month. ${text}`.trim()
  else if (status === 401 || /invalid_api_key|api key/i.test(all)) message = 'ElevenLabs API key is missing or wrong. Check it in Settings.'
  else if (/voice_not_found|voice.*(not found|does not exist)/i.test(all) || status === 404) message = 'ElevenLabs could not find the voice.'
  else if (/missing_permissions|permission/i.test(all)) message = `This ElevenLabs key is not allowed to do that: ${text || code}. Give the key Text to Speech and Voices access.`
  else if (status === 429 || /too_many_concurrent|rate/i.test(all)) message = 'ElevenLabs is busy. Try again in a moment.'
  else if (status >= 500) message = 'ElevenLabs had a problem on its side. Try again later.'
  else if (status === 0) message = 'Could not reach ElevenLabs. Check the internet connection.'
  else message = `ElevenLabs refused the request: ${text || code || `HTTP ${status}`}`
  return { message, code }
}

export interface VoiceDeps {
  fetch?: typeof fetch
}

export interface VoiceService {
  hasKey(): boolean
  check(): Promise<VoiceStatus>
  /** Speaks the text into an mp3 file (no timeline change). */
  speak(text: string, opts?: { model?: string; out: string }): Promise<{ file: string; model: string; characters: number; warning?: string }>
  generate(req: VoiceoverRequest & { source: 'user' | 'claude'; anchor?: Anchor }): Promise<VoiceoverResult>
  sample(text?: string): Promise<string>
  budget(): VoiceBudget
  /**
   * Claude asks before a line takes the video past its voiceover limit: the owner sees how long it would be and
   * allows or declines. Resolves true when allowed (the video's allowance grows to fit it), false when declined or
   * not answered in time.
   */
  approveOverLimit(o: { seconds: number; text: string }): Promise<boolean>
  answerApproval(id: string, allow: boolean): void
}

export function createVoiceService(ctx: AppContext, deps: VoiceDeps = {}): VoiceService {
  const doFetch = deps.fetch ?? fetch
  const apiKey = () => {
    const k = ctx.secrets.get('elevenlabs')
    if (k) registerSecret(k)
    return k
  }
  const settings = () => ctx.settings.get().voice ?? { voiceName: 'Adam V3 Pro', voiceId: '', model: ELEVENLABS_API.defaultModel }
  const log = (msg: string, data?: Record<string, unknown>) => (ctx.projects.current()?.log ?? ctx.appLog).write('voice', msg, data)

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const key = apiKey()
    if (!key) throw new ElevenLabsError('Add your ElevenLabs API key in Settings first.', 401, 'missing_key')
    let res: Response
    try {
      res = await doFetch(`${ELEVENLABS_API.baseUrl}${path}`, {
        method,
        headers: { [ELEVENLABS_API.keyHeader]: key, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Accept: body !== undefined ? 'audio/mpeg' : 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      })
    } catch (err) {
      throw new ElevenLabsError(plainVoiceError(0, null).message, 0, String((err as Error)?.message ?? err))
    }
    if (res.ok) return res
    let data: unknown = null
    try {
      data = JSON.parse(await res.text())
    } catch {
      data = null
    }
    const { message, code } = plainVoiceError(res.status, data)
    throw new ElevenLabsError(message, res.status, code || undefined)
  }

  /** The voice id for the name in Settings, looked up when not known yet (or no longer valid). */
  async function voiceId(fresh = false): Promise<string> {
    const s = settings()
    if (s.voiceId && !fresh) return s.voiceId
    const res = await call('GET', ELEVENLABS_API.voices)
    const list = ((await res.json()) as { voices?: { voice_id: string; name: string }[] }).voices ?? []
    const want = s.voiceName.trim().toLowerCase()
    const hit = list.find((v) => v.name.trim().toLowerCase() === want) ?? list.find((v) => v.name.toLowerCase().includes(want))
    if (!hit) {
      const names = list.map((v) => v.name).slice(0, 12).join(', ')
      throw new ElevenLabsError(`ElevenLabs has no voice named "${s.voiceName}". Your voices: ${names || 'none'}. Fix the name in Settings.`, 404, 'voice_not_found')
    }
    if (hit.voice_id !== s.voiceId) ctx.settings.update({ voice: { ...s, voiceId: hit.voice_id } })
    return hit.voice_id
  }

  async function usage(): Promise<Pick<VoiceStatus, 'tier' | 'charactersUsed' | 'characterLimit' | 'resetsAt'>> {
    const res = await call('GET', ELEVENLABS_API.subscription)
    const d = (await res.json()) as { tier?: string; character_count?: number; character_limit?: number; next_character_count_reset_unix?: number }
    return {
      tier: d.tier,
      charactersUsed: d.character_count,
      characterLimit: d.character_limit,
      ...(d.next_character_count_reset_unix ? { resetsAt: new Date(d.next_character_count_reset_unix * 1000).toISOString() } : {})
    }
  }

  async function speak(text: string, opts: { model?: string; out: string }) {
    const chosen = opts.model || settings().model || ELEVENLABS_API.defaultModel
    let warning: string | undefined
    const attempt = async (model: string, format: string, id: string) =>
      call('POST', `${ELEVENLABS_API.speech(id)}?output_format=${format}`, { text: textForModel(text, model), model_id: model })
    const formats = ELEVENLABS_API.outputFormats
    let id = await voiceId()
    let model = chosen
    let format = 0
    let refound = false
    let res: Response
    // Each way out below is taken at most once, so this ends.
    for (;;) {
      try {
        res = await attempt(model, formats[format], id)
        break
      } catch (err) {
        if (!(err instanceof ElevenLabsError)) throw err
        if ((err.code === 'voice_not_found' || err.status === 404) && !refound) {
          refound = true
          id = await voiceId(true) // the voice was recreated: find it by name again
        } else if (format === 0 && /output_format|quality|tier|subscription/i.test(`${err.message} ${err.code ?? ''}`)) {
          format = 1 // a plan without 192 kbps
        } else if ((err.status === 400 || err.status === 422) && model !== ELEVENLABS_API.fallbackModel && !/characters|quota/i.test(err.message)) {
          warning = `${model} refused this line (${err.message}); it was made with ${ELEVENLABS_API.fallbackModel} instead.`
          model = ELEVENLABS_API.fallbackModel
        } else throw err
      }
    }
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length < 200) throw new ElevenLabsError('ElevenLabs returned no audio.', 200, 'empty')
    mkdirSync(join(opts.out, '..'), { recursive: true })
    writeFileSync(opts.out, bytes)
    return { file: opts.out, model, characters: textForModel(text, model).length, ...(warning ? { warning } : {}) }
  }

  // One question at a time; later ones wait their turn.
  const pending: { approval: VoiceApproval; resolve: (allow: boolean) => void; timer?: ReturnType<typeof setTimeout> }[] = []
  const showNext = () => {
    const next = pending[0]
    if (!next) return void ctx.send('voice:approval', null)
    if (!next.timer) next.timer = setTimeout(() => settle(next.approval.id, false, 'no answer'), APPROVAL_TIMEOUT_MS)
    ctx.send('voice:approval', next.approval)
  }
  const settle = (id: string, allow: boolean, why: string) => {
    const at = pending.findIndex((p) => p.approval.id === id)
    if (at < 0) return
    const [p] = pending.splice(at, 1)
    if (p.timer) clearTimeout(p.timer)
    const store = ctx.projects.current()
    if (allow && store) {
      // Room for this line (with a little margin, since the real length differs from the estimate).
      const want = Math.ceil((voiceSecondsUsed(store.project) + p.approval.seconds) * 1.1)
      store.mutate('Allow more voiceover', 'user', (d) => {
        d.project.voiceAllowanceSeconds = Math.max(d.project.voiceAllowanceSeconds ?? 0, want)
      }, { bypassLock: true, noHistory: true })
    }
    log(`Voiceover over the limit ${allow ? 'allowed' : `declined (${why})`}`, { seconds: p.approval.seconds, used: p.approval.usedSeconds, limit: p.approval.limitSeconds })
    p.resolve(allow)
    showNext()
  }

  return {
    hasKey: () => !!apiKey(),

    budget() {
      const store = ctx.projects.current()
      if (!store) return { usedSeconds: 0, limitSeconds: settings().maxSecondsPerVideo ?? DEFAULT_VOICE_LIMIT_SECONDS }
      return { usedSeconds: voiceSecondsUsed(store.project), limitSeconds: voiceLimitSeconds(store.project, settings().maxSecondsPerVideo) }
    },

    approveOverLimit(o) {
      const store = ctx.projects.current()
      if (!store) return Promise.resolve(false)
      const approval: VoiceApproval = {
        id: newId('vapr'),
        seconds: o.seconds,
        usedSeconds: Math.round(voiceSecondsUsed(store.project) * 10) / 10,
        limitSeconds: voiceLimitSeconds(store.project, settings().maxSecondsPerVideo),
        text: spokenWords(o.text)
      }
      return new Promise<boolean>((resolve) => {
        pending.push({ approval, resolve })
        if (pending.length === 1) showNext()
      })
    },

    answerApproval(id, allow) {
      settle(id, allow, 'the owner said no')
    },

    async check() {
      const s = settings()
      const base: VoiceStatus = { ok: false, voiceName: s.voiceName, model: s.model || ELEVENLABS_API.defaultModel }
      if (!apiKey()) return { ...base, message: 'Add your ElevenLabs API key in Settings.' }
      try {
        const id = await voiceId(true)
        let u = {}
        try {
          u = await usage()
        } catch (err) {
          // A key limited to speech can still make voiceovers; the count is just unknown.
          log('Could not read the ElevenLabs character count', { error: (err as Error).message })
        }
        return { ...base, ok: true, voiceId: id, ...u }
      } catch (err) {
        return { ...base, message: (err as Error).message }
      }
    },

    speak,

    async generate(req) {
      const store = ctx.projects.current()
      if (!store) throw new Error('Open a project first.')
      const text = (req.text ?? '').trim()
      if (!spokenWords(text)) throw new Error('Type what the voiceover should say.')
      const model = req.model || settings().model || ELEVENLABS_API.defaultModel
      if (text.length > maxChars(model)) throw new Error(`That is ${text.length} characters; ${model} takes at most ${maxChars(model)} in one go. Split it into shorter lines.`)
      const id = newId('aud')
      const rel = `audio/voiceover/vo-${id.replace(/^aud_?/, '')}.mp3`
      const started = Date.now()
      const made = await speak(text, { model, out: join(store.dir, ...rel.split('/')) })
      const probe = await ctx.engine.probe(made.file)
      const duration = Math.max(0.1, probe.duration || 0)
      placeVoiceover(store, { id, file: rel, duration, time: Math.max(0, req.time || 0), anchor: req.anchor, text, model: made.model, source: req.source })
      log(`Voiceover made (${made.characters} characters, ${duration.toFixed(1)} s) in ${((Date.now() - started) / 1000).toFixed(1)} s`, {
        source: req.source,
        model: made.model,
        voice: settings().voiceName,
        file: rel,
        characters: made.characters,
        ...(made.warning ? { warning: made.warning } : {})
      })
      let charactersLeft: number | undefined
      try {
        const u = await usage()
        if (u.characterLimit !== undefined && u.charactersUsed !== undefined) charactersLeft = Math.max(0, u.characterLimit - u.charactersUsed)
      } catch {
        /* the count is a courtesy */
      }
      return { itemId: id, file: rel, duration, characters: made.characters, ...(charactersLeft !== undefined ? { charactersLeft } : {}), ...(made.warning ? { warning: made.warning } : {}) }
    },

    async sample(text) {
      const line = (text ?? '').trim() || `[warmly] Hey, it's ${settings().voiceName.replace(/\s+v\d.*$/i, '')}. This is how my voiceovers will sound.`
      const dir = join(ctx.projects.current()?.paths.cache ?? paths.toolsDir, 'voice')
      const out = join(dir, `sample-${Date.now().toString(36)}.mp3`)
      await speak(line, { out })
      return out
    }
  }
}

/** Puts a voiceover file on the Voiceover track (made when missing), anchored to the word nearest the time. */
export function placeVoiceover(
  store: ProjectStore,
  o: { id: string; file: string; duration: number; time: number; anchor?: Anchor; text: string; model: string; source: 'user' | 'claude' }
): void {
  const doc = store.snapshotDoc()
  const anchor = o.anchor ?? new TimelineResolver(doc.project, doc.transcript).anchorAt(o.time)
  const words = spokenWords(o.text)
  const label = `VO: ${words.length > 40 ? words.slice(0, 38) + '…' : words}`
  store.mutate(`Add voiceover "${words.slice(0, 30)}${words.length > 30 ? '…' : ''}"`, o.source, (d) => {
    if (!d.project.tracks.some((t) => t.id === VOICE_TRACK.id)) {
      // Right under the A-roll, where speech belongs.
      let at = 0
      d.project.tracks.forEach((t, i) => {
        if (t.kind === 'aroll' || t.kind === 'broll') at = i + 1
      })
      d.project.tracks.splice(at, 0, { ...VOICE_TRACK })
    }
    d.project.items.push({
      id: o.id,
      trackId: VOICE_TRACK.id,
      type: 'audio',
      createdBy: o.source,
      anchor,
      duration: o.duration,
      file: o.file,
      in: 0,
      volume: 0,
      fadeIn: 0,
      fadeOut: 0,
      duck: false,
      loop: false,
      label,
      voiceover: true,
      voiceText: o.text,
      voiceModel: o.model
    } as Item)
  })
}
