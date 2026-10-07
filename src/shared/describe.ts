/** Plain-words names for timeline items, used in undo history and messages ("B-roll clip "Charger screen""). */
import type { Item, Project } from './project'
import { formatTime } from './timeline'

const EFFECT_NAMES: Record<string, string> = {
  grade: 'color grade',
  light_leak: 'light leak',
  vhs: 'VHS look',
  freeze: 'freeze frame',
  speed: 'speed change',
  replay: 'replay',
  custom: 'custom effect'
}

export function itemKindName(project: Pick<Project, 'tracks'>, item: Item): string {
  switch (item.type) {
    case 'segment':
      return 'A-roll cut'
    case 'clip':
      return 'B-roll clip'
    case 'graphic':
      return 'graphic'
    case 'effect':
      return `${EFFECT_NAMES[item.effect] ?? item.effect} effect`
    case 'audio': {
      const kind = project.tracks.find((t) => t.id === item.trackId)?.kind
      return kind === 'music' ? 'music' : 'sound effect'
    }
  }
}

/** e.g. B-roll clip "Charger screen", or A-roll cut from 1:02 for an unlabelled cut. */
export function itemName(project: Pick<Project, 'tracks'>, item: Item): string {
  const kind = itemKindName(project, item)
  const label = item.label?.trim()
  if (label) return `${kind} "${label.length > 40 ? `${label.slice(0, 39)}…` : label}"`
  if (item.type === 'segment') return `${kind} from ${formatTime(item.in)} of the footage`
  return kind
}

/** What an item change does, from the fields it touches. */
export function changeVerb(keys: string[], patch: Record<string, unknown> = {}): string {
  const has = (k: string) => keys.includes(k)
  if (has('picture')) return patch.picture === undefined ? 'Remove stabilization from' : 'Change the picture of'
  if (has('transform') || has('keyframes')) return 'Move or resize'
  if (has('volume') && keys.length === 1) return 'Change the volume of'
  if ((has('fadeIn') || has('fadeOut')) && keys.every((k) => k === 'fadeIn' || k === 'fadeOut')) return 'Change the fades of'
  if (has('speed') && keys.length === 1) return 'Change the speed of'
  if (has('label') && keys.length === 1) return 'Rename'
  if (has('muted') && keys.length === 1) return patch.muted ? 'Mute' : 'Unmute'
  if (has('params')) return 'Change the settings of'
  if (has('anchor')) return 'Move'
  if (has('duration')) return 'Change the length of'
  return 'Change'
}
