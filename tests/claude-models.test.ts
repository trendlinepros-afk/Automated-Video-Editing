import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SettingsSchema, type Settings } from '@shared/settings'
import { RECOMMENDED_MODELS } from '@shared/claudeModels'
import type { EditRequest } from '@shared/project'
import { planRun, stageInstructions } from '../src/main/runner/stages'
import { costFromResult, estimate, recordRunCost } from '../src/main/runner/costs'
import { readTranscriptFile } from '../src/main/mcp/tools/cut'
import { cleanupTemps, fakeContext, makeProject, tempDir } from './helpers/project'

afterEach(() => cleanupTemps())

const req = (kind: EditRequest['kind'], id = `req_${kind}`, extra: Partial<EditRequest> = {}): EditRequest =>
  ({ id, kind, status: 'queued', createdAt: new Date(Date.now() - 60000).toISOString(), text: '', context: {}, ...extra }) as EditRequest

function withSettings(ctx: ReturnType<typeof fakeContext>, initial: Partial<Settings> = {}) {
  let settings = SettingsSchema.parse(initial)
  ;(ctx as any).settings = {
    get: () => settings,
    update: (p: Partial<Settings>) => (settings = SettingsSchema.parse({ ...settings, ...p })),
    onChange: () => () => undefined
  }
  return () => settings
}

describe('planning runs per model', () => {
  it('groups consecutive unfinished stages that share a model, with the recommended defaults', () => {
    const store = makeProject()
    const p = store.project
    const first = planRun([req('start_edit')], p, {})!
    expect(first).toMatchObject({ section: 'transcript', model: RECOMMENDED_MODELS.transcript, stages: ['transcript'] })
    expect(stageInstructions(first)).toMatch(/save_transcript with that file/)

    store.mutate('t', 'app', (d) => {
      d.project.checklist.find((c) => c.id === 'transcript')!.status = 'done'
    })
    // With the recommended models everything after transcribing runs on Opus, as one session.
    const second = planRun([req('start_edit')], store.project, {})!
    expect(second).toMatchObject({ model: 'claude-opus-5-5', stages: ['cuts', 'broll', 'graphics', 'audio', 'captions', 'self_check', 'thumbnails', 'publish'], laterStages: [] })
    expect(stageInstructions(second)).toMatch(/last stages/)

    // When the owner picks another model for a later part, the run stops there and writes the plan for it.
    const mixed = planRun([req('start_edit')], store.project, { graphics: 'claude-sonnet-5-5' })!
    expect(mixed).toMatchObject({ model: 'claude-opus-5-5', stages: ['cuts', 'broll'] })
    expect(mixed.laterStages[0]).toBe('graphics')
    expect(stageInstructions(mixed)).toMatch(/concrete plan for the later stages/)
    expect(stageInstructions(mixed)).toMatch(/Do not call finish_request yet/)
  })

  it('recommends Opus everywhere except transcribing', () => {
    for (const [section, model] of Object.entries(RECOMMENDED_MODELS)) expect([section, model]).toEqual([section, section === 'transcript' ? 'claude-haiku-4-5' : 'claude-opus-5-5'])
  })

  it('follows the owner\'s model choices and runs other requests by their own section', () => {
    const p = makeProject().project
    const allOpus = planRun([req('start_edit')], p, { transcript: 'claude-opus-5-5', graphics: 'claude-sonnet-5-5' })!
    expect(allOpus.stages).toEqual(['transcript', 'cuts', 'broll'])
    const chat = planRun([req('chat'), req('fix_audio'), req('chat', 'req_chat2')], p, {})!
    expect(chat.section).toBe('chat')
    expect(chat.requests.map((r) => r.id)).toEqual(['req_chat', 'req_chat2'])
    expect(planRun([req('fix_audio')], p, { fix_audio: '' })!.model).toBe('')
  })

  it('stops Just the intro before thumbnails and closes out once every stage is done', () => {
    const store = makeProject()
    store.mutate('t', 'app', (d) => {
      d.project.scope.mode = 'intro'
      for (const c of d.project.checklist) if (c.id !== 'thumbnails' && c.id !== 'publish') c.status = 'done'
    })
    const closing = planRun([req('start_edit')], store.project, {})!
    expect(closing.stages).toEqual([])
    expect(stageInstructions(closing)).toBe('')
  })
})

describe('costs', () => {
  const plan = (kinds: EditRequest['kind'][], stages: string[] = [], section = 'chat') =>
    ({ requests: kinds.map((k) => req(k)), section, model: 'claude-opus-5-5', stages, laterStages: [] }) as any

  it('reads what Claude Code reports, per model', () => {
    const rec = costFromResult(plan(['chat']), {
      type: 'result',
      total_cost_usd: 0.4213,
      duration_ms: 51000,
      num_turns: 12,
      modelUsage: { 'claude-opus-5-5': { inputTokens: 1200, outputTokens: 3400, cacheReadInputTokens: 90000, cacheCreationInputTokens: 8000, costUSD: 0.4213 } }
    })!
    expect(rec).toMatchObject({ costUsd: 0.4213, turns: 12, durationMs: 51000, section: 'chat', model: 'claude-opus-5-5' })
    expect(rec.byModel!['claude-opus-5-5']).toMatchObject({ outputTokens: 3400, cacheReadInputTokens: 90000 })
    expect(costFromResult(plan(['chat']), { type: 'result' })).toBeNull()
  })

  it('adds runs to the project and the all-time total, and averages them for the next estimate', () => {
    const store = makeProject()
    const ctx = fakeContext({ store })
    const settings = withSettings(ctx)
    expect(estimate(ctx, store.project, 'chat')).toMatchObject({ measured: false })
    recordRunCost(ctx, store, plan(['chat']), { total_cost_usd: 0.3 })
    recordRunCost(ctx, store, plan(['chat']), { total_cost_usd: 0.5 })
    expect(store.project.claudeCosts!.totalUsd).toBeCloseTo(0.8)
    expect(store.project.claudeCosts!.runs).toHaveLength(2)
    expect(settings().claude.totalUsd).toBeCloseTo(0.8)
    expect(estimate(ctx, store.project, 'chat')).toMatchObject({ usd: 0.4, measured: true })
  })

  it('estimates a whole edit per minute of footage, then from finished edits', () => {
    const store = makeProject() // 100 s of footage
    const ctx = fakeContext({ store })
    withSettings(ctx)
    const guess = estimate(ctx, store.project, 'start_edit')
    expect(guess.measured).toBe(false)
    expect(guess.usd).toBeGreaterThan(0)
    // Cheaper models lower the first guess.
    withSettings(ctx, { claude: { models: Object.fromEntries(Object.keys(RECOMMENDED_MODELS).map((k) => [k, 'claude-haiku-4-5'])), stats: {}, totalUsd: 0 } } as any)
    expect(estimate(ctx, store.project, 'start_edit').usd).toBeLessThan(guess.usd)
    // A finished edit (the start_edit request is no longer open) becomes the measured average.
    withSettings(ctx)
    const edit = ctx.requests.enqueue({ kind: 'start_edit' })
    const editPlan = (stages: string[]) => ({ requests: [edit], section: stages[0], model: 'claude-opus-5-5', stages, laterStages: [] }) as any
    recordRunCost(ctx, store, editPlan(['transcript']), { total_cost_usd: 0.25 })
    expect(estimate(ctx, store.project, 'start_edit').measured).toBe(false) // the edit is still open
    ctx.requests.finish(edit.id, 'done')
    recordRunCost(ctx, store, editPlan(['cuts', 'broll']), { total_cost_usd: 1.25 })
    recordRunCost(ctx, store, editPlan(['cuts']), { total_cost_usd: 0 }) // counted once only
    const measured = estimate(ctx, store.project, 'start_edit')
    expect(measured.measured).toBe(true)
    expect(measured.usd).toBeCloseTo(1.5) // $1.50 over 100 s of footage, for the same footage
  })
})

describe('transcript from a file', () => {
  it('reads faster-whisper segments, word lists and {words}', () => {
    const dir = tempDir()
    const fw = join(dir, 'fw.json')
    writeFileSync(fw, JSON.stringify({ language: 'en', segments: [{ words: [{ word: ' Hello', start: 0.1, end: 0.4, probability: 0.9 }, { word: ' there.', start: 0.5, end: 0.8 }] }] }))
    expect(readTranscriptFile(fw)).toEqual({
      language: 'en',
      words: [
        { text: 'Hello', start: 0.1, end: 0.4, prob: 0.9 },
        { text: 'there.', start: 0.5, end: 0.8 }
      ]
    })
    const list = join(dir, 'list.json')
    writeFileSync(list, JSON.stringify([{ text: 'Hi', start: 1, end: 1.2 }]))
    expect(readTranscriptFile(list).words).toHaveLength(1)
    const empty = join(dir, 'empty.json')
    writeFileSync(empty, JSON.stringify({ segments: [{ text: 'no word times' }] }))
    expect(() => readTranscriptFile(empty)).toThrow(/word timestamps/)
  })
})
