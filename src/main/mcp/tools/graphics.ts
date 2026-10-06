/** Graphics tools: free-form motion graphics as Python files, previews, and the asset library. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type { AnchoredItem, Range } from '@shared/project'
import { rangeContains } from '@shared/timeline'
import { addItem } from './place'
import {
  ToolError,
  absInProject,
  anchorInput,
  defineTool,
  describeItem,
  fileExists,
  images,
  itemById,
  json,
  projectRelative,
  sourceById,
  transformInput,
  type ToolEnv
} from './common'

const num = z.number().finite()

export const GRAPHIC_CONTRACT = `A graphic file is a self-contained Python module with:

    def render(t, ctx):
        ...

- t: seconds since the graphic appeared (0 .. ctx.duration).
- ctx.width, ctx.height: the frame size in pixels (preview and export differ, so compute every size and
  position as a fraction of these, never in fixed pixels).
- ctx.duration: how long the item is on screen; ctx.fps.
- ctx.params: the item's params (text, colors, numbers...).
- ctx.brand: the channel brand kit (colors.primary / secondary / accent, fonts, captionStyle...).
- ctx.font(size_px, bold=False): a PIL ImageFont from the brand kit (or the engine's default font).
- Return an RGBA PIL Image, or a HxWx4 uint8 NumPy array, of exactly ctx.width x ctx.height. Transparent
  where nothing is drawn. Return None for a fully transparent frame.
- Optional module-level META = {"description": "...", "inputs": {"text": {"type": "string", "default": "..."}}}
  describes the graphic and its parameters for the asset library.
- Pillow, NumPy, SciPy and OpenCV are available. Keep it deterministic: the same t gives the same image.`

function lockedRangeCheck(env: ToolEnv, rel: string): void {
  const lock = env.store.project.lock
  if (!lock) return
  const r = env.resolver()
  const outside = env.store.project.items.filter((i) => {
    if (i.type === 'segment' || (i as AnchoredItem & { file?: string }).file !== rel) return false
    const span = r.resolveItem(i)
    return !rangeContains(lock.range as Range, span.start, span.end)
  })
  if (outside.length) {
    throw new ToolError(
      `Change rejected: ${rel} is also used outside the section being re-edited (${outside.map((i) => i.id).join(', ')}). ` +
        'Write a new graphic file under another name instead.'
    )
  }
}

export const graphicsTools = [
  defineTool({
    name: 'write_graphic',
    description:
      'Write or replace a motion graphic code file: graphics/<name>.py. Then preview it with preview_graphic and place it with add_item ' +
      `(type "graphic", file "graphics/<name>.py"). Draw in the channel brand kit (get_profile).\n\n${GRAPHIC_CONTRACT}`,
    input: {
      name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'letters, digits, _ and - only').describe('File name without .py'),
      code: z.string().min(1)
    },
    run: (args, env) => {
      const rel = `graphics/${args.name}.py`
      lockedRangeCheck(env, rel)
      const dir = join(env.dir, 'graphics')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${args.name}.py`)
      const replaced = existsSync(file)
      writeFileSync(file, args.code.endsWith('\n') ? args.code : args.code + '\n')
      const usedBy = env.store.project.items.filter((i) => (i as { file?: string }).file === rel).map((i) => i.id)
      env.store.log.write('mcp', `${replaced ? 'Replaced' : 'Wrote'} graphic ${rel}`, { lines: args.code.split('\n').length, usedBy })
      if (usedBy.length) {
        try {
          env.ctx.preview.invalidate()
        } catch {
          /* the preview catches up on the next change */
        }
      }
      return json({ file: rel, replaced, usedBy })
    }
  }),

  defineTool({
    name: 'preview_graphic',
    description:
      'Render a graphic file at a few moments, as frames of the project size scaled to `width`, over a neutral background. ' +
      'Use it to review a graphic like a gallery before placing it. times are seconds from when it appears (default: start, middle, near the end).',
    input: {
      file: z.string().describe('graphics/<name>.py'),
      params: z.record(z.string(), z.unknown()).default({}),
      duration: num.positive().default(3),
      times: z.array(num.min(0)).max(12).optional(),
      width: z.number().int().min(64).max(3840).default(960)
    },
    run: async (args, env) => {
      const rel = projectRelative(env.dir, args.file)
      if (!rel || !fileExists(absInProject(env.dir, rel))) throw new ToolError(`Graphic file not found: ${args.file}`)
      const out = env.store.project.output
      const height = Math.round((args.width * out.height) / out.width / 2) * 2
      const times = args.times?.length ? args.times : [0, args.duration / 2, Math.max(0, args.duration - 0.1)]
      const outDir = join(env.dir, 'cache', 'graphic_previews', `${basename(rel, '.py')}_${Date.now().toString(36)}`)
      mkdirSync(outDir, { recursive: true })
      const files = await env.ctx.engine.graphicPreview(env.dir, rel, {
        params: args.params,
        duration: args.duration,
        times,
        width: args.width,
        height,
        brand: env.store.project.settings.brandKit,
        outDir
      })
      return images(files.map((path, i) => ({ label: `${rel} at t=${times[i]}s`, path })))
    }
  }),

  defineTool({
    name: 'save_to_library',
    description:
      'Save something reusable you built (a like-and-subscribe animation, a lower third, a transition, a sound) to the asset library, so later ' +
      'videos reuse it instead of generating it again. Give item_id (an item on the timeline) or file (a project path). Describe what it is, ' +
      'when to use it, tags, and its inputs (parameters such as text, colors, length) so it works for any text without being rebuilt. ' +
      'scope "shared" = every channel, "channel" = this channel only.',
    input: {
      item_id: z.string().optional(),
      file: z.string().optional(),
      name: z.string().min(1).max(80),
      description: z.string(),
      when_to_use: z.string(),
      tags: z.array(z.string()).default([]),
      scope: z.enum(['shared', 'channel']).default('channel'),
      type: z.enum(['graphic', 'sound', 'effect', 'music', 'clip']).optional(),
      inputs: z.record(z.string(), z.object({ type: z.string(), default: z.unknown().optional(), description: z.string().optional() })).default({})
    },
    run: async (args, env) => {
      if (!env.ctx.library.root()) throw new ToolError('No asset library folder is set. The owner chooses it in Settings.')
      const doc = env.store.snapshotDoc()
      let path: string
      let type = args.type
      if (args.item_id) {
        const item = itemById(doc, args.item_id)
        const f = (item as { file?: string }).file
        const sid = (item as { sourceId?: string }).sourceId
        if (f) path = absInProject(env.dir, f)
        else if (sid) path = sourceById(doc, sid).path
        else throw new ToolError('That item has no file to save.')
        type ??= item.type === 'graphic' ? 'graphic' : item.type === 'effect' ? 'effect' : item.type === 'clip' ? 'clip' : env.store.project.tracks.find((t) => t.id === item.trackId)?.kind === 'music' ? 'music' : 'sound'
      } else if (args.file) {
        const rel = projectRelative(env.dir, args.file)
        path = rel ? absInProject(env.dir, rel) : args.file
        type ??= /\.py$/i.test(path) ? 'graphic' : /\.(wav|mp3|flac|ogg|m4a|aac)$/i.test(path) ? 'sound' : 'clip'
      } else {
        throw new ToolError('Give item_id or file.')
      }
      if (!fileExists(path)) throw new ToolError(`File not found: ${path}`)
      const asset = await env.ctx.library.saveFromFile({
        file: path,
        type,
        name: args.name,
        description: args.description,
        whenToUse: args.when_to_use,
        tags: args.tags,
        scope: args.scope === 'shared' ? 'shared' : env.store.project.profileId,
        inputs: args.inputs
      })
      return json({ saved: { id: asset.id, name: asset.name, type: asset.type, scope: asset.scope, preview: asset.preview && asset.dir ? join(asset.dir, asset.preview) : null } })
    }
  }),

  defineTool({
    name: 'place_library_asset',
    description:
      'Place an asset from the library: it is copied into the project (so later library edits never change this video) and added as an ' +
      'item with your params (inputs not given use their defaults). Anchor it to a word like any item.',
    input: {
      asset_id: z.string(),
      anchor: anchorInput,
      duration: num.positive(),
      params: z.record(z.string(), z.unknown()).default({}),
      track: z.string().optional(),
      transform: transformInput.optional(),
      volume: num.optional(),
      label: z.string().optional()
    },
    run: async (args, env) => {
      const asset = env.ctx.library.get(args.asset_id)
      if (!asset) throw new ToolError(`No library asset "${args.asset_id}". Use search_library.`)
      const rel = env.ctx.library.copyIntoProject(asset.id, env.dir)
      const defaults: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(asset.inputs ?? {})) if (v.default !== undefined) defaults[k] = v.default
      const params = { ...defaults, ...args.params }
      const common = { anchor: args.anchor, duration: args.duration, track: args.track, transform: args.transform, label: args.label ?? asset.name, volume: args.volume }
      let id: string
      if (asset.type === 'graphic') id = await addItem(env, 'graphic', { ...common, file: rel, params }, { libraryAssetId: asset.id })
      else if (asset.type === 'effect') id = await addItem(env, 'effect', { ...common, effect: 'custom', file: rel, params }, { libraryAssetId: asset.id })
      else if (asset.type === 'clip') id = await addItem(env, 'clip', { ...common, file: rel }, { libraryAssetId: asset.id })
      else id = await addItem(env, 'audio', { ...common, file: rel, track: args.track ?? (asset.type === 'music' ? 'music' : 'sfx'), ...(asset.type === 'music' ? { duck: true } : {}) }, { libraryAssetId: asset.id })
      return json({ copiedTo: rel, item: describeItem(env.resolver(), itemById(env.store.snapshotDoc(), id)) })
    }
  })
]
