/** Music, Review and Progress tools. */
import { z } from 'zod'
import type { MusicTrack } from '@shared/ipc'
import { CHECKLIST_STAGES } from '@shared/project'
import { round3 } from '@shared/timeline'
import { newId } from '../../project/store'
import { ToolError, anchorInput, defineTool, errMessage, json, toAnchor } from './common'

/** Bookkeeping: not undoable by the owner, and allowed while a section is locked. */
const BOOKKEEPING = { bypassLock: true, noHistory: true } as const

function musicView(list: MusicTrack[]) {
  const moods = [...new Set(list.map((t) => t.folder).filter(Boolean))].sort()
  return {
    moods,
    fields: ['path', 'name', 'mood', 'duration', 'format', 'missing'],
    tracks: list.slice(0, 400).map((t) => [t.path, t.name, t.folder, Math.round(t.duration * 10) / 10, t.format, t.missing]),
    ...(list.length > 400 ? { more: list.length - 400, note: 'Use search_music to narrow down.' } : {})
  }
}

export const musicTools = [
  defineTool({
    name: 'list_music',
    description:
      "The owner's music library for this channel (only the music folders the channel profile allows). Subfolder names are moods " +
      '(such as "upbeat" or "chill"); filter with mood. Place a track with add_music_track. Music is composed in code by default; use the ' +
      'library when a track fits better or when asked.',
    input: { mood: z.string().optional() },
    run: (args, env) => {
      let list = env.ctx.music.list(env.store.project.profileId)
      if (args.mood) list = list.filter((t) => t.folder.toLowerCase().includes(args.mood!.toLowerCase()))
      return json(musicView(list))
    }
  }),

  defineTool({
    name: 'search_music',
    description: "Search this channel's music library by words in the file name or mood folder (e.g. \"chill piano\").",
    input: { query: z.string().min(1) },
    run: (args, env) => json(musicView(env.ctx.music.search(args.query, env.store.project.profileId)))
  })
]

export const reviewTools = [
  defineTool({
    name: 'get_requests',
    description:
      'What the owner asked for: open requests (start edit, chat messages, section re-edits, clipped-audio fixes, intro decisions, ' +
      'publishing-pack and thumbnail direction) with their time range, direction text and attached context (playhead, selected items, ' +
      'seam audio snippet paths...), open notes left on items or ranges, and the recent chat. Work through requests oldest first: ' +
      'begin_request, do the work inside its range only, reply_chat, finish_request.',
    input: {},
    run: (_args, env) => {
      const p = env.store.project
      return json({
        requests: env.ctx.requests.open().map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          createdAt: r.createdAt,
          text: r.text,
          range: r.range ? { start: round3(r.range.start), end: r.range.end >= 1e8 ? 'end of video' : round3(r.range.end) } : undefined,
          context: r.context,
          ...(r.waitingReason ? { waitingReason: r.waitingReason } : {})
        })),
        notes: p.notes.filter((n) => n.status === 'open'),
        recentChat: p.chat.slice(-20).map((m) => ({ role: m.role, text: m.text, ts: m.ts, requestId: m.requestId, range: m.range })),
        lock: p.lock
      })
    }
  }),

  defineTool({
    name: 'begin_request',
    description:
      'Mark a request as started. For requests with a time range (chat with a range, section re-edit, clipped-audio fix) this locks the rest ' +
      'of the video: any change outside the range is refused until finish_request. If the section gets longer or shorter, everything after ' +
      'it shifts to stay in sync.',
    input: { request_id: z.string() },
    run: (args, env) => {
      let r
      try {
        r = env.ctx.requests.begin(args.request_id)
      } catch (err) {
        throw new ToolError(errMessage(err))
      }
      return json({
        request: { id: r.id, kind: r.kind, status: r.status, text: r.text, range: r.range, context: r.context },
        ...(r.range ? { lock: `Only changes inside ${round3(r.range.start)}s – ${r.range.end >= 1e8 ? 'the end' : round3(r.range.end) + 's'} are accepted until finish_request.` } : {})
      })
    }
  }),

  defineTool({
    name: 'reply_chat',
    description: 'Write a message to the owner in the chat panel: what you did, or a question when a request is unclear. Plain words, short.',
    input: { text: z.string().min(1), request_id: z.string().optional() },
    run: (args, env) => {
      const id = newId('msg')
      env.mutate('Claude replied', (d) => {
        d.project.chat.push({ id, role: 'claude', text: args.text, ts: new Date().toISOString(), ...(args.request_id ? { requestId: args.request_id } : {}) })
      }, BOOKKEEPING)
      return json({ messageId: id })
    }
  }),

  defineTool({
    name: 'finish_request',
    description:
      'Mark a request done (or failed) with a one-line summary of what changed. Releases the section lock. Video changes then show the owner ' +
      'Before / After with Keep and Revert.',
    input: { request_id: z.string(), summary: z.string().min(1), failed: z.boolean().optional() },
    run: (args, env) => {
      try {
        const r = env.ctx.requests.finish(args.request_id, args.summary, args.failed ? 'failed' : 'done')
        return json({ request: { id: r.id, kind: r.kind, status: r.status, review: r.review } })
      } catch (err) {
        throw new ToolError(errMessage(err))
      }
    }
  }),

  defineTool({
    name: 'mark_note_done',
    description: 'Mark a note the owner left (on an item or a range) as done, with a short response saying what you changed.',
    input: { note_id: z.string(), response: z.string().default('') },
    run: (args, env) => {
      if (!env.store.project.notes.some((n) => n.id === args.note_id)) throw new ToolError(`No note "${args.note_id}".`)
      env.mutate('Note done', (d) => {
        const n = d.project.notes.find((x) => x.id === args.note_id)!
        n.status = 'done'
        n.doneAt = new Date().toISOString()
        if (args.response) n.response = args.response
      }, BOOKKEEPING)
      return json({ noteId: args.note_id, status: 'done' })
    }
  })
]

export const progressTools = [
  defineTool({
    name: 'get_checklist',
    description:
      'The progress checklist (transcript, cuts, B-roll, graphics, music and sound, captions, self-check, thumbnails, publishing pack: each ' +
      'not_started, in_progress or done), the next unfinished stage, and the handoff notes. After any interruption continue from the next ' +
      'unfinished stage: never redo finished work.',
    input: {},
    run: (_args, env) => {
      const p = env.store.project
      const next = p.checklist.find((c) => c.status !== 'done')
      return json({ checklist: p.checklist, nextStage: next ? { id: next.id, label: next.label, status: next.status } : null, handoffNotes: p.handoffNotes })
    }
  }),

  defineTool({
    name: 'update_checklist',
    description:
      `Set a checklist stage: ${stageIds()}. status not_started | in_progress | done, with a short detail ` +
      '(what is done, what is left). A new stage id adds a custom stage (give a label). Keep it current after every stage.',
    input: {
      stage: z.string().min(1),
      status: z.enum(['not_started', 'in_progress', 'done']),
      detail: z.string().optional(),
      label: z.string().optional()
    },
    run: (args, env) => {
      env.mutate(`Checklist: ${args.stage} ${args.status}`, (d) => {
        const now = new Date().toISOString()
        let entry = d.project.checklist.find((c) => c.id === args.stage)
        if (!entry) {
          if (!args.label) throw new ToolError(`Unknown stage "${args.stage}". Stages: ${d.project.checklist.map((c) => c.id).join(', ')}. Give a label to add a new one.`)
          entry = { id: args.stage, label: args.label, status: 'not_started' }
          d.project.checklist.push(entry)
        }
        entry.status = args.status
        entry.updatedAt = now
        if (args.detail !== undefined) entry.detail = args.detail
        if (args.status !== 'not_started' && d.project.status === 'new') d.project.status = 'editing'
      }, BOOKKEEPING)
      return json({ checklist: env.store.project.checklist })
    }
  }),

  defineTool({
    name: 'write_handoff_note',
    description:
      'Write a short handoff note into the project: what you decided and what is left. A new session reads these to continue without redoing work.',
    input: { text: z.string().min(1), stage: z.string().optional() },
    run: (args, env) => {
      const id = newId('hn')
      env.mutate('Handoff note', (d) => {
        d.project.handoffNotes.push({ id, ts: new Date().toISOString(), text: args.text, ...(args.stage ? { stage: args.stage } : {}) })
      }, BOOKKEEPING)
      return json({ noteId: id })
    }
  }),

  defineTool({
    name: 'set_project_status',
    description:
      'Set the edit status shown on the home page: "editing", "intro_ready" (Just the intro mode: the intro is done and waits for the owner) ' +
      'or "ready_for_review" (the edit is done and self-checked; a version is saved automatically).',
    input: { status: z.enum(['editing', 'intro_ready', 'ready_for_review']) },
    run: (args, env) => {
      const before = env.store.project.status
      env.mutate(`Status: ${args.status}`, (d) => {
        d.project.status = args.status
      }, { bypassLock: true })
      let version: string | undefined
      if (args.status !== before && (args.status === 'ready_for_review' || args.status === 'intro_ready')) {
        try {
          version = env.ctx.versions.save(args.status === 'ready_for_review' ? 'Ready for review' : 'Intro ready', { auto: true, reason: args.status }).name
        } catch (err) {
          env.store.log.write('error', 'Could not save the automatic version', { error: errMessage(err) })
        }
      }
      return json({ status: args.status, ...(version ? { versionSaved: version } : {}) })
    }
  }),

  defineTool({
    name: 'set_intro_end',
    description:
      'Just the intro mode: mark where the intro ends, anchored to the last word of the intro plus an offset (or a time). The owner previews ' +
      'up to here and then chooses Continue, Redo or stop. After setting it, call set_project_status("intro_ready").',
    input: { anchor: anchorInput },
    run: (args, env) => {
      const anchor = toAnchor(args.anchor, env.store.snapshotDoc())
      env.mutate('Set intro end', (d) => {
        d.project.scope.introEnd = anchor
      }, { bypassLock: true })
      return json({ introEnd: anchor, time: round3(env.resolver().anchorTime(anchor).time) })
    }
  })
]

function stageIds(): string {
  return CHECKLIST_STAGES.map(([id]) => id).join(', ')
}
