/**
 * Updates through GitHub Releases (electron-updater + the per-user NSIS installer).
 *
 * The button: click -> "Checking" -> "Up to date", or a new version downloads at once with a percentage,
 * then a dialog offers Restart now or Later. The quiet check at launch only shows a dot.
 * electron-updater verifies the installer's sha512 before it is ever run, so a bad or partial
 * download is never installed. Settings, profiles and projects live outside the install folder.
 *
 * The real autoUpdater is loaded lazily and can be swapped for a fake, so this file is unit-tested
 * without Electron (tests/updater.test.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { RELEASE_REPO } from '@shared/appInfo'
import type { UpdateState } from '@shared/ipc'
import type { AppContext, UpdaterService } from './context'
import { registerSecret } from './log'
import { paths } from './paths'

/** The part of electron-updater's AppUpdater this app uses. */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  logger: { info(m?: unknown): void; warn(m?: unknown): void; error(m?: unknown): void; debug?(m: string): void } | null
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo: UpdateInfoLike } | null>
  downloadUpdate(): Promise<string[]>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  setFeedURL(options: Record<string, unknown> | string): void
  on(event: string, listener: (...args: any[]) => void): unknown
  off(event: string, listener: (...args: any[]) => void): unknown
}

export interface UpdateInfoLike {
  version: string
  releaseNotes?: string | Array<{ version: string; note: string | null }> | null
  releaseName?: string | null
}

export interface UpdaterDeps {
  /** Returns the autoUpdater to drive. Defaults to electron-updater's, loaded on first use. */
  load?: () => Promise<UpdaterLike>
}

export const MESSAGES = {
  offline: "Can't reach the update server. Check your internet connection.",
  notFound: 'No update information was found on GitHub. Try again later.',
  damaged: 'The downloaded update was damaged, so it was not installed. Click Retry to download it again.',
  download: 'The download did not finish. Click Retry to try again.',
  disk: 'There is not enough free disk space to download the update.',
  dev: 'Updates work in the installed app only. This is a development build.',
  generic: 'The update check did not work. Click Retry to try again.',
  restartBlocked: 'An export is running. Restart when it finishes, or choose Later to update when you close the app.'
}

async function loadElectronUpdater(): Promise<UpdaterLike> {
  const mod = await import('electron-updater')
  return mod.autoUpdater as unknown as UpdaterLike
}

/** Release notes may be HTML text (GitHub) or a list of notes per version. The dialog shows plain text. */
export function releaseNotesText(notes: UpdateInfoLike['releaseNotes']): string {
  if (!notes) return ''
  if (Array.isArray(notes)) {
    return notes
      .map((n) => {
        const body = htmlToText(n.note ?? '')
        return body ? `${n.version}\n${body}` : n.version
      })
      .join('\n\n')
      .trim()
  }
  return htmlToText(String(notes))
}

function htmlToText(html: string): string {
  return html
    .replace(/\r\n/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(p|li|h[1-6]|ul|ol|div|pre|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A plain message for the window; the technical detail goes to the log. */
export function plainUpdateError(err: unknown, stage: 'check' | 'download' | 'install'): string {
  const text = `${(err as { code?: string })?.code ?? ''} ${err instanceof Error ? err.message : String(err)}`
  if (/sha512|checksum|mismatch|signature|not signed|integrity/i.test(text)) return MESSAGES.damaged
  if (/ENOSPC|disk full|not enough space/i.test(text)) return MESSAGES.disk
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|socket hang up|net::ERR_|getaddrinfo|network|timed? ?out|offline/i.test(text)) {
    return MESSAGES.offline
  }
  if (stage === 'download') return MESSAGES.download
  if (/\b404\b|Cannot find .*\.yml|No published versions|Unable to find latest version/i.test(text)) return MESSAGES.notFound
  return MESSAGES.generic
}

export function createUpdaterService(ctx: AppContext, deps: UpdaterDeps = {}): UpdaterService {
  const load = deps.load ?? loadElectronUpdater
  const listeners = new Set<(s: UpdateState) => void>()
  let state: UpdateState | null = null
  let updater: UpdaterLike | null = null
  let loading: Promise<UpdaterLike> | null = null
  /** The current check was started by a click (download at once) rather than the quiet launch check. */
  let interactive = false
  let lastMilestone = 0
  let busy: 'check' | 'download' | null = null
  let installing = false

  const current = (): UpdateState => {
    if (!state) state = { status: 'idle', currentVersion: ctx.appVersion, dot: false }
    return state
  }

  const set = (patch: Partial<UpdateState>): void => {
    state = { ...current(), ...patch }
    const s = state
    for (const cb of listeners) {
      try {
        cb(s)
      } catch {
        // a listener must not break the updater
      }
    }
    ctx.send('updates:state', s)
  }

  /** Every update event goes to the app log and to the open project's log. */
  const log = (msg: string, data?: unknown): void => {
    ctx.appLog.write('update', msg, data)
    try {
      ctx.projects.current()?.log.write('update', msg, data)
    } catch {
      // no project open
    }
  }

  const onChecking = (): void => log('Checking for updates', { currentVersion: ctx.appVersion, quiet: !interactive })

  const onAvailable = (info: UpdateInfoLike): void => {
    const notes = releaseNotesText(info.releaseNotes)
    log(`Update found: version ${info.version}`, { currentVersion: ctx.appVersion, quiet: !interactive })
    if (!interactive) {
      // Quiet launch check: a dot on the button, nothing downloaded until you click.
      busy = null
      set({ status: 'available', newVersion: info.version, releaseNotes: notes, dot: true, percent: undefined, error: undefined })
      return
    }
    lastMilestone = 0
    busy = 'download'
    set({ status: 'downloading', newVersion: info.version, releaseNotes: notes, percent: 0, dot: false, error: undefined })
    log(`Downloading version ${info.version}`)
    updater!.downloadUpdate().catch((err) => fail(err, 'download'))
  }

  const onNotAvailable = (info: UpdateInfoLike): void => {
    busy = null
    log('No update available', { currentVersion: ctx.appVersion, latest: info?.version })
    if (!interactive) return // the quiet check leaves the button as it was
    set({ status: 'up_to_date', percent: undefined, error: undefined, newVersion: undefined, releaseNotes: undefined, dot: false })
  }

  const onProgress = (p: { percent?: number; transferred?: number; total?: number; bytesPerSecond?: number }): void => {
    const percent = Math.max(0, Math.min(100, Math.floor(p.percent ?? 0)))
    const milestone = Math.floor(percent / 25) * 25
    if (milestone > lastMilestone) {
      lastMilestone = milestone
      log(`Download ${milestone}%`, { transferred: p.transferred, total: p.total })
    }
    if (current().status === 'downloading' && percent !== current().percent) set({ percent })
  }

  const onDownloaded = (info: UpdateInfoLike): void => {
    busy = null
    const notes = releaseNotesText(info.releaseNotes) || current().releaseNotes || ''
    log(`Update downloaded: version ${info.version} (checksum verified)`)
    set({ status: 'downloaded', newVersion: info.version, releaseNotes: notes, percent: 100, dot: false, error: undefined, restartBlockedReason: undefined })
  }

  const onError = (err: unknown): void => {
    if (!installing && busy === null) return // already reported through the rejected promise
    fail(err, installing ? 'install' : busy === 'download' ? 'download' : 'check')
  }

  function fail(err: unknown, stage: 'check' | 'download' | 'install'): void {
    // electron-updater both emits "error" and rejects the promise: report once.
    if (stage === 'install' ? !installing : busy === null) return
    busy = null
    installing = false
    const message = plainUpdateError(err, stage)
    log(`Update ${stage} failed`, { message, detail: err instanceof Error ? err.message : String(err) })
    if (!interactive && stage === 'check') {
      // Quiet launch check: nothing shows on the button; the next click tries again.
      return
    }
    set({ status: 'error', error: message, percent: undefined })
  }

  async function ensure(): Promise<UpdaterLike> {
    if (updater) return updater
    if (!loading) {
      loading = (async () => {
        const u = await load()
        u.autoDownload = false
        u.autoInstallOnAppQuit = false
        u.logger = {
          info: (m?: unknown) => ctx.appLog.write('update', String(m)),
          warn: (m?: unknown) => ctx.appLog.write('update', String(m)),
          error: (m?: unknown) => ctx.appLog.write('update', String(m))
        }
        const feed = process.env.AVE_UPDATE_FEED_URL
        if (feed) {
          u.setFeedURL({ provider: 'generic', url: feed })
        } else {
          // Releases are read from a public repository with no token. A token saved in Settings
          // (fully private setup) is used when present and is never logged.
          const token = ctx.secrets.get('githubToken')
          if (token) {
            registerSecret(token)
            u.setFeedURL({ provider: 'github', owner: RELEASE_REPO.owner, repo: RELEASE_REPO.repo, private: true, token })
          }
        }
        u.on('checking-for-update', onChecking)
        u.on('update-available', onAvailable)
        u.on('update-not-available', onNotAvailable)
        u.on('download-progress', onProgress)
        u.on('update-downloaded', onDownloaded)
        u.on('error', onError)
        updater = u
        return u
      })()
    }
    return loading
  }

  return {
    state: current,

    onState(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },

    async check(opts = {}) {
      const quiet = !!opts.quiet
      const s = current().status
      // Already downloaded: a click shows the existing state (and the dialog) again.
      if (s === 'downloaded' || s === 'restart_pending' || installing) {
        if (!quiet) set({})
        return
      }
      if (busy === 'download') return
      if (busy === 'check') {
        // A click during the quiet launch check turns it into a normal check.
        if (!quiet && !interactive) {
          interactive = true
          set({ status: 'checking', error: undefined, percent: undefined })
        }
        return
      }
      interactive = !quiet
      busy = 'check'
      if (!quiet) set({ status: 'checking', error: undefined, percent: undefined, restartBlockedReason: undefined })
      let u: UpdaterLike
      try {
        u = await ensure()
      } catch (err) {
        fail(err, 'check')
        return
      }
      try {
        const result = await u.checkForUpdates()
        if (result === null && busy === 'check') {
          // electron-updater skips the check outside the installed app.
          busy = null
          log('Update check skipped: not an installed build')
          if (!quiet) set({ status: 'error', error: MESSAGES.dev })
        }
      } catch (err) {
        fail(err, 'check')
      }
    },

    async restartNow() {
      const s = current()
      if (s.status !== 'downloaded' && s.status !== 'restart_pending') return
      if (ctx.renders.isBusy()) {
        log('Restart blocked: an export is running')
        set({ restartBlockedReason: MESSAGES.restartBlocked })
        return
      }
      const store = ctx.projects.current()
      try {
        store?.flush()
      } catch (err) {
        log('Could not save the open project before installing', { error: err instanceof Error ? err.message : String(err) })
      }
      // The app reads this after relaunch and reopens the project you were in.
      const reopen = {
        projectPath: store?.dir ?? null,
        fromVersion: ctx.appVersion,
        toVersion: s.newVersion ?? null,
        at: new Date().toISOString()
      }
      try {
        mkdirSync(dirname(paths.pendingUpdateFile), { recursive: true })
        writeFileSync(paths.pendingUpdateFile, JSON.stringify(reopen, null, 2))
      } catch (err) {
        log('Could not write the reopen file', { error: err instanceof Error ? err.message : String(err) })
      }
      log(`Installing version ${s.newVersion ?? ''} and restarting`, { reopenProject: reopen.projectPath })
      installing = true
      try {
        const u = await ensure()
        u.quitAndInstall(true, true)
      } catch (err) {
        fail(err, 'install')
      }
    },

    later() {
      const s = current()
      if (s.status !== 'downloaded' && s.status !== 'restart_pending') return
      if (updater) updater.autoInstallOnAppQuit = true
      log(`Version ${s.newVersion ?? ''} will install when the app closes`)
      set({ status: 'restart_pending', restartBlockedReason: undefined })
    }
  }
}

/**
 * CI: `--update-self-test`. No window. Checks the configured feed (AVE_UPDATE_FEED_URL), downloads,
 * writes a JSON result (AVE_UPDATE_TEST_RESULT) after each stage, then installs silently and exits.
 */
export async function runUpdateSelfTest(
  ctx: AppContext,
  deps: UpdaterDeps & { exit?: (code: number) => void } = {}
): Promise<void> {
  const resultFile = process.env.AVE_UPDATE_TEST_RESULT
  const exit = deps.exit ?? ((code: number) => {
    void import('electron').then((e) => e.app.exit(code))
  })
  const result: Record<string, unknown> = { currentVersion: ctx.appVersion, stages: [] as string[] }
  const write = (stage: string, extra: Record<string, unknown> = {}): void => {
    ;(result.stages as string[]).push(stage)
    Object.assign(result, extra, { stage, at: new Date().toISOString() })
    ctx.appLog.write('update', `Update self-test: ${stage}`, extra)
    if (!resultFile) return
    try {
      mkdirSync(dirname(resultFile), { recursive: true })
      writeFileSync(resultFile, JSON.stringify(result, null, 2))
    } catch {
      // the test harness reports a missing file itself
    }
  }

  try {
    write('start', { feed: process.env.AVE_UPDATE_FEED_URL ?? null })
    const u = await (deps.load ?? loadElectronUpdater)()
    u.autoDownload = false
    u.autoInstallOnAppQuit = false
    u.logger = {
      info: (m?: unknown) => ctx.appLog.write('update', String(m)),
      warn: (m?: unknown) => ctx.appLog.write('update', String(m)),
      error: (m?: unknown) => ctx.appLog.write('update', String(m))
    }
    if (process.env.AVE_UPDATE_FEED_URL) u.setFeedURL({ provider: 'generic', url: process.env.AVE_UPDATE_FEED_URL })
    let progress = 0
    u.on('download-progress', (p: { percent?: number }) => {
      const pct = Math.floor(p.percent ?? 0)
      if (pct >= progress + 25) {
        progress = pct - (pct % 25)
        write('downloading', { percent: progress })
      }
    })

    const check = await u.checkForUpdates()
    if (!check) throw new Error('Update check was skipped (not an installed build)')
    const newVersion = check.updateInfo.version
    const available = check.isUpdateAvailable ?? newVersion !== ctx.appVersion
    write('checked', { newVersion, available })
    if (!available) throw new Error(`No newer version on the feed (feed has ${newVersion}, app is ${ctx.appVersion})`)

    const files = await u.downloadUpdate()
    write('downloaded', { newVersion, files })

    write('installing', { newVersion })
    u.quitAndInstall(true, false)
    // quitAndInstall quits the app; make sure the process ends even without windows.
    setTimeout(() => exit(0), 3000).unref?.()
  } catch (err) {
    write('error', { error: err instanceof Error ? err.message : String(err) })
    exit(1)
  }
}
