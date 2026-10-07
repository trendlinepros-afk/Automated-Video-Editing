/**
 * The base picture of a thumbnail: a clean frame of the footage at a timeline time. Clean means the footage only
 * (A-roll with any B-roll over it, at full source quality): no captions, graphics, effects or logo. It is cropped
 * and scaled to the thumbnail format (16:9 is YouTube's 1280x720) and saved as a JPEG, small enough to send to
 * Pikzels with every prompt.
 */
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { TimelineResolver } from '@shared/timeline'
import type { AppContext } from '../context'
import { formatCommand, spawnLines } from '../engine/engine'
import type { ProjectStore } from '../project/store'

export type ThumbnailFormat = '16:9' | '9:16' | '1:1'

/** The image size for each thumbnail format: YouTube's recommended 1280x720, and the same detail for the others. */
export const THUMBNAIL_SIZE: Record<ThumbnailFormat, { width: number; height: number }> = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '1:1': { width: 1080, height: 1080 }
}

/** ffmpeg filter that fills the format (crop to its shape around the centre, then scale). */
export function fitFilter(format: ThumbnailFormat): string {
  const { width, height } = THUMBNAIL_SIZE[format]
  return `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},setsar=1`
}

/** Renders the clean frame at a timeline time into out (a .jpg), sized for the format. */
export async function cleanFrame(ctx: AppContext, store: ProjectStore, time: number, out: string, format?: ThumbnailFormat): Promise<string> {
  const doc = store.snapshotDoc()
  const duration = new TimelineResolver(doc.project, doc.transcript).duration
  // Inside the video: the last frame at most.
  const t = duration > 0 ? Math.min(Math.max(0, time), Math.max(0, duration - 1 / (doc.project.output.fps || 30))) : Math.max(0, time)
  const fmt = format ?? (doc.project.thumbnails.format as ThumbnailFormat) ?? '16:9'
  mkdirSync(join(out, '..'), { recursive: true })
  // Full output width (at least 1920) from the original footage, not the preview proxies.
  const width = Math.min(3840, Math.max(1920, doc.project.output.width || 1920))
  const png = await ctx.engine.frame(doc, store.dir, t, { width, footageOnly: true, out: out.replace(/\.[a-z]+$/i, '') + '.full.png' })
  const tmp = out.replace(/\.jpg$/i, '.part.jpg')
  const ffmpeg = ctx.env.ffmpeg()
  const args = ['-hide_banner', '-y', '-i', png, '-vf', fitFilter(fmt), '-frames:v', '1', '-q:v', '2', tmp]
  try {
    const r = await spawnLines(ffmpeg, args, {})
    if (r.code !== 0 || !existsSync(tmp)) {
      store.log.write('thumbnail', 'Could not size the frame for the thumbnail', { command: formatCommand(ffmpeg, args), errorOutput: r.stderr.slice(-2000) })
      throw new Error('The frame could not be saved for the thumbnail. See the log for details.')
    }
    renameSync(tmp, out)
  } finally {
    rmSync(tmp, { force: true })
    rmSync(png, { force: true })
  }
  return out
}

/** Grabs the clean frame at a timeline time as the project's thumbnail base picture (replacing the old one). */
export async function grabBase(ctx: AppContext, store: ProjectStore, time: number, by: 'user' | 'claude'): Promise<{ file: string; time: number }> {
  const name = `base-${Date.now().toString(36)}.jpg`
  const abs = join(store.paths.thumbnails, name)
  await cleanFrame(ctx, store, time, abs)
  const old = store.project.thumbnails.base?.file
  const file = `thumbnails/${name}`
  store.mutate(
    'Thumbnail base picture',
    by,
    (d) => {
      d.project.thumbnails.base = { file, time: Math.round(time * 1000) / 1000, by, at: new Date().toISOString() }
    },
    { bypassLock: true, noHistory: true }
  )
  if (old && old !== file && basename(old).startsWith('base-')) rmSync(join(store.dir, old), { force: true })
  store.log.write('thumbnail', `Base picture for thumbnails: the frame at ${time.toFixed(2)} s`, { by, file })
  return { file, time }
}

export function clearBase(store: ProjectStore): void {
  const old = store.project.thumbnails.base?.file
  if (!old) return
  store.mutate('Remove thumbnail base picture', 'user', (d) => void delete d.project.thumbnails.base, { bypassLock: true, noHistory: true })
  if (basename(old).startsWith('base-')) rmSync(join(store.dir, old), { force: true })
}

/** The base picture's file when it still exists. */
export function basePath(store: ProjectStore): string | null {
  const f = store.project.thumbnails.base?.file
  if (!f) return null
  const p = join(store.dir, f)
  return existsSync(p) ? p : null
}
