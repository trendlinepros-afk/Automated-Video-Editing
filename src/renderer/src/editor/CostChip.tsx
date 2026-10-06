/**
 * "Est. cost so far" next to Export: what Claude and Pikzels have cost on this project.
 * Claude's part is what Claude Code reports per run (API prices); Pikzels' part is the price per action.
 * Click for the breakdown by part of the edit and by model.
 */
import { useEffect, useRef, useState } from 'react'
import { MODEL_SECTIONS, modelLabel } from '@shared/claudeModels'
import { CHECKLIST_STAGES } from '@shared/project'
import { editor } from '../state/editor'
import { openSettings } from '../state/app'
import { useStore } from '../state/store'

const SECTION_LABEL: Record<string, string> = Object.fromEntries([
  ...MODEL_SECTIONS.map((s) => [s.id, s.label] as const),
  ...CHECKLIST_STAGES.map(([id, label]) => [id, label] as const)
])

/** Small sums need more places so a few cents still show. */
export function usd(n: number): string {
  if (n === 0) return '$0.00'
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

export function CostChip() {
  const costs = useStore(editor, (s) => s.snapshot!.doc.project.claudeCosts)
  const spend = useStore(editor, (s) => s.snapshot!.doc.project.thumbnails.spend)
  const [open, setOpen] = useState(false)
  const [flash, setFlash] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const claude = costs?.totalUsd ?? 0
  const pikzels = spend?.total ?? 0
  const total = claude + pikzels

  // A short highlight whenever the total goes up, so each iteration's cost is noticed.
  const last = useRef(total)
  useEffect(() => {
    if (total > last.current + 1e-9) {
      setFlash(true)
      const t = setTimeout(() => setFlash(false), 1600)
      last.current = total
      return () => clearTimeout(t)
    }
    last.current = total
  }, [total])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const runs = costs?.runs ?? []
  const bySection = new Map<string, number>()
  const byModel = new Map<string, number>()
  for (const r of runs) {
    const key = r.stages.length ? r.stages.map((s) => SECTION_LABEL[s] ?? s).join(' + ') : SECTION_LABEL[r.section] ?? r.section
    bySection.set(key, (bySection.get(key) ?? 0) + r.costUsd)
    const models = r.byModel && Object.keys(r.byModel).length ? Object.entries(r.byModel).map(([m, u]) => [m, u.costUsd] as const) : [[r.model, r.costUsd] as const]
    for (const [m, c] of models) byModel.set(m, (byModel.get(m) ?? 0) + c)
  }
  const lastRun = runs[runs.length - 1]

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className={`btn ghost small cost-chip${flash ? ' pulse' : ''}`}
        onClick={() => setOpen(!open)}
        title="Estimated cost of this project so far: Claude runs and Pikzels thumbnails. Click for the breakdown."
      >
        Est. cost so far {usd(total)}
      </button>
      {open && (
        <div className="popover cost-pop small" style={{ top: 34, right: 0 }}>
          <h4 style={{ marginBottom: 6 }}>Estimated cost so far</h4>
          <table>
            <tbody>
              <tr>
                <td>Claude ({runs.length} run{runs.length === 1 ? '' : 's'})</td>
                <td>{usd(claude)}</td>
              </tr>
              <tr>
                <td>Pikzels thumbnails</td>
                <td>{usd(pikzels)}</td>
              </tr>
              <tr className="total">
                <td>Total</td>
                <td>{usd(total)}</td>
              </tr>
            </tbody>
          </table>
          {bySection.size > 0 && (
            <>
              <h4 style={{ margin: '10px 0 2px' }}>Claude by part</h4>
              <table>
                <tbody>
                  {[...bySection].map(([k, v]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td>{usd(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h4 style={{ margin: '10px 0 2px' }}>Claude by model</h4>
              <table>
                <tbody>
                  {[...byModel].map(([k, v]) => (
                    <tr key={k}>
                      <td>{modelLabel(k)}</td>
                      <td>{usd(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {lastRun && (
            <div className="muted" style={{ marginTop: 6 }}>
              Last run: {usd(lastRun.costUsd)} on {modelLabel(lastRun.model)}
              {lastRun.durationMs ? `, ${Math.round(lastRun.durationMs / 1000)} s` : ''}.
            </div>
          )}
          <div className="faint" style={{ marginTop: 8 }}>
            Claude's part is what Claude Code reports at API prices. On a Pro or Max plan it is not billed: it shows how much of your
            usage this project took.{' '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault()
                setOpen(false)
                openSettings('models')
              }}
            >
              Choose models
            </a>
          </div>
        </div>
      )}
    </div>
  )
}
