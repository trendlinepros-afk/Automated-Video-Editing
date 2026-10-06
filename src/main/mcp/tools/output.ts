/** Thumbnails and Output tools: thumbnails, self-check, export, publishing pack, caption emphasis. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { RenderJobState } from '@shared/ipc'
import { PIKZELS_MODELS } from '@shared/pikzelsPricing'
import type { Thumbnail } from '@shared/project'
import { round3 } from '@shared/timeline'
import type { AppContext } from '../../context'
import { newId } from '../../project/store'
import { ToolError, anchorInput, defineTool, errMessage, json, toAnchor } from './common'
import { renderDialogue } from './look'

export const PROMPT_WARN_CHARS = 750
const THUMBNAIL_WAIT_MS = 240_000

/** Last known state of each export job, per app. */
const thumbView = (t: Thumbnail) => ({ id: t.id, kind: t.kind, status: t.status, file: t.file, error: t.error, warning: t.warning, cost: t.cost, requestId: t.requestId })

const jobStates = new WeakMap<AppContext, Map<string, RenderJobState>>()

function trackJobs(ctx: AppContext): Map<string, RenderJobState> {
  let map = jobStates.get(ctx)
  if (!map) {
    const m = new Map<string, RenderJobState>()
    jobStates.set(ctx, m)
    ctx.renders.onJob((j) => m.set(j.id, j))
    map = m
  }
  return map
}

export const outputTools = [
  defineTool({
    name: 'request_thumbnails',
    description:
      'Generate thumbnail options through Pikzels, one prompt per option (1 to 3; the project count is in get_profile thumbnailDefaults). ' +
      "Write each prompt from the video's transcript and content, following the channel's thumbnail direction. The project's persona and " +
      'style are added by the app. reference_time attaches a frame of the video at that timeline time as a reference image. Keep prompts ' +
      `under ${PROMPT_WARN_CHARS} characters; links are removed. Images are downloaded into thumbnails/ and shown in the Thumbnails tab.`,
    input: {
      prompts: z.array(z.string().min(1)).min(1).max(3),
      reference_time: z.number().min(0).optional(),
      model: z.enum(PIKZELS_MODELS).optional().describe('Default: the model in Settings (pkz_4_5). Persona and style only work on pkz_4 and pkz_4_5.')
    },
    run: async (args, env) => {
      if (!env.ctx.pikzels.hasKey()) throw new ToolError('Pikzels API key is missing or wrong. The owner adds it in Settings.')
      const warnings: string[] = []
      args.prompts.forEach((p, i) => {
        if (p.length > PROMPT_WARN_CHARS) warnings.push(`Prompt ${i + 1} is ${p.length} characters; Pikzels may shorten prompts over ${PROMPT_WARN_CHARS}.`)
        if (/https?:\/\/|www\./i.test(p)) warnings.push(`Prompt ${i + 1} contained a link; links are removed.`)
      })
      const since = new Date().toISOString()
      const job = env.ctx.pikzels.generate({ prompts: args.prompts, source: 'claude', referenceTime: args.reference_time, model: args.model })
      let timedOut = false
      await Promise.race([job, new Promise<void>((res) => setTimeout(() => { timedOut = true; res() }, THUMBNAIL_WAIT_MS).unref?.())])
      const made = env.store.project.thumbnails.items
        .filter((t) => t.createdAt >= since && t.source === 'claude')
        .map((t) => ({ id: t.id, status: t.status, file: t.file, error: t.error, requestId: t.requestId }))
      return json({
        thumbnails: made,
        ...(timedOut ? { note: 'Still generating; the images will appear in the Thumbnails tab.' } : {}),
        ...(warnings.length ? { warnings } : {})
      })
    }
  }),

  defineTool({
    name: 'recreate_thumbnail',
    description:
      'Make a new thumbnail from an image through Pikzels ("Recreate"): a thumbnail of this project (thumbnail_id), a frame of the video ' +
      '(time, timeline seconds), or a YouTube video link (youtube_url) whose thumbnail to take after. prompt says what to change or keep. ' +
      "The project's persona and style are added on PKZ-4 and PKZ-4.5. Costs Pikzels credits; the result goes into the Thumbnails tab history.",
    input: {
      thumbnail_id: z.string().optional(),
      time: z.number().min(0).optional(),
      youtube_url: z.string().url().optional(),
      prompt: z.string().optional(),
      model: z.enum(PIKZELS_MODELS).optional()
    },
    run: async (args, env) => {
      const from = { thumbnailId: args.thumbnail_id, time: args.time, url: args.youtube_url }
      if (Object.values(from).filter((v) => v !== undefined).length !== 1) throw new ToolError('Give exactly one of thumbnail_id, time or youtube_url.')
      try {
        const t = await env.ctx.pikzels.recreate({ from, prompt: args.prompt, model: args.model, source: 'claude' })
        return json({ thumbnail: thumbView(t) })
      } catch (err) {
        throw new ToolError(errMessage(err))
      }
    }
  }),

  defineTool({
    name: 'edit_thumbnail',
    description:
      'Change part of an existing thumbnail of this project through Pikzels with a prompt (e.g. "make the text say IT EXPLODED, keep the rest"). ' +
      'The edited image is a new thumbnail in the history; the original stays. Costs Pikzels credits.',
    input: { thumbnail_id: z.string(), prompt: z.string().min(1) },
    run: async (args, env) => {
      try {
        const t = await env.ctx.pikzels.edit({ thumbnailId: args.thumbnail_id, prompt: args.prompt, source: 'claude' })
        return json({ thumbnail: thumbView(t) })
      } catch (err) {
        throw new ToolError(errMessage(err))
      }
    }
  }),

  defineTool({
    name: 'score_thumbnail',
    description:
      'Score a thumbnail of this project with Pikzels (overall score, subscores and a suggestion), optionally against a video title ' +
      '(default: the first title option). The score is stored on the thumbnail and shown to the owner. Costs a few Pikzels credits.',
    input: { thumbnail_id: z.string(), title: z.string().optional() },
    run: async (args, env) => {
      try {
        return json({ thumbnailId: args.thumbnail_id, score: await env.ctx.pikzels.score(args.thumbnail_id, args.title) })
      } catch (err) {
        throw new ToolError(errMessage(err))
      }
    }
  }),

  defineTool({
    name: 'generate_titles',
    description:
      'Ask Pikzels for title options from a prompt (what the video is about; default: the start of the transcript), optionally showing it a ' +
      'thumbnail of this project. The titles are added to the Publish tab title options. Costs Pikzels credits.',
    input: { prompt: z.string().optional(), thumbnail_id: z.string().optional() },
    run: async (args, env) => {
      try {
        return json({ titles: await env.ctx.pikzels.titles({ prompt: args.prompt, thumbnailId: args.thumbnail_id, source: 'claude' }) })
      } catch (err) {
        throw new ToolError(errMessage(err))
      }
    }
  }),

  defineTool({
    name: 'run_self_check',
    description:
      'Assemble the dialogue exactly as cut (voice only, no music or effects) into a wav, and list every placed word in timeline order with ' +
      'its timeline time and its source id/time. Transcribe the wav yourself (faster-whisper) and compare with this list: clipped or doubled ' +
      'words at a cut show up as mismatches. Then fix each boundary with get_audio_energy (5 ms steps) and adjust_cut, and record the ' +
      'result with record_self_check.',
    input: {},
    run: async (_args, env) => {
      const dir = join(env.dir, 'cache', 'selfcheck')
      mkdirSync(dir, { recursive: true })
      const file = await renderDialogue(env, join(dir, 'dialogue.wav'))
      const r = env.resolver()
      return json({
        file,
        duration: round3(r.duration),
        fields: ['id', 'text', 'timelineStart', 'timelineEnd', 'sourceId', 'sourceStart', 'sourceEnd', 'segmentId'],
        words: r.placedWords().map((w) => [w.word.id, w.word.text, round3(w.start), round3(w.end), w.sourceId, w.word.start, w.word.end, w.segmentId])
      })
    }
  }),

  defineTool({
    name: 'record_self_check',
    description:
      'Record the self-check result: every word still flagged after your fixes (word, timeline time, note). An empty list means the dialogue ' +
      'checked clean. Each flag is written to the project log.',
    input: { flags: z.array(z.object({ word: z.string(), time: z.number().min(0), note: z.string().optional() })) },
    run: (args, env) => {
      const ranAt = new Date().toISOString()
      env.mutate('Self-check result', (d) => {
        d.project.selfCheck = { ...d.project.selfCheck, ranAt, flags: args.flags }
      }, { bypassLock: true, noHistory: true })
      if (!args.flags.length) env.store.log.write('selfcheck', 'Self-check: no flagged words')
      for (const f of args.flags) env.store.log.write('selfcheck', `Flagged "${f.word}" at ${f.time.toFixed(3)}s${f.note ? `: ${f.note}` : ''}`)
      return json({ recorded: args.flags.length, ranAt })
    }
  }),

  defineTool({
    name: 'start_export',
    description:
      "Render the video (or a range) with the GPU compositor using the project's export preset, into the project's exports/ folder. " +
      'quick: true makes a fast low-resolution check. Returns a job id; follow it with get_export_status. Rendering uses no Claude usage.',
    input: {
      start: z.number().min(0).optional(),
      end: z.number().min(0).optional(),
      quick: z.boolean().default(false),
      captions: z.enum(['burn', 'srt', 'both', 'none']).optional()
    },
    run: async (args, env) => {
      if (env.ctx.renders.isBusy()) throw new ToolError('An export is already running.')
      const range = args.start !== undefined && args.end !== undefined ? { start: args.start, end: args.end } : undefined
      if (range && range.end <= range.start) throw new ToolError('end must be after start')
      trackJobs(env.ctx)
      const p = env.store.project
      const jobId = await env.ctx.renders.start({ range, preset: p.settings.exportPreset, quick: args.quick, captions: args.captions ?? p.settings.captionExport })
      return json({ jobId, preset: p.settings.exportPreset, range: range ?? 'whole video' })
    }
  }),

  defineTool({
    name: 'get_export_status',
    description: 'Progress of an export started with start_export (percent, fps, output file when done, error output when it failed).',
    input: { job_id: z.string().optional() },
    run: (args, env) => {
      const jobs = trackJobs(env.ctx)
      const job = args.job_id ? jobs.get(args.job_id) : [...jobs.values()].pop()
      return json({ job: job ?? null, running: env.ctx.renders.isBusy(), lastOutput: env.ctx.renders.lastOutput() })
    }
  }),

  defineTool({
    name: 'measure_loudness',
    description: 'Integrated loudness (LUFS) and true peak (dB) of an audio or video file, e.g. the finished export (the target is in get_profile mix).',
    input: { path: z.string() },
    run: async (args, env) => {
      try {
        return json({ path: args.path, ...(await env.ctx.engine.loudness(args.path)) })
      } catch (err) {
        throw new ToolError(`Could not measure ${args.path}: ${errMessage(err)}`)
      }
    }
  }),

  defineTool({
    name: 'save_publish_pack',
    description:
      'Save the publishing pack: title options, the description (start from the profile description template with its standing links and ' +
      'disclaimer), chapters anchored to words (so timestamps follow later edits) and tags. Only the parts you pass are replaced.',
    input: {
      titles: z.array(z.string()).optional(),
      description: z.string().optional(),
      chapters: z.array(z.object({ title: z.string(), anchor: anchorInput })).optional(),
      tags: z.array(z.string()).optional()
    },
    run: (args, env) => {
      const doc = env.store.snapshotDoc()
      const chapters = args.chapters?.map((c) => ({ id: newId('ch'), title: c.title, anchor: toAnchor(c.anchor, doc) }))
      env.mutate('Publishing pack', (d) => {
        const pub = d.project.publish
        if (args.titles) pub.titles = args.titles
        if (args.description !== undefined) pub.description = args.description
        if (chapters) {
          // Keep chapter ids stable when a chapter with the same title is saved again.
          pub.chapters = chapters.map((c) => ({ ...c, id: pub.chapters.find((o) => o.title === c.title)?.id ?? c.id }))
        }
        if (args.tags) pub.tags = args.tags
        pub.updatedAt = new Date().toISOString()
      }, { bypassLock: true })
      const r = env.resolver()
      const pub = env.store.project.publish
      return json({
        titles: pub.titles,
        tags: pub.tags,
        descriptionChars: pub.description.length,
        chapters: pub.chapters.map((c) => ({ title: c.title, time: round3(r.anchorTime(c.anchor).time) }))
      })
    }
  }),

  defineTool({
    name: 'set_caption_emphasis',
    description: 'Mark words for emphasis in the captions (highlight color from the brand kit), or remove the emphasis.',
    input: { word_ids: z.array(z.string()).min(1), on: z.boolean() },
    run: (args, env) => {
      const wanted = new Set(args.word_ids)
      const found = new Set<string>()
      env.mutate(`Caption emphasis ${args.on ? 'on' : 'off'} (${args.word_ids.length} words)`, (d) => {
        for (const clip of Object.values(d.transcript.clips)) {
          for (const w of clip.words) {
            if (!wanted.has(w.id)) continue
            found.add(w.id)
            if (args.on) w.emphasis = true
            else delete w.emphasis
          }
        }
      }, { bypassLock: true })
      const missing = args.word_ids.filter((id) => !found.has(id))
      return json({ changed: found.size, ...(missing.length ? { unknownWordIds: missing } : {}) })
    }
  })
]
