/**
 * Where things live on disk. Program files are replaced by updates; nothing here is.
 *  - data root (%APPDATA%/AI Video Editor): settings, profiles, recent list, app log
 *  - runtime root (%LOCALAPPDATA%/AI Video Editor): managed Python environment, ffmpeg, engine versions
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { APP_DATA_FOLDER } from '@shared/appInfo'

let dataRoot: string | null = null
let runtimeRoot: string | null = null
let resourcesRoot: string | null = null

export function initPaths(opts: { data: string; runtime?: string; resources: string }): void {
  dataRoot = opts.data
  runtimeRoot = opts.runtime ?? defaultRuntimeRoot()
  resourcesRoot = opts.resources
  for (const d of [dataRoot, runtimeRoot, join(dataRoot, 'logs'), join(dataRoot, 'profiles'), join(dataRoot, 'backups')]) {
    mkdirSync(d, { recursive: true })
  }
}

export function defaultRuntimeRoot(): string {
  if (process.env.AVE_RUNTIME_DIR) return process.env.AVE_RUNTIME_DIR
  const local = process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share')
  return join(local, APP_DATA_FOLDER)
}

export const paths = {
  get data(): string {
    if (!dataRoot) throw new Error('paths not initialised')
    return dataRoot
  },
  get runtime(): string {
    if (!runtimeRoot) throw new Error('paths not initialised')
    return runtimeRoot
  },
  /** Read-only files shipped with the app (engine source, default assets). */
  get resources(): string {
    if (!resourcesRoot) throw new Error('paths not initialised')
    return resourcesRoot
  },
  get settingsFile(): string {
    return join(this.data, 'settings.json')
  },
  get profilesDir(): string {
    return join(this.data, 'profiles')
  },
  get recentFile(): string {
    return join(this.data, 'recent.json')
  },
  get secretsFile(): string {
    return join(this.data, 'secrets.json')
  },
  get appLog(): string {
    return join(this.data, 'logs', 'app.log')
  },
  get musicIndexFile(): string {
    return join(this.data, 'music-index.json')
  },
  get pythonEnv(): string {
    return join(this.runtime, 'python')
  },
  get toolsDir(): string {
    return join(this.runtime, 'tools')
  },
  get enginesDir(): string {
    return join(this.runtime, 'engines')
  },
  get pendingUpdateFile(): string {
    return join(this.data, 'reopen.json')
  }
}

/** Folders inside a project. */
export const projectPaths = (dir: string) => ({
  file: join(dir, 'project.json'),
  graphics: join(dir, 'graphics'),
  audio: join(dir, 'audio'),
  media: join(dir, 'media'),
  thumbnails: join(dir, 'thumbnails'),
  exports: join(dir, 'exports'),
  cache: join(dir, 'cache'),
  logs: join(dir, 'logs'),
  activityLog: join(dir, 'logs', 'activity.jsonl'),
  backups: join(dir, 'backups'),
  history: join(dir, 'history'),
  versions: join(dir, 'versions'),
  requests: join(dir, 'cache', 'requests')
})
