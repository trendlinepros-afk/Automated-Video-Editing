/**
 * First launch: graphics card check, the one-time Python environment install, the asset library folder,
 * an optional Pikzels key, and whether Claude Code is installed.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { SetupProgress, SetupStatus } from '@shared/ipc'
import { app, call, refreshSettings, toast, updateSettings } from '../state/app'
import { useStore } from '../state/store'
import { AppTopBar } from '../components/AppTopBar'
import { Spinner } from '../components/bits'

const CLAUDE_URL = 'https://code.claude.com/docs/en/setup'

export function SetupScreen() {
  const settings = useStore(app, (s) => s.settings)
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [progress, setProgress] = useState<SetupProgress | null>(null)
  const [installing, setInstalling] = useState(false)
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)

  const load = useCallback(async () => {
    const s = await call(() => window.api.setup.status())
    if (s) {
      setStatus(s)
      if (s.python.installing) setInstalling(true)
    }
    setHasKey((await call(() => window.api.settings.hasPikzelsKey())) ?? false)
  }, [])

  useEffect(() => {
    void load()
    return window.api.setup.onProgress((p) => {
      setProgress(p)
      if (p.done || p.error) {
        setInstalling(false)
        void load()
      }
    })
  }, [load])

  const install = async () => {
    setInstalling(true)
    setProgress({ step: 'start', message: 'Starting…', percent: 0 })
    const ok = await call(() => window.api.setup.installEnvironment(), 'The install stopped')
    if (ok === undefined) setInstalling(false)
    void load()
  }

  const pickLibrary = async () => {
    const dir = await call(() => window.api.app.pickFolder('Choose a folder for your asset library', settings?.libraryFolder || undefined))
    if (dir) {
      await updateSettings({ libraryFolder: dir, libraryFolderConfirmed: true })
      void load()
    }
  }

  const saveKey = async () => {
    if (!key.trim()) return
    await call(() => window.api.settings.setPikzelsKey(key.trim()))
    setKey('')
    setHasKey(true)
    toast('Pikzels key saved with Windows credential protection.')
  }

  const finish = async () => {
    await updateSettings({ setupDone: true })
    await refreshSettings()
    app.set({ screen: 'home' })
  }

  const libraryOk = !!(status?.libraryFolder.ok || settings?.libraryFolder)
  const ready = !!status?.python.ok && libraryOk

  return (
    <>
      <AppTopBar />
      <div className="screen">
        <div className="setup">
          <div>
            <h1>Welcome. Let's get this PC ready.</h1>
            <p className="muted">This happens once. Updates to the app never repeat it.</p>
          </div>
          {!status ? (
            <Spinner label="Checking this PC…" />
          ) : (
            <>
              <Step n={1} done={status.gpu.ok} title="Graphics card">
                <div className={status.gpu.ok ? '' : 'warn'}>{status.gpu.message}</div>
                {status.gpu.name && (
                  <div className="small muted">
                    {status.gpu.name}
                    {status.gpu.driver ? ` · driver ${status.gpu.driver}` : ''}
                  </div>
                )}
                {!status.gpu.ok && (
                  <div className="hint">
                    The preview and exports are rendered on an NVIDIA graphics card. Without one, the app can open projects but
                    cannot render them.
                  </div>
                )}
              </Step>

              <Step n={2} done={status.python.ok && status.ffmpeg.ok} title="Rendering tools (Python, PyTorch, ffmpeg)">
                <div>{status.python.message}</div>
                <div className="small muted">{status.ffmpeg.message}{status.ffmpeg.ok && !status.ffmpeg.nvenc ? ' (no NVIDIA encoder found)' : ''}</div>
                {installing && progress && (
                  <div className="col" style={{ gap: 4 }}>
                    <div className="row small">
                      <span className="spinner" />
                      <span className="grow ellipsis">{progress.message}</span>
                      {progress.percent !== undefined && <span className="mono">{Math.round(progress.percent)}%</span>}
                    </div>
                    <div className="progress">
                      <div style={{ width: `${progress.percent ?? 0}%` }} />
                    </div>
                  </div>
                )}
                {!installing && progress?.error && <div className="bad small">{progress.error}</div>}
                {!status.python.ok && !installing && (
                  <div>
                    <button className="btn primary" onClick={install}>
                      {progress?.error ? 'Try the install again' : 'Install (about 4 GB, one time)'}
                    </button>
                  </div>
                )}
                {status.python.ok && status.python.details && (
                  <div className="small faint">
                    {Object.entries(status.python.details)
                      .map(([k, v]) => `${k} ${v}`)
                      .join(' · ')}
                  </div>
                )}
              </Step>

              <Step n={3} done={libraryOk} title="Asset library folder">
                <div className="muted">
                  Graphics and sounds Claude makes are saved here and reused, so nothing is made twice. Any drive works,
                  including a synced one.
                </div>
                <div className="row">
                  <code className="grow ellipsis">{settings?.libraryFolder || status.libraryFolder.path || 'Not chosen yet'}</code>
                  <button className="btn" onClick={pickLibrary}>
                    Choose folder
                  </button>
                </div>
              </Step>

              <Step n={4} done={hasKey} title="Pikzels API key (optional)">
                <div className="muted">Used only for thumbnails. You can add it later in Settings.</div>
                {hasKey ? (
                  <div className="ok small">Key saved.</div>
                ) : (
                  <div className="row">
                    <input type="password" className="grow" placeholder="Paste your Pikzels API key" value={key} onChange={(e) => setKey(e.target.value)} />
                    <button className="btn" disabled={!key.trim()} onClick={saveKey}>
                      Save key
                    </button>
                  </div>
                )}
              </Step>

              <Step n={5} done={status.claude.ok} title="Claude Code">
                <div className={status.claude.ok ? '' : 'warn'}>{status.claude.message}</div>
                {!status.claude.ok && (
                  <ol className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                    <li>Install Claude Code (see the link below).</li>
                    <li>Open a terminal and run <code>claude</code> once to sign in.</li>
                    <li>Come back here and press Check again.</li>
                  </ol>
                )}
                <div className="row">
                  {!status.claude.ok && (
                    <button className="btn" onClick={() => void window.api.app.openExternal(CLAUDE_URL)}>
                      How to install Claude Code
                    </button>
                  )}
                  <button className="btn ghost" onClick={() => void load()}>
                    Check again
                  </button>
                </div>
              </Step>

              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
                {!ready && <span className="small muted">You can finish the missing steps later in Settings.</span>}
                <button className={`btn${ready ? ' primary' : ''}`} onClick={finish} disabled={installing}>
                  {ready ? 'Done, go to my projects' : 'Continue anyway'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}

function Step(props: { n: number; done: boolean; title: string; children: ReactNode }) {
  return (
    <div className={`card setup-step${props.done ? ' done' : ''}`}>
      <div className="num">{props.done ? '✓' : props.n}</div>
      <div className="col">
        <h3>{props.title}</h3>
        {props.children}
      </div>
    </div>
  )
}
