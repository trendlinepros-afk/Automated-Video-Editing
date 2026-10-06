/**
 * The ave-media:// protocol: serves local files (footage, previews, waveforms, thumbnails) to the
 * window, with HTTP Range support so <video> can seek. URLs are
 * ave-media://local/<encodeURIComponent(absolute path)>.
 */
import { createReadStream, statSync } from 'node:fs'
import { extname } from 'node:path'
import { Readable } from 'node:stream'

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2'
}

/** ave-media://local/<encodeURIComponent(absolute path)>, with HTTP Range support so <video> can seek. */
export function serveMedia(request: Request): Response {
  const url = new URL(request.url)
  const file = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  let size: number
  try {
    const st = statSync(file)
    if (!st.isFile()) return new Response('Not found', { status: 404 })
    size = st.size
  } catch {
    return new Response('Not found', { status: 404 })
  }
  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
  const base: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' }
  const stream = (start: number, end: number) =>
    Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream<Uint8Array>

  const range = request.headers.get('Range')
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
  if (m && (m[1] || m[2])) {
    let start: number
    let end: number
    if (m[1]) {
      start = Number(m[1])
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    } else {
      // "bytes=-500": the last 500 bytes
      start = Math.max(0, size - Number(m[2]))
      end = size - 1
    }
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } })
    }
    return new Response(stream(start, end), {
      status: 206,
      headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) }
    })
  }
  if (size === 0) return new Response(null, { status: 200, headers: { ...base, 'Content-Length': '0' } })
  return new Response(stream(0, size - 1), { status: 200, headers: { ...base, 'Content-Length': String(size) } })
}
