/**
 * The contract between the window (renderer) and the app (main process).
 * The preload script exposes `window.api` with exactly this shape.
 */
import type { VideoTheme, VideoThemeProgress } from './videoTheme'
import type { ExportCheckResult } from './exportCheck'
import type {
  ExportPreset,
  RequestKind,
  Item,
  ProjectDoc,
  Range,
  Track,
  TrackKind
} from './project'
import type { MusicFolder, Pikzonality, Profile, Settings } from './settings'

export type ChangeSource = 'claude' | 'user' | 'app'

export interface AppInfo {
  name: string
  version: string
  platform: string
  isPackaged: boolean
  userDataPath: string
  appLogPath: string
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up_to_date'
  | 'available' // found at launch (quiet check): shows a dot, nothing downloaded yet
  | 'downloading'
  | 'downloaded' // dialog: Restart now / Later
  | 'restart_pending' // Later was chosen: installs on quit, button reads "Restart to update"
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  newVersion?: string
  releaseNotes?: string
  percent?: number
  error?: string
  /** A small dot on the button after the quiet launch check found something. */
  dot: boolean
  /** Restart now is blocked while a render or export runs. */
  restartBlockedReason?: string
}

export interface SetupStatus {
  gpu: { ok: boolean; name?: string; driver?: string; message: string }
  python: { ok: boolean; installing: boolean; path?: string; message: string; details?: Record<string, string> }
  ffmpeg: { ok: boolean; path?: string; nvenc: boolean; message: string }
  libraryFolder: { ok: boolean; path?: string }
  claude: { ok: boolean; message: string }
}

export interface SetupProgress {
  step: string
  percent?: number
  message: string
  done?: boolean
  error?: string
}

export interface RecentProject {
  id: string
  name: string
  path: string // project folder
  profileId: string
  lastOpened: string
  status: string
  found: boolean
  thumbnail?: string // file path of a frame from the video
}

export interface ProjectSnapshot {
  path: string
  doc: ProjectDoc
  readOnly: boolean
  readOnlyReason?: string
  canUndo: boolean
  canRedo: boolean
  undoLabel?: string
  /** Who made the change Undo would take back ('user', 'claude' or 'app') and when (ISO time). */
  undoBy?: string
  undoAt?: string
  redoLabel?: string
  missingSources: string[]
  profile: Profile | null
}

export interface ProjectChangeEvent {
  snapshot: ProjectSnapshot
  source: ChangeSource
  label: string
  changedItemIds: string[]
}

export type UserOp =
  | { op: 'updateItem'; id: string; patch: Partial<Item> & Record<string, unknown> }
  | { op: 'moveItem'; id: string; start: number }
  | { op: 'trimItem'; id: string; edge: 'start' | 'end'; time: number }
  | { op: 'deleteItem'; id: string }
  /** Back to the clip's original settings: position, size, motion, speed, volume, fades, stabilization, and effects on it. */
  | { op: 'resetItem'; id: string }
  | { op: 'nudgeSegment'; id: string; edge: 'in' | 'out'; delta: number }
  | { op: 'updateTrack'; id: string; patch: Partial<Track> }
  | { op: 'addTrack'; kind: TrackKind; name?: string }
  | { op: 'editWord'; wordId: string; text: string }
  | { op: 'setEmphasis'; wordId: string; emphasis: boolean }
  | { op: 'setInspiration'; text: string }
  | { op: 'swapFile'; id: string; path: string }
  | { op: 'patchProject'; path: 'thumbnails' | 'publish' | 'captions' | 'settings' | 'scope'; patch: Record<string, unknown> }

export interface PreviewState {
  status: 'idle' | 'rendering' | 'ready' | 'error' | 'unavailable'
  file?: string // preview mp4 (file:// path)
  version: number // bumps every time the file is rebuilt
  chunksTotal: number
  chunksDone: number
  chunksPending: number
  message?: string
  /** Before/After for a request under review. */
  beforeFile?: string
  /** While the first preview renders, `file` plays the start of it: this many seconds are ready. */
  partialUntil?: number
}

/** Shorts being tracked, rendered or exported: a short line of progress (or a failure) per Short id. */
export interface ShortsState {
  working: Record<string, string>
}

export interface RunnerState {
  status: 'idle' | 'starting' | 'running' | 'stopping' | 'waiting' | 'error'
  connected: boolean // a Claude client (started by the app or by hand) is connected to the MCP server
  activeRequestId?: string
  lastActivity?: string // short live progress line
  queue: number
  waitingReason?: string
  pausedAt?: string // "Claude disconnected, edit paused at: Graphics"
  sessionId?: string
}

export interface RenderJobState {
  id: string
  kind: 'export' | 'section_export' | 'quick_export'
  status: 'running' | 'done' | 'error' | 'cancelled'
  percent: number
  fps?: number
  out?: string
  error?: string
  message?: string
}

export interface MusicTrack {
  path: string
  name: string
  folderId: string
  folder: string // subfolder relative to the master folder, e.g. "upbeat"
  duration: number
  format: string
  missing: boolean
}

export interface LibraryAsset {
  formatVersion: number
  id: string
  name: string
  type: 'graphic' | 'sound' | 'effect' | 'music' | 'clip'
  description: string
  whenToUse: string
  tags: string[]
  scope: 'shared' | string // 'shared' or a profile id
  file: string // main file name inside the asset folder
  preview?: string // preview image file name
  inputs: Record<string, { type: string; default?: unknown; description?: string }>
  preferred: boolean
  uses: number
  createdAt: string
  updatedAt: string
  dir?: string // absolute folder (filled in at read time)
}

export interface VersionInfo {
  id: string
  name: string
  createdAt: string
  auto: boolean
  reason?: string
}

export interface ThumbnailRequest {
  prompt: string
  count: number
  referenceTime?: number
  /** Pikzels model; default the one in Settings (pkz_4_5). Persona and style only work on pkz_4 and pkz_4_5. */
  model?: string
}

/** Recreate a thumbnail from an image: a file, a frame of the video, a thumbnail in the project, or a YouTube link. */
export interface RecreateRequest {
  from: { path?: string; time?: number; thumbnailId?: string; url?: string }
  prompt?: string
  model?: string
  /** How closely to follow the image (pkz_2 only). */
  imageWeight?: 'low' | 'medium' | 'high'
}

export interface EditThumbnailRequest {
  /** The image to edit: a thumbnail in the project or an image file. */
  thumbnailId?: string
  imagePath?: string
  prompt: string
  /** Painted mask (PNG, base64 without the data: prefix): white where the image may change. */
  maskBase64?: string
  supportImagePath?: string
}

export interface FaceSwapRequest {
  thumbnailId?: string
  imagePath?: string
  /** A photo of the face to put on the thumbnail. */
  facePath: string
}

export interface TitlesRequest {
  /** Your own prompt; when empty the start of the transcript is used. */
  prompt?: string
  /** A thumbnail to show Pikzels with the prompt. */
  thumbnailId?: string
}

export interface ThumbnailScore {
  main: number
  subscores: Record<string, unknown>
  suggestion?: string
  title?: string
  requestId?: string
  at: string
  [k: string]: unknown
}

/** Thumbnails listed from a YouTube channel, video or playlist link, saved locally for training. */
export interface YouTubeThumbnailList {
  source: string
  items: { videoId: string; title: string; file: string }[]
}

/** A cost estimate shown before a Claude task runs. */
export interface ClaudeEstimate {
  usd: number
  /** True when based on what this PC has measured; false for a first guess. */
  measured: boolean
  basis: string
}

/** Prices per action (USD), the published defaults, the owner's overrides and the all-time spend. */
export interface PikzelsPricing {
  prices: Record<string, number>
  defaults: Record<string, number>
  overrides: Record<string, number>
  updated: string
  spend: { total: number; byAction: Record<string, number> }
}

export interface Suggestion {
  profileId: string
  kind: string
  text: string
}

export interface Api {
  app: {
    info(): Promise<AppInfo>
    openPath(path: string): Promise<void>
    showItemInFolder(path: string): Promise<void>
    openExternal(url: string): Promise<void>
    pickFolder(title?: string, defaultPath?: string): Promise<string | null>
    pickFiles(opts: { title?: string; filters?: { name: string; extensions: string[] }[]; multi?: boolean }): Promise<string[]>
    saveFile(opts: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>
    fileUrl(path: string): string
    copyText(text: string): Promise<void>
    /** Save the diagnostics zip (logs, system info, settings, keys removed) to Downloads and show it. Returns its path. */
    saveDiagnostics(): Promise<string>
    onMenu(cb: (cmd: string) => void): () => void
  }
  updates: {
    state(): Promise<UpdateState>
    check(): Promise<void>
    restartNow(): Promise<void>
    later(): Promise<void>
    onState(cb: (s: UpdateState) => void): () => void
  }
  setup: {
    status(): Promise<SetupStatus>
    installEnvironment(): Promise<void>
    onProgress(cb: (p: SetupProgress) => void): () => void
  }
  settings: {
    get(): Promise<Settings>
    update(patch: Partial<Settings>): Promise<Settings>
    setPikzelsKey(key: string | null): Promise<void>
    hasPikzelsKey(): Promise<boolean>
    openAppLog(): Promise<void>
    claudeSetup(): Promise<{ command: string; json: string; url: string }>
  }
  profiles: {
    list(): Promise<Profile[]>
    save(profile: Profile): Promise<Profile>
    create(name: string): Promise<Profile>
    delete(id: string): Promise<void>
    suggestions(): Promise<Suggestion[]>
    answerSuggestion(profileId: string, kind: string, accept: boolean): Promise<void>
    onSuggestion(cb: (s: Suggestion) => void): () => void
  }
  music: {
    list(profileId?: string): Promise<MusicTrack[]>
    rescan(): Promise<MusicTrack[]>
    addFolder(path: string): Promise<MusicFolder[]>
    removeFolder(id: string): Promise<MusicFolder[]>
  }
  projects: {
    recent(): Promise<RecentProject[]>
    create(opts: { name: string; profileId: string; footageFolder: string; parentFolder?: string }): Promise<ProjectSnapshot>
    open(path: string): Promise<ProjectSnapshot>
    locate(id: string, newPath: string): Promise<RecentProject[]>
    removeRecent(id: string): Promise<RecentProject[]>
    close(): Promise<void>
  }
  project: {
    get(): Promise<ProjectSnapshot | null>
    onChange(cb: (e: ProjectChangeEvent) => void): () => void
    apply(op: UserOp): Promise<ProjectSnapshot>
    undo(): Promise<ProjectSnapshot>
    redo(): Promise<ProjectSnapshot>
    relinkSource(sourceId: string, newPath: string): Promise<ProjectSnapshot>
    startEdit(opts: { inspiration: string; scope: 'whole' | 'intro'; introMaxSeconds: number | null; videoThemeId?: string | null }): Promise<void>
    /** Choose (or clear) the video theme for this project; Claude follows it from the next request. */
    setVideoTheme(id: string | null): Promise<void>
    sendChat(opts: { text: string; range?: Range; playhead: number; selectedItemIds: string[] }): Promise<void>
    requestReedit(opts: { range: Range; direction: string }): Promise<void>
    requestFixAudio(opts: { segmentId?: string; itemId?: string; time: number }): Promise<void>
    /**
     * Add a photo or video at a spot ("Add clip here"): Claude places it and re-edits `seconds` on each side so it flows.
     * mode 'insert' cuts it into the video (the video gets longer); 'overlay' shows it over the video (the sound carries on).
     */
    requestInsertClip(opts: { file: string; time: number; seconds: number; mode: 'insert' | 'overlay'; note?: string }): Promise<void>
    /** Ask Claude to make Shorts (up to count highlights, plus a recap when the video is an unboxing or review), or remake one. */
    requestShorts(opts: { count: number; recap: boolean; note?: string; redoId?: string }): Promise<void>
    /** Ask Claude to stabilize one A-roll segment or B-roll clip. */
    requestStabilize(opts: { itemId: string; direction?: string }): Promise<void>
    addNote(opts: { text: string; itemId?: string; range?: Range }): Promise<void>
    noteToRule(noteId: string): Promise<void>
    reviewRequest(requestId: string, decision: 'keep' | 'revert'): Promise<void>
    introDecision(decision: 'continue' | 'redo' | 'stop', direction?: string): Promise<void>
    regeneratePublish(part: 'titles' | 'description' | 'chapters' | 'tags', direction: string): Promise<void>
    seamAudio(segmentId: string): Promise<string> // wav path of the audio around the seam before this segment
    waveform(key: { sourceId?: string; file?: string }): Promise<{ peaksPerSecond: number; peaks: number[] } | null>
    frameAt(time: number): Promise<string | null> // png path
    versions: {
      list(): Promise<VersionInfo[]>
      save(name: string): Promise<VersionInfo>
      restore(id: string): Promise<ProjectSnapshot>
      remove(id: string): Promise<void>
      compareFrames(aId: string, bId: string, time: number): Promise<{ a: string | null; b: string | null }>
    }
    exportVideo(opts: { range?: Range; preset: ExportPreset; quick: boolean; captions: 'burn' | 'srt' | 'both' | 'none' }): Promise<string>
    /** The check before export: timeline problems, then the picture and sound of the preview. */
    exportCheck(range?: Range): Promise<ExportCheckResult>
    onCheckProgress(cb: (message: string) => void): () => void
    cancelExport(): Promise<void>
    onRenderJob(cb: (j: RenderJobState) => void): () => void
    exportLog(filter: 'all' | 'last_session'): Promise<string>
    exportPack(): Promise<string>
    saveToLibrary(itemId: string, meta: { name: string; tags: string[]; description: string; whenToUse: string; scope: string }): Promise<LibraryAsset>
  }
  thumbnails: {
    generate(req: ThumbnailRequest): Promise<void>
    regenerate(thumbnailId: string): Promise<void>
    choose(thumbnailId: string): Promise<void>
    exportImage(thumbnailId: string): Promise<string | null>
    recreate(req: RecreateRequest): Promise<void>
    edit(req: EditThumbnailRequest): Promise<void>
    faceSwap(req: FaceSwapRequest): Promise<void>
    score(thumbnailId: string, title?: string): Promise<ThumbnailScore>
    titles(req: TitlesRequest): Promise<string[]>
  }
  preview: {
    state(): Promise<PreviewState>
    onState(cb: (s: PreviewState) => void): () => void
    showBefore(requestId: string | null): Promise<void>
  }
  claude: {
    state(): Promise<RunnerState>
    onState(cb: (s: RunnerState) => void): () => void
    onOutput(cb: (line: { ts: string; text: string; kind: 'text' | 'tool' | 'error' | 'info' }) => void): () => void
    stop(): Promise<void>
    resume(): Promise<void>
    /** What a task is likely to cost before it runs (API-equivalent USD). */
    estimate(kind: RequestKind, opts?: { scope?: 'whole' | 'intro' }): Promise<ClaudeEstimate>
  }
  library: {
    list(filter?: { scope?: string; type?: string; query?: string }): Promise<LibraryAsset[]>
    update(id: string, patch: Partial<LibraryAsset>): Promise<LibraryAsset>
    duplicate(id: string): Promise<LibraryAsset>
    remove(id: string): Promise<void>
    placeInProject(id: string, time: number): Promise<void>
    /** Use another folder for the library, moving the assets there when move is true. */
    changeFolder(dest: string, move: boolean): Promise<{ moved: number; skipped: number }>
  }
  /** Shorts made from the open project. */
  shorts: {
    state(): Promise<ShortsState>
    exportShort(id: string): Promise<string>
    exportAll(): Promise<string[]>
    remove(id: string): Promise<void>
    /** Render the preview again (for example after the footage was relinked). */
    refresh(id: string): Promise<void>
    onState(cb: (s: ShortsState) => void): () => void
  }
  /** Video themes (Settings > Video themes): the measured editing style of reference videos. */
  themes: {
    list(): Promise<VideoTheme[]>
    analyze(input: { link?: string; file?: string; name?: string }): Promise<VideoTheme>
    cancel(): Promise<void>
    update(id: string, patch: { name?: string; notes?: string }): Promise<VideoTheme>
    remove(id: string): Promise<void>
    /** Contact sheet images (absolute paths) with a caption each. */
    sheets(id: string): Promise<{ label: string; path: string }[]>
    onProgress(cb: (p: VideoThemeProgress) => void): () => void
  }
  pikzels: {
    list(): Promise<Pikzonality[]>
    create(kind: 'persona' | 'style', name: string, imagePaths: string[]): Promise<Pikzonality>
    refresh(): Promise<Pikzonality[]>
    updateInstructions(id: string, text: string): Promise<Pikzonality>
    rename(id: string, name: string): Promise<Pikzonality>
    /** List thumbnails from YouTube links (channel, video or playlist) to train a persona or style from. */
    thumbnailsFromLink(links: string): Promise<YouTubeThumbnailList>
    remove(id: string): Promise<void>
    pricing(): Promise<PikzelsPricing>
    /** Save price overrides (null = reset to the published prices). */
    setPrices(overrides: Record<string, number> | null): Promise<PikzelsPricing>
  }
}

declare global {
  interface Window {
    api: Api
  }
}
