// Writes release-notes.md for a version: its section of CHANGELOG.md, or else the tag's annotation.
// electron-builder puts this text in the GitHub release and in latest.yml, and the app's update
// dialog shows it.  Usage: node .github/scripts/release-notes.mjs <version> [out-file]
// With REQUIRE_CHANGELOG=1 it fails when CHANGELOG.md has no notes for the version (release gate).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const version = process.argv[2]
const out = process.argv[3] ?? 'release-notes.md'
if (!version) {
  console.error('usage: release-notes.mjs <version> [out-file]')
  process.exit(2)
}

function fromChangelog() {
  if (!existsSync('CHANGELOG.md')) return ''
  const lines = readFileSync('CHANGELOG.md', 'utf8').split(/\r?\n/)
  const esc = version.replace(/\./g, '\\.')
  const heading = new RegExp(`^##\\s+\\[?v?${esc}\\]?(\\s|$)`)
  const start = lines.findIndex((l) => heading.test(l))
  if (start < 0) return ''
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l))
  if (end < 0) end = lines.length
  return lines.slice(start + 1, end).join('\n').trim()
}

function fromTag() {
  try {
    return execFileSync('git', ['tag', '-l', '--format=%(contents)', `v${version}`], { encoding: 'utf8' })
      .replace(/-----BEGIN PGP SIGNATURE-----[\s\S]*$/, '')
      .trim()
  } catch {
    return ''
  }
}

const changelog = fromChangelog()
if (!changelog && process.env.REQUIRE_CHANGELOG === '1') {
  console.error(`CHANGELOG.md has no notes under a "## ${version}" heading. Add them before tagging.`)
  process.exit(1)
}
const notes = changelog || fromTag() || `Version ${version}.`
writeFileSync(out, notes + '\n')
console.log(`Release notes for ${version}:\n${notes}`)
