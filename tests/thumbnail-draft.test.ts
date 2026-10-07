import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { contactSheet, draftPrompt, parseDraft, pickCandidates, spokenText, writeThumbnailDraft } from '../src/main/services/thumbnailDraft'
import { cleanupTemps, fakeContext, makeProject } from './helpers/project'

afterEach(cleanupTemps)

/** The footage the test project points at: 60 s of a moving test picture. */
function footage(store: ReturnType<typeof makeProject>): void {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=60', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', join(store.dir, 'A001.mp4')])
}

function jpegSize(buf: Buffer): { width: number; height: number } | null {
  for (let i = 2; i < buf.length - 9; ) {
    const marker = buf[i + 1]
    if (marker >= 0xc0 && marker <= 0xc3) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    i += 2 + buf.readUInt16BE(i + 2)
  }
  return null
}

/** A stand-in for Claude Code: records how it was started and answers with the given text. */
function fakeClaude(answer: string, seen: { file?: string; args?: string[]; cwd?: string }) {
  return (file: string, args: string[], opts: any) => {
    seen.file = file
    seen.args = args
    seen.cwd = opts.cwd
    const proc = new EventEmitter() as any
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.kill = () => true
    setTimeout(() => {
      proc.stdout.end(answer)
      proc.stderr.end()
      proc.emit('close', 0)
    }, 5)
    return proc
  }
}

describe('quick thumbnail draft', () => {
  it('picks B-roll first, then talking parts, and says what is said', () => {
    const store = makeProject()
    const c = pickCandidates(store.project, store.transcript, store.dir)
    expect(c.length).toBeGreaterThan(3)
    expect(c.length).toBeLessThanOrEqual(8)
    expect(c[0]).toMatchObject({ what: 'b-roll', time: 3, at: 51 }) // the B-roll clip at 2-4 s shows source 50-52
    expect(c.filter((x) => x.what === 'a-roll').length).toBeGreaterThan(0)
    expect(c.map((x) => x.time)).toEqual([...c.map((x) => x.time)].sort((a, b) => a - b))
    const said = spokenText(store.project, store.transcript)
    expect(said.startsWith('word0 word1')).toBe(true)
    expect(said).not.toContain('word21 ') // cut between 10 and 12 s of the source
  })

  it('builds one contact sheet from the footage', async () => {
    const store = makeProject()
    footage(store)
    const c = pickCandidates(store.project, store.transcript, store.dir)
    const out = join(store.dir, 'sheet.jpg')
    await contactSheet('ffmpeg', c, out)
    const rows = Math.ceil(c.length / 4)
    expect(jpegSize(readFileSync(out))).toEqual({ width: 4 * 480, height: rows * 270 })
  })

  it('reads the frame and description from Claude Code, with or without the JSON envelope', () => {
    expect(parseDraft(JSON.stringify({ type: 'result', result: 'Here: {"frame": 3, "description": "Me with the car, text \\"$65?\\""}' }), 8)).toEqual({ frame: 3, description: 'Me with the car, text "$65?"' })
    expect(parseDraft('{"frame": 12, "description": "See https://x.y now"}', 8)).toEqual({ frame: 1, description: 'See now' })
    expect(() => parseDraft(JSON.stringify({ is_error: true, result: 'Credit balance is too low' }), 8)).toThrow(/Credit balance/)
    expect(() => parseDraft(JSON.stringify({ result: 'no idea' }), 8)).toThrow(/did not answer/)
  })

  it('names the persona, style and direction in the prompt', () => {
    const p = draftPrompt({ count: 2, candidates: [], spoken: 'hello', persona: 'Adam', style: 'Wicked RC - Vehicle W me', direction: 'red text', keepBase: false })
    expect(p).toContain('"Adam"')
    expect(p).toContain('"Wicked RC - Vehicle W me"')
    expect(p).toContain('"red text"')
    expect(p).toContain('sheet.jpg')
  })

  it('runs Claude Code once with only Read, then saves the description and the picked frame as the base picture', async () => {
    const store = makeProject()
    footage(store)
    const ctx = fakeContext({ store }) as any
    let frameAt = -1
    ctx.env = { ffmpeg: () => 'ffmpeg' }
    ctx.pikzels = { list: () => [] }
    ctx.settings = { get: () => ({ runner: { command: 'claude' }, claude: { models: { thumbnails: 'claude-opus-5-5' } } }) }
    ctx.engine = {
      frame: async (_d: unknown, _dir: string, t: number, o: { out: string; footageOnly?: boolean }) => {
        expect(o.footageOnly).toBe(true)
        frameAt = t
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080', '-frames:v', '1', o.out])
        return o.out
      }
    }
    const seen: { file?: string; args?: string[]; cwd?: string } = {}
    const candidates = pickCandidates(store.project, store.transcript, store.dir)
    const r = await writeThumbnailDraft(ctx, store, {
      platform: 'linux',
      spawn: fakeClaude(JSON.stringify({ result: '{"frame": 2, "description": "Me holding the drift car, big text \\"$65?\\""}' }), seen) as any
    })
    expect(seen.file).toBe('claude')
    expect(seen.args).toEqual(expect.arrayContaining(['-p', '--output-format', 'json', '--allowedTools', 'Read', '--model', 'claude-opus-5-5']))
    expect(seen.args).not.toContain('--resume')
    expect(seen.args).not.toContain('--mcp-config')
    expect(r.time).toBe(candidates[1].time)
    expect(frameAt).toBe(candidates[1].time)
    expect(store.project.thumbnails.draft?.text).toBe('Me holding the drift car, big text "$65?"')
    expect(store.project.thumbnails.base).toMatchObject({ by: 'claude', time: Math.round(candidates[1].time * 1000) / 1000 })
    expect(existsSync(join(store.dir, store.project.thumbnails.base!.file))).toBe(true)
    expect(existsSync(seen.cwd!)).toBe(false) // the work folder is cleaned up

    // A base picture the owner grabbed is kept.
    store.mutate('own', 'user', (d) => void (d.project.thumbnails.base = { ...d.project.thumbnails.base!, by: 'user', time: 1 }))
    frameAt = -1
    await writeThumbnailDraft(ctx, store, { platform: 'linux', spawn: fakeClaude('{"frame": 1, "description": "Second idea"}', seen) as any })
    expect(frameAt).toBe(-1)
    expect(store.project.thumbnails).toMatchObject({ draft: { text: 'Second idea' }, base: { by: 'user', time: 1 } })
  })
})
