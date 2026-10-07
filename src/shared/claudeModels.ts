/**
 * Which Claude model runs each part of an edit, and what runs cost.
 *
 * The app runs an edit as stages, each its own Claude Code run with its own model; stages pick up
 * from the progress checklist and handoff notes. Defaults keep Opus where judgment decides quality
 * (cuts, B-roll, self-check, open-ended requests) and use cheaper models where the work is well specified.
 */
import type { RequestKind, StageId } from './project'

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', note: 'Best judgment. Cuts, timing, open-ended requests.' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', note: 'Strong and half the price. Well-specified work.' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: 'Fastest and cheapest. Simple bookkeeping.' },
  { id: '', label: 'Claude Code default', note: 'Whatever model Claude Code is set to use.' }
] as const

export type ClaudeModelId = (typeof CLAUDE_MODELS)[number]['id']

/** USD per million tokens (Claude API list prices, cached 2026-09-25). Used only for estimates;
 * finished runs use the cost Claude Code itself reports. */
export const MODEL_PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }
}
export const MODEL_PRICES_UPDATED = '2026-09-25'

/** Parts of the work that can each have their own model. */
export const MODEL_SECTIONS = [
  { id: 'transcript', label: 'Transcribing', detail: 'Runs faster-whisper on your GPU and hands the transcript file to the app. No judgment needed.', stage: true },
  { id: 'cuts', label: 'Cutting', detail: 'Chooses takes, removes dead space, writes the edit decision list and the plan for graphics and sound.', stage: true },
  { id: 'broll', label: 'B-roll', detail: 'Chooses and times cutaways against the words.', stage: true },
  { id: 'graphics', label: 'Graphics', detail: 'Writes the graphic code files and places them from the plan made while cutting.', stage: true },
  { id: 'audio', label: 'Music and sound', detail: 'Composes music, places sound effects, sets the mix.', stage: true },
  { id: 'captions', label: 'Captions', detail: 'Checks caption words and marks emphasis.', stage: true },
  { id: 'self_check', label: 'Self-check', detail: 'Re-transcribes the cut and fixes clipped or doubled words in 5 ms steps.', stage: true },
  { id: 'thumbnails', label: 'Thumbnails', detail: 'Writes thumbnail prompts for Pikzels.', stage: true },
  { id: 'publish', label: 'Publishing pack', detail: 'Titles, description, chapters and tags.', stage: true },
  { id: 'chat', label: 'Chat and notes', detail: 'Changes you ask for in the chat or in notes for Claude.', stage: false },
  { id: 'reedit', label: 'Section re-edits', detail: 'Re-edit section and intro redo.', stage: false },
  { id: 'fix_audio', label: 'Fix clipped audio', detail: 'Restores one clipped word at a cut.', stage: false },
  { id: 'stabilize', label: 'Stabilize', detail: 'Stabilizes one clip you right-click. ffmpeg does the work; the model runs it and checks the framing.', stage: false }
] as const

export type ModelSection = (typeof MODEL_SECTIONS)[number]['id']

/** Recommended: no noticeable quality drop, about a quarter cheaper than Opus everywhere. */
export const RECOMMENDED_MODELS: Record<ModelSection, ClaudeModelId> = {
  transcript: 'claude-haiku-4-5',
  cuts: 'claude-opus-5-5',
  broll: 'claude-opus-5-5',
  graphics: 'claude-sonnet-5-5',
  audio: 'claude-sonnet-5-5',
  captions: 'claude-sonnet-5-5',
  self_check: 'claude-opus-5-5',
  thumbnails: 'claude-sonnet-5-5',
  publish: 'claude-sonnet-5-5',
  chat: 'claude-opus-5-5',
  reedit: 'claude-opus-5-5',
  fix_audio: 'claude-opus-5-5',
  stabilize: 'claude-sonnet-5-5'
}

export function modelLabel(id: string | undefined | null): string {
  if (!id) return 'Claude Code default'
  return CLAUDE_MODELS.find((m) => m.id === id)?.label ?? id
}

/** The section a request (other than a staged edit) runs under. */
export function sectionForRequest(kind: RequestKind): ModelSection | null {
  switch (kind) {
    case 'chat':
    case 'thumbnail_direction':
      return 'chat'
    case 'reedit':
    case 'redo_intro':
      return 'reedit'
    case 'fix_audio':
      return 'fix_audio'
    case 'stabilize':
      return 'stabilize'
    case 'publish_regen':
      return 'publish'
    default:
      return null // start_edit, continue_intro, resume: staged by the checklist
  }
}

export function isStageSection(id: string): id is StageId & ModelSection {
  return MODEL_SECTIONS.some((s) => s.id === id && s.stage)
}

// ------------------------------------------------------------------ cost records

export interface ClaudeRunCost {
  [k: string]: unknown
  ts: string
  /** Request kinds this run worked on. */
  kinds: string[]
  /** Checklist stages this run was asked to do (staged edits). */
  stages: string[]
  section: string
  model: string
  costUsd: number
  durationMs?: number
  turns?: number
  /** Per model, as Claude Code reports it (a run can use more than one). */
  byModel?: Record<string, { [k: string]: unknown; costUsd: number; inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>
}

/** Rough first guesses (USD) before this PC has measured anything. Replaced by your own averages. */
export const DEFAULT_ESTIMATES = {
  /** A whole staged edit, per minute of footage, with the recommended models. */
  editPerFootageMinute: 0.45,
  chat: 0.35,
  reedit: 0.6,
  fix_audio: 0.15,
  stabilize: 0.12,
  publish: 0.12
}
