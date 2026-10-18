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
    </div>
  )
}
