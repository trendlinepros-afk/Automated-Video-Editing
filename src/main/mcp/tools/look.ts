/** Look tools: let Claude see and measure its own work. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Range } from '@shared/project'
import { formatTime, round3 } from '@shared/timeline'
import { buildPlan } from '../../engine/plan'
import { ToolError, defineTool, images, json, sourceById, type ToolEnv } from './common'

const MAX_IMAGES = 24

function stampName(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function cacheDir(env: ToolEnv, ...parts: string[]): string {
  const dir = join(env.dir, 'cache', ...parts)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Renders the dialogue only (the A-roll voice as cut, no music or effects) for the whole timeline or a range,
 * with the engine's mix command. Returns the wav path.
 */
export async function renderDialogue(env: ToolEnv, out: string, range?: Range): Promise<string> {
  const doc = env.store.snapshotDoc()
  const p = doc.project
  const plan = buildPlan(doc, { projectDir: env.dir, width: p.output.width, height: p.output.height, fps: p.output.fps, burnCaptions: false })
  if (range && Math.min(range.end, plan.duration) <= range.start) throw new ToolError('That range is outside the edited timeline.')
  const planFile = env.ctx.engine.writePlan(plan, cacheDir(env, 'plans'), 'dialogue.json')
  const args = ['mix', '--plan', planFile, '--out', out, '--dialogue-only', '--fade', '0']
  if (range) args.push('--start', String(range.start), '--end', String(Math.min(range.end, plan.duration)))
  await env.ctx.engine.run(p.engineVersion, args)
  return out
}

const width = z.number().int().min(64).max(3840)

export const lookTools = [
  defineTool({
    name: 'get_frame',
    description:
      'A still of the edited video at a timeline time, rendered by the same compositor as the export (graphics, effects and captions in place). ' +
      'footage_only: true shows just the footage under the graphics. Returns an image.',
    input: { time: z.number().min(0), width: width.optional(), footage_only: z.boolean().optional() },
    run: async (args, env) => {
      const out = join(cacheDir(env, 'frames'), `${stampName('frame')}.png`)
      const file = await env.ctx.engine.frame(env.store.snapshotDoc(), env.dir, args.time, { width: args.width ?? 960, footageOnly: args.footage_only, out })
      return images([{ label: `Frame at ${formatTime(args.time, true)} (${args.time}s)${args.footage_only ? ', footage only' : ''}`, path: file }])
    }
  }),

  defineTool({
    name: 'get_frames',
    description: `Stills at several timeline times (up to ${MAX_IMAGES}), for checking graphic placement at key moments. Returns images in order.`,
    input: { times: z.array(z.number().min(0)).min(1).max(MAX_IMAGES), width: width.optional() },
    run: async (args, env) => {
      const files = await env.ctx.engine.frames(env.store.snapshotDoc(), env.dir, args.times, { width: args.width ?? 640, outDir: cacheDir(env, 'frames', stampName('set')) })
      return images(files.map((path, i) => ({ label: `Frame at ${formatTime(args.times[i], true)} (${args.times[i]}s)`, path })))
    }
  }),

  defineTool({
    name: 'get_range_frames',
    description:
      'Play back a range of the edited video as frames: `count` evenly spaced stills from start to end (up to 24). ' +
      'Use it to find what the owner means in a chat request (where they point, what moves) and as a motion check.',
    input: {
      start: z.number().min(0),
      end: z.number().min(0),
      count: z.number().int().min(2).max(MAX_IMAGES).default(8),
      width: width.optional()
    },
    run: async (args, env) => {
      if (args.end <= args.start) throw new ToolError('end must be after start')
      const step = (args.end - args.start) / (args.count - 1)
      const times = Array.from({ length: args.count }, (_, i) => round3(args.start + i * step))
      const files = await env.ctx.engine.frames(env.store.snapshotDoc(), env.dir, times, { width: args.width ?? 480, outDir: cacheDir(env, 'frames', stampName('range')) })
      return images(files.map((path, i) => ({ label: `${i + 1}/${times.length} at ${formatTime(times[i], true)} (${times[i]}s)`, path })))
    }
  }),

  defineTool({
    name: 'get_waveform',
    description:
      'Audio peaks (0..1) for a range. Give source_id with start/end in source seconds, or leave out source_id for the edited A-roll ' +
      'between timeline start/end (each cut piece is read from its source). peaks_per_second defaults to 50.',
    input: {
      source_id: z.string().optional(),
      start: z.number().min(0),
      end: z.number().min(0),
      peaks_per_second: z.number().int().min(1).max(1000).default(50)
    },
    run: async (args, env) => {
      if (args.end <= args.start) throw new ToolError('end must be after start')
      const pps = args.peaks_per_second
      if ((args.end - args.start) * pps > 20000) throw new ToolError('Too many peaks: shorten the range or lower peaks_per_second (max 20000 values).')
      const cache = new Map<string, number[]>()
      const peaksOf = async (sourceId: string) => {
        if (!cache.has(sourceId)) cache.set(sourceId, await env.ctx.engine.peaks(sourceById(env.store.snapshotDoc(), sourceId).path, pps))
        return cache.get(sourceId)!
      }
      const r3 = (v: number) => Math.round(v * 1000) / 1000
      if (args.source_id) {
        const all = await peaksOf(args.source_id)
        return json({ sourceId: args.source_id, start: args.start, end: args.end, peaksPerSecond: pps, peaks: all.slice(Math.floor(args.start * pps), Math.ceil(args.end * pps)).map(r3) })
      }
      const r = env.resolver()
      const peaks: number[] = []
      const seams: number[] = []
      for (const seg of r.segments) {
        const a = Math.max(args.start, seg.start)
        const b = Math.min(args.end, seg.end)
        if (b <= a) continue
        if (seg.start > args.start) seams.push(round3(seg.start))
        const s = seg.item
        const n = Math.round((b - a) * pps)
        if (s.hold || s.muted) {
          peaks.push(...new Array(n).fill(0))
          continue
        }
        const all = await peaksOf(s.sourceId)
        const speed = s.speed || 1
        for (let k = 0; k < n; k++) {
          const src = s.in + (a - seg.start + k / pps) * speed
          peaks.push(r3(all[Math.floor(src * pps)] ?? 0))
        }
      }
      return json({ timeline: true, start: args.start, end: args.end, peaksPerSecond: pps, seams, peaks })
    }
  }),

  defineTool({
    name: 'get_audio_energy',
    description:
      'RMS loudness in dB for each step (default 5 ms) of a SOURCE between start and end (source seconds, at most 10 s). ' +
      'This is how you find a word boundary: read the energy around a flagged cut in 5 ms steps and put the edge where the word really ' +
      'starts or ends. Do not rely on automatic snapping.',
    input: {
      source_id: z.string(),
      start: z.number().min(0),
      end: z.number().min(0),
      step_ms: z.number().min(1).max(100).default(5)
    },
    run: async (args, env) => {
      if (args.end <= args.start) throw new ToolError('end must be after start')
      if (args.end - args.start > 10) throw new ToolError('Read at most 10 seconds at a time.')
      const src = sourceById(env.store.snapshotDoc(), args.source_id)
      const res = await env.ctx.engine.energy(src.path, args.start, args.end, args.step_ms)
      return json({
        sourceId: args.source_id,
        start: res.start,
        stepMs: res.stepMs,
        note: 'db[i] is the RMS level of the step starting at start + i*stepMs/1000 seconds',
        db: res.db.map((v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : -120))
      })
    }
  }),

  defineTool({
    name: 'get_audio_snippet',
    description:
      'Writes a short wav you can transcribe on its own (for example with faster-whisper) to confirm a doubled or clipped word. ' +
      'Give source_id with start/end in source seconds, or leave out source_id for the assembled dialogue between timeline start/end. ' +
      'Returns the file path (at most 60 s).',
    input: { source_id: z.string().optional(), start: z.number().min(0), end: z.number().min(0) },
    run: async (args, env) => {
      if (args.end <= args.start) throw new ToolError('end must be after start')
      if (args.end - args.start > 60) throw new ToolError('A snippet can be at most 60 seconds.')
      const out = join(cacheDir(env, 'snippets'), `${stampName(args.source_id ? 'src' : 'tl')}.wav`)
      if (args.source_id) {
        const src = sourceById(env.store.snapshotDoc(), args.source_id)
        const file = await env.ctx.engine.snippet(src.path, args.start, args.end, out)
        return json({ file, sourceId: args.source_id, start: args.start, end: args.end })
      }
      const file = await renderDialogue(env, out, { start: args.start, end: args.end })
      const words = env
        .resolver()
        .placedWords()
        .filter((w) => w.end > args.start && w.start < args.end)
        .map((w) => [w.word.id, w.word.text, round3(w.start - args.start), round3(w.end - args.start)])
      return json({ file, timeline: true, start: args.start, end: args.end, wordsInSnippet: { fields: ['id', 'text', 'start', 'end'], words } })
    }
  })
]
