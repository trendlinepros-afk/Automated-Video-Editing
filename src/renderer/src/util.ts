/** Small helpers shared by every screen. Paths are Windows paths in the app, POSIX paths in tests. */
import type { Item } from '@shared/project'
import { formatTime } from '@shared/timeline'

export function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(p)
}

export function joinPath(dir: string, rel: string): string {
  if (!rel || isAbsolutePath(rel)) return rel
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.replace(/[\\/]+$/, '') + sep + rel.replace(/[\\/]/g, sep)
}

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

export function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

/** URL for a local file shown in an <img>, <video> or <audio> (served by the app's media protocol). */
export function mediaUrl(path: string | undefined | null, projectDir?: string): string | undefined {
  if (!path) return undefined
  if (/^(ave-media|https?|data|blob):/i.test(path)) return path
  let p = path
  if (/^file:\/\//i.test(p)) {
    p = decodeURIComponent(p.replace(/^file:\/\/\/?/i, ''))
    if (!/^[a-zA-Z]:/.test(p) && !p.startsWith('/')) p = '/' + p
  }
  if (projectDir && !isAbsolutePath(p)) p = joinPath(projectDir, p)
  return window.api.app.fileUrl(p)
}

/** Plain message from an IPC error ("Error invoking remote method 'x': Error: msg" -> "msg"). */
export function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(\w*Error):\s*/, '')
}

export function fmt(t: number, ms = false): string {
  return formatTime(Math.max(0, t), ms)
}

/** Time with tenths: 1:02.5 */
export function fmtShort(t: number): string {
  const base = formatTime(Math.max(0, t))
  const tenth = Math.floor((Math.max(0, t) % 1) * 10)
  return `${base}.${tenth}`
}

export function fmtRange(r: { start: number; end: number }): string {
  return `${fmt(r.start)}–${fmt(r.end)}`
}

export function relativeTime(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const s = (Date.now() - d.getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} days ago`
  return d.toLocaleDateString()
}

export function dateTime(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function itemLabel(item: Item, sourcePath?: (id: string) => string | undefined): string {
  if (item.label) return item.label
  switch (item.type) {
    case 'segment':
      return basename(sourcePath?.(item.sourceId) ?? item.sourceId)
    case 'effect':
      return item.effect === 'custom' && item.file ? stripExt(basename(item.file)) : item.effect.replace('_', ' ')
    case 'graphic':
      return stripExt(basename(item.file))
    default: {
      const f = item.file ?? (item.sourceId ? sourcePath?.(item.sourceId) : undefined)
      return f ? stripExt(basename(f)) : item.type
    }
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** True when a key event is aimed at a text field, so editor shortcuts stay out of the way. */
export function isTyping(e: Event): boolean {
  const t = e.target as HTMLElement | null
  if (!t) return false
  const tag = t.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return true
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type
    return !['checkbox', 'radio', 'range', 'button', 'color'].includes(type)
  }
  return false
}

export const TRACK_COLORS: Record<string, string> = {
  aroll: 'var(--track-aroll)',
  broll: 'var(--track-broll)',
  graphics: 'var(--track-graphics)',
  effects: 'var(--track-effects)',
  captions: 'var(--track-captions)',
  music: 'var(--track-music)',
  sfx: 'var(--track-sfx)'
}

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp']
export const AUDIO_EXTS = ['wav', 'mp3', 'flac', 'm4a', 'aac', 'ogg']
export const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v']
export const FONT_EXTS = ['ttf', 'otf']
