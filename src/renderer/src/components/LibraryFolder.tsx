/**
 * Where the asset library lives. The app asks once at start until the owner has chosen (or kept) a folder,
 * and changing it later in Settings asks whether to move the saved assets along.
 */
import { useState } from 'react'
import { app, call, refreshSettings, toast } from '../state/app'
import { createStore, useStore } from '../state/store'
import { Modal } from './Modal'

const move = createStore<{ pending: { dest: string; count: number } | null }>({ pending: null })

/** Pick a new library folder; if the current one holds assets, ask whether to move them. */
export async function changeLibraryFolder(): Promise<boolean> {
  const current = app.get().settings?.libraryFolder || undefined
  const dest = await call(() => window.api.app.pickFolder('Where should the asset library be kept?', current))
  if (!dest || dest === current) return false
  const count = current ? ((await call(() => window.api.library.list())) ?? []).length : 0
  if (count) {
    move.set({ pending: { dest, count } })
    return true
  }
  await finish(dest, false)
  return true
}

async function finish(dest: string, doMove: boolean): Promise<void> {
  const r = await call(() => window.api.library.changeFolder(dest, doMove))
  move.set({ pending: null })
  await refreshSettings()
  if (!r) return
  toast(
    doMove
      ? `Asset library moved to ${dest}: ${r.moved} asset${r.moved === 1 ? '' : 's'} moved${r.skipped ? `, ${r.skipped} already there kept as they were` : ''}.`
      : `The asset library is now ${dest}. The assets in the old folder stay there.`
  )
}

/** "Move the assets too?" after choosing a new folder. */
export function MoveAssetsPrompt() {
  const m = useStore(move, (s) => s.pending)
  const [busy, setBusy] = useState(false)
  if (!m) return null
  const go = async (doMove: boolean) => {
    setBusy(true)
    await finish(m.dest, doMove)
    setBusy(false)
  }
  return (
    <Modal
      title="Move your assets too?"
      onClose={() => !busy && move.set({ pending: null })}
      footer={
        <>
          <button className="btn" disabled={busy} onClick={() => move.set({ pending: null })}>
            Cancel
          </button>
          <button className="btn" disabled={busy} onClick={() => void go(false)}>
            Leave them where they are
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void go(true)}>
            {busy ? 'Moving…' : `Move ${m.count} asset${m.count === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      <p>
        The current library holds {m.count} saved asset{m.count === 1 ? '' : 's'} (graphics, animations, music and sounds). Move them to{' '}
        <code className="selectable">{m.dest}</code>?
      </p>
      <p className="muted small">
        Moving keeps everything in one place. If you leave them, the new folder starts with only the starter assets, and the old ones
        stay in the old folder (you can switch back to it any time). Projects keep working either way: each video has its own copy of
        what it uses.
      </p>
    </Modal>
  )
}

/** Asked once at start: keep the library where it is, or choose another folder. */
export function LibraryFolderPrompt() {
  const settings = useStore(app, (s) => s.settings)
  const screen = useStore(app, (s) => s.screen)
  const pendingMove = useStore(move, (s) => s.pending)
  const [dismissed, setDismissed] = useState(false)
  if (!settings || settings.libraryFolderConfirmed || dismissed || pendingMove || screen === 'setup') return null
  const keep = async () => {
    await call(() => window.api.settings.update({ libraryFolderConfirmed: true }))
    await refreshSettings()
  }
  return (
    <Modal
      title="Where should your asset library be kept?"
      onClose={() => setDismissed(true)}
      footer={
        <>
          <button className="btn" onClick={() => void changeLibraryFolder()}>
            Choose another folder…
          </button>
          <button className="btn primary" disabled={!settings.libraryFolder} onClick={() => void keep()}>
            Keep it here
          </button>
        </>
      }
    >
      <p>
        Every graphic, animation, song and sound effect Claude makes is saved to your asset library, so later videos can reuse the ones
        that fit. Choose where it lives: any drive works, including a synced folder.
      </p>
      <p>
        {settings.libraryFolder ? (
          <>
            Right now it is <code className="selectable">{settings.libraryFolder}</code>
          </>
        ) : (
          'No folder is set yet.'
        )}
      </p>
      <p className="muted small">You can change it later in Settings &gt; General, and the app offers to move the assets with it.</p>
    </Modal>
  )
}
