/**
 * "Write it for me" in the Thumbnails tab, done in one quick call instead of a full editing session.
 *
 * The app does the slow parts itself: it picks up to 8 candidate moments (B-roll first, since that is where the
 * subject of the video is usually shown, then the talking parts), cuts them straight from the footage with ffmpeg
 * into one contact sheet, and collects what is said. Claude Code then runs once on its own (no project tools, no
 * earlier session to load), looks at the sheet, and answers with the best frame and a description. The app makes
 * that frame the base picture (unless the owner grabbed one) and puts the description in the prompt box.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { ClipItem, Project, Transcript } from '@shared/project'
import { TimelineResolver, timelineToSource } from '@shared/timeline'
import type { AppContext } from '../context'
import { formatCommand, spawnLines } from '../engine/engine'
import type { ProjectStore } from '../project/store'
import { resolveCommand } from '../runner/runner'
import { grabBase } from './thumbnailBase'

export const SHEET_COLUMNS = 4
export const MAX_CANDIDATES = 8
const CELL = { width: 480, height: 270 }
const MAX_SPOKEN_CHARS = 5000
const TIMEOUT_MS = 150_000

export interface Candidate {
  /** Timeline time (what the base picture is grabbed at). */
  time: number
  file: string
  /** Time in that file. */
  at: number
  what: 'b-roll' | 'a-roll'
}

/** Up to 8 moments worth looking at: the middle of the longest B-roll shots, then evenly spread talking parts. */
export function pickCandidates(project: Project, transcript: Transcript, projectDir: string, max = MAX_CANDIDATES): Candidate[] {
  const resolver = new TimelineResolver(project, transcript)
  if (resolver.duration <= 0) return []
  const sourcePath = (id?: string) => project.sources.find((s) => s.id === id && s.kind !== 'image')?.path
  const brollTracks = new Set(project.tracks.filter((t) => t.kind !== 'aroll').map((t) => t.id))
  const out: Candidate[] = []

  const clips = project.items
    .filter((i): i is ClipItem => i.type === 'clip' && brollTracks.has(i.trackId))
    .map((item) => ({ item, span: resolver.resolveItem(item) }))
    .filter(({ item, span }) => !span.orphaned && span.end > span.start && span.start < resolver.duration && (item.sourceId || item.file))
    .sort((a, b) => b.span.end - b.span.start - (a.span.end - a.span.start))
  for (const { item, span } of clips.slice(0, Math.ceil(max * 0.6))) {
    const file = sourcePath(item.sourceId) ?? (item.file ? (isAbsolute(item.file) ? item.file : join(projectDir, item.file)) : undefined)
    if (!file || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(file)) continue
    const mid = (span.start + Math.min(span.end, resolver.duration)) / 2
    out.push({ time: mid, file, at: item.in + (mid - span.start) * (item.speed || 1), what: 'b-roll' })
  }

  const need = max - out.length
  for (let k = 0; k < need; k++) {
    const t = (resolver.duration * (k + 0.5)) / need
    if (out.some((c) => Math.abs(c.time - t) < resolver.duration / (max * 2))) continue
    const hit = timelineToSource(resolver.segments, t)
    const file = hit ? sourcePath(hit.segment.item.sourceId) : undefined
    if (hit && file) out.push({ time: t, file, at: hit.sourceTime, what: 'a-roll' })
  }
  return out.sort((a, b) => a.time - b.time).slice(0, max)
}

/** What is said in the edit, in order (only the parts kept on the timeline). */
export function spokenText(project: Project, transcript: Transcript, maxChars = MAX_SPOKEN_CHARS): string {
  const resolver = new TimelineResolver(project, transcript)
  const parts: string[] = []
  let length = 0
  for (const seg of resolver.segments) {
    const s = seg.item
    const words = transcript.clips[s.sourceId]?.words ?? []
    const text = words
      .filter((w) => w.start >= s.in - 0.05 && w.end <= s.out + 0.05)
      .map((w) => w.text)
      .join(' ')
      .trim()
    if (!text) continue
    parts.push(text)
    length += text.length + 1
    if (length >= maxChars) break
  }
  return parts.join(' ').replace(/\s+/g, ' ').slice(0, maxChars)
}

/** One image with every candidate, numbered left to right, top to bottom. */
export async function contactSheet(ffmpeg: string, candidates: Candidate[], out: string): Promise<void> {
  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  for (const c of candidates) args.push('-ss', Math.max(0, c.at).toFixed(3), '-i', c.file)
  const cols = Math.min(SHEET_COLUMNS, candidates.length)
  const rows = Math.ceil(candidates.length / cols)
  const cells = Array.from({ length: rows * cols }, (_, i) => i)
  const fit = `scale=${CELL.width}:${CELL.height}:force_original_aspect_ratio=increase,crop=${CELL.width}:${CELL.height},setsar=1`
  const filters = candidates.map((_, i) => `[${i}:v:0]trim=end_frame=1,${fit}[c${i}]`)
  // Empty cells (when there are fewer candidates than the grid holds) are black.
  for (let i = candidates.length; i < cells.length; i++) filters.push(`color=c=black:s=${CELL.width}x${CELL.height}:d=1,trim=end_frame=1[c${i}]`)
  const layout = cells.map((i) => `${(i % cols) * CELL.width}_${Math.floor(i / cols) * CELL.height}`).join('|')
  filters.push(`${cells.map((i) => `[c${i}]`).join('')}xstack=inputs=${cells.length}:layout=${layout}[out]`)
  args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', '-q:v', '3', out)
  const r = await spawnLines(ffmpeg, args, {})
  if (r.code !== 0) throw new Error(`The frames could not be gathered: ${r.stderr.slice(-300) || formatCommand(ffmpeg, args)}`)
}

export function draftPrompt(o: {
  count: number
  candidates: Candidate[]
  spoken: string
  title?: string
  persona?: string
  style?: string
  direction?: string
  theme?: string
  keepBase: boolean
}): string {
  const cols = Math.min(SHEET_COLUMNS, o.count)
  return [
    'You are writing a YouTube thumbnail description for a creator. Answer quickly; do not explore or run anything else.',
    `Read the image sheet.jpg in the current folder: ${o.count} frames from the video, numbered 1-${o.count} left to right, top to bottom ` +
      `(${cols} per row). ${o.candidates.map((c, i) => `${i + 1}: ${c.what} at ${c.time.toFixed(1)}s`).join('; ')}.`,
    o.keepBase
      ? 'The creator already chose the base picture; still say which frame shows the subject best.'
      : 'Pick the frame that shows the thing the video is about (the product, vehicle, build or subject) best: big in frame, sharp, well lit, not blocked by hands, no motion blur. It becomes the base picture the thumbnail is built around.',
    'Then write ONE description (under 600 characters, no links) of a click-worthy thumbnail built around that picture: the subject, the ' +
      "creator's face and reaction, big short text (2-4 words), colours and layout. It must match what the video is really about and its payoff.",
    o.persona ? `The creator appears through the Pikzels persona "${o.persona}": describe them by role ("me"), not looks.` : '',
    o.style ? `The Pikzels thumbnail style "${o.style}" is applied: fit the description to it.` : '',
    o.theme ? `Video theme: ${o.theme}.` : '',
    o.direction ? `The creator's thumbnail direction: "${o.direction}".` : '',
    o.title ? `Working title: "${o.title}".` : '',
    `What is said in the video:\n"""${o.spoken || '(no transcript)'}"""`,
    'Reply with ONLY this JSON on one line: {"frame": <number>, "description": "<text>"}'
  ]
    .filter(Boolean)
    .join('\n')
}

/** The frame number and description from Claude Code's reply (its JSON envelope, or plain text). */
export function parseDraft(stdout: string, count: number): { frame: number; description: string } {
  let text = stdout.trim()
  try {
    const env = JSON.parse(text) as { result?: unknown; is_error?: boolean }
    if (env.is_error) throw new Error(String(env.result ?? 'Claude could not answer.'))
    if (typeof env.result === 'string') text = env.result
  } catch (err) {
    if (err instanceof Error && !(err instanceof SyntaxError)) throw err
  }
  const m = /\{[^{}]*"description"[^{}]*\}/s.exec(text)
  if (!m) throw new Error('Claude did not answer with a description.')
  const parsed = JSON.parse(m[0]) as { frame?: unknown; description?: unknown }
  const description = String(parsed.description ?? '').replace(/https?:\/\/\S+|www\.\S+/gi, '').replace(/\s+/g, ' ').trim()
  if (!description) throw new Error('Claude did not answer with a description.')
  const frame = Math.round(Number(parsed.frame))
  return { frame: frame >= 1 && frame <= count ? frame : 1, description }
}

export interface DraftDeps {
  spawn?: (file: string, args: string[], opts: Parameters<typeof spawn>[2]) => ChildProcess
  platform?: NodeJS.Platform
}

/** Runs the whole quick draft. Resolves when the description (and base picture) are saved. */
export async function writeThumbnailDraft(ctx: AppContext, store: ProjectStore, deps: DraftDeps = {}): Promise<{ description: string; time: number }> {
  const doc = store.snapshotDoc()
  const project = doc.project
  const candidates = pickCandidates(project, doc.transcript, store.dir)
  if (!candidates.length) throw new Error('There is no footage on the timeline yet to make a thumbnail from.')
  const work = join(store.paths.cache, 'thumbnail-draft')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const started = Date.now()
  await contactSheet(ctx.env.ffmpeg(), candidates, join(work, 'sheet.jpg'))

  const names = new Map(ctx.pikzels.list().map((p) => [p.id, p.name]))
  const th = project.thumbnails
  const keepBase = th.base?.by === 'user'
  const prompt = draftPrompt({
    count: candidates.length,
    candidates,
    spoken: spokenText(project, doc.transcript),
    title: project.publish.titles[0],
    persona: th.personaId ? names.get(th.personaId) : undefined,
    style: th.styleId ? names.get(th.styleId) : undefined,
    direction: th.direction.trim() || undefined,
    theme: project.videoTheme?.name,
    keepBase
  })
  writeFileSync(join(work, 'prompt.txt'), prompt)

  const settings = ctx.settings.get()
  const model = settings.claude?.models?.thumbnails || ''
  const args = ['-p', prompt, '--output-format', 'json', '--allowedTools', 'Read', '--max-turns', '4', ...(model ? ['--model', model] : [])]
  const platform = deps.platform ?? process.platform
  const cmd = resolveCommand(settings.runner.command, args, platform)
  const { ANTHROPIC_API_KEY: _drop, ...env } = process.env // Claude Code uses its own sign-in, never a key from the app
  const run = deps.spawn ?? spawn
  const stdout = await new Promise<string>((resolve, reject) => {
    let out = ''
    let err = ''
    const proc = run(cmd.file, cmd.args, { cwd: work, env, windowsHide: true, shell: cmd.shell, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('Claude took too long to answer. Try again.'))
    }, TIMEOUT_MS)
    proc.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')))
    proc.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')))
    proc.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`Claude Code could not be started (${(e as NodeJS.ErrnoException).code ?? e.message}). Check Settings > Claude.`))
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 || out.trim()) resolve(out)
      else reject(new Error(`Claude could not answer: ${(err || out).trim().slice(-300) || `exit code ${code}`}`))
    })
  })
  const { frame, description } = parseDraft(stdout, candidates.length)
  const pick = candidates[frame - 1]
  if (!keepBase) await grabBase(ctx, store, pick.time, 'claude')
  store.mutate(
    'Thumbnail description from Claude',
    'claude',
    (d) => {
      d.project.thumbnails.draft = { text: description, at: new Date().toISOString() }
    },
    { bypassLock: true, noHistory: true }
  )
  store.log.write('thumbnail', `Claude wrote the thumbnail description in ${((Date.now() - started) / 1000).toFixed(1)} s`, {
    model: model || 'default',
    frame,
    time: pick.time,
    keptOwnBase: keepBase
  })
  rmSync(work, { recursive: true, force: true })
  return { description, time: pick.time }
}
