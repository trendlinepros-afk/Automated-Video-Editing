/** "Estimated cost ≈ $1.20" shown before a Claude task runs, with how the number was worked out on hover. */
import { useEffect, useState } from 'react'
import type { ClaudeEstimate } from '@shared/ipc'
import type { RequestKind } from '@shared/project'
import { usd } from './CostChip'

export function EstimateNote({ estimate, prefix = 'Estimated cost' }: { estimate: ClaudeEstimate | null; prefix?: string }) {
  if (!estimate) return null
  return (
    <span className="small muted" title={`Based on ${estimate.basis}. API prices; on a Pro or Max plan it counts against your usage instead.`}>
      {prefix} ≈ {usd(estimate.usd)}
      {!estimate.measured && <span className="faint"> (first guess)</span>}
    </span>
  )
}

/** The estimate for a kind of request, refreshed when the component mounts. */
export function useEstimate(kind: RequestKind): ClaudeEstimate | null {
  const [est, setEst] = useState<ClaudeEstimate | null>(null)
  useEffect(() => {
    let live = true
    window.api.claude.estimate(kind).then((e) => live && setEst(e), () => undefined)
    return () => {
      live = false
    }
  }, [kind])
  return est
}
