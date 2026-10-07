/**
 * Shorts: after Claude saves a Short, the app finds the subject in each piece (reframe.py), renders a low-resolution
 * preview, and on request exports the full 1080x1920 file with a text file of its titles, description and hashtags.
 * One job at a time, in the order asked.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { SHORT_PREVIEW_SIZE, SHORT_SIZE, shortDuration, type Short } from '@shared/shorts'
import type { ShortsState } from '@shared/ipc'
import type { AppContext } from '../context'
import type { ProjectStore } from '../project/store'
import { buildPlan } from '../engine/plan'
import { spawnLines } from '../engine/engine'
import { shortDoc } from './build'

export interface ShortsService {
  /** Track the subject and render the preview for a Short Claude just saved (queued). */
  prepare(id: string): void
  exportShort(id: string): Promise<string>
  exportAll(): Promise<string[]>
  state(): ShortsState
}

const BOOKKEEPING = { bypassLock: true, noHistory: true } as const

function safeName(s: string): string {
  return s.replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Short'
}

export function createShortsService(ctx: AppContext): ShortsService {
  let chain: Promise<unknown> = Promise.resolve()
  const state: ShortsState = { working: {} }
  const emit = () => ctx.send('shorts:state', state)
  const set = (id: string, message: string | null) => {
    if (message) state.working[id] = message
    else delete state.working[id]
    emit()
  }
  const queue = <T>(job: () => Promise<T>): Promise<T> => {
    const next = chain.then(job, job)
    chain = next.catch(() => undefined)
    return next
  }
  const store = (): ProjectStore => {
    const s = ctx.projects.current()
    if (!s) throw new Error('Open a project first.')
    return s
  }
  const find = (s: ProjectStore, id: string): Short => {
    const short = s.project.shorts?.find((x) => x.id === id)
    if (!short) throw new Error('That Short no longer exists.')
    return short
  }
  const update = (s: ProjectStore, id: string, patch: (x: Short) => void) =>
    s.mutate('Short updated', 'app', (d) => {
      const x = d.project.shorts?.find((y) => y.id === id)
      if (x) patch(x)
    }, BOOKKEEPING)

  /** Subject tracking for pieces with no framing yet. */
  const track = async (s: ProjectStore, short: Short) => {
    const todo = short.segments.map((g, i) => ({ g, i })).filter(({ g }) => g.focusX === undefined && !g.track)
    if (!todo.length) return
    const sources = new Map(s.project.sources.map((x) => [x.id, x]))
    const list = todo.map(({ g }) => ({ path: sources.get(g.sourceId)?.path ?? '', in: g.in, out: g.out }))
    const file = join(s.paths.cache, 'shorts', `reframe-${randomBytes(3).toString('hex')}.json`)
    mkdirSync(join(s.paths.cache, 'shorts'), { recursive: true })
    writeFileSync(file, JSON.stringify(list))
    let result: { points: { t: number; x: number; y: number }[] }[] | null = null
    let error = ''
    const script = ctx.env.analysisScript().replace(/style\.py$/, 'reframe.py')
    await spawnLines(ctx.env.python(), [script, '--ffmpeg', ctx.env.ffmpeg(), '--segments', file], {
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      onLine: (line) => {
        try {
          const e = JSON.parse(line)
          if (e.event === 'result') result = e.data
          if (e.event === 'error') error = String(e.message)
          if (e.event === 'progress') set(short.id, `${e.message}…`)
        } catch {
          /* not an event */
        }
      }
    })
    if (!result) {
      // Framing falls back to the centre; the Short still works.
      s.log.write('error', `Could not find the subject for the Short "${short.title}"`, { error })
      return
    }
    const r = result as { points: { t: number; x: number; y: number }[] }[]
    update(s, short.id, (x) => {
      todo.forEach(({ i }, k) => {
        if (x.segments[i] && r[k]) x.segments[i].track = r[k].points
      })
    })
  }

  const render = async (s: ProjectStore, short: Short, size: { width: number; height: number }, quality: string, out: string) => {
    const doc = shortDoc(s.snapshotDoc(), short, size)
    const plan = buildPlan(doc, { projectDir: s.dir, width: size.width, height: size.height, fps: doc.project.output.fps, burnCaptions: short.captions })
    const planFile = ctx.engine.writePlan(plan, join(s.paths.cache, 'plans'), `short-${short.id}-${randomBytes(2).toString('hex')}`)
    await ctx.engine.run(plan.engineVersion, ['export', '--plan', planFile, '--out', out, '--quality', quality, '--codec', 'h264', '--encoder', 'auto'], {
      onEvent: (e) => {
        if (e.event === 'progress' && Number(e.total) > 0) set(short.id, `Rendering… ${Math.round((Number(e.done) / Number(e.total)) * 100)}%`)
      }
    })
    return out
  }

  const prepare = (id: string) =>
    queue(async () => {
      const s = store()
      try {
        set(id, 'Finding the subject…')
        await track(s, find(s, id))
        set(id, 'Rendering the preview…')
        const dir = join(s.paths.cache, 'shorts')
        mkdirSync(dir, { recursive: true })
        const name = `${id}-${Date.now().toString(36)}.mp4`
        await render(s, find(s, id), SHORT_PREVIEW_SIZE, 'draft', join(dir, name))
        update(s, id, (x) => {
          x.preview = `cache/shorts/${name}`
        })
        s.log.write('render', `Short preview ready: ${find(s, id).title}`)
      } catch (err) {
        s.log.write('error', `Short preview failed`, { id, error: err instanceof Error ? err.message : String(err) })
        state.working[id] = `Preview failed: ${err instanceof Error ? err.message : String(err)}`
        emit()
        return
      }
      set(id, null)
    })

  const exportShort = (id: string) =>
    queue(async () => {
      const s = store()
      const short = find(s, id)
      try {
        if (short.segments.some((g) => g.focusX === undefined && !g.track)) await track(s, short)
        const dir = join(ctx.settings.get().defaultExportsFolder || s.paths.exports, 'Shorts')
        mkdirSync(dir, { recursive: true })
        const n = (s.project.shorts ?? []).findIndex((x) => x.id === id) + 1
        let base = `${safeName(s.project.name)} - Short ${n} - ${safeName(short.title)}`
        for (let k = 2; existsSync(join(dir, `${base}.mp4`)); k++) base = `${safeName(s.project.name)} - Short ${n} - ${safeName(short.title)} (${k})`
        set(id, 'Exporting…')
        const out = await render(s, find(s, id), SHORT_SIZE, 'best', join(dir, `${base}.mp4`))
        const x = find(s, id)
        writeFileSync(
          join(dir, `${base}.txt`),
          [
            `YouTube Shorts title: ${x.youtubeTitle || x.title}`,
            '',
            `TikTok caption: ${x.tiktokCaption || x.youtubeTitle || x.title}`,
            '',
            'Description:',
            x.description,
            '',
            `Hashtags: ${x.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}`,
            '',
            `Length: ${shortDuration(x).toFixed(1)} s`
          ].join('\r\n')
        )
        update(s, id, (y) => {
          y.exported = out
        })
        s.log.write('export', `Short exported: ${x.title}`, { out })
        set(id, null)
        return out
      } catch (err) {
        set(id, null)
        throw err
      }
    })

  return {
    prepare: (id) => void prepare(id),
    exportShort,
    async exportAll() {
      const s = store()
      const ids = (s.project.shorts ?? []).map((x) => x.id)
      const out: string[] = []
      for (const id of ids) out.push(await exportShort(id))
      return out
    },
    state: () => state
  }
}

/** The preview file of a Short as an absolute path. */
export function previewPath(dir: string, short: Short): string | null {
  if (!short.preview) return null
  const p = isAbsolute(short.preview) ? short.preview : join(dir, short.preview)
  return existsSync(p) ? p : null
}
