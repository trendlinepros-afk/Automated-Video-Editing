/**
 * Shared pieces for the MCP tools: the tool definition shape, result helpers, and the small
 * bookkeeping helpers several tools use (anchors, tracks, project paths, sources).
 * None of this makes an editing decision: it records what Claude asked for.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Anchor, Item, ProjectDoc, Source, Track, TrackKind } from '@shared/project'
import { TimelineResolver, round3 } from '@shared/timeline'
import type { AppContext } from '../../context'
import type { ProjectStore } from '../../project/store'
import { newId } from '../../project/store'

export type ToolResult = CallToolResult

/** What a tool receives besides its arguments. */
export interface ToolEnv {
  ctx: AppContext
  /** The open project. Tools marked needsProject: false may get null. */
  store: ProjectStore
  dir: string
  /** Apply a change from Claude: format check, section lock, undo history, save, window update. */
  mutate<T>(label: string, fn: (draft: ProjectDoc) => T, opts?: { bypassLock?: boolean; noHistory?: boolean }): T
  resolver(): TimelineResolver
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  description: string
  input: S
  /** Default true: the tool refuses to run when no project is open. */
  needsProject?: boolean
  run(args: z.output<z.ZodObject<S>>, env: ToolEnv): Promise<ToolResult> | ToolResult
}

/** Keeps the argument types of each tool while collecting them in one list. */
export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef
}

/** A plain-language failure. The message goes back to Claude as is. */
export class ToolError extends Error {}

// ---------------------------------------------------------------- results

export function json(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] }
}

export function text(t: string): ToolResult {
  return { content: [{ type: 'text', text: t }] }
}

/** Images with a caption line before each one. */
export function images(list: { label: string; path: string }[], header?: unknown): ToolResult {
  const content: ToolResult['content'] = []
  if (header !== undefined) content.push({ type: 'text', text: typeof header === 'string' ? header : JSON.stringify(header, null, 1) })
  for (const img of list) {
    content.push({ type: 'text', text: img.label })
    content.push({ type: 'image', data: readFileSync(img.path).toString('base64'), mimeType: mimeFor(img.path) })
  }
  return { content }
}

function mimeFor(p: string): string {
  if (/\.jpe?g$/i.test(p)) return 'image/jpeg'
  if (/\.webp$/i.test(p)) return 'image/webp'
  return 'image/png'
}

// ---------------------------------------------------------------- input pieces

const num = z.number().finite()

/** Where an item starts: a transcript word plus an offset (preferred), or a fixed timeline time. */
export const anchorInput = z
  .object({
    word_id: z.string().min(1).optional().describe('Transcript word id. The item moves with this word when cuts change.'),
    offset: num.optional().describe('Seconds after (+) or before (-) the start of the word. Default 0.'),
    time: num.min(0).optional().describe('Fixed timeline time in seconds. Use only for things tied to the timeline itself, such as music.')
  })
  .describe('Either {word_id, offset} or {time}.')
export type AnchorInput = z.infer<typeof anchorInput>

export function toAnchor(a: AnchorInput, doc: ProjectDoc): Anchor {
  if (a.word_id) {
    const exists = Object.values(doc.transcript.clips).some((c) => c.words.some((w) => w.id === a.word_id))
    if (!exists) throw new ToolError(`Word id "${a.word_id}" is not in the saved transcript. Use get_transcript to find word ids.`)
    return { kind: 'word', wordId: a.word_id, offset: a.offset ?? 0 }
  }
  if (a.time !== undefined) return { kind: 'time', time: a.time }
  throw new ToolError('An anchor needs a word_id (with an optional offset) or a time.')
}

export const transformInput = z
  .object({
    x: num.optional().describe('Centre offset as a fraction of frame width (-0.5..0.5 = edges).'),
    y: num.optional().describe('Centre offset as a fraction of frame height.'),
    scale: num.positive().optional(),
    rotation: num.optional().describe('Degrees.'),
    opacity: num.min(0).max(1).optional()
  })
  .describe('Position and size on screen.')

export const keyframesInput = z
  .array(z.object({ t: num.min(0).describe('Seconds from the item start'), x: num, y: num, scale: num.positive().optional() }))
  .describe('Positions along the way, for following something that moves.')

// ---------------------------------------------------------------- tracks

export const DEFAULT_TRACK_FOR: Record<string, TrackKind> = {
  clip: 'broll',
  graphic: 'graphics',
  effect: 'effects',
  audio: 'sfx'
}

/** A track by id, or the first track of a kind. */
export function findTrack(doc: ProjectDoc, idOrKind: string): Track {
  const byId = doc.project.tracks.find((t) => t.id === idOrKind)
  if (byId) return byId
  const byKind = doc.project.tracks.find((t) => t.kind === idOrKind)
  if (byKind) return byKind
  throw new ToolError(`No track "${idOrKind}". Tracks: ${doc.project.tracks.map((t) => `${t.id} (${t.kind})`).join(', ')}`)
}

// ---------------------------------------------------------------- files

/** Project-relative path with forward slashes, or null when the file is outside the project. */
export function projectRelative(dir: string, p: string): string | null {
  const abs = resolve(isAbsolute(p) ? p : join(dir, p))
  const rel = relative(resolve(dir), abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

export function absInProject(dir: string, rel: string): string {
  return isAbsolute(rel) ? rel : join(dir, ...rel.split('/'))
}

export function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

export const AUDIO_EXT = /\.(wav|mp3|flac|aac|m4a|ogg|opus|aif|aiff|wma)$/i
export const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i

/** Probe a file and register it as a project source (or return the existing one with that path). */
export async function ensureSource(env: ToolEnv, path: string, origin: Source['origin']): Promise<Source> {
  if (!isAbsolute(path)) throw new ToolError(`"${path}" is not an absolute path`)
  if (!fileExists(path)) throw new ToolError(`File not found: ${path}`)
  const norm = (p: string) => resolve(p).toLowerCase()
  const existing = env.store.project.sources.find((s) => norm(s.path) === norm(path))
  if (existing) return existing
  let info: Awaited<ReturnType<AppContext['engine']['probe']>>
  try {
    info = await env.ctx.engine.probe(path)
  } catch (err) {
    throw new ToolError(`Could not read ${basename(path)}: ${errMessage(err)}`)
  }
  const st = statSync(path)
  const source: Source = {
    id: newId('src'),
    path,
    kind: info.kind,
    duration: info.duration,
    ...(info.width ? { width: info.width } : {}),
    ...(info.height ? { height: info.height } : {}),
    ...(info.fps ? { fps: info.fps } : {}),
    hasAudio: info.hasAudio,
    origin,
    size: st.size,
    mtimeMs: st.mtimeMs
  }
  env.mutate(`Add source ${basename(path)}`, (d) => {
    d.project.sources.push(source)
  }, { bypassLock: true })
  return source
}

export function sourceById(doc: ProjectDoc, id: string): Source {
  const s = doc.project.sources.find((x) => x.id === id)
  if (!s) throw new ToolError(`No source "${id}". Use list_footage to see source ids.`)
  return s
}

export function itemById(doc: ProjectDoc, id: string): Item {
  const item = doc.project.items.find((i) => i.id === id)
  if (!item) throw new ToolError(`No item "${id}" in the project.`)
  return item
}

/** Item as Claude sees it: stored fields plus resolved timeline start and end. */
export function describeItem(r: TimelineResolver, item: Item): Record<string, unknown> {
  const res = r.resolveItem(item)
  return { ...item, start: round3(res.start), end: round3(res.end), ...(res.orphaned ? { orphaned: true } : {}) }
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export function existsOrThrow(p: string, what: string): void {
  if (!existsSync(p)) throw new ToolError(`${what} not found: ${p}`)
}

/** File-name-safe slug. */
export function slug(name: string, max = 48): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
  return s || 'file'
}
