/** Settings: keys, folders, music folders, Claude connection, profiles, suggested rules, About. */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MusicTrack, RunnerState, Suggestion } from '@shared/ipc'
import { CORRECTION_KINDS, SettingsSchema } from '@shared/settings'
import { app, call, profileById, refreshProfiles, refreshSettings, toast, updateSettings, type SettingsSection } from '../state/app'
import { useStore } from '../state/store'
import { AppTopBar } from '../components/AppTopBar'
import { CopyButton, Empty, Spinner, Toggle } from '../components/bits'
import { Icon } from '../components/Icon'
import { UpdateButton } from '../components/Updates'
import { ProfilesSection } from '../settings/ProfilesSection'
import { ModelsSection } from '../settings/ModelsSection'
import { fmt } from '../util'
import { PriceEditor } from '../panels/ThumbnailsPanelCosts'

const SECTIONS: [SettingsSection, string][] = [
  ['general', 'General'],
  ['music', 'Music folders'],
  ['claude', 'Claude connection'],
  ['models', 'Claude models'],
  ['profiles', 'Profiles'],
  ['suggestions', 'Suggested rules'],
  ['about', 'About']
]

export function SettingsScreen() {
  const section = useStore(app, (s) => s.settingsSection)
  const settings = useStore(app, (s) => s.settings)
  useEffect(() => {
    void refreshSettings()
    void refreshProfiles()
  }, [])
  return (
    <>
      <AppTopBar />
      <div className="screen" style={{ overflow: 'hidden' }}>
        <div className="settings">
          <nav className="settings-nav">
            {SECTIONS.map(([id, label]) => (
              <button key={id} className={section === id ? 'on' : ''} onClick={() => app.set({ settingsSection: id })}>
                {label}
              </button>
            ))}
          </nav>
          <div className="settings-body">
            <div className="inner">
              {!settings ? (
                <Spinner label="Loading settings…" />
              ) : section === 'general' ? (
                <General />
              ) : section === 'music' ? (
                <Music />
              ) : section === 'claude' ? (
                <Claude />
              ) : section === 'models' ? (
                <ModelsSection />
              ) : section === 'profiles' ? (
                <ProfilesSection />
              ) : section === 'suggestions' ? (
                <Suggestions />
              ) : (
                <About />
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function FolderRow({ label, value, hint, onPick, onClear }: { label: string; value: string; hint?: string; onPick: () => void; onClear?: () => void }) {
  return (
    <div className="section col">
      <h3>{label}</h3>
      {hint && <span className="hint">{hint}</span>}
      <div className="row">
        <code className="grow ellipsis">{value || 'Not set'}</code>
        {value && (
          <button className="btn ghost small" onClick={() => void window.api.app.openPath(value)} title="Open folder">
            <Icon name="folder" size={14} />
          </button>
        )}
        <button className="btn" onClick={onPick}>
          Choose
        </button>
        {onClear && value && (
          <button className="btn ghost" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
    </div>
  )
}

function General() {
  const settings = useStore(app, (s) => s.settings)!
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [key, setKey] = useState('')
  const [editingKey, setEditingKey] = useState(false)
  useEffect(() => {
    void call(() => window.api.settings.hasPikzelsKey()).then((k) => setHasKey(!!k))
  }, [])
  const pick = async (field: 'defaultProjectsFolder' | 'defaultExportsFolder' | 'libraryFolder', title: string) => {
    const dir = await call(() => window.api.app.pickFolder(title, settings[field] || undefined))
    if (dir) await updateSettings({ [field]: dir })
  }
  const saveKey = async () => {
    await call(() => window.api.settings.setPikzelsKey(key.trim()))
    setKey('')
    setEditingKey(false)
    setHasKey(true)
    toast('Pikzels key saved with Windows credential protection.')
  }
  return (
    <>
      <h1 style={{ marginBottom: 8 }}>General</h1>
      <div className="section col">
        <h3>Pikzels API key</h3>
        <span className="hint">Used for thumbnails only. Stored with Windows credential protection, never in project files or logs.</span>
        {hasKey === null ? null : hasKey && !editingKey ? (
          <div className="row">
            <code className="grow">••••••••••••••••</code>
            <button className="btn" onClick={() => setEditingKey(true)}>
              Replace
            </button>
            <button
              className="btn ghost danger"
              onClick={async () => {
                await call(() => window.api.settings.setPikzelsKey(null))
                setHasKey(false)
                toast('Pikzels key removed.')
              }}
            >
              Clear
            </button>
          </div>
        ) : (
          <div className="row">
            <input type="password" className="grow" placeholder="Paste your Pikzels API key" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
            <button className="btn primary" disabled={!key.trim()} onClick={saveKey}>
              Save key
            </button>
            {editingKey && (
              <button className="btn ghost" onClick={() => setEditingKey(false)}>
                Cancel
              </button>
            )}
          </div>
        )}
      </div>
      <PriceEditor />
      <FolderRow
        label="Asset library folder"
        hint="Saved graphics, animations and sounds. Any drive works, including a synced one."
        value={settings.libraryFolder}
        onPick={() => void pick('libraryFolder', 'Choose the asset library folder')}
      />
      <FolderRow
        label="Default folder for new projects"
        value={settings.defaultProjectsFolder}
        onPick={() => void pick('defaultProjectsFolder', 'Where new project folders go')}
      />
      <FolderRow
        label="Default folder for exports"
        hint="Leave empty to export into each project's exports folder."
        value={settings.defaultExportsFolder}
        onPick={() => void pick('defaultExportsFolder', 'Where finished videos go')}
        onClear={() => void updateSettings({ defaultExportsFolder: '' })}
      />
      <div className="section col">
        <h3>Preview</h3>
        <span className="hint">A lower preview size updates faster after each change. Exports always use full quality.</span>
        <div className="row">
          <select value={settings.previewHeight} onChange={(e) => void updateSettings({ previewHeight: parseInt(e.target.value) })}>
            {[360, 540, 720].map((h) => (
              <option key={h} value={h}>
                {h}p
              </option>
            ))}
          </select>
          <select value={settings.previewFps} onChange={(e) => void updateSettings({ previewFps: parseFloat(e.target.value) })}>
            {[24, 30, 60].map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </div>
      </div>
    </>
  )
}

function Music() {
  const settings = useStore(app, (s) => s.settings)!
  const [tracks, setTracks] = useState<MusicTrack[] | null>(null)
  const [scanning, setScanning] = useState(false)
  useEffect(() => {
    void call(() => window.api.music.list()).then((t) => setTracks(t ?? []))
  }, [])
  const add = async () => {
    const dir = await call(() => window.api.app.pickFolder('Choose a music folder'))
    if (!dir) return
    setScanning(true)
    const folders = await call(() => window.api.music.addFolder(dir), 'Could not add the folder')
    setScanning(false)
    if (folders) {
      app.set({ settings: { ...settings, musicFolders: folders } })
      setTracks((await call(() => window.api.music.list())) ?? [])
    }
  }
  const rescan = async () => {
    setScanning(true)
    const t = await call(() => window.api.music.rescan(), 'Rescan failed')
    setScanning(false)
    if (t) {
      setTracks(t)
      const missing = t.filter((x) => x.missing).length
      toast(`Found ${t.length - missing} tracks${missing ? `; ${missing} missing` : ''}.`)
    }
  }
  const byFolder = useMemo(() => {
    const m = new Map<string, MusicTrack[]>()
    for (const t of tracks ?? []) {
      const l = m.get(t.folderId) ?? []
      l.push(t)
      m.set(t.folderId, l)
    }
    return m
  }, [tracks])
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <h1 className="grow">Music folders</h1>
        <button className="btn" onClick={rescan} disabled={scanning || !settings.musicFolders.length}>
          <Icon name="refresh" size={14} /> {scanning ? 'Scanning…' : 'Rescan'}
        </button>
        <button className="btn primary" onClick={add} disabled={scanning}>
          <Icon name="plus" size={14} /> Add folder
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        The app reads these folders and their subfolders. It never moves or changes your files. Subfolder names such as "upbeat" or
        "chill" are passed to Claude, so organising by mood helps it choose. Each profile picks which folders it may use.
      </p>
      {settings.musicFolders.length === 0 ? (
        <Empty title="No music folders yet">
          <p>Claude composes music in code by default. Add a folder if you want it to use your own tracks too.</p>
        </Empty>
      ) : (
        settings.musicFolders.map((f) => {
          const list = byFolder.get(f.id) ?? []
          const missing = list.filter((t) => t.missing)
          const subfolders = new Set(list.map((t) => t.folder).filter(Boolean))
          return (
            <div key={f.id} className="card pad col" style={{ marginBottom: 10 }}>
              <div className="row">
                <b className="grow">{f.name}</b>
                <button className="btn ghost small" onClick={() => void window.api.app.openPath(f.path)} title="Open folder">
                  <Icon name="folder" size={14} />
                </button>
                <button
                  className="btn ghost small danger"
                  onClick={async () => {
                    const folders = await call(() => window.api.music.removeFolder(f.id))
                    if (folders) app.set({ settings: { ...settings, musicFolders: folders } })
                    setTracks((await call(() => window.api.music.list())) ?? [])
                  }}
                >
                  Remove
                </button>
              </div>
              <code className="small muted">{f.path}</code>
              <div className="small">
                {tracks === null ? 'Counting…' : `${list.length - missing.length} tracks`}
                {subfolders.size > 0 && <span className="muted"> · {[...subfolders].slice(0, 8).join(', ')}{subfolders.size > 8 ? '…' : ''}</span>}
              </div>
              {missing.length > 0 && (
                <details>
                  <summary className="small warn" style={{ cursor: 'pointer' }}>
                    {missing.length} {missing.length === 1 ? 'file is' : 'files are'} missing since the last scan
                  </summary>
                  <div className="col small muted" style={{ gap: 2, marginTop: 6, maxHeight: 160, overflow: 'auto' }}>
                    {missing.map((t) => (
                      <code key={t.path}>{t.path}</code>
                    ))}
                  </div>
                </details>
              )}
              {list.length > 0 && (
                <details>
                  <summary className="small muted" style={{ cursor: 'pointer' }}>
                    Show tracks
                  </summary>
                  <div className="col small" style={{ gap: 2, marginTop: 6, maxHeight: 220, overflow: 'auto' }}>
                    {list.slice(0, 500).map((t) => (
                      <div key={t.path} className={`row ${t.missing ? 'warn' : ''}`}>
                        <span className="grow ellipsis">{t.folder ? `${t.folder} / ` : ''}{t.name}</span>
                        <span className="mono faint">{fmt(t.duration)}</span>
                        <span className="tag">{t.format}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )
        })
      )}
    </>
  )
}

function Claude() {
  const settings = useStore(app, (s) => s.settings)!
  const runner = settings.runner
  const [state, setState] = useState<RunnerState | null>(null)
  const [setup, setSetup] = useState<{ command: string; json: string; url: string } | null>(null)
  const [command, setCommand] = useState(runner.command)
  const [args, setArgs] = useState(runner.args.join('\n'))
  const [resumeArgs, setResumeArgs] = useState(runner.resumeArgs.join('\n'))
  const [tools, setTools] = useState(runner.allowedTools)
  const [port, setPort] = useState(String(settings.mcpPort))

  useEffect(() => {
    void call(() => window.api.claude.state()).then((s) => s && setState(s))
    return window.api.claude.onState(setState)
  }, [])

  const saveRunner = (patch: Partial<typeof runner>) => void updateSettings({ runner: { ...runner, ...patch } })
  const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean)

  const copySetup = async () => {
    const s = await call(() => window.api.settings.claudeSetup())
    if (!s) return
    setSetup(s)
    await call(() => window.api.app.copyText(s.json))
    toast('Connection settings copied. Paste them into your Claude MCP settings, or run the command shown.')
  }

  return (
    <>
      <h1 style={{ marginBottom: 8 }}>Claude connection</h1>
      <div className="section col">
        <h3>Status</h3>
        {state ? (
          <div className="row">
            <span className={`status-dot ${state.connected ? 'ok' : state.status === 'error' ? 'bad' : ''}`} />
            <span>
              {state.connected ? 'Claude is connected' : 'Claude is not connected'}
              {state.status === 'running' ? ' and working' : ''}
              {state.queue ? ` · ${state.queue} waiting in the queue` : ''}
            </span>
          </div>
        ) : (
          <Spinner />
        )}
        {state?.waitingReason && <div className="small warn">{state.waitingReason}</div>}
        <span className="hint">
          The app starts Claude Code in the background when you press Start edit, send a chat message or ask for a fix. It uses the
          Claude Code sign-in already on this PC. The app makes no AI calls of its own.
        </span>
      </div>
      <div className="section col">
        <h3>Command that starts Claude</h3>
        <span className="hint">Claude Code by default. Any AI tool with a command line and MCP support can replace it.</span>
        <div className="field-row">
          <label className="label">Command</label>
          <input type="text" className="mono" value={command} onChange={(e) => setCommand(e.target.value)} onBlur={() => command.trim() && command !== runner.command && saveRunner({ command: command.trim() })} />
        </div>
        <div className="field-row" style={{ alignItems: 'start' }}>
          <label className="label">Arguments, one per line</label>
          <textarea className="mono" rows={8} value={args} onChange={(e) => setArgs(e.target.value)} onBlur={() => saveRunner({ args: lines(args) })} />
        </div>
        <div className="field-row" style={{ alignItems: 'start' }}>
          <label className="label">Resume arguments</label>
          <textarea className="mono" rows={2} value={resumeArgs} onChange={(e) => setResumeArgs(e.target.value)} onBlur={() => saveRunner({ resumeArgs: lines(resumeArgs) })} />
        </div>
        <div className="field-row">
          <label className="label">Allowed tools</label>
          <input type="text" className="mono" value={tools} onChange={(e) => setTools(e.target.value)} onBlur={() => tools !== runner.allowedTools && saveRunner({ allowedTools: tools.trim() })} />
        </div>
        <span className="hint">
          Placeholders: <code>{'{prompt}'}</code> <code>{'{mcpConfig}'}</code> <code>{'{systemPrompt}'}</code> <code>{'{allowedTools}'}</code>{' '}
          <code>{'{sessionId}'}</code>
        </span>
        <Toggle checked={runner.autoStart} onChange={(v) => saveRunner({ autoStart: v })} label="Start Claude automatically when there is something to do" />
        <Toggle
          checked={runner.autoRetry !== false}
          onChange={(v) => saveRunner({ autoRetry: v })}
          label="Try again on its own when Claude's usage resets, credits run out, or the connection drops"
        />
        <div className="row">
          <button
            className="btn ghost"
            onClick={() => {
              const defaults = SettingsSchema.parse({}).runner
              setCommand(defaults.command)
              setArgs(defaults.args.join('\n'))
              setResumeArgs(defaults.resumeArgs.join('\n'))
              setTools(defaults.allowedTools)
              saveRunner({ command: defaults.command, args: defaults.args, resumeArgs: defaults.resumeArgs, allowedTools: defaults.allowedTools })
            }}
          >
            Reset to Claude Code defaults
          </button>
        </div>
      </div>
      <div className="section col">
        <h3>Connect by hand</h3>
        <span className="hint">
          You can also connect from Claude Code or the Claude desktop app yourself. Claude picks up any queued requests when it connects.
        </span>
        <div className="row">
          <label className="label">Local MCP port</label>
          <input type="number" style={{ width: 100 }} value={port} onChange={(e) => setPort(e.target.value)} onBlur={() => parseInt(port) !== settings.mcpPort && parseInt(port) > 1024 && void updateSettings({ mcpPort: parseInt(port) })} />
          <span className="spacer" />
          <button className="btn primary" onClick={copySetup}>
            <Icon name="copy" size={14} /> Copy setup
          </button>
        </div>
        {setup && (
          <div className="col">
            <div className="row">
              <span className="small muted grow">Command for Claude Code:</span>
              <CopyButton text={setup.command} />
            </div>
            <pre className="card pad mono small">{setup.command}</pre>
            <div className="row">
              <span className="small muted grow">MCP settings (JSON):</span>
              <CopyButton text={setup.json} />
            </div>
            <pre className="card pad mono small">{setup.json}</pre>
            <span className="hint">
              Server address: <code>{setup.url}</code>. It only accepts programs on this PC.
            </span>
          </div>
        )}
      </div>
    </>
  )
}

function Suggestions() {
  const [list, setList] = useState<Suggestion[] | null>(null)
  const load = useCallback(async () => setList((await call(() => window.api.profiles.suggestions())) ?? []), [])
  useEffect(() => {
    void load()
    return window.api.profiles.onSuggestion(() => void load())
  }, [load])
  const answer = async (s: Suggestion, accept: boolean) => {
    await call(() => window.api.profiles.answerSuggestion(s.profileId, s.kind, accept))
    if (accept) toast('Saved as a channel rule.')
    void load()
    void refreshProfiles()
  }
  return (
    <>
      <h1 style={{ marginBottom: 8 }}>Suggested rules</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        When you make the same kind of change on a few videos of one channel, the app suggests a rule. Nothing becomes a rule without your
        yes, and the app never changes a video by itself.
      </p>
      {list === null ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty title="No suggestions right now">
          <p>Keep editing. Repeated tweaks on a channel show up here.</p>
        </Empty>
      ) : (
        list.map((s) => (
          <div key={s.profileId + s.kind} className="list-row">
            <span className="chip">{profileById(s.profileId)?.name ?? 'Channel'}</span>
            <span className="grow">{s.text || CORRECTION_KINDS[s.kind as keyof typeof CORRECTION_KINDS] || s.kind}</span>
            <button className="btn primary small" onClick={() => void answer(s, true)}>
              Yes
            </button>
            <button className="btn small" onClick={() => void answer(s, false)}>
              No
            </button>
          </div>
        ))
      )}
    </>
  )
}

function About() {
  const info = useStore(app, (s) => s.info)
  return (
    <>
      <h1 style={{ marginBottom: 8 }}>About</h1>
      <div className="section col">
        <div className="row">
          <b>{info?.name ?? 'AI Video Editor'}</b>
          <span className="muted">version {info?.version}</span>
        </div>
        <UpdateButton />
        <span className="hint">
          Updates replace program files only. Your settings, profiles and projects are kept somewhere else and are never touched.
        </span>
      </div>
      <div className="section col">
        <h3>App log</h3>
        <span className="hint">Startup and update problems when no project is open. For a project, use Export log in the editor.</span>
        <div className="row">
          <button className="btn" onClick={() => void call(() => window.api.settings.openAppLog())}>
            <Icon name="log" size={14} /> Open app log
          </button>
          {info?.userDataPath && (
            <button className="btn ghost" onClick={() => void window.api.app.openPath(info.userDataPath)}>
              Open settings folder
            </button>
          )}
        </div>
      </div>
    </>
  )
}
