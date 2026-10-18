/**
 * The bar along the bottom of a full-page tab: what this step is for on the left, and the button to the next step
 * (Next, or Finish And Export on the last page) in the lower right. The flow is a guide, not a lock: every tab can be
 * opened at any time from the top.
 */
import type { ReactNode } from 'react'

export function FlowFooter({ hint, children }: { hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flow-footer">
      <span className="hint grow">{hint}</span>
      {children}
    </div>
  )
}
