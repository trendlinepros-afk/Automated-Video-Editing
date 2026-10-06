/** The asset library: every saved graphic, sound and clip, with preview, tags and use count. */
import { useCallback, useEffect, useState } from 'react'
import type { LibraryAsset } from '@shared/ipc'
import { app, call, openSettings, profileById, toast } from '../state/app'
import { editor } from '../state/editor'
import { useStore } from '../state/store'
import { AppTopBar } from '../components/AppTopBar'
import { Empty, Spinner } from '../components/bits'
import { Icon } from '../components/Icon'
import { fmt, joinPath, mediaUrl, relativeTime } from '../util'

const TYPES: LibraryAsset['type'][] = ['graphic', 'sound', 'effect', 'music', 'clip']
const TYPE_LABELS: Record<string, string> = { graphic: 'Graphic', sound: 'Sound', effect: 'Effect', music: 'Music', clip: 'Clip' }

export function LibraryScreen() {
  const profiles = useStore(app, (s) => s.profiles)
  const libraryFolder = useStore(app, (s) => s.settings?.libraryFolder ?? '')
  const projectOpen = useStore(editor, (s) => !!s.snapshot && !s.snapshot.readOnly)
  const [scope, setScope] = useState('')
  const [type, setType] = useState('')
  const [query, setQuery] = useState('')
  const [assets, setAssets] = useState<LibraryAsset[] | null>(null)

  const load = useCallback(async () => {
    const list = await call(() => window.api.library.list({ scope: scope || undefined, type: type || undefined, query: query.trim() || undefined }))
    setAssets(list ?? [])
  }, [scope, type, query])

  useEffect(() => {
    const t = setTimeout(() => void load(), query ? 250 : 0)
    return () => clearTimeout(t)
  }, [load, query])

  const patch = async (a: LibraryAsset, p: Partial<LibraryAsset>) => {
    const updated = await call(() => window.api.library.update(a.id, p), 'Could not change the asset')
    if (updated) setAssets((list) => list?.map((x) => (x.id === a.id ? { ...updated, dir: updated.dir ?? a.dir } : x)) ?? null)
  }

  if (!libraryFolder) {
    return (
      <>
        <AppTopBar />
        <div className="screen">
          <Empty title="Choose a library folder first" icon="folder">
            <p>Graphics, animations and sounds are saved there and reused on later videos.</p>
            <button className="btn primary" onClick={() => openSettings('general')}>
              Open Settings
            </button>
          </Empty>
        </div>
      </>
    )
  }

  return (
    <>
      <AppTopBar />
      <div className="screen">
        <div className="page">
          <div className="home-head">
            <h1 className="grow">Asset library</h1>
            <input type="search" placeholder="Search names, tags, descriptions" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 240 }} />
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">Shared and all channels</option>
              <option value="shared">Shared</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">All types</option>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            <button className="btn ghost" title="Open the library folder" onClick={() => void window.api.app.openPath(libraryFolder)}>
              <Icon name="folder" size={14} />
            </button>
          </div>
          {assets === null ? (
            <Spinner label="Loading…" />
          ) : assets.length === 0 ? (
            <Empty title={query || type || scope ? 'Nothing matches' : 'The library is empty'} icon="sparkle">
              <p>
                {query || type || scope
                  ? 'Try another search or filter.'
                  : 'Right-click a graphic or sound on the timeline and choose Save to library. Claude also saves reusable pieces here as it works.'}
              </p>
            </Empty>
          ) : (
            <div className="asset-grid">
              {assets.map((a) => (
                <AssetCard
                  key={a.id}
                  asset={a}
                  projectOpen={projectOpen}
                  onPatch={(p) => void patch(a, p)}
                  onDuplicate={async () => {
                    const copy = await call(() => window.api.library.duplicate(a.id))
                    if (copy) {
                      toast(`Made a copy: ${copy.name}`)
                      void load()
                    }
                  }}
                  onDelete={async () => {
                    await call(() => window.api.library.remove(a.id))
                    toast(`Deleted "${a.name}" from the library. Projects that used it keep their own copy.`)
                    void load()
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function AssetCard(props: {
  asset: LibraryAsset
  projectOpen: boolean
  onPatch: (p: Partial<LibraryAsset>) => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const { asset: a } = props
  const profiles = useStore(app, (s) => s.profiles)
  const [name, setName] = useState(a.name)
  const [tags, setTags] = useState(a.tags.join(', '))
  useEffect(() => setName(a.name), [a.name])
  useEffect(() => setTags(a.tags.join(', ')), [a.tags])
  const preview = a.preview && a.dir ? mediaUrl(joinPath(a.dir, a.preview)) : undefined
  const audio = (a.type === 'sound' || a.type === 'music') && a.dir ? mediaUrl(joinPath(a.dir, a.file)) : undefined
  const owner = a.scope === 'shared' ? 'Shared' : profileById(a.scope)?.name ?? 'Unknown channel'

  const commitTags = () => {
    const list = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    if (list.join(',') !== a.tags.join(',')) props.onPatch({ tags: list })
  }

  return (
    <div className="card asset">
      <div className="pv">{preview ? <img src={preview} alt="" /> : <Icon name={a.type === 'sound' || a.type === 'music' ? 'note' : 'image'} size={28} />}</div>
      <div className="info">
        <div className="row">
          <input
            type="text"
            className="grow"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== a.name && props.onPatch({ name: name.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            title="Rename"
          />
          <button
            className={`star${a.preferred ? ' on' : ''}`}
            title={a.preferred ? 'Preferred: Claude uses this first for this purpose' : 'Mark as preferred'}
            onClick={() => props.onPatch({ preferred: !a.preferred })}
          >
            ★
          </button>
        </div>
        <div className="row wrap small muted">
          <span className="tag">{TYPE_LABELS[a.type] ?? a.type}</span>
          <span>Used {a.uses} {a.uses === 1 ? 'time' : 'times'}</span>
          <span className="faint">· {relativeTime(a.updatedAt)}</span>
        </div>
        {a.description && <div className="small">{a.description}</div>}
        {a.whenToUse && <div className="small muted">When to use: {a.whenToUse}</div>}
        {Object.keys(a.inputs ?? {}).length > 0 && (
          <div className="small faint">Inputs: {Object.keys(a.inputs).join(', ')}</div>
        )}
        {audio && <audio controls src={audio} style={{ width: '100%', height: 30 }} preload="none" />}
        <input
          type="text"
          value={tags}
          placeholder="Tags, separated by commas"
          onChange={(e) => setTags(e.target.value)}
          onBlur={commitTags}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          title="Tags"
        />
        <div className="row">
          <select value={a.scope} onChange={(e) => props.onPatch({ scope: e.target.value })} className="grow" title="Who can use it">
            <option value="shared">Shared (every channel)</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} only
              </option>
            ))}
            {a.scope !== 'shared' && !profiles.some((p) => p.id === a.scope) && <option value={a.scope}>{owner}</option>}
          </select>
        </div>
        <div className="row wrap">
          {props.projectOpen && (
            <button
              className="btn small"
              title="Copies it into the open project at the playhead"
              onClick={async () => {
                await call(() => window.api.library.placeInProject(a.id, editor.get().playhead))
                toast(`Placed "${a.name}" at ${fmt(editor.get().playhead)}.`)
              }}
            >
              Add to project
            </button>
          )}
          <button className="btn small" onClick={props.onDuplicate}>
            Duplicate
          </button>
          {a.dir && (
            <button className="btn small ghost" onClick={() => void window.api.app.openPath(a.dir!)} title="Open its folder">
              <Icon name="folder" size={14} />
            </button>
          )}
          <span className="spacer" />
          <button className="btn small ghost danger" onClick={props.onDelete} title="Delete from the library">
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
