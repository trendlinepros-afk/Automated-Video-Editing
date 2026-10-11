/**
 * Read-only access to the owner's own YouTube channel, so Claude can learn where this channel's
 * viewers stay and where they leave (audience retention) before it edits.
 *
 * Sign-in is Google's flow for desktop apps: the owner makes their own OAuth client ("Desktop app")
 * in Google Cloud and pastes its Client ID and secret into Settings. Connect opens the browser on
 * Google's sign-in page; Google sends the answer back to a one-shot web server on this PC
 * (127.0.0.1, a random port), protected with PKCE and a random state. Only the two read-only scopes
 * are asked for. The client secret and the refresh token live in the secrets store; access tokens
 * stay in memory. All three are registered so they never reach a log.
 *
 * Everything read from YouTube is kept in the data folder for a day, so asking again costs nothing.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import {
  channelSummary,
  curveOf,
  isShortVideo,
  parseIsoDuration,
  videoInsights,
  type ChannelRetention,
  type RetentionPoint,
  type VideoMeta,
  type VideoRetention,
  type VideoStats,
  type YouTubeStatus
} from '@shared/retention'
import type { AppContext } from '../context'
import { registerSecret } from '../log'
import { paths } from '../paths'
import { readJson, writeJsonAtomic } from '../project/store'

export const GOOGLE = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  dataApi: 'https://www.googleapis.com/youtube/v3',
  analyticsApi: 'https://youtubeanalytics.googleapis.com/v2/reports',
  scopes: ['https://www.googleapis.com/auth/yt-analytics.readonly', 'https://www.googleapis.com/auth/youtube.readonly']
} as const

const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000
const CACHE_MS = 24 * 60 * 60 * 1000
const DEFAULT_VIDEOS = 15
/** Upload list pages read at most (50 videos each), to find enough long videos among Shorts. */
const MAX_UPLOAD_PAGES = 3

export const RECONNECT_MESSAGE =
  'Google ended the connection to your YouTube channel. Sign-ins expire after 7 days while your Google Cloud app is in ' +
  'Testing mode (or access was removed). Reconnect in Settings > General > YouTube channel.'

export class YouTubeAnalyticsError extends Error {
  constructor(
    message: string,
    /** not_connected: no sign-in yet; reconnect: Google ended the sign-in. */
    readonly code?: 'not_connected' | 'reconnect' | 'not_configured'
  ) {
    super(message)
  }
}

export interface YouTubeAnalyticsService {
  status(): YouTubeStatus
  /** Save the owner's OAuth client. A secret left undefined keeps the saved one; a new Client ID ends the sign-in. */
  setClient(clientId: string, clientSecret?: string | null): YouTubeStatus
  connect(): Promise<YouTubeStatus>
  disconnect(): Promise<YouTubeStatus>
  channelRetention(opts?: { videos?: number; refresh?: boolean }): Promise<ChannelRetention>
  videoRetention(videoId: string, opts?: { refresh?: boolean }): Promise<VideoRetention>
}

export interface YouTubeAnalyticsDeps {
  fetch?: typeof fetch
  /** Opens Google's sign-in page in the browser (Electron's shell.openExternal). */
  openExternal?: (url: string) => Promise<void> | void
  cacheDir?: string
  now?: () => number
  signInTimeoutMs?: number
}

// ---------------------------------------------------------------- PKCE and the sign-in link

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  return { verifier, challenge: challengeFor(verifier) }
}

export function challengeFor(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest())
}

export function buildAuthUrl(o: { clientId: string; redirectUri: string; challenge: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    scope: GOOGLE.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: o.challenge,
    code_challenge_method: 'S256',
    state: o.state
  })
  return `${GOOGLE.authUrl}?${q.toString()}`
}

function page(title: string, body: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
    '<body style="font-family:system-ui,sans-serif;background:#0E0F12;color:#e8e8ea;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
    `<div style="text-align:center"><h2>${title}</h2><p style="color:#9a9aa3">${body}</p></div></body></html>`
  )
}

/** Answers from Google's token endpoint and APIs, in plain words. */
function googleMessage(body: unknown): { error?: string; message: string; reason?: string } {
  const b = (body ?? {}) as Record<string, any>
  if (typeof b.error === 'string') return { error: b.error, message: String(b.error_description ?? b.error) }
  if (b.error && typeof b.error === 'object') {
    const reason = b.error.errors?.[0]?.reason ?? b.error.status
    return { error: String(b.error.status ?? b.error.code ?? ''), message: String(b.error.message ?? 'unknown error'), reason: reason ? String(reason) : undefined }
  }
  return { message: 'unknown error' }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return { error: { message: text.slice(0, 300) } }
  }
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))
  return out
}

// ---------------------------------------------------------------- the service

export function createYouTubeAnalyticsService(ctx: AppContext, deps: YouTubeAnalyticsDeps = {}): YouTubeAnalyticsService {
  const doFetch: typeof fetch = deps.fetch ?? ((...a) => globalThis.fetch(...a))
  const now = deps.now ?? Date.now
  const cacheRoot = () => deps.cacheDir ?? join(paths.data, 'cache', 'youtube-analytics')
  let access: { token: string; expiresAt: number } | null = null
  let connecting: { cancel: (why: string) => void } | null = null
  let lastError: string | undefined

  const log = (msg: string, data?: unknown) => {
    try {
      ctx.appLog.write('app', msg, data)
    } catch {
      /* the app log may not exist in tests */
    }
  }
  const yt = () => ctx.settings.get().youtube
  const saveYt = (patch: Partial<ReturnType<typeof yt>>) => ctx.settings.update({ youtube: { ...yt(), ...patch } })
  const clientSecret = () => ctx.secrets.get('googleClientSecret')
  const refreshToken = () => ctx.secrets.get('googleRefreshToken')

  function status(): YouTubeStatus {
    const s = yt()
    return {
      clientId: s.clientId,
      hasClientSecret: !!clientSecret(),
      connected: !!refreshToken(),
      connecting: !!connecting,
      channelTitle: s.channelTitle,
      videoCount: s.videoCount,
      ...(lastError ? { error: lastError } : {})
    }
  }

  function client(): { clientId: string; secret: string } {
    const clientId = yt().clientId.trim()
    const secret = clientSecret()
    if (!clientId || !secret) {
      throw new YouTubeAnalyticsError('Add your Google OAuth Client ID and Client secret in Settings > General > YouTube channel first.', 'not_configured')
    }
    return { clientId, secret }
  }

  function forgetSignIn(): void {
    access = null
    ctx.secrets.set('googleRefreshToken', null)
  }

  async function tokenRequest(params: Record<string, string>): Promise<Record<string, any>> {
    const res = await doFetch(GOOGLE.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString()
    })
    const body = (await readBody(res)) as Record<string, any>
    if (res.ok) {
      if (typeof body.access_token === 'string') registerSecret(body.access_token)
      if (typeof body.refresh_token === 'string') registerSecret(body.refresh_token)
      return body
    }
    const g = googleMessage(body)
    if (g.error === 'invalid_grant') {
      if (params.grant_type === 'refresh_token') {
        forgetSignIn()
        lastError = RECONNECT_MESSAGE
        log('YouTube sign-in expired or was removed (invalid_grant)')
        throw new YouTubeAnalyticsError(RECONNECT_MESSAGE, 'reconnect')
      }
      throw new YouTubeAnalyticsError('Google did not accept the sign-in code (it may have expired). Press Connect to try again.')
    }
    if (g.error === 'invalid_client' || g.error === 'unauthorized_client') {
      throw new YouTubeAnalyticsError(`Google did not accept the Client ID or Client secret (${g.message}). Check them in Settings > General > YouTube channel.`)
    }
    throw new YouTubeAnalyticsError(`Google sign-in failed (${res.status}): ${g.message}`)
  }

  async function accessToken(force = false): Promise<string> {
    if (!force && access && access.expiresAt - 60_000 > now()) return access.token
    const token = refreshToken()
    if (!token) throw new YouTubeAnalyticsError("The owner's YouTube channel is not connected.", 'not_connected')
    const { clientId, secret } = client()
    const body = await tokenRequest({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId, client_secret: secret })
    access = { token: String(body.access_token), expiresAt: now() + Number(body.expires_in ?? 3600) * 1000 }
    // Google may hand out a new refresh token; keep the newest.
    if (typeof body.refresh_token === 'string' && body.refresh_token !== token) ctx.secrets.set('googleRefreshToken', body.refresh_token)
    lastError = undefined
    return access.token
  }

  /** GET a Google API as the owner. Refreshes the access token once if Google says it ran out. */
  async function api<T = Record<string, any>>(url: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await accessToken(attempt > 0)
      const res = await doFetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
      if (res.status === 401 && attempt === 0) continue
      const body = await readBody(res)
      if (res.ok) return body as T
      const g = googleMessage(body)
      const which = url.startsWith(GOOGLE.analyticsApi) ? 'YouTube Analytics API' : 'YouTube Data API v3'
      if (g.reason === 'accessNotConfigured' || g.reason === 'SERVICE_DISABLED' || /has not been used|is disabled/i.test(g.message)) {
        throw new YouTubeAnalyticsError(`The ${which} is not turned on in your Google Cloud project. Enable it there, wait a minute, then try again. (Google said: ${g.message})`)
      }
      if (g.reason === 'quotaExceeded' || g.reason === 'rateLimitExceeded') {
        throw new YouTubeAnalyticsError(`Google's daily limit for the ${which} is used up for today. Try again tomorrow. (${g.message})`)
      }
      throw new YouTubeAnalyticsError(`YouTube refused the request (${res.status}): ${g.message}`)
    }
  }

  // ------------------------------------------------------------ cache

  function cached<T>(name: string, refresh: boolean | undefined): T | null {
    if (refresh) return null
    const file = join(cacheRoot(), `${name}.json`)
    if (!existsSync(file)) return null
    try {
      const c = readJson<{ savedAt: number; data: T }>(file)
      return now() - c.savedAt < CACHE_MS ? c.data : null
    } catch {
      return null
    }
  }

  function keep<T>(name: string, data: T): T {
    try {
      mkdirSync(cacheRoot(), { recursive: true })
      writeJsonAtomic(join(cacheRoot(), `${name}.json`), { savedAt: now(), data })
    } catch (err) {
      log('Could not save YouTube numbers to the cache', { error: String(err) })
    }
    return data
  }

  // ------------------------------------------------------------ channel data

  interface Uploads {
    channel: string
    videos: VideoMeta[]
    fetchedAt: string
  }

  async function videoDetails(ids: string[]): Promise<VideoMeta[]> {
    const out: VideoMeta[] = []
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50).join(',')
      const base = `${GOOGLE.dataApi}/videos?id=${encodeURIComponent(batch)}&maxResults=50&part=`
      let body: Record<string, any>
      try {
        // fileDetails (picture size, only for the owner) tells vertical Shorts apart.
        body = await api(`${base}contentDetails,statistics,snippet,fileDetails`)
      } catch (err) {
        if (err instanceof YouTubeAnalyticsError && err.code) throw err
        body = await api(`${base}contentDetails,statistics,snippet`)
      }
      for (const v of body.items ?? []) {
        const stream = v.fileDetails?.videoStreams?.[0]
        const durationSec = parseIsoDuration(v.contentDetails?.duration)
        out.push({
          id: String(v.id),
          title: String(v.snippet?.title ?? ''),
          publishedAt: String(v.snippet?.publishedAt ?? ''),
          durationSec,
          isShort: isShortVideo({
            durationSec,
            width: Number(stream?.widthPixels) || undefined,
            height: Number(stream?.heightPixels) || undefined,
            title: v.snippet?.title,
            description: v.snippet?.description
          }),
          views: Number(v.statistics?.viewCount ?? 0)
        })
      }
    }
    return out
  }

  async function uploads(refresh?: boolean): Promise<Uploads> {
    const hit = cached<Uploads>('uploads', refresh)
    if (hit) return hit
    const ch = await api(`${GOOGLE.dataApi}/channels?part=snippet,contentDetails,statistics&mine=true`)
    const channel = ch.items?.[0]
    if (!channel) throw new YouTubeAnalyticsError('This Google account has no YouTube channel. Connect again and pick the account (or Brand Account) that owns the channel.')
    const playlist = channel.contentDetails?.relatedPlaylists?.uploads
    const ids: string[] = []
    let pageToken = ''
    for (let i = 0; playlist && i < MAX_UPLOAD_PAGES; i++) {
      const pl = await api(
        `${GOOGLE.dataApi}/playlistItems?part=contentDetails,snippet&maxResults=50&playlistId=${encodeURIComponent(playlist)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
      )
      for (const item of pl.items ?? []) {
        const id = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId
        if (id) ids.push(String(id))
      }
      pageToken = pl.nextPageToken ?? ''
      if (!pageToken) break
    }
    const details = await videoDetails(ids)
    // Newest first, as in the uploads list.
    const order = new Map(ids.map((id, i) => [id, i]))
    details.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    const title = String(channel.snippet?.title ?? '')
    saveYt({ channelId: String(channel.id ?? ''), channelTitle: title, videoCount: Number(channel.statistics?.videoCount ?? ids.length) })
    return keep('uploads', { channel: title, videos: details, fetchedAt: new Date(now()).toISOString() })
  }

  const today = () => new Date(now()).toISOString().slice(0, 10)

  /** Rows of an Analytics report as objects keyed by column name. */
  function rowsOf(body: Record<string, any>): Record<string, unknown>[] {
    const names: string[] = (body.columnHeaders ?? []).map((h: { name: string }) => h.name)
    return (body.rows ?? []).map((r: unknown[]) => Object.fromEntries(names.map((n, i) => [n, r[i]])))
  }

  async function retentionPoints(id: string, refresh?: boolean): Promise<RetentionPoint[]> {
    const hit = cached<RetentionPoint[]>(`retention-${id}`, refresh)
    if (hit) return hit
    const q = new URLSearchParams({
      ids: 'channel==MINE',
      startDate: '2005-01-01',
      endDate: today(),
      metrics: 'audienceWatchRatio,relativeRetentionPerformance',
      dimensions: 'elapsedVideoTimeRatio',
      filters: `video==${id}`
    })
    const body = await api(`${GOOGLE.analyticsApi}?${q.toString()}`)
    const points = rowsOf(body).map((r) => ({
      ratio: Number(r.elapsedVideoTimeRatio),
      watch: Number(r.audienceWatchRatio),
      relative: r.relativeRetentionPerformance === undefined || r.relativeRetentionPerformance === null ? null : Number(r.relativeRetentionPerformance)
    }))
    return keep(`retention-${id}`, points)
  }

  async function videoStats(ids: string[], refresh?: boolean): Promise<Map<string, VideoStats>> {
    const out = new Map<string, VideoStats>()
    const missing: string[] = []
    for (const id of ids) {
      const hit = cached<VideoStats | { none: true }>(`stats-${id}`, refresh)
      if (hit && !('none' in hit)) out.set(id, hit)
      else if (!hit) missing.push(id)
    }
    for (let i = 0; i < missing.length; i += 50) {
      const batch = missing.slice(i, i + 50)
      const q = new URLSearchParams({
        ids: 'channel==MINE',
        startDate: '2005-01-01',
        endDate: today(),
        metrics: 'views,averageViewDuration,averageViewPercentage',
        dimensions: 'video',
        filters: `video==${batch.join(',')}`,
        sort: '-views',
        maxResults: '50'
      })
      const body = await api(`${GOOGLE.analyticsApi}?${q.toString()}`)
      const got = new Set<string>()
      for (const r of rowsOf(body)) {
        const stats: VideoStats = {
          views: Number(r.views ?? 0),
          averageViewDurationSec: Number(r.averageViewDuration ?? 0),
          averageViewPct: Number(r.averageViewPercentage ?? 0)
        }
        out.set(String(r.video), keep(`stats-${r.video}`, stats))
        got.add(String(r.video))
      }
      // Videos with no numbers yet are remembered too, so they are not asked for again today.
      for (const id of batch) if (!got.has(id)) keep(`stats-${id}`, { none: true })
    }
    return out
  }

  // ------------------------------------------------------------ sign-in

  /** Runs the browser sign-in and returns the code Google sends back to this PC. */
  function signIn(clientId: string, challenge: string, state: string): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      let server: Server | null = null
      let timer: NodeJS.Timeout | null = null
      let done = false
      const finish = (err: Error | null, value?: { code: string; redirectUri: string }) => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        connecting = null
        // Let the answer page reach the browser before the server goes away.
        setTimeout(() => {
          server?.close()
          server?.closeAllConnections?.()
        }, 200)
        if (err) reject(err)
        else resolve(value!)
      }
      connecting = { cancel: (why) => finish(new YouTubeAnalyticsError(why)) }
      server = createServer((req, res) => {
        const redirectUri = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
        const u = new URL(req.url ?? '/', redirectUri)
        const code = u.searchParams.get('code')
        const error = u.searchParams.get('error')
        if (u.pathname !== '/' || (!code && !error)) {
          res.writeHead(404).end()
          return
        }
        const answer = (status: number, title: string, body: string) => {
          res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' })
          res.end(page(title, body))
        }
        if (u.searchParams.get('state') !== state) {
          answer(400, 'Not connected', 'This sign-in answer does not match the one the app asked for. Press Connect in the app again.')
          finish(new YouTubeAnalyticsError('The Google sign-in answer did not match (state check failed). Press Connect to try again.'))
          return
        }
        if (error || !code) {
          answer(200, 'Not connected', 'Google did not give access. You can close this tab and try again from the app.')
          finish(
            new YouTubeAnalyticsError(
              error === 'access_denied'
                ? 'Google sign-in was cancelled, or this Google account is not a test user of your OAuth app (add it under Audience > Test users in Google Cloud).'
                : `Google sign-in failed: ${error}`
            )
          )
          return
        }
        registerSecret(code)
        answer(200, 'Connected — you can close this tab', 'AI Video Editor can now read your channel’s analytics (read-only).')
        finish(null, { code, redirectUri })
      })
      server.on('error', (err) => finish(new YouTubeAnalyticsError(`Could not start the sign-in helper on this PC: ${err.message}`)))
      server.listen(0, '127.0.0.1', () => {
        const redirectUri = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
        timer = setTimeout(() => finish(new YouTubeAnalyticsError('Google sign-in timed out after 5 minutes. Press Connect to try again.')), deps.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS)
        const url = buildAuthUrl({ clientId, redirectUri, challenge, state })
        if (!deps.openExternal) {
          finish(new YouTubeAnalyticsError('The browser cannot be opened from here.'))
          return
        }
        Promise.resolve(deps.openExternal(url)).catch((err) => finish(new YouTubeAnalyticsError(`Could not open the browser: ${String(err)}`)))
      })
    })
  }

  // ------------------------------------------------------------ insights

  async function channelRetention(opts: { videos?: number; refresh?: boolean } = {}): Promise<ChannelRetention> {
    const want = Math.max(1, Math.min(50, Math.round(opts.videos ?? DEFAULT_VIDEOS)))
    const up = await uploads(opts.refresh)
    const long = up.videos.filter((v) => !v.isShort)
    const chosen = long.slice(0, want)
    // Shorts skipped among the uploads up to the oldest video looked at.
    const lastIndex = chosen.length ? up.videos.indexOf(chosen[chosen.length - 1]) : up.videos.length - 1
    const shortsSkipped = up.videos.slice(0, lastIndex + 1).filter((v) => v.isShort).length
    const stats = await videoStats(chosen.map((v) => v.id), opts.refresh)
    const curves = await pool(chosen, 4, (v) => retentionPoints(v.id, opts.refresh))
    const videos = chosen.map((v, i) => videoInsights(v, curves[i], stats.get(v.id)))
    return { channel: up.channel, summary: channelSummary(videos, shortsSkipped), videos, fetchedAt: up.fetchedAt }
  }

  async function videoRetention(videoId: string, opts: { refresh?: boolean } = {}): Promise<VideoRetention> {
    const id = videoId.trim()
    const up = await uploads(opts.refresh)
    let meta = up.videos.find((v) => v.id === id)
    if (!meta) [meta] = await videoDetails([id])
    if (!meta) throw new YouTubeAnalyticsError(`No video "${id}" on the connected channel.`)
    const [points, stats] = await Promise.all([retentionPoints(id, opts.refresh), videoStats([id], opts.refresh)])
    return { video: videoInsights(meta, points, stats.get(id)), curve: curveOf(points, meta.durationSec), fetchedAt: new Date(now()).toISOString() }
  }

  return {
    status,
    setClient(clientId, secret) {
      const id = clientId.trim()
      if (id !== yt().clientId) {
        // A sign-in belongs to one OAuth client: a new client needs a new sign-in.
        if (yt().clientId) forgetSignIn()
        saveYt({ clientId: id })
      }
      if (secret !== undefined) ctx.secrets.set('googleClientSecret', secret)
      lastError = undefined
      return status()
    },
    async connect() {
      const { clientId, secret } = client()
      connecting?.cancel('A new sign-in was started.')
      const { verifier, challenge } = pkcePair()
      const state = b64url(randomBytes(16))
      log('YouTube sign-in started in the browser')
      const { code, redirectUri } = await signIn(clientId, challenge, state)
      const body = await tokenRequest({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: secret
      })
      if (typeof body.refresh_token !== 'string') {
        throw new YouTubeAnalyticsError('Google signed you in but gave no lasting access. Remove the app at myaccount.google.com/permissions and press Connect again.')
      }
      ctx.secrets.set('googleRefreshToken', body.refresh_token)
      access = { token: String(body.access_token), expiresAt: now() + Number(body.expires_in ?? 3600) * 1000 }
      lastError = undefined
      // A fresh sign-in may be another channel: start the cache over.
      rmSync(cacheRoot(), { recursive: true, force: true })
      try {
        await uploads(true)
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
      log('YouTube channel connected (read-only)', { channel: yt().channelTitle })
      return status()
    },
    async disconnect() {
      connecting?.cancel('The sign-in was stopped.')
      const token = refreshToken()
      forgetSignIn()
      if (token) {
        // Ask Google to end the access too; the app forgets it either way.
        await doFetch(GOOGLE.revokeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }).toString()
        }).catch(() => undefined)
      }
      rmSync(cacheRoot(), { recursive: true, force: true })
      saveYt({ channelId: '', channelTitle: '', videoCount: 0 })
      lastError = undefined
      log('YouTube channel disconnected')
      return status()
    },
    channelRetention,
    videoRetention
  }
}
