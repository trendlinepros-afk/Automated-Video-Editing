/** Every tool the app exposes to Claude, in the order Claude sees them. */
import type { ToolDef } from './common'
import { channelTools } from './channel'
import { cutTools } from './cut'
import { graphicsTools } from './graphics'
import { lookTools } from './look'
import { outputTools } from './output'
import { placeTools } from './place'
import { readTools } from './read'
import { shortsTools } from './shorts'
import { musicTools, progressTools, reviewTools } from './review'

export const ALL_TOOLS: ToolDef[] = [
  ...readTools,
  ...channelTools,
  ...lookTools,
  ...cutTools,
  ...placeTools,
  ...graphicsTools,
  ...musicTools,
  ...reviewTools,
  ...progressTools,
  ...outputTools,
  ...shortsTools
]

export type { ToolDef, ToolEnv, ToolResult } from './common'
