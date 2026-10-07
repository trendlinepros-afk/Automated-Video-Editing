/**
 * The check before export. Two parts, neither uses Claude:
 *  - the timeline: missing footage or files, items tied to words that were cut, Claude still working, changes
 *    waiting for Keep or Revert, the self-check not done;
 *  - the finished picture and sound, measured on the preview (the same compositor and the same mix as the export):
 *    black stretches, frozen picture, dead air, loudness off target and peaks that would distort.
 * Photos, freeze frames and fades the edit asks for are not reported.
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { ExportCheckResult, ExportProblem } from '@shared/exportCheck'
import type { Range } from '@shared/project'
import { TimelineResolver, formatTime } from '@shared/timeline'
import { itemName } from '@shared/describe'
import type { AppContext } from '../context'
import type { ProjectStore } from '../project/store'
import { buildPlan } from '../engine/plan'
import { spawnLines } from '../engine/engine'

interface QcResult {
  black: Range[]
  frozen: Range[]
  hasAudio: boolean
  silence?: Range[]
  lufs?: number | null
  truePeakDb?: number | null
}

const overlaps = (a: Range, b: Range) => a.start < b.end && b.start < a.end
const t = (s: number) => formatTime(Math.max(0, s), true)
const span = (r: Range) => `${t(r.start)} to ${t(r.end)}`

/** Timeline problems: fast, no rendering. */
export function timelineProblems(ctx: AppContext, store: ProjectStore, range?: Range): ExportProblem[] {
  const doc = store.snapshotDoc()
  const p = doc.project
  const out: ExportProblem[] = []
  const missing = new Set(ctx.projects.missingSources())
  for (const s of p.sources.filter((x) => missing.has(x.id) && p.items.some((i) => (i as { sourceId?: string }).sourceId === x.id))) {
    out.push({ id: `missing_${s.id}`, severity: 'error', title: `Footage not found: ${s.path}`, detail: 'Relink it (the warning at the top of the editor) or the export will fail.' })
  }
  const resolver = new TimelineResolver(p, doc.transcript)
  const inRange = (r: Range) => !range || overlaps(r, range)
  for (const item of p.items) {
    const r = resolver.resolveItem(item)
    if (!inRange({ start: r.start, end: r.end })) continue
    const files = [(item as { file?: string }).file, (item as { picture?: { file: string } }).picture?.file].filter(Boolean) as string[]
    for (const f of files) {
      if (!existsSync(isAbsolute(f) ? f : join(store.dir, f))) {
        out.push({ id: `file_${item.id}`, severity: 'error', title: `File missing for ${itemName(p, item)}`, detail: f, range: { start: r.start, end: r.end } })
      }
    }
    if (item.type !== 'segment' && r.orphaned) {
      out.push({
        id: `orphan_${item.id}`,
        severity: 'warning',
        title: `${itemName(p, item)} lost its word`,
        detail: 'The word it was tied to was cut, so it now follows the next kept word. Check that it still lands in the right place.',
        range: { start: r.start, end: r.end }
      })
    }
  }
  const open = p.requests.filter((r) => r.status === 'queued' || r.status === 'in_progress')
  if (open.length) out.push({ id: 'open_requests', severity: 'warning', title: `Claude still has ${open.length} request${open.length > 1 ? 's' : ''} open`, detail: 'The export would not include what Claude is still doing.' })
  const pending = p.requests.filter((r) => r.review === 'pending')
  if (pending.length) out.push({ id: 'pending_review', severity: 'info', title: `${pending.length} change${pending.length > 1 ? 's' : ''} waiting for Keep or Revert`, detail: 'They are in the video as it stands; the export uses them.' })
  const notes = p.notes.filter((n) => n.status === 'open')
  if (notes.length) out.push({ id: 'open_notes', severity: 'info', title: `${notes.length} note${notes.length > 1 ? 's' : ''} for Claude not done yet` })
  const selfCheck = p.checklist.find((c) => c.id === 'self_check')
  if (p.items.some((i) => i.type === 'segment') && selfCheck && selfCheck.status !== 'done' && p.status !== 'new') {
    out.push({ id: 'self_check', severity: 'warning', title: 'The self-check has not run', detail: 'Claude re-transcribes the cut to catch clipped or doubled words. Ask Claude to run it, or export anyway.' })
  }
  if (p.captions.enabled && !Object.keys(doc.transcript.clips).length) {
    out.push({ id: 'no_transcript', severity: 'warning', title: 'Captions are on but there is no transcript', detail: 'The export would have no captions.' })
  }
  return out
}

/** Ranges where a still or a fade is part of the edit: photos, freeze frames, and fades in and out of black. */
export function intendedStills(ctx: AppContext, store: ProjectStore): { stills: Range[]; fades: Range[] } {
  const doc = store.snapshotDoc()
  const plan = buildPlan(doc, { projectDir: store.dir, width: 320, height: 180, fps: 30, burnCaptions: false })
  const stills: Range[] = []
  const fades: Range[] = []
  for (const l of plan.layers) {
    if (l.kind !== 'video') continue
    if (l.isImage || l.hold) stills.push({ start: l.start, end: l.end })
    if (l.fadeIn) fades.push({ start: l.start, end: l.start + l.fadeIn + 0.2 })
    if (l.fadeOut) fades.push({ start: l.end - l.fadeOut - 0.2, end: l.end })
  }
  for (const l of plan.layers) {
    if (l.kind === 'effect' && (l.effect === 'freeze' || l.effect === 'replay')) stills.push({ start: l.start, end: l.end })
  }
  void ctx
  return { stills, fades }
}

export function renderProblems(qc: QcResult, opts: { targetLufs: number; stills: Range[]; fades: Range[]; duration: number; from?: number }): ExportProblem[] {
  const from = opts.from ?? 0
  const out: ExportProblem[] = []
  const covered = (r: Range, by: Range[], share: number) => {
    const len = r.end - r.start
    const hit = by.reduce((s, b) => s + Math.max(0, Math.min(r.end, b.end) - Math.max(r.start, b.start)), 0)
    return len > 0 && hit / len >= share
  }
  for (const b of qc.black) {
    const atEdge = b.start < from + 0.6 || b.end > opts.duration - 0.6
    if (covered(b, opts.fades, 0.5) || (atEdge && b.end - b.start < 1.5)) continue
    out.push({ id: `black_${b.start}`, severity: 'warning', title: `Black screen for ${(b.end - b.start).toFixed(1)} s`, detail: `${span(b)}: nothing on screen.`, range: b })
  }
  for (const f of qc.frozen) {
    if (covered(f, opts.stills, 0.6)) continue
    out.push({ id: `frozen_${f.start}`, severity: 'warning', title: `Picture frozen for ${(f.end - f.start).toFixed(1)} s`, detail: `${span(f)}: the picture does not change. Footage missing, or a clip ran past its end?`, range: f })
  }
  if (qc.hasAudio) {
    for (const s of qc.silence ?? []) {
      if (s.start < from + 0.5 || s.end > opts.duration - 0.5) continue
      out.push({ id: `silence_${s.start}`, severity: 'warning', title: `${(s.end - s.start).toFixed(1)} s of silence`, detail: `${span(s)}: no voice, music or sound. Dead air, or a muted clip?`, range: s })
    }
    if (typeof qc.lufs === 'number' && Math.abs(qc.lufs - opts.targetLufs) > 2) {
      out.push({
        id: 'loudness',
        severity: 'warning',
        title: `Loudness ${qc.lufs.toFixed(1)} LUFS, the target is ${opts.targetLufs}`,
        detail: qc.lufs < opts.targetLufs ? 'It will sound quieter than other videos.' : 'It will be turned down by YouTube and may sound squashed.'
      })
    }
    if (typeof qc.truePeakDb === 'number' && qc.truePeakDb > -0.5) {
      out.push({ id: 'peak', severity: 'warning', title: `Peaks reach ${qc.truePeakDb.toFixed(1)} dB`, detail: 'Loud moments may distort after upload. Lower the loudest sound or the music.' })
    }
  } else if (opts.duration > 1) {
    out.push({ id: 'no_audio', severity: 'warning', title: 'The video has no sound' })
  }
  return out
}

async function runQc(ctx: AppContext, video: string, range?: Range): Promise<QcResult> {
  const script = ctx.env.analysisScript().replace(/style\.py$/, 'qc.py')
  let result: QcResult | null = null
  let error: string | null = null
  const args = [script, '--ffmpeg', ctx.env.ffmpeg(), '--video', video, ...(range ? ['--start', String(range.start), '--end', String(range.end)] : [])]
  const r = await spawnLines(ctx.env.python(), args, {
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    onLine: (line) => {
      try {
        const e = JSON.parse(line)
        if (e.event === 'result') result = e.data
        if (e.event === 'error') error = String(e.message)
      } catch {
        /* not an event */
      }
    }
  })
  if (!result) throw new Error(error ?? (r.stderr.trim().split('\n').pop() || 'the check did not finish'))
  return result
}

/** Waits for the preview to finish rendering (it is rebuilt after every change). */
async function readyPreview(ctx: AppContext, timeoutMs: number): Promise<string | null> {
  const ok = (s: ReturnType<AppContext['preview']['state']>) => s.status === 'ready' && !s.chunksPending && s.file
  let s = ctx.preview.state()
  if (ok(s)) return s.file!
  if (s.status === 'unavailable' || s.status === 'error') return null
  if (s.status === 'idle') ctx.preview.invalidate()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off()
      resolve(null)
    }, timeoutMs)
    const off = ctx.preview.onState((n) => {
      s = n
      if (ok(n) || n.status === 'error' || n.status === 'unavailable') {
        clearTimeout(timer)
        off()
        resolve(ok(n) ? n.file! : null)
      }
    })
  })
}

export async function runExportCheck(ctx: AppContext, store: ProjectStore, opts: { range?: Range; onProgress?: (msg: string) => void } = {}): Promise<ExportCheckResult> {
  const checked = ['the timeline (missing files, items that lost their word, open requests)']
  const skipped: string[] = []
  const problems = timelineProblems(ctx, store, opts.range)
  if (problems.some((p) => p.severity === 'error')) {
    skipped.push('the picture and sound: fix the missing files first')
  } else {
    opts.onProgress?.('Waiting for the preview to finish…')
    const file = await readyPreview(ctx, 10 * 60_000)
    if (!file) {
      skipped.push('the picture and sound: the preview is not available')
    } else {
      opts.onProgress?.('Checking the picture and sound…')
      try {
        const qc = await runQc(ctx, file, opts.range)
        const doc = store.snapshotDoc()
        const duration = new TimelineResolver(doc.project, doc.transcript).duration
        problems.push(...renderProblems(qc, { targetLufs: doc.project.settings.mix.targetLufs, ...intendedStills(ctx, store), duration: opts.range ? opts.range.end : duration, from: opts.range?.start }))
        checked.push('the picture (black or frozen stretches)', 'the sound (silence, loudness, peaks)')
      } catch (err) {
        skipped.push(`the picture and sound: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  const order = { error: 0, warning: 1, info: 2 }
  problems.sort((a, b) => order[a.severity] - order[b.severity] || (a.range?.start ?? -1) - (b.range?.start ?? -1))
  store.log.write('render', `Export check: ${problems.length ? `${problems.length} problem${problems.length > 1 ? 's' : ''}` : 'no problems'}`, {
    problems: problems.map((p) => `${p.severity}: ${p.title}`),
    skipped
  })
  return { problems, checked, skipped }
}
