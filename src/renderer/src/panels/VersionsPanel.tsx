/** Versions: save the whole edit under a name, restore, delete, and compare two versions at the same moment. */
import { useCallback, useEffect, useState } from 'react'
import type { VersionInfo } from '@shared/ipc'
import { call, toast } from '../state/app'
import { editor, openDialog } from '../state/editor'
import { useStore } from '../state/store'
import { Empty } from '../components/bits'
import { Icon } from '../components/Icon'
import { dateTime } from '../util'

export function VersionsPanel() {
  const snapshot = useStore(editor, (s) => s.snapshot!)
  const [list, setList] = useState<VersionInfo[] | null>(null)
  const [name, setName] = useState('')
  const [pick, setPick] = useState<string[]>([])
  const ro = snapshot.readOnly

  const load = useCallback(async () => {
    const l = await call(() => window.api.project.versions.list())
    if (l) setList(l.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
  }, [])

  // Versions are also saved automatically (edit ready, before re-edits and exports), so refresh on changes.
  useEffect(() => {
    void load()
  }, [load, snapshot.doc.project.updatedAt])

  const save = async () => {
    const v = await call(() => window.api.project.versions.save(name.trim()), 'Could not save the version')
    if (v) {
      setName('')
      toast(`Saved version "${v.name}".`)
      void load()
    }
  }

  const restore = async (v: VersionInfo) => {
    const snap = await call(() => window.api.project.versions.restore(v.id), 'Could not restore')
    if (snap) {
      editor.set({ snapshot: snap })
      toast(`Restored "${v.name}". What you had before was saved as its own version, so this can be reversed.`)
      void load()
    }
  }

  const togglePick = (id: string) => setPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]))

  const named = list?.filter((v) => !v.auto) ?? []
  const auto = list?.filter((v) => v.auto) ?? []

  const row = (v: VersionInfo) => (
    <div key={v.id} className="list-row">
      <input type="checkbox" checked={pick.includes(v.id)} onChange={() => togglePick(v.id)} title="Pick two to compare" />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ellipsis">{v.name}</div>
        <div className="tiny faint">
          {dateTime(v.createdAt)}
          {v.reason ? ` · ${v.reason}` : ''}
        </div>
      </div>
      <button className="btn small" disabled={ro} onClick={() => void restore(v)}>
        Restore
      </button>
      <button
        className="btn ghost small icon danger"
        title="Delete"
        onClick={async () => {
          await call(() => window.api.project.versions.remove(v.id))
          setPick((p) => p.filter((x) => x !== v.id))
          void load()
        }}
      >
        <Icon name="trash" size={13} />
      </button>
    </div>
  )

  return (
    <div className="panel">
      <div className="row">
        <input type="text" className="grow" placeholder='Name, e.g. "before music change"' value={name} disabled={ro} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void save()} />
        <button className="btn primary" disabled={ro || !name.trim()} onClick={save}>
          Save version
        </button>
      </div>
      <div className="row">
        <span className="small muted grow">{pick.length === 2 ? 'Two versions picked.' : 'Tick two versions to compare them side by side.'}</span>
        <button className="btn small" disabled={pick.length !== 2} onClick={() => openDialog({ kind: 'compare', a: pick[0], b: pick[1] })}>
          Compare
        </button>
      </div>
      {list && list.length === 0 && (
        <Empty title="No versions yet">
          <div className="small">Save one before a big change. The app also saves one when Claude marks the edit ready, before re-edits and before exports.</div>
        </Empty>
      )}
      {named.length > 0 && (
        <div className="col" style={{ gap: 0 }}>
          <h4 style={{ marginBottom: 4 }}>Named</h4>
          {named.map(row)}
        </div>
      )}
      {auto.length > 0 && (
        <div className="col" style={{ gap: 0 }}>
          <h4 style={{ marginBottom: 4 }}>Automatic (latest 20)</h4>
          {auto.map(row)}
        </div>
      )}
    </div>
  )
}
