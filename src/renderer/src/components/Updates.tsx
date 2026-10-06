/**
 * "Check for updates" sits in the top bar on every screen, next to the version number.
 * Its label follows the updater: Checking / Up to date / NN% / Restart to update / error with Retry.
 */
import { app, call } from '../state/app'
import { useStore } from '../state/store'
import { Modal } from './Modal'

export function UpdateButton() {
  const u = useStore(app, (s) => s.update)
  const info = useStore(app, (s) => s.info)
  const version = u?.currentVersion ?? info?.version ?? ''
  const check = () => void call(() => window.api.updates.check(), 'Could not check for updates')
  let label = 'Check for updates'
  let title = 'Look for a new version of the app'
  let onClick: () => void = check
  let busy = false
  let primary = false
  switch (u?.status) {
    case 'checking':
      label = 'Checking…'
      busy = true
      break
    case 'up_to_date':
      label = `Up to date v${u.currentVersion}`
      title = 'You have the newest version. Click to check again.'
      break
    case 'available':
      // Found by the quiet check at launch: only a small dot, nothing downloaded until you click.
      title = `Version ${u.newVersion ?? ''} is out. Click to download it.`
      break
    case 'downloading':
      label = `Downloading ${Math.round(u.percent ?? 0)}%`
      busy = true
      break
    case 'downloaded':
    case 'restart_pending':
      label = 'Restart to update'
      title = `Version ${u.newVersion ?? ''} is ready. It also installs the next time you close the app.`
      primary = true
      onClick = () => app.set({ updateDialog: true })
      break
  }
  return (
    <div className="row" style={{ gap: 6 }}>
      {u?.status === 'error' ? (
        <>
          <span className="small bad ellipsis" style={{ maxWidth: 260 }} title={u.error}>
            {u.error || 'Could not check for updates'}
          </span>
          <button className="btn small" onClick={check}>
            Retry
          </button>
        </>
      ) : (
        <button className={`btn small update-btn${primary ? ' primary' : ''}`} disabled={busy} onClick={onClick} title={title}>
          {busy && <span className="spinner" style={{ width: 11, height: 11 }} />}
          {label}
          {(u?.dot || u?.status === 'available') && !primary && <span className="badge-dot" />}
        </button>
      )}
      {version && <span className="version">v{version}</span>}
    </div>
  )
}

export function UpdateDialog() {
  const open = useStore(app, (s) => s.updateDialog)
  const u = useStore(app, (s) => s.update)
  if (!open || !u || (u.status !== 'downloaded' && u.status !== 'restart_pending')) return null
  const close = () => app.set({ updateDialog: false })
  const later = async () => {
    close()
    await call(() => window.api.updates.later())
  }
  const blocked = u.restartBlockedReason
  return (
    <Modal
      title={`Version ${u.newVersion ?? ''} is ready`}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={later}>
            Later
          </button>
          {!blocked && (
            <button className="btn primary" onClick={() => void call(() => window.api.updates.restartNow())}>
              Restart now
            </button>
          )}
        </>
      }
    >
      <div className="muted">
        You have v{u.currentVersion}. Restart now saves your open project, installs the update and reopens where you were.
        Later installs it the next time you close the app.
      </div>
      {blocked && <div className="banner" style={{ borderRadius: 6 }}>{blocked} Restart now is not available until it finishes.</div>}
      {u.releaseNotes ? (
        <div className="card pad" style={{ maxHeight: 280, overflow: 'auto' }}>
          <h4 style={{ marginBottom: 6 }}>What's new</h4>
          <pre className="small">{stripHtml(u.releaseNotes)}</pre>
        </div>
      ) : null}
    </Modal>
  )
}

/** Release notes from GitHub may arrive as HTML; show them as plain text. */
function stripHtml(s: string): string {
  if (!/<[a-z][\s\S]*>/i.test(s)) return s
  const doc = new DOMParser().parseFromString(s.replace(/<li>/gi, '<li>• ').replace(/<\/(p|li|h\d)>/gi, '\n'), 'text/html')
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}
