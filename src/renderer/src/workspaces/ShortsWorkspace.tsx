/**
 * Shorts: OpusClip makes short clips from the finished video and posts or schedules them to the accounts connected
 * in OpusClip. Open at any time; making clips needs a finished edit. Left: the video to send and every option
 * OpusClip's API takes. Right: the runs and their clips (preview, download, bleep swear words, collections, post or
 * schedule with titles written by OpusClip), then the posts and the collections.
 */
import { useEffect, useMemo, useState } from 'react'
import type { OpusAccount, OpusClipItem, OpusClipOptions, OpusCollection, OpusRun, OpusSourceInfo, OpusState, OpusTemplate } from '@shared/opusclip'
import { call, openSettings, toast } from '../state/app'
import { editor } from '../state/editor'
import { useStore } from '../state/store'
import { Spinner, Toggle } from '../components/bits'
import { Icon } from '../components/Icon'
import { fmt, relativeTime } from '../util'
import { FlowFooter } from './FlowFooter'

const LANGS: [string, string][] = [
  ['auto', 'Detect automatically'],
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['zh', 'Chinese']
]
const LENGTHS: [string, [number, number][] | undefined][] = [
  ['Auto (OpusClip decides)', undefined],
  ['Under 30 s', [[0, 30]]],
  ['30 s to 60 s', [[30, 60]]],
  ['60 s to 90 s', [[60, 90]]],
  ['90 s to 3 min', [[90, 180]]],
  ['Under 60 s (any)', [[0, 60]]]
]

const gb = (b: number) => `${(b / 1e9).toFixed(b > 1e10 ? 0 : 1)} GB`

export function ShortsWorkspace() {
  const status = useStore(editor, (s) => s.snapshot!.doc.project.status)
  const projectName = useStore(editor, (s) => s.snapshot!.doc.project.name)
  const ready = status === 'ready_for_review' || status === 'exported'
  const [state, setState] = useState<OpusState | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  useEffect(() => {
    void call(() => window.api.opusclip.state()).then((s) => s && setState(s))
    return window.api.opusclip.onState((s) => setState(s))
  }, [])
  const runs = state?.runs ?? []
  const run = runs.find((r) => r.id === runId) ?? runs[0]

  return (
    <div className="workspace">
      <div className="workspace-body">
        <div className="thumbs-page shorts-page">
          <aside className="col thumbs-left">
            {!state ? <Spinner label="Loading…" /> : !state.hasKey ? <KeyNeeded /> : <MakeClips ready={ready} projectName={projectName} onStarted={(r) => setRunId(r.id)} />}
          </aside>
          <div className="col thumbs-main">
            {!ready && (
              <div className="banner">
                <Icon name="note" size={14} /> Shorts are made from the finished video. Finish the edit (and export it) first; you can look around here
                meanwhile.
              </div>
            )}
            <section className="card thumbs-card">
              <div className="row">
                <h3 className="grow">Clips</h3>
                {runs.length > 1 && (
                  <select value={run?.id} onChange={(e) => setRunId(e.target.value)} title="Earlier runs">
                    {runs.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.title} · {relativeTime(r.createdAt)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {run ? <RunView run={run} /> : <span className="muted">No clips yet. Choose the options on the left and press Make clips.</span>}
            </section>
            {state && state.posts.length > 0 && <Posts state={state} />}
            {state?.hasKey && <Collections run={run} />}
          </div>
        </div>
      </div>
      <FlowFooter hint="OpusClip finds the best moments, reframes them vertical and captions them. Nothing posts until you press Post or Schedule.">
        <span />
      </FlowFooter>
    </div>
  )
}

function KeyNeeded() {
  return (
    <section className="card thumbs-card">
      <h3>Connect OpusClip</h3>
      <span className="muted">Paste your OpusClip API key (app.opus.pro → Settings → Integration tokens) in Settings &gt; API keys. It is encrypted on this PC and never shown again.</span>
      <div className="row">
        <button className="btn primary" onClick={() => openSettings('keys')}>
          Open API keys
        </button>
      </div>
    </section>
  )
}

/** The video to send and every clipping option. */
function MakeClips({ ready, projectName, onStarted }: { ready: boolean; projectName: string; onStarted: (r: OpusRun) => void }) {
  const [source, setSource] = useState<OpusSourceInfo | null | undefined>(undefined)
  const [picked, setPicked] = useState<string | null>(null)
  const [templates, setTemplates] = useState<OpusTemplate[]>([])
  const [o, setO] = useState<Omit<OpusClipOptions, 'sourcePath'>>({ title: projectName, model: 'ClipAnything', layoutAspectRatio: 'portrait', sourceLang: 'auto', removeFillerWords: true })
  const [lengths, setLengths] = useState(0)
  const [keywords, setKeywords] = useState('')
  const [useRange, setUseRange] = useState(false)
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<OpusClipOptions>) => setO((x) => ({ ...x, ...patch }))
  useEffect(() => {
    void call(() => window.api.opusclip.defaultSource()).then((s) => setSource(s ?? null))
    void window.api.opusclip.brandTemplates().then(setTemplates, () => undefined)
  }, [])
  const file = picked ?? source?.path ?? null
  const choose = async () => {
    const [f] = (await call(() => window.api.app.pickFiles({ title: 'The video to make shorts from', filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm'] }] }))) ?? []
    if (f) setPicked(f)
  }
  const start = async () => {
    if (!file) return
    setBusy(true)
    const opts: OpusClipOptions = {
      ...o,
      sourcePath: file,
      clipDurations: LENGTHS[lengths][1],
      topicKeywords: keywords.split(',').map((k) => k.trim()).filter(Boolean),
      ...(useRange ? {} : { rangeStart: undefined, rangeEnd: undefined })
    }
    const r = await call(() => window.api.opusclip.start(opts), 'Could not send the video to OpusClip')
    setBusy(false)
    if (r) {
      onStarted(r)
      toast('Sending the video to OpusClip. You can keep working; the clips show up here when they are ready.')
    }
  }
  const disabled = !ready || busy

  return (
    <section className="card thumbs-card shorts-form">
      <h3>Make clips with OpusClip</h3>
      <div className="field">
        <label>Video</label>
        {source === undefined ? (
          <Spinner />
        ) : file ? (
          <code className="ellipsis" title={file}>
            {file.split(/[\\/]/).pop()}
            {!picked && source ? ` · ${gb(source.sizeBytes)}` : ''}
          </code>
        ) : (
          <span className="muted">No export of the whole video yet. Export it (Finish And Export) or choose a file.</span>
        )}
        <div className="row">
          <button className="btn small" onClick={() => void choose()}>
            Choose file…
          </button>
          {picked && (
            <button className="btn small ghost" onClick={() => setPicked(null)}>
              Use the newest export
            </button>
          )}
        </div>
        <span className="hint">Send the full-resolution export: the vertical clips are cropped from it. Over 10 GB, a smaller copy at the same size goes up.</span>
      </div>
      <div className="field">
        <label>Name at OpusClip</label>
        <input type="text" value={o.title ?? ''} onChange={(e) => set({ title: e.target.value })} />
      </div>
      <div className="field">
        <label>Clipping model</label>
        <div className="seg" style={{ width: 'fit-content' }}>
          <button className={o.model === 'ClipAnything' ? 'on' : ''} onClick={() => set({ model: 'ClipAnything' })}>
            ClipAnything
          </button>
          <button className={o.model === 'ClipBasic' ? 'on' : ''} onClick={() => set({ model: 'ClipBasic' })}>
            ClipBasic
          </button>
        </div>
        <span className="hint">{o.model === 'ClipAnything' ? 'Any kind of video (action, product shots), guided by what you describe.' : 'Talking-head videos, guided by topic keywords.'}</span>
      </div>
      <div className="field">
        <label>{o.model === 'ClipAnything' ? 'What to look for' : 'Prompt (optional)'}</label>
        <textarea rows={3} value={o.customPrompt ?? ''} placeholder="e.g. the best drifts, the price reveal and the gyro test" onChange={(e) => set({ customPrompt: e.target.value })} />
      </div>
      <div className="field">
        <label>Topic keywords</label>
        <input type="text" value={keywords} placeholder="drift, gyro, price, Rlaarlo XDX" onChange={(e) => setKeywords(e.target.value)} />
      </div>
      <div className="row wrap" style={{ gap: 12 }}>
        <div className="field">
          <label>Clip length</label>
          <select value={lengths} onChange={(e) => setLengths(parseInt(e.target.value))}>
            {LENGTHS.map(([l], i) => (
              <option key={l} value={i}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Layout</label>
          <select value={o.layoutAspectRatio} onChange={(e) => set({ layoutAspectRatio: e.target.value as OpusClipOptions['layoutAspectRatio'] })}>
            <option value="portrait">Vertical 9:16</option>
            <option value="square">Square 1:1</option>
            <option value="landscape">Landscape 16:9</option>
          </select>
        </div>
        <div className="field">
          <label>Language</label>
          <select value={o.sourceLang} onChange={(e) => set({ sourceLang: e.target.value })}>
            {LANGS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="row wrap" style={{ gap: 12 }}>
        <div className="field">
          <label>Brand template</label>
          <select value={o.brandTemplateId ?? ''} onChange={(e) => set({ brandTemplateId: e.target.value || undefined })}>
            <option value="">OpusClip default</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Genre</label>
          <input type="text" value={o.genre ?? ''} placeholder="e.g. Automotive" onChange={(e) => set({ genre: e.target.value })} style={{ width: 150 }} />
        </div>
      </div>
      <Toggle checked={o.removeFillerWords ?? true} onChange={(v) => set({ removeFillerWords: v })} label="Remove filler words (um, uh)" />
      <Toggle checked={useRange} onChange={setUseRange} label="Only part of the video" />
      {useRange && (
        <div className="row small">
          <span className="muted">From</span>
          <input type="number" min={0} style={{ width: 80 }} value={o.rangeStart ?? 0} onChange={(e) => set({ rangeStart: Math.max(0, parseFloat(e.target.value) || 0) })} />
          <span className="muted">to</span>
          <input type="number" min={0} style={{ width: 80 }} value={o.rangeEnd ?? ''} placeholder="end" onChange={(e) => set({ rangeEnd: e.target.value ? Math.max(0, parseFloat(e.target.value)) : undefined })} />
          <span className="muted">seconds</span>
        </div>
      )}
      <details>
        <summary className="small">More</summary>
        <div className="col" style={{ gap: 8, marginTop: 8 }}>
          <Toggle checked={!!o.skipCurate} onChange={(v) => set({ skipCurate: v })} label="Upload only, no clipping (to edit it in OpusClip yourself)" />
          <div className="field">
            <label>Email me when the clips are ready</label>
            <input type="email" value={o.notifyEmail ?? ''} placeholder="you@example.com" onChange={(e) => set({ notifyEmail: e.target.value })} />
          </div>
          <div className="field">
            <label>Webhook when ready (advanced)</label>
            <input type="text" value={o.webhookUrl ?? ''} placeholder="https://…" onChange={(e) => set({ webhookUrl: e.target.value })} />
          </div>
          <Toggle checked={!!o.notifyOnFailure} onChange={(v) => set({ notifyOnFailure: v })} label="Also tell me if it fails" />
        </div>
      </details>
      <div className="row">
        <span className="grow" />
        <button className="btn primary" disabled={disabled || !file} onClick={() => void start()} title={!ready ? 'Finish the edit first' : ''}>
          {busy ? 'Sending…' : 'Make clips'}
        </button>
      </div>
    </section>
  )
}

function RunView({ run }: { run: OpusRun }) {
  const [post, setPost] = useState<OpusClipItem | null>(null)
  const working = run.phase === 'preparing' || run.phase === 'uploading' || run.phase === 'processing'
  const share = async (v: 'DEFAULT' | 'PUBLIC') => {
    if (await call(() => window.api.opusclip.share(run.id, v), 'Could not change sharing')) toast(v === 'PUBLIC' ? 'Anyone with the link can now open this OpusClip project.' : 'Only your OpusClip team can open this project now.')
  }
  const sorted = useMemo(() => [...run.clips].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)), [run.clips])
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row wrap small">
        <b className="grow">{run.title}</b>
        {run.projectId && (
          <select value={run.visibility ?? 'DEFAULT'} onChange={(e) => void share(e.target.value as 'DEFAULT' | 'PUBLIC')} title="Who can open this project at OpusClip">
            <option value="DEFAULT">Shared with my OpusClip team</option>
            <option value="PUBLIC">Anyone with the link</option>
          </select>
        )}
        {run.projectId && (
          <button className="btn small ghost" onClick={() => void call(() => window.api.opusclip.refresh(run.id), 'Could not refresh')}>
            Refresh
          </button>
        )}
        {working && run.phase !== 'processing' && (
          <button className="btn small ghost" onClick={() => void window.api.opusclip.cancel(run.id)}>
            Cancel
          </button>
        )}
        <button
          className="btn small ghost danger"
          onClick={() => void window.api.opusclip.removeRun(run.id)}
          title="Remove from this list (the project stays in your OpusClip account)"
        >
          Remove
        </button>
      </div>
      {working && (
        <div className="col" style={{ gap: 4 }}>
          <Spinner label={run.message ?? 'Working…'} />
          <div className="progress">
            <div style={{ width: `${run.percent ?? 0}%` }} />
          </div>
          <span className="hint">You can close this tab or keep editing. OpusClip usually needs 10 to 30 minutes for a long video.</span>
        </div>
      )}
      {run.phase === 'failed' && <div className="banner error">{run.error ?? 'OpusClip could not make the clips.'}</div>}
      {run.phase === 'complete' && !sorted.length && <span className="muted">OpusClip made no clips from this video{run.options.skipCurate ? ' (upload only)' : ''}.</span>}
      <div className="shorts-grid">
        {sorted.map((c) => (
          <ClipCard key={c.id} run={run} clip={c} onPost={() => setPost(c)} />
        ))}
      </div>
      {post && <PostPanel run={run} clip={post} onClose={() => setPost(null)} />}
    </div>
  )
}

function ClipCard({ run, clip, onPost }: { run: OpusRun; clip: OpusClipItem; onPost: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const act = async <T,>(what: string, fn: () => Promise<T>, fail: string) => {
    setBusy(what)
    const r = await call(fn, fail)
    setBusy(null)
    return r
  }
  const download = async () => {
    const f = await act('download', () => window.api.opusclip.download(run.id, clip.id), 'Could not download the clip')
    if (f) toast('Clip saved in the Export\\Shorts folder.', { actions: [{ label: 'Show', run: () => void window.api.app.showItemInFolder(f) }] })
  }
  const censor = (beep: boolean) => void act('censor', () => window.api.opusclip.censor(run.id, clip.id, beep), 'Could not censor the clip')
  return (
    <div className="card shorts-clip">
      {clip.previewUrl ? <video src={clip.previewUrl} controls preload="metadata" className="shorts-video" /> : <div className="shorts-video empty-video">No preview</div>}
      <b className="shorts-title">{clip.title}</b>
      <div className="row wrap small muted" style={{ gap: 8 }}>
        {clip.score !== undefined && <span className="pill">Score {Math.round(clip.score)}</span>}
        {clip.durationSeconds !== undefined && <span>{fmt(clip.durationSeconds)}</span>}
        {clip.censor && <span title={clip.censor.error}>{clip.censor.status}</span>}
        {clip.file && <span>Downloaded</span>}
      </div>
      {clip.hashtags && <span className="small faint">{clip.hashtags}</span>}
      {Object.keys(clip.extra).length > 0 && (
        <details className="small">
          <summary>Details</summary>
          {Object.entries(clip.extra).map(([k, v]) => (
            <div key={k} className="row">
              <span className="faint grow">{k}</span>
              <span>{String(v)}</span>
            </div>
          ))}
        </details>
      )}
      <div className="row wrap" style={{ gap: 6 }}>
        <button className="btn small primary" onClick={onPost}>
          Post…
        </button>
        <button className="btn small" disabled={!!busy} onClick={() => void download()}>
          {busy === 'download' ? 'Downloading…' : 'Download'}
        </button>
        <button className="btn small ghost" disabled={!!busy} onClick={() => censor(true)} title="OpusClip bleeps swear words in this clip">
          {busy === 'censor' ? 'Censoring…' : 'Bleep swears'}
        </button>
        <button className="btn small ghost" disabled={!!busy} onClick={() => censor(false)} title="OpusClip mutes swear words in this clip">
          Mute swears
        </button>
      </div>
    </div>
  )
}

/** Post now or schedule one clip to a connected account, with the text OpusClip writes for that platform. */
function PostPanel({ run, clip, onClose }: { run: OpusRun; clip: OpusClipItem; onClose: () => void }) {
  const [accounts, setAccounts] = useState<OpusAccount[] | null>(null)
  const [acc, setAcc] = useState('')
  const [title, setTitle] = useState(clip.title)
  const [description, setDescription] = useState(clip.description ?? clip.hashtags ?? '')
  const [privacy, setPrivacy] = useState<'public' | 'private' | 'unlisted'>('public')
  const [style, setStyle] = useState('')
  const [when, setWhen] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    void call(() => window.api.opusclip.socialAccounts(), 'Could not load your connected accounts').then((a) => {
      setAccounts(a ?? [])
      if (a?.[0]) setAcc(key(a[0]))
    })
  }, [])
  const key = (a: OpusAccount) => `${a.postAccountId}|${a.subAccountId ?? ''}`
  const account = accounts?.find((a) => key(a) === acc)
  const youtube = /youtube/i.test(account?.platform ?? '')
  const write = async (force: boolean) => {
    if (!account) return
    setBusy('write')
    const r = await call(
      () => window.api.opusclip.socialCopy({ runId: run.id, clipId: clip.id, postAccountId: account.postAccountId, subAccountId: account.subAccountId, prompt: style, forceRegenerate: force }),
      'OpusClip could not write the text'
    )
    setBusy(null)
    if (r) {
      setTitle(r.title || title)
      setDescription([r.description, r.hashtags].filter(Boolean).join('\n\n'))
    }
  }
  const send = async () => {
    if (!account) return
    setBusy('post')
    const r = await call(
      () =>
        window.api.opusclip.post({
          runId: run.id,
          clipId: clip.id,
          postAccountId: account.postAccountId,
          subAccountId: account.subAccountId,
          title,
          description,
          ...(youtube ? { privacy } : {}),
          ...(when ? { publishAt: new Date(when).toISOString() } : {})
        }),
      when ? 'Could not schedule the post' : 'Could not post the clip'
    )
    setBusy(null)
    if (r) {
      toast(r.kind === 'scheduled' ? `Scheduled for ${new Date(r.publishAt!).toLocaleString()} on ${account.name}.` : `Sent to ${account.name}. OpusClip uploads it now.`)
      onClose()
    }
  }
  return (
    <div className="card shorts-post">
      <div className="row">
        <h4 className="grow">Post “{clip.title}”</h4>
        <button className="btn small ghost" onClick={onClose}>
          Close
        </button>
      </div>
      {accounts === null ? (
        <Spinner label="Loading your accounts…" />
      ) : !accounts.length ? (
        <span className="muted">No social accounts are connected in OpusClip yet. Connect YouTube, TikTok, Instagram and others in your OpusClip account, then come back.</span>
      ) : (
        <>
          <div className="field">
            <label>Account</label>
            <select value={acc} onChange={(e) => setAcc(e.target.value)}>
              {accounts.map((a) => (
                <option key={key(a)} value={key(a)}>
                  {a.platform ? `${a.platform.charAt(0)}${a.platform.slice(1).toLowerCase()}` : 'Account'} · {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="row">
            <input type="text" className="grow" value={style} placeholder="Tone for OpusClip's text (optional), e.g. hype and funny" onChange={(e) => setStyle(e.target.value)} />
            <button className="btn small" disabled={!!busy} onClick={() => void write(false)}>
              {busy === 'write' ? 'Writing…' : 'Write it for this platform'}
            </button>
            <button className="btn small ghost" disabled={!!busy} onClick={() => void write(true)} title="Write it again instead of reusing the last text">
              Again
            </button>
          </div>
          <div className="field">
            <label>Title</label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label>Description and hashtags</label>
            <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="row wrap" style={{ gap: 12 }}>
            {youtube && (
              <div className="field">
                <label>YouTube visibility</label>
                <select value={privacy} onChange={(e) => setPrivacy(e.target.value as typeof privacy)}>
                  <option value="public">Public</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="private">Private</option>
                </select>
              </div>
            )}
            <div className="field">
              <label>When</label>
              <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
              <span className="hint">{when ? 'Scheduled at OpusClip; you can cancel it until then.' : 'Empty: posts right away.'}</span>
            </div>
          </div>
          <div className="row">
            <span className="grow" />
            <button className="btn primary" disabled={!!busy || !title.trim()} onClick={() => void send()}>
              {busy === 'post' ? 'Sending…' : when ? 'Schedule' : 'Post now'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function Posts({ state }: { state: OpusState }) {
  return (
    <section className="card thumbs-card">
      <h3>Posted and scheduled</h3>
      {state.posts.map((p, i) => (
        <div key={p.scheduleId ?? p.postId ?? i} className="row small">
          <span className="grow ellipsis">
            <b>{p.title}</b> · {p.platform ? `${p.platform.charAt(0)}${p.platform.slice(1).toLowerCase()} ` : ''}
            {p.account}
          </span>
          <span className="muted">
            {p.cancelled ? 'Cancelled' : p.kind === 'scheduled' ? `Scheduled ${new Date(p.publishAt!).toLocaleString()}` : `Posted ${relativeTime(p.createdAt)}`}
          </span>
          {p.kind === 'scheduled' && !p.cancelled && p.scheduleId && new Date(p.publishAt!).getTime() > Date.now() && (
            <button className="btn small ghost danger" onClick={() => void call(() => window.api.opusclip.cancelSchedule(p.scheduleId!), 'Could not cancel the post')}>
              Cancel
            </button>
          )}
        </div>
      ))}
    </section>
  )
}

/** OpusClip collections: make, fill with clips of this run, download all, delete. */
function Collections({ run }: { run?: OpusRun }) {
  const [list, setList] = useState<OpusCollection[] | null>(null)
  const [name, setName] = useState('')
  const [clipId, setClipId] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const load = () => void window.api.opusclip.collections().then(setList, () => setList([]))
  useEffect(load, [])
  const clips = run?.clips ?? []
  const create = async () => {
    if (await call(() => window.api.opusclip.createCollection(name), 'Could not make the collection')) {
      setName('')
      load()
    }
  }
  const add = async (c: OpusCollection) => {
    if (!clipId) return
    if ((await call(() => window.api.opusclip.addToCollection(c.id, clipId).then(() => true), 'Could not add the clip')) === true) toast(`Added to ${c.name}.`)
  }
  const remove = async (c: OpusCollection) => {
    if (!clipId) return
    if ((await call(() => window.api.opusclip.removeFromCollection(c.id, clipId).then(() => true), 'Could not remove the clip')) === true) toast(`Removed from ${c.name}.`)
  }
  const exportAll = async (c: OpusCollection) => {
    setBusy(c.id)
    const r = await call(() => window.api.opusclip.exportCollection(c.id), 'Could not download the collection')
    setBusy(null)
    if (r) toast(`${r.files.length} clip${r.files.length === 1 ? '' : 's'} downloaded.`, { actions: [{ label: 'Show', run: () => void window.api.app.openPath(r.dir) }] })
  }
  return (
    <details className="card thumbs-card thumbs-history">
      <summary>
        <h3>Collections</h3>
        <span className="small faint">Group clips in your OpusClip account</span>
      </summary>
      <div className="col" style={{ gap: 8, marginTop: 8 }}>
        <div className="row">
          <input type="text" className="grow" value={name} placeholder="New collection name" onChange={(e) => setName(e.target.value)} />
          <button className="btn small" disabled={!name.trim()} onClick={() => void create()}>
            Make collection
          </button>
        </div>
        {clips.length > 0 && (
          <div className="row small">
            <span className="muted">Clip</span>
            <select className="grow" value={clipId} onChange={(e) => setClipId(e.target.value)}>
              <option value="">Pick a clip to add or remove…</option>
              {clips.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </div>
        )}
        {list === null ? (
          <Spinner />
        ) : !list.length ? (
          <span className="muted small">No collections yet.</span>
        ) : (
          list.map((c) => (
            <div key={c.id} className="row small">
              <span className="grow">{c.name}</span>
              <button className="btn small ghost" disabled={!clipId} onClick={() => void add(c)}>
                Add clip
              </button>
              <button className="btn small ghost" disabled={!clipId} onClick={() => void remove(c)}>
                Remove clip
              </button>
              <button className="btn small ghost" disabled={busy === c.id} onClick={() => void exportAll(c)}>
                {busy === c.id ? 'Downloading…' : 'Download all'}
              </button>
              <button
                className="btn small ghost danger"
                onClick={async () => {
                  if (!confirm(`Delete the collection "${c.name}" in OpusClip? The clips stay.`)) return
                  await call(() => window.api.opusclip.deleteCollection(c.id), 'Could not delete the collection')
                  load()
                }}
              >
                Delete
              </button>
            </div>
          ))
        )}
      </div>
    </details>
  )
}
