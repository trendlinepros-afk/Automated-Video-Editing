import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppContext } from '../src/main/context'
import { renderProblems, timelineProblems } from '../src/main/services/exportCheck'
import { makeZip } from '../src/main/services/zip'
import { buildDiagnostics } from '../src/main/services/diagnostics'
import { initPaths } from '../src/main/paths'
import { ActivityLog, registerSecret } from '../src/main/log'
import { cleanupTemps, makeProject } from './helpers/project'

afterEach(() => cleanupTemps())

describe('the check before export', () => {
  it('reports black, frozen, silence, loudness and peaks, but not the stills, fades and edges the edit asks for', () => {
    const problems = renderProblems(
      {
        black: [{ start: 0, end: 0.5 }, { start: 30, end: 31.4 }, { start: 59.8, end: 61 }, { start: 89.5, end: 90 }],
        frozen: [{ start: 10, end: 13 }, { start: 40, end: 44 }],
        hasAudio: true,
        silence: [{ start: 0, end: 3.2 }, { start: 50, end: 54.2 }],
        lufs: -19.5,
        truePeakDb: 0.3
      },
      { targetLufs: -14, stills: [{ start: 9.5, end: 13.5 }], fades: [{ start: 59.5, end: 61.2 }], duration: 90 }
    )
    expect(problems.map((p) => p.title)).toEqual([
      'Black screen for 1.4 s',
      'Picture frozen for 4.0 s',
      '4.2 s of silence',
      'Loudness -19.5 LUFS, the target is -14',
      'Peaks reach 0.3 dB'
    ])
    expect(problems[0].range).toEqual({ start: 30, end: 31.4 })
    expect(renderProblems({ black: [], frozen: [], hasAudio: false }, { targetLufs: -14, stills: [], fades: [], duration: 30 }).map((p) => p.title)).toEqual(['The video has no sound'])
  })

  it('checks the timeline: missing files, items that lost their word, open requests and the self-check', () => {
    const store = makeProject()
    store.mutate('state', 'claude', (d) => {
      d.project.status = 'editing'
      d.project.requests.push({ id: 'r1', kind: 'chat', status: 'queued', createdAt: '', text: 'x', context: {} } as any)
      ;(d.project.items.find((i) => i.id === 'gfx_inside') as any).anchor = { kind: 'word', wordId: 'src_a_w2', offset: 0 }
    })
    const ctx = { projects: { missingSources: () => [] } } as unknown as AppContext
    const titles = timelineProblems(ctx, store).map((p) => `${p.severity}: ${p.title}`)
    expect(titles).toContain('error: File missing for graphic') // graphics/a.py was never written in this test project
    expect(titles).toContain('warning: Claude still has 1 request open')
    expect(titles).toContain('warning: The self-check has not run')
    // A section export only looks at items in its range.
    expect(timelineProblems(ctx, store, { start: 1000, end: 1001 }).some((p) => p.title.startsWith('File missing'))).toBe(false)
  })
})

describe('the diagnostics zip', () => {
  it('writes a zip any unzip tool reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ave-zip-'))
    const file = join(dir, 'x.zip')
    writeFileSync(file, makeZip([{ name: 'a.txt', data: 'hello' }, { name: 'logs/b.log', data: 'x'.repeat(10000) }]))
    let listing = ''
    try {
      listing = execFileSync('unzip', ['-l', file], { encoding: 'utf8' })
    } catch {
      listing = execFileSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("\\n".join(z.namelist()))', file], { encoding: 'utf8' })
    }
    expect(listing).toContain('a.txt')
    expect(listing).toContain('logs/b.log')
    const ok = execFileSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip(), z.read("a.txt").decode())', file], { encoding: 'utf8' })
    expect(ok.trim()).toBe('None hello')
  })

  it('bundles logs, settings and the open project with keys removed', async () => {
    const data = mkdtempSync(join(tmpdir(), 'ave-diag-'))
    initPaths({ data, runtime: join(data, 'rt'), resources: data })
    mkdirSync(join(data, 'logs'), { recursive: true })
    registerSecret('pkz_supersecretvalue123')
    writeFileSync(join(data, 'logs', 'app.log'), '{"msg":"called with pkz_supersecretvalue123"}\n')
    const store = makeProject()
    const ctx = {
      isPackaged: false,
      appLog: new ActivityLog(join(data, 'logs', 'app.log')),
      projects: { current: () => store, missingSources: () => [] },
      env: { status: async () => ({ gpu: { ok: true } }) },
      settings: { get: () => ({ runner: { command: 'definitely-not-a-command-xyz' }, pikzels: { note: 'Bearer abcdefghijklmnop' } }) },
      updater: { state: () => ({ status: 'idle' }) },
      runner: { state: () => ({ status: 'idle' }), recentOutput: () => [{ ts: '', kind: 'text', text: 'used token sk-ant-abcdefghijklmnop' }] },
      preview: { state: () => ({ status: 'ready' }) }
    } as unknown as AppContext
    const out = await buildDiagnostics(ctx, { appName: 'AI Video Editor', appVersion: '9.9.9', versions: { electron: '38' }, outDir: data })
    const read = (name: string) =>
      execFileSync('python3', ['-c', 'import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode())', out, name], { encoding: 'utf8' })
    const names = execFileSync('python3', ['-c', 'import zipfile,sys; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', out], { encoding: 'utf8' }).trim().split('\n')
    expect(names).toEqual(expect.arrayContaining(['README.txt', 'system.json', 'environment.json', 'claude-code.txt', 'settings.json', 'updates.json', 'claude-output.json', 'logs/app.log', 'project/project.json', 'project/state.json']))
    const all = names.map(read).join('\n')
    expect(all).not.toContain('pkz_supersecretvalue123')
    expect(all).not.toContain('sk-ant-abcdefghijklmnop')
    expect(all).not.toContain('abcdefghijklmnop')
    expect(read('system.json')).toContain('9.9.9')
    expect(read('claude-code.txt')).toMatch(/not available/)
  })
})
