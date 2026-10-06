/** What is being dragged on the timeline right now. Only the dragged block re-renders while you drag. */
import { createStore } from '../state/store'

export type DragMode = 'move' | 'trim-start' | 'trim-end' | 'seam'

export interface DragState {
  id: string | null
  mode: DragMode | null
  /** Seconds moved so far. */
  dt: number
}

export const drag = createStore<DragState>({ id: null, mode: null, dt: 0 })

export const HEADER_W = 184
export const RULER_H = 28
export const MAX_ZOOM = 800 // px per second: one pixel is about 1 ms

export function laneHeight(kind: string): number {
  switch (kind) {
    case 'aroll':
      return 58
    case 'music':
    case 'sfx':
      return 46
    case 'captions':
      return 30
    default:
      return 40
  }
}
