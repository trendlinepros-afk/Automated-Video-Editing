/**
 * Activity logs. Written line by line as things happen, so a crash never loses them.
 * Every line passes through redact(): API keys and tokens never reach a log file.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export type LogCategory =
  | 'mcp'
  | 'tweak'
  | 'request'
  | 'render'
  | 'export'
  | 'selfcheck'
  | 'thumbnail'
  | 'upgrade'
  | 'update'
  | 'claude'
  | 'error'
  | 'app'
  | 'library'
  | 'version'

export interface LogEntry {
  ts: string
  session: string
  cat: LogCategory
  msg: string
  data?: unknown
}

/** One id per app launch, so "Last session" can be filtered. */
export const SESSION_ID = randomUUID().slice(0, 8)

const knownSecrets = new Set<string>()

/** Register a secret value (an API key, a token) so it is scrubbed from every log line. */
export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 6) knownSecrets.add(value)
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/pkz_[A-Za-z0-9_\-]{6,}/g, 'pkz_[REDACTED]'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, 'gh_[REDACTED]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_[REDACTED]'],
  [/sk-ant-[A-Za-z0-9_\-]{10,}/g, 'sk-ant-[REDACTED]'],
  [/sk-[A-Za-z0-9]{20,}/g, 'sk-[REDACTED]'],
  [/(Bearer\s+)[A-Za-z0-9._\-~+/=]{8,}/gi, '$1[REDACTED]'],
  [/("?(?:x-api-key|api[_-]?key|apikey|authorization|token|access[_-]?token|secret|password|GH_TOKEN)"?\s*[:=]\s*"?)([^"\s,}&]{4,})/gi, '$1[REDACTED]'],
  [/([?&](?:token|key|api_key|access_token)=)[^&\s"]+/gi, '$1[REDACTED]']
]

export function redact(text: string): string {
  let out = text
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]')
  }
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep)
  return out
}

function summarise(data: unknown, max = 4000): unknown {
  if (data === undefined) return undefined
  let s: string
  try {
    s = JSON.stringify(data)
  } catch {
    s = String(data)
  }
  if (s.length > max) s = s.slice(0, max) + `… (${s.length - max} more chars)`
  try {
    return JSON.parse(redact(s))
  } catch {
    return redact(s)
  }
}

export class ActivityLog {
  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true })
  }

  write(cat: LogCategory, msg: string, data?: unknown): LogEntry {
    const entry: LogEntry = { ts: new Date().toISOString(), session: SESSION_ID, cat, msg: redact(msg) }
    if (data !== undefined) entry.data = summarise(data)
    try {
      appendFileSync(this.file, redact(JSON.stringify(entry)) + '\n')
    } catch {
      // A log write must never break the app.
    }
    return entry
  }

  read(): LogEntry[] {
    if (!existsSync(this.file)) return []
    const out: LogEntry[] = []
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        out.push({ ts: '', session: '', cat: 'error', msg: line })
      }
    }
    return out
  }
}

export function formatEntry(e: LogEntry): string {
  const data = e.data === undefined ? '' : ' ' + (typeof e.data === 'string' ? e.data : JSON.stringify(e.data))
  return `${e.ts} [${e.cat}] ${e.msg}${data}`
}

export interface LogHeader {
  appVersion: string
  projectFormatVersion: number
  windowsVersion: string
  profile: string
  projectName: string
}

/** Builds the Export log text file: a header, then one timestamped line per event, oldest first. */
export function buildLogExport(entries: LogEntry[], header: LogHeader, filter: 'all' | 'last_session'): string {
  let list = entries
  if (filter === 'last_session' && entries.length) {
    const last = entries[entries.length - 1].session
    list = entries.filter((e) => e.session === last)
  }
  list = [...list].sort((a, b) => a.ts.localeCompare(b.ts))
  const lines = [
    `AI Video Editor activity log`,
    `App version: ${header.appVersion}`,
    `Project format version: ${header.projectFormatVersion}`,
    `Windows version: ${header.windowsVersion}`,
    `Profile: ${header.profile}`,
    `Project: ${header.projectName}`,
    `Filter: ${filter === 'all' ? 'Everything' : 'Last session'}`,
    `Exported: ${new Date().toISOString()}`,
    '-'.repeat(72),
    ...list.map(formatEntry)
  ]
  return redact(lines.join('\n') + '\n')
}

export function writeLogExport(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, redact(text))
}

let appLog: ActivityLog | null = null
export function initAppLog(file: string): ActivityLog {
  appLog = new ActivityLog(file)
  return appLog
}
/** The app-level log: startup and update problems, reached from Settings. */
export function appLogger(): ActivityLog {
  if (!appLog) appLog = new ActivityLog(process.env.AVE_APP_LOG ?? 'app.log')
  return appLog
}
