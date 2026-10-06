/**
 * What Claude runs cost. Claude Code reports each run's cost (API-equivalent USD) and tokens per
 * model in its final "result" event; the app adds that up per project and keeps averages per kind of
 * work so it can show an estimate before the next run. On a Claude subscription the dollars are
 * not billed: they show how much of the plan's usage a task takes.
 */
import { DEFAULT_ESTIMATES, RECOMMENDED_MODELS, sectionForRequest, type ClaudeRunCost, type ModelSection } from '@shared/claudeModels'
import type { Project, RequestKind } from '@shared/project'
import type { ClaudeEstimate } from '@shared/ipc'
import type { AppContext } from '../context'
import type { ProjectStore } from '../project/store'
import { STAGED_KINDS, type RunPlan } from './stages'

const RUNS_KEPT = 500

/** Minutes of footage in the project, for per-minute edit estimates. */
export function footageMinutes(project: Project): number {
  const secs = project.sources.filter((s) => s.origin === 'footage' && s.kind !== 'image').reduce((t, s) => t + (s.duration || 0), 0)
  return secs / 60
}

/** Turns Claude Code's result event into a cost record. */
export function costFromResult(plan: RunPlan, result: Record<string, any>, now = new Date()): ClaudeRunCost | null {
  const costUsd = Number(result.total_cost_usd ?? result.cost_usd ?? NaN)
  if (!Number.isFinite(costUsd)) return null
  const byModel: ClaudeRunCost['byModel'] = {}
  const usage = result.modelUsage ?? result.model_usage
  if (usage && typeof usage === 'object') {
    for (const [model, u] of Object.entries(usage as Record<string, any>)) {
      byModel[model] = {
        costUsd: Number(u?.costUSD ?? u?.cost_usd ?? 0) || 0,
        inputTokens: Number(u?.inputTokens ?? u?.input_tokens ?? 0) || 0,
        outputTokens: Number(u?.outputTokens ?? u?.output_tokens ?? 0) || 0,
        cacheReadInputTokens: Number(u?.cacheReadInputTokens ?? u?.cache_read_input_tokens ?? 0) || 0,
        cacheCreationInputTokens: Number(u?.cacheCreationInputTokens ?? u?.cache_creation_input_tokens ?? 0) || 0
      }
    }
  }
  return {
    ts: now.toISOString(),
    kinds: [...new Set(plan.requests.map((r) => r.kind))],
    stages: plan.stages,
    section: plan.section,
    model: plan.model,
    costUsd,
    ...(typeof result.duration_ms === 'number' ? { durationMs: result.duration_ms } : {}),
    ...(typeof result.num_turns === 'number' ? { turns: result.num_turns } : {}),
    ...(Object.keys(byModel).length ? { byModel } : {})
  }
}

/** Adds a finished run to the project's total, the all-time total and the averages for estimates. */
export function recordRunCost(ctx: AppContext, store: ProjectStore, plan: RunPlan, result: Record<string, any>): ClaudeRunCost | null {
  const rec = costFromResult(plan, result)
  if (!rec) return null
  store.mutate('Claude run cost', 'app', (d) => {
    const c = d.project.claudeCosts ?? { totalUsd: 0, runs: [] }
    c.totalUsd = round(c.totalUsd + rec.costUsd)
    c.runs = [...c.runs, rec].slice(-RUNS_KEPT)
    d.project.claudeCosts = c
  }, { bypassLock: true, noHistory: true })

  const settings = ctx.settings.get()
  const claude = settings.claude ?? { models: {}, stats: {}, totalUsd: 0 }
  const stats = { ...claude.stats }
  const add = (key: string, usd: number) => {
    const s = stats[key] ?? { total: 0, count: 0 }
    stats[key] = { total: round(s.total + usd), count: s.count + 1 }
  }
  // Staged edits are averaged per finished edit (below); other work per run.
  if (!plan.stages.length && !plan.requests.some((r) => STAGED_KINDS.includes(r.kind))) add(plan.section, rec.costUsd)
  // When a staged edit has just finished, average its whole cost per minute of footage.
  const edit = plan.requests.find((r) => r.kind === 'start_edit')
  const editOpen = edit && ctx.requests.open().some((r) => r.id === edit.id)
  const counted = store.project.claudeCosts?.editsCounted ?? []
  if (edit && !editOpen && !counted.includes(edit.id)) {
    const mins = footageMinutes(store.project)
    const editCost = (store.project.claudeCosts?.runs ?? [])
      .filter((r) => r.ts >= edit.createdAt && (r.stages.length || r.kinds.some((k) => STAGED_KINDS.includes(k as RequestKind))))
      .reduce((t, r) => t + r.costUsd, 0)
    if (mins > 0.2 && editCost > 0) add('edit_per_min', editCost / mins)
    // Each finished edit is averaged once.
    store.mutate('Claude edit cost counted', 'app', (d) => {
      const c = d.project.claudeCosts ?? { totalUsd: 0, runs: [] }
      d.project.claudeCosts = { ...c, editsCounted: [...(c.editsCounted ?? []), edit.id].slice(-50) }
    }, { bypassLock: true, noHistory: true })
  }
  ctx.settings.update({ claude: { ...claude, stats, totalUsd: round((claude.totalUsd ?? 0) + rec.costUsd) } })
  store.log.write('claude', `Claude run cost about $${rec.costUsd.toFixed(4)} (${rec.model || 'default model'}, ${plan.stages.length ? `stages: ${plan.stages.join(', ')}` : plan.section})`, {
    costUsd: rec.costUsd,
    byModel: rec.byModel ?? null
  })
  return rec
}

/** Price of a model relative to Opus 5.5, for scaling first-run guesses when you pick cheaper models. */
function relativePrice(model: string): number {
  if (model.includes('haiku')) return 0.3
  if (model.includes('sonnet')) return 0.6
  return 1
}

/** An estimate shown before a task runs: your measured average when there is one, else a first guess. */
export function estimate(ctx: AppContext, project: Project | null, kind: RequestKind, opts: { scope?: 'whole' | 'intro' } = {}): ClaudeEstimate {
  const claude = ctx.settings.get().claude ?? { models: {}, stats: {}, totalUsd: 0 }
  const modelOf = (s: ModelSection) => (s in claude.models ? claude.models[s] : RECOMMENDED_MODELS[s])
  if (kind === 'start_edit' || kind === 'resume' || kind === 'continue_intro') {
    const mins = project ? footageMinutes(project) : 0
    // Just the intro reads the whole video but edits only the opening: roughly a third of a full edit.
    const share = (opts.scope ?? project?.scope.mode) === 'intro' && kind === 'start_edit' ? 0.35 : 1
    const s = claude.stats.edit_per_min
    if (s?.count) {
      const per = s.total / s.count
      return { usd: round(per * mins * share), measured: true, basis: `your average of $${per.toFixed(2)} per minute of footage over ${s.count} edit${s.count > 1 ? 's' : ''}` }
    }
    // First guess: the per-minute default is for the recommended models; scale for the models chosen.
    const stages: ModelSection[] = ['transcript', 'cuts', 'broll', 'graphics', 'audio', 'captions', 'self_check', 'thumbnails', 'publish']
    const ratio = stages.reduce((t, st) => t + relativePrice(modelOf(st)) / relativePrice(RECOMMENDED_MODELS[st]), 0) / stages.length
    return {
      usd: round(DEFAULT_ESTIMATES.editPerFootageMinute * ratio * mins * share),
      measured: false,
      basis: `a first guess of about $${(DEFAULT_ESTIMATES.editPerFootageMinute * ratio).toFixed(2)} per minute of footage until this PC has measured a finished edit`
    }
  }
  const section = sectionForRequest(kind) ?? 'chat'
  const s = claude.stats[section]
  if (s?.count) return { usd: round(s.total / s.count), measured: true, basis: `your average over ${s.count} run${s.count > 1 ? 's' : ''}` }
  const guess = (DEFAULT_ESTIMATES as Record<string, number>)[section] ?? DEFAULT_ESTIMATES.chat
  return { usd: round(guess * (relativePrice(modelOf(section)) / relativePrice(RECOMMENDED_MODELS[section]))), measured: false, basis: 'a first guess until this PC has measured one' }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}
