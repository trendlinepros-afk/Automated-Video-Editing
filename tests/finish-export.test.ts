import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { publishText, safeFileName, thumbnailsToExport, writeFinishFiles } from '../src/main/services/finishExport'
import { cleanupTemps, makeProject } from './helpers/project'

afterEach(cleanupTemps)

function withThumbs(store: ReturnType<typeof makeProject>) {
  mkdirSync(join(store.dir, 'thumbnails'), { recursive: true })
  const thumb = (id: string, status: 'done' | 'failed' = 'done') => {
    if (status === 'done') writeFileSync(join(store.dir, 'thumbnails', `${id}.png`), `PNG-${id}`)
    return { id, kind: 'text', prompt: id, source: 'user', format: '16:9', createdAt: new Date().toISOString(), status, ...(status === 'done' ? { file: `thumbnails/${id}.png` } : {}) }
  }
  store.mutate('thumbs', 'user', (d) => {
    d.project.name = 'H-Star: Drift Car?'
    d.project.thumbnails.items = [thumb('t1'), thumb('t2'), thumb('t3', 'failed'), thumb('t4'), thumb('t5')] as any
    d.project.thumbnails.chosenId = 't2'
    d.project.publish.titles = ['Is This $65 Drift Car Any Good?', 'H-Star D24 Review', 'I Did Not Expect This']
    d.project.publish.description = 'A $65 micro drift car with a real gyro.'
    d.project.publish.tags = ['rc drift', 'h-star d24', 'micro rc']
    // Chapter pinned to word 28 (timeline 12.0 s in the test project) and one at the start.
    d.project.publish.chapters = [
      { id: 'c2', title: 'Gyro test', anchor: { kind: 'word', wordId: 'src_a_w28', offset: 0 } },
      { id: 'c1', title: 'Intro', anchor: { kind: 'time', time: 0 } }
    ] as any
  })
}

describe('Finish And Export files', () => {
  it('puts the chosen thumbnail first, then the newest others, three at most', () => {
    const store = makeProject()
    withThumbs(store)
    expect(thumbnailsToExport(store.project).map((t) => t.id)).toEqual(['t2', 't5', 't4'])
  })

  it('writes the title, other options, description with chapters, and tags', () => {
    const store = makeProject()
    withThumbs(store)
    expect(publishText(store.project, store.transcript)).toBe(
      'TITLE\nIs This $65 Drift Car Any Good?\n\n' +
        'OTHER TITLE OPTIONS\n- H-Star D24 Review\n- I Did Not Expect This\n\n' +
        'DESCRIPTION\nA $65 micro drift car with a real gyro.\n\n0:00 Intro\n0:12 Gyro test\n\n' +
        'TAGS\nrc drift, h-star d24, micro rc\n'
    )
  })

  it('writes everything into the Export folder with safe names', () => {
    const store = makeProject()
    withThumbs(store)
    const r = writeFinishFiles(store)
    expect(r.dir).toBe(join(store.dir, 'Export'))
    expect(readdirSync(r.dir).sort()).toEqual([
      'H-Star Drift Car - thumbnail option 2.png',
      'H-Star Drift Car - thumbnail option 3.png',
      'H-Star Drift Car - thumbnail.png',
      'H-Star Drift Car - title, description, tags.txt'
    ])
    expect(readFileSync(join(r.dir, 'H-Star Drift Car - thumbnail.png'), 'utf8')).toBe('PNG-t2')
    expect(safeFileName('a<b>c:"d"/e\\f|g?h*. ')).toBe('a b c d e f g h')
  })

  it('still writes the text file with nothing made yet', () => {
    const store = makeProject()
    const r = writeFinishFiles(store)
    expect(r.files).toHaveLength(1)
    expect(readFileSync(r.files[0], 'utf8')).toContain('TITLE\n(no title yet)')
    expect(existsSync(r.files[0])).toBe(true)
  })
})

describe('export file names', () => {
  it('say the size, and mark a quick check so it is not uploaded by mistake', async () => {
    const { exportFileName } = await import('../src/main/engine/renders')
    const when = new Date(2026, 9, 20, 14, 5)
    expect(exportFileName('Drift car', undefined, when, { height: 2160 })).toBe('Drift car_whole_2160p_2026-10-20_14-05.mp4')
    expect(exportFileName('Drift', undefined, when, { height: 540, quick: true })).toBe('Drift_whole_QUICK-CHECK-540p_2026-10-20_14-05.mp4')
  })
})
