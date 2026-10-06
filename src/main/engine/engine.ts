/**
 * Runs the Python render engine: `python -m ave_engine [--ffmpeg F --ffprobe P] <cmd> ...`, with the
 * engine folder of the version a project was made with as the working folder.
 * The engine prints one JSON object per line; the last {"event":"result"} is the answer.
 * Every command is written to the open project's log (or the app log) with the full command line.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { ENGINE_VERSION } from '@shared/appInfo'
import type { RenderPlan } from '@shared/plan'
import type { AppContext, EngineRunOptions, EngineService } from '../context'
import type { ActivityLog } from '../log'
import { projectPaths } from '../paths'
import { buildPlan } from './plan'

export class EngineError extends Error {
  constructor(
    message: string,
    readonly output = ''
  ) {
    super(message)
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'AbortError'
  }
}

/** Quotes a command line for the log, so it can be pasted into a terminal. */
export function formatCommand(cmd: string, args: string[]): string {
  return [cmd, ...args].map((a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)).join(' ')
}

/** Ends a process and everything it started (ffmpeg children included). */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill())
  } else {
    try {
      // Detached children lead their own process group: kill the whole group.
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

export interface SpawnResult {
  code: number
  stderr: string
}

/**
 * Spawns a program, streaming stdout lines to onLine. Rejects with CancelledError when the signal aborts.
 * Used for the engine and for plain ffmpeg runs (preview concat, seam audio).
 */
export function spawnLines(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; onLine?: (line: string) => void }
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new CancelledError())
      return
    }
    let child: ChildProcess
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        windowsHide: true,
        detached: process.platform !== 'win32'
      })
    } catch (err) {
      reject(err)
      return
    }
    let stderr = ''
    let partial = ''
    let cancelled = false
    const onAbort = () => {
      cancelled = true
      killTree(child)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout!.on('data', (chunk: Buffer) => {
      partial += chunk.toString('utf8')
      const lines = partial.split(/\r?\n/)
      partial = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) opts.onLine?.(l)
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-64_000)
    })
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? new EngineError(`Could not start ${cmd}. The render engine may not be installed yet.`)
          : err
      )
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (partial.trim()) opts.onLine?.(partial)
      if (cancelled) reject(new CancelledError())
      else resolve({ code: code ?? -1, stderr })
    })
  })
}

export function isCancelled(err: unknown): boolean {
  return err instanceof CancelledError || (err instanceof Error && err.name === 'AbortError')
}

function shortHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12)
}

/** Output size for a given width, keeping the project's aspect ratio (even numbers, as encoders need). */
export function sizeForWidth(design: { width: number; height: number }, width: number): { width: number; height: number } {
  const w = Math.max(2, Math.round(width / 2) * 2)
  return { width: w, height: Math.max(2, Math.round((w * design.height) / design.width / 2) * 2) }
}

export function sizeForHeight(design: { width: number; height: number }, height: number): { width: number; height: number } {
  const h = Math.max(2, Math.round(height / 2) * 2)
  return { width: Math.max(2, Math.round((h * design.width) / design.height / 2) * 2), height: h }
}

export function createEngineService(ctx: AppContext): EngineService {
  const log = (): ActivityLog => ctx.projects.current()?.log ?? ctx.appLog
  const currentVersion = (): string => ctx.projects.current()?.project.engineVersion || ENGINE_VERSION

  const run = async (engineVersion: string, args: string[], opts: EngineRunOptions = {}): Promise<unknown> => {
    const py = ctx.env.python()
    const fullArgs = ['-m', 'ave_engine', '--ffmpeg', ctx.env.ffmpeg(), '--ffprobe', ctx.env.ffprobe(), ...args]
    const command = formatCommand(py, fullArgs)
    const started = Date.now()
    let cwd: string
    try {
      cwd = ctx.env.engineDir(engineVersion || ENGINE_VERSION)
    } catch (err) {
      log().write('render', `Engine command could not start: ${args[0]}`, { command, error: (err as Error).message })
      throw err
    }
    let result: unknown = undefined
    let gotResult = false
    let engineError: string | null = null
    let trace: string | undefined
    const logLines: string[] = []
    let res: SpawnResult
    try {
      res = await spawnLines(py, fullArgs, {
        cwd,
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
        signal: opts.signal,
        onLine: (line) => {
          let e: { event?: string; [k: string]: unknown }
          try {
            e = JSON.parse(line)
          } catch {
            logLines.push(line)
            if (logLines.length > 50) logLines.shift()
            return
          }
          if (!e || typeof e.event !== 'string') return
          if (e.event === 'result') {
            result = e.data
            gotResult = true
          } else if (e.event === 'error') {
            engineError = String(e.message ?? 'The engine reported an error')
            trace = typeof e.trace === 'string' ? e.trace : undefined
          } else if (e.event === 'log') {
            logLines.push(`[${e.level ?? 'info'}] ${e.message ?? ''}`)
            if (logLines.length > 50) logLines.shift()
          }
          try {
            opts.onEvent?.(e as { event: string })
          } catch {
            /* a listener problem must not stop the render */
          }
        }
      })
    } catch (err) {
      const seconds = (Date.now() - started) / 1000
      if (isCancelled(err)) {
        log().write('render', `Engine ${args[0]} cancelled after ${seconds.toFixed(1)} s`, { command })
      } else {
        log().write('render', `Engine ${args[0]} could not run`, { command, error: (err as Error).message })
      }
      throw err
    }
    const seconds = (Date.now() - started) / 1000
    if (engineError || res.code !== 0 || !gotResult) {
      const message =
        engineError ??
        (lastLines(res.stderr) || (res.code !== 0 ? `The engine stopped with exit code ${res.code}` : 'The engine finished without a result'))
      log().write('render', `Engine ${args[0]} failed after ${seconds.toFixed(1)} s: ${message}`, {
        command,
        engineVersion,
        exitCode: res.code,
        errorOutput: (trace ? trace + '\n' : '') + res.stderr.slice(-6000),
        engineLog: logLines.slice(-20)
      })
      throw new EngineError(message, res.stderr)
    }
    log().write('render', `Engine ${args[0]} finished in ${seconds.toFixed(1)} s`, { command, engineVersion })
    return result
  }

  const writePlan = (plan: RenderPlan, dir: string, name = 'plan'): string => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, name.endsWith('.json') ? name : `${name}.json`)
    writeFileSync(file, JSON.stringify(plan))
    return file
  }

  const planFor = (doc: Parameters<EngineService['frame']>[0], projectDir: string, width: number) => {
    const size = sizeForWidth(doc.project.output, width)
    return buildPlan(doc, { projectDir, width: size.width, height: size.height, fps: doc.project.output.fps, burnCaptions: true })
  }

  const frame: EngineService['frame'] = async (doc, projectDir, time, opts = {}) => {
    const plan = planFor(doc, projectDir, opts.width ?? 960)
    const p = projectPaths(projectDir)
    const planText = JSON.stringify(plan)
    const key = shortHash(planText + time + (opts.footageOnly ? 'f' : ''))
    const planFile = writePlan(plan, join(p.cache, 'plans'), `frame-${key}`)
    const out = opts.out ?? join(p.cache, 'frames', `frame-${Math.round(time * 1000)}-${key}.png`)
    mkdirSync(join(out, '..'), { recursive: true })
    const args = ['frame', '--plan', planFile, '--time', String(time), '--out', out]
    if (opts.footageOnly) args.push('--footage-only')
    const result = (await run(plan.engineVersion, args)) as { out?: string } | null
    return result?.out ?? out
  }

  const frames: EngineService['frames'] = async (doc, projectDir, times, opts = {}) => {
    if (!times.length) return []
    const plan = planFor(doc, projectDir, opts.width ?? 960)
    const p = projectPaths(projectDir)
    const key = shortHash(JSON.stringify(plan) + times.join(','))
    const planFile = writePlan(plan, join(p.cache, 'plans'), `frames-${key}`)
    const outDir = opts.outDir ?? join(p.cache, 'frames', `set-${key}`)
    mkdirSync(outDir, { recursive: true })
    const result = (await run(plan.engineVersion, ['frames', '--plan', planFile, '--times', times.map((t) => String(t)).join(','), '--out-dir', outDir])) as {
      files?: string[]
    } | null
    return result?.files ?? []
  }

  const graphicPreview: EngineService['graphicPreview'] = async (projectDir, file, opts) => {
    mkdirSync(opts.outDir, { recursive: true })
    const args = [
      'graphic-preview',
      '--file',
      isAbsolute(file) ? file : join(projectDir, file),
      '--params',
      JSON.stringify(opts.params ?? {}),
      '--duration',
      String(opts.duration),
      '--times',
      opts.times.map((t) => String(t)).join(','),
      '--width',
      String(opts.width),
      '--height',
      String(opts.height),
      '--out-dir',
      opts.outDir
    ]
    if (opts.brand) {
      const brandFile = join(opts.outDir, 'brand.json')
      writeFileSync(brandFile, JSON.stringify(opts.brand))
      args.push('--brand', brandFile)
    }
    const result = (await run(currentVersion(), args)) as { files?: string[] } | null
    return result?.files ?? []
  }

  return {
    run,
    writePlan,
    frame,
    frames,
    graphicPreview,
    energy: async (path, start, end, stepMs) =>
      (await run(currentVersion(), ['energy', '--path', path, '--start', String(start), '--end', String(end), '--step-ms', String(stepMs)])) as {
        stepMs: number
        start: number
        db: number[]
      },
    snippet: async (path, start, end, out) => {
      mkdirSync(join(out, '..'), { recursive: true })
      const r = (await run(currentVersion(), ['snippet', '--path', path, '--start', String(start), '--end', String(end), '--out', out])) as { out?: string } | null
      return r?.out ?? out
    },
    peaks: async (path, perSecond) => {
      const r = (await run(currentVersion(), ['peaks', '--path', path, '--per-second', String(perSecond)])) as { peaks?: number[] } | null
      return r?.peaks ?? []
    },
    loudness: async (path) => (await run(currentVersion(), ['loudness', '--path', path])) as { lufs: number; truePeakDb: number },
    probe: async (path) =>
      (await run(currentVersion(), ['probe', '--path', path])) as Awaited<ReturnType<EngineService['probe']>>
  }
}

function lastLines(text: string, n = 3): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(' ')
    .slice(0, 600)
}
