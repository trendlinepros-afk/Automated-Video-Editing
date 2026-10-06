/**
 * Learned corrections. The app watches for the same kind of manual tweak on a channel and, once it
 * has happened on a few different videos, suggests a rule in plain words. Nothing becomes a rule
 * without a yes, and the app never applies a correction to a video itself.
 */
import { CORRECTION_KINDS, CorrectionStatSchema, type CorrectionKind } from '@shared/settings'
import type { Suggestion } from '@shared/ipc'
import type { AppContext, CorrectionsService } from '../context'
import { newId } from '../project/store'

/** A kind is suggested once it has happened on this many different projects. */
export const SUGGEST_AFTER_PROJECTS = 2

/** "Keep music quieter under speech on this channel?" -> "Keep music quieter under speech." */
export function ruleText(kind: CorrectionKind): string {
  return CORRECTION_KINDS[kind].replace(/ on this channel\?$/, '.').replace(/\?$/, '.')
}

const isKind = (k: string): k is CorrectionKind => Object.prototype.hasOwnProperty.call(CORRECTION_KINDS, k)

export function createCorrectionsService(ctx: AppContext): CorrectionsService {
  return {
    record(kind, projectId, profileId) {
      const profile = ctx.profiles.get(profileId)
      if (!profile) return
      const stat = CorrectionStatSchema.parse(profile.corrections[kind] ?? {})
      stat.count += 1
      if (!stat.projects.includes(projectId)) stat.projects.push(projectId)
      let suggest = false
      if (stat.state === 'watching' && stat.projects.length >= SUGGEST_AFTER_PROJECTS) {
        stat.state = 'suggested'
        suggest = true
      }
      profile.corrections[kind] = stat
      try {
        ctx.profiles.save(profile)
      } catch (err) {
        ctx.appLog.write('error', 'Could not save a learned correction', { error: String(err) })
        return
      }
      if (suggest) {
        const s: Suggestion = { profileId, kind, text: CORRECTION_KINDS[kind] }
        ctx.appLog.write('app', `Suggesting a rule for "${profile.name}": ${s.text}`, { kind, projects: stat.projects.length })
        ctx.send('profiles:suggestion', s)
      }
    },

    suggestions() {
      const out: Suggestion[] = []
      for (const p of ctx.profiles.list()) {
        for (const [kind, stat] of Object.entries(p.corrections)) {
          if (stat.state === 'suggested' && isKind(kind)) out.push({ profileId: p.id, kind, text: CORRECTION_KINDS[kind] })
        }
      }
      return out
    },

    answer(profileId, kind, accept) {
      const profile = ctx.profiles.get(profileId)
      if (!profile || !isKind(kind)) return
      const stat = CorrectionStatSchema.parse(profile.corrections[kind] ?? {})
      stat.state = accept ? 'accepted' : 'dismissed'
      profile.corrections[kind] = stat
      if (accept) {
        const text = ruleText(kind)
        if (!profile.rules.some((r) => r.text === text)) {
          profile.rules.push({ id: newId('rule'), text, enabled: true, source: 'learned', createdAt: new Date().toISOString() })
        }
      }
      ctx.profiles.save(profile)
      ctx.appLog.write('app', `${accept ? 'Rule added' : 'Suggestion dismissed'} for "${profile.name}": ${CORRECTION_KINDS[kind]}`)
    }
  }
}
