/** Tabs at the top of the editor: Instructions, Editing, Thumbnails, Title, desc, tags. Any of them, at any time. */
import { WORKSPACES, editor, setWorkspace } from '../state/editor'
import { useStore } from '../state/store'

export function WorkspaceTabs() {
  const current = useStore(editor, (s) => s.workspace)
  return (
    <div className="workspace-tabs" role="tablist">
      {WORKSPACES.map(([id, label], i) => (
        <button key={id} role="tab" aria-selected={current === id} className={current === id ? 'on' : ''} onClick={() => setWorkspace(id)}>
          <span className="step">{i + 1}</span>
          {label}
        </button>
      ))}
      <span className="spacer" />
      <EditNext />
    </div>
  )
}

/** In the Editing tab, once the edit is ready: on to the thumbnails (the flow's next step), top right. */
function EditNext() {
  const workspace = useStore(editor, (s) => s.workspace)
  const status = useStore(editor, (s) => s.snapshot!.doc.project.status)
  if (workspace !== 'edit' || (status !== 'ready_for_review' && status !== 'exported')) return null
  return (
    <button className="btn small primary next" onClick={() => setWorkspace('thumbnails')} title="Happy with the edit? Make the thumbnails next">
      Next: Thumbnails →
    </button>
  )
}
