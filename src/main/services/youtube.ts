/**
 * Thumbnails from a YouTube link, for training a Pikzels persona or style without downloading
 * images by hand. Paste a channel, a video or a playlist link; the app lists the thumbnails and
 * you pick the three to train from.
 *
 * Uses YouTube's public pages, feeds and thumbnail images only. No API key, no sign-in.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type YouTubeLink =
  | { kind: 'video'; videoId: string }
  | { kind: 'playlist'; playlistId: string }
  | { kind: 'channel'; channelId?: string; path: string }

export interface YouTubeThumbnail {
  videoId: string
  title: string
  /** Local copy of the thumbnail image, ready to upload. */
  file: string
}

export interface YouTubeThumbnailList {
  source: string // channel or playlist name, or the video title
  items: YouTubeThumbnail[]
}

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}>

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/

// Asking for the English page and accepting YouTube's consent wall up front keeps the page the
// same everywhere (in the EU YouTube otherwise answers with a cookie consent page).
const PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: 'CONSENT=YES+cb; SOCS=CAI'
}

export class YouTubeError extends Error {}

/** Understands every common YouTube link form. Returns null for anything that is not YouTube. */
export function parseYouTubeLink(input: string): YouTubeLink | null {
  const text = input.trim()
  if (VIDEO_ID.test(text)) return { kind: 'video', videoId: text }
  if (CHANNEL_ID.test(text)) return { kind: 'channel', channelId: text, path: `/channel/${text}` }
  if (/^@[\w.-]+$/.test(text)) return { kind: 'channel', path: `/${text}` }
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '')
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0]
    return VIDEO_ID.test(id) ? { kind: 'video', videoId: id } : null
  }
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null
  const parts = url.pathname.split('/').filter(Boolean)
  const v = url.searchParams.get('v')
  if (v && VIDEO_ID.test(v)) return { kind: 'video', videoId: v }
  if (['shorts', 'live', 'embed', 'v'].includes(parts[0] ?? '') && VIDEO_ID.test(parts[1] ?? '')) {
    return { kind: 'video', videoId: parts[1] }
  }
  const list = url.searchParams.get('list')
  if (list) return { kind: 'playlist', playlistId: list }
  if (parts[0]?.startsWith('@')) return { kind: 'channel', path: `/${parts[0]}` }
  if (parts[0] === 'channel' && CHANNEL_ID.test(parts[1] ?? '')) {
    return { kind: 'channel', channelId: parts[1], path: `/channel/${parts[1]}` }
  }
  if ((parts[0] === 'c' || parts[0] === 'user') && parts[1]) return { kind: 'channel', path: `/${parts[0]}/${parts[1]}` }
  return null
}

/** The channel id (UC…) on a channel page. */
export function extractChannelId(html: string): string | null {
  const patterns = [
    /"externalId":"(UC[A-Za-z0-9_-]{22})"/,
    /<meta itemprop="(?:identifier|channelId)" content="(UC[A-Za-z0-9_-]{22})"/,
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/,
    /"browseId":"(UC[A-Za-z0-9_-]{22})"/,
    /"channelId":"(UC[A-Za-z0-9_-]{22})"/
  ]
  for (const re of patterns) {
    const m = re.exec(html)
    if (m) return m[1]
  }
  return null
}

/** Video ids in page order, without repeats. */
export function extractVideoIds(html: string, limit = 60): string[] {
  const seen = new Set<string>()
  for (const m of html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)) {
    seen.add(m[1])
    if (seen.size >= limit) break
  }
  return [...seen]
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
}

/** A channel or playlist feed: its name and its newest videos with titles. */
export function parseFeed(xml: string): { title: string; videos: { videoId: string; title: string }[] } {
  const head = xml.split('<entry>')[0]
  const title = decodeXml(/<title>([\s\S]*?)<\/title>/.exec(head)?.[1] ?? '').trim()
  const videos: { videoId: string; title: string }[] = []
  for (const entry of xml.split('<entry>').slice(1)) {
    const id = /<yt:videoId>([A-Za-z0-9_-]{11})<\/yt:videoId>/.exec(entry)?.[1]
    if (!id) continue
    videos.push({ videoId: id, title: decodeXml(/<title>([\s\S]*?)<\/title>/.exec(entry)?.[1] ?? '').trim() })
  }
  return { title, videos }
}

/** The title YouTube puts in a video page's head. */
export function extractVideoTitle(html: string): string {
  const m = /<meta name="title" content="([^"]*)"/.exec(html) ?? /<title>([\s\S]*?)<\/title>/.exec(html)
  return decodeXml(m?.[1] ?? '').replace(/ - YouTube$/, '').trim()
}

export interface FetchThumbnailsOptions {
  fetch?: FetchLike
  cacheDir: string
  /** How many videos to list from a channel or playlist. */
  limit?: number
}

/**
 * Lists thumbnails for one or more links (separated by spaces, commas or new lines) and saves a
 * local copy of each, largest size available.
 */
export async function fetchYouTubeThumbnails(input: string, opts: FetchThumbnailsOptions): Promise<YouTubeThumbnailList> {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init))
  const limit = opts.limit ?? 30
  const links = input.split(/[\s,]+/).filter(Boolean)
  if (!links.length) throw new YouTubeError('Paste a YouTube channel, video or playlist link.')

  const getText = async (url: string): Promise<string> => {
    let res
    try {
      res = await doFetch(url, { headers: PAGE_HEADERS })
    } catch {
      throw new YouTubeError("Can't reach YouTube. Check your internet connection.")
    }
    if (!res.ok) throw new YouTubeError(res.status === 404 ? 'YouTube could not find that link.' : `YouTube answered ${res.status}. Try again.`)
    return res.text()
  }

  const videos: { videoId: string; title: string }[] = []
  const sources: string[] = []
  for (const raw of links) {
    const link = parseYouTubeLink(raw)
    if (!link) throw new YouTubeError(`That is not a YouTube channel, video or playlist link: ${raw}`)
    if (link.kind === 'video') {
      let title = ''
      try {
        title = extractVideoTitle(await getText(`https://www.youtube.com/watch?v=${link.videoId}`))
      } catch {
        /* the thumbnail still works without a title */
      }
      videos.push({ videoId: link.videoId, title })
      sources.push(title || 'Video')
    } else if (link.kind === 'playlist') {
      const feed = parseFeed(await getText(`https://www.youtube.com/feeds/videos.xml?playlist_id=${encodeURIComponent(link.playlistId)}`))
      videos.push(...feed.videos)
      sources.push(feed.title || 'Playlist')
    } else {
      // The channel's Videos tab lists its uploads; the feed adds titles for the newest ones.
      const page = await getText(`https://www.youtube.com${link.path}/videos`)
      const channelId = link.channelId ?? extractChannelId(page)
      let feed: ReturnType<typeof parseFeed> | null = null
      if (channelId) {
        try {
          feed = parseFeed(await getText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`))
        } catch {
          feed = null
        }
      }
      const titles = new Map(feed?.videos.map((v) => [v.videoId, v.title]) ?? [])
      const ids = extractVideoIds(page, limit)
      const list = ids.length ? ids : (feed?.videos.map((v) => v.videoId) ?? [])
      if (!list.length) throw new YouTubeError('No videos were found on that channel.')
      videos.push(...list.map((videoId) => ({ videoId, title: titles.get(videoId) ?? '' })))
      sources.push(feed?.title || link.path.replace(/^\//, ''))
    }
  }

  const unique = [...new Map(videos.map((v) => [v.videoId, v])).values()].slice(0, Math.max(limit, links.length))
  mkdirSync(opts.cacheDir, { recursive: true })
  const items: YouTubeThumbnail[] = []
  // A few at a time keeps a 30-video channel quick without hammering YouTube.
  for (let i = 0; i < unique.length; i += 6) {
    const batch = await Promise.all(unique.slice(i, i + 6).map((v) => saveThumbnail(doFetch, v, opts.cacheDir)))
    for (const t of batch) if (t) items.push(t)
  }
  if (!items.length) throw new YouTubeError('No thumbnails could be downloaded for that link.')
  return { source: sources.join(', '), items }
}

/** Downloads the largest thumbnail YouTube has for a video. maxresdefault is missing on some videos. */
async function saveThumbnail(doFetch: FetchLike, v: { videoId: string; title: string }, dir: string): Promise<YouTubeThumbnail | null> {
  const file = join(dir, `${v.videoId}.jpg`)
  if (existsSync(file) && statSync(file).size > 2000) return { ...v, file }
  for (const size of ['maxresdefault', 'sddefault', 'hqdefault']) {
    try {
      const res = await doFetch(`https://i.ytimg.com/vi/${v.videoId}/${size}.jpg`)
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      // YouTube serves a tiny grey placeholder for sizes that do not exist.
      if (buf.length < 2000) continue
      writeFileSync(file, buf)
      return { ...v, file }
    } catch {
      /* try the next size */
    }
  }
  return null
}
