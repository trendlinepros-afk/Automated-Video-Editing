/**
 * Publish: title options, description, chapters and tags, each with Copy, next to the chosen thumbnail.
 * Chapters are tied to moments in the video, so their times follow the edit.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { chapterLines } from '@shared/captions'
import { call, toast } from '../state/app'
import { editor } from '../state/editor'
import { useStore } from '../state/store'
import { CopyButton, Empty } from '../components/bits'
import { Icon } from '../components/Icon'
import { errorMessage, mediaUrl, relativeTime } from '../util'

type Part = 'titles' | 'description' | 'chapters' | 'tags'

export function PublishPanel() {
  const snap = useStore(editor, (s) => s.snapshot!)
  const pub = snap.doc.project.publish
  const th = snap.doc.project.thumbnails
  const chosen = th.items.find((t) => t.id === th.chosenId)
  const chapters = useMemo(() => chapterLines(snap.doc), [snap.doc])
  const [exporting, setExporting] = useState(false)
  const empty = !pub.titles.length && !pub.description && !pub.chapters.length && !pub.tags.length

  const exportPack = async () => {
    setExporting(true)
    const dir = await call(() => window.api.project.exportPack(), 'Could not export the pack')
    setExporting(false)
    if (dir) toast('Saved the publishing pack.', { actions: [{ label: 'Open folder', run: () => void window.api.app.openPath(dir) }] })
  }

  return (
    <div className="panel">
      <div className="row top">
        <div style={{ width: 160, flex: 'none' }}>
          <div className="thumb chosen" style={{ borderColor: chosen ? 'var(--accent)' : 'transparent' }}>
            <div className="img">{chosen?.file ? <img src={mediaUrl(chosen.file, snap.path)} alt="" /> : <span className="tiny faint">No thumbnail chosen</span>}</div>
          </div>
        </div>
        <div className="col grow" style={{ gap: 6 }}>
          <button className="btn primary" disabled={exporting} onClick={exportPack} title="The video, thumbnail, subtitle file and a text file of the title, description and chapters, in one folder">
            <Icon name="export" size={14} /> {exporting ? 'Exporting…' : 'Export pack'}
          </button>
          <span className="hint">Video, thumbnail, subtitle file, and a text file with the title, description and chapters.</span>
          {pub.updatedAt && <span className="tiny faint">Written {relativeTime(pub.updatedAt)}</span>}
        </div>
      </div>

      {empty && (
        <Empty title="Nothing written yet">
          <div className="small">When the edit is ready, Claude writes title options, a description, chapters and tags here. You can also ask for any part below.</div>
        </Empty>
      )}

      <Section part="titles" title="Titles" copy={pub.titles.join('\n')}>
        {pub.titles.map((t, i) => (
          <div key={i} className="row">
            <span className="grow selectable">{t}</span>
            <CopyButton text={t} label="" />
          </div>
        ))}
      </Section>
      <Section part="description" title="Description" copy={pub.description}>
        {pub.description && <pre className="small">{pub.description}</pre>}
      </Section>
      <Section part="chapters" title="Chapters" copy={chapters.join('\n')}>
        {chapters.length > 0 && <pre className="small mono">{chapters.join('\n')}</pre>}
        {chapters.length > 0 && <span className="hint">Times follow the edit on their own.</span>}
      </Section>
      <Section part="tags" title="Tags" copy={pub.tags.join(', ')}>
        {pub.tags.length > 0 && (
          <div className="row wrap" style={{ gap: 4 }}>
            {pub.tags.map((t) => (
              <span key={t} className="tag">
                {t}
              </span>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

function Section({ part, title, copy, children }: { part: Part; title: string; copy: string; children: ReactNode }) {
  const ro = useStore(editor, (s) => s.snapshot!.readOnly)
  const [open, setOpen] = useState(false)
  const [direction, setDirection] = useState('')
  const regen = async () => {
    try {
      await window.api.project.regeneratePublish(part, direction.trim())
      toast(`Asked Claude to rewrite the ${title.toLowerCase()}.`)
      setOpen(false)
      setDirection('')
    } catch (e) {
      toast(errorMessage(e), { kind: 'error' })
    }
  }
  return (
    <div className="section col" style={{ gap: 6 }}>
      <div className="row">
        <h4 className="grow">{title}</h4>
        <button className="btn ghost small" disabled={ro} onClick={() => setOpen(!open)}>
          <Icon name="refresh" size={13} /> {copy ? 'Regenerate' : 'Write'}
        </button>
        <CopyButton text={copy} />
      </div>
      {children}
      {open && (
        <div className="col" style={{ gap: 6 }}>
          <textarea rows={2} autoFocus value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="Your direction (optional), e.g. shorter, more curiosity, mention the price (Win+H to speak)" />
          <div className="row">
            <span className="spacer" />
            <button className="btn ghost small" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn small primary" onClick={regen}>
              Ask Claude
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
