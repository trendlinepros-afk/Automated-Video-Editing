/**
 * What the app tells Claude when it starts it: the system prompt (rules + how to work with the app)
 * and the prompt for one run, built from the request queue.
 * The rules are handed over as written. The app adds no editing logic of its own.
 */
import type { EditRequest, Project } from '@shared/project'
import { DEFAULT_EDITING_RULES } from '@shared/rules'
import type { Profile } from '@shared/settings'
import { formatTime } from '@shared/timeline'

export const WORKFLOW = `How to work with the app (tools from the "ave" MCP server)

- The project lives in the app. Make every change through the ave tools; never edit project.json yourself.
- Start with get_requests, get_project, get_checklist, get_inspiration_and_scope and get_profile.
- For each open request, oldest first: begin_request(id), do the work, reply_chat with a short plain-words summary
  (or a question when the request is unclear), then finish_request(id, summary).
- A request with a time range is locked to that range: the app refuses any change outside it. Look at the frames in the
  range (get_range_frames) to find what the owner means, such as where they are pointing.
- Keep the progress checklist current (update_checklist) and write a handoff note (write_handoff_note) after every
  stage: what you decided and what is left. If this session is interrupted, the next one continues from there.
- Resume from the next unfinished checklist stage. Never redo finished work; at most repeat the one stage in flight.
- Work so that an interruption (power cut, usage limit, lost connection) costs little: every tool change is saved at once,
  so apply results as you go instead of saving them all up for the end. In a long stage, update the checklist detail and the
  handoff note at least every 10 minutes of footage covered (e.g. "cuts done to 12:30 of C0003"). Transcribe one source at a
  time and call save_transcript for each as soon as it is done; when resuming, skip sources list_footage shows as transcribed.
  Keep your scratch files in the project's scratch folder (get_engine_info) so a new session can find and reuse them.
- Anchor B-roll, graphics, effects, sound effects and chapters to transcript words, not fixed times.
- Search the asset library (search_library) before making a graphic or sound; offer to save reusable new ones (save_to_library).
- Anything the tools cannot express, build with your own scripts (get_engine_info gives the Python and ffmpeg to use) and
  bring the finished file in with import_file.
- Claude cannot hear the result: check audio by measurement (get_audio_energy, measure_loudness, transcribing snippets).`

export function buildSystemPrompt(profile: Profile | null): string {
  const rules = profile?.editingRules?.trim() ? profile.editingRules.trim() : DEFAULT_EDITING_RULES
  const channelRules = (profile?.rules ?? []).filter((r) => r.enabled).map((r) => `- ${r.text}`)
  const parts = [
    `You are editing a YouTube video inside the owner's video editor app${profile ? ` for the channel "${profile.name}"` : ''}. ` +
      'You make every editing decision; the app shows each change on its timeline and renders it.',
    rules,
    channelRules.length ? `Channel rules for this channel (always follow them):\n${channelRules.join('\n')}` : '',
    profile?.channelNotes?.trim() ? `Channel notes from the owner:\n${profile.channelNotes.trim()}` : '',
    WORKFLOW
  ]
  return parts.filter(Boolean).join('\n\n')
}

function rangeText(r: EditRequest['range']): string {
  if (!r) return ''
  const end = r.end >= 1e8 ? 'the end of the video' : `${formatTime(r.end, true)} (${r.end.toFixed(2)}s)`
  return `${formatTime(r.start, true)} (${r.start.toFixed(2)}s) to ${end}`
}

function contextText(ctx: Record<string, unknown>): string {
  const keys = Object.keys(ctx ?? {})
  if (!keys.length) return ''
  return `Attached context: ${JSON.stringify(ctx)}`
}

/** The instructions for one request. */
export function requestSection(r: EditRequest, project: Project): string {
  const head = `Request ${r.id} (${r.kind})`
  const ctx = contextText(r.context)
  const lines: string[] = []
  switch (r.kind) {
    case 'start_edit': {
      const inspiration = (r.text || project.inspiration).trim()
      lines.push(
        inspiration
          ? `Inspiration from the owner (their vision for this video; follow it):\n"""\n${inspiration}\n"""`
          : 'The owner left no inspiration text. Do your best from the footage, the channel notes and rules, and the brand kit. Do not ask for it.'
      )
      if (project.scope.mode === 'intro') {
        const max = project.scope.introMaxSeconds
        lines.push(
          'Scope: JUST THE INTRO. Review and transcribe the whole video first so the intro reflects what the video is about, but edit only the opening. ' +
            (max ? `The intro may be at most ${max} seconds long.` : 'Intro length is Auto: you judge where the intro ends.') +
            ' Give the intro the full treatment: cuts, B-roll, graphics, music, sound effects and captions, and self-check it. ' +
            'When it is done, call set_intro_end with the last word of the intro, then set_project_status("intro_ready"), reply_chat, and finish_request. Do not edit past the intro.'
        )
      } else {
        lines.push(
          'Scope: the WHOLE video. Do the full edit, stage by stage, keeping the checklist current: transcript, cuts, B-roll, graphics, ' +
            'music and sound, captions, self-check. Then set_project_status("ready_for_review"), request_thumbnails ' +
            `(${project.thumbnails.count} prompt${project.thumbnails.count > 1 ? 's' : ''}), save_publish_pack, reply_chat with a summary, and finish_request.`
        )
      }
      break
    }
    case 'continue_intro':
      lines.push(
        `The owner approved the intro. Keep it EXACTLY as it is: change nothing up to its last frame${r.range ? ` (${formatTime(r.range.start, true)})` : ''}. ` +
          'Edit the rest of the video on from there with the same care (cuts, B-roll, graphics, music, sound effects, captions, self-check), ' +
          `then set_project_status("ready_for_review"), request_thumbnails, save_publish_pack, reply_chat and finish_request.`
      )
      if (r.text.trim()) lines.push(`Direction: ${r.text.trim()}`)
      break
    case 'redo_intro':
      lines.push(
        'The owner wants the intro done again' +
          (r.text.trim() ? ` with this direction: "${r.text.trim()}"` : '') +
          '. Re-edit only the intro, then set_intro_end, set_project_status("intro_ready"), reply_chat and finish_request.'
      )
      break
    case 'chat':
      lines.push(`The owner wrote in the chat: "${r.text}"`)
      if (r.range) lines.push(`It applies to ${rangeText(r.range)}. Look at the frames in that range to find what they mean, and change things inside that range only.`)
      lines.push('Reply in the chat with what you did, or ask a question if it is unclear.')
      break
    case 'reedit':
      lines.push(`Re-edit the section ${rangeText(r.range)}.` + (r.text.trim() ? ` Direction: "${r.text.trim()}"` : ' No direction given: make it better by the channel rules.'))
      lines.push('Only that range can change; if it gets shorter or longer, everything after it shifts on its own.')
      break
    case 'fix_audio':
      lines.push(
        `Fix clipped audio at ${rangeText(r.range)}. A word at this cut sounds clipped or doubled. The attached context has the seam ` +
          'and audio snippet paths of the source around it. Read the audio energy in 5 ms steps (get_audio_energy), confirm on an isolated ' +
          'snippet when a word may be doubled, restore the missing part of the word with adjust_cut, and reply with what you changed.'
      )
      if (r.text.trim()) lines.push(`Note from the owner: "${r.text.trim()}"`)
      break
    case 'stabilize':
      lines.push(
        `Stabilize the clip ${r.context?.itemId ?? ''} at ${rangeText(r.range)}. The attached context has its source file, the source range it ` +
          'shows (sourceIn–sourceOut) and a slightly wider range to read (readFrom–readTo) so motion at the edges is smoothed too.',
        'How: get_engine_info for ffmpeg and the managed Python. Look at a few frames first (get_range_frames): if the shot is already steady ' +
          '(tripod, locked-off), change nothing and say so. Otherwise run two-pass vidstab on readFrom–readTo only (vidstabdetect with ' +
          'shakiness 5-8 and accuracy 15 into the scratch folder, then vidstabtransform with smoothing about 15-30, optzoom 1, interpol bicubic, ' +
          'followed by a light unsharp). If this ffmpeg has no vidstab filters, use OpenCV in the managed Python (feature tracking, smoothed ' +
          'trajectory, warp, minimal crop). Keep the source frame size and EXACT frame rate (no frame drops or duplicates), no audio, high ' +
          'quality (NVENC with a low cq, or libx264 crf 14). Write it to the saveAs project path from the context.',
        'Then call set_item_picture with that file, source_start = readFrom and kind "stabilized", with a one-line note of the settings. ' +
          'Check the result with get_range_frames against the original: framing should stay close (optzoom zooms in as far as the shake ' +
          'needs; if that is more than about 8 %, lower the smoothing or use optzoom 2 and say so in the reply). On a talking head, faces ' +
          'must not wobble or warp. Sound, cuts and timing stay as they are. Reply in the chat with what you did and how much it zoomed.'
      )
      if (r.context?.currentPicture) lines.push('This clip already has a processed picture; make the new one from the ORIGINAL source, not from that file.')
      if (r.text.trim()) lines.push(`Direction from the owner: "${r.text.trim()}"`)
      break
    case 'publish_regen':
      lines.push(`Regenerate part of the publishing pack${r.text.trim() ? ` with this direction: "${r.text.trim()}"` : ''}. Save it with save_publish_pack.`)
      break
    case 'thumbnail_direction':
      lines.push(`New thumbnail direction from the owner: "${r.text}". Write new prompts that follow it and call request_thumbnails.`)
      break
    case 'resume':
      lines.push('Continue the edit from the next unfinished checklist stage. Read the handoff notes first. Do not redo finished work.')
      if (r.text.trim()) lines.push(`Note: ${r.text.trim()}`)
      break
  }
  if (ctx) lines.push(ctx)
  return `${head}\n${lines.join('\n')}`
}

/** The prompt for one run: every open request, oldest first. */
export function buildRunPrompt(requests: EditRequest[], project: Project, opts: { resumed: boolean }): string {
  const intro = opts.resumed
    ? 'New work from the owner in this project. Call get_requests and get_checklist first.'
    : 'You are connected to the video editor app through the "ave" MCP tools. Call get_requests, get_project and get_checklist first.'
  const inFlight = project.checklist.find((c) => c.status === 'in_progress')
  const resumeNote = inFlight ? `\nThe checklist shows "${inFlight.label}" in progress: continue from there and do not redo finished stages.` : ''
  const body = requests.map((r) => requestSection(r, project)).join('\n\n')
  const theme = project.videoTheme
    ? `\nVideo theme: "${project.videoTheme.name}". Edit to a similar pace and style as its reference videos. Call get_video_theme before ` +
      'deciding cuts, B-roll, graphics, captions or sound (the channel rules, brand kit and the inspiration still come first).'
    : ''
  return `${intro}${resumeNote}${theme}\n\nOpen requests (handle them in this order; begin_request and finish_request each one):\n\n${body}`
}
