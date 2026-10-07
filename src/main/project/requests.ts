/**
 * The request queue: start edit, chat, section re-edits, clipped-audio fixes, intro decisions and
 * publishing-pack regeneration. Claude picks requests up through MCP; the runner starts Claude
 * when one is waiting.
 *
 * Requests that change the video save a Before version first, so Keep / Revert is instant.
 * While a range-scoped request is in progress, the section lock refuses Claude's changes outside it.
 */
import type { EditRequest, Range, RequestKind } from '@shared/project'
import type { AppContext, RequestInput, RequestService } from '../context'
import { newId, type ProjectStore } from './store'

/** Requests that change the video and so get Before / After with Keep and Revert. */
export const VERSIONED_KINDS: RequestKind[] = ['chat', 'reedit', 'fix_audio', 'stabilize', 'insert_clip', 'redo_intro', 'continue_intro']

export const REQUEST_LABELS: Record<RequestKind, string> = {
  start_edit: 'start edit',
  chat: 'chat request',
  reedit: 'section re-edit',
  fix_audio: 'clipped audio fix',
  stabilize: 'stabilize clip',
  insert_clip: 'new clip',
  make_shorts: 'Shorts',
  continue_intro: 'continue after the intro',
  redo_intro: 'intro redo',
  publish_regen: 'publishing pack update',
  thumbnail_direction: 'thumbnail direction',
  resume: 'resume'
}

/** Bookkeeping changes: not undoable, and allowed while a section is locked. */
const BOOKKEEPING = { bypassLock: true, noHistory: true } as const

/** "1:05.2–1:20.0" for log lines and version names. */
function rangeText(r: Range | undefined): string {
  if (!r) return ''
  const t = (s: number) => {
    if (s >= 1e8) return 'end'
    const m = Math.floor(s / 60)
    return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`
  }
  return `${t(r.start)}–${t(r.end)}`
}

export function createRequestService(ctx: AppContext): RequestService {
  const store = (): ProjectStore => {
    const s = ctx.projects.current()
    if (!s) throw new Error('No project is open.')
    return s
  }

  const find = (s: ProjectStore, id: string): EditRequest => {
    const r = s.project.requests.find((x) => x.id === id)
    if (!r) throw new Error(`Unknown request ${id}`)
    return r
  }

  return {
    enqueue(input: RequestInput) {
      const s = store()
      const id = newId('req')
      const now = new Date().toISOString()
      let beforeVersionId: string | undefined
      if (VERSIONED_KINDS.includes(input.kind)) {
        const where = input.range ? ` (${rangeText(input.range)})` : ''
        const v = ctx.versions.save(`Before ${REQUEST_LABELS[input.kind]}${where}`, { auto: true, reason: input.kind })
        beforeVersionId = v.id
      }
      const request: EditRequest = {
        id,
        kind: input.kind,
        status: 'queued',
        createdAt: now,
        text: input.text ?? '',
        context: input.context ?? {},
        ...(input.range ? { range: { start: Math.max(0, input.range.start), end: Math.max(input.range.start, input.range.end) } } : {}),
        ...(beforeVersionId ? { beforeVersionId } : {})
      }
      s.mutate(`Request: ${REQUEST_LABELS[input.kind]}`, 'app', (d) => {
        d.project.requests.push(request)
        if (input.kind === 'chat') {
          d.project.chat.push({
            id: newId('msg'),
            role: 'user',
            text: input.text ?? '',
            ts: now,
            requestId: id,
            ...(request.range ? { range: request.range } : {})
          })
        }
      }, BOOKKEEPING)
      s.log.write('request', `New ${REQUEST_LABELS[input.kind]}${request.range ? ` for ${rangeText(request.range)}` : ''}`, {
        id,
        direction: request.text,
        range: request.range,
        context: request.context,
        beforeVersionId
      })
      if (ctx.settings.get().runner.autoStart) ctx.runner.kick()
      return structuredClone(request)
    },

    open() {
      const s = ctx.projects.current()
      if (!s) return []
      return s.project.requests
        .filter((r) => r.status === 'queued' || r.status === 'in_progress')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((r) => structuredClone(r))
    },

    begin(requestId) {
      const s = store()
      const r = find(s, requestId)
      if (r.status !== 'queued' && r.status !== 'in_progress') {
        throw new Error(`Request ${requestId} is already ${r.status}`)
      }
      const lock = s.project.lock
      if (r.range && lock && lock.requestId !== requestId) {
        const holder = s.project.requests.find((x) => x.id === lock.requestId)
        if (holder?.status === 'in_progress') {
          throw new Error(`Another section re-edit (${holder.id}) is in progress. Finish it first.`)
        }
      }
      s.mutate(`Begin ${REQUEST_LABELS[r.kind]}`, 'app', (d) => {
        const req = d.project.requests.find((x) => x.id === requestId)!
        req.status = 'in_progress'
        req.startedAt = new Date().toISOString()
        delete req.waitingReason
        if (req.range) d.project.lock = { requestId, range: { ...req.range } }
        else if (d.project.lock && d.project.lock.requestId !== requestId) {
          // A stale lock from a request that is no longer running.
          const holder = d.project.requests.find((x) => x.id === d.project.lock!.requestId)
          if (holder?.status !== 'in_progress') d.project.lock = null
        }
      }, BOOKKEEPING)
      s.log.write('request', `Claude started the ${REQUEST_LABELS[r.kind]}`, { id: requestId, lockedRange: r.range })
      return structuredClone(find(s, requestId))
    },

    finish(requestId, summary, status = 'done') {
      const s = store()
      const r = find(s, requestId)
      s.mutate(`Finish ${REQUEST_LABELS[r.kind]}`, 'app', (d) => {
        const req = d.project.requests.find((x) => x.id === requestId)!
        req.status = status
        req.finishedAt = new Date().toISOString()
        req.summary = summary
        delete req.waitingReason
        if (req.beforeVersionId && status === 'done') req.review = 'pending'
        if (d.project.lock?.requestId === requestId) d.project.lock = null
      }, BOOKKEEPING)
      s.log.write('request', `${status === 'done' ? 'Finished' : 'Failed'}: ${REQUEST_LABELS[r.kind]}`, { id: requestId, summary })
      return structuredClone(find(s, requestId))
    },

    requeueInProgress(reason) {
      const s = ctx.projects.current()
      if (!s || s.readOnly) return
      const running = s.project.requests.filter((r) => r.status === 'in_progress').map((r) => r.id)
      if (!running.length) return
      s.mutate('Requests back in queue', 'app', (d) => {
        for (const req of d.project.requests) {
          if (!running.includes(req.id)) continue
          req.status = 'queued'
          req.waitingReason = reason
          if (d.project.lock?.requestId === req.id) d.project.lock = null
        }
      }, BOOKKEEPING)
      s.log.write('request', `Back in the queue: ${reason}`, { ids: running })
    },

    setWaitingReason(reason) {
      const s = ctx.projects.current()
      if (!s || s.readOnly) return
      const queued = s.project.requests.filter((r) => r.status === 'queued')
      if (!queued.length || queued.every((r) => r.waitingReason === reason)) return
      s.mutate('Request waiting reason', 'app', (d) => {
        for (const req of d.project.requests) {
          if (req.status !== 'queued') continue
          if (reason) req.waitingReason = reason
          else delete req.waitingReason
        }
      }, BOOKKEEPING)
    },

    review(requestId, decision) {
      const s = store()
      const r = find(s, requestId)
      if (decision === 'revert') {
        if (!r.beforeVersionId) throw new Error('This change has no Before version to go back to.')
        ctx.versions.restore(r.beforeVersionId)
      }
      s.mutate(decision === 'keep' ? 'Keep change' : 'Revert change', 'app', (d) => {
        const req = d.project.requests.find((x) => x.id === requestId)
        if (req) req.review = decision === 'keep' ? 'kept' : 'reverted'
      }, BOOKKEEPING)
      s.log.write('request', `${decision === 'keep' ? 'Kept' : 'Reverted'}: ${REQUEST_LABELS[r.kind]}`, { id: requestId, range: r.range })
    }
  }
}
