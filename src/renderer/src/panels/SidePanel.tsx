/** The side panel and its tabs. */
import { editor, setTab, type SideTab } from '../state/editor'
import { useStore } from '../state/store'
import { ChatPanel } from './ChatPanel'
import { InspectorPanel } from './InspectorPanel'
import { TranscriptPanel } from './TranscriptPanel'
import { ThumbnailsPanel } from './ThumbnailsPanel'
import { PublishPanel } from './PublishPanel'
import { VersionsPanel } from './VersionsPanel'
import { NotesPanel } from './NotesPanel'

const TABS: [SideTab, string][] = [
  ['chat', 'Chat'],
  ['inspector', 'Inspector'],
  ['transcript', 'Transcript'],
  ['thumbnails', 'Thumbnails'],
  ['publish', 'Publish'],
  ['versions', 'Versions'],
  ['notes', 'Notes for Claude']
]

export function SidePanel() {
  const tab = useStore(editor, (s) => s.tab)
  const openNotes = useStore(editor, (s) => s.snapshot!.doc.project.notes.filter((n) => n.status === 'open').length)
  const reviews = useStore(editor, (s) => s.snapshot!.doc.project.requests.filter((r) => r.review === 'pending').length)
  return (
    <div className="side">
      <div className="tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
            {id === 'notes' && openNotes > 0 && <span className="count">{openNotes}</span>}
            {id === 'chat' && reviews > 0 && <span className="count">{reviews}</span>}
          </button>
        ))}
      </div>
      {tab === 'chat' && <ChatPanel />}
      {tab === 'inspector' && <InspectorPanel />}
      {tab === 'transcript' && <TranscriptPanel />}
      {tab === 'thumbnails' && <ThumbnailsPanel />}
      {tab === 'publish' && <PublishPanel />}
      {tab === 'versions' && <VersionsPanel />}
      {tab === 'notes' && <NotesPanel />}
    </div>
  )
}
