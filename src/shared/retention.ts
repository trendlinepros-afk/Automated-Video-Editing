/**
 * Audience retention of the owner's own YouTube videos, turned into plain insights: how many
 * viewers are still there at 30 s, 1 min and each quarter, where they leave fastest, where they
 * re-watch, and how the video holds compared with similar videos on YouTube.
 *
 * Pure math on the numbers YouTube Analytics returns (no network, no files), shared by the main
 * process (the MCP tool, the cache) and the Settings preview.
 */

/** One point of YouTube's retention curve (there are 100, one per 1 % of the video). */
export interface RetentionPoint {
  /** Position in the video, 0..1 (elapsedVideoTimeRatio). */
  ratio: number
  /** Share of the video's views still watching here (audienceWatchRatio); can go above 1 with re-watches. */
  watch: number
  /** 0..1 against videos of similar length on YouTube; 0.5 is typical (relativeRetentionPerformance). */
  relative: number | null
}

export interface RetentionDrop {
  /** Where the fast fall starts and ends, in seconds from the start of the video. */
  atSec: number
  untilSec: number
  /** Where it starts as a share of the video's length, in %. */
  atPct: number
  /** Viewers still watching before and after the fall, in % of views. */
  fromPct: number
  toPct: number
  /** Percentage points of viewers lost over the fall. */
  lostPct: number
  /** The fall is in the opening seconds (the hook). */
  opening?: boolean
}

export interface RetentionSpike {
  atSec: number
  untilSec: number
  atPct: number
  /** Percentage points gained: viewers skipping back to watch this part again. */
  gainPct: number
}

export type RelativeVerdict = 'better than similar videos' | 'about the same as similar videos' | 'worse than similar videos' | 'unknown'

export interface VideoMeta {
  id: string
  title: string
  publishedAt: string
  durationSec: number
  isShort: boolean
  views: number
}

export interface VideoStats {
  views: number
  averageViewDurationSec: number
  averageViewPct: number
}

export interface VideoInsights {
  id: string
  title: string
  publishedAt: string
  durationSec: number
  views: number
  /** False when YouTube has no retention data yet (a new video, or too few views). */
  hasData: boolean
  averageViewDurationSec?: number
  averageViewPct?: number
  /** % of views still watching at each point (null when the video is shorter than that). */
  retentionPct: { at30s: number | null; at1min: number | null; at25: number | null; at50: number | null; at75: number | null }
  drops: RetentionDrop[]
  spikes: RetentionSpike[]
  vsSimilar: { average: number | null; first30s: number | null; verdict: RelativeVerdict }
}

export interface DropSpot {
  where: string
  /** How many of the analysed videos lose viewers fast here. */
  videos: number
  avgLostPct: number
}

export interface HeldVideo {
  id: string
  title: string
  averageViewPct: number | null
  at30sPct: number | null
}

export interface ChannelSummary {
  videosAnalysed: number
  videosWithoutData: number
  shortsSkipped: number
  averages: {
    at30sPct: number | null
    at1minPct: number | null
    at50Pct: number | null
    averageViewPct: number | null
    averageViewDurationSec: number | null
    relative: number | null
  }
  dropSpots: DropSpot[]
  heldBest: HeldVideo[]
  heldWorst: HeldVideo[]
  /** The same facts as short sentences. */
  notes: string[]
}

export interface ChannelRetention {
  channel: string
  summary: ChannelSummary
  videos: VideoInsights[]
  /** When the numbers were read from YouTube (they are kept for a day). */
  fetchedAt: string
}

export interface VideoRetention {
  video: VideoInsights
  /** The full curve, one value per 1 % of the video, rounded. */
  curve: { stepSec: number; retentionPct: number[]; relative: (number | null)[] }
  fetchedAt: string
}

export interface YouTubeStatus {
  clientId: string
  hasClientSecret: boolean
  connected: boolean
  connecting: boolean
  channelTitle: string
  videoCount: number
  /** The last problem, in plain words (for example an expired sign-in). */
  error?: string
}

// ---------------------------------------------------------------- math

const round1 = (n: number) => Math.round(n * 10) / 10
const pct = (ratio: number) => Math.round(ratio * 1000) / 10

function median(values: number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function mean(values: (number | null | undefined)[]): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}

/** Points in order, with anything YouTube left out (missing numbers) dropped. */
export function cleanPoints(points: RetentionPoint[]): RetentionPoint[] {
  return points.filter((p) => Number.isFinite(p.ratio) && Number.isFinite(p.watch)).sort((a, b) => a.ratio - b.ratio)
}

/** Share of views still watching at a position (0..1), read off the curve. */
export function watchAt(points: RetentionPoint[], ratio: number): number | null {
  if (!points.length || ratio < 0 || ratio > 1.0001) return null
  if (ratio <= points[0].ratio) return points[0].watch
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (ratio <= b.ratio) {
      const t = b.ratio === a.ratio ? 0 : (ratio - a.ratio) / (b.ratio - a.ratio)
      return a.watch + (b.watch - a.watch) * t
    }
  }
  return points[points.length - 1].watch
}

/** Groups of neighbouring steps that pass a test, as [first point, last point] index pairs. */
function runs(steps: number[], test: (s: number) => boolean): [number, number][] {
  const out: [number, number][] = []
  let start = -1
  for (let i = 0; i <= steps.length; i++) {
    if (i < steps.length && test(steps[i])) {
      if (start < 0) start = i
    } else if (start >= 0) {
      out.push([start, i]) // step i-1 ends at point i
      start = -1
    }
  }
  return out
}

/**
 * The places where viewers leave clearly faster than the video's usual pace. Every video loses
 * viewers slowly all the way through; a drop is a stretch that loses much more than that.
 * The last 5 % (end screen) is left out: everyone leaves there.
 */
export function findDrops(points: RetentionPoint[], durationSec: number, max = 4): RetentionDrop[] {
  const p = cleanPoints(points)
  if (p.length < 5) return []
  const steps = p.slice(1).map((pt, i) => pt.watch - p[i].watch)
  const usualLoss = Math.max(0, -median(steps.slice(2)))
  const limit = -(usualLoss * 1.5 + 0.004)
  const found = runs(steps, (s) => s < limit)
    .map(([from, to]) => {
      const lost = p[from].watch - p[to].watch
      const drop: RetentionDrop & { excess: number } = {
        atSec: Math.round(p[from].ratio * durationSec),
        untilSec: Math.round(p[to].ratio * durationSec),
        atPct: Math.round(p[from].ratio * 100),
        fromPct: pct(p[from].watch),
        toPct: pct(p[to].watch),
        lostPct: pct(lost),
        excess: lost - usualLoss * (to - from)
      }
      if (from === 0 || p[from].ratio * durationSec < 15) drop.opening = true
      return { drop, from }
    })
    .filter(({ drop, from }) => drop.lostPct >= 1.5 && p[from].ratio < 0.95)
    .map(({ drop }) => drop)
  return found
    .sort((a, b) => b.excess - a.excess)
    .slice(0, max)
    .sort((a, b) => a.atSec - b.atSec)
    .map(({ excess: _excess, ...d }) => d)
}

/** Stretches where the share of viewers goes up: people skipping back to watch it again. */
export function findSpikes(points: RetentionPoint[], durationSec: number, max = 3): RetentionSpike[] {
  const p = cleanPoints(points)
  if (p.length < 5) return []
  const steps = p.slice(1).map((pt, i) => pt.watch - p[i].watch)
  const usualLoss = Math.max(0, -median(steps.slice(2)))
  const limit = Math.max(0.004, usualLoss)
  return runs(steps, (s) => s > limit)
    .map(([from, to]) => ({
      atSec: Math.round(p[from].ratio * durationSec),
      untilSec: Math.round(p[to].ratio * durationSec),
      atPct: Math.round(p[from].ratio * 100),
      gainPct: pct(p[to].watch - p[from].watch)
    }))
    .filter((s) => s.gainPct >= 1)
    .sort((a, b) => b.gainPct - a.gainPct)
    .slice(0, max)
    .sort((a, b) => a.atSec - b.atSec)
}

export function verdictFor(relative: number | null): RelativeVerdict {
  if (relative === null) return 'unknown'
  if (relative >= 0.55) return 'better than similar videos'
  if (relative <= 0.45) return 'worse than similar videos'
  return 'about the same as similar videos'
}

export function videoInsights(meta: VideoMeta, rawPoints: RetentionPoint[], stats?: VideoStats | null): VideoInsights {
  const points = cleanPoints(rawPoints)
  const d = meta.durationSec
  const at = (ratio: number) => {
    const w = watchAt(points, ratio)
    return w === null ? null : pct(w)
  }
  const atSec = (sec: number) => (d > 0 && sec <= d ? at(sec / d) : null)
  const relAll = mean(points.map((p) => p.relative))
  const relFirst = mean(points.filter((p, i) => i === 0 || p.ratio * d <= 30).map((p) => p.relative))
  const out: VideoInsights = {
    id: meta.id,
    title: meta.title,
    publishedAt: meta.publishedAt,
    durationSec: d,
    views: stats?.views ?? meta.views,
    hasData: points.length >= 5,
    retentionPct: points.length
      ? { at30s: atSec(30), at1min: atSec(60), at25: at(0.25), at50: at(0.5), at75: at(0.75) }
      : { at30s: null, at1min: null, at25: null, at50: null, at75: null },
    drops: findDrops(points, d),
    spikes: findSpikes(points, d),
    vsSimilar: {
      average: relAll === null ? null : Math.round(relAll * 100) / 100,
      first30s: relFirst === null ? null : Math.round(relFirst * 100) / 100,
      verdict: verdictFor(relAll)
    }
  }
  if (stats) {
    out.averageViewDurationSec = Math.round(stats.averageViewDurationSec)
    out.averageViewPct = round1(stats.averageViewPct)
  }
  return out
}

/** The full curve, rounded, for one video. */
export function curveOf(points: RetentionPoint[], durationSec: number): VideoRetention['curve'] {
  const p = cleanPoints(points)
  return {
    stepSec: Math.round((durationSec / 100) * 10) / 10,
    retentionPct: p.map((x) => Math.round(x.watch * 100)),
    relative: p.map((x) => (x.relative === null ? null : Math.round(x.relative * 100) / 100))
  }
}

/** A name for where in a video a drop happens, so drops from different videos can be counted together. */
export function dropSpot(drop: RetentionDrop): string {
  if (drop.atSec < 15) return 'first 15 s'
  if (drop.atSec < 30) return '15-30 s'
  if (drop.atSec < 60) return '30-60 s'
  if (drop.atSec < 120) return '1-2 min'
  if (drop.atPct < 25) return 'first quarter (after 2 min)'
  if (drop.atPct < 50) return 'second quarter'
  if (drop.atPct < 75) return 'third quarter'
  return 'last quarter'
}

/** "1:05" */
export function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function channelSummary(videos: VideoInsights[], shortsSkipped = 0): ChannelSummary {
  const withData = videos.filter((v) => v.hasData)
  const avg = (f: (v: VideoInsights) => number | null | undefined) => {
    const m = mean(withData.map(f))
    return m === null ? null : round1(m)
  }
  const spots = new Map<string, { videos: Set<string>; lost: number[] }>()
  for (const v of withData) {
    for (const d of v.drops) {
      const key = dropSpot(d)
      const s = spots.get(key) ?? { videos: new Set<string>(), lost: [] }
      s.videos.add(v.id)
      s.lost.push(d.lostPct)
      spots.set(key, s)
    }
  }
  const dropSpots: DropSpot[] = [...spots.entries()]
    .map(([where, s]) => ({ where, videos: s.videos.size, avgLostPct: round1(mean(s.lost) ?? 0) }))
    .sort((a, b) => b.videos - a.videos || b.avgLostPct - a.avgLostPct)
    .slice(0, 5)
  const held = (v: VideoInsights): HeldVideo => ({
    id: v.id,
    title: v.title,
    averageViewPct: v.averageViewPct ?? null,
    at30sPct: v.retentionPct.at30s
  })
  // Average % watched says best how well a video held; the curve at the half-way mark stands in without it.
  const score = (v: VideoInsights) => v.averageViewPct ?? v.retentionPct.at50 ?? 0
  const ranked = [...withData].sort((a, b) => score(b) - score(a))
  const summary: ChannelSummary = {
    videosAnalysed: withData.length,
    videosWithoutData: videos.length - withData.length,
    shortsSkipped,
    averages: {
      at30sPct: avg((v) => v.retentionPct.at30s),
      at1minPct: avg((v) => v.retentionPct.at1min),
      at50Pct: avg((v) => v.retentionPct.at50),
      averageViewPct: avg((v) => v.averageViewPct),
      averageViewDurationSec: avg((v) => v.averageViewDurationSec),
      relative: (() => {
        const m = mean(withData.map((v) => v.vsSimilar.average))
        return m === null ? null : Math.round(m * 100) / 100
      })()
    },
    dropSpots,
    heldBest: ranked.slice(0, 3).map(held),
    heldWorst: ranked.length > 3 ? ranked.slice(-3).reverse().map(held) : [],
    notes: []
  }
  const n = summary.notes
  const a = summary.averages
  if (!withData.length) {
    n.push('YouTube has no retention data for these videos yet (new videos and videos with few views have none).')
    return summary
  }
  if (a.at30sPct !== null) n.push(`On average ${a.at30sPct} % of viewers are still watching at 0:30${a.at1minPct !== null ? ` and ${a.at1minPct} % at 1:00` : ''}.`)
  if (a.averageViewPct !== null) {
    n.push(`Viewers watch ${a.averageViewPct} % of a video on average${a.averageViewDurationSec !== null ? ` (${clock(a.averageViewDurationSec)})` : ''}.`)
  }
  if (dropSpots[0]) {
    n.push(`Most common place viewers leave fast: ${dropSpots[0].where} (${dropSpots[0].videos} of ${withData.length} videos, about ${dropSpots[0].avgLostPct} points lost).`)
  }
  if (summary.heldBest[0]) {
    const b = summary.heldBest[0]
    n.push(`Held best: "${b.title}"${b.averageViewPct !== null ? ` (${b.averageViewPct} % watched on average)` : ''}.`)
  }
  if (a.relative !== null) n.push(`Against similar-length videos on YouTube, retention is ${verdictFor(a.relative)} (${a.relative}, where 0.5 is typical).`)
  if (shortsSkipped) n.push(`${shortsSkipped} ${shortsSkipped === 1 ? 'Short was' : 'Shorts were'} left out.`)
  return summary
}

// ---------------------------------------------------------------- YouTube shapes

/** "PT1H2M3S" -> 3723 */
export function parseIsoDuration(text: string | undefined): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text ?? '')
  if (!m) return 0
  return (Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0)
}

/** A Short: 60 seconds or less, a vertical picture, or a short video tagged #shorts. */
export function isShortVideo(o: { durationSec: number; width?: number; height?: number; title?: string; description?: string }): boolean {
  if (o.durationSec > 0 && o.durationSec <= 60) return true
  if (o.width && o.height && o.height > o.width) return true
  if (o.durationSec <= 180 && /#shorts?\b/i.test(`${o.title ?? ''} ${o.description ?? ''}`)) return true
  return false
}
