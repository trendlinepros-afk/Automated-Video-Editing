/**
 * Export pack (video, thumbnail, subtitles and a text file of the publishing pack in one folder)
 * and Export log (a .txt of everything the app did on the open project).
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'
import { release, type as osType } from 'node:os'
import { PROJECT_FORMAT_VERSION } from '@shared/appInfo'
import { buildSrt, chapterLines } from '@shared/captions'
import type { ProjectDoc } from '@shared/project'
import type { AppContext } from '../context'
import { buildLogExport, writeLogExport } from '../log'
import type { ProjectStore } from '../project/store'
import { safeName } from '../project/manager'

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function openStore(ctx: AppContext): ProjectStore {
  const s = ctx.projects.current()
  if (!s) throw new Error('No project is open.')
  return s
}

/** The text file of the publishing pack: titles, description (with the channel template), chapters, tags. */
export function publishText(doc: ProjectDoc, descriptionTemplate: string): string {
  const { publish } = doc.project
  const chapters = chapterLines(doc)
  const description = [publish.description.trim(), descriptionTemplate.trim()].filter(Boolean).join('\n\n')
  const lines: string[] = [`${doc.project.name}`, '', 'TITLE OPTIONS']
  if (publish.titles.length) publish.titles.forEach((t, i) => lines.push(`${i + 1}. ${t}`))
  else lines.push('(none yet)')
  lines.push('', 'DESCRIPTION', description || '(none yet)')
  lines.push('', 'CHAPTERS', ...(chapters.length ? chapters : ['(none yet)']))
  lines.push('', 'TAGS', publish.tags.length ? publish.tags.join(', ') : '(none yet)', '')
  return lines.join('\n')
}

/** The newest finished export: the render service's last output, or the newest video in exports/. */
function latestExport(ctx: AppContext, store: ProjectStore): string | null {
  const last = ctx.renders.lastOutput()
  if (last && existsSync(last)) return last
  if (!existsSync(store.paths.exports)) return null
  const videos = readdirSync(store.paths.exports)
    .filter((f) => ['.mp4', '.mov', '.mkv'].includes(extname(f).toLowerCase()))
    .map((f) => join(store.paths.exports, f))
    .filter((f) => statSync(f).isFile())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return videos[0] ?? null
}

/** Large videos are hard-linked when the drive allows it, so the pack takes no extra space. */
function linkOrCopy(from: string, to: string): void {
  try {
    linkSync(from, to)
  } catch {
    copyFileSync(from, to)
  }
}

/** Saves the pack into exports/<project>-pack-<time>/ and returns that folder. */
export function exportPack(ctx: AppContext): string {
  const store = openStore(ctx)
  const doc = store.snapshotDoc()
  const name = safeName(doc.project.name)
  const video = latestExport(ctx, store)
  if (!video) throw new Error('Export the video first, then save the pack.')

  const dir = join(store.paths.exports, `${name}-pack-${stamp()}`)
  mkdirSync(dir, { recursive: true })
  const files: string[] = []

  const videoOut = join(dir, `${name}${extname(video)}`)
  linkOrCopy(video, videoOut)
  files.push(videoOut)

  const thumbs = doc.project.thumbnails
  const chosen =
    thumbs.items.find((t) => t.id === thumbs.chosenId && t.file) ?? thumbs.items.find((t) => t.status === 'done' && t.file)
  if (chosen?.file) {
    const src = isAbsolute(chosen.file) ? chosen.file : join(store.dir, chosen.file)
    if (existsSync(src)) {
      const out = join(dir, `${name}-thumbnail${extname(src) || '.png'}`)
      copyFileSync(src, out)
      files.push(out)
    }
  }

  const srt = buildSrt(doc)
  if (srt.trim()) {
    const out = join(dir, `${name}.srt`)
    writeFileSync(out, srt)
    files.push(out)
  }

  const profile = ctx.profiles.get(doc.project.profileId)
  const template = doc.project.settings.descriptionTemplate || profile?.descriptionTemplate || ''
  const textOut = join(dir, 'publish.txt')
  writeFileSync(textOut, publishText(doc, template))
  files.push(textOut)

  store.log.write('export', 'Publishing pack saved', { dir, video, files: files.map((f) => basename(f)) })
  return dir
}

/** Windows version for the log header, e.g. "Windows_NT 10.0.22631". */
export function osVersion(): string {
  return `${osType()} ${release()}`
}

/** Writes <project>/logs/export-<time>.txt and returns its path. The caller opens its folder. */
export function exportLog(ctx: AppContext, filter: 'all' | 'last_session'): string {
  const store = openStore(ctx)
  const profile = ctx.profiles.get(store.project.profileId)
  const text = buildLogExport(
    store.log.read(),
    {
      appVersion: ctx.appVersion,
      projectFormatVersion: PROJECT_FORMAT_VERSION,
      windowsVersion: osVersion(),
      profile: profile?.name ?? store.project.profileId,
      projectName: store.project.name
    },
    filter
  )
  const out = join(store.paths.logs, `export-${stamp()}.txt`)
  writeLogExport(out, text)
  store.log.write('app', 'Activity log exported', { file: out, filter })
  return out
}
