/**
 * Chat: requests in plain words. Times typed in the message are highlighted on the timeline as you type,
 * and the playhead and any selected item are attached, so "here" and "this" work.
 */
import { EstimateNote, useEstimate } from '../editor/EstimateNote'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { EditRequest } from '@shared/project'
import { findTimeRange } from '@shared/timeline'
import { toast } from '../state/app'
import { editor, review, showBefore } from '../state/editor'
import { useDerived } from '../state/derived'
import { seek } from '../state/player'
import { useStore } from '../state/store'
import { Icon } from '../components/Icon'
import { errorMessage, fmt, fmtRange, itemLabel } from '../util'

export function ChatPanel() {
  const chat = useStore(editor, (s) => s.snapshot!.doc.project.chat)
  const requests = useStore(editor, (s) => s.snapshot!.doc.project.requests)
  const readOnly = useStore(editor, (s) => s.snapshot!.readOnly)
  const log = useRef<HTMLDivElement>(null)
  const byId = useMemo(() => new Map(requests.map((r) => [r.id, r])), [requests])

  useEffect(() => {
    const el = log.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.length])

  // Requests answered by a Claude message show Keep/Revert there; others on the user's message.
  const answered = new Set(chat.filter((m) => m.role === 'claude' && m.requestId).map((m) => m.requestId!))

  return (
    <div className="panel flush" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="chat-log" ref={log}>
        {chat.length === 0 && (
          <div className="empty">
            <h3>Ask for a change</h3>
            <div className="small">
              e.g. “At 2:10 to 2:45, add an animation of a LiPo battery on fire where I am pointing.” Claude looks at that range,
              changes only it, and replies here.
            </div>
          </div>
        )}
        {chat.map((m) => {
          const req = m.requestId ? byId.get(m.requestId) : undefined
          const showReq = req && (m.role === 'claude' || !answered.has(req.id))
          return (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.text}
              {(m.range || showReq) && (
                <div className="meta">
                  {m.range && (
                    <a onClick={() => seek(m.range!.start)} title="Jump there">
                      {fmtRange(m.range)}
                    </a>
                  )}
                  {showReq && <RequestState r={req!} />}
                </div>
              )}
            </div>
          )
        })}
        <LiveOutput />
      </div>
      {!readOnly && <Compose />}
    </div>
  )
}

function RequestState({ r }: { r: EditRequest }) {
  const beforeId = useStore(editor, (s) => s.beforeRequestId)
  if (r.status === 'queued') return <span className="warn">Waiting{r.waitingReason ? `: ${r.waitingReason}` : ' for Claude'}</span>
  if (r.status === 'in_progress') return <span className="row" style={{ gap: 4 }}><span className="spinner" style={{ width: 10, height: 10 }} /> Claude is on it</span>
  if (r.status === 'failed') return <span className="bad">Not done{r.summary ? `: ${r.summary}` : ''}</span>
  if (r.status === 'cancelled') return <span className="faint">Cancelled</span>
  if (r.review === 'pending') {
    return (
      <span className="row" style={{ gap: 4 }}>
        <span className="seg">
          <button className={beforeId === r.id ? 'on' : ''} onClick={() => void showBefore(r.id)}>
            Before
          </button>
          <button className={beforeId !== r.id ? 'on' : ''} onClick={() => void showBefore(null)}>
            After
          </button>
        </span>
        <button className="btn small primary" onClick={() => void review(r.id, 'keep')}>
          Keep
        </button>
        <button className="btn small" onClick={() => void review(r.id, 'revert')}>
          Revert
        </button>
      </span>
    )
  }
  if (r.review === 'kept') return <span className="ok">Kept</span>
  if (r.review === 'reverted') return <span className="faint">Reverted</span>
  return <span className="ok">Done</span>
}

/** Claude's live output while it works. */
function LiveOutput() {
  const status = useStore(editor, (s) => s.runner.status)
  const output = useStore(editor, (s) => s.output)
  const [open, setOpen] = useState(true)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  }, [output.length, open])
  const working = status === 'running' || status === 'starting'
  if (!working || !output.length) return null
  return (
    <div className="col" style={{ gap: 4 }}>
      <a className="small" onClick={() => setOpen(!open)}>
        <span className="pulse-dot" style={{ display: 'inline-block', marginRight: 6 }} />
        {open ? 'Hide what Claude is doing' : 'Show what Claude is doing'}
      </a>
      {open && (
        <div className="live-lines" ref={box}>
          {output.slice(-80).map((l, i) => (
            <div key={i} className={l.kind}>
              {l.text}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Compose() {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const selection = useStore(editor, (s) => s.selection)
  const range = useStore(editor, (s) => s.range)
  const playhead = useStore(editor, (s) => Math.floor(s.playhead * 10) / 10)
  const d = useDerived()
  const typed = useMemo(() => findTimeRange(text), [text])
  const chatEstimate = useEstimate('chat')

  // "Send time to chat" from the timeline: the time goes into the box, ready to finish the sentence.
  const draft = useStore(editor, (s) => s.chatDraft)
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!draft) return
    setText((cur) => (cur.trim() ? `${cur.trimEnd()} ${draft.text}` : draft.text))
    editor.set({ chatDraft: null })
    requestAnimationFrame(() => {
      const el = box.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }, [draft])

  // Highlight a typed time range on the timeline as you type.
  useEffect(() => {
    const cur = editor.get().chatRange
    if (typed?.start !== cur?.start || typed?.end !== cur?.end) editor.set({ chatRange: typed })
  }, [typed])
  useEffect(() => () => editor.set({ chatRange: null }), [])

  const send = async () => {
    const t = text.trim()
    if (!t) return
    setBusy(true)
    try {
      await window.api.project.sendChat({
        text: t,
        range: typed ?? range ?? undefined,
        playhead: editor.get().playhead,
        selectedItemIds: editor.get().selection
      })
      setText('')
    } catch (e) {
      toast(`Could not send: ${errorMessage(e)}`, { kind: 'error' })
    }
    setBusy(false)
  }

  const items = d ? selection.map((id) => d.resolved.get(id)?.item).filter((x) => !!x) : []
  return (
    <div className="chat-compose">
      <textarea
        ref={box}
        rows={3}
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void send()
          }
        }}
        placeholder="Ask Claude for a change, e.g. “At 2:10 to 2:45, make it punchier”. Enter sends, Shift+Enter for a new line. Win+H to speak."
      />
      <div className="row wrap small">
        <span className="chip" title="The playhead is attached, so “here” works">
          ▸ {fmt(playhead)}
        </span>
        {typed ? (
          <span className="chip warn" title="Recognised in your message and highlighted on the timeline">
            {fmtRange(typed)}
          </span>
        ) : range ? (
          <span className="chip accent" title="The selected section is attached">
            {fmtRange(range)}
          </span>
        ) : null}
        {items.slice(0, 3).map((it) => (
          <span key={it!.id} className="chip" title="The selected item is attached, so “this” works">
            {itemLabel(it!, (id) => d?.sources.get(id)?.path)}
          </span>
        ))}
        {items.length > 3 && <span className="chip">+{items.length - 3}</span>}
        <span className="spacer" />
        <EstimateNote estimate={chatEstimate} prefix="Est." />
        <button className="btn primary small" disabled={!text.trim() || busy} onClick={send}>
          <Icon name="sparkle" size={13} /> Send
        </button>
      </div>
    </div>
  )
}
