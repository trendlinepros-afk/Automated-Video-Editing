import { z } from 'zod'
import { DEFAULT_MCP_PORT, SETTINGS_FORMAT_VERSION } from './appInfo'
import { BrandKitSchema, ExportPresetSchema, MixSettingsSchema, PikzelsSpendSchema } from './project'

export const MusicFolderSchema = z.looseObject({ id: z.string(), path: z.string(), name: z.string() })
export type MusicFolder = z.infer<typeof MusicFolderSchema>

export const PikzonalitySchema = z.looseObject({
  id: z.string(),
  kind: z.enum(['persona', 'style']),
  name: z.string().max(25),
  status: z.enum(['processing', 'completed', 'failed']).default('processing'),
  progress: z.number().default(0),
  sampleImage: z.string().optional(), // local path to one of the training images
  specialInstructions: z.string().default(''),
  createdAt: z.string(),
  error: z.string().optional()
})
export type Pikzonality = z.infer<typeof PikzonalitySchema>

export const DEFAULT_RUNNER_ARGS = [
  '-p',
  '{prompt}',
  '--output-format',
  'stream-json',
  '--verbose',
  '--mcp-config',
  '{mcpConfig}',
  '--append-system-prompt',
  '{systemPrompt}',
  '--permission-mode',
  'acceptEdits',
  '--allowedTools',
  '{allowedTools}'
]

export const SettingsSchema = z.looseObject({
  formatVersion: z.number().int().default(SETTINGS_FORMAT_VERSION),
  defaultProjectsFolder: z.string().default(''),
  defaultExportsFolder: z.string().default(''), // '' = the project's exports/ folder
  libraryFolder: z.string().default(''),
  musicFolders: z.array(MusicFolderSchema).default([]),
  runner: z.looseObject({
    /** The command that starts the AI. Claude Code by default; any CLI with MCP support can replace it. */
    command: z.string().default('claude'),
    args: z.array(z.string()).default(DEFAULT_RUNNER_ARGS),
    resumeArgs: z.array(z.string()).default(['--resume', '{sessionId}']),
    allowedTools: z.string().default('mcp__ave Bash Read Write Edit Glob Grep'),
    autoStart: z.boolean().default(true),
    /** Try again on its own when Claude's usage resets, credits are back or the connection returns. */
    autoRetry: z.boolean().default(true)
  }).default({
    command: 'claude',
    args: DEFAULT_RUNNER_ARGS,
    resumeArgs: ['--resume', '{sessionId}'],
    allowedTools: 'mcp__ave Bash Read Write Edit Glob Grep',
    autoStart: true,
    autoRetry: true
  }),
  mcpPort: z.number().int().default(DEFAULT_MCP_PORT),
  pikzels: z.looseObject({
    model: z.string().default('pkz_4_5'),
    pikzonalities: z.array(PikzonalitySchema).default([]),
    /** The owner's price overrides (USD per call), keyed as in shared/pikzelsPricing.ts. */
    prices: z.record(z.string(), z.number()).default({}),
    /** All-time Pikzels spend on this PC (successful calls only). */
    spend: PikzelsSpendSchema.default({ total: 0, byAction: {} })
  }).default({ model: 'pkz_4_5', pikzonalities: [], prices: {}, spend: { total: 0, byAction: {} } }),
  /** Claude model per part of the edit, and what runs have cost on this PC. */
  claude: z.looseObject({
    /** Section id -> model id ('' = Claude Code's default). Missing sections use the recommended model. */
    models: z.record(z.string(), z.string()).default({}),
    /** Measured averages used for estimates before a run: key -> { total USD, count }. */
    stats: z.record(z.string(), z.looseObject({ total: z.number().default(0), count: z.number().default(0) })).default({}),
    /** All-time Claude cost on this PC as reported by Claude Code (API-equivalent USD). */
    totalUsd: z.number().default(0)
  }).default({ models: {}, stats: {}, totalUsd: 0 }),
  setupDone: z.boolean().default(false),
  previewHeight: z.number().int().default(540),
  previewFps: z.number().default(30)
})
export type Settings = z.infer<typeof SettingsSchema>

export const RuleSchema = z.looseObject({
  id: z.string(),
  text: z.string(),
  enabled: z.boolean().default(true),
  source: z.enum(['user', 'learned', 'note']).default('user'),
  createdAt: z.string()
})
export type Rule = z.infer<typeof RuleSchema>

export const CORRECTION_KINDS = {
  music_quieter: 'Keep music quieter under speech on this channel?',
  music_louder: 'Keep music louder on this channel?',
  graphics_shorter: 'Keep graphics on screen for less time on this channel?',
  graphics_longer: 'Keep graphics on screen longer on this channel?',
  sfx_deleted: 'Use fewer sound effects on this channel?',
  sfx_quieter: 'Keep sound effects quieter on this channel?',
  broll_deleted: 'Use less B-roll on this channel?',
  broll_shorter: 'Keep B-roll cutaways shorter on this channel?',
  cuts_looser: 'Leave a little more room around cuts on this channel?',
  cuts_tighter: 'Cut tighter around words on this channel?',
  captions_off: 'Leave captions off on this channel?'
} as const
export type CorrectionKind = keyof typeof CORRECTION_KINDS

export const CorrectionStatSchema = z.looseObject({
  projects: z.array(z.string()).default([]),
  count: z.number().default(0),
  state: z.enum(['watching', 'suggested', 'accepted', 'dismissed']).default('watching')
})

export const ProfileSchema = z.looseObject({
  formatVersion: z.number().int().default(SETTINGS_FORMAT_VERSION),
  id: z.string(),
  name: z.string(),
  color: z.string().default('#4F8CFF'),
  thumbnail: z.looseObject({
    personaId: z.string().default(''),
    styleId: z.string().default(''),
    count: z.number().int().min(1).max(3).default(3),
    direction: z.string().default('')
  }).default({ personaId: '', styleId: '', count: 3, direction: '' }),
  musicFolderIds: z.array(z.string()).default([]),
  channelNotes: z.string().default(''),
  /** The standard editing rules handed to Claude each session. Editable per profile. */
  editingRules: z.string().default(''),
  /** Channel rules: written by you, saved from notes, or learned corrections you accepted. */
  rules: z.array(RuleSchema).default([]),
  brandKit: BrandKitSchema.default(BrandKitSchema.parse({})),
  exportPreset: ExportPresetSchema.default(ExportPresetSchema.parse({})),
  captionExport: z.enum(['burn', 'srt', 'both', 'none']).default('srt'),
  descriptionTemplate: z.string().default(''),
  mix: MixSettingsSchema.default(MixSettingsSchema.parse({})),
  corrections: z.record(z.string(), CorrectionStatSchema).default({})
})
export type Profile = z.infer<typeof ProfileSchema>

export function newProfile(id: string, name: string, color = '#4F8CFF'): Profile {
  return ProfileSchema.parse({ id, name, color })
}
