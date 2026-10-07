/**
 * Video themes: a YouTube link (with a stand-in for yt-dlp that "downloads" a generated clip) or a file is
 * measured by the real analysis script, saved, and read back by Claude through get_video_theme.
 * Skipped when ffmpeg, python3 with numpy and Pillow are not available.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppContext } from '../src/main/context'
import { ActivityLog } from '../src/main/log'
import { createVideoThemesService, themeSheets, ytdlpArgs } from '../src/main/services/videoThemes'
import { buildRunPrompt } from '../src/main/runner/prompts'
import { makeProject } from './helpers/project'

function available(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    execFileSync('python3', ['-c', 'import numpy, PIL'], { stdio: 'ignore' })
    return process.platform !== 'win32'
  } catch {
    return false
  }
}
const ok = available()

/** Stands in for yt-dlp: "downloads" the clip for each URL into the -o folder, up to --max-downloads. */
const FAKE_YTDLP = String.raw`#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_YT_LOG, JSON.stringify(args) + '\n')
if (process.env.FAKE_YT_FAIL) { process.stderr.write('ERROR: [youtube] abc: Sign in to confirm you are not a bot\n'); process.exit(1) }
const out = args[args.indexOf('-o') + 1]
const max = Number(args[args.indexOf('--max-downloads') + 1] || 99)
const urls = args.filter((a) => a.startsWith('https://'))
let n = 0
for (const u of urls) {
  if (n >= max) process.exit(101)
  const id = new URL(u).searchParams.get('v')
  const dir = path.dirname(out)
  console.log('[download] Destination: ' + path.join(dir, id + '.mp4'))
  console.log('[download]  50.0% of 1MiB')
  fs.copyFileSync(process.env.FAKE_YT_CLIP, path.join(dir, id + '.mp4'))
  fs.writeFileSync(path.join(dir, id + '.en.json3'), JSON.stringify({ events: [{ tStartMs: 0, segs: 'this is a fast paced review of a tiny drift car right here'.split(' ').map((w, i) => ({ utf8: ' ' + w, tOffsetMs: i * 250 })) }] }))
  fs.writeFileSync(path.join(dir, id + '.info.json'), JSON.stringify({ title: 'Video ' + id, channel: 'Drift Channel', webpage_url: u }))
  n++
}
`

let dir: string
let clip: string
let ytLog: string

function makeCtx(): AppContext {
  return {
    appLog: new ActivityLog(join(dir, 'app.log')),
    env: {
      ytdlp: async () => join(dir, 'yt-dlp'),
      python: () => 'python3',
      ffmpeg: () => 'ffmpeg',
      analysisScript: () => resolve('engine/analysis/style.py')
    }
  } as unknown as AppContext
}

beforeAll(() => {
  if (!ok) return
  dir = mkdtempSync(join(tmpdir(), 'ave-themes-'))
  clip = join(dir, 'clip.mp4')
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=30', '-f', 'lavfi', '-i', 'smptebars=s=640x360:r=30:d=30', '-f', 'lavfi', '-i', 'sine=f=300:d=20',
    '-filter_complex', '[0:v]trim=0:3,setpts=PTS-STARTPTS[a];[1:v]trim=0:3,setpts=PTS-STARTPTS[b];[0:v]trim=10:13,setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=1:a=0,format=yuv420p[v]',
    '-map', '[v]', '-map', '2:a', '-t', '9', '-c:v', 'libx264', '-crf', '22', '-c:a', 'aac', clip
  ])
  writeFileSync(join(dir, 'yt-dlp'), FAKE_YTDLP)
  chmodSync(join(dir, 'yt-dlp'), 0o755)
  ytLog = join(dir, 'yt.log')
  process.env.FAKE_YT_LOG = ytLog
  process.env.FAKE_YT_CLIP = clip
})

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('yt-dlp arguments', () => {
  it('reads a small copy of the opening only, with captions, and skips Shorts and live streams on a channel', () => {
    const args = ytdlpArgs(['https://www.youtube.com/watch?v=aaaaaaaaaaa'], '/w', '/tools/ffmpeg/bin/ffmpeg', 3, true)
    expect(args).toEqual(expect.arrayContaining(['--download-sections', '*0-720', '--max-downloads', '3', '--write-auto-subs', '--ffmpeg-location', '/tools/ffmpeg/bin']))
    expect(args[args.indexOf('-f') + 1]).toMatch(/height<=480/)
    expect(args[args.indexOf('--match-filter') + 1]).toBe('duration > 180 & !is_live')
    expect(ytdlpArgs([], '/w', 'ffmpeg', 1, false)[ytdlpArgs([], '/w', 'ffmpeg', 1, false).indexOf('--match-filter') + 1]).toBe('!is_live')
  })
})

describe.skipIf(!ok)('video themes', () => {
  it('makes a theme from a channel: newest 3 videos measured, downloads deleted, Claude reads it', async () => {
    const root = join(dir, 'themes')
    const work = join(dir, 'work')
    const ids = ['aaaaaaaaaa1', 'aaaaaaaaaa2', 'aaaaaaaaaa3', 'aaaaaaaaaa4']
    const fakeFetch = async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => (url.includes('/videos') ? ids.map((v) => `"videoId":"${v}"`).join(',') : ''),
      arrayBuffer: async () => new ArrayBuffer(0)
    })
    const svc = createVideoThemesService(makeCtx(), { root, workRoot: work, fetch: fakeFetch })
    const steps: string[] = []
    const t = await svc.analyze({ link: 'https://www.youtube.com/@driftchannel' }, (p) => steps.push(p.step))
    expect(t.name).toBe('Drift Channel style')
    expect(t.source.kind).toBe('channel')
    expect(t.videos.map((v) => v.title)).toEqual(['Video aaaaaaaaaa1', 'Video aaaaaaaaaa2', 'Video aaaaaaaaaa3'])
    expect(t.videos[0].stats.cutTimes).toEqual([3, 6])
    expect(t.averages.cutsPerMinute).toBeCloseTo(13.3, 1)
    expect(t.averages.wordsPerMinute).toBeGreaterThan(150)
    expect(steps).toEqual(expect.arrayContaining(['listing', 'download', 'analyze', 'done']))
    // Only the numbers and contact sheets are kept.
    expect(readdirSync(join(root, t.id)).sort()).toEqual(['theme.json', 'v1-hook.jpg', 'v2-hook.jpg', 'v3-hook.jpg'])
    expect(existsSync(join(work, t.id))).toBe(false)
    expect(svc.list().map((x) => x.id)).toEqual([t.id])

    // Claude reads the theme through the project.
    const store = makeProject()
    store.mutate('theme', 'user', (d) => {
      d.project.videoTheme = { id: t.id, name: t.name }
    })
    expect(buildRunPrompt([], store.project, { resumed: false })).toMatch(/Video theme: "Drift Channel style".*get_video_theme/s)
    expect(themeSheets(svc.dir(t.id), t)).toHaveLength(3)

    svc.update(t.id, { notes: 'Copy the pace, skip the memes', summary: 'Fast jump cuts every 2-3 s.' })
    expect(svc.get(t.id)).toMatchObject({ notes: 'Copy the pace, skip the memes', summary: 'Fast jump cuts every 2-3 s.' })
    svc.remove(t.id)
    expect(svc.list()).toEqual([])
  }, 120000)

  it('makes a theme from a video file, and explains a refused download', async () => {
    const svc = createVideoThemesService(makeCtx(), { root: join(dir, 'themes2'), workRoot: join(dir, 'work2') })
    const t = await svc.analyze({ file: clip, name: 'My reference' })
    expect(t).toMatchObject({ name: 'My reference', source: { kind: 'file' } })
    expect(t.videos[0].stats.cuts).toBe(2)

    process.env.FAKE_YT_FAIL = '1'
    await expect(svc.analyze({ link: 'https://youtu.be/aaaaaaaaaa1' })).rejects.toThrow(/confirm this is not a bot/)
    delete process.env.FAKE_YT_FAIL
    expect(svc.list().map((x) => x.name)).toEqual(['My reference']) // the failed one left nothing behind
  }, 120000)
})
