/**
 * The "Title, desc, tags" page. The owner gives up to 3 titles they like and says what the video is about; one quick
 * Claude call writes three titles (search, clickbait, a mix of both), a description and tags. Everything stays
 * editable by hand. The title in use is publish.titles[0] (thumbnail scoring and the export read it from there).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { chapterLines } from '@shared/captions'
import type { PublishPart } from '@shared/ipc'
import type { Project } from '@shared/project'
import { toast } from '../state/app'
import { applyOp, editor } from '../state/editor'
import { createStore, useStore } from '../state/store'
import { CopyButton, Spinner } from '../components/bits'
import { Icon } from '../components/Icon'
import { errorMessage, relativeTime } from '../util'
import { FlowFooter } from './FlowFooter'
import { finishAndExport } from './finish'

type Pub = Project['publish']
type Kind = 'search' | 'clickbait' | 'mix'

const TITLE_MAX = 70
const TAGS_MAX = 500
const DESCRIPTION_MAX = 5000
const KINDS: { kind: Kind; label: string; hint: string }[] = [
  { kind: 'search', label: 'Search', hint: 'Keywords people search, first' },
  { kind: 'clickbait', label: 'Clickbait', hint: 'Curiosity, still true' },
  { kind: 'mix', label: 'Mix of both', hint: 'Keyword plus a hook' }
]

/** What Claude is writing right now. Outside the component so it survives switching tabs. */
const job = createStore<{ busy: PublishPart | 'all' | null }>({ busy: null })

async function generate(only?: PublishPart, direction?: string): Promise<void> {
  if (job.get().busy) return
  job.set({ busy: only ?? 'all' })
  try {
    await window.api.publish.generate({ only, direction })
  } catch (e) {
    toast(`Claude could not write it: ${errorMessage(e)}`, { kind: 'error' })
  } finally {
    job.set({ busy: null })
  }
}

const patch = (p: Partial<Pub>) => applyOp({ op: 'patchProject', path: 'publish', patch: p as Record<string, unknown> })

/** Tags as YouTube counts them: joined with commas, a tag with a space counts its quotes too. */
function tagsLength(tags: string[]): number {
  return tags.reduce((n, t, i) => n + t.length + (/\s/.test(t) ? 2 : 0) + (i ? 1 : 0), 0)
}

export function PublishWorkspace() {
  const snap = useStore(editor, (s) => s.snapshot!)
  const ro = snap.readOnly
  const pub = snap.doc.project.publish
  const busy = useStore(job, (s) => s.busy)
  const chapters = useMemo(() => chapterLines(snap.doc), [snap.doc])

  return (
    <div className="workspace">
      <div className="workspace-body">
        <div className="page pub-page">
          <div className="pub-head">
            <h2>Title, description and tags</h2>
            <span className="hint">
              Tell Claude about the video and the titles you like. It writes a search title, a clickbait title and a mix of both, plus the description and tags. Change anything by hand.
            </span>
          </div>
          <div className="pub-grid">
            <Brief pub={pub} inspiration={snap.doc.project.inspiration} ro={ro} busy={busy} />
            <div className="col pub-out" style={{ gap: 14 }}>
              {busy === 'all' && (
                <div className="pub-busy card">
                  <Spinner />
                  <div className="col" style={{ gap: 2 }}>
                    <b>Claude is writing…</b>
                    <span className="hint">Titles, description and tags, usually 10-30 s. You can keep working in the other tabs.</span>
                  </div>
                </div>
              )}
              <Titles pub={pub} ro={ro} busy={busy} />
              <Description pub={pub} chapters={chapters} ro={ro} busy={busy} />
              <Tags pub={pub} ro={ro} busy={busy} />
              {chapters.length > 0 && (
                <Card title="Chapters" right={<CopyButton text={chapters.join('\n')} />}>
                  <pre className="small mono pub-chapters">{chapters.join('\n')}</pre>
                  <span className="hint">From the edit. The times follow the edit on their own.</span>
                </Card>
              )}
            </div>
          </div>
        </div>
      </div>
      <FlowFooter hint={pub.titles[0] ? <>Title in use: <b className="pub-using">{pub.titles[0]}</b></> : 'Pick the title you want to use, check the description and tags, then finish.'}>
        <button className="btn primary pub-finish" onClick={finishAndExport} title="Export the video with this title, description and tags">
          <Icon name="export" size={14} /> Finish And Export
        </button>
      </FlowFooter>
    </div>
  )
}

function Card({ title, right, busy, children }: { title: string; right?: ReactNode; busy?: boolean; children: ReactNode }) {
  return (
    <section className="card pub-card">
      <div className="row pub-card-head">
        <h4 className="grow">{title}</h4>
        {busy && <Spinner label="Claude is writing…" />}
        {right}
      </div>
      {children}
    </section>
  )
}

function Brief({ pub, inspiration, ro, busy }: { pub: Pub; inspiration: string; ro: boolean; busy: PublishPart | 'all' | null }) {
  const hasTitles = !!pub.generated
  const saved = pub.brief
  const [examples, setExamples] = useState<string[]>(() => [0, 1, 2].map((i) => saved?.examples[i] ?? ''))
  const [about, setAbout] = useState(() => saved?.about || inspiration)
  // Follow changes made elsewhere (undo, another window) while the fields are not being typed in.
  const savedKey = saved ? JSON.stringify({ examples: saved.examples, about: saved.about }) : ''
  useEffect(() => {
    if (!saved) return
    setExamples([0, 1, 2].map((i) => saved.examples[i] ?? ''))
    setAbout(saved.about)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey])

  const save = async (): Promise<void> => {
    const next = { examples: examples.map((e) => e.trim()).filter(Boolean), about: about.trim() }
    if (savedKey === JSON.stringify(next)) return
    if (!saved && !next.examples.length && next.about === inspiration.trim()) return
    await patch({ brief: next })
  }
  const run = async () => {
    await save()
    await generate()
  }

  return (
    <section className="card pub-card pub-brief">
      <div className="field">
        <label htmlFor="pub-about">What is this video about?</label>
        <textarea
          id="pub-about"
          rows={5}
          value={about}
          disabled={ro}
          onChange={(e) => setAbout(e.target.value)}
          onBlur={() => void save()}
          placeholder="e.g. I run a cheap 4S LiPo flat out in my Traxxas until it gets too hot, and show what the heat does to it."
        />
        {!saved?.about && inspiration.trim() && about === inspiration && <span className="hint">From your instructions for the edit. Change it if you like.</span>}
      </div>
      <div className="field">
        <label>Titles you like (up to 3)</label>
        <span className="hint" style={{ marginTop: -2 }}>
          Your own past titles or ones that worked. Claude matches their style.
        </span>
        {examples.map((v, i) => (
          <input
            key={i}
            type="text"
            value={v}
            disabled={ro}
            maxLength={120}
            placeholder={['e.g. I Bought the Cheapest Drift Car on Amazon', 'Title 2 (optional)', 'Title 3 (optional)'][i]}
            onChange={(e) => setExamples(examples.map((x, j) => (j === i ? e.target.value : x)))}
            onBlur={() => void save()}
          />
        ))}
      </div>
      <button className="btn primary pub-generate" disabled={ro || !!busy || (!about.trim() && !examples.some((e) => e.trim()))} onClick={run}>
        <Icon name="sparkle" size={14} /> {busy === 'all' ? 'Claude is writing…' : hasTitles ? 'Write new titles' : 'Write titles, description and tags'}
      </button>
      <span className="hint">
        {busy === 'all'
          ? 'Usually 10-30 s.'
          : (hasTitles ? 'Writes three new titles. ' : 'One quick call to Claude, usually 10-30 s. It reads what is said in the edit too. ') +
            (pub.description.trim() && pub.tags.length
              ? 'Your description and tags are kept: use Rewrite on them for new ones.'
              : pub.description.trim() || pub.tags.length
                ? `It fills in the ${pub.description.trim() ? 'tags' : 'description'}; use Rewrite on the ${pub.description.trim() ? 'description' : 'tags'} for a new one.`
                : '')}
      </span>
      {pub.generated?.at && <span className="tiny faint">Last written {relativeTime(pub.generated.at)}</span>}
    </section>
  )
}

function Titles({ pub, ro, busy }: { pub: Pub; ro: boolean; busy: PublishPart | 'all' | null }) {
  const gen = pub.generated
  const chosen: Kind | null = gen ? (gen.chosen ?? 'mix') : null
  // The chosen card is the title in use only while titles[0] still matches it (Claude or the owner may change it elsewhere).
  const inUse = gen && chosen && pub.titles[0] === gen[chosen] ? chosen : null

  const edit = (k: Kind, text: string) => {
    if (!gen || text === gen[k]) return
    const titles = inUse === k ? [text, ...pub.titles.slice(1)] : pub.titles
    void patch({ generated: { ...gen, [k]: text }, titles })
  }
  const use = (k: Kind) => {
    if (!gen) return
    const t = gen[k].trim()
    if (!t) return
    void patch({ generated: { ...gen, chosen: k }, titles: [t, ...pub.titles.filter((x) => x !== t)] })
  }
  const useOld = (t: string) => void patch({ titles: [t, ...pub.titles.filter((x) => x !== t)] })

  return (
    <Card
      title="Titles"
      busy={busy === 'titles'}
      right={
        gen && (
          <button className="btn ghost small" disabled={ro || !!busy} onClick={() => void generate('titles')} title="Three new titles">
            <Icon name="refresh" size={13} /> Rewrite
          </button>
        )
      }
    >
      {!gen && busy !== 'all' && (
        <div className="pub-empty">
          <span className="small">No titles from this page yet. Fill in the left side and press <b>Write titles, description and tags</b>.</span>
        </div>
      )}
      {gen && (
        <div className="pub-titles">
          {KINDS.map(({ kind, label, hint }) => (
            <TitleCard
              key={kind}
              label={label}
              hint={hint}
              value={gen[kind]}
              using={inUse === kind}
              ro={ro}
              busy={!!busy}
              onEdit={(t) => edit(kind, t)}
              onUse={() => use(kind)}
              onMore={() => void generate('titles', `Write more like the ${label} title "${gen[kind]}": keep its angle and keywords, try new wording for all three.`)}
            />
          ))}
        </div>
      )}
      {(() => {
        const others = pub.titles.filter((t) => !gen || ![gen.search, gen.clickbait, gen.mix].includes(t))
        if (!others.length) return null
        return (
          <div className="col" style={{ gap: 4 }}>
            <span className="label">{gen ? 'Other titles' : 'Titles Claude wrote during the edit'}</span>
            {others.map((t) => (
              <div key={t} className="row pub-old">
                <span className="grow selectable">{t}</span>
                {pub.titles[0] === t ? (
                  <span className="chip accent">
                    <Icon name="check" size={12} /> In use
                  </span>
                ) : (
                  <button className="btn ghost small" disabled={ro} onClick={() => useOld(t)}>
                    Use this title
                  </button>
                )}
              </div>
            ))}
          </div>
        )
      })()}
    </Card>
  )
}

function TitleCard(props: { label: string; hint: string; value: string; using: boolean; ro: boolean; busy: boolean; onEdit: (t: string) => void; onUse: () => void; onMore: () => void }) {
  const [text, setText] = useState(props.value)
  useEffect(() => setText(props.value), [props.value])
  const n = text.trim().length
  const commit = () => {
    const t = text.replace(/\s+/g, ' ').trim()
    if (t && t !== props.value) props.onEdit(t)
    else setText(props.value)
  }
  return (
    <div className={`pub-title${props.using ? ' on' : ''}`}>
      <div className="pub-title-kind">
        <b>{props.label}</b>
        <span className="tiny faint">{props.hint}</span>
      </div>
      <input
        type="text"
        className="pub-title-text"
        value={text}
        disabled={props.ro}
        aria-label={`${props.label} title`}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <span className={`pub-title-count tiny ${n > TITLE_MAX ? 'pub-over' : 'faint'}`} title={n > TITLE_MAX ? 'YouTube cuts titles longer than about 70 characters in search and on phones' : 'Characters'}>
        {n}/{TITLE_MAX}
      </span>
      <div className="pub-title-use">
        {props.using ? (
          <span className="chip accent">
            <Icon name="check" size={12} /> Using this title
          </span>
        ) : (
          <button className="btn small" disabled={props.ro || !n} onClick={props.onUse}>
            Use this title
          </button>
        )}
      </div>
      <div className="pub-title-more row" style={{ gap: 4 }}>
        <button className="btn ghost small" disabled={props.ro || props.busy} onClick={props.onMore} title="Three new titles in this direction">
          More like this
        </button>
        <CopyButton text={text.trim()} label="" />
      </div>
    </div>
  )
}

function Description({ pub, chapters, ro, busy }: { pub: Pub; chapters: string[]; ro: boolean; busy: PublishPart | 'all' | null }) {
  const [text, setText] = useState(pub.description)
  useEffect(() => setText(pub.description), [pub.description])
  const full = [text.trim(), chapters.length ? chapters.join('\n') : ''].filter(Boolean).join('\n\n')
  return (
    <Card
      title="Description"
      busy={busy === 'description'}
      right={
        <>
          <button className="btn ghost small" disabled={ro || !!busy} onClick={() => void generate('description')}>
            <Icon name="refresh" size={13} /> {pub.description ? 'Rewrite' : 'Write'}
          </button>
          <CopyButton text={full} />
        </>
      }
    >
      <textarea
        rows={9}
        value={text}
        disabled={ro}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== pub.description && void patch({ description: text })}
        placeholder="The description shows here once Claude writes it, or type your own."
      />
      <div className="row">
        <span className="hint grow">
          The first two lines show above “…more”, so they carry the hook and keywords.{chapters.length ? ' Copy includes the chapters.' : ''}
        </span>
        <span className={`tiny ${text.length > DESCRIPTION_MAX ? 'pub-over' : 'faint'}`}>
          {text.length}/{DESCRIPTION_MAX}
        </span>
      </div>
    </Card>
  )
}

function Tags({ pub, ro, busy }: { pub: Pub; ro: boolean; busy: PublishPart | 'all' | null }) {
  const [draft, setDraft] = useState('')
  const total = tagsLength(pub.tags)
  const add = (raw: string) => {
    const fresh = raw
      .split(',')
      .map((t) => t.replace(/^#+/, '').replace(/\s+/g, ' ').trim())
      .filter((t) => t && !pub.tags.some((o) => o.toLowerCase() === t.toLowerCase()))
    setDraft('')
    if (fresh.length) void patch({ tags: [...pub.tags, ...new Set(fresh)] })
  }
  const remove = (t: string) => void patch({ tags: pub.tags.filter((x) => x !== t) })
  return (
    <Card
      title="Tags"
      busy={busy === 'tags'}
      right={
        <>
          <button className="btn ghost small" disabled={ro || !!busy} onClick={() => void generate('tags')}>
            <Icon name="refresh" size={13} /> {pub.tags.length ? 'Rewrite' : 'Write'}
          </button>
          <CopyButton text={pub.tags.join(', ')} />
        </>
      }
    >
      <div className="pub-tags">
        {pub.tags.map((t) => (
          <span key={t} className="pub-tag">
            {t}
            {!ro && (
              <button aria-label={`Remove ${t}`} title="Remove" onClick={() => remove(t)}>
                <Icon name="close" size={11} />
              </button>
            )}
          </span>
        ))}
        <input
          type="text"
          className="pub-tag-input"
          value={draft}
          disabled={ro}
          placeholder={pub.tags.length ? 'Add a tag…' : 'Type tags, separated by commas…'}
          onChange={(e) => (e.target.value.includes(',') ? add(e.target.value) : setDraft(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add(draft)
            if (e.key === 'Backspace' && !draft && pub.tags.length) remove(pub.tags[pub.tags.length - 1])
          }}
          onBlur={() => draft.trim() && add(draft)}
        />
      </div>
      <div className="row">
        <span className="hint grow">Specific first (the exact product or search phrase), then broad. 10-20 is plenty.</span>
        <span className="tiny faint">{pub.tags.length} tags</span>
        <span className={`tiny ${total > TAGS_MAX ? 'pub-over' : 'faint'}`} title="Characters, as YouTube counts them">
          {total}/{TAGS_MAX}
        </span>
      </div>
    </Card>
  )
}
