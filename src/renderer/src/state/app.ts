/**
 * App-wide state: which screen is showing, app info, updates, settings, profiles, toasts and the context menu.
 */
import type { AppInfo, ProjectSnapshot, Suggestion, UpdateState } from '@shared/ipc'
import type { Profile, Settings } from '@shared/settings'
import { CORRECTION_KINDS } from '@shared/settings'
import { errorMessage } from '../util'
import { createStore } from './store'
import { editor, openSnapshot } from './editor'

export type Screen = 'loading' | 'setup' | 'home' | 'editor' | 'settings' | 'library' | 'personas'
export type SettingsSection = 'general' | 'music' | 'claude' | 'profiles' | 'suggestions' | 'about'

export interface ToastAction {
  label: string
  run: () => void
  primary?: boolean
}

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
  actions?: ToastAction[]
  sticky?: boolean
}

export interface MenuEntry {
  label: string
  run: () => void
  disabled?: boolean
  separator?: boolean
}

export interface AppState {
  screen: Screen
  /** Where "Back" goes from Settings, Library and Personas & Styles. */
  returnTo: Screen
  settingsSection: SettingsSection
  settingsProfileId: string | null
  info: AppInfo | null
  update: UpdateState | null
  /** The update dialog is open (new version downloaded, or "Restart to update" clicked). */
  updateDialog: boolean
  settings: Settings | null
  profiles: Profile[]
  toasts: Toast[]
  menu: { x: number; y: number; entries: MenuEntry[] } | null
}

export const app = createStore<AppState>({
  screen: 'loading',
  returnTo: 'home',
  settingsSection: 'general',
  settingsProfileId: null,
  info: null,
  update: null,
  updateDialog: false,
  settings: null,
  profiles: [],
  toasts: [],
  menu: null
})

let toastSeq = 0

export function toast(text: string, opts: { kind?: 'info' | 'error'; actions?: ToastAction[]; sticky?: boolean; ms?: number } = {}): number {
  const id = ++toastSeq
  const t: Toast = { id, text, kind: opts.kind ?? 'info', actions: opts.actions, sticky: opts.sticky }
  app.set((s) => ({ toasts: [...s.toasts.slice(-3), t] }))
  if (!opts.sticky) setTimeout(() => dismissToast(id), opts.ms ?? (opts.actions?.length ? 9000 : 4500))
  return id
}

export function dismissToast(id: number): void {
  app.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

/** Runs an app call and shows a plain message if it fails. Resolves to undefined on failure. */
export async function call<T>(fn: () => Promise<T>, failPrefix?: string): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    const msg = errorMessage(e)
    toast(failPrefix ? `${failPrefix}: ${msg}` : msg, { kind: 'error' })
    return undefined
  }
}

export function openMenu(e: { clientX: number; clientY: number; preventDefault(): void }, entries: MenuEntry[]): void {
  e.preventDefault()
  app.set({ menu: { x: e.clientX, y: e.clientY, entries } })
}

export function go(screen: Screen): void {
  const cur = app.get().screen
  if (screen === 'settings' || screen === 'library' || screen === 'personas') {
    const returnTo = cur === 'settings' || cur === 'library' || cur === 'personas' ? app.get().returnTo : cur
    app.set({ screen, returnTo: returnTo === 'loading' || returnTo === 'setup' ? 'home' : returnTo })
  } else {
    app.set({ screen })
  }
}

export function goBack(): void {
  const back = app.get().returnTo
  app.set({ screen: back === 'editor' && !editor.get().snapshot ? 'home' : back })
}

export function openSettings(section: SettingsSection, profileId?: string): void {
  app.set({ settingsSection: section, settingsProfileId: profileId ?? app.get().settingsProfileId })
  go('settings')
}

export async function refreshSettings(): Promise<void> {
  const settings = await call(() => window.api.settings.get())
  if (settings) app.set({ settings })
}

export async function refreshProfiles(): Promise<Profile[]> {
  const profiles = await call(() => window.api.profiles.list())
  if (profiles) app.set({ profiles })
  return profiles ?? app.get().profiles
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const settings = await call(() => window.api.settings.update(patch), 'Could not save settings')
  if (settings) app.set({ settings })
}

export function profileById(id: string | undefined): Profile | undefined {
  return app.get().profiles.find((p) => p.id === id)
}

/** Opens a project snapshot in the editor. */
export function enterEditor(snapshot: ProjectSnapshot): void {
  openSnapshot(snapshot)
  app.set({ screen: 'editor' })
}

export async function leaveEditor(): Promise<void> {
  await call(() => window.api.projects.close())
  openSnapshot(null)
  app.set({ screen: 'home' })
}

function suggestionToast(s: Suggestion): void {
  const text = s.text || CORRECTION_KINDS[s.kind as keyof typeof CORRECTION_KINDS] || s.kind
  const profile = profileById(s.profileId)
  const id = toast(profile ? `${profile.name}: ${text}` : text, {
    sticky: true,
    actions: [
      { label: 'Yes', primary: true, run: () => answer(true) },
      { label: 'No', run: () => answer(false) }
    ]
  })
  function answer(accept: boolean) {
    dismissToast(id)
    void call(() => window.api.profiles.answerSuggestion(s.profileId, s.kind, accept)).then(() => {
      if (accept) toast('Saved as a channel rule. Claude follows it from the next edit.')
      void refreshProfiles()
    })
  }
}

let started = false

/** Loads everything the window needs and subscribes to app events. */
export async function startApp(): Promise<void> {
  if (started) return
  started = true
  const api = window.api
  api.updates.onState((u) => {
    const prev = app.get().update
    const openDialog = u.status === 'downloaded' && (prev?.status !== 'downloaded' || prev?.newVersion !== u.newVersion)
    app.set({ update: u, updateDialog: openDialog ? true : app.get().updateDialog && u.status === 'downloaded' })
  })
  api.profiles.onSuggestion(suggestionToast)
  api.app.onMenu((cmd) => handleMenuCommand(cmd))

  const [info, update, settings, profiles] = await Promise.all([
    call(() => api.app.info()),
    call(() => api.updates.state()),
    call(() => api.settings.get()),
    call(() => api.profiles.list())
  ])
  app.set({ info: info ?? null, update: update ?? null, settings: settings ?? null, profiles: profiles ?? [] })
  if (update?.status === 'downloaded') app.set({ updateDialog: true })

  if (settings && !settings.setupDone) {
    app.set({ screen: 'setup' })
    return
  }
  // After "Restart now" the app reopens the project you were in.
  const snap = await call(() => api.project.get())
  if (snap) enterEditor(snap)
  else app.set({ screen: 'home' })
}

/** Commands from the native menu (if the main process sends any). */
export function handleMenuCommand(cmd: string): void {
  const inEditor = app.get().screen === 'editor'
  switch (cmd) {
    case 'undo':
      if (inEditor) void editorUndo()
      break
    case 'redo':
      if (inEditor) void editorRedo()
      break
    case 'settings':
      go('settings')
      break
    case 'library':
      go('library')
      break
    case 'home':
      if (inEditor) void leaveEditor()
      else app.set({ screen: 'home' })
      break
    case 'check-updates':
      void call(() => window.api.updates.check())
      break
    case 'export':
      if (inEditor) editor.set({ dialog: { kind: 'export' } })
      break
    case 'export-log':
      if (inEditor) editor.set({ dialog: { kind: 'exportLog' } })
      break
  }
}

async function editorUndo() {
  const snap = await call(() => window.api.project.undo())
  if (snap) editor.set({ snapshot: snap })
}

async function editorRedo() {
  const snap = await call(() => window.api.project.redo())
  if (snap) editor.set({ snapshot: snap })
}
