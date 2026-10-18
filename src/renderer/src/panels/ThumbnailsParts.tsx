/**
 * The pieces of the thumbnail editor, shared by the narrow Thumbnails tab of the side panel and the full Thumbnails
 * page: one hook with the state and actions (`useThumbnails`), and the blocks built on it (model, persona and style,
 * the prompt box with Claude's description, count and Generate, the options, More tools and History).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PikzelsPricing } from '@shared/ipc'
import { PIKZELS_MODELS, PIKZELS_MODEL_LABELS, formatUsd, supportsPikzonality } from '@shared/pikzelsPricing'
import type { Thumbnail } from '@shared/project'
import type { Pikzonality } from '@shared/settings'
import { app, call, go, openSettings, toast, updateSettings } from '../state/app'
import { applyOp, editor } from '../state/editor'
import { useStore } from '../state/store'
import { Empty, Toggle } from '../components/bits'
import { Icon } from '../components/Icon'
import { IMAGE_EXTS, errorMessage, joinPath, mediaUrl, relativeTime } from '../util'
import { CostPerAction, costLabel, usePikzelsPricing } from './ThumbnailsPanelCosts'
import { EditTool, FaceSwapTool, RecreateTool, TOOL_LABELS, TitlesTool, type ToolName } from './ThumbnailsPanelTools'

const KIND_LABELS: Record<string, string> = { text: 'From prompt', recreate: 'Recreated', edit: 'Edited', faceswap: 'Face swap' }

const MAX_PROMPT = 750

/** State and actions of the thumbnail editor for the open project. */
export function useThumbnails() {
  const snap = useStore(editor, (s) => s.snapshot!)
  const th = snap.doc.project.thumbnails
  const ro = snap.readOnly
  const [pikz, setPikz] = useState<Pikzonality[]>([])
  const [hasKey, setHasKey] = useState(true)
  const [prompt, setPrompt] = useState(th.direction || th.draft?.text || '')
  const [busy, setBusy] = useState(false)
  const [model, setModel] = useState(() => app.get().settings?.pikzels.model || 'pkz_4_5')
  const [tool, setTool] = useState<ToolName | null>(null)
  const [targetId, setTargetId] = useState<string | null>(null)
  // An image file a tool starts on (the base picture, say) instead of a thumbnail.
  const [toolFile, setToolFile] = useState<string | null>(null)
  const [pricing, reloadPricing] = usePikzelsPricing(th.spend?.total)
  const autoScore = useStore(app, (s) => s.settings?.pikzels.autoScore !== false)
  const target = th.items.find((t) => t.id === targetId) ?? null
  const pikzOk = supportsPikzonality(model)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    void call(() => window.api.pikzels.list()).then((l) => setPikz(l ?? []))
    void call(() => window.api.settings.hasPikzelsKey()).then((k) => setHasKey(!!k))
  }, [])

  const personas = pikz.filter((p) => p.kind === 'persona' && p.status === 'completed')
  const styles = pikz.filter((p) => p.kind === 'style' && p.status === 'completed')
  const patch = (p: Record<string, unknown>) => void applyOp({ op: 'patchProject', path: 'thumbnails', patch: p })

  /** Opens a tool on a thumbnail (id) or on an image file. */
  const openTool = (name: ToolName, on?: { id?: string; file?: string }) => {
    setTool(name)
    if (on?.id) {
      setTargetId(on.id)
      setToolFile(null)
    } else if (on?.file) {
      setTargetId(null)
      setToolFile(on.file)
    }
  }

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

  // One quick call: the description (and base picture) arrive when it returns, usually within half a minute.
  const [writing, setWriting] = useState(false)
  const drafting = writing || snap.doc.project.requests.some((r) => r.kind === 'thumbnail_draft' && r.status === 'in_progress')
  // `quiet`: the automatic first ask stays silent when it fails (Claude Code not signed in, say).
  const requestDraft = async (quiet = false) => {
    setWriting(true)
    try {
      await window.api.thumbnails.requestDraft()
    } catch (e) {
      if (!quiet) toast(`Claude could not write the description: ${errorMessage(e)}`, { kind: 'error' })
    }
    setWriting(false)
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

  // The base picture: a frame of the footage at a timeline time, or a picture of your own.
  const [grabbing, setGrabbing] = useState(false)
  const grab = async (time: number) => {
    setGrabbing(true)
    await call(() => window.api.thumbnails.grabBase(time), 'Could not grab the frame')
    setGrabbing(false)
  }
  const uploadBase = async () => {
    const files = await call(() => window.api.app.pickFiles({ title: 'Choose a picture for the thumbnail', filters: [{ name: 'Images', extensions: IMAGE_EXTS }] }))
    if (!files?.[0]) return
    setGrabbing(true)
    await call(() => window.api.thumbnails.useImageAsBase(files[0]), 'Could not use the picture')
    setGrabbing(false)
  }
  const clearBase = () => void call(() => window.api.thumbnails.clearBase())
  /** The base picture's full path, for the tools that take an image file. */
  const baseFile = th.base ? (/^[a-z][a-z-]+:/i.test(th.base.file) ? th.base.file : joinPath(snap.path, th.base.file)) : null

  const batches = useMemo(() => groupBatches(th.items), [th.items])

  return {
    snap,
    th,
    ro,
    dir: snap.path,
    hasKey,
    personas,
    styles,
    model,
    setModel,
    pikzOk,
    pricing,
    reloadPricing,
    autoScore,
    prompt,
    onPrompt,
    draft,
    drafting,
    requestDraft,
    busy,
    generate,
    patch,
    tool,
    setTool,
    target,
    setTargetId,
    toolFile,
    openTool,
    grabbing,
    grab,
    uploadBase,
    clearBase,
    baseFile,
    batches,
    latest: batches[0] as { id: string; items: Thumbnail[] } | undefined
  }
}

export type Thumbs = ReturnType<typeof useThumbnails>

export function PikzelsKeyBanner({ c }: { c: Thumbs }) {
  if (c.hasKey) return null
  return (
    <div className="banner" style={{ borderRadius: 6 }}>
      Add your Pikzels API key to make thumbnails.
      <button className="btn small" onClick={() => openSettings('general')}>
        Settings
      </button>
    </div>
  )
}

/** Model, persona and style. `wide`: the three side by side with the label above. */
export function ModelFields({ c, wide }: { c: Thumbs; wide?: boolean }) {
  const { ro, pricing, th } = c
  const fields: [string, React.ReactNode][] = [
    [
      'Model',
      <select key="m" className="grow" value={c.model} disabled={ro} onChange={(e) => c.setModel(e.target.value)}>
        {PIKZELS_MODELS.map((m) => (
          <option key={m} value={m}>
            {PIKZELS_MODEL_LABELS[m]}
            {pricing ? ` · ${formatUsd(pricing.prices[`thumbnail:${m}`] ?? 0)}` : ''}
          </option>
        ))}
      </select>
    ],
    ['Persona', <PikzSelect key="p" value={th.personaId} options={c.personas} disabled={ro || !c.pikzOk} onChange={(v) => c.patch({ personaId: v })} />],
    ['Style', <PikzSelect key="s" value={th.styleId} options={c.styles} disabled={ro || !c.pikzOk} onChange={(v) => c.patch({ styleId: v })} />]
  ]
  return (
    <div className="col" style={{ gap: 6 }}>
      {wide ? (
        <div className="thumbs-fields">
          {fields.map(([label, el]) => (
            <div key={label} className="field">
              <label>{label}</label>
              {el}
            </div>
          ))}
        </div>
      ) : (
        fields.map(([label, el]) => (
          <div key={label} className="row">
            <span className="label" style={{ width: 60 }}>
              {label}
            </span>
            {el}
          </div>
        ))
      )}
      {!c.pikzOk && <span className="hint warn">Persona and style only work on PKZ-4.5 and PKZ-4. This model makes thumbnails without them.</span>}
      <span className="hint">
        These apply to this project only. <a onClick={() => openSettings('profiles', c.snap.doc.project.profileId)}>Profile defaults</a> ·{' '}
        <a onClick={() => go('personas')}>Personas & Styles</a>
      </span>
    </div>
  )
}

/** The description box with its counter and Claude's "Write it for me". */
export function PromptBox({ c, rows = 4 }: { c: Thumbs; rows?: number }) {
  const { prompt, draft, ro } = c
  return (
    <div className="col" style={{ gap: 6 }}>
      <textarea rows={rows} value={prompt} disabled={ro} onChange={(e) => c.onPrompt(e.target.value)} placeholder="Describe the thumbnail, e.g. me holding a burning LiPo battery, shocked face, big bold text “IT EXPLODED”. (Win+H to speak)" />
      <div className="row small">
        <span className={prompt.length > MAX_PROMPT ? 'warn' : 'faint'}>
          {prompt.length}/{MAX_PROMPT}
          {prompt.length > MAX_PROMPT ? ' · Pikzels may shorten prompts this long' : ''}
        </span>
        {/https?:\/\/|www\./i.test(prompt) && <span className="warn">Links are removed from prompts</span>}
        {draft && prompt === draft.text && <span className="tiny faint">Written by Claude — change anything</span>}
        <span className="spacer" />
        {c.drafting ? (
          <span className="faint">
            <span className="spinner" style={{ width: 10, height: 10, verticalAlign: -1 }} /> Claude is writing…
          </span>
        ) : (
          !ro && <a onClick={() => void c.requestDraft()}>✨ Write it for me</a>
        )}
      </div>
    </div>
  )
}

/** How many options (1 to 3) and Generate. */
export function GenerateRow({ c, label }: { c: Thumbs; label?: string }) {
  const { th, ro } = c
  return (
    <div className="row">
      {label && <span className="label">{label}</span>}
      <div className="seg" title="How many options">
        {[1, 2, 3].map((n) => (
          <button key={n} className={th.count === n ? 'on' : ''} disabled={ro} onClick={() => c.patch({ count: n })}>
            {n}
          </button>
        ))}
      </div>
      <span className="spacer" />
      <button className="btn primary" disabled={ro || c.busy || !c.prompt.trim() || !c.hasKey} onClick={c.generate}>
        <Icon name="sparkle" size={14} /> {c.busy ? 'Sending…' : `Generate ${th.count}${costLabel(c.pricing, 'thumbnail', c.model, th.count)}`}
      </button>
    </div>
  )
}

/** "Use my direction" and automatic scoring. */
export function ThumbToggles({ c }: { c: Thumbs }) {
  const score = costLabel(c.pricing, 'score')
  return (
    <>
      <Toggle
        checked={c.th.useMyDirection}
        disabled={c.ro}
        onChange={(v) => c.patch({ useMyDirection: v, direction: c.prompt })}
        label="Use my direction: Claude follows this text when it writes thumbnail prompts"
      />
      <Toggle
        checked={c.autoScore}
        onChange={(v) => {
          const pikzels = app.get().settings?.pikzels
          if (pikzels) void updateSettings({ pikzels: { ...pikzels, autoScore: v } })
        }}
        label={`Score every new thumbnail automatically${score ? ` (${score.replace(/^\s*·\s*/, '')} each)` : ''}`}
      />
    </>
  )
}

/** Recreate, Edit, Face swap and Titles. */
export function MoreTools({ c, title = 'More tools' }: { c: Thumbs; title?: string }) {
  const { tool } = c
  const props = {
    pricing: c.pricing,
    model: c.model,
    dir: c.dir,
    target: c.target,
    thumbs: c.th.items,
    setTarget: c.setTargetId,
    disabled: c.ro || !c.hasKey,
    onDone: c.reloadPricing,
    initialFile: c.target ? null : c.toolFile
  }
  // A new starting picture starts the tool afresh.
  const key = `${tool}:${props.initialFile ?? ''}`
  const box = useRef<HTMLDivElement>(null)
  // Opened from a card or the base picture: bring the tool into view.
  useEffect(() => {
    if (tool && (c.target || c.toolFile)) box.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [tool, c.target?.id, c.toolFile]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="col thumbs-tools" style={{ gap: 6 }} ref={box}>
      <div className="row">
        <h4 className="grow">{title}</h4>
        <div className="seg">
          {(Object.keys(TOOL_LABELS) as ToolName[]).map((k) => (
            <button key={k} className={tool === k ? 'on' : ''} onClick={() => c.setTool(tool === k ? null : k)}>
              {TOOL_LABELS[k]}
            </button>
          ))}
        </div>
      </div>
      {tool === 'recreate' && <RecreateTool key={key} {...props} />}
      {tool === 'edit' && <EditTool key={key} {...props} />}
      {tool === 'faceswap' && <FaceSwapTool key={key} {...props} />}
      {tool === 'titles' && <TitlesTool {...props} chosenId={c.th.chosenId} />}
    </div>
  )
}

/** The latest batch of options. `large`: big cards with labelled buttons, up to three side by side. */
export function OptionsGrid({ c, large }: { c: Thumbs; large?: boolean }) {
  const { latest, th } = c
  if (!latest)
    return (
      <Empty title="No thumbnails yet">
        <div className="small">Claude makes them when the edit is ready. You can also type a prompt and press Generate at any time, also while the video is still being edited.</div>
      </Empty>
    )
  return (
    <div className={`thumb-grid${large ? ' large' : ''}`}>
      {latest.items.map((t) => (
        <ThumbCard
          key={t.id}
          t={t}
          large={large}
          chosen={th.chosenId === t.id}
          dir={c.dir}
          ro={c.ro}
          pricing={c.pricing}
          title={c.snap.doc.project.publish.titles[0]}
          onTool={(name, id) => c.openTool(name, { id })}
          onScored={c.reloadPricing}
        />
      ))}
    </div>
  )
}

/** Every thumbnail made for this project, newest first, with its prompt. */
export function ThumbHistory({ c }: { c: Thumbs }) {
  const { th, ro } = c
  return (
    <div className="col" style={{ gap: 0 }}>
      {th.items
        .slice()
        .reverse()
        .map((t) => (
          <div key={t.id} className="history-row">
            {t.file && t.status === 'done' ? <img src={mediaUrl(t.file, c.dir)} alt="" /> : <div className="ph" />}
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
              <div className="small selectable" style={{ wordBreak: 'break-word' }}>
                {t.prompt}
              </div>
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
  )
}

export function ThumbCosts({ c }: { c: Thumbs }) {
  return <CostPerAction pricing={c.pricing} projectSpend={c.th.spend} only={['thumbnail', 'recreate', 'edit', 'faceswap', 'score', 'title']} />
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
  large?: boolean
  dir: string
  ro: boolean
  pricing: PikzelsPricing | null
  title?: string
  onTool: (tool: ToolName, id: string) => void
  onScored: () => void
}) {
  const { t, chosen, dir, ro, pricing, large } = props
  const [scoring, setScoring] = useState(false)
  const score = async () => {
    setScoring(true)
    await call(() => window.api.thumbnails.score(t.id, props.title), 'Could not score the thumbnail')
    setScoring(false)
    props.onScored()
  }
  const label = (text: string) => (large ? <span>{text}</span> : null)
  return (
    <div className={`thumb${chosen ? ' chosen' : ''}`}>
      <div className="img" title={t.prompt}>
        {t.status === 'done' && t.file ? (
          <img src={mediaUrl(t.file, dir)} alt="" />
        ) : t.status === 'pending' ? (
          <span className="col" style={{ alignItems: 'center', gap: 6 }}>
            <span className="spinner" />
            {large && <span className="small faint">Generating…</span>}
          </span>
        ) : (
          <span className="small bad" style={{ padding: 6, textAlign: 'center' }}>
            {t.error ?? 'Failed'}
          </span>
        )}
        {chosen && (
          <span className="chip accent" style={{ position: 'absolute', top: 4, left: 4 }}>
            Chosen
          </span>
        )}
        {large && t.score && (
          <span className="thumb-score" title={t.score.title ? `Scored against "${t.score.title}"` : 'Pikzels score'}>
            {t.score.main}
          </span>
        )}
      </div>
      <div className="actions">
        {t.status === 'done' && !chosen && (
          <button className="btn small primary" disabled={ro} onClick={() => void call(() => window.api.thumbnails.choose(t.id))}>
            {large && <Icon name="check" size={13} />} Pick
          </button>
        )}
        <button className="btn small" disabled={ro || t.status === 'pending'} onClick={() => void call(() => window.api.thumbnails.regenerate(t.id), 'Could not regenerate')} title="Make a new image from the same prompt. The old one stays in History.">
          <Icon name="refresh" size={13} />
          {label('Again')}
        </button>
        {t.status === 'done' && (
          <>
            {!large && (
              <button className="btn small" disabled={ro || scoring} onClick={score} title={props.title ? `Score against the title "${props.title}"` : 'Score the thumbnail'}>
                {scoring ? '…' : `Score${costLabel(pricing, 'score')}`}
              </button>
            )}
            <button className="btn small" disabled={ro} title="Edit, recreate or face swap this one" onClick={() => props.onTool('edit', t.id)}>
              <Icon name="wand" size={13} />
              {label('Edit')}
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
      {large && !t.score && t.status === 'done' && (
        <div className="row tiny faint" style={{ padding: '0 8px 8px' }}>
          <span className="grow">Not scored yet</span>
          {!ro && <a onClick={scoring ? undefined : score}>{scoring ? 'Scoring…' : `Score${costLabel(pricing, 'score')}`}</a>}
        </div>
      )}
      {t.score && (
        <div className="col tiny" style={{ gap: 2, padding: large ? '0 8px 8px' : '4px 6px 6px' }} title={t.score.title ? `Scored against "${t.score.title}"` : undefined}>
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
