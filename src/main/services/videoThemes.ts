/**
 * Video themes: measure the editing style of reference videos so Claude can edit to a similar pace and look.
 *
 * From a YouTube link the app downloads a small copy (480p at most, the first 12 minutes) of the video, or of the
 * newest few videos of a channel (Shorts and live streams skipped), with the captions, using yt-dlp. A video file
 * works too. The analysis script measures cuts, shot lengths, speech pace and loudness and makes contact sheets;
 * the downloads are deleted afterwards. Only the numbers and the contact sheets are kept, in
 * <data>/video-themes/<id>/. No Claude usage: Claude reads the result later, while editing.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { VideoStyleStatsSchema, VideoThemeSchema, averageStats, type VideoStyleStats, type VideoTheme, type VideoThemeProgress } from '@shared/videoTheme'
import type { AppContext } from '../context'
import { paths } from '../paths'
import { writeJsonAtomic } from '../project/store'
import { isCancelled, spawnLines } from '../engine/engine'
import { YouTubeError, parseYouTubeLink, resolveYouTubeVideos, type FetchLike } from './youtube'

/** How much of each video is measured: the opening matters most for pace. */
export const MAX_SECONDS = 720
/** Videos measured from a channel or playlist. */
export const CHANNEL_VIDEOS = 3

export interface VideoThemesService {
  list(): VideoTheme[]
  get(id: string): VideoTheme | null
  /** Folder holding a theme's theme.json and contact sheets. */
  dir(id: string): string
  analyze(input: { link?: string; file?: string; name?: string }, onProgress?: (p: VideoThemeProgress) => void): Promise<VideoTheme>
  cancel(): void
  update(id: string, patch: { name?: string; notes?: string; summary?: string }): VideoTheme
  remove(id: string): void
}

export interface VideoThemeDeps {
  fetch?: FetchLike
  root?: string
  workRoot?: string
}

const VIDEO_EXT = /\.(mp4|mkv|webm|mov|m4v)$/i

/** yt-dlp output that usually means YouTube changed and a newer yt-dlp is needed. */
const NEEDS_UPDATE = /sign in to confirm|HTTP Error 403|nsig|signature|Unable to extract|Requested format is not available|please report this issue|Confirm you are on the latest version/i

/** A channel's Shorts (up to 3 minutes) and live streams say little about its long-form editing. */
export function ytdlpArgs(urls: string[], workDir: string, ffmpeg: string, count: number, skipShorts: boolean): string[] {
  return [
    '--newline',
    '--no-playlist',
    '--ignore-errors',
    '--ffmpeg-location', dirname(ffmpeg),
    '-f', 'bv*[height<=480]+ba/b[height<=480]/bv*+ba/b',
    '-S', 'res:480',
    '--merge-output-format', 'mp4',
    '--download-sections', `*0-${MAX_SECONDS}`,
    '--write-subs', '--write-auto-subs', '--sub-langs', 'en.*,en,-live_chat', '--sub-format', 'json3/vtt/best',
    '--write-info-json',
    '--match-filter', skipShorts ? 'duration > 180 & !is_live' : '!is_live',
    '--max-downloads', String(count),
    '-o', join(workDir, '%(id)s.%(ext)s'),
    ...urls
  ]
}

export function createVideoThemesService(ctx: AppContext, deps: VideoThemeDeps = {}): VideoThemesService {
  const root = () => deps.root ?? join(paths.data, 'video-themes')
  const workRoot = () => deps.workRoot ?? join(paths.runtime, 'cache', 'video-themes')
  let abort: AbortController | null = null

  const read = (id: string): VideoTheme | null => {
    const file = join(root(), id, 'theme.json')
    if (!existsSync(file)) return null
    try {
      const parsed = VideoThemeSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }
  const save = (t: VideoTheme) => {
    mkdirSync(join(root(), t.id), { recursive: true })
    writeJsonAtomic(join(root(), t.id, 'theme.json'), t)
  }

  /** Download with yt-dlp; if YouTube changed and the download fails, update yt-dlp once and try again. */
  const download = async (urls: string[], work: string, count: number, report: (p: VideoThemeProgress) => void, signal: AbortSignal) => {
    const exe = await ctx.env.ytdlp((pct) => report({ step: 'tools', message: `Getting the YouTube downloader… ${Math.round(pct)}%`, percent: Math.round(pct * 0.1) }))
    const attempt = async () => {
      let n = 0
      const r = await spawnLines(exe, ytdlpArgs(urls, work, ctx.env.ffmpeg(), count, count > 1), {
        signal,
        onLine: (line) => {
          if (/^\[download\] Destination:.*\.(mp4|webm|m4a|mkv)$/i.test(line) && !/\.f\d+\./.test(line)) n++
          const pct = /^\[download\]\s+([\d.]+)%/.exec(line)
          if (pct) report({ step: 'download', message: `Downloading video ${Math.max(1, Math.min(n || 1, count))} of up to ${count}… ${Math.round(Number(pct[1]))}%`, percent: 10 + Math.round((Number(pct[1]) / 100) * 40) })
        }
      })
      return r
    }
    let r = await attempt()
    // Exit 101: stopped after --max-downloads, which is the plan.
    const videos = () => readdirSync(work).filter((f) => VIDEO_EXT.test(f) && !/\.f\d+\./.test(f) && !f.endsWith('.part'))
    if (!videos().length && r.code !== 0 && r.code !== 101 && NEEDS_UPDATE.test(r.stderr) && exe !== 'yt-dlp') {
      report({ step: 'tools', message: 'YouTube changed; updating the downloader…' })
      await spawnLines(exe, ['-U'], { signal })
      r = await attempt()
    }
    if (!videos().length) {
      const last = r.stderr.split(/\r?\n/).filter((l) => /ERROR/.test(l)).pop()?.replace(/^ERROR:\s*/, '') ?? ''
      if (/Sign in to confirm/i.test(last)) throw new YouTubeError('YouTube asked to confirm this is not a bot. Try again later, or use a video file instead.')
      if (/private|members-only|unavailable/i.test(last)) throw new YouTubeError(`That video cannot be downloaded: ${last}`)
      throw new YouTubeError(last ? `The video could not be downloaded: ${last}` : 'No long-form video (over 3 minutes) was found at that link.')
    }
    return videos()
  }

  /** Runs the analysis script on one video. */
  const measure = async (video: string, subs: string | undefined, outDir: string, prefix: string, report: (msg: string) => void, signal: AbortSignal): Promise<VideoStyleStats> => {
    const py = ctx.env.python()
    if (/[\\/]/.test(py) && !existsSync(py)) throw new Error('The engine is not set up yet. Finish the setup in Settings > Engine first.')
    let result: unknown = null
    let error: string | null = null
    const args = [ctx.env.analysisScript(), '--ffmpeg', ctx.env.ffmpeg(), '--video', video, ...(subs ? ['--subs', subs] : []), '--out-dir', outDir, '--prefix', prefix, '--max-seconds', String(MAX_SECONDS)]
    const r = await spawnLines(py, args, {
      signal,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      onLine: (line) => {
        try {
          const e = JSON.parse(line)
          if (e.event === 'result') result = e.data
          else if (e.event === 'error') error = String(e.message)
          else if (e.event === 'progress' && e.message) report(String(e.message))
        } catch {
          /* not an event line */
        }
      }
    })
    if (error || !result) throw new Error(`The video could not be analysed: ${error ?? (r.stderr.trim().split('\n').pop() || `exit code ${r.code}`)}`)
    return VideoStyleStatsSchema.parse(result)
  }

  return {
    list() {
      if (!existsSync(root())) return []
      return readdirSync(root())
        .map(read)
        .filter((t): t is VideoTheme => !!t)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },
    get: read,
    dir: (id) => join(root(), id),

    async analyze(input, onProgress) {
      if (abort) throw new Error('A video theme is already being analysed. Wait for it to finish or cancel it.')
      abort = new AbortController()
      const signal = abort.signal
      const report = (p: VideoThemeProgress) => onProgress?.(p)
      const id = `vt_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`
      const work = join(workRoot(), id)
      const out = join(root(), id)
      mkdirSync(work, { recursive: true })
      mkdirSync(out, { recursive: true })
      try {
        let items: { file: string; subs?: string; title: string; channel?: string; url?: string }[] = []
        let source: VideoTheme['source']
        if (input.file) {
          if (!existsSync(input.file)) throw new Error(`File not found: ${input.file}`)
          items = [{ file: input.file, title: basename(input.file, extname(input.file)) }]
          source = { kind: 'file', input: input.file, title: basename(input.file) }
        } else {
          const link = (input.link ?? '').trim()
          const parsed = parseYouTubeLink(link)
          if (!parsed) throw new YouTubeError('Paste a YouTube video, channel or playlist link, or choose a video file.')
          report({ step: 'listing', message: parsed.kind === 'video' ? 'Reading the video…' : 'Finding the newest videos…', percent: 2 })
          const found = parsed.kind === 'video' ? { source: '', kind: 'video' as const, videos: [{ videoId: parsed.videoId, title: '' }] } : await resolveYouTubeVideos(link, { fetch: deps.fetch, limit: 12 })
          const count = parsed.kind === 'video' ? 1 : CHANNEL_VIDEOS
          const urls = found.videos.map((v) => `https://www.youtube.com/watch?v=${v.videoId}`)
          const files = await download(urls, work, count, report, signal)
          for (const f of files) {
            const vid = f.replace(VIDEO_EXT, '')
            const info = existsSync(join(work, `${vid}.info.json`)) ? JSON.parse(readFileSync(join(work, `${vid}.info.json`), 'utf8')) : {}
            const subs = readdirSync(work).find((x) => x.startsWith(`${vid}.`) && /\.(json3|vtt)$/.test(x))
            items.push({ file: join(work, f), subs: subs ? join(work, subs) : undefined, title: info.title ?? '', channel: info.channel ?? info.uploader, url: info.webpage_url ?? `https://www.youtube.com/watch?v=${vid}` })
          }
          source = { kind: parsed.kind, input: link, title: found.source || items[0]?.channel || items[0]?.title }
        }
        const videos: VideoTheme['videos'] = []
        for (const [i, it] of items.entries()) {
          const base = 50 + Math.round((i / items.length) * 48)
          report({ step: 'analyze', message: `Measuring the style of ${it.title ? `"${it.title}"` : 'the video'}…`, percent: base })
          const stats = await measure(it.file, it.subs, out, `v${i + 1}`, (msg) => report({ step: 'analyze', message: `${msg} (video ${i + 1} of ${items.length})…`, percent: base }), signal)
          videos.push({ title: it.title, ...(it.channel ? { channel: it.channel } : {}), ...(it.url ? { url: it.url } : {}), ...(input.file ? { file: input.file } : {}), stats })
        }
        const channel = videos.find((v) => v.channel)?.channel
        const name =
          input.name?.trim() ||
          (source.kind === 'channel' && channel ? `${channel} style` : source.kind === 'file' ? basename(input.file!, extname(input.file!)) : videos[0]?.title || 'Video theme')
        const theme: VideoTheme = VideoThemeSchema.parse({
          id,
          name,
          createdAt: new Date().toISOString(),
          source,
          videos,
          averages: averageStats(videos),
          notes: ''
        })
        save(theme)
        ctx.appLog.write('app', `Video theme made: ${name}`, { id, source: source.kind, videos: videos.length })
        report({ step: 'done', message: 'Done', percent: 100 })
        return theme
      } catch (err) {
        rmSync(out, { recursive: true, force: true })
        if (isCancelled(err)) throw new Error('Cancelled')
        ctx.appLog.write('error', 'Video theme analysis failed', { error: err instanceof Error ? err.message : String(err) })
        throw err
      } finally {
        abort = null
        rmSync(work, { recursive: true, force: true })
      }
    },

    cancel() {
      abort?.abort()
    },

    update(id, patch) {
      const t = read(id)
      if (!t) throw new Error('That video theme no longer exists.')
      const next: VideoTheme = {
        ...t,
        ...(patch.name !== undefined ? { name: patch.name.trim() || t.name } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.summary !== undefined ? { summary: patch.summary.trim(), summaryAt: new Date().toISOString() } : {})
      }
      save(next)
      return next
    },

    remove(id) {
      if (!/^vt_[a-z0-9]+$/.test(id)) throw new Error('Unknown video theme.')
      rmSync(join(root(), id), { recursive: true, force: true })
    }
  }
}

/** Contact sheets of a theme, newest video first, for showing to Claude or in Settings. */
export function themeSheets(dir: string, t: VideoTheme): { label: string; path: string }[] {
  const out: { label: string; path: string }[] = []
  for (const v of t.videos) {
    for (const s of v.stats.sheets) {
      const p = join(dir, s.file)
      if (existsSync(p) && statSync(p).size > 0) out.push({ label: `${v.title ? `"${v.title}"` : 'Video'}: ${s.label}`, path: p })
    }
  }
  return out
}
