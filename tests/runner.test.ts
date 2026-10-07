import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectSettingsSchema, type EditRequest } from '@shared/project'
import { DEFAULT_RUNNER_ARGS, SettingsSchema } from '@shared/settings'
import type { RunnerState } from '@shared/ipc'
import type { AppContext } from '../src/main/context'
import { ActivityLog } from '../src/main/log'
import { ProjectStore } from '../src/main/project/store'
import { buildRunPrompt, buildSystemPrompt } from '../src/main/runner/prompts'
import { LIMIT_RETRY_MS, TRANSIENT_RETRY_MS, classifyOutcome, createRunnerService, retryDelay, templateArgs } from '../src/main/runner/runner'

/** A stand-in for Claude Code: prints stream-json lines like `claude -p --output-format stream-json`. */
const FAKE_CLAUDE = String.raw`
const fs = require('fs')
const [mode, record, doneMarker] = process.argv.slice(2, 5)
const args = process.argv.slice(5)
fs.appendFileSync(record, JSON.stringify(args) + '\n')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const resumed = args.includes('--resume')
if (mode === 'resume_fail' && resumed) {
  process.stderr.write('No conversation found with session ID: ' + args[args.indexOf('--resume') + 1] + '\n')
  process.exit(1)
}
const sid = resumed ? args[args.indexOf('--resume') + 1] : 'sess_' + Math.random().toString(36).slice(2, 8)
out({ type: 'system', subtype: 'init', session_id: sid, mcp_servers: [{ name: 'ave', status: 'connected' }] })
out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: 'Reading the project.' }, { type: 'tool_use', name: 'mcp__ave__get_requests', input: {} }] } })
if (mode === 'overloaded') {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', session_id: sid })
  process.exit(1)
}
if (mode === 'limit') {
  out({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1900000000', session_id: sid })
  process.exit(1)
}
fs.writeFileSync(doneMarker, 'done')
out({ type: 'result', subtype: 'success', is_error: false, result: 'Done', num_turns: 3, duration_ms: 1200, session_id: sid })
`

let dir: string
let store: ProjectStore
let script: string
let record: string
let marker: string
let requeued: string[]
let waiting: (string | undefined)[]
let requests: EditRequest[]
let openedCb: ((s: ProjectStore | null) => void) | null

function makeCtx(mode: string): AppContext {
  const settings = SettingsSchema.parse({})
  settings.runner.command = process.execPath
  settings.runner.args = [script, mode, record, marker, ...DEFAULT_RUNNER_ARGS]
  return {
    appLog: new ActivityLog(join(dir, 'app.log')),
    settings: { get: () => settings },
    profiles: { get: () => null },
    projects: {
      current: () => store,
      onOpened: (cb: (s: ProjectStore | null) => void) => {
        openedCb = cb
        return () => {}
      }
    },
    mcp: {
      url: (id?: string) => `http://127.0.0.1:47821/mcp${id ? '/' + id : ''}`,
      token: () => 'tok_secret_value_123',
      connectedClients: () => 0,
      handClients: () => 0,
      onClientsChanged: () => () => {}
    },
    requests: {
      // The fake Claude "finishes" the work by writing the marker file.
      open: () => (existsSync(marker) ? [] : requests),
      requeueInProgress: (r: string) => void requeued.push(r),
      setWaitingReason: (r: string | undefined) => void waiting.push(r)
    },
    send: () => {}
  } as unknown as AppContext
}

async function waitIdle(runner: ReturnType<typeof createRunnerService>): Promise<RunnerState> {
  const until = Date.now() + 20000
  await new Promise((r) => setTimeout(r, 50))
  while (runner.isRunning() && Date.now() < until) await new Promise((r) => setTimeout(r, 25))
  return runner.state()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ave-runner-'))
  script = join(dir, 'fake-claude.cjs')
  writeFileSync(script, FAKE_CLAUDE)
  record = join(dir, 'calls.jsonl')
  marker = join(dir, 'done')
  requeued = []
  waiting = []
  openedCb = null
  store = ProjectStore.create(join(dir, 'proj'), {
    name: 'Run',
    profileId: 'p1',
    footageFolder: dir,
    settings: ProjectSettingsSchema.parse({}),
    thumbnails: { personaId: '', styleId: '', count: 3, direction: '' },
    appVersion: '1.0.0-test'
  })
  requests = [{ id: 'req_1', kind: 'start_edit', status: 'queued', createdAt: new Date().toISOString(), text: 'Fast and funny', context: {} }]
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const calls = () => readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[])

describe('runner', () => {
  it('fills placeholders, one argument each', () => {
    const args = templateArgs(['-p', '{prompt}', '--mcp-config', '{mcpConfig}', '--x={sessionId}', '{unknown}'], {
      prompt: 'line one\nline "two"',
      mcpConfig: 'C:\\p\\cache\\claude-mcp.json',
      sessionId: 'abc'
    })
    expect(args).toEqual(['-p', 'line one\nline "two"', '--mcp-config', 'C:\\p\\cache\\claude-mcp.json', '--x=abc', '{unknown}'])
  })

  it('classifies usage limits, sign-out and a missing command', () => {
    const base = { stopping: false, resumed: false, exitCode: 1, text: '', command: 'claude' }
    expect(classifyOutcome({ ...base, result: { is_error: true, result: 'Claude AI usage limit reached|1900000000' } }).kind).toBe('limit')
    expect(classifyOutcome({ ...base, result: null, text: 'Invalid API key · Please run /login' }).kind).toBe('auth')
    const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
    expect(classifyOutcome({ ...base, spawnError: enoent, result: null })).toMatchObject({ kind: 'not_found' })
    expect(classifyOutcome({ ...base, exitCode: 0, result: { is_error: false, result: 'ok' } }).kind).toBe('ok')
  })

  it('starts Claude with the prompt, MCP config and system prompt, streams progress and keeps the session id', async () => {
    const runner = createRunnerService(makeCtx('ok'))
    const lines: string[] = []
    runner.onOutput((l) => lines.push(`${l.kind}:${l.text}`))
    const states: RunnerState[] = []
    runner.onState((s) => states.push(s))
    runner.kick()
    const end = await waitIdle(runner)
    expect(end.status).toBe('idle')
    const [args] = calls()
    const prompt = args[args.indexOf('-p') + 1]
    expect(prompt).toContain('req_1')
    expect(prompt).toContain('Fast and funny')
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain('Standard editing rules')
    expect(args[args.indexOf('--allowedTools') + 1]).toContain('mcp__ave')
    const configPath = args[args.indexOf('--mcp-config') + 1]
    expect(configPath.startsWith(store.paths.cache)).toBe(true)
    expect(existsSync(configPath)).toBe(false) // removed after the run
    expect(lines).toContain('text:Reading the project.')
    expect(lines).toContain('tool:get_requests')
    expect(states.some((s) => s.status === 'running')).toBe(true)
    expect(store.project.claudeSessionId).toMatch(/^sess_/)
    expect(readFileSync(store.log.file, 'utf8')).not.toContain('tok_secret_value_123')
  })

  it('leaves the request queued when Claude hits its usage limit, and tries again on its own when it resets', async () => {
    const timers: { fn: () => void; ms: number }[] = []
    const now = 1899990000 * 1000 // 10 000 s before the reset Claude reports (1900000000)
    const runner = createRunnerService(makeCtx('limit'), { setTimer: (fn, ms) => timers.push({ fn, ms }), clearTimer: () => undefined, now: () => now })
    runner.kick()
    const end = await waitIdle(runner)
    expect(end.status).toBe('waiting')
    expect(end.waitingReason).toMatch(/usage limit/i)
    expect(end.waitingReason).toMatch(/Trying again on its own/)
    expect(waiting.at(-1)).toMatch(/usage limit/i)
    expect(requeued.at(-1)).toMatch(/usage limit/i)
    expect(calls()).toHaveLength(1)
    // One retry, a minute after the reset time.
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(10_000_000 + 60_000)
    timers[0].fn()
    await waitIdle(runner)
    expect(calls()).toHaveLength(2) // it ran again, from the same request
  })

  it('retries after a dropped connection or a busy API, waiting longer each time, and not after Stop or with retries off', async () => {
    const timers: { fn: () => void; ms: number }[] = []
    const ctx = makeCtx('overloaded')
    const runner = createRunnerService(ctx, { setTimer: (fn, ms) => timers.push({ fn, ms }), clearTimer: () => undefined })
    runner.kick()
    expect((await waitIdle(runner)).waitingReason).toMatch(/lost its connection or Anthropic was busy/)
    timers[0].fn()
    await waitIdle(runner)
    expect(timers.map((t) => t.ms)).toEqual([60_000, 120_000])
    expect(calls()).toHaveLength(2)

    ctx.settings.get().runner.autoRetry = false
    timers[1].fn()
    await waitIdle(runner)
    expect(timers).toHaveLength(2) // no new retry scheduled
    expect(runner.state().status).toBe('waiting')
  })

  it('on opening a project that was interrupted mid-run, puts the work back in the queue and says where it carries on', () => {
    const runner = createRunnerService(makeCtx('ok'))
    runner.state() // wires the project listener
    store.mutate('interrupted', 'app', (d) => {
      d.project.status = 'editing'
      d.project.requests.push({ id: 'req_9', kind: 'start_edit', status: 'in_progress', createdAt: new Date().toISOString(), text: '', context: {} } as EditRequest)
      for (const c of d.project.checklist) if (c.id === 'transcript' || c.id === 'cuts') c.status = 'done'
    }, { noHistory: true })
    openedCb!(store)
    expect(requeued.at(-1)).toMatch(/app closed while Claude was working/)
    const s = runner.state()
    expect(s.status).toBe('waiting')
    expect(s.waitingReason).toMatch(/Claude was interrupted\. It carries on from: B-roll\. Finished work is saved\. Press Resume/)
    expect(calls).toThrow() // nothing started on its own
  })

  it('classifies dropped connections and a busy API as worth retrying', () => {
    const base = { stopping: false, resumed: false, exitCode: 1, text: '', command: 'claude' }
    expect(classifyOutcome({ ...base, result: null, text: 'Error: fetch failed (ENOTFOUND api.anthropic.com)' }).kind).toBe('transient')
    expect(classifyOutcome({ ...base, result: { is_error: true, result: 'API Error: 529 overloaded_error' } }).kind).toBe('transient')
    expect(classifyOutcome({ ...base, result: { is_error: true, result: 'Credit balance is too low' } })).toMatchObject({ kind: 'limit', reason: expect.stringMatching(/credit balance/i) })
    expect(retryDelay({ kind: 'limit', reason: '' }, 0)).toBe(LIMIT_RETRY_MS)
    expect(retryDelay({ kind: 'transient', reason: '' }, 9)).toBe(TRANSIENT_RETRY_MS.at(-1))
    expect(retryDelay({ kind: 'auth', reason: '' }, 0)).toBeNull()
  })

  it('continues the earlier session with --resume, and starts fresh when it cannot be resumed', async () => {
    store.mutate('session', 'app', (d) => {
      d.project.claudeSessionId = 'sess_old'
    }, { noHistory: true })
    const runner = createRunnerService(makeCtx('resume_fail'))
    runner.kick()
    await waitIdle(runner)
    await waitIdle(runner)
    const all = calls()
    expect(all[0]).toContain('--resume')
    expect(all[0][all[0].indexOf('--resume') + 1]).toBe('sess_old')
    expect(all[1]).not.toContain('--resume')
    expect(store.project.claudeSessionId).toMatch(/^sess_/)
    expect(store.project.claudeSessionId).not.toBe('sess_old')
  })

  it('reports a missing command as waiting, not as a crash', async () => {
    const ctx = makeCtx('ok')
    ctx.settings.get().runner.command = join(dir, 'no-such-claude')
    const runner = createRunnerService(ctx)
    runner.kick()
    const end = await waitIdle(runner)
    expect(end.status).toBe('waiting')
    expect(end.waitingReason).toMatch(/not found/)
  })

  it('builds the prompts from the queue and the profile rules', () => {
    const sys = buildSystemPrompt({ name: 'RC', editingRules: '', rules: [{ id: 'r', text: 'Keep music quiet', enabled: true }, { id: 'o', text: 'Off rule', enabled: false }], channelNotes: 'Loud and fast' } as any)
    expect(sys).toContain('Keep music quiet')
    expect(sys).not.toContain('Off rule')
    expect(sys).toContain('begin_request')
    const p = { ...store.project, scope: { ...store.project.scope, mode: 'intro' as const, introMaxSeconds: 20 } }
    const prompt = buildRunPrompt(requests, p, { resumed: false })
    expect(prompt).toContain('JUST THE INTRO')
    expect(prompt).toContain('at most 20 seconds')
    expect(prompt).toContain('set_intro_end')
  })
})
