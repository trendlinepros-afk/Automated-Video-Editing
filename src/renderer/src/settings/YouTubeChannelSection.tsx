/**
 * Settings > General: the owner's own YouTube channel, read-only. Google sign-in with the owner's
 * own OAuth client, and a small preview of what Claude learns from the channel's audience retention.
 */
import { useEffect, useState } from 'react'
import type { ChannelRetention, YouTubeStatus } from '@shared/retention'
import { clock } from '@shared/retention'
import { call, toast } from '../state/app'

export function YouTubeChannelSection() {
  const [status, setStatus] = useState<YouTubeStatus | null>(null)
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [insights, setInsights] = useState<ChannelRetention | null>(null)
  const [loadingInsights, setLoadingInsights] = useState(false)

  useEffect(() => {
    void call(() => window.api.youtube.status()).then((s) => {
      if (!s) return
      setStatus(s)
      setClientId(s.clientId)
    })
  }, [])

  const loadInsights = async (refresh = false) => {
    setLoadingInsights(true)
    const r = await call(() => window.api.youtube.insights({ refresh }), 'Could not read the channel insights')
    setLoadingInsights(false)
    if (r) setInsights(r)
    void call(() => window.api.youtube.status()).then((s) => s && setStatus(s))
  }

  useEffect(() => {
    if (status?.connected && !insights && !loadingInsights) void loadInsights()
    // Only when the connection appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.connected])

  if (!status) return null
  const configured = !!status.clientId && status.hasClientSecret
  const showForm = !configured || editing

  const saveClient = async () => {
    const s = await call(() => window.api.youtube.setClient(clientId.trim(), secret.trim() ? secret.trim() : undefined))
    if (!s) return
    setStatus(s)
    setSecret('')
    setEditing(false)
    toast('Google client saved. The secret is stored with Windows credential protection.')
  }
  const connect = async () => {
    setBusy(true)
    toast('Finish the sign-in in your browser. Pick the Google account that owns the channel.')
    const s = await call(() => window.api.youtube.connect(), 'Not connected')
    setBusy(false)
    if (s) {
      setStatus(s)
      if (s.connected) toast(`Connected${s.channelTitle ? ` to ${s.channelTitle}` : ''}.`)
    }
  }
  const disconnect = async () => {
    const s = await call(() => window.api.youtube.disconnect())
    if (!s) return
    setStatus(s)
    setInsights(null)
    toast('YouTube channel disconnected.')
  }

  const a = insights?.summary.averages
  return (
    <div className="section col">
      <h3>YouTube channel (read-only)</h3>
      <span className="hint">
        Lets Claude learn from your own videos' audience retention: where viewers stay, and where they leave (a long intro, a slow setup…).
        The app only reads analytics; it never uploads or changes anything on YouTube.
      </span>
      <details>
        <summary className="small" style={{ cursor: 'pointer' }}>
          How to set it up (about 5 minutes, once)
        </summary>
        <ol className="small muted" style={{ margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
          <li>
            Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">Google Cloud console</a> and create a
            project (any name).
          </li>
          <li>
            In APIs &amp; Services &gt; Library, enable <b>YouTube Data API v3</b> and <b>YouTube Analytics API</b>.
          </li>
          <li>
            In Google Auth Platform (OAuth consent screen), choose External, fill in the app name and your email, and under Audience &gt; Test users
            add the Google account that owns your channel.
          </li>
          <li>
            In Clients (Credentials), create an OAuth client of type <b>Desktop app</b>, then copy its Client ID and Client secret here.
          </li>
          <li>Press Connect and sign in with the channel's account. While the app stays in Testing mode, Google asks you to reconnect every 7 days.</li>
        </ol>
      </details>

      {showForm ? (
        <>
          <div className="field-row">
            <label className="label">Client ID</label>
            <input type="text" className="mono" placeholder="1234…apps.googleusercontent.com" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
          </div>
          <div className="field-row">
            <label className="label">Client secret</label>
            <input
              type="password"
              placeholder={status.hasClientSecret ? 'Saved (leave empty to keep it)' : 'GOCSPX-…'}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="row">
            <button className="btn primary" disabled={!clientId.trim() || (!secret.trim() && !status.hasClientSecret)} onClick={saveClient}>
              Save
            </button>
            {editing && (
              <button className="btn ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="row">
          <span className={`status-dot ${status.connected ? 'ok' : status.error ? 'warn' : ''}`} />
          <span className="grow">
            {status.connected
              ? `Connected${status.channelTitle ? ` as ${status.channelTitle}` : ''}${status.videoCount ? ` · ${status.videoCount} videos` : ''}`
              : busy
                ? 'Waiting for the sign-in in your browser…'
                : 'Not connected'}
          </span>
          {status.connected ? (
            <button className="btn ghost danger" onClick={disconnect}>
              Disconnect
            </button>
          ) : (
            <button className="btn primary" disabled={busy} onClick={connect}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          )}
          <button className="btn ghost" onClick={() => setEditing(true)}>
            Change client
          </button>
        </div>
      )}
      {status.error && <div className="small warn">{status.error}</div>}

      {status.connected && (
        <div className="card pad col" style={{ gap: 6 }}>
          <div className="row">
            <b className="grow">Channel insights</b>
            <button className="btn ghost small" disabled={loadingInsights} onClick={() => void loadInsights(true)}>
              {loadingInsights ? 'Reading…' : 'Refresh'}
            </button>
          </div>
          {!insights ? (
            <span className="small muted">{loadingInsights ? 'Reading your channel’s analytics…' : 'No insights yet.'}</span>
          ) : insights.summary.videosAnalysed === 0 ? (
            <span className="small muted">{insights.summary.notes[0]}</span>
          ) : (
            <>
              <div className="row small" style={{ gap: 16, flexWrap: 'wrap' }}>
                <span>
                  Still watching at 0:30: <b>{a?.at30sPct ?? '–'} %</b>
                </span>
                <span>
                  at 1:00: <b>{a?.at1minPct ?? '–'} %</b>
                </span>
                <span>
                  Watched on average: <b>{a?.averageViewPct ?? '–'} %</b>
                  {a?.averageViewDurationSec ? ` (${clock(a.averageViewDurationSec)})` : ''}
                </span>
              </div>
              {insights.summary.dropSpots.length > 0 && (
                <div className="small">
                  <span className="muted">Where viewers leave fastest: </span>
                  {insights.summary.dropSpots.slice(0, 3).map((d, i) => (
                    <span key={d.where}>
                      {i > 0 ? ' · ' : ''}
                      {d.where} ({d.videos} of {insights.summary.videosAnalysed} videos, −{d.avgLostPct} pts)
                    </span>
                  ))}
                </div>
              )}
              {insights.summary.heldBest[0] && (
                <div className="small">
                  <span className="muted">Held best: </span>
                  {insights.summary.heldBest[0].title}
                  {insights.summary.heldBest[0].averageViewPct !== null ? ` (${insights.summary.heldBest[0].averageViewPct} % watched)` : ''}
                </div>
              )}
              <span className="hint">
                From your last {insights.summary.videosAnalysed} long videos{insights.summary.shortsSkipped ? ` (${insights.summary.shortsSkipped} Shorts left out)` : ''}.
                Claude reads the same numbers at the start of an edit.
              </span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
