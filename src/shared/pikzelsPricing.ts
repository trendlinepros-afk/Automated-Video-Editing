/**
 * What each Pikzels action costs, in US dollars per call. Pikzels bills API credits, not Claude usage.
 * These are the published prices on the date below. The owner can override any of them in Settings
 * (stored in settings.pikzels.prices) when Pikzels changes its prices, without an app update.
 */

export const PIKZELS_PRICES_UPDATED = 'May 11, 2026'

export const PIKZELS_MODELS = ['pkz_4_5', 'pkz_4', 'pkz_3', 'pkz_2'] as const
export type PikzelsModel = (typeof PIKZELS_MODELS)[number]

export const PIKZELS_MODEL_LABELS: Record<PikzelsModel, string> = {
  pkz_4_5: 'PKZ-4.5 (newest)',
  pkz_4: 'PKZ-4',
  pkz_3: 'PKZ-3',
  pkz_2: 'PKZ-2'
}

/** Personas and styles only work on these models. */
export const PIKZONALITY_MODELS: readonly string[] = ['pkz_4', 'pkz_4_5']

export const supportsPikzonality = (model: string): boolean => PIKZONALITY_MODELS.includes(model)

export type PikzelsAction = 'thumbnail' | 'recreate' | 'edit' | 'faceswap' | 'score' | 'title' | 'style_training' | 'persona_training'

export const PIKZELS_ACTION_LABELS: Record<PikzelsAction, string> = {
  thumbnail: 'Thumbnail',
  recreate: 'Recreate',
  edit: 'Edit thumbnail',
  faceswap: 'Face swap',
  score: 'Score thumbnail',
  title: 'Titles',
  style_training: 'Style training',
  persona_training: 'Persona training'
}

/** Actions whose price depends on the model. */
const PER_MODEL: PikzelsAction[] = ['thumbnail', 'recreate']

export interface PriceRow {
  key: string
  label: string
  action: PikzelsAction
  model?: PikzelsModel
  usd: number
}

const MODEL_NAMES: Record<PikzelsModel, string> = { pkz_4_5: 'PKZ-4.5', pkz_4: 'PKZ-4', pkz_3: 'PKZ-3', pkz_2: 'PKZ-2' }

function row(action: PikzelsAction, usd: number, model?: PikzelsModel, label?: string): PriceRow {
  return { key: priceKey(action, model), label: label ?? (model ? `${MODEL_NAMES[model]} ${PIKZELS_ACTION_LABELS[action]}` : PIKZELS_ACTION_LABELS[action]), action, ...(model ? { model } : {}), usd }
}

/** The published price list, in the order Pikzels lists it. */
export const PIKZELS_PRICES: PriceRow[] = [
  row('thumbnail', 0.13, 'pkz_4_5'),
  row('thumbnail', 0.37, 'pkz_4'),
  row('thumbnail', 0.16, 'pkz_3'),
  row('thumbnail', 0.2, 'pkz_2'),
  row('recreate', 0.13, 'pkz_4_5'),
  row('recreate', 0.36, 'pkz_4'),
  row('recreate', 0.18, 'pkz_3'),
  row('recreate', 0.2, 'pkz_2'),
  row('edit', 0.12, undefined, 'Edit Thumbnail'),
  row('faceswap', 0.12, undefined, 'Face Swap Thumbnail'),
  row('score', 0.03, undefined, 'Score Thumbnail'),
  row('title', 0.08, undefined, 'Text To Title'),
  row('style_training', 0.38),
  row('persona_training', 0.38)
]

/** key -> USD per call. */
export type PriceTable = Record<string, number>

export function priceKey(action: PikzelsAction, model?: string): string {
  return PER_MODEL.includes(action) ? `${action}:${model || 'pkz_4_5'}` : action
}

export function defaultPrices(): PriceTable {
  return Object.fromEntries(PIKZELS_PRICES.map((r) => [r.key, r.usd]))
}

/** The prices in use: the published list with the owner's overrides on top. */
export function effectivePrices(overrides?: PriceTable | null): PriceTable {
  const out = defaultPrices()
  for (const [k, v] of Object.entries(overrides ?? {})) if (k in out && Number.isFinite(v) && v >= 0) out[k] = v
  return out
}

/** Cost in USD of one call. */
export function costFor(action: PikzelsAction, model?: string, overrides?: PriceTable | null): number {
  return effectivePrices(overrides)[priceKey(action, model)] ?? 0
}

/** "$0.39". Sums are rounded to cents for display only. */
export function formatUsd(usd: number): string {
  return `$${(Math.round(usd * 100) / 100).toFixed(2)}`
}

/** Running spend: total and per price key. Only successful calls are counted. */
export interface PikzelsSpend {
  total: number
  byAction: Record<string, number>
  [k: string]: unknown
}

export function addSpend(spend: PikzelsSpend | undefined, key: string, usd: number): PikzelsSpend {
  const cur = spend ?? { total: 0, byAction: {} }
  const round = (n: number) => Math.round(n * 10000) / 10000
  return { ...cur, total: round((cur.total ?? 0) + usd), byAction: { ...(cur.byAction ?? {}), [key]: round((cur.byAction?.[key] ?? 0) + usd) } }
}

/** Label of a price key, e.g. "PKZ-4.5 Thumbnail". */
export function priceLabel(key: string): string {
  return PIKZELS_PRICES.find((r) => r.key === key)?.label ?? key
}
