/** Finish And Export, the last step of the flow: the export dialog in its Finish mode (video, thumbnails and text file). */
import { openDialog } from '../state/editor'

export function finishAndExport(): void {
  openDialog({ kind: 'export', finish: true })
}
