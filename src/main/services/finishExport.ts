/**
 * Finish And Export: everything for the upload in one folder of the project (Export/): the video (rendered by the
 * normal export, into that folder), the thumbnails (the chosen one first) and a text file with the title options,
 * description, chapters and tags, ready to copy into YouTube.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'
import type { Project, Thumbnail, Transcript } from '@shared/project'
import { TimelineResolver, formatTime } from '@shared/timeline'
import type { ProjectStore } from '../project/store'

export const FINISH_FOLDER = 'Export'
/** At most this many thumbnails go into the folder (the options of a thumbnail round). */
export const MAX_THUMBNAILS = 3

/** A file name from the project name, safe on Windows. */
export function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '') || 'Video'
}

/** The thumbnails to export: the chosen one first, then the newest other finished ones, up to three. */
export function thumbnailsToExport(project: Project): Thumbnail[] {
  const done = project.thumbnails.items.filter((t) => t.status === 'done' && t.file)
  const chosen = done.find((t) => t.id === project.thumbnails.chosenId)
  const others = done.filter((t) => t !== chosen).reverse()
  return [...(chosen ? [chosen] : []), ...others].slice(0, MAX_THUMBNAILS)
}

/** The text file: title (and the other options), description, chapters and tags, in the order YouTube asks for them. */
export function publishText(project: Project, transcript: Transcript): string {
  const p = project.publish
  const [title, ...others] = p.titles.map((t) => t.trim()).filter(Boolean)
  // Chapters follow the words they are pinned to; added unless the description already lists them.
  const resolver = new TimelineResolver(project, transcript)
  const chapters =
    p.chapters.length && !/\b0?0:00\b/.test(p.description)
      ? p.chapters
          .map((c) => ({ time: resolver.anchorTime(c.anchor).time, title: c.title }))
          .sort((a, b) => a.time - b.time)
          .map((c) => `${formatTime(c.time)} ${c.title}`)
          .join('\n')
      : ''
  const parts = [
    `TITLE\n${title ?? '(no title yet)'}`,
    others.length ? `OTHER TITLE OPTIONS\n${others.map((t) => `- ${t}`).join('\n')}` : '',
    `DESCRIPTION\n${p.description.trim() || '(no description yet)'}${chapters ? `\n\n${chapters}` : ''}`,
    `TAGS\n${p.tags.length ? p.tags.join(', ') : '(no tags yet)'}`
  ]
  return parts.filter(Boolean).join('\n\n') + '\n'
}

/** Writes the thumbnails and the text file into the project's Export folder. Returns the folder and the files. */
export function writeFinishFiles(store: ProjectStore): { dir: string; files: string[] } {
  const project = store.project
  const dir = join(store.dir, FINISH_FOLDER)
  mkdirSync(dir, { recursive: true })
  const base = safeFileName(project.name)
  const files: string[] = []
  thumbnailsToExport(project).forEach((t, i) => {
    const src = isAbsolute(t.file!) ? t.file! : join(store.dir, t.file!)
    if (!existsSync(src)) return
    const name = i === 0 ? `${base} - thumbnail${extname(src)}` : `${base} - thumbnail option ${i + 1}${extname(src)}`
    copyFileSync(src, join(dir, name))
    files.push(join(dir, name))
  })
  const text = join(dir, `${base} - title, description, tags.txt`)
  writeFileSync(text, publishText(project, store.transcript), 'utf8')
  files.push(text)
  store.log.write('export', `Finish And Export: ${files.length - 1} thumbnail(s) and the text file written`, { dir })
  return { dir, files }
}
