import type { ProjectDoc, Range } from './project'
import { CaptionStyleSchema } from './project'
import { TimelineResolver, buildCaptions, type CaptionLine } from './timeline'

function srtTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const r = ms % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`
}

export function captionLines(doc: ProjectDoc): CaptionLine[] {
  const style = CaptionStyleSchema.parse({ ...doc.project.settings.brandKit.captionStyle, ...(doc.project.captions.style ?? {}) })
  return buildCaptions(new TimelineResolver(doc.project, doc.transcript), style)
}

/** A subtitle file for YouTube, built from the same caption lines that are burned in. */
export function buildSrt(doc: ProjectDoc, range?: Range): string {
  const offset = range?.start ?? 0
  const out: string[] = []
  let n = 1
  for (const line of captionLines(doc)) {
    if (range && (line.end <= range.start || line.start >= range.end)) continue
    const start = Math.max(0, line.start - offset)
    const end = Math.min(range ? range.end - offset : Infinity, line.end - offset)
    out.push(String(n++), `${srtTime(start)} --> ${srtTime(end)}`, line.words.map((w) => w.word.text.trim()).join(' '), '')
  }
  return out.join('\n')
}

/** Chapter list for a YouTube description: "0:00 Intro". Times follow the words they are tied to. */
export function chapterLines(doc: ProjectDoc): string[] {
  const r = new TimelineResolver(doc.project, doc.transcript)
  const chapters = doc.project.publish.chapters
    .map((c) => ({ title: c.title, t: r.anchorTime(c.anchor).time }))
    .sort((a, b) => a.t - b.t)
  if (chapters.length && chapters[0].t > 0.5) chapters.unshift({ title: 'Intro', t: 0 })
  if (chapters.length) chapters[0].t = 0
  return chapters.map((c) => {
    const t = Math.floor(c.t)
    const h = Math.floor(t / 3600)
    const m = Math.floor((t % 3600) / 60)
    const s = t % 60
    const ts = h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
    return `${ts} ${c.title}`
  })
}
