/**
 * Profiles: one per channel. Name and colour, thumbnail defaults, music folders, channel notes for the AI,
 * editing rules, channel rules, brand kit, export preset, captions, description template and mix.
 * Changes save on their own a moment after you stop typing. Editing a profile never changes existing projects.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { LibraryAsset } from '@shared/ipc'
import type { BrandKit, CaptionStyle, MixSettings } from '@shared/project'
import type { Pikzonality, Profile, Rule } from '@shared/settings'
import { DEFAULT_EDITING_RULES } from '@shared/rules'
import { app, call, refreshProfiles, toast } from '../state/app'
import { useStore } from '../state/store'
import { CommitSlider, Empty, NumberInput, Toggle } from '../components/bits'
import { Icon } from '../components/Icon'
import { CAPTION_EXPORT_LABELS, PresetEditor } from '../components/PresetEditor'
import { FONT_EXTS, IMAGE_EXTS, VIDEO_EXTS, basename, mediaUrl, stripExt } from '../util'

export function ProfilesSection() {
  const profiles = useStore(app, (s) => s.profiles)
  const selectedId = useStore(app, (s) => s.settingsProfileId)
  const [newName, setNewName] = useState('')
  const selected = profiles.find((p) => p.id === selectedId) ?? profiles[0]

  const create = async () => {
    const p = await call(() => window.api.profiles.create(newName.trim()))
    if (p) {
      await refreshProfiles()
      app.set({ settingsProfileId: p.id })
      setNewName('')
    }
  }

  return (
    <>
      <h1 style={{ marginBottom: 8 }}>Profiles</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        One profile per channel. A new project copies its profile's settings; editing a profile never changes projects you already made.
      </p>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        {profiles.map((p) => (
          <button key={p.id} className={`btn${selected?.id === p.id ? ' on' : ''}`} onClick={() => app.set({ settingsProfileId: p.id })}>
            <span className="dot" style={{ width: 8, height: 8, borderRadius: '50%', background: p.color }} />
            {p.name}
          </button>
        ))}
        <input type="text" placeholder="New profile name" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && newName.trim() && void create()} style={{ width: 180 }} />
        <button className="btn" disabled={!newName.trim()} onClick={create}>
          <Icon name="plus" size={14} /> Add
        </button>
      </div>
      {selected ? (
        <ProfileEditor key={selected.id} profile={selected} />
      ) : (
        <Empty title="No profiles yet">
          <p>Add one for each channel, for example "RC cars" and "Finance".</p>
        </Empty>
      )}
    </>
  )
}

function ProfileEditor({ profile }: { profile: Profile }) {
  const [draft, setDraft] = useState<Profile>(profile)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const latest = useRef(draft)
  const [pikz, setPikz] = useState<Pikzonality[]>([])
  const [assets, setAssets] = useState<LibraryAsset[]>([])
  const musicFolders = useStore(app, (s) => s.settings?.musicFolders ?? [])

  useEffect(() => {
    void call(() => window.api.pikzels.list()).then((l) => setPikz(l ?? []))
    void call(() => window.api.library.list({})).then((l) => setAssets(l ?? []))
  }, [])

  // Pick up rules accepted elsewhere (suggestion toasts, notes saved as rules) while this editor is open.
  useEffect(() => {
    if (JSON.stringify(profile.rules) !== JSON.stringify(latest.current.rules)) {
      setDraft((d) => (latest.current = { ...d, rules: profile.rules, corrections: profile.corrections }))
    }
  }, [profile.rules, profile.corrections])

  const flush = async () => {
    clearTimeout(timer.current)
    timer.current = undefined
    const saved = await call(() => window.api.profiles.save(latest.current), 'Could not save the profile')
    if (saved) app.set((s) => ({ profiles: s.profiles.map((p) => (p.id === saved.id ? saved : p)) }))
  }

  useEffect(
    () => () => {
      if (timer.current) void flush()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const update = (patch: Partial<Profile>) => {
    setDraft((d) => {
      const next = { ...d, ...patch }
      latest.current = next
      return next
    })
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), 600)
  }
  const brand = (patch: Partial<BrandKit>) => update({ brandKit: { ...latest.current.brandKit, ...patch } })
  const caption = (patch: Partial<CaptionStyle>) => brand({ captionStyle: { ...latest.current.brandKit.captionStyle, ...patch } })
  const mix = (patch: Partial<MixSettings>) => update({ mix: { ...latest.current.mix, ...patch } })

  const personas = pikz.filter((p) => p.kind === 'persona' && p.status === 'completed')
  const styles = pikz.filter((p) => p.kind === 'style' && p.status === 'completed')
  const sounds = assets.filter((a) => a.type === 'sound' && (a.scope === 'shared' || a.scope === profile.id))
  const clips = assets.filter((a) => (a.type === 'clip' || a.type === 'graphic') && (a.scope === 'shared' || a.scope === profile.id))
  const bk = draft.brandKit
  const cs = bk.captionStyle

  const pickFile = async (title: string, extensions: string[]) => {
    const files = await call(() => window.api.app.pickFiles({ title, filters: [{ name: title, extensions }] }))
    return files?.[0]
  }

  return (
    <div className="col" style={{ gap: 0 }}>
      <Section title="Name and colour">
        <div className="row">
          <input type="text" className="grow" value={draft.name} onChange={(e) => update({ name: e.target.value })} />
          <input type="color" value={draft.color} onChange={(e) => update({ color: e.target.value })} title="Shown on project cards and in the editor" />
        </div>
      </Section>

      <Section title="Thumbnails" hint="Used unless you change them in a project.">
        <div className="field-row">
          <label className="label">Default persona</label>
          <PikzSelect value={draft.thumbnail.personaId} options={personas} onChange={(v) => update({ thumbnail: { ...draft.thumbnail, personaId: v } })} />
        </div>
        <div className="field-row">
          <label className="label">Default style</label>
          <PikzSelect value={draft.thumbnail.styleId} options={styles} onChange={(v) => update({ thumbnail: { ...draft.thumbnail, styleId: v } })} />
        </div>
        <div className="field-row">
          <label className="label">Options per video</label>
          <div className="seg" style={{ width: 'fit-content' }}>
            {[1, 2, 3].map((n) => (
              <button key={n} className={draft.thumbnail.count === n ? 'on' : ''} onClick={() => update({ thumbnail: { ...draft.thumbnail, count: n } })}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <div className="field-row" style={{ alignItems: 'start' }}>
          <label className="label">Thumbnail direction</label>
          <textarea rows={2} placeholder='Standing notes for thumbnail prompts, e.g. "big bold text, shocked face"' value={draft.thumbnail.direction} onChange={(e) => update({ thumbnail: { ...draft.thumbnail, direction: e.target.value } })} />
        </div>
      </Section>

      <Section title="Music folders" hint="Which of your music folders Claude may use for this channel.">
        {musicFolders.length === 0 ? (
          <span className="small muted">No music folders yet. Add them under Music folders.</span>
        ) : (
          musicFolders.map((f) => (
            <Toggle
              key={f.id}
              checked={draft.musicFolderIds.includes(f.id)}
              label={f.name}
              onChange={(on) =>
                update({ musicFolderIds: on ? [...draft.musicFolderIds, f.id] : draft.musicFolderIds.filter((id) => id !== f.id) })
              }
            />
          ))
        )}
      </Section>

      <Section title="Channel notes for the AI" hint="Tone, pacing, things to always or never do. Claude reads these at the start of every edit.">
        <textarea rows={5} value={draft.channelNotes} placeholder="e.g. Fast pacing, dry humour. Never use stock footage of people. Always show the price on screen." onChange={(e) => update({ channelNotes: e.target.value })} />
      </Section>

      <Section title="Channel rules" hint="Rules you wrote, notes you saved as rules, and learned corrections you said yes to.">
        <RulesEditor rules={draft.rules} onChange={(rules) => update({ rules })} />
      </Section>

      <Section title="Editing rules" hint="The standard method handed to Claude every session. Claude applies them; the app does not.">
        <textarea className="mono small" rows={10} value={draft.editingRules || DEFAULT_EDITING_RULES} onChange={(e) => update({ editingRules: e.target.value })} />
        {draft.editingRules && draft.editingRules !== DEFAULT_EDITING_RULES && (
          <div>
            <button className="btn ghost small" onClick={() => update({ editingRules: '' })}>
              Reset to the standard rules
            </button>
          </div>
        )}
      </Section>

      <Section title="Brand kit" hint="Claude reads this before making any graphic. Library assets take their fonts and colours from it.">
        <h4>Fonts</h4>
        {bk.fonts.map((f, i) => (
          <div key={f.path + i} className="row">
            <input type="text" style={{ width: 180 }} value={f.name} onChange={(e) => brand({ fonts: bk.fonts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
            <code className="grow ellipsis small muted">{f.path}</code>
            <button className="btn ghost small danger" onClick={() => brand({ fonts: bk.fonts.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
        ))}
        <div>
          <button
            className="btn small"
            onClick={async () => {
              const files = await call(() => window.api.app.pickFiles({ title: 'Load font files', filters: [{ name: 'Fonts', extensions: FONT_EXTS }], multi: true }))
              if (files?.length) brand({ fonts: [...bk.fonts, ...files.map((p) => ({ name: stripExt(basename(p)), path: p }))] })
            }}
          >
            <Icon name="plus" size={14} /> Load font files
          </button>
        </div>

        <h4 style={{ marginTop: 10 }}>Colours</h4>
        <div className="row">
          {(['primary', 'secondary', 'accent'] as const).map((k) => (
            <label key={k} className="row small" style={{ gap: 6 }}>
              <input type="color" value={bk.colors[k]} onChange={(e) => brand({ colors: { ...bk.colors, [k]: e.target.value } })} />
              {k[0].toUpperCase() + k.slice(1)}
            </label>
          ))}
        </div>

        <h4 style={{ marginTop: 10 }}>Logo and watermark</h4>
        <Toggle checked={bk.logo.enabled} onChange={(v) => brand({ logo: { ...bk.logo, enabled: v } })} label="Show a logo on screen" />
        <div className="row">
          <code className="grow ellipsis small">{bk.logo.path || 'No logo file'}</code>
          <button
            className="btn small"
            onClick={async () => {
              const f = await pickFile('Logo image', IMAGE_EXTS)
              if (f) brand({ logo: { ...bk.logo, path: f } })
            }}
          >
            Choose image
          </button>
        </div>
        <div className="row wrap">
          <select value={bk.logo.position} onChange={(e) => brand({ logo: { ...bk.logo, position: e.target.value as BrandKit['logo']['position'] } })}>
            <option value="top-left">Top left</option>
            <option value="top-right">Top right</option>
            <option value="bottom-left">Bottom left</option>
            <option value="bottom-right">Bottom right</option>
          </select>
          <span className="small muted">Size</span>
          <CommitSlider value={bk.logo.size} min={0.03} max={0.3} step={0.01} onCommit={(v) => brand({ logo: { ...bk.logo, size: v } })} format={(v) => `${Math.round(v * 100)}%`} />
          <span className="small muted">Opacity</span>
          <CommitSlider value={bk.logo.opacity} min={0.1} max={1} step={0.05} onCommit={(v) => brand({ logo: { ...bk.logo, opacity: v } })} format={(v) => `${Math.round(v * 100)}%`} />
        </div>

        <h4 style={{ marginTop: 10 }}>Intro and outro</h4>
        {(['intro', 'outro'] as const).map((k) => (
          <div key={k} className="field-row">
            <label className="label">{k === 'intro' ? 'Intro' : 'Outro'}</label>
            <div className="row">
              <select
                className="grow"
                value={clips.some((a) => a.id === bk[k]) ? bk[k] : bk[k] ? '__file' : ''}
                onChange={(e) => e.target.value !== '__file' && brand({ [k]: e.target.value })}
              >
                <option value="">None</option>
                {bk[k] && !clips.some((a) => a.id === bk[k]) && <option value="__file">{basename(bk[k])}</option>}
                {clips.map((a) => (
                  <option key={a.id} value={a.id}>
                    Library: {a.name}
                  </option>
                ))}
              </select>
              <button
                className="btn small"
                onClick={async () => {
                  const f = await pickFile(`${k === 'intro' ? 'Intro' : 'Outro'} clip`, VIDEO_EXTS)
                  if (f) brand({ [k]: f })
                }}
              >
                Choose clip
              </button>
            </div>
          </div>
        ))}

        <h4 style={{ marginTop: 10 }}>Caption style</h4>
        <div className="field-row">
          <label className="label">Font</label>
          <select value={cs.font} onChange={(e) => caption({ font: e.target.value })}>
            <option value="">Standard font</option>
            {bk.fonts.map((f) => (
              <option key={f.path} value={f.path}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field-row">
          <label className="label">Size</label>
          <CommitSlider value={cs.size} min={0.03} max={0.12} step={0.005} onCommit={(v) => caption({ size: v })} format={(v) => `${(v * 100).toFixed(1)}%`} />
        </div>
        <div className="field-row">
          <label className="label">Position</label>
          <div className="seg" style={{ width: 'fit-content' }}>
            {(['top', 'middle', 'bottom'] as const).map((p) => (
              <button key={p} className={cs.position === p ? 'on' : ''} onClick={() => caption({ position: p })}>
                {p[0].toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="field-row">
          <label className="label">Colours</label>
          <div className="row small">
            <input type="color" value={cs.color} onChange={(e) => caption({ color: e.target.value })} /> Text
            <input type="color" value={cs.highlightColor} onChange={(e) => caption({ highlightColor: e.target.value })} /> Highlight
            <input type="color" value={cs.outlineColor} onChange={(e) => caption({ outlineColor: e.target.value })} /> Outline
          </div>
        </div>
        <div className="field-row">
          <label className="label">Words per line</label>
          <NumberInput value={cs.maxWords} min={1} max={12} step={1} width={70} onCommit={(v) => caption({ maxWords: Math.round(v) })} />
        </div>
        <CaptionPreview style={cs} fonts={bk.fonts} />

        <h4 style={{ marginTop: 10 }}>Sound signature</h4>
        <select value={bk.soundSignature} onChange={(e) => brand({ soundSignature: e.target.value })}>
          <option value="">None</option>
          {sounds.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {sounds.length === 0 && <span className="hint">Save a whoosh, pop or sting to the library to choose it here.</span>}
      </Section>

      <Section title="Export" hint="The default for new projects. You can change it in each export.">
        <PresetEditor value={draft.exportPreset} onChange={(p) => update({ exportPreset: p })} />
        <div className="field-row">
          <label className="label">Captions at export</label>
          <select value={draft.captionExport} onChange={(e) => update({ captionExport: e.target.value as Profile['captionExport'] })}>
            {Object.entries(CAPTION_EXPORT_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
      </Section>

      <Section title="Description template" hint="Your standing links and any disclaimer. Claude adds it to every description it writes.">
        <textarea rows={5} value={draft.descriptionTemplate} placeholder={'Gear I use: https://…\n\nThis is not financial advice.'} onChange={(e) => update({ descriptionTemplate: e.target.value })} />
      </Section>

      <Section title="Mix" hint="Changing these re-runs the mix on your PC. It uses no Claude usage.">
        <div className="field-row">
          <label className="label">Music under speech</label>
          <CommitSlider value={draft.mix.musicUnderSpeechDb} min={-30} max={0} step={1} onCommit={(v) => mix({ musicUnderSpeechDb: v })} format={(v) => `${v} dB`} width={200} />
        </div>
        <div className="field-row">
          <label className="label">Final loudness</label>
          <CommitSlider value={draft.mix.targetLufs} min={-24} max={-8} step={0.5} onCommit={(v) => mix({ targetLufs: v })} format={(v) => `${v} LUFS`} width={200} />
        </div>
        <div className="field-row">
          <label className="label">Peak limit</label>
          <CommitSlider value={draft.mix.truePeakDb} min={-6} max={0} step={0.5} onCommit={(v) => mix({ truePeakDb: v })} format={(v) => `${v} dB`} width={200} />
        </div>
        <Toggle checked={draft.mix.voiceCleanup} onChange={(v) => mix({ voiceCleanup: v })} label="Voice clean-up" />
        <Toggle checked={draft.mix.limiter} onChange={(v) => mix({ limiter: v })} label="Limiter for mic handling noise" />
        <span className="hint">YouTube plays videos at about -14 LUFS.</span>
      </Section>

      <Section title="Delete this profile">
        <div>
          <button
            className="btn danger"
            onClick={async () => {
              clearTimeout(timer.current)
              timer.current = undefined
              await call(() => window.api.profiles.delete(profile.id))
              await refreshProfiles()
              app.set({ settingsProfileId: null })
              toast(`Deleted the profile "${profile.name}". Its projects keep their own settings.`)
            }}
          >
            <Icon name="trash" size={14} /> Delete profile
          </button>
        </div>
      </Section>
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="section col">
      <h3>{title}</h3>
      {hint && <span className="hint">{hint}</span>}
      {children}
    </div>
  )
}

function PikzSelect({ value, options, onChange }: { value: string; options: Pikzonality[]; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">None</option>
      {value && !options.some((o) => o.id === value) && <option value={value}>(not ready or deleted)</option>}
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  )
}

function RulesEditor({ rules, onChange }: { rules: Rule[]; onChange: (r: Rule[]) => void }) {
  const [text, setText] = useState('')
  const add = () => {
    if (!text.trim()) return
    onChange([...rules, { id: `rule_${Date.now().toString(36)}`, text: text.trim(), enabled: true, source: 'user', createdAt: new Date().toISOString() }])
    setText('')
  }
  return (
    <div className="col" style={{ gap: 0 }}>
      {rules.length === 0 && <span className="small muted" style={{ paddingBottom: 6 }}>No channel rules yet.</span>}
      {rules.map((r) => (
        <div key={r.id} className="rule-row">
          <input type="checkbox" checked={r.enabled} title={r.enabled ? 'Switch off' : 'Switch on'} onChange={(e) => onChange(rules.map((x) => (x.id === r.id ? { ...x, enabled: e.target.checked } : x)))} />
          <div className="col" style={{ gap: 2 }}>
            <textarea rows={1} value={r.text} style={{ opacity: r.enabled ? 1 : 0.5 }} onChange={(e) => onChange(rules.map((x) => (x.id === r.id ? { ...x, text: e.target.value } : x)))} />
            {r.source !== 'user' && <span className="tiny faint">{r.source === 'learned' ? 'Learned from your tweaks' : 'Saved from a note'}</span>}
          </div>
          <button className="btn ghost small icon danger" title="Delete rule" onClick={() => onChange(rules.filter((x) => x.id !== r.id))}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}
      <div className="row" style={{ paddingTop: 8 }}>
        <input type="text" className="grow" placeholder="Write a rule, e.g. Keep graphics on screen for at most 3 seconds" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="btn" disabled={!text.trim()} onClick={add}>
          Add rule
        </button>
      </div>
    </div>
  )
}

function CaptionPreview({ style, fonts }: { style: CaptionStyle; fonts: { name: string; path: string }[] }) {
  const [family, setFamily] = useState('inherit')
  useEffect(() => {
    if (!style.font) {
      setFamily('inherit')
      return
    }
    const name = `brand_${Math.abs(hash(style.font))}`
    const url = mediaUrl(style.font)
    if (!url) return
    const face = new FontFace(name, `url("${url}")`)
    face
      .load()
      .then((f) => {
        document.fonts.add(f)
        setFamily(name)
      })
      .catch(() => setFamily('inherit'))
  }, [style.font, fonts])
  const pos = style.position === 'top' ? { top: '10%' } : style.position === 'middle' ? { top: '42%' } : { bottom: '10%' }
  return (
    <div className="caption-preview">
      <span
        style={{
          ...pos,
          fontFamily: family,
          fontSize: `${style.size * 120}px`,
          color: style.color,
          WebkitTextStroke: `1px ${style.outlineColor}`,
          textShadow: `0 2px 4px ${style.outlineColor}`
        }}
      >
        This is how <span style={{ position: 'static', color: style.highlightColor, padding: 0 }}>captions</span> look
      </span>
    </div>
  )
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}
