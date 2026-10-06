/**
 * Personas & Styles: Pikzels personas (your face) and styles (a thumbnail look) made through the API.
 * Training runs at Pikzels; this screen shows progress and marks each ready when it completes.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Pikzonality } from '@shared/settings'
import { call, openSettings, toast } from '../state/app'
import { AppTopBar } from '../components/AppTopBar'
import { Empty, Spinner } from '../components/bits'
import { Icon } from '../components/Icon'
import { IMAGE_EXTS, dateTime, mediaUrl } from '../util'
import { CostPerAction, costLabel, usePikzelsPricing } from '../panels/ThumbnailsPanelCosts'
import type { PikzelsPricing, YouTubeThumbnailList } from '@shared/ipc'

export function PersonasScreen() {
  const [list, setList] = useState<Pikzonality[] | null>(null)
  const [hasKey, setHasKey] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [pricing, reloadPricing] = usePikzelsPricing()

  const refresh = useCallback(async (remote: boolean) => {
    setRefreshing(true)
    const l = await call(() => (remote ? window.api.pikzels.refresh() : window.api.pikzels.list()))
    setRefreshing(false)
    if (l) setList(l)
  }, [])

  useEffect(() => {
    void call(() => window.api.settings.hasPikzelsKey()).then((k) => setHasKey(!!k))
    void refresh(false).then(() => refresh(true))
  }, [refresh])

  // While anything is training, ask Pikzels for progress every 20 seconds.
  const training = list?.some((p) => p.status === 'processing')
  useEffect(() => {
    if (!training) return
    const t = setInterval(() => void refresh(true), 20000)
    return () => clearInterval(t)
  }, [training, refresh])

  const personas = list?.filter((p) => p.kind === 'persona') ?? []
  const styles = list?.filter((p) => p.kind === 'style') ?? []

  return (
    <>
      <AppTopBar />
      <div className="screen">
        <div className="page col" style={{ gap: 18 }}>
          <div className="home-head" style={{ marginBottom: 0 }}>
            <h1 className="grow">Personas & Styles</h1>
            <button className="btn" onClick={() => void refresh(true)} disabled={refreshing}>
              <Icon name="refresh" size={14} /> {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          {!hasKey && (
            <div className="banner" style={{ borderRadius: 6 }}>
              Add your Pikzels API key in Settings to create personas and styles.
              <button className="btn small" onClick={() => openSettings('general')}>
                Open Settings
              </button>
            </div>
          )}
          <p className="muted" style={{ margin: 0 }}>
            Only personas and styles created here can be used for thumbnails. Ones made on the Pikzels website need to be created again
            here.
          </p>
          <CreateForm
            disabled={!hasKey}
            pricing={pricing}
            onCreated={(p) => {
              setList((l) => [p, ...(l ?? [])])
              reloadPricing()
            }}
          />
          {list === null ? (
            <Spinner label="Loading…" />
          ) : (
            <>
              <Group title="Personas" items={personas} onChange={setList} empty="No personas yet. A persona is your face, made from three photos." />
              <Group title="Styles" items={styles} onChange={setList} empty="No styles yet. A style is a thumbnail look, made from three reference thumbnails." />
            </>
          )}
          <CostPerAction pricing={pricing} only={['persona_training', 'style_training']} />
        </div>
      </div>
    </>
  )
}

function CreateForm({ disabled, onCreated, pricing }: { disabled: boolean; onCreated: (p: Pikzonality) => void; pricing: PikzelsPricing | null }) {
  const [kind, setKind] = useState<'persona' | 'style'>('persona')
  const [name, setName] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState('')
  const [loading, setLoading] = useState(false)
  const [found, setFound] = useState<YouTubeThumbnailList | null>(null)

  const loadFromYouTube = async () => {
    setLoading(true)
    const list = await call(() => window.api.pikzels.thumbnailsFromLink(link.trim()), 'Could not load thumbnails from YouTube')
    setLoading(false)
    if (list) setFound(list)
  }

  // Clicking a thumbnail selects it; a fourth click replaces the oldest pick.
  const toggle = (file: string) =>
    setImages((cur) => (cur.includes(file) ? cur.filter((f) => f !== file) : [...cur, file].slice(-3)))

  const pick = async () => {
    const files = await call(() =>
      window.api.app.pickFiles({
        title: kind === 'persona' ? 'Choose three photos of your face' : 'Choose three reference thumbnails',
        filters: [{ name: 'Images', extensions: IMAGE_EXTS }],
        multi: true
      })
    )
    if (files?.length) setImages((cur) => [...cur, ...files].slice(-3))
  }

  const create = async () => {
    setBusy(true)
    const p = await call(() => window.api.pikzels.create(kind, name.trim(), images), `Could not create the ${kind}`)
    setBusy(false)
    if (p) {
      onCreated(p)
      toast(`${name.trim()} is training at Pikzels. It is marked ready when done.`)
      setName('')
      setImages([])
      setFound(null)
    }
  }

  return (
    <div className="card pad col">
      <div className="row">
        <h3 className="grow">Create</h3>
        <div className="seg">
          <button className={kind === 'persona' ? 'on' : ''} onClick={() => setKind('persona')}>
            Persona
          </button>
          <button className={kind === 'style' ? 'on' : ''} onClick={() => setKind('style')}>
            Style
          </button>
        </div>
      </div>
      <div className="row">
        <input type="text" className="grow" maxLength={25} placeholder={kind === 'persona' ? 'Name, e.g. Adam' : 'Name, e.g. Bold RC'} value={name} onChange={(e) => setName(e.target.value)} />
        <span className={`small mono ${name.length >= 25 ? 'warn' : 'faint'}`}>{name.length}/25</span>
      </div>
      <div className="photo-pick" style={{ maxWidth: 420 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} onClick={pick} style={{ cursor: 'pointer' }} title="Choose images">
            {images[i] ? <img src={mediaUrl(images[i])} alt="" /> : kind === 'persona' ? `Face photo ${i + 1}` : `Thumbnail ${i + 1}`}
          </div>
        ))}
      </div>
      <div className="row">
        <button className="btn" onClick={pick}>
          Choose images
        </button>
        {images.length > 0 && (
          <button className="btn ghost" onClick={() => setImages([])}>
            Clear
          </button>
        )}
        <span className="spacer" />
        <button className="btn primary" disabled={disabled || busy || !name.trim() || images.length !== 3} onClick={create}>
          {busy ? 'Uploading…' : `Train ${kind}${costLabel(pricing, kind === 'persona' ? 'persona_training' : 'style_training')}`}
        </button>
      </div>
      <span className="hint">
        {kind === 'persona' ? 'Three clear, well-lit photos of the same face work best.' : 'Three thumbnails in the look you want.'} Names can be up to 25
        characters.
      </span>
      <div className="col" style={{ gap: 8, marginTop: 6 }}>
        <h3>Or pick from YouTube</h3>
        <div className="row">
          <input
            type="text"
            className="grow"
            placeholder="Paste a channel, video or playlist link, e.g. youtube.com/@yourchannel"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && link.trim() && !loading) void loadFromYouTube()
            }}
          />
          <button className="btn" disabled={!link.trim() || loading} onClick={loadFromYouTube}>
            {loading ? 'Loading…' : 'Show thumbnails'}
          </button>
        </div>
        <span className="hint">
          {kind === 'persona'
            ? 'Pick three thumbnails where your face is clear. Several links can be pasted at once.'
            : 'Pick three thumbnails in the look you want. Several links can be pasted at once.'}
        </span>
        {found && (
          <>
            <div className="row small muted">
              <span className="grow">
                {found.items.length} thumbnails from {found.source}. {images.length} of 3 picked.
              </span>
              <button className="btn ghost small" onClick={() => setFound(null)}>
                Hide
              </button>
            </div>
            <div className="yt-grid">
              {found.items.map((t) => {
                const n = images.indexOf(t.file)
                return (
                  <button key={t.videoId} className={`yt-thumb${n >= 0 ? ' on' : ''}`} onClick={() => toggle(t.file)} title={t.title || t.videoId}>
                    <img src={mediaUrl(t.file)} alt="" loading="lazy" />
                    {n >= 0 && <span className="yt-pick">{n + 1}</span>}
                    {t.title && <span className="yt-title">{t.title}</span>}
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Group(props: { title: string; items: Pikzonality[]; empty: string; onChange: (fn: (l: Pikzonality[] | null) => Pikzonality[] | null) => void }) {
  return (
    <div className="col">
      <h2>{props.title}</h2>
      {props.items.length === 0 ? (
        <div className="muted small">{props.empty}</div>
      ) : (
        <div className="asset-grid">
          {props.items.map((p) => (
            <PikzCard key={p.id} p={p} onChange={props.onChange} />
          ))}
        </div>
      )}
    </div>
  )
}

function PikzCard({ p, onChange }: { p: Pikzonality; onChange: (fn: (l: Pikzonality[] | null) => Pikzonality[] | null) => void }) {
  const [text, setText] = useState(p.specialInstructions)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(p.name)
  const rename = async () => {
    const clean = name.trim()
    if (!clean || clean === p.name) return setRenaming(false)
    const u = await call(() => window.api.pikzels.rename(p.id, clean), 'Could not rename')
    if (u) {
      onChange((l) => l?.map((x) => (x.id === p.id ? u : x)) ?? null)
      toast(`Renamed to ${u.name}.`)
      setRenaming(false)
    }
  }
  const saved = useRef(p.specialInstructions)
  useEffect(() => {
    setText(p.specialInstructions)
    saved.current = p.specialInstructions
  }, [p.specialInstructions])
  const save = async () => {
    if (text === saved.current) return
    const u = await call(() => window.api.pikzels.updateInstructions(p.id, text), 'Could not save the instructions')
    if (u) {
      saved.current = u.specialInstructions
      onChange((l) => l?.map((x) => (x.id === p.id ? u : x)) ?? null)
      toast('Special instructions saved.')
    }
  }
  return (
    <div className="card asset">
      <div className="pv">{p.sampleImage ? <img src={mediaUrl(p.sampleImage)} alt="" style={{ objectFit: 'cover' }} /> : <Icon name="image" size={28} />}</div>
      <div className="info">
        <div className="row">
          {renaming ? (
            <>
              <input
                type="text"
                className="grow"
                autoFocus
                maxLength={25}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void rename()
                  if (e.key === 'Escape') setRenaming(false)
                }}
              />
              <button className="btn small primary" onClick={() => void rename()}>
                Save
              </button>
            </>
          ) : (
            <b
              className="grow ellipsis"
              title="Click to rename"
              style={{ cursor: 'text' }}
              onClick={() => {
                setName(p.name)
                setRenaming(true)
              }}
            >
              {p.name}
            </b>
          )}
          {p.status === 'completed' && <span className="chip ok">Ready</span>}
          {p.status === 'processing' && <span className="chip warn">Training</span>}
          {p.status === 'failed' && <span className="chip bad">Failed</span>}
        </div>
        {p.status === 'processing' && (
          <div className="col" style={{ gap: 3 }}>
            <div className="progress">
              <div style={{ width: `${Math.max(3, Math.min(100, p.progress))}%` }} />
            </div>
            <span className="tiny faint">{Math.round(p.progress)}% · training at Pikzels</span>
          </div>
        )}
        {p.error && <div className="small bad">{p.error}</div>}
        <div className="tiny faint">Made {dateTime(p.createdAt)}</div>
        <textarea
          rows={2}
          placeholder="Special instructions, e.g. always wearing a cap"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
        />
        <div className="row">
          <span className="spacer" />
          <button
            className="btn small ghost danger"
            onClick={async () => {
              await call(() => window.api.pikzels.remove(p.id))
              onChange((l) => l?.filter((x) => x.id !== p.id) ?? null)
              toast(`Deleted ${p.name}.`)
            }}
          >
            <Icon name="trash" size={14} /> Delete
          </button>
        </div>
      </div>
    </div>
  )
}
