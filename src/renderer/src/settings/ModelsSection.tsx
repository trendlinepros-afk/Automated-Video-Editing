/**
 * Settings > Claude models: which Claude model runs each part of the edit, and what Claude has cost.
 * Recommended defaults keep Opus where judgment decides quality and use cheaper models elsewhere.
 */
import {
  CLAUDE_MODELS,
  MODEL_PRICES,
  MODEL_PRICES_UPDATED,
  MODEL_SECTIONS,
  RECOMMENDED_MODELS,
  modelLabel,
  type ModelSection
} from '@shared/claudeModels'
import { app, updateSettings } from '../state/app'
import { useStore } from '../state/store'

export function ModelsSection() {
  const settings = useStore(app, (s) => s.settings)!
  const claude = settings.claude ?? { models: {}, stats: {}, totalUsd: 0 }
  const chosen = (id: ModelSection) => (id in claude.models ? claude.models[id] : RECOMMENDED_MODELS[id])
  const allRecommended = MODEL_SECTIONS.every((s) => chosen(s.id) === RECOMMENDED_MODELS[s.id])

  const set = (id: ModelSection, model: string) => void updateSettings({ claude: { ...claude, models: { ...claude.models, [id]: model } } })
  const reset = () => void updateSettings({ claude: { ...claude, models: {} } })

  const stats = claude.stats ?? {}
  const perMin = stats.edit_per_min?.count ? stats.edit_per_min.total / stats.edit_per_min.count : null

  return (
    <>
      <h1 style={{ marginBottom: 8 }}>Claude models</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Each part of an edit runs as its own Claude run, so each can use its own model. The recommended set keeps Opus 5.5 where
        judgment decides quality (cutting, B-roll, self-check, your requests) and uses cheaper models for well-specified work. That
        is about a quarter cheaper than Opus everywhere, with no noticeable quality drop.
      </p>

      <div className="section col">
        <div className="row">
          <h3 className="grow">Model for each part</h3>
          <button className="btn small" disabled={allRecommended} onClick={reset}>
            Reset to recommended
          </button>
        </div>
        <table className="model-table">
          <thead>
            <tr>
              <th>Part of the edit</th>
              <th>Model</th>
              <th className="muted">Recommended</th>
            </tr>
          </thead>
          <tbody>
            {MODEL_SECTIONS.map((s) => {
              const value = chosen(s.id)
              const changed = value !== RECOMMENDED_MODELS[s.id]
              return (
                <tr key={s.id}>
                  <td>
                    <div>{s.label}</div>
                    <div className="hint">{s.detail}</div>
                  </td>
                  <td>
                    <select value={value} onChange={(e) => set(s.id, e.target.value)} className={changed ? 'changed' : ''}>
                      {CLAUDE_MODELS.map((m) => (
                        <option key={m.id || 'default'} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="muted small">{modelLabel(RECOMMENDED_MODELS[s.id])}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <span className="hint">
          Changes apply from the next Claude run. A part that runs on a different model from the one before starts a fresh Claude
          session that picks up from the progress checklist and handoff notes.
        </span>
      </div>

      <div className="section col">
        <h3>What Claude has cost</h3>
        <div className="row" style={{ gap: 24, flexWrap: 'wrap' }}>
          <div>
            <div className="hint">All time on this PC</div>
            <div className="big-number">${(claude.totalUsd ?? 0).toFixed(2)}</div>
          </div>
          <div>
            <div className="hint">Average edit</div>
            <div className="big-number">{perMin === null ? '—' : `$${perMin.toFixed(2)}/min`}</div>
          </div>
          {(['chat', 'reedit', 'fix_audio', 'stabilize', 'publish'] as const).map((k) =>
            stats[k]?.count ? (
              <div key={k}>
                <div className="hint">Average {MODEL_SECTIONS.find((s) => s.id === k)?.label.toLowerCase()}</div>
                <div className="big-number">${(stats[k].total / stats[k].count).toFixed(2)}</div>
              </div>
            ) : null
          )}
        </div>
        <span className="hint">
          Costs are what Claude Code reports for each run, at API prices. On a Claude Pro or Max plan you are not billed per run: the
          figures show how much of your plan's usage each task takes. Estimates before a task use these averages once there are some.
        </span>
      </div>

      <div className="section col">
        <h3>Prices</h3>
        <table className="model-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Input</th>
              <th>Output</th>
              <th>Cached input</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(MODEL_PRICES).map(([id, p]) => (
              <tr key={id}>
                <td>{modelLabel(id)}</td>
                <td>${p.input.toFixed(2)}</td>
                <td>${p.output.toFixed(2)}</td>
                <td>${p.cacheRead.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <span className="hint">USD per million tokens, Claude API list prices as of {MODEL_PRICES_UPDATED}.</span>
      </div>
    </>
  )
}
