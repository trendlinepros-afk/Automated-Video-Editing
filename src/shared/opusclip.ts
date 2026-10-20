/** OpusClip shorts: types shared by the main process and the Shorts tab. */

/** Everything OpusClip's API lets you choose when it makes clips from a video. */
export interface OpusClipOptions {
  /** The video file to send (normally the finished export). */
  sourcePath: string
  /** Name of the project at OpusClip. */
  title?: string
  /** Brand template (captions style, logo, layout) from your OpusClip account. */
  brandTemplateId?: string
  /** ClipBasic: talking-head videos, guided by keywords. ClipAnything: any video, guided by a prompt. */
  model?: 'ClipBasic' | 'ClipAnything'
  /** Clip lengths to aim for, each [min, max] seconds, e.g. [[0, 30], [30, 60]]. */
  clipDurations?: [number, number][]
  topicKeywords?: string[]
  /** What to look for (ClipAnything), e.g. "every drift and the price reveal". */
  customPrompt?: string
  genre?: string
  /** Only clip this part of the video (seconds). */
  rangeStart?: number
  rangeEnd?: number
  /** Upload only, no clipping (to use the video in OpusClip yourself). */
  skipCurate?: boolean
  layoutAspectRatio?: 'portrait' | 'landscape' | 'square'
  removeFillerWords?: boolean
  /** Spoken language, ISO code or "auto". */
  sourceLang?: string
  /** OpusClip emails this address when the clips are ready (or failed). */
  notifyEmail?: string
  notifyOnFailure?: boolean
  /** OpusClip calls this URL when the clips are ready. */
  webhookUrl?: string
}

export type OpusRunPhase = 'preparing' | 'uploading' | 'processing' | 'complete' | 'failed'

export interface OpusClipItem {
  /** Full id, "<projectId>.<curationId>". */
  id: string
  curationId: string
  title: string
  previewUrl?: string
  exportUrl?: string
  durationSeconds?: number
  score?: number
  description?: string
  hashtags?: string
  /** Other simple fields OpusClip sends about the clip, shown as details. */
  extra: Record<string, string | number | boolean>
  /** Local copy, once downloaded. */
  file?: string
  censor?: { jobId?: string; status: string; beep: boolean; error?: string }
}

export interface OpusRun {
  /** Local id. */
  id: string
  projectId?: string
  title: string
  createdAt: string
  updatedAt: string
  sourceFile: string
  options: OpusClipOptions
  phase: OpusRunPhase
  /** OpusClip's own stage (PENDING, QUEUED, IMPORT, CURATE, REFINE, RENDER, UPLOAD, COMPLETE). */
  stage?: string
  percent?: number
  message?: string
  error?: string
  visibility?: 'DEFAULT' | 'PUBLIC'
  clips: OpusClipItem[]
}

export interface OpusTemplate {
  id: string
  name: string
}

export interface OpusAccount {
  postAccountId: string
  subAccountId?: string
  platform: string
  name: string
}

export interface OpusCollection {
  id: string
  name: string
}

export interface OpusSocialCopy {
  title: string
  description: string
  hashtags: string
  cached?: boolean
}

export interface OpusPostRequest {
  runId: string
  clipId: string
  postAccountId: string
  subAccountId?: string
  title: string
  description?: string
  /** YouTube only. */
  privacy?: 'public' | 'private' | 'unlisted'
  mediaType?: string
  /** Future time (ISO). Without it the clip posts now. */
  publishAt?: string
}

export interface OpusPostRecord {
  kind: 'posted' | 'scheduled'
  postId?: string
  scheduleId?: string
  runId: string
  clipId: string
  clipTitle: string
  account: string
  platform: string
  title: string
  publishAt?: string
  createdAt: string
  cancelled?: boolean
}

export interface OpusState {
  hasKey: boolean
  runs: OpusRun[]
  posts: OpusPostRecord[]
}

/** Newest whole-video export of a project, the default video to send. */
export interface OpusSourceInfo {
  path: string
  sizeBytes: number
  modified: string
}
