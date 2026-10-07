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
import type { AppContext, RunnerService } from '../context'
import type { McpServiceImpl } from '../mcp/server'
import type { ProjectStore } from '../project/store'
import { buildRunPrompt, buildSystemPrompt } from './prompts'
import { saveNewAssetsToLibrary } from '../project/autoLibrary'
import { recordRunCost } from './costs'
import { doneStageCount, planRun, stageInstructions, type RunPlan } from './stages'

type OutputLine = { ts: string; text: string; kind: 'text' | 'tool' | 'error' | 'info' }

export interface RunnerDeps {
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  platform?: NodeJS.Platform
  /** Timers for automatic retries (tests replace them). */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  now?: () => number
}

/** Replace {placeholders} inside each argument. One argument stays one argument, whatever its content. */
export function templateArgs(args: string[], vars: Record<string, string>): string[] {
  return args.map((a) => a.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? vars[name] : m)))
}

export type Outcome =
  | { kind: 'ok' }
  | { kind: 'not_found' | 'auth' | 'resume_failed' | 'error' | 'transient' | 'stopped'; reason: string }
  | { kind: 'limit'; reason: string; resetsAt?: Date }

const LIMIT_RE = /usage limit|limit reached|hit your limit|limit will reset|resets? at|rate.?limit(ed)?|quota exceeded|out of (extra )?usage|credit balance is too low/i
const AUTH_RE = /invalid api key|please run \/login|run \/login|not logged in|not signed in|log ?in again|sign ?in again|authentication[_ ](failed|error|required)|oauth token (has )?expired|invalid bearer|401 unauthorized/i
// The connection dropped or Anthropic was busy: worth trying again on its own (Wi-Fi back after a power cut).
const TRANSIENT_RE = /overloaded|\b529\b|\b50[234]\b|internal server error|api error: 5\d\d|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|connection (error|refused|reset)|network error|fetch failed|socket hang up|request timed out/i
const RESUME_RE = /no conversation found|session (id )?.*not found|could not (find|resume) (the )?session|cannot resume/i

/** When the usage limit resets, if Claude Code says ("Claude AI usage limit reached|<unix seconds>" in some versions). */
export function limitResetsAt(text: string): Date | undefined {
  const epoch = /limit reached\|(\d{9,})/i.exec(text)
  return epoch ? new Date(Number(epoch[1]) * 1000) : undefined
}

function limitReason(text: string): string {
  const at = limitResetsAt(text)
  if (at) return `Claude usage limit reached. It resets at ${at.toLocaleString()}.`
  if (/credit balance is too low/i.test(text)) return 'Your Anthropic API credit balance is too low. Add credits (console.anthropic.com > Billing).'
  const resets = /resets?\s+(?:at\s+)?([^\n.·|]{2,40})/i.exec(text)
  return `Claude usage limit reached${resets ? ` (resets ${resets[1].trim()})` : ''}.`
}

/** Automatic retries while Claude is out of usage or credits: on the reset time when known, else this often. */
export const LIMIT_RETRY_MS = 30 * 60_000
/** After a dropped connection or a busy API: 1, 2, 5, 10, then every 30 minutes. */
export const TRANSIENT_RETRY_MS = [60_000, 120_000, 300_000, 600_000, 30 * 60_000]

/** How long to wait before trying again on its own, or null when it needs the owner. */
export function retryDelay(outcome: Outcome, transientTries: number, now = Date.now()): number | null {
  if (outcome.kind === 'limit') {
    if (outcome.resetsAt && outcome.resetsAt.getTime() > now) return Math.min(outcome.resetsAt.getTime() - now + 60_000, 12 * 3600_000)
    return LIMIT_RETRY_MS
  }
  if (outcome.kind === 'transient') return TRANSIENT_RETRY_MS[Math.min(transientTries, TRANSIENT_RETRY_MS.length - 1)]
  return null
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
  if (failed && LIMIT_RE.test(all)) {
    const resetsAt = limitResetsAt(all)
    return { kind: 'limit', reason: limitReason(all), ...(resetsAt ? { resetsAt } : {}) }
  }
  if (failed && AUTH_RE.test(all)) return { kind: 'auth', reason: 'Claude Code is signed out. Open a terminal, run "claude" and sign in, then press Resume.' }
  if (failed && TRANSIENT_RE.test(all)) {
    const detail = (r.result?.result || r.result?.error || r.text.trim().split('\n').filter(Boolean).pop() || '').slice(0, 200)
    return { kind: 'transient', reason: `Claude lost its connection or Anthropic was busy${detail ? ` (${detail})` : ''}.` }
  }
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
  plan: RunPlan
  doneBefore: number
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
  let waitingForHand = false
  let unwatchStore: (() => void) | null = null
  // Automatic retry after a usage limit, low credits or a dropped connection.
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref?.() ?? null)
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout))
  const now = deps.now ?? (() => Date.now())
  let retryTimer: unknown = null
  let transientTries = 0
  const cancelRetry = () => {
    if (retryTimer !== null) clearTimer(retryTimer)
    retryTimer = null
  }

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

  /** Clients connected by hand (Claude Code or the desktop app), not the one this runner started. */
  const handCount = (): number => {
    try {
      const mcp = ctx.mcp as Partial<McpServiceImpl>
      if (mcp.handClients) return mcp.handClients()
      return current ? 0 : ctx.mcp.connectedClients()
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

  // The last lines Claude printed, for the diagnostics zip.
  const recent: OutputLine[] = []
  const output = (kind: OutputLine['kind'], text: string, log = true) => {
    const line: OutputLine = { ts: new Date().toISOString(), text, kind }
    recent.push(line)
    if (recent.length > 500) recent.shift()
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
      // When the hand-connected client goes away, the app starts Claude itself for what is still queued.
      if (!current && waitingForHand && handCount() === 0 && !held) kick()
    })
    ctx.projects.onOpened((store) => {
      watchStore(store)
      if (current && (!store || store.project.id !== current.projectId)) void stop()
      runsWithoutProgress = 0
      transientTries = 0
      held = false
      cancelRetry()
      update({ pausedAt: undefined, waitingReason: undefined, sessionId: store?.project.claudeSessionId, status: current ? state.status : 'idle' })
      if (!current && store && !store.readOnly) showInterrupted(store)
    })
    watchStore(ctx.projects.current())
  }

  /**
   * On opening a project with unfinished requests (the app closed, crashed or lost power while Claude worked, or it
   * was waiting for usage to reset): put them back in the queue and say where the edit will carry on from.
   * Nothing is redone: finished stages are ticked on the checklist and every change was saved as it was made.
   */
  const showInterrupted = (store: ProjectStore): void => {
    const open = store.project.requests.filter((r) => r.status === 'queued' || r.status === 'in_progress')
    if (!open.length) return
    const wasRunning = open.some((r) => r.status === 'in_progress')
    if (wasRunning) ctx.requests.requeueInProgress('The app closed while Claude was working on this (power cut, crash or restart).')
    const next = store.project.checklist.find((c) => c.status !== 'done')
    const started = store.project.checklist.some((c) => c.status !== 'not_started')
    const editing = open.some((r) => r.kind === 'start_edit' || r.kind === 'resume' || r.kind === 'continue_intro')
    const where = editing && started && next ? ` It carries on from: ${next.label}.` : ''
    const reason = wasRunning
      ? `Claude was interrupted.${where} Finished work is saved. Press Resume to continue.`
      : `${open.length} request${open.length > 1 ? 's' : ''} waiting.${where} Press Resume to continue.`
    ctx.requests.setWaitingReason(reason)
    update({ status: 'waiting', waitingReason: reason })
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

  const saveSessionId = (store: ProjectStore, id: string | undefined, model?: string) => {
    if (store.readOnly || (store.project.claudeSessionId === id && (model === undefined || store.project.claudeSessionModel === model))) return
    try {
      store.mutate('Claude session', 'app', (d) => {
        if (id) {
          d.project.claudeSessionId = id
          if (model !== undefined) d.project.claudeSessionModel = model
        } else {
          delete d.project.claudeSessionId
          delete d.project.claudeSessionModel
        }
      }, { bypassLock: true, noHistory: true })
    } catch (err) {
      store.log.write('error', 'Could not save the Claude session id', { error: String(err) })
    }
  }

  const handleEvent = (run: Run, ev: Record<string, any>) => {
    if (typeof ev.session_id === 'string' && ev.session_id && ev.session_id !== run.sessionId) {
      run.sessionId = ev.session_id
      saveSessionId(run.store, ev.session_id, run.plan.model)
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
          const cost = typeof ev.total_cost_usd === 'number' ? `est. $${ev.total_cost_usd.toFixed(2)}` : ''
          output('info', `Claude finished${turns || secs || cost ? ` (${[turns, secs, cost].filter(Boolean).join(', ')})` : ''}`)
        }
        break
    }
  }

  const finishRun = (run: Run, exitCode: number | null) => {
    if (current === run) current = null
    rmSync(run.configFile, { force: true })
    void (ctx.mcp as Partial<McpServiceImpl>).closeSessions?.(run.projectId)
    const outcome = classifyOutcome({ ...run, exitCode })
    const store = run.store
    // What the run cost, as Claude Code reports it, whatever the outcome: tokens were used either way.
    if (run.result) {
      try {
        recordRunCost(ctx, store, run.plan, run.result)
      } catch (err) {
        store.log.write('error', 'Could not record what the Claude run cost', { error: String(err) })
      }
    }
    // Whatever Claude made in this run goes into the asset library (Claude saves most itself, with descriptions).
    void saveNewAssetsToLibrary(ctx, store)
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
      transientTries = 0
      const finished = run.startOpenIds.filter((id) => !stillOpen.some((r) => r.id === id))
      // A staged run makes progress by finishing checklist stages, not requests.
      const stagesAdvanced = doneStageCount(store.project) > run.doneBefore
      runsWithoutProgress = finished.length || stagesAdvanced ? 0 : runsWithoutProgress + 1
      if (stillOpen.some((r) => r.status === 'in_progress')) {
        ctx.requests.requeueInProgress(stagesAdvanced ? 'Continuing with the next stage' : 'Claude stopped before finishing this request')
      }
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
    // Out of usage or credits, or the connection dropped: everything finished so far is saved, and the app tries
    // again on its own (when the limit resets, or after a short wait) and carries on from the same stage.
    const delay = sameProject && ctx.settings.get().runner.autoRetry !== false ? retryDelay(outcome, transientTries, now()) : null
    if (delay !== null) {
      if (outcome.kind === 'transient') transientTries++
      cancelRetry()
      const projectId = run.projectId
      retryTimer = setTimer(() => {
        retryTimer = null
        if (current || held || ctx.projects.current()?.project.id !== projectId) return
        output('info', 'Trying again')
        kick()
      }, delay)
      const at = new Date(now() + delay)
      const when = delay >= 3600_000 ? at.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      const full = `${reason} Finished work is saved. Trying again on its own at ${when}, or press Resume.`
      if (sameProject) ctx.requests.setWaitingReason(full)
      return update({ status: 'waiting', waitingReason: full, activeRequestId: undefined, lastActivity: reason, pausedAt: pausedAt(store) })
    }
    const waiting = outcome.kind === 'not_found' || outcome.kind === 'limit' || outcome.kind === 'auth' || outcome.kind === 'transient'
    update({ status: waiting ? 'waiting' : 'error', waitingReason: reason, activeRequestId: undefined, lastActivity: reason, pausedAt: pausedAt(store) })
  }

  const startNext = (): void => {
    const store = ctx.projects.current()
    if (!store || store.readOnly) return update({ status: 'idle', activeRequestId: undefined })
    const plan = planRun(ctx.requests.open(), store.project, ctx.settings.get().claude?.models ?? {})
    if (!plan) return update({ status: 'idle', activeRequestId: undefined })
    startRun(store, plan)
  }

  const startRun = (store: ProjectStore, plan: RunPlan) => {
    const settings = ctx.settings.get().runner
    const project = store.project
    const open = plan.requests
    // A session is continued only on the model it ran on; another model starts fresh from the
    // checklist and handoff notes (cheaper than carrying the whole history over).
    // (A session saved before models were tracked has no model recorded: continue it.)
    const sameModel = project.claudeSessionModel === undefined || project.claudeSessionModel === plan.model
    const sessionId = forceFresh || !sameModel ? undefined : project.claudeSessionId
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
      prompt: [buildRunPrompt(open, project, { resumed: !!sessionId }), stageInstructions(plan)].filter(Boolean).join('\n\n'),
      systemPrompt: buildSystemPrompt(ctx.profiles.get(project.profileId)),
      mcpConfig: configFile,
      allowedTools: settings.allowedTools,
      sessionId: sessionId ?? ''
    }
    const args = [...templateArgs(settings.args, vars), ...(sessionId ? templateArgs(settings.resumeArgs, vars) : [])]
    // The model for this part of the edit (Settings > Claude models). '' leaves Claude Code's own default.
    if (plan.model && !args.includes('--model')) args.push('--model', plan.model)
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
      command: settings.command,
      plan,
      doneBefore: doneStageCount(project)
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
    store.log.write('claude', `Starting Claude${sessionId ? ' (continuing the earlier session)' : ''} on ${plan.model || 'its default model'}`, {
      command: settings.command,
      section: plan.section,
      stages: plan.stages,
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
    waitingForHand = false
    if (handCount() > 0) {
      // Claude connected by hand (Claude Code or the desktop app) picks up queued requests through get_requests.
      const reason = 'Claude is connected by hand: it picks this up when it checks get_requests.'
      waitingForHand = true
      ctx.requests.setWaitingReason(reason)
      return update({ status: 'waiting', waitingReason: reason })
    }
    if (open.some((r) => r.status === 'in_progress')) ctx.requests.requeueInProgress('Claude stopped before finishing this request')
    if (!settings.autoStart) {
      const reason = 'Waiting for Claude to connect (starting Claude automatically is off in Settings).'
      ctx.requests.setWaitingReason(reason)
      return update({ status: 'waiting', waitingReason: reason })
    }
    const plan = planRun(ctx.requests.open(), store.project, ctx.settings.get().claude?.models ?? {})
    if (plan) startRun(store, plan)
  }

  async function stop(): Promise<void> {
    wire()
    const run = current
    if (!run) return
    run.stopping = true
    held = true
    cancelRetry()
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
      transientTries = 0
      cancelRetry()
      ctx.requests.setWaitingReason(undefined)
      update({ waitingReason: undefined, status: current ? state.status : 'idle' })
      kick()
    },
    isRunning() {
      return !!current
    },
    recentOutput() {
      return [...recent]
    }
  }
}
