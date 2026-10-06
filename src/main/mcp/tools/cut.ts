/** Cut tools: the transcript and the edit decision list. The app applies every cut exactly as given. */
import { z } from 'zod'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { SegmentItem, Word } from '@shared/project'
import { round3, segmentDuration } from '@shared/timeline'
import { newId } from '../../project/store'
import { ToolError, defineTool, findTrack, json, sourceById } from './common'

const num = z.number().finite()

const segmentInput = z.object({
  id: z.string().optional().describe('Keep the id of a segment you are not changing. Leave out for a new segment.'),
  source_id: z.string(),
  in: num.min(0).describe('Source seconds where the kept piece starts'),
  out: num.min(0).describe('Source seconds where it ends'),
  speed: num.positive().optional(),
  hold: num.min(0).optional().describe('Freeze frame: show the frame at `in` for this many seconds'),
  muted: z.boolean().optional(),
  volume: num.optional().describe('dB'),
  fade_in: num.min(0).optional(),
  fade_out: num.min(0).optional(),
  label: z.string().optional()
})

const EPS = 1e-6

type FileWord = { id?: string; text: string; start: number; end: number; prob?: number }

/** Reads the word list from a transcription JSON file (faster-whisper / WhisperX style, {words}, or a plain list). */
export function readTranscriptFile(path: string): { words: FileWord[]; language?: string } {
  if (!existsSync(path)) throw new ToolError(`Transcript file not found: ${path}`)
  let data: any
  try {
    data = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch (err) {
    throw new ToolError(`The transcript file is not valid JSON: ${(err as Error).message}`)
  }
  const list: any[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.words)
      ? data.words
      : Array.isArray(data?.segments)
        ? data.segments.flatMap((s: any) => (Array.isArray(s?.words) ? s.words : []))
        : []
  const words: FileWord[] = []
  for (const w of list) {
    const text = String(w?.text ?? w?.word ?? '').trim()
    const start = Number(w?.start)
    const end = Number(w?.end)
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)) continue
    const prob = Number(w?.prob ?? w?.probability ?? w?.score)
    words.push({ ...(typeof w?.id === 'string' && w.id ? { id: w.id } : {}), text, start: Math.max(0, start), end: Math.max(0, end), ...(Number.isFinite(prob) ? { prob } : {}) })
  }
  if (!words.length) throw new ToolError('No words with start and end times were found in the transcript file. Transcribe with word timestamps.')
  const language = typeof data?.language === 'string' ? data.language : typeof data?.info?.language === 'string' ? data.info.language : undefined
  return { words, ...(language ? { language } : {}) }
}

export const cutTools = [
  defineTool({
    name: 'save_transcript',
    description:
      'Save the transcript of one source (you transcribe it yourself, e.g. faster-whisper on the GPU with word timings). ' +
      'Prefer file: the path of the JSON your transcription wrote (faster-whisper style {segments:[{words:[{word,start,end,probability}]}]}, ' +
      'or {words:[...]} or a plain word list). It costs far fewer tokens than sending the words. Otherwise pass ' +
      'words: [{id?, text, start, end, prob?}] in source seconds. Ids are given as "<sourceId>_w<index>" when you leave them out. ' +
      'When re-saving a source, pass the existing ids of words that stay, so anchors, captions and chapters keep pointing at them. ' +
      'Replaces the saved words of that source.',
    input: {
      source_id: z.string(),
      language: z.string().optional(),
      file: z.string().optional().describe('Path to a transcript JSON file (absolute, or relative to the project folder)'),
      words: z.array(z.object({ id: z.string().min(1).optional(), text: z.string(), start: num.min(0), end: num.min(0), prob: num.optional() })).optional()
    },
    run: (raw, env) => {
      const fromFile = raw.file ? readTranscriptFile(isAbsolute(raw.file) ? raw.file : join(env.store.dir, raw.file)) : null
      if (!fromFile && !raw.words) throw new ToolError('Give file (the transcript JSON path) or words.')
      const args = { ...raw, words: fromFile?.words ?? raw.words ?? [], language: raw.language ?? fromFile?.language }
      const doc = env.store.snapshotDoc()
      sourceById(doc, args.source_id)
      const previous = new Map((doc.transcript.clips[args.source_id]?.words ?? []).map((w) => [w.id, w]))
      const otherIds = new Set<string>()
      for (const [sid, clip] of Object.entries(doc.transcript.clips)) if (sid !== args.source_id) for (const w of clip.words) otherIds.add(w.id)
      const used = new Set<string>()
      const problems: string[] = []
      const words: Word[] = args.words.map((w, index) => {
        let id = w.id
        if (id) {
          if (used.has(id)) problems.push(`word id ${id} is used twice`)
          if (otherIds.has(id)) problems.push(`word id ${id} already belongs to another source`)
        } else {
          id = `${args.source_id}_w${index}`
          let n = 2
          while (used.has(id) || otherIds.has(id) || args.words.some((x) => x.id === id)) id = `${args.source_id}_w${index}_${n++}`
        }
        used.add(id)
        if (w.end < w.start) problems.push(`word ${id} ("${w.text}") ends before it starts`)
        const old = previous.get(id)
        return {
          ...(old ?? {}),
          id,
          text: w.text,
          start: w.start,
          end: w.end,
          ...(w.prob !== undefined ? { prob: w.prob } : {}),
          ...(old?.emphasis ? { emphasis: true } : {})
        }
      })
      if (problems.length) throw new ToolError(`Transcript not saved: ${problems.slice(0, 10).join('; ')}`)
      words.sort((a, b) => a.start - b.start)
      const kept = new Set(words.map((w) => w.id))
      const lost = [...previous.keys()].filter((id) => !kept.has(id))
      env.mutate(`Save transcript (${words.length} words)`, (d) => {
        d.transcript.clips[args.source_id] = { ...(d.transcript.clips[args.source_id] ?? {}), ...(args.language ? { language: args.language } : {}), words }
        d.transcript.updatedAt = new Date().toISOString()
        d.project.transcript.updatedAt = d.transcript.updatedAt
      })
      const lostSet = new Set(lost)
      const brokenAnchors = env.store.project.items
        .filter((i) => i.type !== 'segment' && i.anchor.kind === 'word' && lostSet.has(i.anchor.wordId))
        .map((i) => i.id)
      return json({
        sourceId: args.source_id,
        words: words.length,
        firstIds: words.slice(0, 3).map((w) => w.id),
        removedWordIds: lost.length,
        ...(brokenAnchors.length ? { warning: `These items were anchored to words that are gone; re-anchor them: ${brokenAnchors.join(', ')}` } : {})
      })
    }
  }),

  defineTool({
    name: 'set_aroll_cuts',
    description:
      'Apply your edit decision list: the full ordered list of kept A-roll pieces, [{source_id, in, out, speed?, hold?, muted?, volume?}] in ' +
      'source seconds. They play one after another in this order. This replaces every segment on the A-roll track. Give the id of each ' +
      'segment you keep unchanged (or the same source_id/in/out) so its id stays the same. Items anchored to words move with the words. ' +
      'The app applies the cuts exactly as given and adjusts nothing.',
    input: {
      segments: z.array(segmentInput),
      track_id: z.string().optional().describe('A-roll track id; default the first A-roll track')
    },
    run: (args, env) => {
      const doc = env.store.snapshotDoc()
      const track = findTrack(doc, args.track_id ?? 'aroll')
      if (track.kind !== 'aroll') throw new ToolError(`Track ${track.id} is not an A-roll track.`)
      const old = doc.project.items.filter((i): i is SegmentItem => i.type === 'segment' && i.trackId === track.id)
      const byId = new Map(old.map((s) => [s.id, s]))
      const taken = new Set<string>()
      const problems: string[] = []
      const next: SegmentItem[] = args.segments.map((s, n) => {
        const src = sourceById(doc, s.source_id)
        if (!s.hold && s.out <= s.in) problems.push(`#${n}: out (${s.out}) must be after in (${s.in})`)
        if (src.duration && s.in > src.duration + 0.05) problems.push(`#${n}: in ${s.in}s is past the end of ${s.source_id} (${src.duration}s)`)
        let prev = s.id ? byId.get(s.id) : undefined
        if (s.id && !prev && doc.project.items.some((i) => i.id === s.id)) problems.push(`#${n}: id ${s.id} belongs to another item`)
        if (!prev && !s.id) prev = old.find((o) => !taken.has(o.id) && o.sourceId === s.source_id && Math.abs(o.in - s.in) < EPS && Math.abs(o.out - s.out) < EPS)
        let id = prev?.id ?? s.id ?? newId('seg')
        if (taken.has(id)) id = newId('seg')
        taken.add(id)
        const seg: SegmentItem = {
          ...(prev ?? {}),
          id,
          trackId: track.id,
          type: 'segment',
          createdBy: prev?.createdBy ?? 'claude',
          sourceId: s.source_id,
          in: s.in,
          out: s.hold ? Math.max(s.out, s.in) : s.out,
          speed: s.speed ?? 1,
          volume: s.volume ?? 0,
          fadeIn: s.fade_in ?? 0,
          fadeOut: s.fade_out ?? 0
        }
        if (s.hold !== undefined && s.hold > 0) seg.hold = s.hold
        else delete seg.hold
        if (s.muted) seg.muted = true
        else delete seg.muted
        if (s.label !== undefined) seg.label = s.label
        return seg
      })
      if (problems.length) throw new ToolError(`Cuts not applied: ${problems.slice(0, 10).join('; ')}`)
      env.mutate(`Set A-roll cuts (${next.length} segments)`, (d) => {
        const firstIdx = d.project.items.findIndex((i) => i.type === 'segment' && i.trackId === track.id)
        const rest = d.project.items.filter((i) => !(i.type === 'segment' && i.trackId === track.id))
        const at = firstIdx < 0 ? 0 : d.project.items.slice(0, firstIdx).filter((i) => !(i.type === 'segment' && i.trackId === track.id)).length
        rest.splice(at, 0, ...next)
        d.project.items = rest
      })
      const r = env.resolver()
      const orphaned = r.resolveAll().filter((x) => x.orphaned).map((x) => x.item.id)
      const kept = new Set(next.map((s) => s.id))
      return json({
        segments: r.segments.filter((s) => s.item.trackId === track.id).map((s) => ({ id: s.item.id, sourceId: s.item.sourceId, in: s.item.in, out: s.item.out, start: round3(s.start), end: round3(s.end) })),
        removed: old.filter((o) => !kept.has(o.id)).map((o) => o.id),
        timelineDuration: round3(r.duration),
        ...(orphaned.length ? { warning: `These items are anchored to words that are now cut out; they follow the next kept word. Re-anchor them if that is wrong: ${orphaned.join(', ')}` } : {})
      })
    }
  }),

  defineTool({
    name: 'adjust_cut',
    description:
      'Move one edge of one A-roll segment to a new SOURCE time (for example after reading get_audio_energy in 5 ms steps). ' +
      'edge "in" is where the piece starts in the source, "out" where it ends. Everything after it shifts to stay in sync.',
    input: { segment_id: z.string(), edge: z.enum(['in', 'out']), time: num.min(0) },
    run: (args, env) => {
      const doc = env.store.snapshotDoc()
      const seg = doc.project.items.find((i) => i.id === args.segment_id)
      if (!seg || seg.type !== 'segment') throw new ToolError(`No A-roll segment "${args.segment_id}".`)
      const before = { in: seg.in, out: seg.out, duration: segmentDuration(seg) }
      const nextIn = args.edge === 'in' ? args.time : seg.in
      const nextOut = args.edge === 'out' ? args.time : seg.out
      if (!seg.hold && nextOut <= nextIn) throw new ToolError(`That would make the segment end (${nextOut}s) before it starts (${nextIn}s).`)
      env.mutate(`Adjust cut ${args.edge} of ${args.segment_id}`, (d) => {
        const s = d.project.items.find((i) => i.id === args.segment_id) as SegmentItem
        s[args.edge] = args.time
      })
      const r = env.resolver()
      const placed = r.segments.find((s) => s.item.id === args.segment_id)!
      return json({
        segmentId: args.segment_id,
        before,
        after: { in: placed.item.in, out: placed.item.out, duration: round3(placed.end - placed.start) },
        timelineStart: round3(placed.start),
        timelineEnd: round3(placed.end),
        shift: round3(placed.end - placed.start - before.duration)
      })
    }
  })
]
