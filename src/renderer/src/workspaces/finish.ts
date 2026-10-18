/** The Finish And Export step at the end of the flow (placeholder: opens the export dialog for now). */
import { openDialog } from '../state/editor'

export function finishAndExport(): void {
  openDialog({ kind: 'export' })
}
