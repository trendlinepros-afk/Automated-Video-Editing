import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ActivityLog, buildLogExport, redact, registerSecret, writeLogExport, type LogEntry } from '../src/main/log'
import { initPaths } from '../src/main/paths'
import { createSecretsService, type SafeStorageLike } from '../src/main/services/settings'
import { cleanupTemps, fakeContext, tempDir } from './helpers/project'

afterEach(cleanupTemps)

const header = { appVersion: '1.0.0', projectFormatVersion: 2, windowsVersion: 'Windows_NT 10.0.22631', profile: 'RC', projectName: 'Test' }

describe('redact()', () => {
  it('scrubs Pikzels keys', () => {
    const out = redact('calling with key pkz_live_9f8e7d6c5b4a3210 now')
    expect(out).not.toContain('9f8e7d6c5b4a3210')
    expect(out).toContain('pkz_[REDACTED]')
  })

  it('scrubs GitHub tokens', () => {
    const classic = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
    const fine = 'github_pat_' + '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'
    const out = redact(`token ${classic} and ${fine} and gho_${'x'.repeat(30)}`)
    expect(out).not.toContain(classic)
    expect(out).not.toContain(fine)
    expect(out).not.toContain('x'.repeat(30))
  })

  it('scrubs Bearer tokens and x-api-key headers', () => {
    const out = redact('Authorization: Bearer abc.def-ghi_jkl123456 x-api-key: k3y-v4lue-0987 "X-API-KEY":"another-secret-1"')
    expect(out).not.toContain('abc.def-ghi_jkl123456')
    expect(out).not.toContain('k3y-v4lue-0987')
    expect(out).not.toContain('another-secret-1')
  })

  it('scrubs secrets in query strings and JSON fields', () => {
    const out = redact('GET https://api.example.com/x?api_key=supersecret123&ok=1 {"token":"tok-998877","password":"hunter22"}')
    expect(out).not.toContain('supersecret123')
    expect(out).not.toContain('tok-998877')
    expect(out).not.toContain('hunter22')
    expect(out).toContain('ok=1')
  })

  it('scrubs registered secrets that match no pattern', () => {
    registerSecret('plain-looking-value-4242')
    expect(redact('the value plain-looking-value-4242 appears')).toBe('the value [REDACTED] appears')
  })

  it('leaves ordinary text alone', () => {
    const text = 'Moved graphic gfx_price from 12.0s to 13.5s'
    expect(redact(text)).toBe(text)
  })
})

describe('log files never contain a registered secret', () => {
  const SECRET = 'my-registered-secret-value-0001'
  registerSecret(SECRET)

  it('ActivityLog scrubs messages and nested data', () => {
    const file = join(tempDir(), 'logs', 'activity.jsonl')
    const log = new ActivityLog(file)
    log.write('thumbnail', `Pikzels call with ${SECRET}`, {
      headers: { 'x-api-key': SECRET, Authorization: `Bearer ${SECRET}` },
      nested: { deeper: [{ value: SECRET }, `prefix ${SECRET} suffix`] },
      apiKey: SECRET,
      pikzels: 'pkz_abcdef1234567890'
    })
    log.write('error', 'plain', new Error(`boom ${SECRET}`).message)
    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('pkz_abcdef1234567890')
    expect(log.read()).toHaveLength(2)
  })

  it('buildLogExport output is scrubbed even if raw entries hold a secret', () => {
    // Entries as they might sit in an old log written before the secret was registered.
    const entries: LogEntry[] = [
      { ts: '2026-10-20T10:00:00.000Z', session: 'aaaa', cat: 'mcp', msg: `tool call ${SECRET}`, data: { key: SECRET, list: [SECRET] } },
      { ts: '2026-10-20T10:00:01.000Z', session: 'bbbb', cat: 'update', msg: 'check', data: { token: 'ghp_' + 'Z'.repeat(36) } }
    ]
    for (const filter of ['all', 'last_session'] as const) {
      const text = buildLogExport(entries, header, filter)
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain('Z'.repeat(36))
      expect(text).toContain('App version: 1.0.0')
    }
    const out = join(tempDir(), 'export.txt')
    writeLogExport(out, `raw ${SECRET}`)
    expect(readFileSync(out, 'utf8')).not.toContain(SECRET)
  })

  it('Last session keeps only the newest session, oldest first', () => {
    const entries: LogEntry[] = [
      { ts: '2026-10-20T10:00:02.000Z', session: 'new', cat: 'app', msg: 'second' },
      { ts: '2026-10-19T10:00:00.000Z', session: 'old', cat: 'app', msg: 'old one' },
      { ts: '2026-10-20T10:00:01.000Z', session: 'new', cat: 'app', msg: 'first' }
    ]
    const text = buildLogExport(entries, header, 'last_session')
    expect(text).not.toContain('old one')
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'))
  })
})

describe('secrets service', () => {
  const fakeSafe = (available = true): SafeStorageLike => ({
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(s.split('').reverse().join(''), 'utf8'),
    decryptString: (b) => b.toString('utf8').split('').reverse().join('')
  })

  it('stores keys encrypted, registers them, and they never reach the logs', () => {
    const data = tempDir('ave-data-')
    initPaths({ data, runtime: join(data, 'runtime'), resources: data })
    const ctx = fakeContext({ logDir: data })
    // No recognisable pattern: only registration can scrub it.
    const key = 'plainKeyNoPattern-8812-qq'
    const secrets = createSecretsService(ctx, fakeSafe())
    secrets.set('pikzels', key)
    const stored = readFileSync(join(data, 'secrets.json'), 'utf8')
    expect(stored).not.toContain(key)
    expect(createSecretsService(ctx, fakeSafe()).get('pikzels')).toBe(key)

    ctx.appLog.write('app', `oops ${key}`, { key, nested: [`x${key}y`] })
    const logText = readFileSync(join(data, 'app.log'), 'utf8')
    expect(logText).not.toContain(key)
  })

  it('refuses to store a key when Windows credential protection is unavailable', () => {
    const data = tempDir('ave-data-')
    initPaths({ data, runtime: join(data, 'runtime'), resources: data })
    const secrets = createSecretsService(fakeContext({ logDir: data }), fakeSafe(false))
    expect(() => secrets.set('githubToken', 'ghp_' + 'B'.repeat(36))).toThrow(/cannot be stored safely/)
    expect(existsSync(join(data, 'secrets.json'))).toBe(false)
    expect(secrets.get('githubToken')).toBeNull()
  })

  it('no log file anywhere contains a registered secret', () => {
    const dir = tempDir()
    const secret = 'zz-registered-' + 'k'.repeat(12)
    registerSecret(secret)
    const a = new ActivityLog(join(dir, 'a', 'activity.jsonl'))
    const b = new ActivityLog(join(dir, 'b', 'app.log'))
    a.write('mcp', 'tool', { args: { url: `https://x.test/?token=${secret}` } })
    b.write('update', `GH_TOKEN=${secret}`)
    for (const sub of ['a', 'b']) {
      for (const f of readdirSync(join(dir, sub))) expect(readFileSync(join(dir, sub, f), 'utf8')).not.toContain(secret)
    }
  })
})
