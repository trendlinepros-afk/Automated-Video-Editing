import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ProjectSettingsSchema } from '@shared/project'
import { SettingsSchema } from '@shared/settings'
import type { AppContext } from '../src/main/context'
import { ActivityLog } from '../src/main/log'
import { createMcpService, type McpServiceImpl } from '../src/main/mcp/server'
import { createRequestService } from '../src/main/project/requests'
import { ProjectStore } from '../src/main/project/store'

let dir: string
const themeState: any = {
  id: 'vt_test1', name: 'Fast RC style', createdAt: '', source: { kind: 'video', input: 'x' }, notes: 'Copy the pace',
  averages: { cutsPerMinute: 24, cutsPerMinuteFirst30s: 40, medianShotSeconds: 1.8 },
  videos: [{ title: 'Ref', stats: { analyzedSeconds: 600, cutsPerMinute: 24, cutsPerMinuteFirst30s: 40, shotSeconds: { median: 1.8 }, pace: [{ from: 0, cutsPerMinute: 40 }], cutTimes: [1.2, 2.9], sheets: [{ file: 'v1-hook.jpg', label: 'one frame from each shot in the first minute' }] } }]
}
let store: ProjectStore
let mcp: McpServiceImpl
let ctx: AppContext
const clients: Client[] = []

function makeCtx(): AppContext {
  const secrets = new Map<string, string>()
  const settings = SettingsSchema.parse({ mcpPort: 0 })
  const c = {
    appVersion: '1.0.0-test',
    isPackaged: false,
    appLog: new ActivityLog(join(dir, 'app.log')),
    settings: { get: () => settings, update: (p: object) => Object.assign(settings, p), onChange: () => () => {} },
    secrets: { get: (n: string) => secrets.get(n) ?? null, set: (n: string, v: string | null) => (v ? secrets.set(n, v) : secrets.delete(n)) },
    profiles: { get: () => null, list: () => [] },
    projects: { current: () => store },
    versions: { save: (name: string) => ({ id: `v_${name.length}`, name, createdAt: new Date().toISOString(), auto: true }) },
    runner: { kick: () => {} },
    preview: { invalidate: () => {} },
    themes: {
      get: (id: string) => (id === themeState.id ? themeState : null),
      dir: () => join(dir, 'theme'),
      update: (_id: string, patch: { summary?: string }) => Object.assign(themeState, patch)
    },
    engine: {
      probe: async (p: string) => ({ kind: p.endsWith('.png') ? 'image' : 'video', duration: 8, fps: 30, width: 1920, height: 1080, hasAudio: false }),
      frame: async (_doc: unknown, _dir: string, _time: number, o: { out: string; footageOnly?: boolean }) => {
        if (!o.footageOnly) throw new Error('the base picture must be the clean footage')
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080', '-frames:v', '1', o.out])
        return o.out
      }
    },
    env: { ffmpeg: () => 'ffmpeg' },
    send: () => {}
  } as unknown as AppContext
  c.requests = createRequestService(c)
  return c
}

async function connect(path = ''): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(mcp.url() + path), {
    requestInit: { headers: { Authorization: `Bearer ${mcp.token()}` } }
  })
  await client.connect(transport)
  clients.push(client)
  return client
}

function rawPost(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: mcp.port(), path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      }
    )
    req.on('error', reject)
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }))
  })
}

const textOf = (r: any): string => (r.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ave-mcp-'))
  store = ProjectStore.create(join(dir, 'proj'), {
    name: 'Test',
    profileId: 'p1',
    footageFolder: dir,
    settings: ProjectSettingsSchema.parse({}),
    thumbnails: { personaId: '', styleId: '', count: 3, direction: '' },
    appVersion: '1.0.0-test'
  })
  store.mutate('add source', 'app', (d) => {
    d.project.sources.push({ id: 'src1', path: join(dir, 'a.mp4'), kind: 'video', duration: 60, hasAudio: true, origin: 'footage' })
  })
  ctx = makeCtx()
  mcp = createMcpService(ctx)
  ctx.mcp = mcp
  await mcp.start()
})

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => undefined)
  await mcp.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('MCP server', () => {
  it('listens on localhost only and rejects requests without the token or from a foreign host', async () => {
    expect(mcp.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(await rawPost({})).toBe(401)
    expect(await rawPost({ Authorization: 'Bearer wrong-token-value' })).toBe(401)
    expect(await rawPost({ Authorization: `Bearer ${mcp.token()}`, Host: 'evil.example.com' })).toBe(403)
    expect(await rawPost({ Authorization: `Bearer ${mcp.token()}`, Origin: 'https://evil.example.com' })).toBe(403)
  })

  it('lists the tools with descriptions and counts connected clients', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    for (const n of ['get_project', 'set_aroll_cuts', 'add_item', 'get_audio_energy', 'write_graphic', 'begin_request', 'run_self_check', 'request_thumbnails']) {
      expect(names).toContain(n)
    }
    expect(tools.every((t) => (t.description ?? '').length > 20)).toBe(true)
    expect(mcp.connectedClients()).toBeGreaterThan(0)
    expect(mcp.handClients()).toBeGreaterThan(0)
  })

  it('saves a transcript, sets cuts and places an item anchored to a word', async () => {
    const client = await connect()
    const words = ['hello', 'there', 'this', 'is', 'a', 'test'].map((text, i) => ({ text, start: i, end: i + 0.8 }))
    const saved = await client.callTool({ name: 'save_transcript', arguments: { source_id: 'src1', words } })
    expect(saved.isError).toBeFalsy()
    expect(store.transcript.clips.src1.words[3].id).toBe('src1_w3')

    const cuts = await client.callTool({
      name: 'set_aroll_cuts',
      arguments: { segments: [{ source_id: 'src1', in: 0, out: 2 }, { source_id: 'src1', in: 3, out: 6 }] }
    })
    expect(cuts.isError).toBeFalsy()
    const segIds = store.project.items.filter((i) => i.type === 'segment').map((i) => i.id)
    expect(segIds).toHaveLength(2)

    // Re-sending the same cuts keeps the ids.
    await client.callTool({ name: 'set_aroll_cuts', arguments: { segments: [{ source_id: 'src1', in: 0, out: 2 }, { source_id: 'src1', in: 3, out: 6 }] } })
    expect(store.project.items.filter((i) => i.type === 'segment').map((i) => i.id)).toEqual(segIds)

    const g = await client.callTool({ name: 'write_graphic', arguments: { name: 'title', code: 'def render(t, ctx):\n    return None\n' } })
    expect(g.isError).toBeFalsy()
    const added = await client.callTool({
      name: 'add_item',
      arguments: { type: 'graphic', file: 'graphics/title.py', anchor: { word_id: 'src1_w4', offset: 0.1 }, duration: 1 }
    })
    expect(added.isError).toBeFalsy()
    const item = JSON.parse(textOf(added)).item
    // Word 4 starts at source 4.0 -> second segment starts at timeline 2.0 with in=3 -> 3.0, plus 0.1.
    expect(item.start).toBeCloseTo(3.1, 3)
    expect(item.anchor).toEqual({ kind: 'word', wordId: 'src1_w4', offset: 0.1 })

    const bad = await client.callTool({ name: 'add_item', arguments: { type: 'graphic', file: 'graphics/title.py', anchor: { word_id: 'nope' }, duration: 1 } })
    expect(bad.isError).toBe(true)
    expect(textOf(bad)).toContain('nope')
  })

  it('refuses changes outside the range of a section re-edit', async () => {
    const client = await connect()
    const req = ctx.requests.enqueue({ kind: 'reedit', range: { start: 2, end: 5 }, text: 'tighter' })
    const pending = JSON.parse(textOf(await client.callTool({ name: 'get_requests', arguments: {} })))
    expect(pending.requests.map((r: any) => r.id)).toContain(req.id)
    const begun = await client.callTool({ name: 'begin_request', arguments: { request_id: req.id } })
    expect(begun.isError).toBeFalsy()
    expect(store.project.lock?.requestId).toBe(req.id)

    const outside = await client.callTool({ name: 'add_item', arguments: { type: 'graphic', file: 'graphics/title.py', anchor: { word_id: 'src1_w0' }, duration: 1 } })
    expect(outside.isError).toBe(true)
    expect(textOf(outside)).toMatch(/outside the section/)

    const inside = await client.callTool({ name: 'add_item', arguments: { type: 'graphic', file: 'graphics/title.py', anchor: { word_id: 'src1_w3' }, duration: 0.5 } })
    expect(inside.isError).toBeFalsy()

    const done = await client.callTool({ name: 'finish_request', arguments: { request_id: req.id, summary: 'Added a title' } })
    expect(done.isError).toBeFalsy()
    expect(store.project.lock).toBeNull()
  })

  it('refuses tool calls on a project endpoint when another project is open', async () => {
    const client = await connect('/prj_other')
    const r = await client.callTool({ name: 'get_project', arguments: {} })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/prj_other/)
    const own = await connect(`/${store.project.id}`)
    expect((await own.callTool({ name: 'get_project', arguments: {} })).isError).toBeFalsy()
  })

  it('logs every tool call with its result and duration, without the token', async () => {
    const client = await connect()
    const invalid = await client.callTool({ name: 'adjust_cut', arguments: { segment_id: 'x', edge: 'sideways', time: 1 } })
    expect(invalid.isError).toBe(true)
    const entries = store.log.read().filter((e) => e.cat === 'mcp' && / (ok|error) \(\d+ ms\)$/.test(e.msg))
    const names = entries.map((e) => e.msg.split(' ')[0])
    for (const n of ['save_transcript', 'set_aroll_cuts', 'write_graphic', 'add_item', 'begin_request', 'finish_request', 'get_project', 'adjust_cut']) {
      expect(names).toContain(n)
    }
    expect(entries.some((e) => e.msg.startsWith('add_item error'))).toBe(true)
    expect(JSON.stringify(store.log.read())).not.toContain(mcp.token())
  })
})

describe('stabilize', () => {
  it('queues a request that describes the clip, and attaches a processed picture that the render plan uses', async () => {
    const seg = store.project.items.find((i) => i.type === 'segment' && i.in === 3)!
    // The right-click request: the clip, its source range and where to save.
    const req = ctx.requests.enqueue({ kind: 'stabilize', text: '', range: { start: 2, end: 5 }, context: { itemId: seg.id } })
    expect(req.kind).toBe('stabilize')

    const client = await connect()
    mkdirSync(join(store.dir, 'media', 'stabilized'), { recursive: true })
    writeFileSync(join(store.dir, 'media', 'stabilized', `${seg.id}.mp4`), 'x')
    // The file starts at source 2 s and is 8 s long: it covers the segment's 3-6 s.
    const set = await client.callTool({
      name: 'set_item_picture',
      arguments: { id: seg.id, file: `media/stabilized/${seg.id}.mp4`, source_start: 2, kind: 'stabilized', note: 'vidstab smoothing 20' }
    })
    expect(set.isError).toBeFalsy()
    expect((store.project.items.find((i) => i.id === seg.id) as any).picture).toEqual({
      file: `media/stabilized/${seg.id}.mp4`,
      sourceStart: 2,
      kind: 'stabilized',
      note: 'vidstab smoothing 20'
    })

    const { buildPlan } = await import('../src/main/engine/plan')
    const plan = buildPlan(store.snapshotDoc(), { projectDir: store.dir, width: 960, height: 540, fps: 30, burnCaptions: false })
    const layer = plan.layers.find((l) => l.id === seg.id) as any
    expect(layer.path).toBe(join(store.dir, 'media', 'stabilized', `${seg.id}.mp4`))
    expect(layer.sourceIn).toBeCloseTo(1) // source 3 s is file time 1 s
    // Sound stays on the original footage.
    expect(plan.audio.clips.find((c) => c.id === seg.id)!.path).toBe(join(dir, 'a.mp4'))

    // A file that starts after the in point, or is too short, is refused.
    const late = await client.callTool({ name: 'set_item_picture', arguments: { id: seg.id, file: `media/stabilized/${seg.id}.mp4`, source_start: 3.5 } })
    expect(late.isError).toBe(true)
    const short = await client.callTool({ name: 'set_item_picture', arguments: { id: seg.id, file: `media/stabilized/${seg.id}.mp4`, source_start: -10 } })
    expect(short.isError).toBe(true)

    const removed = await client.callTool({ name: 'set_item_picture', arguments: { id: seg.id, remove: true } })
    expect(removed.isError).toBeFalsy()
    expect((store.project.items.find((i) => i.id === seg.id) as any).picture).toBeUndefined()
  })
})

describe('video theme tools', () => {
  it('shows Claude the theme with its contact sheets until it has written a summary, then the summary only', async () => {
    mkdirSync(join(dir, 'theme'), { recursive: true })
    writeFileSync(join(dir, 'theme', 'v1-hook.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const client = await connect()
    const none = await client.callTool({ name: 'get_video_theme', arguments: {} })
    expect(textOf(none)).toMatch(/No video theme/)

    store.mutate('theme', 'user', (d) => {
      d.project.videoTheme = { id: 'vt_test1', name: 'Fast RC style' }
    })
    const first = (await client.callTool({ name: 'get_video_theme', arguments: {} })) as any
    expect(first.content.some((c: any) => c.type === 'image')).toBe(true)
    expect(textOf(first)).toMatch(/about 24 cuts a minute \(40 in the first 30 s\)/)
    expect(textOf(first)).toMatch(/Copy the pace/)
    expect(textOf(first)).toMatch(/save_video_theme_summary/)

    const saved = await client.callTool({ name: 'save_video_theme_summary', arguments: { summary: 'Jump cuts every 1-2 s, punch-in zooms, bold captions.' } })
    expect(saved.isError).toBeFalsy()
    const again = (await client.callTool({ name: 'get_video_theme', arguments: {} })) as any
    expect(again.content.every((c: any) => c.type === 'text')).toBe(true)
    expect(textOf(again)).toMatch(/Jump cuts every 1-2 s/)
  })
})

describe('caption moments tool', () => {
  it('sets the caption spans, says how much of the video they cover, and refuses unknown words', async () => {
    const client = await connect()
    expect(store.project.captions.mode).toBe('moments') // new projects caption key moments only
    const r = await client.callTool({ name: 'set_caption_spans', arguments: { spans: [{ from_word_id: 'src1_w0', to_word_id: 'src1_w1' }] } })
    expect(r.isError).toBeFalsy()
    const out = JSON.parse(textOf(r))
    expect(out.spans).toBe(1)
    expect(out.onTimeline.length).toBeGreaterThan(0)
    expect(store.project.captions.spans).toEqual([{ from: 'src1_w0', to: 'src1_w1' }])
    const bad = await client.callTool({ name: 'set_caption_spans', arguments: { spans: [{ from_word_id: 'nope', to_word_id: 'src1_w1' }] } })
    expect(bad.isError).toBe(true)
  })

  it('saves a thumbnail description and base picture for the owner, keeping a base the owner grabbed', async () => {
    const client = await connect()
    const r = await client.callTool({ name: 'save_thumbnail_draft', arguments: { description: 'Me holding the drift car, big text "$65?" https://x.com/a', base_time: 1.5 } })
    expect(r.isError).toBeFalsy()
    expect(store.project.thumbnails.draft?.text).toBe('Me holding the drift car, big text "$65?"')
    expect(store.project.thumbnails.base).toMatchObject({ by: 'claude', time: 1.5 })
    expect(existsSync(join(store.dir, store.project.thumbnails.base!.file))).toBe(true)

    store.mutate('grab', 'user', (d) => void (d.project.thumbnails.base = { ...d.project.thumbnails.base!, by: 'user' }))
    const refused = await client.callTool({ name: 'save_thumbnail_draft', arguments: { description: 'Another', base_time: 2 } })
    expect(refused.isError).toBe(true)
    const kept = await client.callTool({ name: 'save_thumbnail_draft', arguments: { description: 'Another' } })
    expect(kept.isError).toBeFalsy()
    expect(store.project.thumbnails).toMatchObject({ draft: { text: 'Another' }, base: { by: 'user', time: 1.5 } })
  })
})
