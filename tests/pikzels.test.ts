import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectSettingsSchema } from '@shared/project'
import { SettingsSchema } from '@shared/settings'
import type { AppContext } from '../src/main/context'
import { ActivityLog } from '../src/main/log'
import { ProjectStore } from '../src/main/project/store'
import { PIKZELS_API, createPikzelsService, plainError, stripLinks } from '../src/main/services/pikzels'

const KEY = 'pkz_live_secretkey_0123456789'
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
    settings: { get: () => settings, update: (p: object) => Object.assign(settings, p) },
    secrets: { get: (n: string) => (n === 'pikzels' ? key : null), set: () => {} },
    projects: { current: () => store }
  } as unknown as AppContext
}

/** A fake Pikzels: thumbnail requests answer 429 `busy` times first, then an image URL. */
function fakeFetch(opts: { busy?: number; status?: number; error?: { code: string; message: string } } = {}) {
  const calls: Call[] = []
  let busyLeft = opts.busy ?? 0
  let n = 0
  const fn = (async (input: any, init: any = {}) => {
    const url = String(input)
    const call: Call = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    if (url.startsWith('https://cdn.example.com/')) {
      return new Response(Buffer.from('PNGDATA' + url), { status: 200, headers: { 'content-type': 'image/png' } })
    }
    if (url.endsWith(PIKZELS_API.thumbnailFromText)) {
      if (busyLeft > 0) {
        busyLeft--
        return new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'Too many requests' }, request_id: 'req_busy' }), { status: 429 })
      }
      if (opts.status) return new Response(JSON.stringify({ error: opts.error, request_id: 'req_err' }), { status: opts.status })
      n++
      return new Response(JSON.stringify({ output: `https://cdn.example.com/img${n}.png`, request_id: `req_${n}`, model: 'pkz_4_5' }), { status: 200 })
    }
    if (url.includes('/v2/pikzonality/persona')) return new Response(JSON.stringify({ id: 'pz_1' }), { status: 200 })
    if (url.includes('/v2/pikzonality/pz_1')) return new Response(JSON.stringify({ status: 'completed', progress: 100 }), { status: 200 })
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  return { fn, calls }
}

beforeEach(() => {
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
})
