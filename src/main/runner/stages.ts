/**
 * Splits the work into runs, each on the model chosen for that part of the edit.
 *
 * A staged edit (Start edit, Resume) runs one group of checklist stages at a time: consecutive
 * unfinished stages that share a model go in one run. Each run marks its stages done and leaves a
 * handoff note, and the next run (possibly on another model) carries on from there. Everything
 * else (chat, re-edits, fixes) runs as one request type at a time on that type's model.
 */
import {
  RECOMMENDED_MODELS,
  sectionForRequest,
  type ModelSection
} from '@shared/claudeModels'
import { CHECKLIST_STAGES, type EditRequest, type Project, type RequestKind } from '@shared/project'

export const STAGED_KINDS: RequestKind[] = ['start_edit', 'resume']

export interface RunPlan {
  requests: EditRequest[]
  section: ModelSection
  /** Model id for this run; '' = Claude Code's own default. */
  model: string
  /** Checklist stages this run is limited to (empty = no stage limit). */
  stages: string[]
  /** Stages still to do after this run's, within the edit's scope. */
  laterStages: string[]
}

export function modelFor(models: Record<string, string>, section: ModelSection): string {
  return section in models ? models[section] : RECOMMENDED_MODELS[section]
}

/** Stages that belong to the edit: Just the intro stops before thumbnails and the publishing pack. */
export function stagesInScope(project: Project): string[] {
  const all = CHECKLIST_STAGES.map(([id]) => id as string)
  return project.scope.mode === 'intro' ? all.filter((s) => s !== 'thumbnails' && s !== 'publish') : all
}

export function planRun(open: EditRequest[], project: Project, models: Record<string, string>): RunPlan | null {
  if (!open.length) return null
  // A request already in progress goes first, then the oldest.
  const first = open.find((r) => r.status === 'in_progress') ?? open[0]

  if (STAGED_KINDS.includes(first.kind)) {
    const requests = open.filter((r) => STAGED_KINDS.includes(r.kind))
    const scope = stagesInScope(project)
    const remaining = project.checklist.filter((c) => scope.includes(c.id) && c.status !== 'done').map((c) => c.id)
    if (!remaining.length) {
      // Every stage is done: one closing run (status, thumbnails, publishing pack, finish).
      return { requests, section: 'cuts', model: modelFor(models, 'cuts'), stages: [], laterStages: [] }
    }
    const section = remaining[0] as ModelSection
    const model = modelFor(models, section)
    const stages: string[] = []
    for (const s of remaining) {
      if (modelFor(models, s as ModelSection) !== model) break
      stages.push(s)
    }
    return { requests, section, model, stages, laterStages: remaining.slice(stages.length) }
  }

  // Continuing past an approved intro re-does every stage for the rest of the video in one run,
  // on the cutting model: the checklist already shows the intro's stages as done.
  if (first.kind === 'continue_intro') {
    return { requests: open.filter((r) => r.kind === 'continue_intro'), section: 'cuts', model: modelFor(models, 'cuts'), stages: [], laterStages: [] }
  }

  const section = sectionForRequest(first.kind) ?? 'chat'
  const requests = open.filter((r) => (sectionForRequest(r.kind) ?? 'chat') === section && !STAGED_KINDS.includes(r.kind) && r.kind !== 'continue_intro')
  return { requests, section, model: modelFor(models, section), stages: [], laterStages: [] }
}

const STAGE_LABEL = Object.fromEntries(CHECKLIST_STAGES) as Record<string, string>

/** Added to the run prompt for a staged run. */
export function stageInstructions(plan: RunPlan): string {
  if (!plan.stages.length) return ''
  const names = plan.stages.map((s) => STAGE_LABEL[s] ?? s)
  const lines = [
    `THIS RUN COVERS ONLY THESE CHECKLIST STAGES: ${names.join(', ')}.`,
    'Do them now, mark each one done with update_checklist, and write a handoff note for whoever does the next stage.',
    plan.laterStages.length
      ? `Do not start later stages (${plan.laterStages.map((s) => STAGE_LABEL[s] ?? s).join(', ')}): the app starts them next, possibly on another model. ` +
        'Do not call finish_request yet; end your turn when your stages are done.'
      : 'These are the last stages: when they are done, carry out the closing steps of the request above and call finish_request.'
  ]
  if (plan.stages.includes('transcript')) {
    lines.push(
      'Transcript: run faster-whisper with word timings and save its JSON output to a file, then call save_transcript with that file ' +
        '(the file parameter) instead of sending the words one by one. It is the same transcript at a fraction of the cost.'
    )
  }
  if (plan.stages.includes('cuts') && plan.laterStages.length) {
    lines.push(
      'After the cuts, write in your handoff note a concrete plan for the later stages: which B-roll, graphics, music cues and sound ' +
        'effects go where (anchored to transcript words, with what each graphic says and how long it stays up). The later stages follow your plan.'
    )
  }
  return lines.join('\n')
}

export function doneStageCount(project: Project): number {
  return project.checklist.filter((c) => c.status === 'done').length
}
