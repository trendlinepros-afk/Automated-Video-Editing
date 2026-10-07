/** The check that runs when you press Export: problems that would make the exported video broken or worse. */
import type { Range } from './project'

export interface ExportProblem {
  id: string
  /** error: the export would be broken. warning: very likely a mistake. info: worth a look. */
  severity: 'error' | 'warning' | 'info'
  title: string
  detail?: string
  /** Where on the timeline, to jump there. */
  range?: Range
}

export interface ExportCheckResult {
  problems: ExportProblem[]
  /** What was checked, in words ("picture and sound of the preview", ...). */
  checked: string[]
  /** Checks that could not run, and why. */
  skipped: string[]
}

export function blocking(r: ExportCheckResult): ExportProblem[] {
  return r.problems.filter((p) => p.severity !== 'info')
}
