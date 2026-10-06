/** Home: recent projects, New project, Open project from disk, search and a profile filter. */
import { useEffect, useMemo, useState } from 'react'
import type { RecentProject } from '@shared/ipc'
import { STATUS_LABELS, type ProjectStatus } from '@shared/project'
import { app, call, enterEditor, openSettings, profileById, refreshProfiles, toast } from '../state/app'
import { useStore } from '../state/store'
import { AppTopBar } from '../components/AppTopBar'
import { Empty, ProfileChip, Spinner } from '../components/bits'
import { Icon } from '../components/Icon'
import { Modal } from '../components/Modal'
import { basename, mediaUrl, relativeTime } from '../util'

export function HomeScreen() {
  const profiles = useStore(app, (s) => s.profiles)
  const [recent, setRecent] = useState<RecentProject[] | null>(null)
  const [query, setQuery] = useState('')
  const [profileFilter, setProfileFilter] = useState('')
  const [creating, setCreating] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)

  useEffect(() => {
    void call(() => window.api.projects.recent()).then((r) => setRecent(r ?? []))
  }, [])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (recent ?? []).filter(
      (p) => (!profileFilter || p.profileId === profileFilter) && (!q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
    )
  }, [recent, query, profileFilter])

  const open = async (path: string) => {
    setOpening(path)
    const snap = await call(() => window.api.projects.open(path), 'Could not open the project')
    setOpening(null)
    if (snap) enterEditor(snap)
  }

  const openFromDisk = async () => {
    const dir = await call(() => window.api.app.pickFolder('Open a project folder (the one with project.json)'))
    if (dir) await open(dir)
  }

  const locate = async (p: RecentProject) => {
    const dir = await call(() => window.api.app.pickFolder(`Where is "${p.name}" now?`))
    if (!dir) return
    const list = await call(() => window.api.projects.locate(p.id, dir), 'That folder does not hold this project')
    if (list) setRecent(list)
  }

  const remove = async (p: RecentProject) => {
    const list = await call(() => window.api.projects.removeRecent(p.id))
    if (list) {
      setRecent(list)
      toast(`Removed "${p.name}" from the list. The folder was not touched.`)
    }
  }

  const showFilters = (recent?.length ?? 0) > 4

  return (
    <>
      <AppTopBar />
      <div className="screen">
        <div className="page">
          <div className="home-head">
            <h1 className="grow">Projects</h1>
            {showFilters && (
              <>
                <input type="search" placeholder="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 220 }} />
                <select value={profileFilter} onChange={(e) => setProfileFilter(e.target.value)}>
                  <option value="">All channels</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </>
            )}
            <button className="btn" onClick={openFromDisk}>
              <Icon name="folder" size={14} /> Open project from disk
            </button>
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Icon name="plus" size={14} /> New project
            </button>
          </div>

          {recent === null ? (
            <Spinner label="Loading projects…" />
          ) : recent.length === 0 ? (
            <Empty title="No projects yet" icon="folder">
              <p>
                Press <b>New project</b>, pick the channel profile and your footage folder. Claude takes it from there.
              </p>
              <button className="btn primary" onClick={() => setCreating(true)}>
                New project
              </button>
            </Empty>
          ) : shown.length === 0 ? (
            <Empty title="Nothing matches">
              <p>Try a different search or channel.</p>
            </Empty>
          ) : (
            <div className="proj-grid">
              {shown.map((p) => {
                const profile = profileById(p.profileId)
                return (
                  <div
                    key={p.id}
                    className={`card proj-card${p.found ? '' : ' missing'}`}
                    onClick={() => p.found && opening === null && void open(p.path)}
                    title={p.path}
                  >
                    <div className="frame">
                      {p.thumbnail && p.found ? <img src={mediaUrl(p.thumbnail)} alt="" /> : <Icon name="image" size={28} />}
                    </div>
                    <div className="meta">
                      <div className="row">
                        <b className="grow ellipsis">{p.name}</b>
                        {opening === p.path && <span className="spinner" />}
                      </div>
                      <div className="row wrap">
                        <ProfileChip name={profile?.name} color={profile?.color} />
                        {p.found ? (
                          <span className={`chip${p.status === 'ready_for_review' ? ' accent' : p.status === 'exported' ? ' ok' : ''}`}>
                            {STATUS_LABELS[p.status as ProjectStatus] ?? p.status}
                          </span>
                        ) : (
                          <span className="chip bad">Not found</span>
                        )}
                      </div>
                      <div className="small faint">Opened {relativeTime(p.lastOpened)}</div>
                      {!p.found && (
                        <div className="row" onClick={(e) => e.stopPropagation()}>
                          <button className="btn small" onClick={() => void locate(p)}>
                            Locate
                          </button>
                          <button className="btn small ghost" onClick={() => void remove(p)}>
                            Remove from list
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </>
  )
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const profiles = useStore(app, (s) => s.profiles)
  const settings = useStore(app, (s) => s.settings)
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? '')
  const [newProfile, setNewProfile] = useState('')
  const [footage, setFootage] = useState('')
  const [name, setName] = useState('')
  const [parent, setParent] = useState(settings?.defaultProjectsFolder ?? '')
  const [busy, setBusy] = useState(false)

  const pickFootage = async () => {
    const dir = await call(() => window.api.app.pickFolder('Choose the footage folder'))
    if (dir) {
      setFootage(dir)
      if (!name) setName(basename(dir))
    }
  }

  const pickParent = async () => {
    const dir = await call(() => window.api.app.pickFolder('Where should the project folder go?', parent || undefined))
    if (dir) setParent(dir)
  }

  const addProfile = async () => {
    if (!newProfile.trim()) return
    const p = await call(() => window.api.profiles.create(newProfile.trim()))
    if (p) {
      await refreshProfiles()
      setProfileId(p.id)
      setNewProfile('')
    }
  }

  const create = async () => {
    setBusy(true)
    const snap = await call(
      () => window.api.projects.create({ name: name.trim(), profileId, footageFolder: footage, parentFolder: parent || undefined }),
      'Could not create the project'
    )
    setBusy(false)
    if (snap) {
      onClose()
      enterEditor(snap)
    }
  }

  return (
    <Modal
      title="New project"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!profileId || !footage || !name.trim() || busy} onClick={create}>
            {busy ? 'Creating…' : 'Create and open'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Channel profile</label>
        {profiles.length ? (
          <div className="row">
            <select className="grow" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button className="btn ghost small" onClick={() => openSettings('profiles', profileId)}>
              Edit profiles
            </button>
          </div>
        ) : (
          <div className="hint">No profiles yet. Make one for this channel:</div>
        )}
        <div className="row">
          <input type="text" className="grow" placeholder="New profile name, e.g. RC cars" value={newProfile} onChange={(e) => setNewProfile(e.target.value)} />
          <button className="btn" disabled={!newProfile.trim()} onClick={addProfile}>
            Add profile
          </button>
        </div>
      </div>
      <div className="field">
        <label>Footage folder</label>
        <div className="row">
          <code className="grow ellipsis">{footage || 'Not chosen'}</code>
          <button className="btn" onClick={pickFootage}>
            Choose folder
          </button>
        </div>
        <span className="hint">Your footage stays where it is. The project only points to it.</span>
      </div>
      <div className="field">
        <label>Project name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. LiPo battery test" />
      </div>
      <div className="field">
        <label>Save the project in</label>
        <div className="row">
          <code className="grow ellipsis">{parent || 'The default projects folder'}</code>
          <button className="btn ghost" onClick={pickParent}>
            Change
          </button>
        </div>
      </div>
    </Modal>
  )
}
