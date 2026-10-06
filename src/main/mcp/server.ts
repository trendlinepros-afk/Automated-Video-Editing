/**
 * The local MCP server Claude connects to. Only programs on this PC can reach it:
 *  - it listens on 127.0.0.1 only,
 *  - every request must carry the app's bearer token,
 *  - requests whose Host or Origin is not localhost are refused (a web page cannot rebind its way in).
 *
 * Endpoints:
 *  - /mcp              works on whichever project is open in the app (Claude connected by hand)
 *  - /mcp/<projectId>  the runner's connection; refuses to work when another project is open
 *
 * Every tool call is validated, applied through ProjectStore.mutate (format check, section lock, undo
 * history, save, window update) and written to the project log with its duration.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { APP_NAME, MCP_SERVER_NAME } from '@shared/appInfo'
import { TimelineResolver } from '@shared/timeline'
import type { AppContext, McpService } from '../context'
import { registerSecret } from '../log'
import type { ProjectStore } from '../project/store'
import { ALL_TOOLS, type ToolDef, type ToolEnv, type ToolResult } from './tools'

/** A session that never opens an event stream counts as connected while it was active this recently. */
const ACTIVE_MS = 120_000
/** Sessions with no stream and no activity for this long are closed. */
const IDLE_CLOSE_MS = 30 * 60_000
const MAX_BODY = 16 * 1024 * 1024

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export const SERVER_INSTRUCTIONS = `${APP_NAME}: the owner's video editor. You make every editing decision; the app shows each change on its timeline and renders it.
Start every session with get_requests, get_project, get_checklist and get_profile. For each request: begin_request, work only inside its range (changes outside a locked range are refused), reply_chat with what you did, finish_request.
Keep the checklist and handoff notes current so an interrupted edit can continue from the next unfinished stage without redoing finished work.`

interface Session {
  id: string
  projectId: string | null
  transport: StreamableHTTPServerTransport
  server: Server
  streams: number
  /** The client opened an event stream at some point: it then counts as connected only while one is open. */
  everStreamed: boolean
  lastSeen: number
  client?: string
}

/** Short, readable summary of tool arguments for the log (code and long text are shortened). */
export function summarizeArgs(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 100)}… (${value.length} chars)` : value
  if (Array.isArray(value)) {
    if (depth > 2) return `[${value.length} items]`
    const head = value.slice(0, 6).map((v) => summarizeArgs(v, depth + 1))
    return value.length > 6 ? [...head, `… (+${value.length - 6} more)`] : head
  }
  if (value && typeof value === 'object') {
    if (depth > 3) return '{…}'
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = summarizeArgs(v, depth + 1)
    return out
  }
  return value
}

function summarizeResult(result: ToolResult): string {
  const parts: string[] = []
  for (const c of result.content ?? []) {
    if (c.type === 'text') parts.push(c.text.length > 300 ? `${c.text.slice(0, 300)}… (${c.text.length} chars)` : c.text)
    else if (c.type === 'image') parts.push('[image]')
  }
  return parts.join(' ').replace(/\s+/g, ' ')
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** JSON schema for a tool's input, as Claude sees it. */
function inputSchema(def: ToolDef): { type: 'object'; [k: string]: unknown } {
  const schema = z.toJSONSchema(z.object(def.input), { io: 'input', target: 'draft-7', unrepresentable: 'any' }) as Record<string, unknown>
  delete schema.$schema
  return { ...schema, type: 'object' }
}

function hostAllowed(host: string | undefined): boolean {
  if (!host) return false
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return LOCAL_HOSTS.has(name.toLowerCase())
}

function originAllowed(origin: string): boolean {
  try {
    const u = new URL(origin)
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname.toLowerCase())
  } catch {
    return false
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

function rpcError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null }, headers)
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('Request too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'))
      } catch {
        reject(new Error('Body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

export interface McpServiceImpl extends McpService {
  /** Port the server is listening on (0 when stopped). */
  port(): number
  /** Clients connected by hand on /mcp (not started by the app's runner). */
  handClients(): number
  /** Close the sessions of a project endpoint (the runner's Claude has exited). */
  closeSessions(projectId: string): Promise<void>
}

export function createMcpService(ctx: AppContext, opts: { tools?: ToolDef[] } = {}): McpServiceImpl {
  const tools = opts.tools ?? ALL_TOOLS
  const byName = new Map(tools.map((t) => [t.name, t]))
  const sessions = new Map<string, Session>()
  const listeners = new Set<(n: number) => void>()
  let http: HttpServer | null = null
  let boundPort = 0
  let timer: NodeJS.Timeout | null = null
  let lastCount = 0
  let cachedToken: string | null = null

  const ensureToken = (): string => {
    if (cachedToken) return cachedToken
    let t = ctx.secrets.get('mcpToken')
    if (!t) {
      t = randomBytes(32).toString('base64url')
      ctx.secrets.set('mcpToken', t)
    }
    registerSecret(t)
    cachedToken = t
    return t
  }

  const authorized = (header: string | undefined): boolean => {
    const m = /^Bearer\s+(.+)$/i.exec(header ?? '')
    if (!m) return false
    const given = Buffer.from(m[1].trim())
    const want = Buffer.from(ensureToken())
    return given.length === want.length && timingSafeEqual(given, want)
  }

  const isConnected = (s: Session, now: number) => s.streams > 0 || (!s.everStreamed && now - s.lastSeen < ACTIVE_MS)

  const countConnected = (filter: (s: Session) => boolean = () => true): number => {
    const now = Date.now()
    let n = 0
    for (const s of sessions.values()) if (filter(s) && isConnected(s, now)) n++
    return n
  }

  const changed = () => {
    const n = countConnected()
    if (n === lastCount) return
    lastCount = n
    for (const cb of listeners) {
      try {
        cb(n)
      } catch {
        /* a listener must not break the server */
      }
    }
  }

  const sweep = () => {
    const now = Date.now()
    for (const s of [...sessions.values()]) {
      if (s.streams === 0 && now - s.lastSeen > IDLE_CLOSE_MS) {
        sessions.delete(s.id)
        void s.transport.close().catch(() => undefined)
      }
    }
    changed()
  }

  const logFor = (store: ProjectStore | null) => store?.log ?? ctx.appLog

  async function callTool(session: Session, name: string, rawArgs: unknown): Promise<ToolResult> {
    const started = Date.now()
    const store = ctx.projects.current()
    const def = byName.get(name)
    const finish = (result: ToolResult, args: unknown): ToolResult => {
      const ms = Date.now() - started
      logFor(store).write('mcp', `${name} ${result.isError ? 'error' : 'ok'} (${ms} ms)`, {
        sent: summarizeArgs(args ?? {}),
        result: summarizeResult(result)
      })
      return result
    }
    if (!def) return finish(toolError(`Unknown tool "${name}".`), rawArgs)
    if (session.projectId && store?.project.id !== session.projectId) {
      return finish(
        toolError(
          store
            ? `This connection is for project ${session.projectId}, but the app now has "${store.project.name}" open. Stop here: the owner switched projects.`
            : `This connection is for project ${session.projectId}, but no project is open in the app. Stop here: the owner closed the project.`
        ),
        rawArgs
      )
    }
    if (def.needsProject !== false && !store) return finish(toolError('No project is open in the app. Ask the owner to open the project first.'), rawArgs)
    const parsed = z.object(def.input).safeParse(rawArgs ?? {})
    if (!parsed.success) {
      const detail = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')
      return finish(toolError(`Invalid input for ${name}: ${detail}`), rawArgs)
    }
    const env: ToolEnv = {
      ctx,
      store: store as ProjectStore,
      dir: store?.dir ?? '',
      mutate: (label, fn, o) => store!.mutate(label, 'claude', fn, o),
      resolver: () => new TimelineResolver(store!.project, store!.transcript)
    }
    try {
      return finish(await def.run(parsed.data, env), parsed.data)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return finish(toolError(message), parsed.data)
    }
  }

  function buildServer(session: Session): Server {
    const server = new Server({ name: MCP_SERVER_NAME, version: ctx.appVersion }, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS })
    const listed = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t) }))
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }))
    server.setRequestHandler(CallToolRequestSchema, async (req) => callTool(session, req.params.name, req.params.arguments))
    server.oninitialized = () => {
      const info = server.getClientVersion()
      session.client = info ? `${info.name} ${info.version}` : 'unknown client'
      const store = ctx.projects.current()
      logFor(store).write('mcp', `Claude connected (${session.client})${session.projectId ? ' for this project' : ''}`)
    }
    return server
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req.headers.host)) return rpcError(res, 403, 'Forbidden: only local connections are accepted')
    const origin = req.headers.origin
    if (origin && !originAllowed(origin)) return rpcError(res, 403, 'Forbidden origin')
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const m = /^\/mcp(?:\/([A-Za-z0-9_-]+))?\/?$/.exec(url.pathname)
    if (!m) return rpcError(res, 404, 'Not found')
    if (!authorized(req.headers.authorization)) return rpcError(res, 401, 'Missing or wrong token', { 'WWW-Authenticate': 'Bearer' })
    const projectId = m[1] ?? null

    const sid = req.headers['mcp-session-id']
    if (typeof sid === 'string' && sid) {
      const s = sessions.get(sid)
      if (!s) return rpcError(res, 404, 'Session not found. Reconnect.')
      if (s.projectId !== projectId) return rpcError(res, 400, 'This session belongs to another endpoint')
      s.lastSeen = Date.now()
      if (req.method === 'GET') {
        s.streams++
        s.everStreamed = true
        res.on('close', () => {
          s.streams = Math.max(0, s.streams - 1)
          s.lastSeen = Date.now()
          changed()
        })
      }
      changed()
      await s.transport.handleRequest(req, res)
      return
    }

    if (req.method !== 'POST') return rpcError(res, 400, 'No session. Send an initialize request first.')
    let body: unknown
    try {
      body = await readBody(req)
    } catch (err) {
      return rpcError(res, 400, err instanceof Error ? err.message : 'Bad request')
    }
    if (!isInitializeRequest(body)) return rpcError(res, 400, 'No session. Send an initialize request first.')

    const session = { id: '', projectId, streams: 0, everStreamed: false, lastSeen: Date.now() } as Session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        session.id = id
        sessions.set(id, session)
        changed()
      },
      onsessionclosed: (id) => {
        sessions.delete(id)
        changed()
      }
    })
    transport.onclose = () => {
      if (session.id) sessions.delete(session.id)
      changed()
    }
    session.transport = transport
    session.server = buildServer(session)
    await session.server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  return {
    async start() {
      if (http) return
      ensureToken()
      const port = ctx.settings.get().mcpPort
      const server = createServer((req, res) => {
        handle(req, res).catch((err) => {
          ctx.appLog.write('error', 'MCP request failed', { error: err instanceof Error ? err.stack ?? err.message : String(err) })
          rpcError(res, 500, 'Internal error')
        })
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', (err: NodeJS.ErrnoException) => {
          reject(
            err.code === 'EADDRINUSE'
              ? new Error(`Port ${port} is already used by another program. Choose another Claude connection port in Settings.`)
              : err
          )
        })
        server.listen(port, '127.0.0.1', () => resolve())
      })
      http = server
      boundPort = (server.address() as AddressInfo).port
      timer = setInterval(sweep, 10_000)
      timer.unref?.()
      ctx.appLog.write('app', `Claude connection (MCP) listening on 127.0.0.1:${boundPort}`)
    },

    async stop() {
      if (timer) clearInterval(timer)
      timer = null
      for (const s of sessions.values()) await s.transport.close().catch(() => undefined)
      sessions.clear()
      changed()
      if (http) {
        const h = http
        http = null
        h.closeAllConnections?.()
        await new Promise<void>((resolve) => h.close(() => resolve()))
      }
      boundPort = 0
    },

    url(projectId?: string) {
      const port = boundPort || ctx.settings.get().mcpPort
      return `http://127.0.0.1:${port}/mcp${projectId ? `/${projectId}` : ''}`
    },

    token() {
      return ensureToken()
    },

    connectedClients() {
      return countConnected()
    },

    onClientsChanged(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },

    port() {
      return boundPort
    },

    handClients() {
      return countConnected((s) => s.projectId === null)
    },

    async closeSessions(projectId) {
      for (const s of [...sessions.values()]) {
        if (s.projectId !== projectId) continue
        sessions.delete(s.id)
        await s.transport.close().catch(() => undefined)
      }
      changed()
    }
  }
}
