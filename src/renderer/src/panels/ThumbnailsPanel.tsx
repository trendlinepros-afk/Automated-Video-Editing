/**
 * Thumbnails: persona and style for this project, your own prompt (works without Claude), count,
 * "Use my direction", the options side by side, and the full history with prompts.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Thumbnail } from '@shared/project'
import type { Pikzonality } from '@shared/settings'
import { call, go, openSettings, toast } from '../state/app'
import { applyOp, editor } from '../state/editor'
import { useStore } from '../state/store'
import { Empty, Toggle } from '../components/bits'
import { Icon } from '../components/Icon'
import { errorMessage, mediaUrl, relativeTime } from '../util'

const MAX_PROMPT = 750

export function ThumbnailsPanel() {
  const snap = useStore(editor, (s) => s.snapshot!)
  const th = snap.doc.project.thumbnails
  const ro = snap.readOnly
  const [pikz, setPikz] = useState<Pikzonality[]>([])
  const [hasKey, setHasKey] = useState(true)
  const [prompt, setPrompt] = useState(th.direction)
  const [busy, setBusy] = useState(false)
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

  const generate = async () => {
    setBusy(true)
    try {
      await window.api.thumbnails.generate({ prompt: prompt.trim(), count: th.count, referenceTime: undefined })
      toast(`Generating ${th.count} ${th.count === 1 ? 'option' : 'options'} at Pikzels. They download into the project as they finish.`)
    } catch (e) {
      toast(errorMessage(e), { kind: 'error' })
    }
    setBusy(false)
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
          <span className="label" style={{ width: 60 }}>Persona</span>
          <PikzSelect value={th.personaId} options={personas} disabled={ro} onChange={(v) => patch({ personaId: v })} />
        </div>
        <div className="row">
          <span className="label" style={{ width: 60 }}>Style</span>
          <PikzSelect value={th.styleId} options={styles} disabled={ro} onChange={(v) => patch({ styleId: v })} />
        </div>
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
            <Icon name="sparkle" size={14} /> {busy ? 'Sending…' : 'Generate'}
          </button>
        </div>
        <Toggle
          checked={th.useMyDirection}
          disabled={ro}
          onChange={(v) => patch({ useMyDirection: v, direction: prompt })}
          label="Use my direction: Claude follows this text when it writes thumbnail prompts"
        />
      </div>

      {latest ? (
        <div className="col" style={{ gap: 6 }}>
          <h4>Options</h4>
          <div className="thumb-grid">
            {latest.items.map((t) => (
              <ThumbCard key={t.id} t={t} chosen={th.chosenId === t.id} dir={snap.path} ro={ro} />
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
                    {t.requestId && <span title="Pikzels request ID">· {t.requestId.slice(0, 8)}</span>}
                  </div>
                  <div className="small selectable" style={{ wordBreak: 'break-word' }}>{t.prompt}</div>
                  {t.error && <div className="small bad">{t.error}</div>}
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

function ThumbCard({ t, chosen, dir, ro }: { t: Thumbnail; chosen: boolean; dir: string; ro: boolean }) {
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
