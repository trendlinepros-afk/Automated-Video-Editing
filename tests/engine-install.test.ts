import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { engineContentHash } from '../src/main/engine/environment'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('engine install', () => {
  it('gives changed engine code a new install folder, so app updates reach existing projects', () => {
    const a = mkdtempSync(join(tmpdir(), 'ave-eng-'))
    dirs.push(a)
    cpSync(join(process.cwd(), 'engine', 'ave_engine'), join(a, 'ave_engine'), { recursive: true })
    const before = engineContentHash(a)
    expect(before).toMatch(/^[0-9a-f]{10}$/)
    // Python caches do not count.
    writeFileSync(join(a, 'ave_engine', 'stray.pyc'), 'x')
    expect(engineContentHash(a)).toBe(before)
    writeFileSync(join(a, 'ave_engine', 'encode.py'), '# changed\n', { flag: 'a' })
    expect(engineContentHash(a)).not.toBe(before)
  })
})
