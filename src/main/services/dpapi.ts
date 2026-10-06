/**
 * Windows credential protection (DPAPI), called directly through PowerShell.
 * Unlike Electron's safeStorage it does not depend on a master key Chromium writes to disk later,
 * so a key saved just before the app quits, crashes or updates is never lost.
 * Values pass through stdin and stdout only, never on a command line.
 */
import { spawnSync } from 'node:child_process'
import type { SafeStorageLike } from './settings'

// Ties the protected data to this app as well as to the Windows user.
const ENTROPY = 'AI Video Editor secrets v1'

function run(op: 'Protect' | 'Unprotect', base64In: string): string {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    `$entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
    `$out = [Security.Cryptography.ProtectedData]::${op}($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))'
  ].join('; ')
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    input: base64In,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000
  })
  if (res.error) throw res.error
  if (res.status !== 0) throw new Error(`Windows credential protection failed (${op})`)
  return res.stdout.trim()
}

export function windowsDpapi(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => process.platform === 'win32',
    encryptString: (plain) => Buffer.from(run('Protect', Buffer.from(plain, 'utf8').toString('base64')), 'base64'),
    decryptString: (encrypted) => Buffer.from(run('Unprotect', encrypted.toString('base64')), 'base64').toString('utf8')
  }
}
