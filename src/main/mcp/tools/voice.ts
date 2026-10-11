/** Voiceover tools: lines in the owner's own ElevenLabs voice. */
import { z } from 'zod'
import { TimelineResolver } from '@shared/timeline'
import { TAG_MODELS, maxChars, spokenWords } from '../../services/elevenlabs'
import { ToolError, anchorInput, defineTool, errMessage, json, toAnchor } from './common'

export const voiceTools = [
  defineTool({
    name: 'generate_voiceover',
    description:
      "Speak a line in the OWNER'S OWN voice (their ElevenLabs voice from Settings; never any other voice) and put it on the Voiceover " +
      'track at the anchor (a word id, so it follows cuts, or a time). Music ducks under it like under the A-roll. Use it only when the ' +
      'owner asks for a voiceover or narration, or the channel rules call for one: every character counts against their monthly ' +
      'ElevenLabs allowance. Write it the way they talk (read the transcript). On eleven_v3 and eleven_v4 (default v3) audio tags in ' +
      'square brackets shape the delivery, placed right before the words they colour: [excited] [curious] [sarcastic] [warmly] ' +
      '[whispers] [laughs] [sighs] [pause]. Use CAPS sparingly for emphasis and … for pauses; keep numbers and prices as written. ' +
      'Check placement with get_audio_energy or by transcribing, and trim or move it with update_item like any audio item.',
    input: {
      text: z.string().min(1).max(3000),
      anchor: anchorInput,
      volume: z.number().min(-30).max(12).optional().describe('dB, default 0'),
      model: z.enum(['eleven_v3', 'eleven_v4', 'eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5']).optional()
    },
    run: async (args, env) => {
      if (!env.ctx.voice.hasKey()) throw new ToolError('No ElevenLabs API key: the owner adds it in Settings. Tell them in the chat instead of retrying.')
      const doc = env.store.snapshotDoc()
      const anchor = toAnchor(args.anchor, doc)
      const time = new TimelineResolver(doc.project, doc.transcript).anchorTime(anchor).time
      const model = args.model ?? env.ctx.settings.get().voice?.model ?? 'eleven_v3'
      if (args.text.length > maxChars(model)) throw new ToolError(`${model} takes at most ${maxChars(model)} characters per line; split it.`)
      // Check the section lock before paying for the audio.
      const lock = doc.project.lock
      if (lock && (time < lock.range.start || time >= lock.range.end)) {
        throw new ToolError(`That time is outside the section being edited (${lock.range.start.toFixed(1)}-${lock.range.end.toFixed(1)} s).`)
      }
      try {
        const r = await env.ctx.voice.generate({ text: args.text, time, model, anchor, source: 'claude' })
        if (args.volume !== undefined) env.mutate('Voiceover volume', (d) => {
          const it = d.project.items.find((i) => i.id === r.itemId)
          if (it && it.type === 'audio') it.volume = args.volume!
        })
        return json({
          itemId: r.itemId,
          file: r.file,
          duration: r.duration,
          start: time,
          characters: r.characters,
          ...(r.charactersLeft !== undefined ? { charactersLeftThisMonth: r.charactersLeft } : {}),
          ...(!TAG_MODELS.includes(model) && /\[[^\]]+\]/.test(args.text) ? { note: `Tags were removed: ${model} would have read them out.` } : {}),
          ...(r.warning ? { warning: r.warning } : {}),
          says: spokenWords(args.text)
        })
      } catch (err) {
        throw new ToolError(errMessage(err))
      }
    }
  })
]
