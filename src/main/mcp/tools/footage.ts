/**
 * Footage index tools: the shots of every video source, measured once by the app (services/footageIndex.ts), so
 * Claude can choose B-roll and moments from a list and a contact sheet instead of rendering frame after frame.
 */
import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type { Source } from '@shared/project'
import { formatTime } from '@shared/timeline'
import {
  findShots,
  lookWords,
  parseShotId,
  shotId,
  shotLook,
  shotUses,
  type FootageIndexEntry,
  type FootageIndexStatus,
  type IndexedShot
} from '../../services/footageIndex'
import { ToolError, defineTool, images, json, sourceById, type ToolEnv } from './common'

const SHEET_MAX = 12
const t1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1)

function indexingText(st: FootageIndexStatus): string | undefined {
  const parts: string[] = []
  if (st.running || st.done < st.total) {
    parts.push(`Indexing: ${st.done} of ${st.total} video files done` + (st.current ? `, now ${st.current.name} (${st.current.percent}%)` : ''))
  }
  if (st.failed.length) parts.push(`Could not index: ${st.failed.map((f) => `${f.name} (${f.error})`).join('; ')}`)
  return parts.length ? parts.join('. ') : undefined
}

function indexed(env: ToolEnv): { source: Source; entry: FootageIndexEntry }[] {
  const out: { source: Source; entry: FootageIndexEntry }[] = []
  for (const source of env.store.project.sources) {
    if (source.kind !== 'video') continue
    const entry = env.ctx.footage.get(source.id)
    if (entry) out.push({ source, entry })
  }
  return out
}

function sourceState(env: ToolEnv, source: Source, st: FootageIndexStatus): string {
  if (env.ctx.footage.get(source.id)) return 'indexed'
  if (st.current?.sourceId === source.id) return `indexing (${st.current.percent}%)`
  const failed = st.failed.find((f) => f.sourceId === source.id)
  if (failed) return `failed: ${failed.error}`
  return env.ctx.projects.missingSources().includes(source.id) ? 'file not found' : 'waiting'
}

/** One compact line per shot: number, source times, best still, look, colours, where it is on the timeline. */
function shotLine(env: ToolEnv, source: Source, e: FootageIndexEntry, s: IndexedShot): string {
  const uses = shotUses(env.resolver(), source.id, s.start, s.end)
  const tl = uses.length ? ` | on timeline ${uses.map((u) => `${t1(u.start)}-${t1(u.end)} ${u.as}`).join(', ')}` : ''
  return `#${s.index} ${t1(s.start)}-${t1(s.end)} (${t1(s.end - s.start)}s) best ${s.best} | ${lookWords(shotLook(s, e.index.facesChecked))} | ${s.colors.join(' ')}${tl}`
}

/** The loudest seconds of a file, at least 3 s apart: crashes, jumps, engine revs. */
function loudest(e: FootageIndexEntry, n = 6): { time: number; db: number }[] {
  const db = e.index.audio?.db ?? []
  const order = db.map((v, i) => ({ time: i, db: v })).sort((a, b) => b.db - a.db)
  const picked: { time: number; db: number }[] = []
  for (const x of order) {
    if (picked.length >= n || x.db < -50) break
    if (picked.every((p) => Math.abs(p.time - x.time) >= 3)) picked.push(x)
  }
  return picked.sort((a, b) => a.time - b.time)
}

export const footageTools = [
  defineTool({
    name: 'get_footage_index',
    description:
      'The footage index the app builds on its own for every video file: its shots (split at cuts, view changes and every 10 s at most) ' +
      'with how each looks (sharp/ok/soft/flat, steady/moving/shaky camera, calm/some/action, dark/bright, faces, loud), main colours, the ' +
      'best still (source seconds) and where the shot is already on the timeline. Without source_id: a summary per file. With source_id: ' +
      'its shots, one line each ("#n start-end (length) best t | look | colours | on timeline ..."). Times are source seconds.',
    input: {
      source_id: z.string().optional(),
      offset: z.number().int().min(0).default(0).describe('First shot to list (with source_id), for long files.'),
      limit: z.number().int().min(1).max(200).default(80)
    },
    run: (args, env) => {
      const st = env.ctx.footage.status()
      const indexing = indexingText(st)
      if (args.source_id) {
        const source = sourceById(env.store.snapshotDoc(), args.source_id)
        if (source.kind !== 'video') throw new ToolError(`${basename(source.path)} is not a video; only video files are indexed.`)
        const e = env.ctx.footage.get(source.id)
        if (!e) return json({ source_id: source.id, file: basename(source.path), status: sourceState(env, source, st), ...(indexing ? { indexing } : {}) })
        const shots = e.index.shots.slice(args.offset, args.offset + args.limit)
        const next = args.offset + shots.length
        return json({
          source_id: source.id,
          file: basename(source.path),
          duration: e.index.duration,
          faces_checked: e.index.facesChecked,
          shots: shots.map((s) => shotLine(env, source, e, s)),
          ...(next < e.index.shots.length ? { more: `${e.index.shots.length - next} more shots: offset ${next}` } : {}),
          loudest_seconds: loudest(e),
          shot_ids: `use "${shotId(source.id, 1)}" style ids (source id # shot number) with get_shot_sheet`
        })
      }
      const sources = env.store.project.sources
        .filter((x) => x.kind === 'video')
        .map((source) => {
          const e = env.ctx.footage.get(source.id)
          if (!e) return { source_id: source.id, file: basename(source.path), status: sourceState(env, source, st) }
          const looks = e.index.shots.map((s) => shotLook(s, e.index.facesChecked))
          const count = (f: (l: (typeof looks)[number]) => boolean) => looks.filter(f).length
          const r = env.resolver()
          return {
            source_id: source.id,
            file: basename(source.path),
            status: 'indexed',
            duration: e.index.duration,
            shots: e.index.shots.length,
            sharp: count((l) => l.detail === 'sharp'),
            steady: count((l) => l.camera === 'steady'),
            shaky: count((l) => l.camera === 'shaky'),
            action: count((l) => l.motion === 'action'),
            with_faces: e.index.facesChecked ? count((l) => l.faces === 'face' || l.faces === 'close') : 'not checked',
            dark: count((l) => l.light === 'dark'),
            on_timeline: e.index.shots.filter((s) => shotUses(r, source.id, s.start, s.end).length).length
          }
        })
      return json({ ...(indexing ? { indexing } : {}), sources })
    }
  }),

  defineTool({
    name: 'find_shots',
    description:
      'Find B-roll and moments in the footage index: filter and rank shots, best first, each with its best still (source seconds), the ' +
      'safe in/out to use (clear of the cut edges), its look and where it already is on the timeline. Filters: steady (true: no shaky ' +
      'camera; false: handheld/shaky only), faces ("none", "any", "close"), sharp, bright, motion ("calm", "some", "action"), loud (true: ' +
      'loud sound such as a crash or a rev), min_seconds, not_on_timeline (unused footage only), near_time (timeline seconds: shots from the ' +
      'same file near the moment playing there rank higher). Then look at the candidates together with get_shot_sheet.',
    input: {
      source_id: z.string().optional(),
      min_seconds: z.number().min(0).optional(),
      steady: z.boolean().optional(),
      faces: z.enum(['none', 'any', 'close']).optional(),
      sharp: z.boolean().optional(),
      bright: z.boolean().optional(),
      motion: z.enum(['calm', 'some', 'action']).optional(),
      loud: z.boolean().optional(),
      not_on_timeline: z.boolean().optional(),
      near_time: z.number().min(0).optional(),
      limit: z.number().int().min(1).max(40).default(10)
    },
    run: (args, env) => {
      if (args.source_id) sourceById(env.store.snapshotDoc(), args.source_id)
      const st = env.ctx.footage.status()
      const indexing = indexingText(st)
      const list = indexed(env)
      if (!list.length) {
        throw new ToolError(indexing ? `No footage is indexed yet. ${indexing}. Try again shortly, or use get_frame meanwhile.` : 'There is no video footage in the project to index.')
      }
      const candidates = findShots(list, env.resolver(), args)
      return json({ ...(indexing ? { indexing } : {}), found: candidates.length, candidates })
    }
  }),

  defineTool({
    name: 'get_shot_sheet',
    description:
      `One contact sheet image of up to ${SHEET_MAX} shots from the footage index, numbered, each picture the best still of its shot. ` +
      'Give shot_ids (from find_shots or get_footage_index, e.g. "src_abc#4"), or source_id with from_shot to page through a file. ' +
      'Compare candidates here in one look; use get_frame only to confirm the final pick in place.',
    input: {
      shot_ids: z.array(z.string()).min(1).max(SHEET_MAX).optional(),
      source_id: z.string().optional(),
      from_shot: z.number().int().min(1).default(1)
    },
    run: async (args, env) => {
      const doc = env.store.snapshotDoc()
      const picks: { source: Source; entry: FootageIndexEntry; shot: IndexedShot }[] = []
      const take = (sourceId: string, index: number, id: string) => {
        const source = sourceById(doc, sourceId)
        const entry = env.ctx.footage.get(source.id)
        if (!entry) throw new ToolError(`${basename(source.path)} is not indexed yet (${sourceState(env, source, env.ctx.footage.status())}).`)
        const shot = entry.index.shots[index - 1]
        if (!shot) throw new ToolError(`No shot ${id}: ${basename(source.path)} has ${entry.index.shots.length} shots.`)
        picks.push({ source, entry, shot })
      }
      if (args.shot_ids?.length) {
        for (const id of args.shot_ids) {
          const p = parseShotId(id)
          if (!p) throw new ToolError(`"${id}" is not a shot id. Shot ids look like "src_abc#4" (source id, #, shot number).`)
          take(p.sourceId, p.index, id)
        }
      } else if (args.source_id) {
        const entry = env.ctx.footage.get(args.source_id)
        const total = entry?.index.shots.length ?? 0
        if (entry && args.from_shot > total) throw new ToolError(`The file has ${total} shots.`)
        for (let i = args.from_shot; i < args.from_shot + SHEET_MAX && (!entry || i <= total); i++) take(args.source_id, i, shotId(args.source_id, i))
      } else {
        throw new ToolError('Give shot_ids or a source_id.')
      }
      const items = picks.map(({ entry, shot }) => ({
        path: shot.thumb ? join(entry.thumbs, shot.thumb) : '',
        label: `${formatTime(shot.best, true)}  ${lookWords(shotLook(shot, entry.index.facesChecked))}`
      }))
      const dir = join(env.dir, 'cache', 'frames')
      mkdirSync(dir, { recursive: true })
      const out = join(dir, `shots_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.jpg`)
      await env.ctx.footage.sheet(items, out)
      const key = picks.map(({ source, shot }, i) => `${i + 1}: ${shotId(source.id, shot.index)} ${basename(source.path)} ${t1(shot.start)}-${t1(shot.end)}s, best ${shot.best}s`)
      return images([{ label: `Shot sheet (source seconds):\n${key.join('\n')}`, path: out }])
    }
  })
]
