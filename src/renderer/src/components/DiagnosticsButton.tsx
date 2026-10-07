/** The log icon at the top right: one click saves a diagnostics zip (logs, system info, settings; keys removed). */
import { useState } from 'react'
import { call, toast } from '../state/app'
import { Icon } from './Icon'

export function DiagnosticsButton() {
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    const path = await call(() => window.api.app.saveDiagnostics(), 'Could not save the diagnostics zip')
    setBusy(false)
    if (path) {
      toast(`Saved ${path.split(/[\\/]/).pop()} to your Downloads folder. Send it to Claude when something goes wrong. API keys are not in it.`, {
        actions: [{ label: 'Show file', run: () => void window.api.app.showItemInFolder(path) }]
      })
    }
  }
  return (
    <button
      className="btn ghost small icon"
      disabled={busy}
      onClick={() => void save()}
      title="Save a diagnostics zip to Downloads: app and project logs, Claude's last output, system and setup info. API keys are removed. Send it when something goes wrong."
    >
      {busy ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <Icon name="log" size={15} />}
    </button>
  )
}
