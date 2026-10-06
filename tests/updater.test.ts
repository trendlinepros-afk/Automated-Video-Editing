import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APP_ID, APP_NAME, RELEASE_REPO } from '@shared/appInfo'
import type { UpdateState } from '@shared/ipc'
import type { AppContext } from '../src/main/context'
import { ActivityLog, registerSecret } from '../src/main/log'
import { initPaths, paths } from '../src/main/paths'
import {
  MESSAGES,
  createUpdaterService,
  releaseNotesText,
  runUpdateSelfTest,
  type UpdateInfoLike,
  type UpdaterLike
} from '../src/main/updater'

/** A stand-in for electron-updater's autoUpdater, driven by the test. */
class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true
  autoInstallOnAppQuit = true
  logger: UpdaterLike['logger'] = null
  feed: unknown = null
  checks = 0
  downloads = 0
  installs: [boolean | undefined, boolean | undefined][] = []
  /** What the next check finds: a version, nothing new, or an error. */
  next: { version?: string; notes?: UpdateInfoLike['releaseNotes']; error?: Error } = {}
  downloadError: Error | null = null
  manualDownload = false
  private finishDownload: (() => void) | null = null

  setFeedURL(options: unknown): void {
    this.feed = options
  }

  async checkForUpdates() {
    this.checks++
    this.emit('checking-for-update')
    await Promise.resolve()
    if (this.next.error) {
      this.emit('error', this.next.error)
      throw this.next.error
    }
    const info: UpdateInfoLike = { version: this.next.version ?? '1.0.0', releaseNotes: this.next.notes }
    const isUpdateAvailable = !!this.next.version
    this.emit(isUpdateAvailable ? 'update-available' : 'update-not-available', info)
    return { isUpdateAvailable, updateInfo: info }
  }

  async downloadUpdate(): Promise<string[]> {
    this.downloads++
    const info: UpdateInfoLike = { version: this.next.version!, releaseNotes: this.next.notes }
    for (const percent of [10, 30, 55, 80]) this.emit('download-progress', { percent, transferred: percent, total: 100 })
    if (this.manualDownload) await new Promise<void>((r) => (this.finishDownload = r))
    await Promise.resolve()
    if (this.downloadError) {
      this.emit('error', this.downloadError)
      throw this.downloadError
    }
    this.emit('download-progress', { percent: 100, transferred: 100, total: 100 })
    this.emit('update-downloaded', { ...info, downloadedFile: 'C:\\fake\\setup.exe' })
    return ['C:\\fake\\setup.exe']
  }

  release(): void {
    this.finishDownload?.()
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter])
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

let dir: string
let fake: FakeUpdater
let appLog: ActivityLog
let projectLog: ActivityLog
let exporting: boolean
let flushed: number
let sent: { channel: string; payload: unknown }[]
let secrets: Record<string, string | null>

function makeCtx(opts: { project?: boolean } = {}): AppContext {
  const store = opts.project === false ? null : { dir: join(dir, 'My Project'), log: projectLog, flush: () => flushed++ }
  return {
    appVersion: '1.0.0',
    isPackaged: true,
    appLog,
    projects: { current: () => store },
    renders: { isBusy: () => exporting },
    preview: { isBusy: () => true },
    secrets: { get: (name: string) => secrets[name] ?? null, set: () => {} },
    send: (channel: string, payload: unknown) => sent.push({ channel, payload })
  } as unknown as AppContext
}

function makeService(ctx = makeCtx()) {
  const svc = createUpdaterService(ctx, { load: async () => fake })
  const states: UpdateState[] = []
  svc.onState((s) => states.push(s))
  return { svc, states }
}

function logText(): string {
  return [appLog.file, projectLog.file].map((f) => (existsSync(f) ? readFileSync(f, 'utf8') : '')).join('\n')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ave-upd-'))
  initPaths({ data: join(dir, 'data'), runtime: join(dir, 'runtime'), resources: dir })
  fake = new FakeUpdater()
  appLog = new ActivityLog(join(dir, 'app.log'))
  projectLog = new ActivityLog(join(dir, 'My Project', 'logs', 'activity.jsonl'))
  exporting = false
  flushed = 0
  sent = []
  secrets = {}
  delete process.env.AVE_UPDATE_FEED_URL
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('updater', () => {
  it('quiet launch check only shows a dot and downloads nothing', async () => {
    fake.next = { version: '1.0.1', notes: 'Fixes' }
    const { svc, states } = makeService()
    await svc.check({ quiet: true })
    expect(fake.autoDownload).toBe(false)
    expect(fake.downloads).toBe(0)
    expect(svc.state()).toMatchObject({ status: 'available', dot: true, newVersion: '1.0.1' })
    expect(states.some((s) => s.status === 'checking')).toBe(false)
    expect(sent.at(-1)).toMatchObject({ channel: 'updates:state', payload: { status: 'available', dot: true } })
  })

  it('quiet check with nothing new or no connection leaves the button alone', async () => {
    const { svc } = makeService()
    await svc.check({ quiet: true })
    expect(svc.state()).toMatchObject({ status: 'idle', dot: false })
    fake.next = { error: new Error('net::ERR_INTERNET_DISCONNECTED') }
    await svc.check({ quiet: true })
    expect(svc.state()).toMatchObject({ status: 'idle', dot: false })
  })

  it('click: checking, then up to date with the version', async () => {
    const { svc, states } = makeService()
    await svc.check()
    expect(states[0].status).toBe('checking')
    expect(svc.state()).toMatchObject({ status: 'up_to_date', currentVersion: '1.0.0' })
  })

  it('click: a new version downloads at once with progress, then shows version and notes', async () => {
    fake.next = { version: '1.0.1', notes: '<h2>1.0.1</h2><ul><li>Faster preview</li><li>Fix &amp; polish</li></ul>' }
    fake.manualDownload = true
    const { svc, states } = makeService()
    await svc.check({ quiet: true })
    expect(svc.state().dot).toBe(true)
    await svc.check()
    expect(fake.downloads).toBe(1)
    expect(svc.state()).toMatchObject({ status: 'downloading', dot: false })
    expect(states.filter((s) => s.status === 'downloading').map((s) => s.percent)).toEqual([0, 10, 30, 55, 80])
    fake.release()
    await flush()
    await flush()
    const s = svc.state()
    expect(s.status).toBe('downloaded')
    expect(s.newVersion).toBe('1.0.1')
    expect(s.releaseNotes).toBe('1.0.1\n- Faster preview\n- Fix & polish')
  })

  it('Restart now saves the project, writes the reopen file and installs silently, then relaunches', async () => {
    fake.next = { version: '1.0.1' }
    const { svc } = makeService()
    await svc.check()
    await flush()
    expect(svc.state().status).toBe('downloaded')
    await svc.restartNow()
    expect(flushed).toBe(1)
    expect(fake.installs).toEqual([[true, true]])
    const reopen = JSON.parse(readFileSync(paths.pendingUpdateFile, 'utf8'))
    expect(reopen).toMatchObject({ projectPath: join(dir, 'My Project'), fromVersion: '1.0.0', toVersion: '1.0.1' })
  })

  it('Restart now is blocked while an export runs, and Later still works', async () => {
    fake.next = { version: '1.0.1' }
    const { svc } = makeService()
    await svc.check()
    await flush()
    exporting = true
    await svc.restartNow()
    expect(fake.installs).toEqual([])
    expect(svc.state()).toMatchObject({ status: 'downloaded', restartBlockedReason: MESSAGES.restartBlocked })
    expect(existsSync(paths.pendingUpdateFile)).toBe(false)
    svc.later()
    expect(svc.state()).toMatchObject({ status: 'restart_pending' })
    expect(svc.state().restartBlockedReason).toBeUndefined()
  })

  it('Later installs on quit and the button reads restart to update', async () => {
    fake.next = { version: '1.0.1' }
    const { svc } = makeService()
    await svc.check()
    await flush()
    expect(fake.autoInstallOnAppQuit).toBe(false)
    svc.later()
    expect(fake.autoInstallOnAppQuit).toBe(true)
    expect(svc.state().status).toBe('restart_pending')
    // A later click does not download again; Restart now from here still installs.
    await svc.check()
    expect(fake.downloads).toBe(1)
    await svc.restartNow()
    expect(fake.installs).toEqual([[true, true]])
  })

  it('offline: a plain message, and Retry checks again', async () => {
    fake.next = { error: Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' }) }
    const { svc } = makeService()
    await svc.check()
    expect(svc.state()).toMatchObject({ status: 'error', error: MESSAGES.offline })
    fake.next = { version: '1.0.1' }
    await svc.check()
    await flush()
    expect(fake.checks).toBe(2)
    expect(svc.state().status).toBe('downloaded')
  })

  it('a damaged download is reported and never installed', async () => {
    fake.next = { version: '1.0.1' }
    fake.downloadError = new Error('sha512 checksum mismatch, expected abc, got def')
    const { svc } = makeService()
    await svc.check()
    await flush()
    await flush()
    expect(svc.state()).toMatchObject({ status: 'error', error: MESSAGES.damaged })
    await svc.restartNow()
    expect(fake.installs).toEqual([])
    fake.downloadError = new Error('socket hang up')
    await svc.check()
    await flush()
    await flush()
    expect(svc.state()).toMatchObject({ status: 'error', error: MESSAGES.offline })
  })

  it('logs every event to the app log and the project log, never a token', async () => {
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    secrets.githubToken = token
    fake.next = { version: '1.0.1' }
    const { svc } = makeService()
    await svc.check()
    await flush()
    expect(fake.feed).toMatchObject({ provider: 'github', private: true })
    fake.logger?.info(`GET https://api.github.com/repos/x/y/releases Authorization: token ${token}`)
    await svc.restartNow()
    fake.emit('error', new Error(`install failed for ${token}`))

    const appMsgs = appLog.read().filter((e) => e.cat === 'update').map((e) => e.msg)
    const projectMsgs = projectLog.read().filter((e) => e.cat === 'update').map((e) => e.msg)
    for (const msgs of [appMsgs, projectMsgs]) {
      expect(msgs).toContain('Checking for updates')
      expect(msgs).toContain('Update found: version 1.0.1')
      expect(msgs).toContain('Download 25%')
      expect(msgs).toContain('Download 100%')
      expect(msgs.some((m) => m.startsWith('Update downloaded: version 1.0.1'))).toBe(true)
      expect(msgs.some((m) => m.startsWith('Installing version 1.0.1'))).toBe(true)
      expect(msgs).toContain('Update install failed')
    }
    expect(logText()).not.toContain(token)
    expect(logText()).not.toContain('a1B2c3D4e5F6')
    registerSecret(null)
  })

  it('works with no project open', async () => {
    fake.next = { version: '1.0.1' }
    const { svc } = makeService(makeCtx({ project: false }))
    await svc.check()
    await flush()
    await svc.restartNow()
    expect(JSON.parse(readFileSync(paths.pendingUpdateFile, 'utf8')).projectPath).toBeNull()
    expect(fake.installs).toEqual([[true, true]])
  })

  it('outside the installed app, says so plainly', async () => {
    const svc = createUpdaterService(makeCtx(), {
      load: async () => Object.assign(fake, { checkForUpdates: async () => null })
    })
    await svc.check()
    expect(svc.state()).toMatchObject({ status: 'error', error: MESSAGES.dev })
  })

  it('release notes as a list become plain text', () => {
    expect(releaseNotesText([{ version: '1.0.1', note: '<p>One</p>' }, { version: '1.0.0', note: null }])).toBe('1.0.1\nOne\n\n1.0.0')
    expect(releaseNotesText(null)).toBe('')
  })
})

describe('update self-test', () => {
  it('checks the feed, downloads, records each stage and installs without relaunching', async () => {
    const result = join(dir, 'result.json')
    process.env.AVE_UPDATE_FEED_URL = 'http://127.0.0.1:8765/'
    process.env.AVE_UPDATE_TEST_RESULT = result
    fake.next = { version: '1.0.1' }
    const codes: number[] = []
    await runUpdateSelfTest(makeCtx(), { load: async () => fake, exit: (c) => codes.push(c) })
    expect(fake.feed).toEqual({ provider: 'generic', url: 'http://127.0.0.1:8765/' })
    expect(fake.installs).toEqual([[true, false]])
    const r = JSON.parse(readFileSync(result, 'utf8'))
    expect(r.stage).toBe('installing')
    expect(r.stages).toEqual(expect.arrayContaining(['start', 'checked', 'downloaded', 'installing']))
    expect(r.newVersion).toBe('1.0.1')
    expect(codes).toEqual([])
    delete process.env.AVE_UPDATE_TEST_RESULT
  })

  it('writes the error and exits 1 when nothing is found', async () => {
    const result = join(dir, 'result.json')
    process.env.AVE_UPDATE_TEST_RESULT = result
    const codes: number[] = []
    await runUpdateSelfTest(makeCtx(), { load: async () => fake, exit: (c) => codes.push(c) })
    const r = JSON.parse(readFileSync(result, 'utf8'))
    expect(r.stage).toBe('error')
    expect(codes).toEqual([1])
    expect(fake.installs).toEqual([])
    expect(readdirSync(dir)).toContain('result.json')
    delete process.env.AVE_UPDATE_TEST_RESULT
  })
})

describe('packaging config', () => {
  it('electron-builder.yml matches appInfo.ts and publishes per-user installers to the release repository', () => {
    const yml = readFileSync(join(__dirname, '..', 'electron-builder.yml'), 'utf8')
    const value = (key: string) => yml.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'))?.[1].trim()
    expect(value('appId')).toBe(APP_ID)
    expect(value('productName')).toBe(APP_NAME)
    expect(value('owner')).toBe(RELEASE_REPO.owner)
    expect(value('repo')).toBe(RELEASE_REPO.repo)
    expect(value('provider')).toBe('github')
    expect(value('perMachine')).toBe('false')
    expect(value('allowElevation')).toBe('false')
  })
})
