/**
 * Video themes: the measured editing style of reference videos (a YouTube video, the latest videos of a channel,
 * or a video file). Kept in the app's data folder, chosen per project, and read by Claude while it edits.
 */
import { z } from 'zod'

const num = z.number().finite()

export const VideoStyleStatsSchema = z.looseObject({
  duration: num,
  analyzedSeconds: num,
  cuts: num,
  cutsPerMinute: num,
  cutsPerMinuteFirst30s: num,
  cutsPerMinuteFirst60s: num,
  shotSeconds: z.looseObject({ median: num, mean: num, p10: num, p90: num }),
  pace: z.array(z.looseObject({ from: num, cutsPerMinute: num })).default([]),
  cutTimes: z.array(num).default([]),
  speech: z
    .looseObject({ wordsPerMinute: num, speechShare: num, longPausesPerMinute: num, firstWords: z.string().default('') })
    .optional(),
  loudnessLufs: num.optional(),
  sheets: z.array(z.looseObject({ file: z.string(), label: z.string() })).default([])
})
export type VideoStyleStats = z.infer<typeof VideoStyleStatsSchema>

export const VideoThemeSchema = z.looseObject({
  formatVersion: z.literal(1).default(1),
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  source: z.looseObject({ kind: z.enum(['video', 'channel', 'playlist', 'file']), input: z.string(), title: z.string().optional() }),
  videos: z.array(
    z.looseObject({
      title: z.string().default(''),
      channel: z.string().optional(),
      url: z.string().optional(),
      file: z.string().optional(),
      stats: VideoStyleStatsSchema
    })
  ),
  /** Averages over the videos, weighted by how much of each was measured. */
  averages: z.looseObject({
    cutsPerMinute: num,
    cutsPerMinuteFirst30s: num,
    medianShotSeconds: num,
    wordsPerMinute: num.optional(),
    loudnessLufs: num.optional()
  }),
  /** The owner's notes: what to copy and what to leave out. */
  notes: z.string().default(''),
  /** Claude's description of the style, written the first time it uses the theme. */
  summary: z.string().optional(),
  summaryAt: z.string().optional()
})
export type VideoTheme = z.infer<typeof VideoThemeSchema>

export interface VideoThemeProgress {
  step: 'tools' | 'listing' | 'download' | 'analyze' | 'done' | 'error'
  message: string
  percent?: number
}

export function averageStats(videos: { stats: VideoStyleStats }[]): VideoTheme['averages'] {
  const avg = (f: (s: VideoStyleStats) => number | undefined) => {
    const have = videos.filter((v) => f(v.stats) !== undefined)
    const w = have.reduce((t, v) => t + v.stats.analyzedSeconds, 0)
    return have.length && w ? Math.round((have.reduce((t, v) => t + f(v.stats)! * v.stats.analyzedSeconds, 0) / w) * 10) / 10 : undefined
  }
  const wpm = avg((s) => s.speech?.wordsPerMinute)
  const lufs = avg((s) => s.loudnessLufs)
  return {
    cutsPerMinute: avg((s) => s.cutsPerMinute) ?? 0,
    cutsPerMinuteFirst30s: avg((s) => s.cutsPerMinuteFirst30s) ?? 0,
    medianShotSeconds: avg((s) => s.shotSeconds.median) ?? 0,
    ...(wpm !== undefined ? { wordsPerMinute: wpm } : {}),
    ...(lufs !== undefined ? { loudnessLufs: lufs } : {})
  }
}

/** One line for prompts and cards: "about 24 cuts a minute (38 in the first 30 s), shots 1.9 s, 185 words a minute". */
export function themeOneLine(t: Pick<VideoTheme, 'averages'>): string {
  const a = t.averages
  return (
    `about ${a.cutsPerMinute} cuts a minute (${a.cutsPerMinuteFirst30s} in the first 30 s), median shot ${a.medianShotSeconds} s` +
    (a.wordsPerMinute ? `, speech ${a.wordsPerMinute} words a minute` : '') +
    (a.loudnessLufs !== undefined ? `, ${a.loudnessLufs} LUFS` : '')
  )
}
