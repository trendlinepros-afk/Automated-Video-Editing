import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppContext } from '../src/main/context'
import { OPUS_API, copyBitrate, createOpusClipService, parseClip, plainOpusError, projectBody, stageInfo } from '../src/main/services/opusclip'
import { cleanupTemps, makeProject } from './helpers/project'

afterEach(cleanupTemps)

const KEY = 'opus-test-key-123'

function ctxFor(store: ReturnType<typeof makeProject>, key: string | null = KEY) {
  const sent: { channel: string; payload: any }[] = []
  const ctx = {
    settings: { get: () => ({ defaultExportsFolder: '' }) },
    secrets: { get: (n: string) => (n === 'opusclip' ? key : null), set: () => {} },
    projects: { current: () => store },
    env: { ffmpeg: () => 'ffmpeg' },
    engine: { probe: async () => ({ kind: 'video', duration: 60, hasAudio: true }) },
    send: (channel: string, payload: unknown) => sent.push({ channel, payload })
  } as unknown as AppContext
  return { ctx, sent }
}

type Route = (body: any, init: any) => { status: number; json?: unknown; headers?: Record<string, string>; raw?: string }

/** A fake OpusClip API and Google Cloud upload. */
function fakeOpus(routes: Record<string, Route> = {}) {
  const calls: { url: string; method: string; headers: any; body: any }[] = []
  let polls = 0
  const fn = (async (input: any, init: any = {}) => {
    const url = String(input)
    let body: any = init.body
    if (typeof body === 'string') body = JSON.parse(body)
    else if (body && typeof body[Symbol.asyncIterator] === 'function') {
      let n = 0
      for await (const c of body) n += c.length
      body = { bytes: n }
    }
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body })
    const respond = (r: ReturnType<Route>) => new Response(r.status === 204 ? null : r.raw ?? (r.json === undefined ? '' : JSON.stringify(r.json)), { status: r.status, headers: r.headers })
    if (url.startsWith('https://storage.googleapis.com/upload')) return respond({ status: 201, headers: { location: 'https://storage.googleapis.com/session/abc' } })
    if (url === 'https://storage.googleapis.com/session/abc') return respond({ status: 200, json: {} })
    if (url.startsWith('https://cdn.opus.pro/')) return new Response(Buffer.from('MP4DATA'), { status: 200 })
    const path = url.slice(OPUS_API.baseUrl.length)
    const route = routes[path] ?? routes[path.split('?')[0]]
    if (route) return respond(route(body, init))
    if (path === OPUS_API.uploadLinks) return respond({ status: 200, json: { url: 'https://storage.googleapis.com/upload/xyz', uploadId: 'up_123' } })
    if (path === OPUS_API.projects) return respond({ status: 200, json: { id: 'P1', stage: 'QUEUED' } })
    if (path === OPUS_API.project('P1')) return respond({ status: 200, json: { id: 'P1', stage: polls++ === 0 ? 'RENDER' : 'COMPLETE' } })
    if (path.startsWith(OPUS_API.clips)) {
      return respond({
        status: 200,
        json: { data: { list: [{ id: 'P1.CU1', title: 'Best drift', uriForPreview: 'https://cdn.opus.pro/p1.mp4', uriForExport: 'https://cdn.opus.pro/e1.mp4', durationMs: 31000, viralityScore: 91, genre: 'auto' }], total: 1 } }
      })
    }
    if (path === OPUS_API.socialAccounts) return respond({ status: 200, json: { data: [{ postAccountId: 'yt1', platform: 'YOUTUBE', extUserName: 'Wicked RC' }, { postAccountId: 'ig1', subAccountId: 'igb', platform: 'INSTAGRAM', extUserName: 'wicked.rc' }] } })
    if (path === OPUS_API.socialCopyJobs) return respond({ status: 200, json: { data: { jobId: 'J1' } } })
    if (path === OPUS_API.socialCopyJob('J1')) return respond({ status: 200, json: { data: { status: 'COMPLETED', title: 'T', description: 'D', hashtags: ['#rc', '#drift'] } } })
    if (path === OPUS_API.postTasks) return respond({ status: 200, json: { data: { postId: 'post1' } } })
    if (path === OPUS_API.schedules) return respond({ status: 200, json: { data: { scheduleId: 'sch1' } } })
    if (path === OPUS_API.schedule('sch1')) return respond({ status: 204 })
    return respond({ status: 404, json: { message: 'nope' } })
  }) as unknown as typeof fetch
  return { fn, calls }
}

const sleep = async () => {}
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
}

describe('OpusClip requests', () => {
  it('builds the project body from every option, leaving out what is not set', () => {
    expect(projectBody('up_1', { sourcePath: 'x' })).toEqual({ videoUrl: 'up_1' })
    expect(
      projectBody('up_1', {
        sourcePath: 'x',
        title: ' Drift car ',
        brandTemplateId: 'tpl',
        model: 'ClipAnything',
        clipDurations: [[0, 30]],
        topicKeywords: [' gyro ', ''],
        customPrompt: 'the drifts',
        genre: 'Auto',
        rangeStart: 10,
        rangeEnd: 300,
        layoutAspectRatio: 'portrait',
        removeFillerWords: true,
        sourceLang: 'en',
        notifyEmail: 'me@x.com',
        notifyOnFailure: true
      })
    ).toEqual({
      videoUrl: 'up_1',
      brandTemplateId: 'tpl',
      curationPref: { model: 'ClipAnything', clipDurations: [[0, 30]], topicKeywords: ['gyro'], customPrompt: 'the drifts', genre: 'Auto', range: { startSec: 10, endSec: 300 } },
      renderPref: { layoutAspectRatio: 'portrait', quickstartConfig: { enableRemoveFillerWords: true } },
      importPref: { sourceLang: 'en' },
      uploadedVideoAttr: { title: 'Drift car' },
      conclusionActions: [{ type: 'EMAIL', email: 'me@x.com', notifyFailure: true }]
    })
  })

  it('reads clips whatever extra fields they carry', () => {
    expect(parseClip({ id: 'CU9', title: '', durationMs: 12500, viralityScore: '77', uriForExport: 'u', layout: 'portrait' }, 'P2')).toEqual({
      id: 'P2.CU9',
      curationId: 'CU9',
      title: 'Clip CU9',
      exportUrl: 'u',
      durationSeconds: 12.5,
      score: 77,
      extra: { layout: 'portrait' }
    })
    expect(parseClip({}, 'P')).toBeNull()
  })

  it('says plainly what went wrong and how far along OpusClip is', () => {
    expect(plainOpusError(401, '')).toMatch(/Settings > API keys/)
    expect(plainOpusError(422, '{"message":"videoUrl is invalid"}')).toBe('OpusClip rejected the request (422): videoUrl is invalid.')
    expect(stageInfo('CURATE')).toEqual({ label: 'Finding the best moments', percent: 43 })
    expect(stageInfo('COMPLETE').percent).toBe(100)
  })

  it('makes an upload copy that fits under 10 GB without raising the bitrate', () => {
    // 15:29 of 4K60 at 120 Mbps is 13.9 GB: the copy goes down to about 72 Mbps.
    const rate = copyBitrate(929, 120_000_000)
    expect(rate).toBeLessThan(80_000_000)
    expect(((rate + 192_000) * 929) / 8).toBeLessThan(9.5e9)
    expect(copyBitrate(60, 30_000_000)).toBe(30_000_000)
  })
})

describe('OpusClip service', () => {
  it('uploads the export, creates the project, waits for the clips and keeps them in the project folder', async () => {
    const store = makeProject()
    const video = join(store.dir, 'exports', 'video.mp4')
    mkdirSync(join(store.dir, 'exports'), { recursive: true })
    writeFileSync(video, Buffer.alloc(5000, 1))
    const { ctx, sent } = ctxFor(store)
    const { fn, calls } = fakeOpus()
    const svc = createOpusClipService(ctx, { fetch: fn, sleep, poll: false })
    const run = await svc.start({ sourcePath: video, model: 'ClipAnything', customPrompt: 'drifts' })
    await until(() => svc.state().runs[0]?.projectId === 'P1')
    // Key only on OpusClip's own API, never on the upload host.
    const apiCalls = calls.filter((c) => c.url.startsWith(OPUS_API.baseUrl))
    expect(apiCalls.every((c) => c.headers.Authorization === `Bearer ${KEY}`)).toBe(true)
    expect(calls.filter((c) => c.url.includes('storage.googleapis.com')).every((c) => !c.headers.Authorization)).toBe(true)
    expect(calls.find((c) => c.url.endsWith('/session/abc'))!.body).toEqual({ bytes: 5000 })
    expect(calls.find((c) => c.url === OPUS_API.baseUrl + OPUS_API.projects)!.body).toEqual({ videoUrl: 'up_123', curationPref: { model: 'ClipAnything', customPrompt: 'drifts' } })

    expect((await svc.refresh(run.id)).phase).toBe('processing')
    const done = await svc.refresh(run.id)
    expect(done).toMatchObject({ phase: 'complete', percent: 100, clips: [{ id: 'P1.CU1', title: 'Best drift', durationSeconds: 31, score: 91, extra: { genre: 'auto' } }] })
    expect(JSON.parse(readFileSync(join(store.dir, 'opusclip', 'state.json'), 'utf8')).runs[0].clips).toHaveLength(1)
    expect(sent.at(-1)!.channel).toBe('opusclip:state')
    // The key is never written anywhere in the project.
    for (const f of readdirSync(join(store.dir, 'opusclip'))) expect(readFileSync(join(store.dir, 'opusclip', f), 'utf8')).not.toContain(KEY)

    const file = await svc.download(run.id, 'P1.CU1')
    expect(file).toBe(join(store.dir, 'Export', 'Shorts', 'Best drift.mp4'))
    expect(readFileSync(file, 'utf8')).toBe('MP4DATA')
  })

  it('writes the post text per platform, posts now or schedules, and cancels a schedule', async () => {
    const store = makeProject()
    const video = join(store.dir, 'v.mp4')
    writeFileSync(video, 'x')
    const { ctx } = ctxFor(store)
    const { fn, calls } = fakeOpus()
    const svc = createOpusClipService(ctx, { fetch: fn, sleep, poll: false })
    const run = await svc.start({ sourcePath: video })
    await until(() => svc.state().runs[0]?.projectId === 'P1')
    await svc.refresh(run.id)
    await svc.refresh(run.id)

    expect(await svc.socialCopy({ runId: run.id, clipId: 'P1.CU1', postAccountId: 'ig1', subAccountId: 'igb', prompt: 'hype' })).toEqual({ title: 'T', description: 'D', hashtags: '#rc #drift' })
    expect(calls.find((c) => c.url.endsWith(OPUS_API.socialCopyJobs))!.body).toEqual({ projectId: 'P1', clipId: 'CU1', postAccountId: 'ig1', subAccountId: 'igb', prompt: 'hype' })

    const now = await svc.post({ runId: run.id, clipId: 'P1.CU1', postAccountId: 'yt1', title: 'Best drift', description: 'D #rc', privacy: 'unlisted' })
    expect(now).toMatchObject({ kind: 'posted', postId: 'post1', platform: 'YOUTUBE', account: 'Wicked RC' })
    expect(calls.find((c) => c.url.endsWith(OPUS_API.postTasks))!.body).toEqual({
      projectId: 'P1',
      clipId: 'CU1',
      postAccountId: 'yt1',
      postDetail: { title: 'Best drift', custom: { description: 'D #rc', privacy: 'unlisted' } }
    })

    await expect(svc.post({ runId: run.id, clipId: 'P1.CU1', postAccountId: 'yt1', title: 'x', publishAt: new Date(Date.now() - 1000).toISOString() })).rejects.toThrow(/minute from now/)
    const at = new Date(Date.now() + 3_600_000).toISOString()
    const later = await svc.post({ runId: run.id, clipId: 'P1.CU1', postAccountId: 'ig1', subAccountId: 'igb', title: 'Later', publishAt: at })
    expect(later).toMatchObject({ kind: 'scheduled', scheduleId: 'sch1', publishAt: at })
    expect(calls.find((c) => c.url.endsWith(OPUS_API.schedules))!.body).toMatchObject({ subAccountId: 'igb', publishAt: at })
    await svc.cancelSchedule('sch1')
    expect(svc.state().posts.find((p) => p.scheduleId === 'sch1')!.cancelled).toBe(true)
  })

  it('needs the key, and explains a refused key plainly', async () => {
    const store = makeProject()
    const video = join(store.dir, 'v.mp4')
    writeFileSync(video, 'x')
    await expect(createOpusClipService(ctxFor(store, null).ctx, { fetch: fakeOpus().fn, sleep, poll: false }).start({ sourcePath: video })).rejects.toThrow(/Settings > API keys/)
    const denied = fakeOpus({ [OPUS_API.uploadLinks]: () => ({ status: 401, json: {} }) })
    const svc = createOpusClipService(ctxFor(store).ctx, { fetch: denied.fn, sleep, poll: false })
    const run = await svc.start({ sourcePath: video })
    await until(() => svc.state().runs.find((r) => r.id === run.id)?.phase === 'failed')
    expect(svc.state().runs.find((r) => r.id === run.id)!.error).toMatch(/key is missing or wrong/)
    expect(existsSync(join(store.dir, 'opusclip', 'state.json'))).toBe(true)
  })
})
