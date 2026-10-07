/**
 * The diagnostics zip (the log icon at the top right): everything needed to find out what went wrong, in one file
 * to send. API keys and tokens are removed from every file (the same scrubbing as the logs). No footage, renders
 * or transcripts are included.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { cpus, freemem, release, totalmem, type as osType, uptime, arch } from 'node:os'
import { join } from 'node:path'
import type { AppContext } from '../context'
import { redact } from '../log'
import { paths } from '../paths'
import { makeZip, type ZipEntry } from './zip'

/** The newest part of a log: 5 MB is weeks of activity. */
const MAX_LOG_BYTES = 5 * 1024 * 1024

function tail(file: string, max = MAX_LOG_BYTES): string {
  const buf = readFileSync(file)
  const text = buf.length > max ? buf.subarray(buf.length - max).toString('utf8').replace(/^[^\n]*\n/, '') : buf.toString('utf8')
  return redact(text)
}

function json(data: unknown): string {
  return redact(JSON.stringify(data, null, 2))
}

function version(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, ['--version'], { timeout: 10000, windowsHide: true, shell: process.platform === 'win32' }, (err, stdout, stderr) =>
        resolve(err ? `not available: ${err.message.split('\n')[0]}` : (stdout || stderr).trim())
      )
    } catch (err) {
      resolve(`not available: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`
}

export async function buildDiagnostics(
  ctx: AppContext,
  info: { appName: string; appVersion: string; versions: Record<string, string | undefined>; outDir: string }
): Promise<string> {
  const entries: ZipEntry[] = []
  const add = (name: string, data: string) => entries.push({ name, data })
  const safe = async (name: string, f: () => unknown | Promise<unknown>) => {
    try {
      add(name, json(await f()))
    } catch (err) {
      add(name, json({ error: err instanceof Error ? err.message : String(err) }))
    }
  }

  const store = ctx.projects.current()
  add(
    'README.txt',
    [
      `${info.appName} ${info.appVersion} diagnostics, made ${new Date().toString()}`,
      '',
      'system.json        Windows, CPU, memory, app and Electron versions',
      'environment.json   graphics card, Python engine and ffmpeg status',
      'claude-code.txt    the Claude Code version the app starts',
      'settings.json      app settings (API keys are stored separately and are not included)',
      'updates.json       update status',
      'claude-output.json the last lines Claude printed, and its state',
      'logs/              the app log',
      store ? 'project/           the open project: project.json and its activity log (no footage or transcript)' : '',
      '',
      'Keys and tokens are removed from every file.'
    ]
      .join('\r\n')
  )
  await safe('system.json', () => ({
    app: { name: info.appName, version: info.appVersion, packaged: ctx.isPackaged },
    versions: info.versions,
    os: { type: osType(), release: release(), arch: arch(), uptimeHours: Math.round(uptime() / 360) / 10 },
    cpu: { model: cpus()[0]?.model, cores: cpus().length },
    memoryGb: { total: Math.round(totalmem() / 1e8) / 10, free: Math.round(freemem() / 1e8) / 10 },
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    folders: { data: paths.data, runtime: paths.runtime }
  }))
  await safe('environment.json', () => ctx.env.status())
  add('claude-code.txt', redact(await version(ctx.settings.get().runner.command || 'claude')))
  await safe('settings.json', () => ctx.settings.get())
  await safe('updates.json', () => ctx.updater.state())
  await safe('claude-output.json', () => ({ state: ctx.runner.state(), lastLines: ctx.runner.recentOutput() }))

  const logDir = join(paths.data, 'logs')
  if (existsSync(logDir)) {
    for (const f of readdirSync(logDir).filter((n) => /\.log(\.\d+)?$/.test(n))) {
      try {
        add(`logs/${f}`, tail(join(logDir, f)))
      } catch {
        /* a locked file is skipped */
      }
    }
  }
  if (store) {
    await safe('project/project.json', () => store.project)
    await safe('project/state.json', () => ({ dir: store.dir, readOnly: store.readOnly, preview: ctx.preview.state(), missingSources: ctx.projects.missingSources() }))
    const plogs = store.paths.logs
    if (existsSync(plogs)) {
      for (const f of readdirSync(plogs)) {
        const full = join(plogs, f)
        try {
          if (statSync(full).isFile()) add(`project/logs/${f}`, tail(full))
        } catch {
          /* skipped */
        }
      }
    }
  }

  const out = join(info.outDir, `AI-Video-Editor-diagnostics-${stamp()}.zip`)
  writeFileSync(out, makeZip(entries))
  ctx.appLog.write('app', 'Diagnostics zip saved', { file: out, files: entries.length })
  return out
}
