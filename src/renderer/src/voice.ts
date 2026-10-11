/** ElevenLabs voiceover helpers shared by Settings and the Voiceover dialog. */
import type { VoiceStatus } from '@shared/ipc'

/** The models on the owner's ElevenLabs account, best first. */
export const VOICE_MODELS: [string, string][] = [
  ['eleven_v3', 'v3 — expressive, audio tags (recommended)'],
  ['eleven_v4', 'v4 — newest, audio tags'],
  ['eleven_multilingual_v2', 'Multilingual v2 — steady'],
  ['eleven_turbo_v2_5', 'Turbo v2.5 — faster, half the characters'],
  ['eleven_flash_v2_5', 'Flash v2.5 — fastest, half the characters']
]

/** v3 and v4 understand [excited] style tags; the others would speak them, so the app removes them. */
export function voiceTagsWork(model: string): boolean {
  return /^eleven_v[34]/.test(model)
}

/** Characters left this month, when ElevenLabs said. */
export function charactersLeft(s: VoiceStatus | null | undefined): number | undefined {
  return s?.characterLimit != null && s.charactersUsed != null ? Math.max(0, s.characterLimit - s.charactersUsed) : undefined
}

/** "✓ Adam V3 Pro found · 12,340 of 100,000 characters used this month · resets Oct 28" */
export function voiceStatusLine(s: VoiceStatus): string {
  if (!s.ok) return s.message ?? 'ElevenLabs is not ready.'
  const parts = [`✓ ${s.voiceName} found`]
  if (s.charactersUsed != null && s.characterLimit != null)
    parts.push(`${s.charactersUsed.toLocaleString()} of ${s.characterLimit.toLocaleString()} characters used this month`)
  if (s.resetsAt) {
    const d = new Date(s.resetsAt)
    if (!isNaN(d.getTime())) parts.push(`resets ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`)
  }
  return parts.join(' · ')
}
