/**
 * Claude wants a voiceover line that takes the video past its voiceover limit (Settings > ElevenLabs, 2 minutes by
 * default): say how long it would be and let the owner allow it or not. Declining tells Claude to find another way.
 */
import { useEffect, useState } from 'react'
import type { VoiceApproval } from '@shared/ipc'
import { call } from '../state/app'
import { fmt } from '../util'
import { Modal } from './Modal'

export function VoiceApprovalPrompt() {
  const [ask, setAsk] = useState<VoiceApproval | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => window.api.voice.onApproval((a) => setAsk(a)), [])
  if (!ask) return null
  const total = ask.usedSeconds + ask.seconds
  const answer = async (allow: boolean) => {
    setBusy(true)
    await call(() => window.api.voice.answerApproval(ask.id, allow))
    setBusy(false)
    setAsk(null)
  }
  return (
    <Modal
      title="More voiceover?"
      onClose={() => !busy && void answer(false)}
      footer={
        <>
          <button className="btn" disabled={busy} onClick={() => void answer(false)}>
            No, find another way
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void answer(true)}>
            Allow {fmt(ask.seconds)} more
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        Claude wants to add a voiceover line of about <b>{fmt(ask.seconds)}</b>. That would make <b>{fmt(total)}</b> of voiceover in this
        video, over your limit of {fmt(ask.limitSeconds)} ({fmt(ask.usedSeconds)} used so far).
      </p>
      <blockquote className="small" style={{ margin: '8px 0', paddingLeft: 10, borderLeft: '3px solid var(--bg-4)' }}>
        {ask.text}
      </blockquote>
      <span className="hint">If you say no, Claude does it another way: shorter wording, on-screen text, a graphic or a cut.</span>
    </Modal>
  )
}
