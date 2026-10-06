/**
 * Exports: the whole timeline or a selected section, rendered on this PC by the engine's `export` command
 * from the original footage (never proxies). One export runs at a time; you can keep reviewing meanwhile.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { buildSrt } from '@shared/captions'
import type { RenderJobState } from '@shared/ipc'
import type { ExportPreset, Range } from '@shared/project'
import type { AppContext, ExportOptions, RenderJobs } from '../context'
import { buildPlan, planDuration } from './plan'
import { isCancelled } from './engine'
import { audioHash, cachedMix } from './preview'

/** The quick check preset: small, fast, CPU encoder allowed. */
export const QUICK_PRESET: ExportPreset = { name: 'Quick check', width: 960, height: 540, fps: 30, quality: 'draft', codec: 'h264' }

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** "02-10" for 130 seconds. */
export function mmss(t: number): string {
  const s = Math.max(0, Math.floor(t))
  return `${pad(Math.floor(s / 60))}-${pad(s % 60)}`
}

/** Characters Windows does not allow in file names become "_". */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  return cleaned || 'export'
}

/** exports/<project>_<whole|mm-ss_to_mm-ss>_<YYYY-MM-DD_HH-mm>.mp4 */
export function exportFileName(projectName: string, range: Range | undefined, when = new Date()): string {
  const part = range ? `${mmss(range.start)}_to_${mmss(range.end)}` : 'whole'
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}_${pad(when.getHours())}-${pad(when.getMinutes())}`
  return `${safeFileName(projectName)}_${part}_${stamp}.mp4`
}

function uniquePath(dir: string, file: string): string {
  let out = join(dir, file)
  for (let i = 2; existsSync(out); i++) out = join(dir, file.replace(/\.mp4$/, ` (${i}).mp4`))
  return out
}

export function createRenderJobs(ctx: AppContext): RenderJobs {
  const listeners = new Set<(j: RenderJobState) => void>()
  let current: { state: RenderJobState; controller: AbortController } | null = null
  let last: string | null = null

  const emit = (state: RenderJobState) => {
    if (current && current.state.id === state.id) current.state = state
    for (const cb of listeners) {
      try {
        cb(state)
      } catch {
        /* a listener problem must not stop the export */
      }
    }
    ctx.send('render:job', state)
  }

  const start = async (opts: ExportOptions): Promise<string> => {
    if (current) throw new Error('An export is already running. Wait for it to finish or cancel it first.')
    const store = ctx.projects.current()
    if (!store) throw new Error('Open a project to export.')
    const missing = ctx.projects.missingSources()
    if (missing.length) throw new Error(`Some footage files cannot be found (${missing.length}). Relink them before exporting.`)

    const doc = store.snapshotDoc()
    const projectDir = store.dir
    const preset = opts.quick ? QUICK_PRESET : opts.preset
    const range = opts.range && opts.range.end > opts.range.start ? opts.range : undefined
    const burn = opts.captions === 'burn' || opts.captions === 'both'
    const srt = opts.captions === 'srt' || opts.captions === 'both'
    const kind: RenderJobState['kind'] = opts.quick ? 'quick_export' : range ? 'section_export' : 'export'
    const id = `exp_${randomBytes(4).toString('hex')}`

    const plan = buildPlan(doc, { projectDir, width: preset.width, height: preset.height, fps: preset.fps, burnCaptions: burn })
    const duration = planDuration(plan)
    if (duration <= 0) throw new Error('There is nothing on the timeline to export yet.')
    // Use the loudness the preview already measured for this exact mix, so preview and export match.
    const mix = cachedMix(projectDir, audioHash(plan, undefined, duration))
    if (mix && typeof mix.masterGainDb === 'number') plan.audio.masterGainDb = mix.masterGainDb

    const outDir = opts.outDir || ctx.settings.get().defaultExportsFolder || store.paths.exports
    mkdirSync(outDir, { recursive: true })
    const out = uniquePath(outDir, exportFileName(doc.project.name, range))
    const planFile = ctx.engine.writePlan(plan, join(store.paths.cache, 'plans'), `export-${id}`)

    try {
      ctx.versions.save(`Before export ${range ? `${mmss(range.start)} to ${mmss(range.end)}` : 'whole video'}`, { auto: true, reason: 'export' })
    } catch (err) {
      store.log.write('error', 'Could not save the automatic version before export', { error: (err as Error).message })
    }

    const args = ['export', '--plan', planFile, '--out', out, '--quality', preset.quality, '--codec', preset.codec, '--encoder', 'auto']
    if (range) args.push('--start', String(range.start), '--end', String(Math.min(range.end, duration)))
    const settingsSummary = {
      kind,
      preset,
      range: range ?? 'whole',
      captions: opts.captions,
      out,
      engineVersion: plan.engineVersion,
      masterGainDb: plan.audio.masterGainDb
    }
    store.log.write('export', `Export started: ${kind === 'section_export' ? 'selected section' : kind === 'quick_export' ? 'quick check' : 'whole video'}`, settingsSummary)

    const srtFile = out.replace(/\.mp4$/, '.srt')
    const controller = new AbortController()
    const state: RenderJobState = { id, kind, status: 'running', percent: 0, message: `Exporting ${preset.width}x${preset.height}…` }
    current = { state, controller }
    emit(state)
    const started = Date.now()

    void (async () => {
      try {
        if (srt) writeFileSync(srtFile, buildSrt(doc, range))
        const result = (await ctx.engine.run(plan.engineVersion, args, {
          signal: controller.signal,
          onEvent: (e) => {
            if (e.event !== 'progress') return
            const done = Number(e.done ?? 0)
            const total = Number(e.total ?? 0)
            const percent = total > 0 ? Math.min(99.9, (done / total) * 100) : current?.state.percent ?? 0
            const fps = typeof e.fps === 'number' ? e.fps : undefined
            emit({ ...current!.state, percent: Math.round(percent * 10) / 10, fps, message: typeof e.message === 'string' ? e.message : current!.state.message })
          }
        })) as { out?: string; duration?: number; ffmpegCommand?: string; encoder?: string; lufs?: number } | null
        const seconds = (Date.now() - started) / 1000
        const file = result?.out ?? out
        last = file
        store.log.write('export', `Export finished in ${seconds.toFixed(0)} s`, {
          out: file,
          videoDuration: result?.duration,
          encoder: result?.encoder,
          lufs: result?.lufs,
          ffmpegCommand: result?.ffmpegCommand
        })
        if (kind === 'export' && ctx.projects.current() === store && !store.readOnly) {
          try {
            store.mutate('Exported', 'app', (d) => {
              d.project.status = 'exported'
            }, { bypassLock: true, noHistory: true })
          } catch (err) {
            store.log.write('error', 'Could not mark the project exported', { error: (err as Error).message })
          }
        }
        emit({ ...current!.state, status: 'done', percent: 100, out: file, message: `Saved ${file}` })
      } catch (err) {
        rmSync(out, { force: true })
        if (srt) rmSync(srtFile, { force: true })
        if (isCancelled(err)) {
          store.log.write('export', `Export cancelled after ${((Date.now() - started) / 1000).toFixed(0)} s`)
          emit({ ...current!.state, status: 'cancelled', message: 'Export cancelled.' })
        } else {
          const message = (err as Error).message || 'The export failed.'
          store.log.write('export', `Export failed: ${message}`, { ...settingsSummary, error: message })
          emit({ ...current!.state, status: 'error', error: message, message: `The export failed: ${message}` })
        }
      } finally {
        rmSync(planFile, { force: true })
        current = null
      }
    })()
    return id
  }

  return {
    start,
    cancel() {
      current?.controller.abort()
    },
    isBusy: () => !!current,
    onJob(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    lastOutput: () => last
  }
}
