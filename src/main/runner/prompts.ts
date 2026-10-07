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
- Captions on long-form videos are a tool, not wallpaper: caption the hook (about the first 3-6 seconds) and then only the
  moments where they pull attention back (a key number or price, a punchline or strong claim, the payoff, hard-to-hear speech, a
  re-hook). Choose them with set_caption_spans, usually 10-25 % of the video. Never caption a whole intro or the whole video unless
  the owner or the channel rules ask for it (set_caption_spans with mode "all"). Shorts are captioned throughout by the app.
- Before making a graphic, animation, song or sound effect, search the asset library (search_library). Reuse one only when it fits
  this moment perfectly (same purpose, emotion and energy, right for the story and the brand) and is as good as what you would
  make fresh. Quality first: never reuse to save time or usage; when a new one would carry the story or emotion better, make it.
- Save every new graphic, animation, custom effect, music track and sound effect you make to the library (save_to_library) right
  after placing it, with a description of what it is, its mood and when it fits.
- Thumbnails are built around a base picture: a clean frame of the footage (no captions or graphics) where the subject of the
  video is shown best. Before request_thumbnails, pick that moment (check candidates with get_frame footage_only) and call
  save_thumbnail_draft with your best description and base_time; leave base_time out when get_project shows the owner grabbed
  one (thumbnails.base.by "user"). The base picture is sent with every thumbnail prompt.
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
    case 'insert_clip': {
      const c = (r.context ?? {}) as { insertAt?: number; mode?: string; secondsEachSide?: number; kind?: string; sourceId?: string }
      const at = typeof c.insertAt === 'number' ? `${formatTime(c.insertAt, true)} (${c.insertAt.toFixed(2)}s)` : 'the marked spot'
      lines.push(
        `The owner added a ${c.kind === 'image' ? 'photo' : 'video clip'} (source ${c.sourceId ?? 'in the attached context'}) at ${at} and wants it to ` +
          `flow with the edit around it. You may re-edit ${rangeText(r.range)} (${c.secondsEachSide ?? '?'} s on each side); nothing outside it can change.`,
        c.mode === 'overlay'
          ? 'Show it OVER the video there as B-roll (add_item on the B-roll track, anchored to the words at that spot): the A-roll and its sound carry on underneath.'
          : 'Cut it INTO the video there (set_aroll_cuts, inserting it between the pieces at that spot; the video gets longer and everything after shifts on its own). ' +
              'Pick the exact cut points at word boundaries near the spot, so no word is clipped.',
        'Look at the new clip first (frames of the source) and at the footage around the spot (get_range_frames). Decide how long it should be ' +
          'and which part of it to use, then re-tune the range so it reads as one piece: trims, the cuts before and after, a transition only if it ' +
          'helps, graphics, sound effects, music under it and captions. ' +
          (c.kind === 'image'
            ? 'For a photo, choose a length that suits the moment (usually 2-4 s) and give it gentle motion if that fits the style (keyframes, or render a short video from it with ffmpeg and import_file). '
            : 'Keep its own sound only if it adds something; otherwise lower or mute it under the voice. ') +
          'Follow the channel rules and the video theme if there is one. Reply with what you did.'
      )
      if (r.text.trim()) lines.push(`Note from the owner: "${r.text.trim()}"`)
      break
    }
    case 'make_shorts': {
      const c = (r.context ?? {}) as { count?: number; recap?: boolean; redoId?: string }
      if (c.redoId) {
        lines.push(
          `Remake the Short ${c.redoId} (list_shorts shows it) with save_short and replace_id "${c.redoId}".` +
            (r.text.trim() ? ` The owner wants: "${r.text.trim()}"` : ' Make it stronger: a better hook, tighter, or a better moment.')
        )
      } else {
        lines.push(
          `Make vertical Shorts from this video for YouTube Shorts and TikTok. The owner asked for up to ${c.count ?? 3} highlight Short${(c.count ?? 3) > 1 ? 's' : ''}.`,
          'Read the transcript (get_transcript) and look through the footage (get_range_frames over the source, and the edit so far) to find the moments ' +
            'that stop a scroll: the hook of the video, high-action moments, surprises, reveals, funny or striking moments, strong opinions. Each Short ' +
            'opens on its hook in the first second, keeps only what earns its place (cut pauses and filler with several pieces), ends on a payoff, and ' +
            'makes sense to someone who never saw the video. Usually 15-60 s.',
          'Quality over count: Shorts must not feel like copies of each other. If the video only has, say, 7 distinct strong moments, make 7 and ' +
            'say why in your reply. The app refuses a highlight that shares too much footage with another one.',
          c.recap
            ? 'Also, if this video is an unboxing or a review (for example of an RC car), make ONE extra Short of kind "recap", about 30 s, ' +
                'hyper-focused with none of the bloat: the box opening, a quick look at what is inside, then it in use, done. It may reuse moments ' +
                'from the highlights. If the video is not an unboxing or review, skip it and say so.'
            : '',
          'For each Short call save_short with its pieces from the SOURCE footage, a punchy YouTube Shorts title (under 70 characters), a TikTok ' +
            'caption, a one-line description and 3-6 hashtags, in the channel\'s voice. Use list_shorts to see what exists; do not repeat it. ' +
            'Follow the channel rules and the video theme if there is one. Reply with the list and one line on each.'
        )
        if (r.text.trim()) lines.push(`Note from the owner: "${r.text.trim()}"`)
      }
      break
    }
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
    case 'thumbnail_draft': {
      const c = (r.context ?? {}) as { persona?: string; style?: string; keepBase?: boolean }
      lines.push(
        'Write the thumbnail description for the owner. Do NOT make thumbnails or call any Pikzels tool: the owner reads your ' +
          'description in the Thumbnails tab, changes it if they like, and presses Generate.'
      )
      if (c.keepBase) {
        lines.push('The owner already grabbed the base picture themselves: keep it (do not pass base_time). Look at it with get_frame at that time.')
      } else {
        lines.push(
          'First pick the base picture: the moment where the thing the video is about (the product, vehicle, build or subject) is shown best: ' +
            'big in frame, sharp, well lit, not blocked by hands, no motion blur. Check 4-8 candidate times with get_frame footage_only=true ' +
            '(captions and graphics are left out of the base picture anyway) and pick one.'
        )
      }
      lines.push(
        `Then write ONE description (under 750 characters, no links) of a click-worthy thumbnail built around that picture: ` +
          'the subject, the owner\'s face and reaction, the big short text (2-4 words), colours and layout. It must match the video\'s ' +
          'actual story and payoff (read the transcript and the publishing pack if there is one).' +
          (c.persona ? ` The persona "${c.persona}" (the owner) is added by Pikzels: describe them by role, not looks.` : '') +
          (c.style ? ` The thumbnail style "${c.style}" is applied by Pikzels: fit the description to it.` : '') +
          (project.thumbnails.direction.trim() ? ` Owner's thumbnail direction: "${project.thumbnails.direction.trim()}".` : '')
      )
      lines.push('Save it with save_thumbnail_draft (description, plus base_time unless told to keep the base), then finish_request. No chat reply is needed.')
      break
    }
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
