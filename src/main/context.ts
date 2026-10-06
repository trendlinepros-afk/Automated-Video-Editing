/**
 * The services that make up the main process, and how they reach each other.
 * index.ts builds one AppContext; every service receives it and calls others through it.
 *
 * Module ownership:
 *   services/settings.ts   -> SettingsService, ProfileService, SecretsService, RecentService
 *   project/manager.ts     -> ProjectManager
 *   project/requests.ts    -> RequestService
 *   project/versions.ts    -> VersionService
 *   project/userOps.ts     -> applyUserOp()
 *   services/corrections.ts-> CorrectionsService
 *   engine/environment.ts  -> EnvironmentService (GPU check, managed Python, ffmpeg)
 *   engine/engine.ts       -> EngineService (runs the Python engine)
 *   engine/preview.ts      -> PreviewService (chunked preview)
 *   engine/renders.ts      -> RenderJobs (exports)
 *   services/music.ts      -> MusicService
 *   mcp/server.ts          -> McpService, mcp/tools/*.ts
 *   runner/runner.ts       -> RunnerService
 *   services/library.ts    -> LibraryService
 *   services/pikzels.ts    -> PikzelsService
 *   updater.ts             -> UpdaterService
 */
import type {
  ExportPreset,
  ProjectDoc,
  Range,
  RequestKind,
  EditRequest,
  Thumbnail
} from '@shared/project'
import type {
  EditThumbnailRequest,
  FaceSwapRequest,
  PikzelsPricing,
  RecreateRequest,
  ThumbnailScore,
  TitlesRequest,
  LibraryAsset,
  MusicTrack,
  PreviewState,
  RecentProject,
  RenderJobState,
  RunnerState,
  SetupProgress,
  SetupStatus,
  Suggestion,
  UpdateState,
  VersionInfo
} from '@shared/ipc'
import type { MusicFolder, Pikzonality, Profile, Settings, CorrectionKind } from '@shared/settings'
import type { RenderPlan } from '@shared/plan'
import type { ActivityLog } from './log'
import type { ProjectStore } from './project/store'

export interface SettingsService {
  get(): Settings
  update(patch: Partial<Settings>): Settings
  onChange(cb: (s: Settings) => void): () => void
}

export interface ProfileService {
  list(): Profile[]
  get(id: string): Profile | null
  save(profile: Profile): Profile
  create(name: string): Profile
  delete(id: string): void
}

export interface SecretsService {
  /** Encrypted with Windows credential protection (Electron safeStorage). Never logged. */
  get(name: 'pikzels' | 'mcpToken' | 'githubToken'): string | null
  set(name: 'pikzels' | 'mcpToken' | 'githubToken', value: string | null): void
}

export interface RecentService {
  list(): RecentProject[]
  touch(entry: Omit<RecentProject, 'found' | 'lastOpened'> & { lastOpened?: string }): void
  remove(id: string): void
  locate(id: string, newPath: string): void
}

export interface ProjectManager {
  current(): ProjectStore | null
  open(dir: string): Promise<ProjectStore>
  create(opts: { name: string; profileId: string; footageFolder: string; parentFolder?: string }): Promise<ProjectStore>
  close(): Promise<void>
  /** Called whenever a project is opened or closed. */
  onOpened(cb: (store: ProjectStore | null) => void): () => void
  /** Sources whose files cannot be found. */
  missingSources(): string[]
}

export interface RequestInput {
  kind: RequestKind
  text?: string
  range?: Range
  context?: Record<string, unknown>
}

export interface RequestService {
  /** Adds a request to the queue, saves a Before version when it changes the video, and wakes the runner. */
  enqueue(input: RequestInput): EditRequest
  /** Open requests and notes, oldest first. */
  open(): EditRequest[]
  /** Marks a request in progress; applies the section lock for range-scoped requests. */
  begin(requestId: string): EditRequest
  /** Marks done, releases the lock, sets the request under review when it has a Before version. */
  finish(requestId: string, summary: string, status?: 'done' | 'failed'): EditRequest
  /** Puts in-progress requests back in the queue with a reason (Claude stopped). */
  requeueInProgress(reason: string): void
  setWaitingReason(reason: string | undefined): void
  review(requestId: string, decision: 'keep' | 'revert'): void
}

export interface VersionService {
  list(): VersionInfo[]
  save(name: string, opts?: { auto?: boolean; reason?: string }): VersionInfo
  restore(id: string): void
  remove(id: string): void
  load(id: string): ProjectDoc
}

export interface CorrectionsService {
  /** Record a manual tweak of a kind. Suggests a rule after it happens on a few videos. */
  record(kind: CorrectionKind, projectId: string, profileId: string): void
  suggestions(): Suggestion[]
  answer(profileId: string, kind: string, accept: boolean): void
}

export interface EnvironmentService {
  status(): Promise<SetupStatus>
  install(onProgress: (p: SetupProgress) => void): Promise<void>
  /** Python interpreter of the managed environment (or a dev override). */
  python(): string
  ffmpeg(): string
  ffprobe(): string
  /** Folder holding the engine for a given version, installed from app resources if missing. */
  engineDir(version: string): string
  hasGpu(): Promise<boolean>
}

export interface EngineRunOptions {
  onEvent?: (e: { event: string; [k: string]: unknown }) => void
  signal?: AbortSignal
}

export interface EngineService {
  /** Runs `python -m ave_engine <cmd> ...` with the engine version a project was made with. */
  run(engineVersion: string, args: string[], opts?: EngineRunOptions): Promise<unknown>
  writePlan(plan: RenderPlan, dir: string, name?: string): string
  frame(doc: ProjectDoc, projectDir: string, time: number, opts?: { width?: number; footageOnly?: boolean; out?: string }): Promise<string>
  frames(doc: ProjectDoc, projectDir: string, times: number[], opts?: { width?: number; outDir?: string }): Promise<string[]>
  graphicPreview(projectDir: string, file: string, opts: { params: Record<string, unknown>; duration: number; times: number[]; width: number; height: number; brand: unknown; outDir: string }): Promise<string[]>
  energy(path: string, start: number, end: number, stepMs: number): Promise<{ stepMs: number; start: number; db: number[] }>
  snippet(path: string, start: number, end: number, out: string): Promise<string>
  peaks(path: string, perSecond: number): Promise<number[]>
  loudness(path: string): Promise<{ lufs: number; truePeakDb: number }>
  probe(path: string): Promise<{ kind: 'video' | 'audio' | 'image'; duration: number; width?: number; height?: number; fps?: number; hasAudio: boolean }>
}

export interface PreviewService {
  state(): PreviewState
  onState(cb: (s: PreviewState) => void): () => void
  /** Schedule a rebuild; only chunks a change touches are rendered again. */
  invalidate(): void
  showBefore(requestId: string | null): Promise<void>
  isBusy(): boolean
}

export interface ExportOptions {
  range?: Range
  preset: ExportPreset
  quick: boolean
  captions: 'burn' | 'srt' | 'both' | 'none'
  outDir?: string
}

export interface RenderJobs {
  start(opts: ExportOptions): Promise<string> // returns the job id; resolves when started
  cancel(): void
  isBusy(): boolean
  onJob(cb: (j: RenderJobState) => void): () => void
  /** Last finished export file, if any. */
  lastOutput(): string | null
}

export interface MusicService {
  folders(): MusicFolder[]
  addFolder(path: string): Promise<MusicFolder[]>
  removeFolder(id: string): MusicFolder[]
  list(profileId?: string): MusicTrack[]
  search(query: string, profileId?: string): MusicTrack[]
  rescan(): Promise<MusicTrack[]>
}

export interface McpService {
  start(): Promise<void>
  stop(): Promise<void>
  /** URL for a given project (the app's runner) or for whichever project is open (by hand). */
  url(projectId?: string): string
  token(): string
  connectedClients(): number
  onClientsChanged(cb: (n: number) => void): () => void
}

export interface RunnerService {
  state(): RunnerState
  onState(cb: (s: RunnerState) => void): () => void
  onOutput(cb: (line: { ts: string; text: string; kind: 'text' | 'tool' | 'error' | 'info' }) => void): () => void
  /** Start Claude for the queue if it is not already running. */
  kick(): void
  stop(): Promise<void>
  resume(): void
  isRunning(): boolean
}

export interface LibraryService {
  root(): string | null
  list(filter?: { scope?: string; type?: string; query?: string }): LibraryAsset[]
  search(query: string, opts?: { profileId?: string; type?: string }): LibraryAsset[]
  get(id: string): LibraryAsset | null
  saveFromFile(opts: {
    file: string
    type: LibraryAsset['type']
    name: string
    description: string
    whenToUse: string
    tags: string[]
    scope: string
    inputs?: LibraryAsset['inputs']
    previewImage?: string
  }): Promise<LibraryAsset>
  update(id: string, patch: Partial<LibraryAsset>): LibraryAsset
  duplicate(id: string): LibraryAsset
  remove(id: string): void
  /** Copies an asset into the project folder and returns the project-relative path of its main file. */
  copyIntoProject(id: string, projectDir: string): string
}

export interface PikzelsService {
  hasKey(): boolean
  generate(opts: { prompts: string[]; source: 'claude' | 'user'; referenceTime?: number; model?: string }): Promise<void>
  regenerate(thumbnailId: string): Promise<void>
  /** Each image action adds a thumbnail record (kept in history, failed or not) and returns it. */
  recreate(opts: RecreateRequest & { source: 'claude' | 'user' }): Promise<Thumbnail>
  edit(opts: EditThumbnailRequest & { source: 'claude' | 'user' }): Promise<Thumbnail>
  /** User only: Claude never swaps faces. */
  faceSwap(opts: FaceSwapRequest): Promise<Thumbnail>
  /** Scores a thumbnail of the project and stores the result on its record. */
  score(thumbnailId: string, title?: string): Promise<ThumbnailScore>
  /** Title options; they are added to the Publish tab. */
  titles(opts: TitlesRequest & { source: 'claude' | 'user' }): Promise<string[]>
  list(): Pikzonality[]
  /** User only (training costs credits): Claude never creates personas or styles. */
  create(kind: 'persona' | 'style', name: string, imagePaths: string[]): Promise<Pikzonality>
  refresh(): Promise<Pikzonality[]>
  updateInstructions(id: string, text: string): Promise<Pikzonality>
  rename(id: string, name: string): Promise<Pikzonality>
  remove(id: string): Promise<void>
  pricing(): PikzelsPricing
  setPrices(overrides: Record<string, number> | null): PikzelsPricing
}

export interface UpdaterService {
  state(): UpdateState
  onState(cb: (s: UpdateState) => void): () => void
  check(opts?: { quiet?: boolean }): Promise<void>
  restartNow(): Promise<void>
  later(): void
}

export interface AppContext {
  appVersion: string
  isPackaged: boolean
  appLog: ActivityLog
  settings: SettingsService
  profiles: ProfileService
  secrets: SecretsService
  recent: RecentService
  projects: ProjectManager
  requests: RequestService
  versions: VersionService
  corrections: CorrectionsService
  env: EnvironmentService
  engine: EngineService
  preview: PreviewService
  renders: RenderJobs
  music: MusicService
  mcp: McpService
  runner: RunnerService
  library: LibraryService
  pikzels: PikzelsService
  updater: UpdaterService
  /** Send an event to the window (no-op when no window is open). */
  send(channel: string, payload: unknown): void
}
