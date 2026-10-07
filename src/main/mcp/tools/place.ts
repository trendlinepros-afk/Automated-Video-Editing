/** Place tools: add, change, move and remove items on any track, and bring in files Claude made its own way. */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { EFFECT_KINDS, type AnchoredItem, type Item, type ProjectDoc } from '@shared/project'
import { newId } from '../../project/store'
import { changeVerb, itemName } from '@shared/describe'
import {
  AUDIO_EXT,
  DEFAULT_TRACK_FOR,
  ToolError,
  absInProject,
  anchorInput,
  defineTool,
  describeItem,
  ensureSource,
  fileExists,
  findTrack,
  itemById,
  json,
  keyframesInput,
  projectRelative,
  slug,
  sourceById,
  toAnchor,
  transformInput,
  type ToolEnv
} from './common'

const num = z.number().finite()

/** Fields shared by add_item and update_item (snake_case for Claude, camelCase in the project). */
const itemFields = {
  label: z.string().optional(),
  source_id: z.string().optional().describe('Clip/audio: a project source id'),
  file: z
    .string()
    .optional()
    .describe('Graphic: graphics/<name>.py. Clip/audio/custom effect: a project file path (media/..., audio/...) or an absolute path; files outside the project are added as sources.'),
  in: num.min(0).optional().describe('Clip/audio: source seconds to start from'),
  speed: num.positive().optional(),
  volume: num.optional().describe('dB. B-roll is muted (-120) by default.'),
  fade_in: num.min(0).optional(),
  fade_out: num.min(0).optional(),
  transform: transformInput.optional(),
  keyframes: keyframesInput.optional(),
  params: z.record(z.string(), z.unknown()).optional().describe('Graphic/effect parameters (text, colors, strength...)'),
  effect: z.enum(EFFECT_KINDS).optional(),
  duck: z.boolean().optional().describe('Music: lower under speech by the mix setting'),
  loop: z.boolean().optional()
}

type FieldArgs = { [K in keyof typeof itemFields]?: z.output<(typeof itemFields)[K]> }

const CAMEL: Record<string, string> = { fade_in: 'fadeIn', fade_out: 'fadeOut', source_id: 'sourceId' }

/** Resolve a clip/audio media reference: a source id, a project file, or an outside file that becomes a source. */
async function mediaRef(env: ToolEnv, a: FieldArgs, origin: 'other' | 'music'): Promise<{ sourceId?: string; file?: string }> {
  if (a.source_id) {
    sourceById(env.store.snapshotDoc(), a.source_id)
    return { sourceId: a.source_id }
  }
  if (!a.file) return {}
  const rel = projectRelative(env.dir, a.file)
  if (rel) {
    if (!fileExists(absInProject(env.dir, rel))) throw new ToolError(`File not found in the project: ${rel}`)
    return { file: rel }
  }
  if (!isAbsolute(a.file)) throw new ToolError(`"${a.file}" is neither a project path nor an absolute path.`)
  const src = await ensureSource(env, a.file, origin)
  return { sourceId: src.id }
}

function checkGraphicFile(env: ToolEnv, file: string): string {
  const rel = projectRelative(env.dir, file)
  if (!rel || !rel.startsWith('graphics/')) throw new ToolError('A graphic file must be inside the project graphics/ folder (write it with write_graphic).')
  if (!fileExists(absInProject(env.dir, rel))) throw new ToolError(`Graphic file not found: ${rel}. Write it first with write_graphic.`)
  return rel
}

function checkProjectFile(env: ToolEnv, file: string): string {
  const rel = projectRelative(env.dir, file)
  if (!rel || !fileExists(absInProject(env.dir, rel))) throw new ToolError(`File not found in the project: ${file}`)
  return rel
}

/** Copy plain fields onto an item. */
function applyFields(item: Record<string, unknown>, a: FieldArgs): void {
  for (const key of ['label', 'in', 'speed', 'volume', 'fade_in', 'fade_out', 'transform', 'keyframes', 'params', 'effect', 'duck', 'loop'] as const) {
    if (a[key] !== undefined) item[CAMEL[key] ?? key] = a[key]
  }
}

function itemView(env: ToolEnv, id: string): Record<string, unknown> {
  return describeItem(env.resolver(), itemById(env.store.snapshotDoc(), id))
}

function addResult(env: ToolEnv, id: string) {
  return json({ item: itemView(env, id) })
}

export async function addItem(
  env: ToolEnv,
  type: AnchoredItem['type'],
  a: FieldArgs & { track?: string; anchor: z.infer<typeof anchorInput>; duration: number },
  extra: Record<string, unknown> = {}
): Promise<string> {
  const doc: ProjectDoc = env.store.snapshotDoc()
  const track = findTrack(doc, a.track ?? DEFAULT_TRACK_FOR[type])
  const anchor = toAnchor(a.anchor, doc)
  const id = newId(type === 'clip' ? 'clip' : type === 'graphic' ? 'gfx' : type === 'effect' ? 'fx' : 'aud')
  const item: Record<string, unknown> = { id, trackId: track.id, type, createdBy: 'claude', anchor, duration: a.duration, ...extra }
  if (type === 'graphic') {
    if (!a.file) throw new ToolError('A graphic needs file: graphics/<name>.py')
    item.file = checkGraphicFile(env, a.file)
    item.params = {}
  } else if (type === 'effect') {
    const effect = a.effect
    if (!effect) throw new ToolError(`An effect needs effect: one of ${EFFECT_KINDS.join(', ')}`)
    if (effect === 'custom' && !a.file) throw new ToolError('A custom effect needs file: a Python file in the project with apply(frame, t, ctx).')
    if (a.file) item.file = checkProjectFile(env, a.file)
    item.params = {}
  } else {
    const ref = await mediaRef(env, a, track.kind === 'music' ? 'music' : 'other')
    if (!ref.sourceId && !ref.file) throw new ToolError(`A ${type} needs a source_id or a file.`)
    Object.assign(item, ref)
  }
  applyFields(item, { ...a, file: undefined, source_id: undefined })
  env.mutate(`Add ${itemName(env.store.project, item as Item)} on ${track.name}`, (d) => {
    d.project.items.push(item as Item)
  })
  return id
}

export const placeTools = [
  defineTool({
    name: 'add_item',
    description:
      'Place an item on a track. type: clip (B-roll footage, a still, or a file you processed), graphic (graphics/<name>.py), effect ' +
      `(${EFFECT_KINDS.join(', ')}), audio (sound effect, music, generated audio). Anchor it to a transcript word ({word_id, offset}) so it moves ` +
      'with the words when cuts change; use {time} only for things tied to the timeline itself. duration in seconds. track: a track id or kind ' +
      '(default: clip→broll, graphic→graphics, effect→effects, audio→sfx; use "music" for music). Clip/audio media: source_id, a project file ' +
      'path, or an absolute path (added as a source). Returns the item with its resolved start/end.',
    input: {
      type: z.enum(['clip', 'graphic', 'effect', 'audio']),
      track: z.string().optional(),
      anchor: anchorInput,
      duration: num.positive(),
      ...itemFields
    },
    run: async (args, env) => addResult(env, await addItem(env, args.type, args))
  }),

  defineTool({
    name: 'update_item',
    description:
      'Change fields of an existing item (any field you pass replaces the stored one): label, source_id or file (swap the media), in, speed, ' +
      'volume, fades, transform, keyframes, params, effect, duck, loop, duration, anchor, track. `fields` sets any other stored field as is. ' +
      'For A-roll cut edges use adjust_cut or set_aroll_cuts.',
    input: {
      id: z.string(),
      anchor: anchorInput.optional(),
      duration: num.positive().optional(),
      track: z.string().optional(),
      fields: z.record(z.string(), z.unknown()).optional(),
      ...itemFields
    },
    run: async (args, env) => {
      const doc = env.store.snapshotDoc()
      const current = itemById(doc, args.id)
      const patch: Record<string, unknown> = {}
      if (args.anchor) {
        if (current.type === 'segment') throw new ToolError('A-roll segments have no anchor; their place comes from the cut order.')
        patch.anchor = toAnchor(args.anchor, doc)
      }
      if (args.duration !== undefined) {
        if (current.type === 'segment') throw new ToolError('Change a segment length with adjust_cut.')
        patch.duration = args.duration
      }
      if (args.track) patch.trackId = findTrack(doc, args.track).id
      if (args.file || args.source_id) {
        if (current.type === 'graphic') patch.file = checkGraphicFile(env, args.file ?? '')
        else if (current.type === 'effect') patch.file = checkProjectFile(env, args.file ?? '')
        else if (current.type === 'segment') {
          if (!args.source_id) throw new ToolError('A segment takes a source_id, not a file.')
          sourceById(doc, args.source_id)
          patch.sourceId = args.source_id
        } else {
          const ref = await mediaRef(env, args, current.trackId === 'music' ? 'music' : 'other')
          patch.sourceId = ref.sourceId
          patch.file = ref.file
        }
      }
      applyFields(patch, { ...args, file: undefined, source_id: undefined })
      Object.assign(patch, args.fields ?? {})
      if (patch.id !== undefined && patch.id !== args.id) throw new ToolError('An item id never changes.')
      env.mutate(`${changeVerb(Object.keys(patch), patch)} ${itemName(doc.project, current)}`, (d) => {
        const item = d.project.items.find((i) => i.id === args.id) as unknown as Record<string, unknown>
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) delete item[k]
          else item[k] = v
        }
      })
      return addResult(env, args.id)
    }
  }),

  defineTool({
    name: 'set_item_picture',
    description:
      'Show a processed copy of a clip\'s picture (e.g. a stabilized version you rendered) in place of its original frames, on an A-roll ' +
      'segment or a B-roll clip. Timing, cuts, transcript and sound stay on the original. `file` is a video you made: a project path ' +
      '(media/...) or an absolute path (copied to media/processed/). `source_start` is the original source time at the file\'s first ' +
      'frame, so the file must cover the item\'s source range at the same frame rate. Pass remove: true to go back to the original picture.',
    input: {
      id: z.string(),
      file: z.string().optional(),
      source_start: num.min(0).optional().describe('Source seconds at the first frame of the file'),
      kind: z.enum(['stabilized', 'other']).optional().describe('What was done, shown to the owner (default other)'),
      note: z.string().optional().describe('One line on what you did, e.g. "vidstab smoothing 20, 4% zoom"'),
      remove: z.boolean().optional()
    },
    run: async (args, env) => {
      const doc = env.store.snapshotDoc()
      const item = itemById(doc, args.id)
      if (item.type !== 'segment' && item.type !== 'clip') throw new ToolError('Only A-roll segments and B-roll clips have a picture to replace.')
      if (args.remove) {
        env.mutate(`Remove stabilization from ${itemName(doc.project, item)}`, (d) => {
          delete (d.project.items.find((i) => i.id === args.id) as Record<string, unknown>).picture
        })
        return addResult(env, args.id)
      }
      if (!args.file || args.source_start === undefined) throw new ToolError('Pass file and source_start (or remove: true).')
      let rel = projectRelative(env.dir, args.file)
      if (!rel) {
        if (!isAbsolute(args.file) || !fileExists(args.file)) throw new ToolError(`File not found: ${args.file}`)
        const destDir = join(env.dir, 'media', 'processed')
        mkdirSync(destDir, { recursive: true })
        const ext = extname(args.file).toLowerCase()
        let name = `${slug(basename(args.file, ext))}${ext}`
        for (let n = 2; existsSync(join(destDir, name)); n++) name = `${slug(basename(args.file, ext))}_${n}${ext}`
        copyFileSync(args.file, join(destDir, name))
        rel = `media/processed/${name}`
      }
      const abs = absInProject(env.dir, rel)
      if (!fileExists(abs)) throw new ToolError(`File not found in the project: ${args.file}`)
      let info: Awaited<ReturnType<ToolEnv['ctx']['engine']['probe']>>
      try {
        info = await env.ctx.engine.probe(abs)
      } catch (err) {
        throw new ToolError(`Could not read ${basename(abs)}: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (info.kind !== 'video') throw new ToolError(`${basename(abs)} is not a video.`)
      // The source range the item shows, in the file's own time.
      const from = item.in - args.source_start
      const length = item.type === 'segment' ? (item.hold ? 0 : item.out - item.in) : item.duration * (item.speed ?? 1)
      if (from < -0.01) throw new ToolError(`The file starts at source ${args.source_start.toFixed(3)} s, after the item's in point (${item.in.toFixed(3)} s).`)
      if (from + length > info.duration + 0.05)
        throw new ToolError(`The file is ${info.duration.toFixed(3)} s long but the item needs file time ${from.toFixed(3)}–${(from + length).toFixed(3)} s.`)
      const src = item.sourceId ? doc.project.sources.find((x) => x.id === item.sourceId) : undefined
      const warnings: string[] = []
      if (src?.fps && info.fps && Math.abs(src.fps - info.fps) > 0.05) warnings.push(`Frame rate ${info.fps} differs from the source's ${src.fps}; frames will not line up with the sound.`)
      const picture = { file: rel, sourceStart: args.source_start, kind: args.kind ?? 'other', ...(args.note ? { note: args.note } : {}) }
      env.mutate(`${picture.kind === 'stabilized' ? 'Stabilize' : 'Process the picture of'} ${itemName(doc.project, item)}`, (d) => {
        ;(d.project.items.find((i) => i.id === args.id) as Record<string, unknown>).picture = picture
      })
      return warnings.length ? json({ item: itemView(env, args.id), warnings }) : addResult(env, args.id)
    }
  }),

  defineTool({
    name: 'move_item',
    description: 'Move an item to a new anchor (a word plus offset, or a time) and optionally to another track. A-roll segments move with set_aroll_cuts.',
    input: { id: z.string(), anchor: anchorInput, track: z.string().optional() },
    run: (args, env) => {
      const doc = env.store.snapshotDoc()
      const current = itemById(doc, args.id)
      if (current.type === 'segment') throw new ToolError('A-roll segments play in cut order; reorder them with set_aroll_cuts.')
      const anchor = toAnchor(args.anchor, doc)
      const trackId = args.track ? findTrack(doc, args.track).id : current.trackId
      env.mutate(`Move ${itemName(env.store.project, current)}`, (d) => {
        const item = d.project.items.find((i) => i.id === args.id) as AnchoredItem
        item.anchor = anchor
        item.trackId = trackId
      })
      return addResult(env, args.id)
    }
  }),

  defineTool({
    name: 'remove_item',
    description: 'Remove an item from the timeline (any track, including an A-roll segment). Undo in the app brings it back.',
    input: { id: z.string() },
    run: (args, env) => {
      const item = itemById(env.store.snapshotDoc(), args.id)
      env.mutate(`Delete ${itemName(env.store.project, item)}`, (d) => {
        d.project.items = d.project.items.filter((i) => i.id !== args.id)
      })
      return json({ removed: args.id })
    }
  }),

  defineTool({
    name: 'import_file',
    description:
      'Copy a file you produced your own way into the project, so anything you can make with your own scripts can go on the timeline: ' +
      'processed footage, a rendered animation, composed music, synthesized sound effects, a still. Video and images go to media/, audio to ' +
      'audio/, Python graphics to graphics/. Returns the project path, and a source_id for media (usable on the A-roll with set_aroll_cuts ' +
      'or as B-roll with add_item).',
    input: {
      path: z.string().describe('Absolute path of the file to copy'),
      name: z.string().optional().describe('File name to use in the project (extension kept from the original)'),
      folder: z.enum(['media', 'audio', 'graphics']).optional()
    },
    run: async (args, env) => {
      if (!isAbsolute(args.path) || !fileExists(args.path)) throw new ToolError(`File not found: ${args.path}`)
      const ext = extname(args.path).toLowerCase()
      const folder = args.folder ?? (ext === '.py' ? 'graphics' : AUDIO_EXT.test(ext) ? 'audio' : 'media')
      const destDir = join(env.dir, folder)
      mkdirSync(destDir, { recursive: true })
      const base = slug(args.name ? args.name.replace(/\.[a-z0-9]+$/i, '') : basename(args.path, ext))
      let name = `${base}${ext}`
      for (let n = 2; existsSync(join(destDir, name)); n++) name = `${base}_${n}${ext}`
      const dest = join(destDir, name)
      copyFileSync(args.path, dest)
      const rel = `${folder}/${name}`
      env.store.log.write('mcp', `Imported ${basename(args.path)} as ${rel}`)
      let sourceId: string | undefined
      if (folder !== 'graphics') {
        try {
          sourceId = (await ensureSource(env, dest, 'other')).id
        } catch (err) {
          return json({ path: rel, absolutePath: dest, note: `Copied, but it could not be read as media: ${err instanceof Error ? err.message : String(err)}` })
        }
      }
      return json({ path: rel, absolutePath: dest, ...(sourceId ? { sourceId } : {}) })
    }
  }),

  defineTool({
    name: 'add_music_track',
    description:
      "Place a track from the owner's music library (see list_music / search_music) on the Music track. Adds it as a music source. " +
      'Default: starts at timeline 0, plays to its end, ducks under speech (duck: true) by the profile mix setting. ' +
      'For music you composed yourself, use import_file and add_item instead.',
    input: {
      path: z.string(),
      anchor: anchorInput.optional(),
      duration: num.positive().optional(),
      in: num.min(0).optional(),
      volume: num.optional(),
      duck: z.boolean().optional(),
      fade_in: num.min(0).optional(),
      fade_out: num.min(0).optional(),
      loop: z.boolean().optional(),
      track: z.string().optional(),
      label: z.string().optional()
    },
    run: async (args, env) => {
      const lib = env.ctx.music.list(env.store.project.profileId)
      const hit = lib.find((t) => t.path.toLowerCase() === args.path.toLowerCase())
      if (!hit) throw new ToolError("That file is not in this channel's music folders. Use search_music to find tracks, or import_file for your own music.")
      if (hit.missing) throw new ToolError(`The music file is missing on disk: ${hit.path}`)
      const src = await ensureSource(env, hit.path, 'music')
      const duration = args.duration ?? Math.max(0.1, (src.duration || hit.duration) - (args.in ?? 0))
      const id = await addItem(env, 'audio', {
        track: args.track ?? 'music',
        anchor: args.anchor ?? { time: 0 },
        duration,
        source_id: src.id,
        in: args.in,
        volume: args.volume,
        duck: args.duck ?? true,
        fade_in: args.fade_in,
        fade_out: args.fade_out,
        loop: args.loop,
        label: args.label ?? hit.name
      })
      return json({ item: itemView(env, id), mood: hit.folder })
    }
  })
]
