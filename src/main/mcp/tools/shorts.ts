/** Shorts tools: Claude picks the moments and writes the titles; the app reframes, renders and exports. */
import { z } from 'zod'
import { MAX_OVERLAP, ShortSchema, overlapShare, shortDuration, type Short } from '@shared/shorts'
import { newId } from '../../project/store'
import { ToolError, defineTool, json, sourceById } from './common'

const num = z.number().finite()
const BOOKKEEPING = { bypassLock: true, noHistory: true } as const

const describe = (s: Short) => ({
  id: s.id,
  kind: s.kind,
  title: s.title,
  seconds: Math.round(shortDuration(s) * 10) / 10,
  segments: s.segments.map((g) => ({ source_id: g.sourceId, in: g.in, out: g.out, ...(g.focusX !== undefined ? { focus_x: g.focusX } : {}) })),
  youtubeTitle: s.youtubeTitle,
  tiktokCaption: s.tiktokCaption,
  hashtags: s.hashtags,
  reason: s.reason
})

export const shortsTools = [
  defineTool({
    name: 'list_shorts',
    description: 'The Shorts already made from this video: id, kind, title, length, the source pieces they use, titles and why each was chosen.',
    input: {},
    run: (_args, env) => json({ shorts: (env.store.project.shorts ?? []).map(describe) })
  }),

  defineTool({
    name: 'save_short',
    description:
      'Save one vertical Short (9:16) cut from the SOURCE footage: one or more pieces (source_id, in, out in source seconds) played in order, ' +
      'so you can cut dead air and jump between moments. Start on the hook within the first second; usually 15-60 s; it must make sense on ' +
      'its own. The app follows the subject with a vertical crop (faces first, then motion); give focus_x (0 = left, 1 = right of the source ' +
      'frame) for a piece only when you want a fixed framing. Captions are added big and bold from the transcript. Give a YouTube Shorts ' +
      'title, a TikTok caption, a short description and a few hashtags. kind "recap" is the ~30 s unboxing or review of the whole video; ' +
      `kind "highlight" is one moment. Highlights may not share more than ${Math.round(MAX_OVERLAP * 100)} % of their footage with another ` +
      'highlight: the call is refused and names the one it overlaps. replace_id replaces an existing Short.',
    input: {
      kind: z.enum(['highlight', 'recap']).default('highlight'),
      title: z.string().min(1).max(100),
      segments: z.array(z.object({ source_id: z.string(), in: num.min(0), out: num.min(0), focus_x: num.min(0).max(1).optional() })).min(1).max(30),
      youtube_title: z.string().max(100).default(''),
      tiktok_caption: z.string().max(2200).default(''),
      description: z.string().max(5000).default(''),
      hashtags: z.array(z.string()).max(15).default([]),
      reason: z.string().default(''),
      captions: z.boolean().default(true),
      replace_id: z.string().optional()
    },
    run: (args, env) => {
      const doc = env.store.snapshotDoc()
      const segments = args.segments.map((g, i) => {
        const src = sourceById(doc, g.source_id)
        if (g.out <= g.in) throw new ToolError(`Piece ${i + 1}: out (${g.out}) must be after in (${g.in}).`)
        if (src.duration && g.out > src.duration + 0.05) throw new ToolError(`Piece ${i + 1}: ${src.id} is only ${src.duration.toFixed(2)} s long.`)
        return { sourceId: g.source_id, in: g.in, out: g.out, ...(g.focus_x !== undefined ? { focusX: g.focus_x } : {}) }
      })
      const seconds = segments.reduce((t, g) => t + g.out - g.in, 0)
      if (seconds < 5) throw new ToolError(`That Short is only ${seconds.toFixed(1)} s. Make it at least 5 s.`)
      if (seconds > 180) throw new ToolError(`That Short is ${seconds.toFixed(0)} s; Shorts can be at most 180 s (aim for 15-60).`)
      const existing = doc.project.shorts ?? []
      if (args.replace_id && !existing.some((s) => s.id === args.replace_id)) throw new ToolError(`No Short "${args.replace_id}". Use list_shorts.`)
      if (args.kind === 'highlight') {
        for (const other of existing) {
          if (other.id === args.replace_id || other.kind !== 'highlight') continue
          const share = overlapShare({ segments }, other)
          if (share > MAX_OVERLAP) {
            throw new ToolError(
              `This shares ${Math.round(share * 100)} % of its footage with the Short "${other.title}" (${other.id}). Pick a different moment, ` +
                'or make fewer Shorts if the video does not have enough distinct moments.'
            )
          }
        }
      }
      const prev = existing.find((s) => s.id === args.replace_id)
      const short: Short = ShortSchema.parse({
        id: prev?.id ?? newId('short'),
        kind: args.kind,
        title: args.title,
        reason: args.reason,
        segments,
        youtubeTitle: args.youtube_title,
        tiktokCaption: args.tiktok_caption,
        description: args.description,
        hashtags: args.hashtags.map((h) => h.replace(/^#/, '')),
        captions: args.captions,
        createdAt: prev?.createdAt ?? new Date().toISOString()
      })
      env.store.mutate(prev ? `Remade Short "${short.title}"` : `Short "${short.title}"`, 'claude', (d) => {
        const list = d.project.shorts ?? []
        d.project.shorts = prev ? list.map((s) => (s.id === prev.id ? short : s)) : [...list, short]
      }, BOOKKEEPING)
      env.ctx.shorts.prepare(short.id)
      return json({ saved: describe(short), note: 'The app now follows the subject and renders a preview for the owner.' })
    }
  }),

  defineTool({
    name: 'delete_short',
    description: 'Remove a Short you made (for example to replace weaker ones).',
    input: { id: z.string() },
    run: (args, env) => {
      if (!(env.store.project.shorts ?? []).some((s) => s.id === args.id)) throw new ToolError(`No Short "${args.id}".`)
      env.store.mutate('Delete Short', 'claude', (d) => {
        d.project.shorts = (d.project.shorts ?? []).filter((s) => s.id !== args.id)
      }, BOOKKEEPING)
      return json({ deleted: args.id })
    }
  })
]
