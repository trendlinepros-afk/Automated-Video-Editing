/**
 * Pikzels cost per action: the price list (published prices with the owner's overrides), the spend on
 * this project and the all-time spend. Used by the Thumbnails tab, Personas & Styles and Settings.
 */
import { useCallback, useEffect, useState } from 'react'
import type { PikzelsPricing } from '@shared/ipc'
import { PIKZELS_PRICES, formatUsd, priceKey, priceLabel, type PikzelsAction } from '@shared/pikzelsPricing'
import { call, toast } from '../state/app'

/** Loads the prices and the all-time spend; `reload` after an action to update the totals. */
export function usePikzelsPricing(dep?: unknown): [PikzelsPricing | null, () => void] {
  const [pricing, setPricing] = useState<PikzelsPricing | null>(null)
  const reload = useCallback(() => {
    void call(() => window.api.pikzels.pricing()).then((p) => p && setPricing(p))
  }, [])
  useEffect(reload, [reload, dep])
  return [pricing, reload]
}

/** " · $0.39" for a button label, or '' while prices load. */
export function costLabel(pricing: PikzelsPricing | null, action: PikzelsAction, model?: string, count = 1): string {
  if (!pricing) return ''
  const usd = (pricing.prices[priceKey(action, model)] ?? 0) * count
  return ` · ${formatUsd(usd)}`
}

function SpendLines({ spend }: { spend: { total: number; byAction: Record<string, number> } }) {
  const rows = Object.entries(spend.byAction ?? {}).filter(([, v]) => v > 0)
  if (!rows.length) return <span className="tiny faint">Nothing spent yet.</span>
  return (
    <div className="col" style={{ gap: 2 }}>
      {rows.map(([k, v]) => (
        <div key={k} className="row tiny">
          <span className="grow faint">{priceLabel(k)}</span>
          <span className="mono">{formatUsd(v)}</span>
        </div>
      ))}
    </div>
  )
}

/** Read-only "Cost per action" with the project spend (when given) and the all-time spend. */
export function CostPerAction({ pricing, projectSpend, only }: { pricing: PikzelsPricing | null; projectSpend?: { total: number; byAction: Record<string, number> }; only?: PikzelsAction[] }) {
  const [open, setOpen] = useState(false)
  if (!pricing) return null
  const rows = PIKZELS_PRICES.filter((r) => !only || only.includes(r.action))
  return (
    <div className="section col" style={{ gap: 6 }}>
      <div className="row">
        <h4 className="grow">Cost per action</h4>
        <a className="small" onClick={() => setOpen(!open)}>
          {open ? 'Hide prices' : 'Show prices'}
        </a>
      </div>
      <div className="row small">
        {projectSpend && (
          <span className="grow">
            This project: <b className="mono">{formatUsd(projectSpend.total ?? 0)}</b>
          </span>
        )}
        <span className={projectSpend ? '' : 'grow'}>
          All time: <b className="mono">{formatUsd(pricing.spend.total ?? 0)}</b>
        </span>
      </div>
      {open && (
        <>
          <div className="col" style={{ gap: 2 }}>
            {rows.map((r) => (
              <div key={r.key} className="row small">
                <span className="grow">{r.label}</span>
                <span className={`mono${r.key in pricing.overrides ? ' warn' : ''}`} title={r.key in pricing.overrides ? `Your price (published: ${formatUsd(r.usd)})` : undefined}>
                  {formatUsd(pricing.prices[r.key] ?? r.usd)}
                </span>
              </div>
            ))}
          </div>
          {projectSpend && (
            <>
              <span className="tiny faint">Spent on this project</span>
              <SpendLines spend={projectSpend} />
            </>
          )}
          <span className="hint">
            US dollars per call, prices updated {pricing.updated}. Only successful calls are counted. Change prices in Settings &gt; General.
          </span>
        </>
      )}
    </div>
  )
}

/** Settings: the editable price table with Reset to defaults. */
export function PriceEditor() {
  const [pricing, reload] = usePikzelsPricing()
  const [draft, setDraft] = useState<Record<string, string>>({})
  useEffect(() => {
    if (pricing) setDraft(Object.fromEntries(Object.entries(pricing.prices).map(([k, v]) => [k, String(v)])))
  }, [pricing])
  if (!pricing) return null
  const dirty = Object.entries(draft).some(([k, v]) => Number(v) !== pricing.prices[k])
  const invalid = Object.values(draft).some((v) => v.trim() === '' || !Number.isFinite(Number(v)) || Number(v) < 0)
  const save = async () => {
    const next = Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, Number(v)]))
    const p = await call(() => window.api.pikzels.setPrices(next), 'Could not save the prices')
    if (p) {
      toast('Pikzels prices saved.')
      reload()
    }
  }
  const reset = async () => {
    const p = await call(() => window.api.pikzels.setPrices(null), 'Could not reset the prices')
    if (p) {
      toast('Pikzels prices reset to the published list.')
      reload()
    }
  }
  return (
    <div className="section col">
      <h3>Pikzels cost per action</h3>
      <span className="hint">
        US dollars per call, published {pricing.updated}. When Pikzels changes its prices, type the new ones here; no app update is needed.
      </span>
      <div className="col" style={{ gap: 4, maxWidth: 420 }}>
        {PIKZELS_PRICES.map((r) => (
          <div key={r.key} className="row small">
            <span className="grow">{r.label}</span>
            {r.key in pricing.overrides && <span className="tiny faint">published {formatUsd(r.usd)}</span>}
            <span className="faint">$</span>
            <input
              type="number"
              min={0}
              step={0.01}
              style={{ width: 80 }}
              value={draft[r.key] ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, [r.key]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      <div className="row">
        <button className="btn primary" disabled={!dirty || invalid} onClick={save}>
          Save prices
        </button>
        <button className="btn ghost" disabled={!Object.keys(pricing.overrides).length} onClick={reset}>
          Reset to defaults
        </button>
        <span className="spacer" />
        <span className="small">
          All-time Pikzels spend: <b className="mono">{formatUsd(pricing.spend.total ?? 0)}</b>
        </span>
      </div>
    </div>
  )
}
