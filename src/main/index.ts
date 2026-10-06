/**
 * The app's entry point: one instance, paths and logs, the media protocol for <video>, the
 * AppContext with every service, the window, and the IPC table.
 */
import { BrowserWindow, app, protocol, safeStorage, shell } from 'electron'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { APP_DATA_FOLDER, APP_ID, APP_NAME } from '@shared/appInfo'
import { API_EVENTS, MEDIA_PROTOCOL } from '@shared/ipcChannels'
import type { AppContext } from './context'
import { initAppLog, type ActivityLog } from './log'
import { initPaths, paths } from './paths'
import { registerIpc } from './ipc'
import { serveMedia } from './mediaProtocol'
import { createEnvironmentService } from './engine/environment'
import { createEngineService } from './engine/engine'
import { createPreviewService } from './engine/preview'
import { createRenderJobs } from './engine/renders'
import { createMcpService } from './mcp/server'
import { createRunnerService } from './runner/runner'
import { createProjectManager } from './project/manager'
import { createRequestService } from './project/requests'
import { createVersionService } from './project/versions'
import { readJson } from './project/store'
import { createCorrectionsService } from './services/corrections'
import { createLibraryService } from './services/library'
import { createMusicService } from './services/music'
import { createPikzelsService } from './services/pikzels'
import {
  createProfileService,
  createRecentService,
  createSecretsService,
  createSettingsService
} from './services/settings'
import { createUpdaterService, runUpdateSelfTest } from './updater'

const SELF_TEST = process.argv.includes('--update-self-test')

// Settings live in %APPDATA%/AI Video Editor whatever the program folder is called.
app.setPath('userData', join(app.getPath('appData'), APP_DATA_FOLDER))
app.setName(APP_NAME)
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true }
  }
])

let mainWindow: BrowserWindow | null = null
let ctx: AppContext | null = null
let appLog: ActivityLog | null = null

if (!SELF_TEST && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.whenReady().then(start).catch((err) => fatal(err))
}

// ------------------------------------------------------------------ crash handling

function errorData(err: unknown): { message: string; stack?: string } {
  return err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) }
}

function logCrash(kind: string, err: unknown): void {
  const data = errorData(err)
  try {
    appLog?.write('error', `${kind}: ${data.message}`, data)
    ctx?.projects.current()?.log.write('error', `${kind}: ${data.message}`, data)
  } catch {
    // Logging must never crash the crash handler.
  }
  console.error(kind, err)
}

process.on('uncaughtException', (err) => logCrash('Uncaught error', err))
process.on('unhandledRejection', (reason) => logCrash('Unhandled promise rejection', reason))

function fatal(err: unknown): void {
  logCrash('Startup failed', err)
  app.exit(1)
}

// ------------------------------------------------------------------ the AppContext

function buildContext(log: ActivityLog): AppContext {
  const c = {
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    appLog: log,
    send(channel: string, payload: unknown) {
      const win = mainWindow
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
      win.webContents.send(channel, payload)
    }
  } as AppContext
  // Factories only keep a reference to the context; services reach each other at call time.
  c.settings = createSettingsService(c)
  c.profiles = createProfileService(c)
  c.secrets = createSecretsService(c, safeStorage)
  c.recent = createRecentService(c)
  c.projects = createProjectManager(c, { documentsDir: app.getPath('documents') })
  c.requests = createRequestService(c)
  c.versions = createVersionService(c)
  c.corrections = createCorrectionsService(c)
  c.env = createEnvironmentService(c)
  c.engine = createEngineService(c)
  c.preview = createPreviewService(c)
  c.renders = createRenderJobs(c)
  c.music = createMusicService(c)
  c.mcp = createMcpService(c)
  c.runner = createRunnerService(c)
  c.library = createLibraryService(c)
  c.pikzels = createPikzelsService(c)
  c.updater = createUpdaterService(c)
  return c
}

function forwardEvents(c: AppContext): void {
  c.updater.onState((s) => c.send(API_EVENTS['updates.onState'], s))
  c.preview.onState((s) => c.send(API_EVENTS['preview.onState'], s))
  c.runner.onState((s) => c.send(API_EVENTS['claude.onState'], s))
  c.runner.onOutput((line) => c.send(API_EVENTS['claude.onOutput'], line))
  c.renders.onJob((j) => c.send(API_EVENTS['project.onRenderJob'], j))
}

// ------------------------------------------------------------------ window

function preloadPath(): string {
  const dir = join(__dirname, '../preload')
  for (const name of ['index.js', 'index.cjs', 'index.mjs']) {
    if (existsSync(join(dir, name))) return join(dir, name)
  }
  return join(dir, 'index.js')
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: APP_NAME,
    backgroundColor: '#0E0F12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true
    }
  })
  win.once('ready-to-show', () => win.show())
  // Links open in the browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    // A file dropped on the window must not replace the app.
    e.preventDefault()
  })
  win.webContents.on('render-process-gone', (_e, details) => logCrash('Window crashed', new Error(`${details.reason} (exit ${details.exitCode})`)))
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  return win
}

// ------------------------------------------------------------------ startup

/** After "Restart now", the updater leaves reopen.json so the project you were in opens again. */
async function reopenAfterUpdate(c: AppContext): Promise<void> {
  const file = paths.pendingUpdateFile
  if (!existsSync(file)) return
  let target: string | null = null
  try {
    const info = readJson<{ projectPath?: string | null; fromVersion?: string; toVersion?: string }>(file)
    target = info.projectPath ?? null
    c.appLog.write('update', `Started after an update${info.fromVersion ? ` from ${info.fromVersion}` : ''} to ${c.appVersion}`, info)
  } catch (err) {
    c.appLog.write('error', 'Could not read reopen.json after the update', errorData(err))
  } finally {
    rmSync(file, { force: true })
  }
  if (!target) return
  try {
    await c.projects.open(target)
    c.appLog.write('update', 'Reopened the project you were in', { dir: target })
  } catch (err) {
    c.appLog.write('error', 'Could not reopen the project after the update', { dir: target, ...errorData(err) })
  }
}

async function start(): Promise<void> {
  initPaths({
    data: app.getPath('userData'),
    resources: app.isPackaged ? join(process.resourcesPath) : app.getAppPath()
  })
  appLog = initAppLog(paths.appLog)
  appLog.write('app', `${APP_NAME} ${app.getVersion()} started`, {
    platform: process.platform,
    packaged: app.isPackaged,
    electron: process.versions.electron,
    selfTest: SELF_TEST
  })

  const c = buildContext(appLog)
  ctx = c

  if (SELF_TEST) {
    await runUpdateSelfTest(c)
    return
  }

  protocol.handle(MEDIA_PROTOCOL, (req) => serveMedia(req))
  registerIpc(c, () => mainWindow)
  forwardEvents(c)

  // Claude can connect from the moment the app is up.
  try {
    await c.mcp.start()
  } catch (err) {
    c.appLog.write('error', 'The Claude connection (MCP server) could not start', errorData(err))
  }

  await reopenAfterUpdate(c)
  mainWindow = createWindow()

  // A quiet check at launch: only a dot on the button, nothing downloads until you click.
  void c.updater.check({ quiet: true }).catch((err) => c.appLog.write('update', 'Quiet update check failed', errorData(err)))

  app.on('activate', () => {
    if (!mainWindow) mainWindow = createWindow()
  })
}

let quitting = false
app.on('before-quit', (e) => {
  const c = ctx
  if (quitting || !c || SELF_TEST) return
  quitting = true
  e.preventDefault()
  const done = () => app.quit()
  const steps = async () => {
    try {
      c.projects.current()?.flush()
    } catch (err) {
      logCrash('Could not save the project while quitting', err)
    }
    await Promise.allSettled([c.runner.stop(), c.mcp.stop()])
    await c.projects.close().catch(() => undefined)
    c.appLog.write('app', 'App closed')
  }
  // Never hang on the way out.
  const timer = setTimeout(done, 5000)
  void steps().finally(() => {
    clearTimeout(timer)
    done()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
