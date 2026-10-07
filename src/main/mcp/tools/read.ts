/** Read tools: understand the project and the channel. */
import { existsSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import { z } from 'zod'
import { ENGINE_VERSION, PROJECT_FORMAT_VERSION } from '@shared/appInfo'
import { DEFAULT_EDITING_RULES } from '@shared/rules'
import { round3 } from '@shared/timeline'
import { themeOneLine } from '@shared/videoTheme'
import { themeSheets } from '../../services/videoThemes'
import { AUDIO_EXT, IMAGE_EXT, defineTool, describeItem, ensureSource, images, json, sourceById } from './common'

const VIDEO_EXT = /\.(mp4|mov|mkv|avi|m4v|webm|mts|m2ts|mxf)$/i

export const readTools = [
  defineTool({
    name: 'get_project',
    description:
      'Summary of the open project: name, status, edit scope, output size, tracks, every item with its RESOLVED timeline start/end ' +
      '(plus its anchor), sources, the progress checklist, handoff notes, the section lock (if a re-edit is in progress), and counts. ' +
      'Times are seconds on the edited timeline. Call this first in every session.',
    input: {},
    run: (_args, env) => {
      const p = env.store.project
      const r = env.resolver()
      const counts: Record<string, number> = {}
      for (const i of p.items) counts[i.trackId] = (counts[i.trackId] ?? 0) + 1
      const words = Object.values(env.store.transcript.clips).reduce((n, c) => n + c.words.length, 0)
      return json({
        id: p.id,
        name: p.name,
        folder: env.dir,
        formatVersion: p.formatVersion,
        engineVersion: p.engineVersion,
        status: p.status,
        scope: p.scope,
        output: p.output,
        timelineDuration: round3(r.duration),
        tracks: p.tracks,
        items: p.items.map((i) => describeItem(r, i)),
        sources: p.sources.map((s) => ({ ...s, missing: !existsSync(s.path) })),
        checklist: p.checklist,
        handoffNotes: p.handoffNotes.slice(-15),
        lock: p.lock,
        captions: p.captions,
        thumbnails: { personaId: p.thumbnails.personaId, styleId: p.thumbnails.styleId, count: p.thumbnails.count, format: p.thumbnails.format, generated: p.thumbnails.items.length },
        publish: { titles: p.publish.titles.length, chapters: p.publish.chapters.length, tags: p.publish.tags.length },
        counts: {
          itemsPerTrack: counts,
          transcriptWords: words,
          transcribedSources: Object.keys(env.store.transcript.clips).length,
          openRequests: p.requests.filter((q) => q.status === 'queued' || q.status === 'in_progress').length,
          openNotes: p.notes.filter((n) => n.status === 'open').length
        }
      })
    }
  }),

  defineTool({
    name: 'get_inspiration_and_scope',
    description:
      "The owner's inspiration text (their vision: tone, pacing, jokes, moments to feature; may be empty, then do your best from the footage, " +
      'channel rules and brand kit) and the edit scope: "whole" video or "intro" only, with the intro maximum length (null = Auto: you judge ' +
      'where the intro ends), the intro end if already set, and whether the intro was approved.',
    input: {},
    run: (_args, env) => {
      const p = env.store.project
      const r = env.resolver()
      const introEnd = p.scope.introEnd ? { ...p.scope.introEnd, time: round3(r.anchorTime(p.scope.introEnd).time) } : null
      return json({
        inspiration: p.inspiration,
        scope: { ...p.scope, introEnd },
        thumbnailDirection: p.thumbnails.useMyDirection ? p.thumbnails.direction : '',
        videoTheme: p.videoTheme ? `${p.videoTheme.name} (call get_video_theme)` : null
      })
    }
  }),

  defineTool({
    name: 'get_video_theme',
    description:
      'The video theme the owner chose for this edit: the measured editing style of reference videos (cuts per minute overall, in the ' +
      'first 30 s and minute by minute, shot lengths, speech pace, loudness), the owner\'s notes on what to copy or skip, your earlier ' +
      'written summary of the style if there is one, and contact sheets of the reference shots (one frame per shot in the first minute, then ' +
      'frames spread over the rest). Edit to a similar pace and look; the channel rules, brand kit and the owner\'s inspiration come first. ' +
      'frames: true includes the contact sheets (default when there is no summary yet).',
    input: { frames: z.boolean().optional() },
    run: (args, env) => {
      const ref = env.store.project.videoTheme
      if (!ref) return json({ videoTheme: null, note: 'No video theme is chosen for this project.' })
      const t = env.ctx.themes.get(ref.id)
      if (!t) return json({ videoTheme: null, note: `The video theme "${ref.name}" was deleted in Settings. Edit without it.` })
      const info = {
        name: t.name,
        source: t.source,
        averages: t.averages,
        inWords: themeOneLine(t),
        ownerNotes: t.notes || null,
        yourSummary: t.summary ?? null,
        videos: t.videos.map((v) => ({
          title: v.title,
          url: v.url,
          analyzedSeconds: v.stats.analyzedSeconds,
          cutsPerMinute: v.stats.cutsPerMinute,
          cutsPerMinuteFirst30s: v.stats.cutsPerMinuteFirst30s,
          shotSeconds: v.stats.shotSeconds,
          paceByMinute: v.stats.pace.map((p) => p.cutsPerMinute),
          firstCutTimes: v.stats.cutTimes.slice(0, 40),
          speech: v.stats.speech ?? null,
          loudnessLufs: v.stats.loudnessLufs ?? null
        })),
        next: t.summary
          ? 'Follow your summary and the numbers. Ask for frames: true only if you need to look again.'
          : 'Study the contact sheets (captions, text and graphics, zoom punch-ins, B-roll share, framing, color, transitions), then call save_video_theme_summary once with a short description of the style so later stages can read it without the images.'
      }
      const withFrames = args.frames ?? !t.summary
      return withFrames ? images(themeSheets(env.ctx.themes.dir(t.id), t), info) : json(info)
    }
  }),

  defineTool({
    name: 'save_video_theme_summary',
    description:
      'Save your description of the chosen video theme\'s style (pace, cut style, hook, captions, graphics and text, zooms, B-roll, music ' +
      'and sound effects, color and look) in a few sentences. It is kept with the theme and shown to the owner in Settings, and later ' +
      'stages and videos read it instead of the contact sheets.',
    input: { summary: z.string().min(20).max(2000) },
    run: (args, env) => {
      const ref = env.store.project.videoTheme
      if (!ref || !env.ctx.themes.get(ref.id)) return json({ saved: false, note: 'No video theme is chosen for this project.' })
      env.ctx.themes.update(ref.id, { summary: args.summary })
      return json({ saved: true })
    }
  }),

  defineTool({
    name: 'get_transcript',
    description:
      'The saved transcript with word ids. Words come as rows [id, text, start, end, prob] in SOURCE seconds. ' +
      'Give source_id for one source, and start/end to limit to a source time range. ' +
      'With timeline: true you get the words as they are heard on the edited timeline instead: rows [id, text, timelineStart, timelineEnd, sourceId] ' +
      '(start/end then filter timeline time). Word ids are what you anchor items, chapters and the intro end to.',
    input: {
      source_id: z.string().optional(),
      start: z.number().min(0).optional(),
      end: z.number().min(0).optional(),
      timeline: z.boolean().optional()
    },
    run: (args, env) => {
      const t = env.store.transcript
      const from = args.start ?? 0
      const to = args.end ?? Number.POSITIVE_INFINITY
      if (args.timeline) {
        const words = env
          .resolver()
          .placedWords()
          .filter((w) => w.end >= from && w.start <= to && (!args.source_id || w.sourceId === args.source_id))
        return json({
          fields: ['id', 'text', 'timelineStart', 'timelineEnd', 'sourceId'],
          words: words.map((w) => [w.word.id, w.word.text, round3(w.start), round3(w.end), w.sourceId])
        })
      }
      if (args.source_id && !t.clips[args.source_id]) {
        sourceById(env.store.snapshotDoc(), args.source_id)
        return json({ sourceId: args.source_id, words: [], note: 'No transcript saved for this source yet.' })
      }
      const ids = args.source_id ? [args.source_id] : Object.keys(t.clips)
      return json({
        fields: ['id', 'text', 'start', 'end', 'prob'],
        updatedAt: t.updatedAt,
        sources: ids.map((id) => {
          const clip = t.clips[id]
          const words = clip.words.filter((w) => w.end >= from && w.start <= to)
          return {
            sourceId: id,
            language: clip.language,
            words: words.map((w) => [w.id, w.text, w.start, w.end, w.prob ?? null]),
            emphasis: words.filter((w) => w.emphasis).map((w) => w.id)
          }
        })
      })
    }
  }),

  defineTool({
    name: 'list_footage',
    description:
      'The footage and other sources of the project with probe info (kind, duration, size, fps, audio) and whether the file is missing, ' +
      'plus media files in the footage folder that are not sources yet (register them with add_source).',
    input: {},
    run: (_args, env) => {
      const p = env.store.project
      const known = new Set(p.sources.map((s) => s.path.toLowerCase()))
      const unregistered: string[] = []
      try {
        if (p.footageFolder && existsSync(p.footageFolder)) {
          for (const f of readdirSync(p.footageFolder)) {
            const full = join(p.footageFolder, f)
            if ((VIDEO_EXT.test(f) || AUDIO_EXT.test(f) || IMAGE_EXT.test(f)) && !known.has(full.toLowerCase())) unregistered.push(full)
          }
        }
      } catch {
        /* folder unreadable: only the registered sources are listed */
      }
      return json({
        footageFolder: p.footageFolder,
        sources: p.sources.map((s) => ({
          ...s,
          missing: !existsSync(s.path),
          transcribed: !!env.store.transcript.clips[s.id],
          ext: extname(s.path).toLowerCase()
        })),
        notYetSources: unregistered
      })
    }
  }),

  defineTool({
    name: 'add_source',
    description:
      'Register a media file (absolute path) as a project source so it can be cut on the A-roll, transcribed and placed by source_id. ' +
      'Footage stays where it is. Returns the source with its probe info. Files you produced yourself go through import_file instead.',
    input: {
      path: z.string().min(1),
      origin: z.enum(['footage', 'music', 'other']).optional()
    },
    run: async (args, env) => json(await ensureSource(env, args.path, args.origin ?? 'footage'))
  }),

  defineTool({
    name: 'get_profile',
    description:
      "The channel profile: channel notes (tone, pacing, always/never), the channel rules that are switched on, the standard editing rules, " +
      'the brand kit (fonts, colors, logo, intro/outro, caption style, sound signature), export preset, mix levels, description template ' +
      'and thumbnail defaults. Read this before deciding anything, and before making any graphic.',
    input: {},
    run: (_args, env) => {
      const p = env.store.project
      const profile = env.ctx.profiles.get(p.profileId)
      return json({
        profile: profile ? { id: profile.id, name: profile.name } : { id: p.profileId, name: '(profile not found)' },
        channelNotes: profile?.channelNotes ?? '',
        channelRules: (profile?.rules ?? []).filter((r) => r.enabled).map((r) => ({ id: r.id, text: r.text, source: r.source })),
        editingRules: profile?.editingRules?.trim() ? profile.editingRules : DEFAULT_EDITING_RULES,
        brandKit: p.settings.brandKit,
        exportPreset: p.settings.exportPreset,
        mix: p.settings.mix,
        captionExport: p.settings.captionExport,
        descriptionTemplate: p.settings.descriptionTemplate,
        thumbnailDefaults: {
          personaId: p.thumbnails.personaId,
          styleId: p.thumbnails.styleId,
          count: p.thumbnails.count,
          direction: p.thumbnails.direction,
          format: p.thumbnails.format
        }
      })
    }
  }),

  defineTool({
    name: 'search_library',
    description:
      'Search the asset library (graphics, sounds, effects, music, clips saved from earlier videos) for this channel and the shared section. ' +
      'ALWAYS search before making a graphic or sound. Results come preferred-first with name, description, when to use, tags, inputs ' +
      '(parameters such as text, colors, length), use count, and the path of a preview image you can Read. Place one with place_library_asset. ' +
      'An empty query lists everything.',
    input: {
      query: z.string().default(''),
      type: z.enum(['graphic', 'sound', 'effect', 'music', 'clip']).optional()
    },
    run: (args, env) => {
      if (!env.ctx.library.root()) return json({ assets: [], note: 'No asset library folder is set in Settings yet.' })
      const list = env.ctx.library.search(args.query, { profileId: env.store.project.profileId, type: args.type })
      return json({
        assets: list.map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          description: a.description,
          whenToUse: a.whenToUse,
          tags: a.tags,
          scope: a.scope,
          inputs: a.inputs,
          preferred: a.preferred,
          uses: a.uses,
          preview: a.preview && a.dir ? join(a.dir, a.preview) : null,
          file: a.dir ? join(a.dir, a.file) : a.file
        }))
      })
    }
  }),

  defineTool({
    name: 'get_engine_info',
    description:
      "Paths of the app's managed Python environment (with faster-whisper, PyTorch CUDA, NumPy, SciPy, Pillow, OpenCV), ffmpeg/ffprobe " +
      '(NVIDIA encoder) and the render engine folder. Use this Python to transcribe with faster-whisper on the GPU and to run your own ' +
      'scripts in the same environment the renderer uses. Put scratch files in the project cache folder.',
    input: {},
    needsProject: false,
    run: (_args, env) => {
      const engineVersion = env.store?.project.engineVersion ?? ENGINE_VERSION
      const safe = (f: () => string) => {
        try {
          return f()
        } catch (err) {
          return `(unavailable: ${err instanceof Error ? err.message : String(err)})`
        }
      }
      return json({
        python: safe(() => env.ctx.env.python()),
        ffmpeg: safe(() => env.ctx.env.ffmpeg()),
        ffprobe: safe(() => env.ctx.env.ffprobe()),
        engineDir: safe(() => env.ctx.env.engineDir(engineVersion)),
        engineVersion,
        engineModule: 'ave_engine (run with: <python> -m ave_engine --help, with the engine dir as the working directory or on PYTHONPATH)',
        projectFormatVersion: PROJECT_FORMAT_VERSION,
        projectDir: env.store ? env.dir : null,
        scratchDir: env.store ? join(env.dir, 'cache', 'claude') : null
      })
    }
  })
]

