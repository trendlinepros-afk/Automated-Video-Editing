/**
 * Thumbnails: persona and style for this project, the Pikzels model, your own prompt (works without
 * Claude), count, "Use my direction", the other Pikzels tools (recreate, edit, face swap, titles),
 * the options side by side with scores, the full history with prompts, and what it all cost. The base picture
 * (a clean frame of the footage) and Claude's suggested description sit right under the prompt.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PikzelsPricing } from '@shared/ipc'
import { PIKZELS_MODELS, PIKZELS_MODEL_LABELS, formatUsd, supportsPikzonality } from '@shared/pikzelsPricing'
import type { Thumbnail } from '@shared/project'
import type { Pikzonality } from '@shared/settings'
import { app, call, go, openSettings, toast } from '../state/app'
import { applyOp, editor } from '../state/editor'
import { seek } from '../state/player'
import { useStore } from '../state/store'
import { Empty, Toggle } from '../components/bits'
import { Icon } from '../components/Icon'
import { errorMessage, fmt, mediaUrl, relativeTime } from '../util'
import { CostPerAction, costLabel, usePikzelsPricing } from './ThumbnailsPanelCosts'
import { EditTool, FaceSwapTool, RecreateTool, TOOL_LABELS, TitlesTool, type ToolName } from './ThumbnailsPanelTools'

const KIND_LABELS: Record<string, string> = { text: 'From prompt', recreate: 'Recreated', edit: 'Edited', faceswap: 'Face swap' }

const MAX_PROMPT = 750

export function ThumbnailsPanel() {
  const snap = useStore(editor, (s) => s.snapshot!)
  const th = snap.doc.project.thumbnails
  const ro = snap.readOnly
  const [pikz, setPikz] = useState<Pikzonality[]>([])
  const [hasKey, setHasKey] = useState(true)
  const [prompt, setPrompt] = useState(th.direction || th.draft?.text || '')
  const [busy, setBusy] = useState(false)
  const [grabbing, setGrabbing] = useState(false)
  const [model, setModel] = useState(() => app.get().settings?.pikzels.model || 'pkz_4_5')
  const [tool, setTool] = useState<ToolName | null>(null)
  const [targetId, setTargetId] = useState<string | null>(null)
  const [pricing, reloadPricing] = usePikzelsPricing(th.spend?.total)
  const target = th.items.find((t) => t.id === targetId) ?? null
  const pikzOk = supportsPikzonality(model)
  const openTool = (name: ToolName, id?: string) => {
    setTool(name)
    if (id) setTargetId(id)
  }
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    void call(() => window.api.pikzels.list()).then((l) => setPikz(l ?? []))
    void call(() => window.api.settings.hasPikzelsKey()).then((k) => setHasKey(!!k))
  }, [])

  const personas = pikz.filter((p) => p.kind === 'persona' && p.status === 'completed')
  const styles = pikz.filter((p) => p.kind === 'style' && p.status === 'completed')
  const patch = (p: Record<string, unknown>) => void applyOp({ op: 'patchProject', path: 'thumbnails', patch: p })

  // While "Use my direction" is on, the prompt text is Claude's guidance: keep it saved as you type.
  const onPrompt = (text: string) => {
    setPrompt(text)
    if (!th.useMyDirection) return
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => patch({ direction: text }), 800)
  }
  useEffect(() => () => clearTimeout(saveTimer.current), [])

  // Claude's description fills the box only while it holds nothing of yours (empty, or the previous draft).
  const draft = th.draft
  const lastDraft = useRef({ at: draft?.at, text: draft?.text ?? '' })
  useEffect(() => {
    if (!draft || draft.at === lastDraft.current.at) return
    const prev = lastDraft.current.text
    lastDraft.current = { at: draft.at, text: draft.text }
    setPrompt((cur) => (!cur.trim() || cur === prev ? draft.text : cur))
  }, [draft])

  const drafting = snap.doc.project.requests.some((r) => r.kind === 'thumbnail_draft' && (r.status === 'queued' || r.status === 'in_progress'))
  // `quiet`: the automatic first ask stays silent when it fails (Claude not connected yet, say).
  const requestDraft = async (quiet = false) => {
    try {
      await window.api.thumbnails.requestDraft()
      toast('Claude is writing the description and picking the frame…')
    } catch (e) {
      if (!quiet) toast(`Could not ask Claude: ${errorMessage(e)}`, { kind: 'error' })
    }
  }
  // Once per visit: a finished edit with an empty box and nothing from Claude yet gets a description automatically.
  const autoDrafted = useRef(false)
  useEffect(() => {
    if (autoDrafted.current) return
    autoDrafted.current = true
    const p = snap.doc.project
    const done = p.status === 'ready_for_review' || p.status === 'exported'
    if (!ro && done && !prompt.trim() && !th.draft && !drafting && p.items.some((i) => i.type === 'segment')) void requestDraft(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const grab = async () => {
    setGrabbing(true)
    await call(() => window.api.thumbnails.grabBase(editor.get().playhead), 'Could not grab the frame')
    setGrabbing(false)
  }

  const generate = async () => {
    setBusy(true)
    try {
      await window.api.thumbnails.generate({ prompt: prompt.trim(), count: th.count, referenceTime: undefined, model })
      toast(`Generating ${th.count} ${th.count === 1 ? 'option' : 'options'} at Pikzels. They download into the project as they finish.`)
    } catch (e) {
      toast(errorMessage(e), { kind: 'error' })
    }
    setBusy(false)
    reloadPricing()
  }

  const batches = useMemo(() => groupBatches(th.items), [th.items])
  const latest = batches[0]

  return (
    <div className="panel">
      {!hasKey && (
        <div className="banner" style={{ borderRadius: 6 }}>
          Add your Pikzels API key to make thumbnails.
          <button className="btn small" onClick={() => openSettings('general')}>
            Settings
          </button>
        </div>
      )}
      <div className="col" style={{ gap: 6 }}>
        <div className="row">
          <span className="label" style={{ width: 60 }}>Model</span>
          <select className="grow" value={model} disabled={ro} onChange={(e) => setModel(e.target.value)}>
            {PIKZELS_MODELS.map((m) => (
              <option key={m} value={m}>
                {PIKZELS_MODEL_LABELS[m]}
                {pricing ? ` · ${formatUsd(pricing.prices[`thumbnail:${m}`] ?? 0)}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <span className="label" style={{ width: 60 }}>Persona</span>
          <PikzSelect value={th.personaId} options={personas} disabled={ro || !pikzOk} onChange={(v) => patch({ personaId: v })} />
        </div>
        <div className="row">
          <span className="label" style={{ width: 60 }}>Style</span>
          <PikzSelect value={th.styleId} options={styles} disabled={ro || !pikzOk} onChange={(v) => patch({ styleId: v })} />
        </div>
        {!pikzOk && <span className="hint warn">Persona and style only work on PKZ-4.5 and PKZ-4. This model makes thumbnails without them.</span>}
        <span className="hint">
          These apply to this project only. <a onClick={() => openSettings('profiles', snap.doc.project.profileId)}>Profile defaults</a> ·{' '}
          <a onClick={() => go('personas')}>Personas & Styles</a>
        </span>
      </div>

      <div className="col" style={{ gap: 6 }}>
        <textarea rows={4} value={prompt} disabled={ro} onChange={(e) => onPrompt(e.target.value)} placeholder="Describe the thumbnail, e.g. me holding a burning LiPo battery, shocked face, big bold text “IT EXPLODED”. (Win+H to speak)" />
        <div className="row small">
          <span className={prompt.length > MAX_PROMPT ? 'warn' : 'faint'}>
            {prompt.length}/{MAX_PROMPT}
            {prompt.length > MAX_PROMPT ? ' · Pikzels may shorten prompts this long' : ''}
          </span>
          {/https?:\/\/|www\./i.test(prompt) && <span className="warn">Links are removed from prompts</span>}
          {draft && prompt === draft.text && <span className="tiny faint">Written by Claude — change anything</span>}
          <span className="spacer" />
          {drafting ? (
            <span className="faint">Claude is writing…</span>
          ) : (
            !ro && <a onClick={() => void requestDraft()}>✨ Write it for me</a>
          )}
        </div>
        <div className="row">
          <div className="seg" title="How many options">
            {[1, 2, 3].map((n) => (
              <button key={n} className={th.count === n ? 'on' : ''} disabled={ro} onClick={() => patch({ count: n })}>
                {n}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <button className="btn primary" disabled={ro || busy || !prompt.trim() || !hasKey} onClick={generate}>
            <Icon name="sparkle" size={14} /> {busy ? 'Sending…' : `Generate ${th.count}${costLabel(pricing, 'thumbnail', model, th.count)}`}
          </button>
        </div>
        <div className="row">
          <button className="btn small" disabled={ro || grabbing} onClick={grab} title="Use the frame at the playhead as the base picture">
            <Icon name="camera" size={13} /> {grabbing ? 'Grabbing…' : 'Grab screenshot'}
          </button>
          {th.base && (
            <>
              <img className="thumb-base" src={mediaUrl(th.base.file, snap.path)} alt="" title="Go to this frame" onClick={() => seek(th.base!.time)} />
              <div className="col small grow" style={{ gap: 0 }}>
                <span>Base picture</span>
                <span className="faint">
                  {fmt(th.base.time)} · {th.base.by === 'user' ? 'from you' : 'picked by Claude'}
                </span>
              </div>
              <button className="btn small" disabled={ro} title="Stop using this picture" onClick={() => void call(() => window.api.thumbnails.clearBase())}>
                <Icon name="close" size={12} />
              </button>
            </>
          )}
        </div>
        <span className="hint">
          {th.base
            ? 'A clean frame from the footage: captions, graphics and effects are left out. Pikzels builds the thumbnail around it.'
            : 'Pick the frame that shows what the video is about, then Grab screenshot.'}
        </span>
        <Toggle
          checked={th.useMyDirection}
          disabled={ro}
          onChange={(v) => patch({ useMyDirection: v, direction: prompt })}
          label="Use my direction: Claude follows this text when it writes thumbnail prompts"
        />
      </div>

      <div className="col" style={{ gap: 6 }}>
        <div className="row">
          <h4 className="grow">More tools</h4>
          <div className="seg">
            {(Object.keys(TOOL_LABELS) as ToolName[]).map((k) => (
              <button key={k} className={tool === k ? 'on' : ''} onClick={() => setTool(tool === k ? null : k)}>
                {TOOL_LABELS[k]}
              </button>
            ))}
          </div>
        </div>
        {tool &&
          (() => {
            const props = { pricing, model, dir: snap.path, target, thumbs: th.items, setTarget: setTargetId, disabled: ro || !hasKey, onDone: reloadPricing }
            if (tool === 'recreate') return <RecreateTool {...props} />
            if (tool === 'edit') return <EditTool {...props} />
            if (tool === 'faceswap') return <FaceSwapTool {...props} />
            return <TitlesTool {...props} chosenId={th.chosenId} />
          })()}
      </div>

      {latest ? (
        <div className="col" style={{ gap: 6 }}>
          <h4>Options</h4>
          <div className="thumb-grid">
            {latest.items.map((t) => (
              <ThumbCard key={t.id} t={t} chosen={th.chosenId === t.id} dir={snap.path} ro={ro} pricing={pricing} title={snap.doc.project.publish.titles[0]} onTool={openTool} onScored={reloadPricing} />
            ))}
          </div>
        </div>
      ) : (
        <Empty title="No thumbnails yet">
          <div className="small">Claude makes them when the edit is ready. You can also type a prompt above and press Generate at any time.</div>
        </Empty>
      )}

      {th.items.length > 0 && (
        <div className="col" style={{ gap: 0 }}>
          <h4 style={{ marginBottom: 6 }}>History</h4>
          {th.items
            .slice()
            .reverse()
            .map((t) => (
              <div key={t.id} className="history-row">
                {t.file && t.status === 'done' ? <img src={mediaUrl(t.file, snap.path)} alt="" /> : <div className="ph" />}
                <div className="col" style={{ gap: 2 }}>
                  <div className="row tiny faint">
                    <span>{t.source === 'user' ? 'You' : 'Claude'}</span>
                    <span>· {relativeTime(t.createdAt)}</span>
                    {t.status === 'pending' && <span className="warn">· generating</span>}
                    {t.status === 'failed' && <span className="bad">· failed</span>}
                    {th.chosenId === t.id && <span className="ok">· chosen</span>}
                    {t.kind && <span>· {KIND_LABELS[t.kind] ?? t.kind}</span>}
                    {t.cost !== undefined && <span title="What Pikzels charged">· {formatUsd(t.cost)}</span>}
                    {t.score && <span className="ok">· score {t.score.main}</span>}
                    {t.requestId && <span title="Pikzels request ID">· {t.requestId.slice(0, 8)}</span>}
                  </div>
                  <div className="small selectable" style={{ wordBreak: 'break-word' }}>{t.prompt}</div>
                  {t.error && <div className="small bad">{t.error}</div>}
                  {t.warning && <div className="small warn">{t.warning}</div>}
                  {t.status === 'done' && th.chosenId !== t.id && !ro && (
                    <div>
                      <a className="small" onClick={() => void call(() => window.api.thumbnails.choose(t.id))}>
                        Use this one
                      </a>
                    </div>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}

      <CostPerAction pricing={pricing} projectSpend={th.spend} only={['thumbnail', 'recreate', 'edit', 'faceswap', 'score', 'title']} />
    </div>
  )
}

function groupBatches(items: Thumbnail[]): { id: string; items: Thumbnail[] }[] {
  const out: { id: string; items: Thumbnail[] }[] = []
  const index = new Map<string, number>()
  for (let i = items.length - 1; i >= 0; i--) {
    const t = items[i]
    const key = t.batchId ?? t.id
    const at = index.get(key)
    if (at === undefined) {
      index.set(key, out.length)
      out.push({ id: key, items: [t] })
    } else out[at].items.unshift(t)
  }
  return out
}

function ThumbCard(props: {
  t: Thumbnail
  chosen: boolean
  dir: string
  ro: boolean
  pricing: PikzelsPricing | null
  title?: string
  onTool: (tool: ToolName, id: string) => void
  onScored: () => void
}) {
  const { t, chosen, dir, ro, pricing } = props
  const [scoring, setScoring] = useState(false)
  const score = async () => {
    setScoring(true)
    await call(() => window.api.thumbnails.score(t.id, props.title), 'Could not score the thumbnail')
    setScoring(false)
    props.onScored()
  }
  return (
    <div className={`thumb${chosen ? ' chosen' : ''}`}>
      <div className="img" title={t.prompt}>
        {t.status === 'done' && t.file ? (
          <img src={mediaUrl(t.file, dir)} alt="" />
        ) : t.status === 'pending' ? (
          <span className="spinner" />
        ) : (
          <span className="small bad" style={{ padding: 6, textAlign: 'center' }}>
            {t.error ?? 'Failed'}
          </span>
        )}
        {chosen && <span className="chip accent" style={{ position: 'absolute', top: 4, left: 4 }}>Chosen</span>}
      </div>
      <div className="actions">
        {t.status === 'done' && !chosen && (
          <button className="btn small primary" disabled={ro} onClick={() => void call(() => window.api.thumbnails.choose(t.id))}>
            Pick
          </button>
        )}
        <button className="btn small" disabled={ro || t.status === 'pending'} onClick={() => void call(() => window.api.thumbnails.regenerate(t.id), 'Could not regenerate')} title="Make a new image from the same prompt. The old one stays in History.">
          <Icon name="refresh" size={13} />
        </button>
        {t.status === 'done' && (
          <>
            <button className="btn small" disabled={ro || scoring} onClick={score} title={props.title ? `Score against the title "${props.title}"` : 'Score the thumbnail'}>
              {scoring ? '…' : `Score${costLabel(pricing, 'score')}`}
            </button>
            <button className="btn small" disabled={ro} title="Edit, recreate or face swap this one" onClick={() => props.onTool('edit', t.id)}>
              <Icon name="wand" size={13} />
            </button>
          </>
        )}
        {t.status === 'done' && (
          <button
            className="btn small"
            title="Save the image somewhere"
            onClick={async () => {
              const out = await call(() => window.api.thumbnails.exportImage(t.id))
              if (out) toast('Saved the thumbnail.', { actions: [{ label: 'Show', run: () => void window.api.app.showItemInFolder(out) }] })
            }}
          >
            <Icon name="export" size={13} />
          </button>
        )}
      </div>
      {t.score && (
        <div className="col tiny" style={{ gap: 2, padding: '4px 2px' }} title={t.score.title ? `Scored against "${t.score.title}"` : undefined}>
          <span>
            Score <b>{t.score.main}</b>
            {Object.entries(t.score.subscores ?? {})
              .slice(0, 4)
              .map(([k, v]) => ` · ${k.replace(/_/g, ' ')} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
              .join('')}
          </span>
          {t.score.suggestion && <span className="faint">{t.score.suggestion}</span>}
        </div>
      )}
    </div>
  )
}

function PikzSelect({ value, options, onChange, disabled }: { value: string; options: Pikzonality[]; onChange: (v: string) => void; disabled: boolean }) {
  return (
    <select className="grow" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">None</option>
      {value && !options.some((o) => o.id === value) && <option value={value}>(still training or deleted)</option>}
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  )
}
