/**
 * Shorts made from a project: vertical clips cut from the same footage, with their own cuts, a crop that follows
 * the subject, bold captions, and titles for YouTube Shorts and TikTok. Claude picks the moments; the app reframes,
 * renders and exports them.
 */
import { z } from 'zod'

const num = z.number().finite()

export const ShortSegmentSchema = z.looseObject({
  sourceId: z.string(),
  in: num.min(0),
  out: num.min(0),
  /** Where the subject is (0 = left edge, 1 = right edge of the source) when Claude chose the framing itself. */
  focusX: num.min(0).max(1).optional(),
  /** The crop over time, in source-frame fractions; filled in by the app's subject tracking. */
  track: z.array(z.looseObject({ t: num, x: num, y: num })).optional()
})
export type ShortSegment = z.infer<typeof ShortSegmentSchema>

export const ShortSchema = z.looseObject({
  id: z.string(),
  /** recap: the 30-second unboxing or review of the whole video. highlight: one moment. */
  kind: z.enum(['highlight', 'recap']).default('highlight'),
  title: z.string(),
  /** Why this moment works as a Short, in Claude's words. */
  reason: z.string().default(''),
  segments: z.array(ShortSegmentSchema).min(1),
  youtubeTitle: z.string().default(''),
  tiktokCaption: z.string().default(''),
  description: z.string().default(''),
  hashtags: z.array(z.string()).default([]),
  captions: z.boolean().default(true),
  createdAt: z.string(),
  /** The low-resolution preview render (project-relative), when made. */
  preview: z.string().optional(),
  /** The last full-quality export (absolute path). */
  exported: z.string().optional()
})
export type Short = z.infer<typeof ShortSchema>

export const SHORT_COUNTS = [1, 3, 6, 10, 15] as const
/** Two highlight Shorts may share at most this much of the shorter one's footage. */
export const MAX_OVERLAP = 0.25
export const SHORT_SIZE = { width: 1080, height: 1920 }
export const SHORT_PREVIEW_SIZE = { width: 540, height: 960 }

export function shortDuration(s: Pick<Short, 'segments'>): number {
  return s.segments.reduce((t, g) => t + Math.max(0, g.out - g.in), 0)
}

/** The share of the shorter Short's footage that both use (same source, overlapping times). */
export function overlapShare(a: Pick<Short, 'segments'>, b: Pick<Short, 'segments'>): number {
  let shared = 0
  for (const x of a.segments) {
    for (const y of b.segments) {
      if (x.sourceId !== y.sourceId) continue
      shared += Math.max(0, Math.min(x.out, y.out) - Math.max(x.in, y.in))
    }
  }
  const shorter = Math.min(shortDuration(a), shortDuration(b))
  return shorter > 0 ? shared / shorter : 0
}

export const SHORT_CAPTION_STYLE = { size: 0.068, position: 'middle' as const, maxWords: 3 }
