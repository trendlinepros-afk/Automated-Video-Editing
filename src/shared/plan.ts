/**
 * The render plan: the resolved timeline handed to the Python engine.
 * Everything is in absolute timeline seconds and absolute file paths. The engine never sees anchors.
 * Preview and export use the same plan; only output size and the source files (proxy or original) differ.
 */
import type { BrandKit, CaptionStyle, EffectKind, MixSettings } from './project'

export const PLAN_VERSION = 1

export interface PlanTransform {
  x: number
  y: number
  scale: number
  rotation: number
  opacity: number
}

export interface PlanKeyframe {
  t: number // seconds from layer start
  x: number
  y: number
  scale?: number
}

interface LayerBase {
  id: string
  trackId: string
  start: number
  end: number
  fadeIn: number
  fadeOut: number
}

export interface VideoLayer extends LayerBase {
  kind: 'video'
  role: 'aroll' | 'broll'
  path: string
  isImage: boolean
  sourceIn: number
  speed: number
  /** Freeze: show the frame at sourceIn for the whole layer. */
  hold: boolean
  transform: PlanTransform | null
  keyframes: PlanKeyframe[]
  /** Source frame size, so the engine can fit it to the output. */
  sourceWidth?: number
  sourceHeight?: number
}

export interface GraphicLayer extends LayerBase {
  kind: 'graphic'
  file: string
  params: Record<string, unknown>
  transform: PlanTransform | null
  keyframes: PlanKeyframe[]
}

export interface EffectLayer extends LayerBase {
  kind: 'effect'
  effect: EffectKind
  file?: string
  params: Record<string, unknown>
}

export type Layer = VideoLayer | GraphicLayer | EffectLayer

export interface PlanCaptionLine {
  start: number
  end: number
  words: { text: string; start: number; end: number; emphasis: boolean }[]
}

export interface AudioClip {
  id: string
  trackId: string
  role: 'voice' | 'music' | 'sfx' | 'broll'
  path: string
  start: number
  end: number
  sourceIn: number
  speed: number
  gainDb: number
  fadeIn: number
  fadeOut: number
  duck: boolean
  loop: boolean
}

export interface RenderPlan {
  planVersion: number
  engineVersion: string
  projectDir: string
  /** Design size of the project (4K by default). Layout values are fractions, so any output size matches. */
  design: { width: number; height: number; fps: number }
  output: { width: number; height: number; fps: number }
  duration: number
  layers: Layer[]
  captions: { burn: boolean; style: CaptionStyle; lines: PlanCaptionLine[] }
  brand: BrandKit
  audio: {
    sampleRate: number
    clips: AudioClip[]
    mix: MixSettings
    /** Fixed gain (dB) that brings the full mix to the target loudness. Measured once on the whole
     * timeline so a preview, a section export and a full export all use the same level. */
    masterGainDb: number | null
  }
}

/** One preview chunk to render. */
export interface ChunkJob {
  index: number
  start: number
  end: number
  out: string
}

/** Lines the engine prints on stdout, one JSON object per line. */
export type EngineEvent =
  | { event: 'progress'; done: number; total: number; fps?: number; message?: string }
  | { event: 'chunk_done'; index: number; out: string }
  | { event: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { event: 'result'; data: unknown }
  | { event: 'error'; message: string; trace?: string }
