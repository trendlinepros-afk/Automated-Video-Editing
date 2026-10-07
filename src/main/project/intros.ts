/**
 * Intro A/B: every redo of the intro keeps the one before it as a version named "Intro N", and any saved intro can
 * be put back on the timeline. Only the edit itself is swapped (the timeline, where the intro ends, the caption
 * moments), never the chat, requests or settings.
 */
import type { AppContext } from '../context'
import type { ProjectStore } from './store'

export const INTRO_NAME = /^Intro \d+$/

/** The edit that makes an intro: what is on the timeline and where the intro ends. */
function introKey(doc: { project: { items: unknown; scope: { introEnd: unknown } } }): string {
  return JSON.stringify([doc.project.items, doc.project.scope.introEnd])
}

/** The saved intros, oldest first, and which one is on screen now (null when the one on screen is not saved). */
export function introVersions(ctx: AppContext, s: ProjectStore): { versions: { id: string; name: string; createdAt: string }[]; currentId: string | null } {
  const num = (name: string) => Number(name.replace(/\D+/g, '')) || 0
  const list = ctx.versions.list().filter((v) => INTRO_NAME.test(v.name)).sort((a, b) => num(a.name) - num(b.name))
  const now = introKey(s.snapshotDoc())
  let currentId: string | null = null
  for (const v of list) {
    try {
      if (introKey(ctx.versions.load(v.id)) === now) currentId = v.id
    } catch {
      /* an unreadable version is skipped */
    }
  }
  return { versions: list.map((v) => ({ id: v.id, name: v.name, createdAt: v.createdAt })), currentId }
}

/** Saves the intro on screen as "Intro N" unless it is already saved. */
export function saveIntroVersion(ctx: AppContext, s: ProjectStore): void {
  if (!s.project.items.length) return
  const { versions, currentId } = introVersions(ctx, s)
  if (currentId) return
  const n = versions.reduce((m, v) => Math.max(m, Number(v.name.replace(/\D+/g, '')) || 0), 0) + 1
  ctx.versions.save(`Intro ${n}`, { auto: false, reason: 'intro' })
}

/** Puts a saved intro back on the timeline, as one undo step, after keeping the one on screen. */
export function useIntro(ctx: AppContext, s: ProjectStore, versionId: string): void {
  const v = ctx.versions.list().find((x) => x.id === versionId)
  if (!v || !INTRO_NAME.test(v.name)) throw new Error('That intro is no longer saved.')
  saveIntroVersion(ctx, s)
  const doc = ctx.versions.load(versionId)
  s.mutate(`Use ${v.name}`, 'user', (d) => {
    d.project.items = structuredClone(doc.project.items)
    const have = new Set(d.project.sources.map((x) => x.id))
    for (const src of doc.project.sources) if (!have.has(src.id)) d.project.sources.push(structuredClone(src))
    d.project.scope.introEnd = doc.project.scope.introEnd
    d.project.captions = { ...d.project.captions, mode: doc.project.captions.mode, spans: doc.project.captions.spans }
  }, { bypassLock: true })
}
