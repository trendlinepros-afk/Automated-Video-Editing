/**
 * The project format. project.json is the product: every cut, graphic, sound and timing lives here.
 *
 * Rules:
 *  - Every object is a "loose" object: fields this app does not know are kept as they are when saving.
 *  - formatVersion is bumped for every incompatible change, with a migration in migrations.ts.
 *  - IDs never change once given.
 */
import { z } from 'zod'

export const TRACK_KINDS = ['aroll', 'broll', 'graphics', 'effects', 'captions', 'music', 'sfx'] as const
export type TrackKind = (typeof TRACK_KINDS)[number]

export const TRACK_LABELS: Record<TrackKind, string> = {
  aroll: 'A-roll',
  broll: 'B-roll',
  graphics: 'Graphics',
  effects: 'Effects',
  captions: 'Captions',
  music: 'Music',
  sfx: 'Sound effects'
}

export const CHECKLIST_STAGES = [
  ['transcript', 'Transcript'],
  ['cuts', 'Cuts'],
  ['broll', 'B-roll'],
  ['graphics', 'Graphics'],
  ['audio', 'Music and sound'],
  ['captions', 'Captions'],
  ['self_check', 'Self-check'],
  ['thumbnails', 'Thumbnails'],
  ['publish', 'Publishing pack']
] as const
export type StageId = (typeof CHECKLIST_STAGES)[number][0]

export const PROJECT_STATUSES = ['new', 'editing', 'intro_ready', 'ready_for_review', 'exported'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]
export const STATUS_LABELS: Record<ProjectStatus, string> = {
  new: 'New',
  editing: 'Editing',
  intro_ready: 'Intro ready',
  ready_for_review: 'Ready for review',
  exported: 'Exported'
}

export const EFFECT_KINDS = [
  'grade', // color grade: lift, gamma, gain, saturation, temperature, contrast
  'snow',
  'light_leak',
  'vhs',
  'shake',
  'flash',
  'freeze', // hold the frame at the item's start for its length
  'speed', // play the picture under the item at another speed
  'replay', // slow-motion replay of a moment before the item
  'zoom',
  'vignette',
  'custom' // a Python code file with apply(frame, t, ctx)
] as const
export type EffectKind = (typeof EFFECT_KINDS)[number]

const num = z.number().finite()
const nonNeg = num.min(0)

export const AnchorSchema = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('word'), wordId: z.string().min(1), offset: num.default(0) }),
  z.looseObject({ kind: z.literal('time'), time: nonNeg })
])
export type Anchor = z.infer<typeof AnchorSchema>

export const TransformSchema = z.looseObject({
  x: num.default(0), // centre offset, fraction of frame width (-0.5..0.5 = edges)
  y: num.default(0),
  scale: num.positive().default(1),
  rotation: num.default(0),
  opacity: num.min(0).max(1).default(1)
})
export type Transform = z.infer<typeof TransformSchema>

export const KeyframeSchema = z.looseObject({ t: nonNeg, x: num, y: num, scale: num.positive().optional() })

const itemCommon = {
  id: z.string().min(1),
  trackId: z.string().min(1),
  label: z.string().optional(),
  createdBy: z.enum(['claude', 'user', 'app']).default('claude'),
  libraryAssetId: z.string().optional()
}

/** One kept piece of the A-roll. Segments play one after another in array order. */
export const SegmentItemSchema = z.looseObject({
  ...itemCommon,
  type: z.literal('segment'),
  sourceId: z.string().min(1),
  in: nonNeg,
  out: nonNeg,
  speed: num.positive().default(1),
  /** When set, this segment shows the frame at `in` for this many seconds (a freeze frame in the cut). */
  hold: nonNeg.optional(),
  muted: z.boolean().optional(),
  volume: num.default(0), // dB
  fadeIn: nonNeg.default(0),
  fadeOut: nonNeg.default(0)
})

const anchoredCommon = {
  ...itemCommon,
  anchor: AnchorSchema,
  duration: num.positive()
}

/** B-roll or other picture: footage, still image, or a file Claude processed its own way. */
export const ClipItemSchema = z.looseObject({
  ...anchoredCommon,
  type: z.literal('clip'),
  sourceId: z.string().optional(),
  file: z.string().optional(),
  in: nonNeg.default(0),
  speed: num.positive().default(1),
  volume: num.default(-120), // B-roll audio muted by default
  fadeIn: nonNeg.default(0),
  fadeOut: nonNeg.default(0),
  transform: TransformSchema.optional(),
  keyframes: z.array(KeyframeSchema).optional()
})

export const GraphicItemSchema = z.looseObject({
  ...anchoredCommon,
  type: z.literal('graphic'),
  file: z.string().min(1), // graphics/<name>.py
  params: z.record(z.string(), z.unknown()).default({}),
  transform: TransformSchema.optional(),
  keyframes: z.array(KeyframeSchema).optional()
})

export const EffectItemSchema = z.looseObject({
  ...anchoredCommon,
  type: z.literal('effect'),
  effect: z.enum(EFFECT_KINDS),
  file: z.string().optional(), // for custom effects
  params: z.record(z.string(), z.unknown()).default({})
})

export const AudioItemSchema = z.looseObject({
  ...anchoredCommon,
  type: z.literal('audio'),
  sourceId: z.string().optional(),
  file: z.string().optional(),
  in: nonNeg.default(0),
  volume: num.default(0), // dB
  fadeIn: nonNeg.default(0),
  fadeOut: nonNeg.default(0),
  /** Music: lower under speech by the project's mix setting. */
  duck: z.boolean().default(false),
  loop: z.boolean().default(false)
})

export const ItemSchema = z.discriminatedUnion('type', [
  SegmentItemSchema,
  ClipItemSchema,
  GraphicItemSchema,
  EffectItemSchema,
  AudioItemSchema
])
export type Item = z.infer<typeof ItemSchema>
export type SegmentItem = z.infer<typeof SegmentItemSchema>
export type ClipItem = z.infer<typeof ClipItemSchema>
export type GraphicItem = z.infer<typeof GraphicItemSchema>
export type EffectItem = z.infer<typeof EffectItemSchema>
export type AudioItem = z.infer<typeof AudioItemSchema>
export type AnchoredItem = ClipItem | GraphicItem | EffectItem | AudioItem

export const TrackSchema = z.looseObject({
  id: z.string().min(1),
  kind: z.enum(TRACK_KINDS),
  name: z.string(),
  muted: z.boolean().default(false),
  solo: z.boolean().default(false),
  volume: num.default(0), // dB
  hidden: z.boolean().default(false)
})
export type Track = z.infer<typeof TrackSchema>

export const SourceSchema = z.looseObject({
  id: z.string().min(1),
  path: z.string().min(1), // absolute path; footage and music stay where they are
  kind: z.enum(['video', 'audio', 'image']),
  duration: nonNeg.default(0),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  fps: num.optional(),
  hasAudio: z.boolean().default(false),
  origin: z.enum(['footage', 'music', 'other']).default('footage'),
  size: z.number().optional(),
  mtimeMs: z.number().optional()
})
export type Source = z.infer<typeof SourceSchema>

export const ChecklistEntrySchema = z.looseObject({
  id: z.string(),
  label: z.string(),
  status: z.enum(['not_started', 'in_progress', 'done']).default('not_started'),
  detail: z.string().optional(),
  updatedAt: z.string().optional()
})
export type ChecklistEntry = z.infer<typeof ChecklistEntrySchema>

export const RangeSchema = z.looseObject({ start: nonNeg, end: nonNeg })
export type Range = z.infer<typeof RangeSchema>

export const REQUEST_KINDS = [
  'start_edit',
  'chat',
  'reedit',
  'fix_audio',
  'continue_intro',
  'redo_intro',
  'publish_regen',
  'thumbnail_direction',
  'resume'
] as const
export type RequestKind = (typeof REQUEST_KINDS)[number]

export const RequestSchema = z.looseObject({
  id: z.string(),
  kind: z.enum(REQUEST_KINDS),
  status: z.enum(['queued', 'in_progress', 'done', 'failed', 'cancelled']).default('queued'),
  createdAt: z.string(),
  text: z.string().default(''),
  range: RangeSchema.optional(),
  /** Attached context: playhead, selected items, seam, audio snippets. */
  context: z.record(z.string(), z.unknown()).default({}),
  /** Why a queued request is waiting (Claude not connected, usage limit...). */
  waitingReason: z.string().optional(),
  summary: z.string().optional(),
  beforeVersionId: z.string().optional(),
  review: z.enum(['pending', 'kept', 'reverted']).optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional()
})
export type EditRequest = z.infer<typeof RequestSchema>

export const ChatMessageSchema = z.looseObject({
  id: z.string(),
  role: z.enum(['user', 'claude', 'system']),
  text: z.string(),
  ts: z.string(),
  requestId: z.string().optional(),
  range: RangeSchema.optional()
})
export type ChatMessage = z.infer<typeof ChatMessageSchema>

export const NoteSchema = z.looseObject({
  id: z.string(),
  text: z.string(),
  itemId: z.string().optional(),
  range: RangeSchema.optional(),
  status: z.enum(['open', 'done']).default('open'),
  createdAt: z.string(),
  doneAt: z.string().optional(),
  response: z.string().optional()
})
export type Note = z.infer<typeof NoteSchema>

export const HandoffNoteSchema = z.looseObject({
  id: z.string(),
  ts: z.string(),
  text: z.string(),
  stage: z.string().optional()
})

export const ExportPresetSchema = z.looseObject({
  name: z.string().default('4K 60 fps'),
  width: z.number().int().positive().default(3840),
  height: z.number().int().positive().default(2160),
  fps: num.positive().default(60),
  quality: z.enum(['draft', 'good', 'best']).default('best'),
  codec: z.enum(['h264', 'hevc']).default('h264')
})
export type ExportPreset = z.infer<typeof ExportPresetSchema>

export const MixSettingsSchema = z.looseObject({
  musicUnderSpeechDb: num.default(-15),
  targetLufs: num.default(-14),
  truePeakDb: num.default(-1),
  voiceCleanup: z.boolean().default(true),
  limiter: z.boolean().default(true)
})
export type MixSettings = z.infer<typeof MixSettingsSchema>

export const CaptionStyleSchema = z.looseObject({
  font: z.string().default(''), // path to a font file from the brand kit, '' = engine default
  size: num.positive().default(0.055), // fraction of frame height
  position: z.enum(['bottom', 'middle', 'top']).default('bottom'),
  color: z.string().default('#FFFFFF'),
  highlightColor: z.string().default('#FFD400'),
  outlineColor: z.string().default('#000000'),
  maxWords: z.number().int().positive().default(4)
})
export type CaptionStyle = z.infer<typeof CaptionStyleSchema>

export const BrandKitSchema = z.looseObject({
  fonts: z.array(z.looseObject({ name: z.string(), path: z.string() })).default([]),
  colors: z.looseObject({
    primary: z.string().default('#FF3B30'),
    secondary: z.string().default('#111111'),
    accent: z.string().default('#FFD400')
  }).default({ primary: '#FF3B30', secondary: '#111111', accent: '#FFD400' }),
  logo: z.looseObject({
    path: z.string().default(''),
    enabled: z.boolean().default(false),
    position: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).default('bottom-right'),
    size: num.positive().default(0.08),
    opacity: num.min(0).max(1).default(0.8)
  }).default({ path: '', enabled: false, position: 'bottom-right', size: 0.08, opacity: 0.8 }),
  intro: z.string().default(''), // clip path or library asset id
  outro: z.string().default(''),
  captionStyle: CaptionStyleSchema.default(CaptionStyleSchema.parse({})),
  soundSignature: z.string().default('') // library asset id
})
export type BrandKit = z.infer<typeof BrandKitSchema>

export const ThumbnailSchema = z.looseObject({
  id: z.string(),
  file: z.string().optional(),
  prompt: z.string(),
  personaId: z.string().optional(),
  styleId: z.string().optional(),
  model: z.string().optional(),
  format: z.enum(['16:9', '9:16', '1:1']).default('16:9'),
  requestId: z.string().optional(),
  createdAt: z.string(),
  source: z.enum(['claude', 'user']).default('claude'),
  status: z.enum(['pending', 'done', 'failed']).default('pending'),
  error: z.string().optional(),
  batchId: z.string().optional(),
  /** How it was made: from text, recreated from an image, edited, or face-swapped. */
  kind: z.enum(['text', 'recreate', 'edit', 'faceswap']).optional(),
  /** The thumbnail it was made from (edit, face swap, recreate from a thumbnail). */
  parentId: z.string().optional(),
  warning: z.string().optional(),
  /** USD charged by Pikzels for making it (successful calls only). */
  cost: z.number().optional(),
  score: z.looseObject({
    main: z.number(),
    subscores: z.record(z.string(), z.unknown()).default({}),
    suggestion: z.string().optional(),
    title: z.string().optional(),
    requestId: z.string().optional(),
    at: z.string()
  }).optional()
})
export type Thumbnail = z.infer<typeof ThumbnailSchema>

/** Pikzels spend: total USD and per price key (see shared/pikzelsPricing.ts). */
export const PikzelsSpendSchema = z.looseObject({
  total: z.number().default(0),
  byAction: z.record(z.string(), z.number()).default({})
})

export const ChapterSchema = z.looseObject({ id: z.string(), title: z.string(), anchor: AnchorSchema })
export type Chapter = z.infer<typeof ChapterSchema>

export const ProjectSettingsSchema = z.looseObject({
  exportPreset: ExportPresetSchema.default(ExportPresetSchema.parse({})),
  mix: MixSettingsSchema.default(MixSettingsSchema.parse({})),
  brandKit: BrandKitSchema.default(BrandKitSchema.parse({})),
  musicFolderIds: z.array(z.string()).default([]),
  descriptionTemplate: z.string().default(''),
  captionExport: z.enum(['burn', 'srt', 'both', 'none']).default('srt')
})
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>

export const ProjectSchema = z.looseObject({
  formatVersion: z.number().int(),
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  appVersion: z.string(),
  engineVersion: z.string(),
  profileId: z.string(),
  footageFolder: z.string(),
  status: z.enum(PROJECT_STATUSES).default('new'),
  inspiration: z.string().default(''),
  scope: z.looseObject({
    mode: z.enum(['whole', 'intro']).default('whole'),
    introMaxSeconds: num.positive().nullable().default(null),
    introEnd: AnchorSchema.nullable().default(null),
    introApproved: z.boolean().default(false)
  }),
  output: z.looseObject({ width: z.number().int(), height: z.number().int(), fps: num.positive() }),
  settings: ProjectSettingsSchema,
  sources: z.array(SourceSchema),
  transcript: z.looseObject({ file: z.string().default('transcript.json'), updatedAt: z.string().optional() }),
  tracks: z.array(TrackSchema),
  items: z.array(ItemSchema),
  checklist: z.array(ChecklistEntrySchema),
  handoffNotes: z.array(HandoffNoteSchema).default([]),
  requests: z.array(RequestSchema).default([]),
  chat: z.array(ChatMessageSchema).default([]),
  notes: z.array(NoteSchema).default([]),
  captions: z.looseObject({
    enabled: z.boolean().default(true),
    style: CaptionStyleSchema.optional() // overrides brand kit caption style for this project
  }),
  thumbnails: z.looseObject({
    personaId: z.string().default(''),
    styleId: z.string().default(''),
    count: z.number().int().min(1).max(3).default(3),
    direction: z.string().default(''),
    useMyDirection: z.boolean().default(false),
    format: z.enum(['16:9', '9:16', '1:1']).default('16:9'),
    items: z.array(ThumbnailSchema).default([]),
    chosenId: z.string().optional(),
    /** Pikzels spend on this project (successful calls only). Absent until the first paid call, so older projects open unchanged. */
    spend: PikzelsSpendSchema.optional()
  }),
  publish: z.looseObject({
    titles: z.array(z.string()).default([]),
    description: z.string().default(''),
    chapters: z.array(ChapterSchema).default([]),
    tags: z.array(z.string()).default([]),
    updatedAt: z.string().optional()
  }),
  /** While Claude re-edits a section, everything outside this range is locked. */
  lock: z.looseObject({ requestId: z.string(), range: RangeSchema }).nullable().default(null),
  selfCheck: z.looseObject({
    ranAt: z.string().optional(),
    flags: z.array(z.looseObject({ word: z.string(), time: num, note: z.string().optional() })).default([])
  }).default({ flags: [] }),
  claudeSessionId: z.string().optional()
})
export type Project = z.infer<typeof ProjectSchema>

export const WordSchema = z.looseObject({
  id: z.string().min(1),
  text: z.string(),
  start: nonNeg,
  end: nonNeg,
  prob: num.optional(),
  emphasis: z.boolean().optional(),
  edited: z.boolean().optional()
})
export type Word = z.infer<typeof WordSchema>

export const TranscriptSchema = z.looseObject({
  formatVersion: z.number().int().default(1),
  clips: z.record(z.string(), z.looseObject({ language: z.string().optional(), words: z.array(WordSchema) })),
  /** Words Claude transcribed from the assembled dialogue during the self-check, if kept. */
  updatedAt: z.string().optional()
})
export type Transcript = z.infer<typeof TranscriptSchema>

/** The in-memory document: project.json plus transcript.json. Undo history covers both. */
export interface ProjectDoc {
  project: Project
  transcript: Transcript
}

export function emptyTranscript(): Transcript {
  return { formatVersion: 1, clips: {} }
}

export function defaultTracks(): Track[] {
  return TRACK_KINDS.map((kind) => ({
    id: kind,
    kind,
    name: TRACK_LABELS[kind],
    muted: false,
    solo: false,
    volume: 0,
    hidden: false
  }))
}

export function defaultChecklist(): ChecklistEntry[] {
  return CHECKLIST_STAGES.map(([id, label]) => ({ id, label, status: 'not_started' as const }))
}

export function isAnchored(item: Item): item is AnchoredItem {
  return item.type !== 'segment'
}
