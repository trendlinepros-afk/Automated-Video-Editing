import { get } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsSchema } from '@shared/settings'
import {
  channelSummary,
  findDrops,
  findSpikes,
  isShortVideo,
  parseIsoDuration,
  videoInsights,
  watchAt,
  type RetentionPoint
} from '@shared/retention'
import type { AppContext } from '../src/main/context'
import { ActivityLog, redact } from '../src/main/log'
import { channelTools } from '../src/main/mcp/tools/channel'
import type { ToolEnv } from '../src/main/mcp/tools/common'
import {
  GOOGLE,
  RECONNECT_MESSAGE,
  buildAuthUrl,
  challengeFor,
  createYouTubeAnalyticsService,
  type YouTubeAnalyticsDeps
} from '../src/main/services/youtubeAnalytics'

let dir: string
let settings: ReturnType<typeof SettingsSchema.parse>
let secrets: Map<string, string>
let calls: { url: string; method: string; body: string; auth?: string }[]
let clock: number

function makeCtx(): AppContext {
  return {
    appLog: new ActivityLog(join(dir, 'app.log')),
    settings: {
      get: () => settings,
      update: (p: object) => (settings = SettingsSchema.parse({ ...settings, ...p })),
      onChange: () => () => {}
    },
    secrets: { get: (n: string) => secrets.get(n) ?? null, set: (n: string, v: string | null) => (v ? secrets.set(n, v) : secrets.delete(n)) }
  } as unknown as AppContext
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** A curve: steady slow loss, an opening fall, a fall at 20-24 %, a re-watch bump at 60-62 %, the end-screen fall. */
function sampleCurve(): RetentionPoint[] {
  const pts: RetentionPoint[] = []
  let w = 1.0
  for (let k = 1; k <= 100; k++) {
    if (k === 1) w = 1.0
    else if (k <= 3) w -= 0.08 // opening
    else if (k > 20 && k <= 24) w -= 0.03 // the price reveal
    else if (k > 60 && k <= 62) w += 0.02 // re-watched
    else if (k > 97) w -= 0.05 // end screen
    else w -= 0.002
    pts.push({ ratio: k / 100, watch: Math.round(w * 10000) / 10000, relative: 0.6 })
  }
  return pts
}

/** Analytics answer for a retention report. */
const retentionReport = (pts: RetentionPoint[]) => ({
  columnHeaders: [{ name: 'elapsedVideoTimeRatio' }, { name: 'audienceWatchRatio' }, { name: 'relativeRetentionPerformance' }],
  rows: pts.map((p) => [p.ratio, p.watch, p.relative])
})

/** A fake Google: the token endpoint, the Data API and the Analytics API. */
function fakeGoogle(opts: { onToken?: (params: URLSearchParams) => Response } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = String(init?.body ?? '')
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
    calls.push({ url, method: init?.method ?? 'GET', body, auth })
    if (url === GOOGLE.tokenUrl) {
      const params = new URLSearchParams(body)
      if (opts.onToken) return opts.onToken(params)
      return json({ access_token: `ya29.access_${calls.length}`, expires_in: 3600, refresh_token: params.get('grant_type') === 'authorization_code' ? '1//refresh_abcdef' : undefined })
    }
    if (url === GOOGLE.revokeUrl) return json({})
    const u = new URL(url)
    if (u.pathname.endsWith('/channels')) {
      return json({ items: [{ id: 'UCwicked', snippet: { title: 'Wicked RC' }, contentDetails: { relatedPlaylists: { uploads: 'UUwicked' } }, statistics: { videoCount: '42' } }] })
    }
    if (u.pathname.endsWith('/playlistItems')) {
      return json({ items: ['long1', 'short1', 'long2', 'vert1', 'long3'].map((id) => ({ contentDetails: { videoId: id } })) })
    }
    if (u.pathname.endsWith('/videos')) {
      const v = (id: string, duration: string, w = 1920, h = 1080) => ({
        id,
        snippet: { title: `Video ${id}`, publishedAt: '2026-09-01T00:00:00Z', description: '' },
        contentDetails: { duration },
        statistics: { viewCount: '1000' },
        fileDetails: { videoStreams: [{ widthPixels: w, heightPixels: h }] }
      })
      return json({ items: [v('long1', 'PT10M'), v('short1', 'PT45S'), v('long2', 'PT8M20S'), v('vert1', 'PT2M', 1080, 1920), v('long3', 'PT12M')] })
    }
    if (url.startsWith(GOOGLE.analyticsApi)) {
      if (u.searchParams.get('dimensions') === 'video') {
        const ids = (u.searchParams.get('filters') ?? '').replace('video==', '').split(',')
        return json({
          columnHeaders: [{ name: 'video' }, { name: 'views' }, { name: 'averageViewDuration' }, { name: 'averageViewPercentage' }],
          rows: ids.filter((id) => id !== 'long3').map((id, i) => [id, 1000, 240 - i * 30, 40 - i * 5])
        })
      }
      const id = (u.searchParams.get('filters') ?? '').replace('video==', '')
      return json(id === 'long3' ? { columnHeaders: [], rows: [] } : retentionReport(sampleCurve()))
    }
    return json({ error: { code: 404, message: 'not found' } }, 404)
  }) as typeof fetch
}

function service(extra: YouTubeAnalyticsDeps = {}) {
  return createYouTubeAnalyticsService(makeCtx(), { fetch: fakeGoogle(), cacheDir: join(dir, 'cache'), now: () => clock, ...extra })
}

/** Plays the browser: follows Google's redirect back to the app with a code. */
function browserReturn(authUrl: string, params: Record<string, string>): void {
  const u = new URL(authUrl)
  const back = new URL(u.searchParams.get('redirect_uri')!)
  for (const [k, v] of Object.entries(params)) back.searchParams.set(k, v === '$state' ? u.searchParams.get('state')! : v)
  get(back, (res) => res.resume())
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ave-yt-'))
  settings = SettingsSchema.parse({})
  secrets = new Map()
  calls = []
  clock = Date.parse('2026-10-11T12:00:00Z')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('Google sign-in', () => {
  it('builds the PKCE challenge and the sign-in link', () => {
    // The example from RFC 7636.
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    const url = new URL(buildAuthUrl({ clientId: 'cid.apps.googleusercontent.com', redirectUri: 'http://127.0.0.1:5555', challenge: 'abc', state: 'st' }))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    const q = url.searchParams
    expect(q.get('scope')).toBe('https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/youtube.readonly')
    expect(q.get('access_type')).toBe('offline')
    expect(q.get('prompt')).toBe('consent')
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('code_challenge')).toBe('abc')
    expect(q.get('state')).toBe('st')
    expect(q.get('response_type')).toBe('code')
  })

  it('refuses to connect before the client is set', async () => {
    await expect(service().connect()).rejects.toThrow(/Client ID and Client secret/)
  })

  it('connects through the browser, exchanges the code with the verifier and keeps the refresh token', async () => {
    let authUrl = ''
    const yt = service({ openExternal: (url) => { authUrl = url; browserReturn(url, { code: '4/the_code', state: '$state' }) } })
    yt.setClient('cid.apps.googleusercontent.com', 'GOCSPX-secret123')
    expect(secrets.get('googleClientSecret')).toBe('GOCSPX-secret123')
    const status = await yt.connect()
    expect(status).toMatchObject({ connected: true, channelTitle: 'Wicked RC', videoCount: 42, connecting: false })
    expect(secrets.get('googleRefreshToken')).toBe('1//refresh_abcdef')
    const exchange = new URLSearchParams(calls.find((c) => c.url === GOOGLE.tokenUrl)!.body)
    expect(exchange.get('grant_type')).toBe('authorization_code')
    expect(exchange.get('code')).toBe('4/the_code')
    expect(exchange.get('client_secret')).toBe('GOCSPX-secret123')
    expect(exchange.get('redirect_uri')).toBe(new URL(authUrl).searchParams.get('redirect_uri'))
    expect(challengeFor(exchange.get('code_verifier')!)).toBe(new URL(authUrl).searchParams.get('code_challenge'))
    expect(new URL(authUrl).searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    // Tokens never reach a log.
    expect(redact('token 1//refresh_abcdef and code 4/the_code')).not.toMatch(/refresh_abcdef|the_code/)
  })

  it('rejects an answer whose state does not match', async () => {
    const yt = service({ openExternal: (url) => browserReturn(url, { code: 'x', state: 'forged' }) })
    yt.setClient('cid', 'secret-value')
    await expect(yt.connect()).rejects.toThrow(/state check failed/)
    expect(secrets.has('googleRefreshToken')).toBe(false)
  })

  it('explains a cancelled sign-in and gives up after the time limit', async () => {
    const cancelled = service({ openExternal: (url) => browserReturn(url, { error: 'access_denied', state: '$state' }) })
    cancelled.setClient('cid', 'secret-value')
    await expect(cancelled.connect()).rejects.toThrow(/test user/)
    const slow = service({ openExternal: () => undefined, signInTimeoutMs: 50 })
    slow.setClient('cid', 'secret-value')
    await expect(slow.connect()).rejects.toThrow(/timed out/)
  })

  it('refreshes the access token when it runs out, and only then', async () => {
    secrets.set('googleClientSecret', 'secret-value')
    secrets.set('googleRefreshToken', '1//refresh_abcdef')
    settings = SettingsSchema.parse({ youtube: { clientId: 'cid' } })
    const yt = service()
    await yt.channelRetention({ videos: 1 })
    const tokenCalls = () => calls.filter((c) => c.url === GOOGLE.tokenUrl)
    expect(tokenCalls()).toHaveLength(1)
    const refresh = new URLSearchParams(tokenCalls()[0].body)
    expect(refresh.get('grant_type')).toBe('refresh_token')
    expect(refresh.get('refresh_token')).toBe('1//refresh_abcdef')
    expect(calls.find((c) => c.url.includes('/channels'))!.auth).toMatch(/^Bearer ya29\.access_/)
    await yt.channelRetention({ videos: 2 }) // within the hour: no new token
    expect(tokenCalls()).toHaveLength(1)
    clock += 2 * 3600_000
    await yt.channelRetention({ videos: 3, refresh: true })
    expect(tokenCalls()).toHaveLength(2)
  })

  it('asks to reconnect in plain words when Google ends the sign-in (invalid_grant)', async () => {
    secrets.set('googleClientSecret', 'secret-value')
    secrets.set('googleRefreshToken', '1//expired')
    settings = SettingsSchema.parse({ youtube: { clientId: 'cid', channelTitle: 'Wicked RC' } })
    const yt = service({
      fetch: fakeGoogle({ onToken: () => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400) })
    })
    const err = await yt.channelRetention().catch((e) => e)
    expect(err.code).toBe('reconnect')
    expect(err.message).toBe(RECONNECT_MESSAGE)
    expect(err.message).toMatch(/7 days/)
    expect(secrets.has('googleRefreshToken')).toBe(false)
    expect(yt.status()).toMatchObject({ connected: false, error: RECONNECT_MESSAGE })
  })

  it('a new client id ends the old sign-in; disconnect forgets it and asks Google to revoke it', async () => {
    secrets.set('googleClientSecret', 'secret-value')
    secrets.set('googleRefreshToken', '1//refresh_abcdef')
    settings = SettingsSchema.parse({ youtube: { clientId: 'cid' } })
    const yt = service()
    yt.setClient('cid') // same id, secret kept
    expect(yt.status()).toMatchObject({ connected: true, hasClientSecret: true })
    yt.setClient('other-cid')
    expect(yt.status().connected).toBe(false)
    secrets.set('googleRefreshToken', '1//again')
    const s = await yt.disconnect()
    expect(s.connected).toBe(false)
    expect(calls.some((c) => c.url === GOOGLE.revokeUrl && c.body.includes('again'))).toBe(true)
  })
})

describe('retention insights', () => {
  it('reads the curve and finds the drops and the re-watch spike', () => {
    const pts = sampleCurve()
    expect(watchAt(pts, 0.005)).toBe(1)
    expect(watchAt(pts, 0.015)).toBeCloseTo(0.96, 5)
    const drops = findDrops(pts, 600)
    // The opening fall and the fall at 20 % (2:00); the end screen is left out.
    expect(drops).toHaveLength(2)
    expect(drops[0]).toMatchObject({ atSec: 6, opening: true, lostPct: 16 })
    expect(drops[1]).toMatchObject({ atSec: 120, untilSec: 144, atPct: 20, lostPct: 12 })
    expect(drops[1].opening).toBeUndefined()
    expect(drops.every((d) => d.atPct < 95)).toBe(true)
    const spikes = findSpikes(pts, 600)
    expect(spikes).toEqual([{ atSec: 360, untilSec: 372, atPct: 60, gainPct: 4 }])
  })

  it('works out retention at 30 s, 1 min and the quarters, and the comparison with similar videos', () => {
    const v = videoInsights(
      { id: 'a', title: 'A', publishedAt: '', durationSec: 600, isShort: false, views: 10 },
      sampleCurve(),
      { views: 900, averageViewDurationSec: 250.4, averageViewPct: 41.73 }
    )
    expect(v.hasData).toBe(true)
    expect(v.retentionPct.at30s).toBeCloseTo(83.6, 1) // 5 % of 600 s
    expect(v.retentionPct.at1min).toBeCloseTo(82.6, 1)
    expect(v.retentionPct.at50).not.toBeNull()
    expect(v.views).toBe(900)
    expect(v.averageViewDurationSec).toBe(250)
    expect(v.averageViewPct).toBe(41.7)
    expect(v.vsSimilar).toEqual({ average: 0.6, first30s: 0.6, verdict: 'better than similar videos' })
    const short = videoInsights({ id: 'b', title: 'B', publishedAt: '', durationSec: 50, isShort: false, views: 1 }, sampleCurve())
    expect(short.retentionPct.at1min).toBeNull()
    const empty = videoInsights({ id: 'c', title: 'C', publishedAt: '', durationSec: 300, isShort: false, views: 1 }, [])
    expect(empty).toMatchObject({ hasData: false, drops: [], spikes: [], vsSimilar: { verdict: 'unknown' } })
  })

  it('sums up the channel: averages, common drop spots, best and worst', () => {
    const mk = (id: string, pct: number) =>
      videoInsights({ id, title: id, publishedAt: '', durationSec: 600, isShort: false, views: 1 }, sampleCurve(), { views: 1, averageViewDurationSec: 200, averageViewPct: pct })
    const s = channelSummary([mk('a', 30), mk('b', 50), mk('c', 40), mk('d', 20)], 2)
    expect(s.videosAnalysed).toBe(4)
    expect(s.shortsSkipped).toBe(2)
    expect(s.averages.averageViewPct).toBe(35)
    expect(s.dropSpots[0]).toMatchObject({ videos: 4 })
    expect(s.dropSpots.map((d) => d.where)).toEqual(expect.arrayContaining(['first 15 s', 'first quarter (after 2 min)']))
    expect(s.heldBest.map((v) => v.id)).toEqual(['b', 'c', 'a'])
    expect(s.heldWorst.map((v) => v.id)).toEqual(['d', 'a', 'c'])
    expect(s.notes.join(' ')).toMatch(/still watching at 0:30/)
  })

  it('reads YouTube durations and tells Shorts apart', () => {
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723)
    expect(parseIsoDuration('PT45S')).toBe(45)
    expect(parseIsoDuration('P0D')).toBe(0)
    expect(isShortVideo({ durationSec: 60 })).toBe(true)
    expect(isShortVideo({ durationSec: 61 })).toBe(false)
    expect(isShortVideo({ durationSec: 120, width: 1080, height: 1920 })).toBe(true)
    expect(isShortVideo({ durationSec: 150, title: 'Jump! #shorts' })).toBe(true)
    expect(isShortVideo({ durationSec: 900, title: 'Review #shorts' })).toBe(false)
  })
})

describe('channel retention from YouTube', () => {
  beforeEach(() => {
    secrets.set('googleClientSecret', 'secret-value')
    secrets.set('googleRefreshToken', '1//refresh_abcdef')
    settings = SettingsSchema.parse({ youtube: { clientId: 'cid' } })
  })

  it('looks at long videos only, newest first, and asks for the right reports', async () => {
    const r = await service().channelRetention()
    expect(r.channel).toBe('Wicked RC')
    expect(r.videos.map((v) => v.id)).toEqual(['long1', 'long2', 'long3'])
    expect(r.summary.shortsSkipped).toBe(2)
    expect(r.summary.videosAnalysed).toBe(2)
    expect(r.summary.videosWithoutData).toBe(1)
    expect(r.videos[2].hasData).toBe(false)
    const report = new URL(calls.find((c) => c.url.includes('elapsedVideoTimeRatio'))!.url).searchParams
    expect(report.get('ids')).toBe('channel==MINE')
    expect(report.get('metrics')).toBe('audienceWatchRatio,relativeRetentionPerformance')
    expect(report.get('startDate')).toBe('2005-01-01')
    expect(report.get('endDate')).toBe('2026-10-11')
    expect(report.get('filters')).toMatch(/^video==long\d$/)
    expect(calls.some((c) => c.url.includes('/playlistItems') && c.url.includes('playlistId=UUwicked'))).toBe(true)
  })

  it('keeps the numbers for a day', async () => {
    const yt = service()
    await yt.channelRetention()
    const first = calls.length
    await yt.channelRetention()
    // A new service (the app restarted) reads the cache from disk too.
    await service().channelRetention()
    expect(calls.length).toBe(first) // nothing asked of Google, not even a token
    clock += 25 * 3600_000
    await yt.channelRetention()
    expect(calls.length).toBeGreaterThan(first + 5)
  })

  it('gives one video in detail with its full curve', async () => {
    const r = await service().videoRetention('long1')
    expect(r.video.id).toBe('long1')
    expect(r.curve.retentionPct).toHaveLength(100)
    expect(r.curve.retentionPct[0]).toBe(100)
    expect(r.curve.stepSec).toBe(6)
    expect(r.video.drops.length).toBeGreaterThan(0)
  })
})

describe('get_channel_retention tool', () => {
  const tool = channelTools[0]
  const envFor = (ctx: AppContext) => ({ ctx }) as unknown as ToolEnv

  it('works without an open project', () => {
    expect(tool.name).toBe('get_channel_retention')
    expect(tool.needsProject).toBe(false)
  })

  it('tells Claude to mention it to the owner and carry on when the channel is not connected', async () => {
    const ctx = makeCtx()
    ctx.youtube = createYouTubeAnalyticsService(ctx, { fetch: fakeGoogle(), cacheDir: join(dir, 'cache') })
    await expect(tool.run({}, envFor(ctx))).rejects.toThrow(/not connected.*carry on with the edit/s)
  })

  it('returns the compact insights when connected', async () => {
    secrets.set('googleClientSecret', 'secret-value')
    secrets.set('googleRefreshToken', '1//refresh_abcdef')
    settings = SettingsSchema.parse({ youtube: { clientId: 'cid' } })
    const ctx = makeCtx()
    ctx.youtube = createYouTubeAnalyticsService(ctx, { fetch: fakeGoogle(), cacheDir: join(dir, 'cache'), now: () => clock })
    const res = await tool.run({ videos: 2 }, envFor(ctx))
    const data = JSON.parse((res.content[0] as { text: string }).text)
    expect(data.videos).toHaveLength(2)
    expect(data.summary.notes.length).toBeGreaterThan(0)
    expect(data.howToUse).toMatch(/not a rule/)
    const one = JSON.parse(((await tool.run({ video_id: 'long2' }, envFor(ctx))).content[0] as { text: string }).text)
    expect(one.curve.retentionPct).toHaveLength(100)
  })
})
