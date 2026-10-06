/**
 * Starts Claude Code in the background, in its non-interactive mode, already connected to the open
 * project through the app's MCP server. The app holds no Claude API key and calls no model API:
 * Claude Code uses the sign-in already on this PC.
 *
 * The command and its arguments are a setting, so another AI command line with MCP support can replace it.
 * Placeholders in the arguments: {prompt} {mcpConfig} {systemPrompt} {allowedTools} {sessionId}.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { MCP_SERVER_NAME } from '@shared/appInfo'
import type { RunnerState } from '@shared/ipc'
import type { EditRequest } from '@shared/project'
import type { AppContext, RunnerService } from '../context'
import type { ProjectStore } from '../project/store'
import { buildRunPrompt, buildSystemPrompt } from './prompts'

type OutputLine = { ts: string; text: string; kind: 'text' | 'tool' | 'error' | 'info' }

export interface RunnerDeps {
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  platform?: NodeJS.Platform
}

/** Replace {placeholders} inside each argument. One argument stays one argument, whatever its content. */
export function templateArgs(args: string[], vars: Record<string, string>): string[] {
  return args.map((a) => a.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? vars[name] : m)))
}

export type Outcome =
  | { kind: 'ok' }
  | { kind: 'not_found' | 'limit' | 'auth' | 'resume_failed' | 'error' | 'stopped'; reason: string }

const LIMIT_RE = /usage limit|limit reached|hit your limit|limit will reset|resets? at|rate.?limit(ed)?|quota exceeded|out of (extra )?usage|credit balance is too low/i
const AUTH_RE = /invalid api key|please run \/login|run \/login|not logged in|not signed in|log ?in again|sign ?in again|authentication[_ ](failed|error|required)|oauth token (has )?expired|invalid bearer|401 unauthorized/i
const RESUME_RE = /no conversation found|session (id )?.*not found|could not (find|resume) (the )?session|cannot resume/i

function limitReason(text: string): string {
  // Claude Code reports "Claude AI usage limit reached|<unix seconds>" in some versions.
  const epoch = /limit reached\|(\d{9,})/i.exec(text)
  if (epoch) {
    const at = new Date(Number(epoch[1]) * 1000)
    return `Claude usage limit reached. It resets at ${at.toLocaleString()}. Press Resume then.`
  }
  const resets = /resets?\s+(?:at\s+)?([^\n.·|]{2,40})/i.exec(text)
  return `Claude usage limit reached${resets ? ` (resets ${resets[1].trim()})` : ''}. Press Resume when it resets.`
}

/** What a finished run means for the queue. */
export function classifyOutcome(r: {
  spawnError?: NodeJS.ErrnoException
  stopping: boolean
  resumed: boolean
  result?: { is_error?: boolean; result?: string; subtype?: string; error?: string } | null
  exitCode: number | null
  text: string
  command: string
}): Outcome {
  if (r.spawnError) {
    if (r.spawnError.code === 'ENOENT') {
      return { kind: 'not_found', reason: `Claude Code was not found (command "${r.command}"). Install Claude Code, or change the command in Settings > Claude connection.` }
    }
    return { kind: 'error', reason: `Claude could not start: ${r.spawnError.message}` }
  }
  if (r.stopping) return { kind: 'stopped', reason: 'Stopped' }
  const all = `${r.result?.result ?? ''}\n${r.result?.error ?? ''}\n${r.text}`
  const failed = !r.result || !!r.result.is_error || (r.exitCode !== 0 && r.exitCode !== null)
  if (failed && r.resumed && RESUME_RE.test(all)) return { kind: 'resume_failed', reason: 'The earlier Claude session could not be resumed' }
  if (failed && LIMIT_RE.test(all)) return { kind: 'limit', reason: limitReason(all) }
  if (failed && AUTH_RE.test(all)) return { kind: 'auth', reason: 'Claude Code is signed out. Open a terminal, run "claude" and sign in, then press Resume.' }
  if (r.result && !r.result.is_error && (r.exitCode === 0 || r.exitCode === null)) return { kind: 'ok' }
  const detail = (r.result?.result || r.result?.error || r.text.trim().split('\n').filter(Boolean).pop() || '').slice(0, 300)
  return { kind: 'error', reason: `Claude stopped unexpectedly${r.exitCode !== null ? ` (exit code ${r.exitCode})` : ''}${detail ? `: ${detail}` : ''}` }
}

// ---------------------------------------------------------------- command resolution (Windows needs care)

function findOnPath(cmd: string, platform: NodeJS.Platform): string | null {
  const exts = platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())] : ['']
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  }
  const candidates = (base: string) => (platform === 'win32' && extname(base) ? [base, ...exts.slice(1).map((e) => base + e)] : exts.map((e) => base + e))
  if (isAbsolute(cmd) || /[\\/]/.test(cmd)) {
    for (const c of candidates(cmd)) if (isFile(c)) return c
    return null
  }
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    if (!dir) continue
    for (const c of candidates(join(dir, cmd))) if (isFile(c)) return c
  }
  return null
}

/** cmd.exe cannot carry newlines or bare quotes in arguments; keep the text, flatten the lines. */
function cmdQuote(arg: string): string {
  return `"${arg.replace(/\r?\n/g, ' ').replace(/"/g, '""')}"`
}

export function resolveCommand(command: string, args: string[], platform: NodeJS.Platform): { file: string; args: string[]; shell: boolean } {
  if (platform !== 'win32') return { file: command, args, shell: false }
  const found = findOnPath(command, platform)
  if (!found) return { file: command, args, shell: false }
  if (!/\.(cmd|bat)$/i.test(found)) return { file: found, args, shell: false }
  // An npm shim (claude.cmd) runs a JavaScript file with node: run that directly so long prompts pass intact.
  try {
    const shim = readFileSync(found, 'utf8')
    const m = /"%(?:~?dp0)%\\?([^"%]+\.(?:c|m)?js)"/i.exec(shim)
    if (m) {
      const script = join(dirname(found), m[1])
      const localNode = join(dirname(found), 'node.exe')
      const node = existsSync(localNode) ? localNode : findOnPath('node', platform)
      if (node && existsSync(script)) return { file: node, args: [script, ...args], shell: false }
    }
  } catch {
    /* fall back to the shell */
  }
  return { file: cmdQuote(found), args: args.map(cmdQuote), shell: true }
}

function killTree(proc: ChildProcess, platform: NodeJS.Platform, spawnFn: NonNullable<RunnerDeps['spawn']>): void {
  if (!proc.pid) return
  if (platform === 'win32') {
    try {
      spawnFn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      proc.kill()
    }
    return
  }
  try {
    process.kill(-proc.pid, 'SIGTERM')
  } catch {
    proc.kill('SIGTERM')
  }
  const hard = setTimeout(() => {
    try {
      process.kill(-proc.pid!, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }, 3000)
  hard.unref?.()
  proc.once('exit', () => clearTimeout(hard))
}

// ---------------------------------------------------------------- the service

interface Run {
  proc: ChildProcess
  store: ProjectStore
  projectId: string
  resumed: boolean
  configFile: string
  startOpenIds: string[]
  sawInit: boolean
  sessionId?: string
  result: Record<string, any> | null
  text: string
  spawnError?: NodeJS.ErrnoException
  stopping: boolean
  exited: Promise<void>
  command: string
}

const MAX_RUNS_WITHOUT_PROGRESS = 2

export function createRunnerService(ctx: AppContext, deps: RunnerDeps = {}): RunnerService {
  const spawnFn = deps.spawn ?? (nodeSpawn as unknown as NonNullable<RunnerDeps['spawn']>)
  const platform = deps.platform ?? process.platform
  const stateListeners = new Set<(s: RunnerState) => void>()
  const outputListeners = new Set<(l: OutputLine) => void>()
  let state: RunnerState = { status: 'idle', connected: false, queue: 0 }
  let current: Run | null = null
  let wired = false
  let held = false // after Stop: no automatic restart until the owner acts
  let runsWithoutProgress = 0
  let forceFresh = false
  let unwatchStore: (() => void) | null = null

  const queuedCount = (): number => {
    try {
      return ctx.requests.open().filter((r) => r.status === 'queued').length
    } catch {
      return 0
    }
  }

  const connectedCount = (): number => {
    try {
      return ctx.mcp.connectedClients()
    } catch {
      return 0
    }
  }

  const emit = () => {
    const s = { ...state }
    for (const cb of stateListeners) {
      try {
        cb(s)
      } catch {
        /* listeners never break the runner */
      }
    }
  }

  const update = (patch: Partial<RunnerState>) => {
    state = { ...state, ...patch, connected: connectedCount() > 0, queue: queuedCount() }
    for (const k of Object.keys(patch) as (keyof RunnerState)[]) if (patch[k] === undefined) delete state[k]
    emit()
  }

  const output = (kind: OutputLine['kind'], text: string, log = true) => {
    const line: OutputLine = { ts: new Date().toISOString(), text, kind }
    for (const cb of outputListeners) {
      try {
        cb(line)
      } catch {
        /* ignore */
      }
    }
    if (log) current?.store.log.write('claude', `${kind}: ${text.length > 400 ? text.slice(0, 400) + '…' : text}`)
  }

  const watchStore = (store: ProjectStore | null) => {
    unwatchStore?.()
    unwatchStore = null
    if (!store) return
    const onChange = () => {
      const q = queuedCount()
      if (q !== state.queue) update({})
    }
    store.on('change', onChange)
    unwatchStore = () => store.off('change', onChange)
  }

  const wire = () => {
    if (wired) return
    wired = true
    ctx.mcp.onClientsChanged(() => {
      update({})
      // A client that connected by hand picks up queued work itself.
      if (!current && state.status === 'waiting' && connectedCount() === 0 && !held) kick()
    })
    ctx.projects.onOpened((store) => {
      watchStore(store)
      if (current && (!store || store.project.id !== current.projectId)) void stop()
      runsWithoutProgress = 0
      held = false
      update({ pausedAt: undefined, waitingReason: undefined, sessionId: store?.project.claudeSessionId, status: current ? state.status : 'idle' })
    })
    watchStore(ctx.projects.current())
  }

  /** "Claude disconnected, edit paused at: Graphics" when an edit stopped part way. */
  const pausedAt = (store: ProjectStore): string | undefined => {
    const p = store.project
    if (p.status !== 'editing' && p.status !== 'new') return undefined
    const started = p.checklist.some((c) => c.status !== 'not_started')
    const next = p.checklist.find((c) => c.status !== 'done')
    if (!started || !next) return undefined
    return `Claude disconnected, edit paused at: ${next.label}`
  }

  const saveSessionId = (store: ProjectStore, id: string | undefined) => {
    if (store.readOnly || store.project.claudeSessionId === id) return
    try {
      store.mutate('Claude session', 'app', (d) => {
        if (id) d.project.claudeSessionId = id
        else delete d.project.claudeSessionId
      }, { bypassLock: true, noHistory: true })
    } catch (err) {
      store.log.write('error', 'Could not save the Claude session id', { error: String(err) })
    }
  }

  const handleEvent = (run: Run, ev: Record<string, any>) => {
    if (typeof ev.session_id === 'string' && ev.session_id && ev.session_id !== run.sessionId) {
      run.sessionId = ev.session_id
      saveSessionId(run.store, ev.session_id)
      update({ sessionId: ev.session_id })
    }
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          run.sawInit = true
          update({ status: 'running', lastActivity: 'Claude started' })
          output('info', `Claude started${run.resumed ? ' (continuing the earlier session)' : ''}`)
          const servers: { name: string; status: string }[] = Array.isArray(ev.mcp_servers) ? ev.mcp_servers : []
          const ours = servers.find((s) => s.name === MCP_SERVER_NAME)
          if (ours && ours.status !== 'connected') output('error', `Claude could not reach the app's editing tools (status: ${ours.status}).`)
        }
        break
      case 'assistant': {
        const content: any[] = Array.isArray(ev.message?.content) ? ev.message.content : []
        for (const c of content) {
          if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
            const t = c.text.trim()
            output('text', t.length > 2000 ? t.slice(0, 2000) + '…' : t)
            update({ lastActivity: t.split('\n')[0].slice(0, 140) })
          } else if (c.type === 'tool_use') {
            const name = String(c.name ?? '').replace(new RegExp(`^mcp__${MCP_SERVER_NAME}__`), '')
            output('tool', name)
            const patch: Partial<RunnerState> = { lastActivity: `Using ${name.replace(/_/g, ' ')}` }
            if (name === 'begin_request' && typeof c.input?.request_id === 'string') patch.activeRequestId = c.input.request_id
            update(patch)
          }
        }
        break
      }
      case 'user': {
        const content: any[] = Array.isArray(ev.message?.content) ? ev.message.content : []
        for (const c of content) {
          if (c.type === 'tool_result' && c.is_error) {
            const t = Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? '').join(' ') : String(c.content ?? '')
            output('error', t.slice(0, 400))
          }
        }
        break
      }
      case 'result':
        run.result = ev
        if (!ev.is_error) {
          const turns = typeof ev.num_turns === 'number' ? `${ev.num_turns} turns` : ''
          const secs = typeof ev.duration_ms === 'number' ? `${Math.round(ev.duration_ms / 1000)} s` : ''
          output('info', `Claude finished${turns || secs ? ` (${[turns, secs].filter(Boolean).join(', ')})` : ''}`)
        }
        break
    }
  }

  const finishRun = (run: Run, exitCode: number | null) => {
    if (current === run) current = null
    rmSync(run.configFile, { force: true })
    const outcome = classifyOutcome({ ...run, exitCode })
    const store = run.store
    const stillOpen = (() => {
      const s = ctx.projects.current()
      return s && s.project.id === run.projectId ? ctx.requests.open() : []
    })()
    store.log.write('claude', `Claude exited: ${outcome.kind}${'reason' in outcome ? ` (${outcome.reason})` : ''}`, { exitCode })
    const sameProject = ctx.projects.current()?.project.id === run.projectId

    if (outcome.kind === 'resume_failed') {
      output('info', 'The earlier Claude session could not be continued. Starting a new one from the checklist and handoff notes.')
      saveSessionId(store, undefined)
      forceFresh = true
      if (sameProject) return startNext()
    }

    if (outcome.kind === 'ok') {
      const finished = run.startOpenIds.filter((id) => !stillOpen.some((r) => r.id === id))
      runsWithoutProgress = finished.length ? 0 : runsWithoutProgress + 1
      if (stillOpen.some((r) => r.status === 'in_progress')) ctx.requests.requeueInProgress('Claude stopped before finishing this request')
      const queued = sameProject ? ctx.requests.open() : []
      if (queued.length && !held) {
        if (runsWithoutProgress >= MAX_RUNS_WITHOUT_PROGRESS) {
          const reason = 'Claude stopped twice without finishing the request. Press Resume to try again.'
          ctx.requests.setWaitingReason(reason)
          return update({ status: 'waiting', waitingReason: reason, activeRequestId: undefined, pausedAt: pausedAt(store) })
        }
        return startNext()
      }
      return update({ status: 'idle', activeRequestId: undefined, waitingReason: undefined, lastActivity: 'Claude finished', pausedAt: queued.length ? pausedAt(store) : undefined })
    }

    if (outcome.kind === 'stopped') {
      output('info', 'Stopped')
      return update({ status: queuedCount() ? 'waiting' : 'idle', activeRequestId: undefined, waitingReason: queuedCount() ? 'Stopped. Press Resume to continue.' : undefined, lastActivity: 'Stopped', pausedAt: pausedAt(store) })
    }

    // Claude could not start or stopped with an error: the request stays in the queue with the reason.
    const reason = outcome.reason
    output('error', reason)
    if (sameProject) {
      ctx.requests.requeueInProgress(reason)
      ctx.requests.setWaitingReason(reason)
    }
    const waiting = outcome.kind === 'not_found' || outcome.kind === 'limit' || outcome.kind === 'auth'
    update({ status: waiting ? 'waiting' : 'error', waitingReason: reason, activeRequestId: undefined, lastActivity: reason, pausedAt: pausedAt(store) })
  }

  const startNext = (): void => {
    const store = ctx.projects.current()
    if (!store || store.readOnly) return update({ status: 'idle', activeRequestId: undefined })
    const open = ctx.requests.open()
    if (!open.length) return update({ status: 'idle', activeRequestId: undefined })
    startRun(store, open)
  }

  const startRun = (store: ProjectStore, open: EditRequest[]) => {
    const settings = ctx.settings.get().runner
    const project = store.project
    const sessionId = forceFresh ? undefined : project.claudeSessionId
    forceFresh = false
    const configDir = store.paths.cache
    mkdirSync(configDir, { recursive: true })
    const configFile = join(configDir, 'claude-mcp.json')
    // Holds the app's connection token: lives only in cache/ while Claude runs, and is never logged.
    writeFileSync(
      configFile,
      JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: ctx.mcp.url(project.id), headers: { Authorization: `Bearer ${ctx.mcp.token()}` } } } }, null, 2),
      { mode: 0o600 }
    )
    const vars = {
      prompt: buildRunPrompt(open, project, { resumed: !!sessionId }),
      systemPrompt: buildSystemPrompt(ctx.profiles.get(project.profileId)),
      mcpConfig: configFile,
      allowedTools: settings.allowedTools,
      sessionId: sessionId ?? ''
    }
    const args = [...templateArgs(settings.args, vars), ...(sessionId ? templateArgs(settings.resumeArgs, vars) : [])]
    const cmd = resolveCommand(settings.command, args, platform)
    const { ANTHROPIC_API_KEY: _drop, ...env } = process.env // Claude Code uses its own sign-in, never a key from the app
    let proc: ChildProcess
    const run = {
      store,
      projectId: project.id,
      resumed: !!sessionId,
      configFile,
      startOpenIds: open.map((r) => r.id),
      sawInit: false,
      result: null,
      text: '',
      stopping: false,
      command: settings.command
    } as unknown as Run
    try {
      proc = spawnFn(cmd.file, cmd.args, { cwd: store.dir, env, windowsHide: true, detached: platform !== 'win32', shell: cmd.shell, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      run.spawnError = err as NodeJS.ErrnoException
      current = run
      return finishRun(run, null)
    }
    run.proc = proc
    current = run
    held = false
    store.log.write('claude', `Starting Claude${sessionId ? ' (continuing the earlier session)' : ''}`, {
      command: settings.command,
      requests: open.map((r) => `${r.id} ${r.kind}`)
    })
    ctx.requests.setWaitingReason(undefined)
    update({ status: 'starting', activeRequestId: open[0]?.id, waitingReason: undefined, pausedAt: undefined, lastActivity: 'Starting Claude…', sessionId })

    const keepText = (s: string) => {
      run.text = (run.text + s).slice(-8000)
    }
    run.exited = new Promise<void>((resolve) => {
      let done = false
      const end = (code: number | null) => {
        if (done) return
        done = true
        finishRun(run, code)
        resolve()
      }
      proc.on('error', (err) => {
        run.spawnError = err as NodeJS.ErrnoException
        end(null)
      })
      proc.on('close', (code) => end(code))
    })
    if (proc.stdout) {
      createInterface({ input: proc.stdout }).on('line', (line) => {
        const t = line.trim()
        if (!t) return
        let ev: Record<string, any> | null = null
        if (t.startsWith('{')) {
          try {
            ev = JSON.parse(t)
          } catch {
            ev = null
          }
        }
        if (ev && typeof ev === 'object') handleEvent(run, ev)
        else {
          keepText(t + '\n')
          output('info', t.slice(0, 400))
        }
      })
    }
    proc.stderr?.on('data', (chunk: Buffer) => keepText(chunk.toString('utf8')))
  }

  function kick(): void {
    wire()
    if (current) return
    const store = ctx.projects.current()
    if (!store || store.readOnly) return update({ status: 'idle' })
    held = false
    const open = ctx.requests.open()
    if (!open.length) return update({ status: 'idle', activeRequestId: undefined, waitingReason: undefined })
    const settings = ctx.settings.get().runner
    if (connectedCount() > 0) {
      // Claude connected by hand (Claude Code or the desktop app) picks up queued requests through get_requests.
      const reason = 'Claude is connected by hand: it picks this up when it checks get_requests.'
      ctx.requests.setWaitingReason(reason)
      return update({ status: 'waiting', waitingReason: reason })
    }
    if (open.some((r) => r.status === 'in_progress')) ctx.requests.requeueInProgress('Claude stopped before finishing this request')
    if (!settings.autoStart) {
      const reason = 'Waiting for Claude to connect (starting Claude automatically is off in Settings).'
      ctx.requests.setWaitingReason(reason)
      return update({ status: 'waiting', waitingReason: reason })
    }
    startRun(store, ctx.requests.open())
  }

  async function stop(): Promise<void> {
    wire()
    const run = current
    if (!run) return
    run.stopping = true
    held = true
    update({ status: 'stopping', lastActivity: 'Stopping Claude…' })
    killTree(run.proc, platform, spawnFn)
    await Promise.race([run.exited, new Promise((r) => setTimeout(r, 8000).unref?.())])
    if (ctx.projects.current()?.project.id === run.projectId) ctx.requests.requeueInProgress('Stopped')
    update({ status: queuedCount() ? 'waiting' : 'idle', waitingReason: queuedCount() ? 'Stopped. Press Resume to continue.' : undefined })
  }

  return {
    state() {
      wire()
      return { ...state, connected: connectedCount() > 0, queue: queuedCount() }
    },
    onState(cb) {
      wire()
      stateListeners.add(cb)
      return () => stateListeners.delete(cb)
    },
    onOutput(cb) {
      outputListeners.add(cb)
      return () => outputListeners.delete(cb)
    },
    kick,
    stop,
    resume() {
      wire()
      held = false
      runsWithoutProgress = 0
      ctx.requests.setWaitingReason(undefined)
      update({ waitingReason: undefined, status: current ? state.status : 'idle' })
      kick()
    },
    isRunning() {
      return !!current
    }
  }
}
