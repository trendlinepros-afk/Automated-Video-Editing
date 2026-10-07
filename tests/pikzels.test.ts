import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectSettingsSchema } from '@shared/project'
import { SettingsSchema } from '@shared/settings'
import type { AppContext } from '../src/main/context'
import { ActivityLog } from '../src/main/log'
import { ProjectStore } from '../src/main/project/store'
import { FEATURE_CHANGED, PIKZELS_API, createPikzelsService, fieldProblems, plainError, stripLinks } from '../src/main/services/pikzels'
import { createSecretsService, createSettingsService } from '../src/main/services/settings'
import { initPaths, paths } from '../src/main/paths'
import { clearBase, grabBase } from '../src/main/services/thumbnailBase'

const KEY = 'pkz_live_secretkey_0123456789'

/** Frames the fake engine was asked for. */
let frames: { time: number; footageOnly: boolean }[] = []

/** Width and height from a JPEG's frame header. */
function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null
  for (let i = 2; i < buf.length - 9; ) {
    if (buf[i] !== 0xff) return null
    const marker = buf[i + 1]
    const len = buf.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xc3) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    i += 2 + len
  }
  return null
}
let dir: string
let store: ProjectStore
let settings: ReturnType<typeof SettingsSchema.parse>

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: any
}

function makeCtx(key: string | null = KEY): AppContext {
  settings = SettingsSchema.parse({})
  return {
    appLog: new ActivityLog(join(dir, 'app.log')),
    settings: { get: () => settings, update: (p: object) => (settings = SettingsSchema.parse({ ...settings, ...p })) },
    engine: {
      // A real picture, so the app can crop and size it for the thumbnail with ffmpeg.
      frame: async (_doc: unknown, _dir: string, time: number, o: { out: string; footageOnly?: boolean }) => {
        frames.push({ time, footageOnly: !!o.footageOnly })
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080', '-frames:v', '1', o.out])
        return o.out
      }
    },
    env: { ffmpeg: () => 'ffmpeg' },
    secrets: { get: (n: string) => (n === 'pikzels' ? key : null), set: () => {} },
    projects: { current: () => store }
  } as unknown as AppContext
}

/**
 * A fake Pikzels. Thumbnail requests answer 429 `busy` times first, then an image URL.
 * `failCall` makes the n-th text-thumbnail call (1-based) fail with 402; `routes` overrides any path.
 */
function fakeFetch(
  opts: {
    busy?: number
    status?: number
    error?: { code: string; message: string }
    failCall?: number
    routes?: Record<string, (body: any, method: string) => { status: number; json: unknown }>
  } = {}
) {
  const calls: Call[] = []
  let busyLeft = opts.busy ?? 0
  let n = 0
  let textCalls = 0
  const fn = (async (input: any, init: any = {}) => {
    const url = String(input)
    const call: Call = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    if (url.startsWith('https://cdn.example.com/')) {
      return new Response(Buffer.from('PNGDATA' + url), { status: 200, headers: { 'content-type': 'image/png' } })
    }
    const path = url.slice(PIKZELS_API.baseUrl.length)
    const route = opts.routes?.[path]
    if (route) {
      const r = route(call.body, call.method)
      return new Response(JSON.stringify(r.json), { status: r.status })
    }
    if (path === PIKZELS_API.thumbnailFromText) {
      if (busyLeft > 0) {
        busyLeft--
        return new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'Too many requests' }, request_id: 'req_busy' }), { status: 429 })
      }
      textCalls++
      if (opts.status) return new Response(JSON.stringify({ error: opts.error, request_id: 'req_err' }), { status: opts.status })
      if (opts.failCall === textCalls) return new Response(JSON.stringify({ error: { code: 'insufficient_credits', message: 'No credits' }, request_id: 'req_402' }), { status: 402 })
    }
    if ([PIKZELS_API.thumbnailFromText, PIKZELS_API.thumbnailFromImage, PIKZELS_API.thumbnailEdit, PIKZELS_API.thumbnailFaceSwap].includes(path as any)) {
      n++
      return new Response(JSON.stringify({ output: `https://cdn.example.com/img${n}.png`, request_id: `req_${n}`, model: call.body?.model }), { status: 200 })
    }
    if (path === PIKZELS_API.thumbnailScore) {
      return new Response(JSON.stringify({ main_score: 8.2, subscores: { clarity: 9, emotion: 7 }, suggestion: 'Bigger text', request_id: 'req_score' }), { status: 200 })
    }
    if (path === PIKZELS_API.titleFromText) {
      return new Response(JSON.stringify({ outputs: ['Title A', 'Title B'], reasoning: 'why', request_id: 'req_titles' }), { status: 200 })
    }
    if (url.includes('/v2/pikzonality/persona')) return new Response(JSON.stringify({ id: 'pz_1' }), { status: 200 })
    if (url.includes('/v2/pikzonality/pz_1')) return new Response(JSON.stringify({ status: 'completed', progress: 100 }), { status: 200 })
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  return { fn, calls }
}

/** A finished thumbnail record in the project, with an image file. */
function addDoneThumb(id = 'thumb_base'): string {
  writeFileSync(join(store.paths.thumbnails, `${id}.png`), 'PNG')
  store.mutate('t', 'app', (d) => {
    d.project.thumbnails.items.push({ id, file: `thumbnails/${id}.png`, prompt: 'base', format: '16:9', createdAt: new Date().toISOString(), source: 'user', status: 'done' })
  }, { noHistory: true })
  return id
}

beforeEach(() => {
  frames = []
  dir = mkdtempSync(join(tmpdir(), 'ave-pkz-'))
  store = ProjectStore.create(join(dir, 'proj'), {
    name: 'Thumbs',
    profileId: 'p1',
    footageFolder: dir,
    settings: ProjectSettingsSchema.parse({}),
    thumbnails: { personaId: 'persona_a', styleId: 'style_b', count: 3, direction: '' },
    appVersion: '1.0.0-test'
  })
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('Pikzels', () => {
  it('sends one request per prompt, with persona, style and model, and downloads each image at once', async () => {
    const { fn, calls } = fakeFetch()
    const svc = createPikzelsService(makeCtx(), { fetch: fn, sleep: async () => {} })
    await svc.generate({ prompts: ['Shocked face, big text "IT EXPLODED"', 'RC car mid-air over a ramp', 'Battery on fire'], source: 'claude' })
    const posts = calls.filter((c) => c.url.endsWith(PIKZELS_API.thumbnailFromText))
    expect(posts).toHaveLength(3)
    for (const p of posts) {
      expect(p.method).toBe('POST')
      expect(p.headers['X-Api-Key']).toBe(KEY)
      expect(p.body).toMatchObject({ model: 'pkz_4_5', format: '16:9', persona: 'persona_a', style: 'style_b' })
    }
    // The key never goes to the image host.
    for (const c of calls.filter((c) => c.url.startsWith('https://cdn.example.com/'))) expect(JSON.stringify(c.headers)).not.toContain(KEY)
    const items = store.project.thumbnails.items
    expect(items).toHaveLength(3)
    expect(items.every((t) => t.status === 'done' && t.file && t.requestId)).toBe(true)
    for (const t of items) {
      expect(existsSync(join(store.dir, t.file!))).toBe(true)
      const sidecar = JSON.parse(readFileSync(join(store.paths.thumbnails, `${t.id}.json`), 'utf8'))
      expect(sidecar).toMatchObject({ prompt: t.prompt, persona: 'persona_a', style: 'style_b', model: 'pkz_4_5', requestId: t.requestId })
    }
  })

  it('retries busy answers with increasing delays, never more than three times', async () => {
    const delays: number[] = []
    const ok = fakeFetch({ busy: 2 })
    await createPikzelsService(makeCtx(), { fetch: ok.fn, sleep: async (ms) => void delays.push(ms) }).generate({ prompts: ['one'], source: 'user' })
    expect(store.project.thumbnails.items[0].status).toBe('done')
    expect(delays).toEqual([2000, 5000])

    delays.length = 0
    const busy = fakeFetch({ busy: 99 })
    await createPikzelsService(makeCtx(), { fetch: busy.fn, sleep: async (ms) => void delays.push(ms) }).generate({ prompts: ['two'], source: 'user' })
    expect(busy.calls.filter((c) => c.url.endsWith(PIKZELS_API.thumbnailFromText))).toHaveLength(4) // first try + 3 retries
    expect(delays).toEqual([2000, 5000, 12000])
    const failed = store.project.thumbnails.items[1]
    expect(failed.status).toBe('failed')
    expect(failed.error).toMatch(/busy/i)
  })

  it('strips links from prompts and warns past 750 characters', async () => {
    expect(stripLinks('Look at https://example.com/x and www.foo.com now')).toBe('Look at and now')
    const { fn, calls } = fakeFetch()
    const long = 'A'.repeat(800)
    await createPikzelsService(makeCtx(), { fetch: fn, sleep: async () => {} }).generate({ prompts: ['Big text see https://evil.example/link', long], source: 'claude' })
    const prompts = calls.filter((c) => c.url.endsWith(PIKZELS_API.thumbnailFromText)).map((c) => c.body.prompt)
    expect(prompts.some((p) => p.includes('http'))).toBe(false)
    const items = store.project.thumbnails.items as any[]
    expect(items.find((t) => t.prompt.startsWith('Big text')).warning).toMatch(/Links were removed/)
    expect(items.find((t) => t.prompt === long).warning).toMatch(/750/)
  })

  it('gives plain error messages and logs the request id, never the key', async () => {
    expect(plainError(402, 'insufficient_credits')).toBe('Out of Pikzels credits')
    expect(plainError(401)).toBe('Pikzels API key is missing or wrong')
    expect(plainError(400, 'persona_training', 'Persona is still training')).toBe('Persona still training')

    const { fn } = fakeFetch({ status: 402, error: { code: 'insufficient_credits', message: `Not enough credits for key ${KEY}` } })
    await createPikzelsService(makeCtx(), { fetch: fn, sleep: async () => {} }).generate({ prompts: ['x'], source: 'user' })
    const t = store.project.thumbnails.items[0]
    expect(t.status).toBe('failed')
    expect(t.error).toBe('Out of Pikzels credits')
    const logText = readFileSync(store.log.file, 'utf8')
    expect(logText).toContain('req_err')
    expect(logText).toContain('insufficient_credits')
    expect(logText).not.toContain(KEY)
    for (const f of readdirSync(store.dir)) if (f.endsWith('.json')) expect(readFileSync(join(store.dir, f), 'utf8')).not.toContain(KEY)
  })

  it('does not call the API without a key or while the persona trains', async () => {
    const { fn, calls } = fakeFetch()
    await createPikzelsService(makeCtx(null), { fetch: fn, sleep: async () => {} }).generate({ prompts: ['x'], source: 'user' })
    expect(calls).toHaveLength(0)
    expect(store.project.thumbnails.items[0].error).toBe('Pikzels API key is missing or wrong')

    const ctx = makeCtx()
    settings.pikzels.pikzonalities = [{ id: 'persona_a', kind: 'persona', name: 'Me', status: 'processing', progress: 40, specialInstructions: '', createdAt: '' }]
    await createPikzelsService(ctx, { fetch: fn, sleep: async () => {} }).generate({ prompts: ['y'], source: 'user' })
    expect(calls).toHaveLength(0)
    expect(store.project.thumbnails.items[1].error).toBe('Persona still training')
  })

  it('creates a persona from three images, limits names to 25 characters, and refreshes training', async () => {
    const imgs = [1, 2, 3].map((i) => {
      const p = join(dir, `face${i}.png`)
      writeFileSync(p, `img${i}`)
      return p
    })
    const { fn, calls } = fakeFetch()
    const svc = createPikzelsService(makeCtx(), { fetch: fn, sleep: async () => {} })
    await expect(svc.create('persona', 'A name that is far too long to use', imgs)).rejects.toThrow(/25 characters/)
    await expect(svc.create('persona', 'Me', imgs.slice(0, 2))).rejects.toThrow(/three/)
    const p = await svc.create('persona', 'Me', imgs)
    expect(p).toMatchObject({ id: 'pz_1', status: 'processing', kind: 'persona' })
    const post = calls.find((c) => c.url.endsWith('/v2/pikzonality/persona'))!
    expect(post.body.image_base64s).toHaveLength(3)
    const list = await svc.refresh()
    expect(list[0]).toMatchObject({ id: 'pz_1', status: 'completed', progress: 100 })
  })

  it('sends YouTube picks as links, falls back to image data while Pikzels rejects the request, and says why', async () => {
    const imgs = ['aaaaaaaaaaa__maxresdefault', 'bbbbbbbbbbb__sddefault', 'ccccccccccc__hqdefault'].map((n) => {
      const p = join(dir, `${n}.jpg`)
      writeFileSync(p, n)
      return p
    })
    const bodies: any[] = []
    const reject = { status: 400, json: { error: { code: 'invalid_request', message: 'The request is invalid.' }, request_id: 'req_bad' } }
    const accept = { status: 200, json: { id: 'pz_9' } }
    // Pikzels rejects links and raw data, and accepts data with its type.
    const { fn } = fakeFetch({
      routes: {
        '/v2/pikzonality/persona': (body) => {
          bodies.push(body)
          return body.image_base64s?.[0]?.startsWith('data:image/jpeg;base64,') ? accept : reject
        }
      }
    })
    const ctx = makeCtx()
    const p = await createPikzelsService(ctx, { fetch: fn, sleep: async () => {} }).create('persona', 'Adam', imgs)
    expect(p.id).toBe('pz_9')
    expect(bodies.map((b) => Object.keys(b).sort().join(','))).toEqual(['image_urls,name', 'image_base64s,name', 'image_base64s,name'])
    expect(bodies[0].image_urls).toEqual([
      'https://i.ytimg.com/vi/aaaaaaaaaaa/maxresdefault.jpg',
      'https://i.ytimg.com/vi/bbbbbbbbbbb/sddefault.jpg',
      'https://i.ytimg.com/vi/ccccccccccc/hqdefault.jpg'
    ])
    expect(bodies[1].image_base64s[0]).toBe(Buffer.from('aaaaaaaaaaa__maxresdefault').toString('base64'))
    // Pikzels' own answer is in the log for each rejected form.
    const log = readFileSync(join(dir, 'app.log'), 'utf8')
    expect(log).toContain('sent as image links')
    expect(log).toContain('invalid_request')

    // When every form is rejected, the message says what Pikzels said; a wrong key is not retried in other forms.
    const all = fakeFetch({ routes: { '/v2/pikzonality/persona': () => reject } })
    await expect(createPikzelsService(makeCtx(), { fetch: all.fn, sleep: async () => {} }).create('persona', 'Adam', imgs)).rejects.toThrow(
      'Pikzels rejected the request: The request is invalid (invalid_request).'
    )
    let n = 0
    const denied = fakeFetch({ routes: { '/v2/pikzonality/persona': () => (n++, { status: 401, json: { error: { code: 'unauthorized', message: 'Bad key' } } }) } })
    await expect(createPikzelsService(makeCtx(), { fetch: denied.fn, sleep: async () => {} }).create('persona', 'Adam', imgs)).rejects.toThrow(/key is missing or wrong/)
    expect(n).toBe(1)
  })

  it('recreates from an image file, a video frame and a YouTube link', async () => {
    const { fn, calls } = fakeFetch()
    const svc = createPikzelsService(makeCtx(), { fetch: fn, sleep: async () => {} })
    const img = join(dir, 'ref.png')
    writeFileSync(img, 'REFIMG')
    const a = await svc.recreate({ from: { path: img }, prompt: 'Make it red', source: 'user' })
    expect(a).toMatchObject({ kind: 'recreate', status: 'done', model: 'pkz_4_5' })
    const b1 = calls.filter((c) => c.url.endsWith(PIKZELS_API.thumbnailFromImage))[0].body
    expect(b1).toMatchObject({ image_base64: Buffer.from('REFIMG').toString('base64'), prompt: 'Make it red', model: 'pkz_4_5', persona: 'persona_a', style: 'style_b' })

    await svc.recreate({ from: { url: 'https://www.youtube.com/watch?v=abc123' }, source: 'user' })
    const b2 = calls.filter((c) => c.url.endsWith(PIKZELS_API.thumbnailFromImage))[1].body
    expect(b2.image_url).toBe('https://www.youtube.com/watch?v=abc123')
    expect(b2.image_base64).toBeUndefined()

    // Older model: no persona or style, image_weight only on pkz_2.
    await svc.recreate({ from: { time: 12.5 }, model: 'pkz_2', imageWeight: 'high', source: 'claude' })
    const b3 = calls.filter((c) => c.url.endsWith(PIKZELS_API.thumbnailFromImage))[2].body
    // The frame is the clean footage (no captions or graphics), sized for a 16:9 thumbnail.
    expect(frames.at(-1)).toEqual({ time: 12.5, footageOnly: true })
    expect(jpegSize(Buffer.from(b3.image_base64, 'base64'))).toEqual({ width: 1280, height: 720 })
    expect(b3).toMatchObject({ model: 'pkz_2', image_weight: 'high' })
    expect(b3.persona).toBeUndefined()
    expect(store.project.thumbnails.spend?.byAction).toEqual({ 'recreate:pkz_4_5': 0.26, 'recreate:pkz_2': 0.2 })
    for (const t of store.project.thumbnails.items) expect(existsSync(join(store.dir, t.file!))).toBe(true)
  })

  it('edits a thumbnail with a painted mask and a support image, keeping the original', async () => {
    const { fn, calls } = fakeFetch()
    const base = addDoneThumb()
    const support = join(dir, 'support.png')
    writeFileSync(support, 'SUP')
    const t = await createPikzelsService(makeCtx(), { fetch: fn, sleep: async () => {} }).edit({ thumbnailId: base, prompt: 'Text says WOW', maskBase64: 'data:image/png;base64,TUFTSw==', supportImagePath: support, source: 'user' })
    expect(t).toMatchObject({ kind: 'edit', status: 'done', parentId: base, cost: 0.12 })
    const body = calls.find((c) => c.url.endsWith(PIKZELS_API.thumbnailEdit))!.body
    expect(body).toMatchObject({ prompt: 'Text says WOW', image_base64: Buffer.from('PNG').toString('base64'), mask_base64: 'TUFTSw==', support_image_base64: Buffer.from('SUP').toString('base64'), format: '16:9' })
    expect(store.project.thumbnails.items.find((x) => x.id === base)!.status).toBe('done')
  })

  it('face swaps, and explains plainly when the endpoint has changed', async () => {
    const face = join(dir, 'face.png')
    writeFileSync(face, 'FACE')
    const base = addDoneThumb()
    const ok = fakeFetch()
    const t = await createPikzelsService(makeCtx(), { fetch: ok.fn, sleep: async () => {} }).faceSwap({ thumbnailId: base, facePath: face })
    expect(t).toMatchObject({ kind: 'faceswap', status: 'done', source: 'user' })
    expect(ok.calls.find((c) => c.url.endsWith(PIKZELS_API.thumbnailFaceSwap))!.body).toEqual({ image_base64: Buffer.from('PNG').toString('base64'), face_image_base64: Buffer.from('FACE').toString('base64') })

    const changed = fakeFetch({ routes: { [PIKZELS_API.thumbnailFaceSwap]: () => ({ status: 404, json: { error: { code: 'not_found', message: 'Not found' } } }) } })
    const before = store.project.thumbnails.spend?.total
    const f = await createPikzelsService(makeCtx(), { fetch: changed.fn, sleep: async () => {} }).faceSwap({ thumbnailId: base, facePath: face })
    expect(f.status).toBe('failed')
    expect(f.error).toBe(FEATURE_CHANGED)
    expect(store.project.thumbnails.spend?.total).toBe(before)
    expect(readFileSync(store.log.file, 'utf8')).toContain(FEATURE_CHANGED)
  })

  it('scores a thumbnail and stores the result on its record', async () => {
    const { fn, calls } = fakeFetch()
    const base = addDoneThumb()
    const res = await createPikzelsService(makeCtx(), { fetch: fn, sleep: async () => {} }).score(base, 'My video')
    expect(res).toMatchObject({ main: 8.2, subscores: { clarity: 9, emotion: 7 }, suggestion: 'Bigger text', title: 'My video', requestId: 'req_score' })
    expect(calls.find((c) => c.url.endsWith(PIKZELS_API.thumbnailScore))!.body).toEqual({ image_base64: Buffer.from('PNG').toString('base64'), title: 'My video' })
    expect(store.project.thumbnails.items.find((t) => t.id === base)!.score).toMatchObject({ main: 8.2, suggestion: 'Bigger text' })
    expect(store.project.thumbnails.spend).toEqual({ total: 0.03, byAction: { score: 0.03 } })
  })

  it('generates titles into the Publish tab title options', async () => {
    const { fn, calls } = fakeFetch()
    store.mutate('t', 'app', (d) => void (d.project.publish.titles = ['Old title', 'Title B']), { noHistory: true })
    const base = addDoneThumb()
    const out = await createPikzelsService(makeCtx(), { fetch: fn, sleep: async () => {} }).titles({ thumbnailId: base, source: 'user' })
    expect(out).toEqual(['Title A', 'Title B'])
    const body = calls.find((c) => c.url.endsWith(PIKZELS_API.titleFromText))!.body
    expect(body.prompt).toBe('Thumbs') // no transcript yet: the project name
    expect(body.support_image_base64).toBe(Buffer.from('PNG').toString('base64'))
    expect(store.project.publish.titles).toEqual(['Title A', 'Title B', 'Old title'])
    expect(store.project.thumbnails.spend?.byAction).toEqual({ title: 0.08 })
  })

  it('renames and updates instructions with PATCH, names up to 25 characters', async () => {
    const patches: any[] = []
    const { fn } = fakeFetch({ routes: { '/v2/pikzonality/pz_9': (body, method) => (patches.push({ body, method }), { status: 200, json: {} }) } })
    const ctx = makeCtx()
    settings.pikzels.pikzonalities = [{ id: 'pz_9', kind: 'style', name: 'Old', status: 'completed', progress: 100, specialInstructions: '', createdAt: '' }]
    const svc = createPikzelsService(ctx, { fetch: fn, sleep: async () => {} })
    await expect(svc.rename('pz_9', 'x'.repeat(26))).rejects.toThrow(/25 characters/)
    const u = await svc.rename('pz_9', 'Bold RC')
    expect(u.name).toBe('Bold RC')
    await svc.updateInstructions('pz_9', 'Red text always')
    expect(patches).toEqual([
      { method: 'PATCH', body: { name: 'Bold RC' } },
      { method: 'PATCH', body: { special_instructions: 'Red text always' } }
    ])
    expect(svc.list()[0]).toMatchObject({ name: 'Bold RC', specialInstructions: 'Red text always' })
  })

  it('counts only successful calls in the project and all-time spend', async () => {
    const { fn } = fakeFetch({ failCall: 2 })
    const ctx = makeCtx()
    const svc = createPikzelsService(ctx, { fetch: fn, sleep: async () => {} })
    await svc.generate({ prompts: ['a', 'b', 'c'], source: 'user' })
    const items = store.project.thumbnails.items
    expect(items.filter((t) => t.status === 'done')).toHaveLength(2)
    expect(items.find((t) => t.status === 'failed')!.error).toBe('Out of Pikzels credits')
    expect(store.project.thumbnails.spend).toEqual({ total: 0.26, byAction: { 'thumbnail:pkz_4_5': 0.26 } })
    expect(settings.pikzels.spend.total).toBeCloseTo(0.26, 6)
    // Training is counted all-time only.
    const imgs = [1, 2, 3].map((i) => {
      const p = join(dir, `s${i}.png`)
      writeFileSync(p, 'x')
      return p
    })
    await svc.create('persona', 'Me', imgs)
    expect(settings.pikzels.spend.byAction.persona_training).toBe(0.38)
    expect(svc.pricing().spend.total).toBeCloseTo(0.64, 6)
    expect(store.project.thumbnails.spend?.total).toBe(0.26)
    expect(readFileSync(store.log.file, 'utf8')).toContain('"costUsd":0.13')
  })

  it('uses the owner\'s price overrides and resets to the published prices', async () => {
    const { fn } = fakeFetch()
    const svc = createPikzelsService(makeCtx(), { fetch: fn, sleep: async () => {} })
    expect(svc.pricing().prices['thumbnail:pkz_4_5']).toBe(0.13)
    const p = svc.setPrices({ 'thumbnail:pkz_4_5': 0.2, score: 0.03, bogus: 9 })
    expect(p.overrides).toEqual({ 'thumbnail:pkz_4_5': 0.2 }) // equal-to-default and unknown keys are not stored
    expect(settings.pikzels.prices).toEqual({ 'thumbnail:pkz_4_5': 0.2 })
    expect(() => svc.setPrices({ score: -1 })).toThrow()
    await svc.generate({ prompts: ['a'], source: 'user' })
    expect(store.project.thumbnails.items[0].cost).toBe(0.2)
    expect(store.project.thumbnails.spend?.total).toBe(0.2)
    const reset = svc.setPrices(null)
    expect(reset.overrides).toEqual({})
    expect(reset.prices['thumbnail:pkz_4_5']).toBe(0.13)
  })

  it('keeps the API key in the user data folder across an app update', () => {
    const data = join(dir, 'userdata')
    initPaths({ data, runtime: join(dir, 'runtime'), resources: join(dir, 'install', 'resources') })
    // Reversible stand-in for Windows DPAPI.
    const safe = {
      isEncryptionAvailable: () => true,
      encryptString: (t: string) => Buffer.from(`enc:${Buffer.from(t).toString('hex')}`),
      decryptString: (b: Buffer) => Buffer.from(b.toString().slice(4), 'hex').toString()
    }
    const ctx = { appLog: new ActivityLog(join(dir, 'app.log')) } as unknown as AppContext
    createSecretsService(ctx, safe).set('pikzels', KEY)
    ctx.settings = createSettingsService(ctx)
    ctx.settings.update({ pikzels: { ...ctx.settings.get().pikzels, prices: { score: 0.05 } } })
    expect(paths.secretsFile.startsWith(data)).toBe(true)
    expect(readFileSync(paths.secretsFile, 'utf8')).not.toContain(KEY)

    // An update replaces the program files only: the install folder goes, the user data folder stays.
    rmSync(join(dir, 'install'), { recursive: true, force: true })
    initPaths({ data, runtime: join(dir, 'runtime'), resources: join(dir, 'install-1.0.1', 'resources') })
    const after = { appLog: new ActivityLog(join(dir, 'app2.log')) } as unknown as AppContext
    expect(createSecretsService(after, safe).get('pikzels')).toBe(KEY)
    expect(createSettingsService(after).get().pikzels.prices).toEqual({ score: 0.05 })
  })
})

describe('Thumbnail base picture', () => {
  it('grabs the clean footage frame at YouTube thumbnail size and sends it with every prompt', async () => {
    const ctx = makeCtx()
    const first = await grabBase(ctx, store, 4.2, 'user')
    expect(frames).toEqual([{ time: 4.2, footageOnly: true }])
    expect(store.project.thumbnails.base).toMatchObject({ file: first.file, time: 4.2, by: 'user' })
    const firstPath = join(store.dir, first.file)
    expect(jpegSize(readFileSync(firstPath))).toEqual({ width: 1280, height: 720 })

    const { fn, calls } = fakeFetch()
    await createPikzelsService(ctx, { fetch: fn, sleep: async () => {} }).generate({ prompts: ['Me with the drift car', 'Close-up'], source: 'user' })
    const posts = calls.filter((c) => c.url.endsWith(PIKZELS_API.thumbnailFromText))
    expect(posts).toHaveLength(2)
    for (const p of posts) expect(p.body.support_image_base64).toBe(readFileSync(firstPath).toString('base64'))

    // A new grab replaces the old picture; clearing removes it, and prompts go without one.
    const second = await grabBase(ctx, store, 9, 'user')
    expect(existsSync(firstPath)).toBe(false)
    expect(existsSync(join(store.dir, second.file))).toBe(true)
    clearBase(store)
    expect(store.project.thumbnails.base).toBeUndefined()
    expect(existsSync(join(store.dir, second.file))).toBe(false)
    await createPikzelsService(ctx, { fetch: fn, sleep: async () => {} }).generate({ prompts: ['No base'], source: 'user' })
    expect(calls.filter((c) => c.url.endsWith(PIKZELS_API.thumbnailFromText)).at(-1)!.body.support_image_base64).toBeUndefined()
  })

  it('crops to the thumbnail format', async () => {
    store.mutate('t', 'user', (d) => void (d.project.thumbnails.format = '9:16'))
    const b = await grabBase(makeCtx(), store, 1, 'claude')
    expect(jpegSize(readFileSync(join(store.dir, b.file)))).toEqual({ width: 720, height: 1280 })
  })
})

describe('Pikzels rejecting the base picture', () => {
  const invalid = { status: 400, json: { error: { code: 'VALIDATION_ERROR', message: 'The request is invalid', details: [{ field: 'support_image_base64', message: 'must be a data URI' }] } } }
  const ok = { status: 200, json: { output: 'https://cdn.example.com/ok.png', request_id: 'req_ok' } }

  it('tries the picture as a data URI, then without it, and says so', async () => {
    const ctx = makeCtx()
    await grabBase(ctx, store, 2, 'user')
    const bodies: any[] = []
    const { fn } = fakeFetch({ routes: { [PIKZELS_API.thumbnailFromText]: (b) => (bodies.push(b), bodies.length < 2 ? invalid : ok) } })
    await createPikzelsService(ctx, { fetch: fn, sleep: async () => {} }).generate({ prompts: ['Me and the car'], source: 'user' })
    expect(bodies[0].support_image_base64.startsWith('/9j/')).toBe(true)
    expect(bodies[1].support_image_base64.startsWith('data:image/jpeg;base64,/9j/')).toBe(true)
    const t = store.project.thumbnails.items.at(-1)!
    expect(t.status).toBe('done')
    expect(t.warning ?? '').not.toMatch(/did not accept/)

    bodies.length = 0
    const { fn: fn2 } = fakeFetch({ routes: { [PIKZELS_API.thumbnailFromText]: (b) => (bodies.push(b), bodies.length < 3 ? invalid : ok) } })
    await createPikzelsService(ctx, { fetch: fn2, sleep: async () => {} }).generate({ prompts: ['Again'], source: 'user' })
    expect(bodies).toHaveLength(3)
    expect(bodies[2].support_image_base64).toBeUndefined()
    expect(store.project.thumbnails.items.at(-1)).toMatchObject({ status: 'done', warning: expect.stringMatching(/did not accept the base picture/) })
  })

  it("shows Pikzels' own words about the field it rejected", async () => {
    const { fn } = fakeFetch({ routes: { [PIKZELS_API.thumbnailFromText]: () => invalid } })
    await createPikzelsService(makeCtx(), { fetch: fn, sleep: async () => {} }).generate({ prompts: ['No base here'], source: 'user' })
    expect(store.project.thumbnails.items.at(-1)!.error).toBe('Pikzels rejected the request: The request is invalid: support_image_base64 must be a data URI (VALIDATION_ERROR).')
    expect(fieldProblems({ details: { prompt: ['is too long'] } })).toBe('prompt is too long')
    expect(fieldProblems({ code: 'X' })).toBe('')
  })
})
