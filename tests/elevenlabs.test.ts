import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildPlan } from '../src/main/engine/plan'
import { APPROVAL_TIMEOUT_MS, ELEVENLABS_API, createVoiceService, estimateSeconds, plainVoiceError, textForModel, voiceSecondsUsed } from '../src/main/services/elevenlabs'
import { cleanupTemps, fakeContext, makeProject } from './helpers/project'

afterEach(cleanupTemps)

const KEY = 'sk_eleven_secret_0123456789abcdef'
const MP3 = Buffer.alloc(4000, 0xff)

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: any
}

/** A stand-in ElevenLabs. `speech` decides each text-to-speech answer (default: an mp3). */
function fakeEleven(opts: { voices?: { voice_id: string; name: string }[]; speech?: (c: Call, n: number) => Response } = {}) {
  const calls: Call[] = []
  let n = 0
  const fn = (async (input: any, init: any = {}) => {
    const url = String(input)
    const c: Call = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(c)
    const path = url.slice(ELEVENLABS_API.baseUrl.length)
    if (path === ELEVENLABS_API.voices) return Response.json({ voices: opts.voices ?? [{ voice_id: 'v_other', name: 'Rachel' }, { voice_id: 'ZhsORgwxhA7q6YKjJ9lg', name: 'Adam V3 Pro' }] })
    if (path === ELEVENLABS_API.subscription) return Response.json({ tier: 'creator', character_count: 1200, character_limit: 100000, next_character_count_reset_unix: 1793000000 })
    if (path.startsWith('/v1/text-to-speech/')) return opts.speech ? opts.speech(c, ++n) : new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  return { fn, calls }
}

function setup(key: string | null = KEY) {
  const store = makeProject()
  const ctx = fakeContext({ store }) as any
  let settings: any = { voice: { voiceName: 'Adam V3 Pro', voiceId: '', model: 'eleven_v3' } }
  ctx.settings = { get: () => settings, update: (p: any) => (settings = { ...settings, ...p }) }
  ctx.secrets = { get: (n: string) => (n === 'elevenlabs' ? key : null), set: () => {} }
  ctx.engine = { probe: async () => ({ kind: 'audio', duration: 4.25, hasAudio: true }) }
  return { store, ctx, settings: () => settings }
}

describe('ElevenLabs voiceovers', () => {
  it("finds the owner's voice by name, speaks with v3 and puts the line on a Voiceover track", async () => {
    const { store, ctx, settings } = setup()
    const { fn, calls } = fakeEleven()
    const voice = createVoiceService(ctx, { fetch: fn })
    const r = await voice.generate({ text: '[excited] Sixty-five dollars… for THIS?', time: 12.3, source: 'user' })

    const tts = calls.find((c) => c.url.includes('/v1/text-to-speech/'))!
    expect(tts.url).toBe(`${ELEVENLABS_API.baseUrl}/v1/text-to-speech/ZhsORgwxhA7q6YKjJ9lg?output_format=mp3_44100_192`)
    expect(tts.headers['xi-api-key']).toBe(KEY)
    expect(tts.body).toEqual({ text: '[excited] Sixty-five dollars… for THIS?', model_id: 'eleven_v3' }) // the voice's own settings apply
    expect(settings().voice.voiceId).toBe('ZhsORgwxhA7q6YKjJ9lg')

    const track = store.project.tracks.find((t) => t.id === 'voiceover')!
    expect(track).toMatchObject({ kind: 'sfx', name: 'Voiceover' })
    const kinds = store.project.tracks.map((t) => t.kind)
    expect(store.project.tracks.indexOf(track)).toBe(kinds.lastIndexOf('broll') + 1) // right under the footage tracks
    const item = store.project.items.find((i) => i.id === r.itemId)!
    expect(item).toMatchObject({ type: 'audio', trackId: 'voiceover', duration: 4.25, voiceover: true, voiceModel: 'eleven_v3', createdBy: 'user', label: 'VO: Sixty-five dollars… for THIS?' })
    expect(item.type === 'audio' && item.anchor.kind).toBe('word') // follows cuts
    expect(readFileSync(join(store.dir, r.file)).length).toBe(MP3.length)
    expect(r).toMatchObject({ duration: 4.25, characters: 39, charactersLeft: 98800 })

    // Mixed as speech, so music ducks under it.
    const plan = buildPlan(store.snapshotDoc(), { projectDir: store.dir, width: 640, height: 360, fps: 30, burnCaptions: false })
    expect(plan.audio.clips.find((c) => c.id === r.itemId)?.role).toBe('voice')

    // The second line reuses the remembered voice id.
    await voice.generate({ text: 'Again', time: 1, source: 'claude' })
    expect(calls.filter((c) => c.url.endsWith(ELEVENLABS_API.voices))).toHaveLength(1)
    // The key never reaches the log.
    expect(readFileSync(join(store.dir, 'logs', 'activity.jsonl'), 'utf8')).not.toContain(KEY)
  })

  it('removes audio tags for models that would read them out', () => {
    expect(textForModel('[excited] Big news! [laughs] Okay.', 'eleven_multilingual_v2')).toBe('Big news! Okay.')
    expect(textForModel('[excited] Big news!', 'eleven_v4')).toBe('[excited] Big news!')
  })

  it('falls back to 128 kbps, to the steady model, and finds a recreated voice again', async () => {
    const { ctx, settings } = setup()
    settings().voice.voiceId = 'old_id'
    const { fn, calls } = fakeEleven({
      speech: (c) => {
        if (c.url.includes('/old_id')) return Response.json({ detail: { status: 'voice_not_found', message: 'A voice with that id does not exist.' } }, { status: 404 })
        if (c.url.includes('mp3_44100_192')) return Response.json({ detail: { status: 'output_format_not_allowed', message: 'Your subscription does not allow this output format.' } }, { status: 403 })
        if (c.body.model_id === 'eleven_v4') return Response.json({ detail: { status: 'invalid_request', message: 'This voice is not available for this model.' } }, { status: 400 })
        return new Response(MP3, { status: 200 })
      }
    })
    const r = await createVoiceService(ctx, { fetch: fn }).generate({ text: '[curious] Hidden gyro?', time: 0, model: 'eleven_v4', source: 'user' })
    const tts = calls.filter((c) => c.url.includes('/v1/text-to-speech/'))
    expect(tts.at(-1)!.url).toContain('/ZhsORgwxhA7q6YKjJ9lg?output_format=mp3_44100_128')
    expect(tts.at(-1)!.body).toEqual({ text: 'Hidden gyro?', model_id: 'eleven_multilingual_v2' })
    expect(r.warning).toMatch(/eleven_v4 refused this line/)
    expect(settings().voice.voiceId).toBe('ZhsORgwxhA7q6YKjJ9lg')
  })

  it('says plainly when the key, the characters or the voice are the problem', async () => {
    expect(plainVoiceError(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } }).message).toMatch(/API key is missing or wrong/)
    expect(plainVoiceError(401, { detail: { status: 'quota_exceeded', message: 'You have 3 credits remaining, while 40 are required.' } }).message).toBe(
      'Out of ElevenLabs characters for this month. You have 3 credits remaining, while 40 are required.'
    )
    expect(plainVoiceError(422, { detail: [{ loc: ['body', 'text'], msg: 'field required' }] }).message).toBe('ElevenLabs refused the request: text field required')

    const { ctx } = setup()
    const { fn } = fakeEleven({ voices: [{ voice_id: 'x', name: 'Rachel' }] })
    const status = await createVoiceService(ctx, { fetch: fn }).check()
    expect(status).toMatchObject({ ok: false, voiceName: 'Adam V3 Pro' })
    expect(status.message).toMatch(/no voice named "Adam V3 Pro"\. Your voices: Rachel/)

    const none = setup(null)
    await expect(createVoiceService(none.ctx, { fetch: fakeEleven().fn }).generate({ text: 'Hi', time: 0, source: 'user' })).rejects.toThrow(/Add your ElevenLabs API key/)
  })

  it('reports the voice and the characters left this month', async () => {
    const { ctx } = setup()
    const status = await createVoiceService(ctx, { fetch: fakeEleven().fn }).check()
    expect(status).toMatchObject({ ok: true, voiceId: 'ZhsORgwxhA7q6YKjJ9lg', model: 'eleven_v3', tier: 'creator', charactersUsed: 1200, characterLimit: 100000 })
    expect(status.resetsAt).toBe(new Date(1793000000 * 1000).toISOString())
  })
})

describe('voiceover limit per video', () => {
  it('estimates how long a line takes to say', () => {
    expect(estimateSeconds('[excited] Sixty-five dollars for THIS? Let us find out.')).toBe(3.1) // 8 words
    expect(estimateSeconds('[pause] Okay… go')).toBe(1.9) // 2 words + pause + ellipsis
  })

  it('asks the owner past the limit, grows the allowance when allowed, and says no when declined or unanswered', async () => {
    vi.useFakeTimers()
    try {
      const { store, ctx } = setup()
      const sent: { channel: string; payload: any }[] = []
      ctx.send = (channel: string, payload: unknown) => sent.push({ channel, payload })
      const voice = createVoiceService(ctx, { fetch: fakeEleven().fn })
      // 110 s of voiceover already in the video.
      store.mutate('vo', 'user', (d) => void d.project.items.push({ id: 'vo1', trackId: 'sfx', type: 'audio', createdBy: 'claude', anchor: { kind: 'time', time: 0 }, duration: 110, file: 'a.mp3', in: 0, volume: 0, fadeIn: 0, fadeOut: 0, duck: false, loop: false, voiceover: true } as any))
      expect(voice.budget()).toEqual({ usedSeconds: 110, limitSeconds: 120 })

      const allowed = voice.approveOverLimit({ seconds: 20, text: '[curious] What does the gyro do?' })
      const ask = sent.at(-1)!
      expect(ask.channel).toBe('voice:approval')
      expect(ask.payload).toMatchObject({ seconds: 20, usedSeconds: 110, limitSeconds: 120, text: 'What does the gyro do?' })
      voice.answerApproval(ask.payload.id, true)
      expect(await allowed).toBe(true)
      expect(store.project.voiceAllowanceSeconds).toBe(Math.ceil(130 * 1.1))
      expect(sent.at(-1)).toEqual({ channel: 'voice:approval', payload: null })

      const declined = voice.approveOverLimit({ seconds: 60, text: 'A long one' })
      voice.answerApproval(sent.at(-1)!.payload.id, false)
      expect(await declined).toBe(false)
      expect(store.project.voiceAllowanceSeconds).toBe(143)

      // Nobody answers: after 10 minutes it counts as no.
      const unanswered = voice.approveOverLimit({ seconds: 60, text: 'Anyone there?' })
      vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS + 1)
      expect(await unanswered).toBe(false)
      expect(voiceSecondsUsed(store.project)).toBe(110)
    } finally {
      vi.useRealTimers()
    }
  })

  it('asks one question at a time', async () => {
    const { ctx } = setup()
    const sent: any[] = []
    ctx.send = (_c: string, p: unknown) => sent.push(p)
    const voice = createVoiceService(ctx, { fetch: fakeEleven().fn })
    const a = voice.approveOverLimit({ seconds: 200, text: 'first' })
    const b = voice.approveOverLimit({ seconds: 200, text: 'second' })
    expect(sent.filter(Boolean).map((p) => p.text)).toEqual(['first'])
    voice.answerApproval(sent.at(-1).id, false)
    expect(sent.at(-1).text).toBe('second') // the next question shows once the first is answered
    voice.answerApproval(sent.at(-1).id, true)
    expect([await a, await b]).toEqual([false, true])
  })
})
