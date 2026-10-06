/**
 * Format upgrades, one step at a time. A step receives a deep copy and must never drop data:
 * fields it does not touch are kept as they are.
 *
 * To change the project format:
 *   1. bump PROJECT_FORMAT_VERSION in appInfo.ts
 *   2. add a step here from the previous version
 *   3. add a sample project for the released version under tests/fixtures/projects/
 */
import { ENGINE_VERSION, LIBRARY_FORMAT_VERSION, PROJECT_FORMAT_VERSION, SETTINGS_FORMAT_VERSION } from './appInfo'
import { CHECKLIST_STAGES, ProjectSettingsSchema } from './project'

type Json = Record<string, any>
export type MigrationStep = (doc: Json) => Json

export interface UpgradeResult<T = Json> {
  doc: T
  from: number
  to: number
  upgraded: boolean
  /** The file was written by a newer app: open read-only. */
  newer: boolean
}

function linearToDb(gain: unknown): number {
  const g = typeof gain === 'number' ? gain : 1
  if (g <= 0) return -120
  return Math.round(20 * Math.log10(g) * 100) / 100
}

/** Project format steps: key N upgrades from N to N+1. */
export const PROJECT_STEPS: Record<number, MigrationStep> = {
  1: (d) => {
    // Format 1 was written by the 0.x test builds.
    const out: Json = { ...d }
    delete out.version
    out.formatVersion = 2
    if ('created' in out) {
      out.createdAt = out.created
      delete out.created
    }
    out.updatedAt = out.updatedAt ?? out.createdAt ?? new Date(0).toISOString()
    out.createdAt = out.createdAt ?? out.updatedAt
    if ('profile' in out) {
      out.profileId = out.profile
      delete out.profile
    }
    out.profileId = out.profileId ?? 'default'
    out.appVersion = out.appVersion ?? '0.0.0'
    out.engineVersion = out.engineVersion ?? ENGINE_VERSION
    const statusMap: Record<string, string> = { review: 'ready_for_review', editing: 'editing', exported: 'exported', new: 'new' }
    out.status = statusMap[out.status] ?? 'new'
    out.inspiration = out.inspiration ?? ''
    const scopeMode = typeof out.scope === 'string' ? out.scope : out.scope?.mode ?? 'whole'
    out.scope = { mode: scopeMode === 'intro' ? 'intro' : 'whole', introMaxSeconds: null, introEnd: null, introApproved: false }
    out.output = out.output ?? { width: 3840, height: 2160, fps: 60 }
    out.sources = out.sources ?? []
    out.transcript = { file: out.transcriptFile ?? 'transcript.json' }
    delete out.transcriptFile
    out.tracks = (out.tracks ?? []).map((t: Json) => {
      const nt: Json = { ...t, volume: linearToDb(t.gain) }
      delete nt.gain
      nt.muted = !!nt.muted
      nt.solo = !!nt.solo
      nt.hidden = !!nt.hidden
      return nt
    })
    out.items = (out.items ?? []).map((it: Json) => {
      const ni: Json = { ...it }
      if (ni.type !== 'segment') {
        if (typeof ni.anchorWord === 'string') {
          ni.anchor = { kind: 'word', wordId: ni.anchorWord, offset: ni.anchorOffset ?? 0 }
        } else {
          ni.anchor = { kind: 'time', time: ni.start ?? 0 }
        }
        delete ni.anchorWord
        delete ni.anchorOffset
        delete ni.start
      }
      if ('gain' in ni) {
        ni.volume = linearToDb(ni.gain)
        delete ni.gain
      }
      return ni
    })
    const oldChecklist: Json = out.checklist && !Array.isArray(out.checklist) ? out.checklist : {}
    out.checklist = CHECKLIST_STAGES.map(([id, label]) => ({
      id,
      label,
      status: ['not_started', 'in_progress', 'done'].includes(oldChecklist[id]) ? oldChecklist[id] : 'not_started'
    }))
    out.settings = ProjectSettingsSchema.parse(out.settings ?? {})
    out.handoffNotes = out.handoffNotes ?? []
    out.requests = out.requests ?? []
    out.chat = out.chat ?? []
    out.notes = (out.notes ?? []).map((n: Json, i: number) => ({
      id: n.id ?? `note_v1_${i}`,
      text: n.text ?? String(n),
      status: n.done ? 'done' : 'open',
      createdAt: n.createdAt ?? out.createdAt,
      ...(n.itemId ? { itemId: n.itemId } : {})
    }))
    out.captions = { enabled: true }
    out.thumbnails = { personaId: '', styleId: '', count: 3, direction: '', useMyDirection: false, format: '16:9', items: [] }
    out.publish = { titles: [], description: '', chapters: [], tags: [] }
    out.lock = null
    out.selfCheck = { flags: [] }
    return out
  }
}

export const SETTINGS_STEPS: Record<number, MigrationStep> = {}
export const PROFILE_STEPS: Record<number, MigrationStep> = {}
export const LIBRARY_STEPS: Record<number, MigrationStep> = {}

export function readFormatVersion(doc: Json): number {
  if (typeof doc.formatVersion === 'number') return doc.formatVersion
  if (typeof doc.version === 'number') return doc.version // format 1 used "version"
  return 1
}

export function upgrade(raw: Json, current: number, steps: Record<number, MigrationStep>): UpgradeResult {
  const from = readFormatVersion(raw)
  if (from > current) return { doc: raw, from, to: from, upgraded: false, newer: true }
  let doc: Json = structuredClone(raw)
  for (let v = from; v < current; v++) {
    const step = steps[v]
    if (!step) throw new Error(`No upgrade step from format ${v} to ${v + 1}`)
    doc = step(structuredClone(doc))
    doc.formatVersion = v + 1
  }
  if (typeof doc.formatVersion !== 'number') doc.formatVersion = current
  return { doc, from, to: current, upgraded: from < current, newer: false }
}

export const upgradeProject = (raw: Json) => upgrade(raw, PROJECT_FORMAT_VERSION, PROJECT_STEPS)
export const upgradeSettings = (raw: Json) => upgrade(raw, SETTINGS_FORMAT_VERSION, SETTINGS_STEPS)
export const upgradeProfile = (raw: Json) => upgrade(raw, SETTINGS_FORMAT_VERSION, PROFILE_STEPS)
export const upgradeLibraryAsset = (raw: Json) => upgrade(raw, LIBRARY_FORMAT_VERSION, LIBRARY_STEPS)
