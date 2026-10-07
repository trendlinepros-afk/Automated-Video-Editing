/**
 * DEVELOPMENT ONLY: a fake window.api with sample data, so the window can be reviewed in a plain browser
 * (`npx vite --config src/renderer/vite.dev.config.ts`). main.tsx loads it only when import.meta.env.DEV is true
 * and no preload script provided window.api, so it never ships in the packaged app.
 *
 * URL hash options: #editor opens the sample project straight away, #setup shows first-launch setup.
 */
import type { VideoTheme, VideoThemeProgress } from '@shared/videoTheme'
import type {
  Api,
  LibraryAsset,
  MusicTrack,
  PreviewState,
  ProjectChangeEvent,
  ProjectSnapshot,
  RecentProject,
  RenderJobState,
  RunnerState,
  Suggestion,
  UpdateState,
  UserOp,
  VersionInfo
} from '@shared/ipc'
import {
  ProjectSchema,
  defaultChecklist,
  defaultTracks,
  type Item,
  type Project,
  type ProjectDoc,
  type Transcript,
  type Word
} from '@shared/project'
import { PIKZELS_PRICES_UPDATED, defaultPrices, effectivePrices } from '@shared/pikzelsPricing'
import { ProfileSchema, SettingsSchema, type Pikzonality, type Profile, type Settings } from '@shared/settings'
import { TimelineResolver } from '@shared/timeline'

type Listener<T> = (v: T) => void

function emitter<T>() {
  const ls = new Set<Listener<T>>()
  return {
    on(cb: Listener<T>) {
      ls.add(cb)
      return () => void ls.delete(cb)
    },
    emit(v: T) {
      for (const l of ls) l(v)
    }
  }
}

let seed = 7
function rand(): number {
  seed = (seed * 16807) % 2147483647
  return (seed - 1) / 2147483646
}
const pick = <T,>(a: T[]): T => a[Math.floor(rand() * a.length)]
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const now = () => new Date().toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function placeholder(label: string, hue = 220): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,30%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},45%,14%)"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><text x="160" y="98" font-family="Segoe UI, sans-serif" font-size="18" font-weight="700" fill="white" text-anchor="middle">${label.replace(/[<&>]/g, '')}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

const LOREM =
  'so today we are testing this brand new lipo battery and honestly I did not expect it to get this hot this fast look at the reading here it is already at sixty degrees and we have only been running for two minutes which is crazy the car itself feels great though the steering is sharp and the motor pulls hard out of every corner let me show you what happens when we push it all the way on the long straight'.split(
    ' '
  )

function buildDoc(): ProjectDoc {
  const sources = [0, 1, 2].map((i) => ({
    id: `src${i + 1}`,
    path: `C:\\Users\\Adam\\Videos\\RC\\LiPo test\\C000${i + 1}.MP4`,
    kind: 'video' as const,
    duration: 300,
    width: 1920,
    height: 1080,
    fps: 60,
    hasAudio: true,
    origin: 'footage' as const
  }))
  const transcript: Transcript = { formatVersion: 1, clips: {} }
  for (const s of sources) {
    const words: Word[] = []
    let t = 0.4
    let n = 0
    while (t < s.duration - 1) {
      const len = 0.18 + rand() * 0.3
      words.push({ id: `${s.id}_w${n}`, text: LOREM[n % LOREM.length], start: +t.toFixed(3), end: +(t + len).toFixed(3), emphasis: rand() < 0.02 || undefined })
      n++
      t += len + (rand() < 0.08 ? 0.6 + rand() : 0.05 + rand() * 0.08)
    }
    transcript.clips[s.id] = { words }
  }
  const items: Item[] = []
  // A-roll: ~300 kept pieces making ~12 minutes.
  let segN = 0
  for (const s of sources) {
    let t = 1
    while (t < s.duration - 4) {
      const len = 1.4 + rand() * 1.6
      items.push({ id: `seg${segN++}`, trackId: 'aroll', type: 'segment', sourceId: s.id, in: +t.toFixed(3), out: +(t + len).toFixed(3), speed: 1, volume: 0, fadeIn: 0, fadeOut: 0, createdBy: 'claude' })
      t += len + 0.2 + rand() * 0.6
    }
  }
  const allWords = Object.values(transcript.clips).flatMap((c) => c.words)
  const anchor = () => ({ kind: 'word' as const, wordId: pick(allWords).id, offset: +(rand() * 0.4).toFixed(2) })
  for (let i = 0; i < 150; i++)
    items.push({ id: `broll${i}`, trackId: 'broll', type: 'clip', anchor: anchor(), duration: 1.5 + rand() * 3, file: `media\\broll_${i}.mp4`, in: 0, speed: 1, volume: -120, fadeIn: 0, fadeOut: 0, createdBy: 'claude', label: pick(['Close-up of battery', 'Thermometer', 'Car on track', 'Charger screen', 'Wide shot']) })
  for (let i = 0; i < 80; i++)
    items.push({ id: `gfx${i}`, trackId: 'graphics', type: 'graphic', anchor: anchor(), duration: 2 + rand() * 3, file: `graphics/${pick(['lower_third', 'price_tag', 'temp_meter', 'subscribe'])}_${i}.py`, params: { text: pick(['60°C', '$39.99', 'LiPo 4S', 'Subscribe']), color: '#FF3B30', size: 1.0, animate: true }, transform: { x: 0.2, y: 0.3, scale: 1, rotation: 0, opacity: 1 }, createdBy: 'claude' })
  for (let i = 0; i < 50; i++)
    items.push({ id: `fx${i}`, trackId: 'effects', type: 'effect', anchor: anchor(), duration: 0.5 + rand() * 2, effect: pick(['flash', 'shake', 'vhs', 'light_leak', 'zoom', 'freeze'] as const), params: { strength: +(rand()).toFixed(2) }, createdBy: 'claude' })
  for (let i = 0; i < 300; i++)
    items.push({ id: `sfx${i}`, trackId: 'sfx', type: 'audio', anchor: anchor(), duration: 0.3 + rand() * 1.2, file: `audio/${pick(['whoosh', 'pop', 'click', 'sting', 'riser'])}.wav`, in: 0, volume: -6, fadeIn: 0, fadeOut: 0, duck: false, loop: false, createdBy: 'claude' })
  for (let i = 0; i < 4; i++)
    items.push({ id: `music${i}`, trackId: 'music', type: 'audio', anchor: { kind: 'time', time: i * 180 }, duration: 175, file: `audio/score_${i}.wav`, in: 0, volume: -3, fadeIn: 1, fadeOut: 2, duck: true, loop: false, createdBy: 'claude', label: pick(['Main theme (upbeat)', 'Main theme (tense)', 'Main theme (chill)']) })

  const project: Project = ProjectSchema.parse({
    formatVersion: 2,
    id: 'p_lipo',
    name: 'LiPo battery torture test',
    createdAt: now(),
    updatedAt: now(),
    appVersion: '0.9.0',
    engineVersion: '1.0.0',
    profileId: 'rc',
    footageFolder: 'C:\\Users\\Adam\\Videos\\RC\\LiPo test',
    status: 'ready_for_review',
    inspiration: 'Fast and funny. Lean into the battery getting scary hot. Take after the Oct 5 video.',
    scope: { mode: 'whole', introMaxSeconds: null, introEnd: null, introApproved: false },
    output: { width: 3840, height: 2160, fps: 60 },
    settings: {},
    sources,
    transcript: { file: 'transcript.json' },
    tracks: defaultTracks(),
    items,
    claudeCosts: {
      totalUsd: 4.6731,
      runs: [
        { ts: '2026-10-06T10:00:00Z', kinds: ['start_edit'], stages: ['transcript'], section: 'transcript', model: 'claude-haiku-4-5', costUsd: 0.0931, byModel: { 'claude-haiku-4-5': { costUsd: 0.0931 } } },
        { ts: '2026-10-06T10:20:00Z', kinds: ['start_edit'], stages: ['cuts', 'broll'], section: 'cuts', model: 'claude-opus-5-5', costUsd: 2.412, byModel: { 'claude-opus-5-5': { costUsd: 2.412 } } },
        { ts: '2026-10-06T10:50:00Z', kinds: ['start_edit'], stages: ['graphics', 'audio', 'captions'], section: 'graphics', model: 'claude-sonnet-5-5', costUsd: 1.218, byModel: { 'claude-sonnet-5-5': { costUsd: 1.218 } } },
        { ts: '2026-10-06T11:30:00Z', kinds: ['chat'], stages: [], section: 'chat', model: 'claude-opus-5-5', costUsd: 0.95, durationMs: 62000, byModel: { 'claude-opus-5-5': { costUsd: 0.95 } } }
      ]
    },
    checklist: defaultChecklist().map((c, i) => ({ ...c, status: i < 6 ? 'done' : i === 6 ? 'in_progress' : 'not_started', detail: i === 6 ? '3 boundaries left to check' : undefined })),
    handoffNotes: [
      { id: 'h1', ts: now(), stage: 'Graphics', text: 'Placed 80 graphics in the brand kit style. Price tag reused from the library.' },
      { id: 'h2', ts: now(), stage: 'Self-check', text: 'Re-transcribed the assembled dialogue; 3 boundaries flagged, fixing next.' }
    ],
    requests: [
      { id: 'r1', kind: 'chat', status: 'done', createdAt: now(), text: 'At 2:10 to 2:45 add a fire animation where I point', range: { start: 130, end: 165 }, summary: 'Added a flame graphic that follows your hand at 2:12–2:40.', review: 'pending', beforeVersionId: 'v1' },
      { id: 'r2', kind: 'reedit', status: 'queued', createdAt: now(), text: 'tighter', range: { start: 300, end: 330 }, waitingReason: 'Claude is busy with another request' }
    ],
    shorts: [
      { id: 'short_1', kind: 'recap', title: 'The $25 drift car in 30 seconds', reason: 'Unboxing to first drift with nothing in between.', segments: [{ sourceId: sources[0].id, in: 12, out: 20 }, { sourceId: sources[1].id, in: 40, out: 62 }], youtubeTitle: 'This $25 drift car should NOT be this good', tiktokCaption: 'Unboxing a $25 drift car… then this happened 😳', description: 'Full review on the channel.', hashtags: ['rccar', 'drift', 'unboxing'], captions: true, createdAt: now() },
      { id: 'short_2', kind: 'highlight', title: 'First drift on the garage track', reason: 'Strong hook: the car spins out in the first second.', segments: [{ sourceId: sources[1].id, in: 100, out: 124 }], youtubeTitle: 'It drifted on the FIRST try', tiktokCaption: 'First try 🔥', description: '', hashtags: ['rc', 'drift'], captions: true, createdAt: now() },
      { id: 'short_3', kind: 'highlight', title: 'The gyro test', reason: 'A clear before/after the viewer gets instantly.', segments: [{ sourceId: sources[2].id, in: 30, out: 41 }, { sourceId: sources[2].id, in: 48, out: 60 }], youtubeTitle: 'Does the gyro actually help?', tiktokCaption: 'Gyro on vs off', description: '', hashtags: ['rc', 'gyro'], captions: true, createdAt: now() }
    ],
    chat: [
      { id: 'c1', role: 'user', text: 'At 2:10 to 2:45, add an animation of a LiPo battery on fire where I am pointing.', ts: now(), requestId: 'r1', range: { start: 130, end: 165 } },
      { id: 'c2', role: 'claude', text: 'Added a flame graphic anchored to "battery", positioned at 5 points along your hand movement. Kept everything else in the range unchanged.', ts: now(), requestId: 'r1' }
    ],
    notes: [
      { id: 'n1', text: 'Make this one funnier', itemId: 'gfx3', status: 'open', createdAt: now() },
      { id: 'n2', text: 'Music too loud here', range: { start: 60, end: 75 }, status: 'done', createdAt: now(), response: 'Lowered the music by 4 dB under this section.' }
    ],
    captions: { enabled: true },
    thumbnails: {
      personaId: 'pz1',
      styleId: 'pz2',
      count: 3,
      direction: '',
      useMyDirection: false,
      items: [0, 1, 2].map((i) => ({ id: `t${i}`, file: placeholder(`Option ${i + 1}`, 10 + i * 40), prompt: `Adam holding a smoking LiPo battery, shocked face, bold text "IT GOT HOT" (${i + 1})`, createdAt: now(), source: 'claude', status: i === 2 ? 'failed' : 'done', error: i === 2 ? 'Out of Pikzels credits' : undefined, batchId: 'b1', requestId: `req_${i}abcdef` })),
      chosenId: 't0'
    },
    publish: {
      titles: ['I Pushed This LiPo Until It Almost Exploded', 'This $40 Battery Got Scary Hot', 'Never Charge a LiPo Like This'],
      description: 'Testing a brand new 4S LiPo to its limit.\n\nGear I use: https://example.com/gear',
      chapters: [
        { id: 'ch1', title: 'The battery', anchor: { kind: 'word', wordId: 'src1_w40', offset: 0 } },
        { id: 'ch2', title: 'First run', anchor: { kind: 'word', wordId: 'src2_w20', offset: 0 } },
        { id: 'ch3', title: 'Too hot', anchor: { kind: 'word', wordId: 'src3_w30', offset: 0 } }
      ],
      tags: ['rc car', 'lipo', 'battery test', 'traxxas']
    },
    selfCheck: { ranAt: now(), flags: [{ word: 'battery', time: 42.2 }, { word: 'corner', time: 210.5 }] }
  })
  return { project, transcript }
}

export function installMockApi(): void {
  const hash = location.hash
  const rcProfile = ProfileSchema.parse({ id: 'rc', name: 'RC cars', color: '#FF6B3D', rules: [{ id: 'ru1', text: 'Keep graphics on screen for at most 3 seconds.', enabled: true, source: 'learned', createdAt: now() }] })
  let profiles: Profile[] = [rcProfile, ProfileSchema.parse({ id: 'fin', name: 'Finance', color: '#4CC38A' })]
  let settings: Settings = SettingsSchema.parse({
    setupDone: !hash.includes('setup'),
    libraryFolder: 'D:\\Library',
    musicFolders: [{ id: 'mf1', path: 'D:\\Music', name: 'Music' }]
  })
  let priceOverrides: Record<string, number> = {}
  const mockPricing = () => ({
    prices: effectivePrices(priceOverrides),
    defaults: defaultPrices(),
    overrides: priceOverrides,
    updated: PIKZELS_PRICES_UPDATED,
    spend: { total: 4.21, byAction: { 'thumbnail:pkz_4_5': 3.38, score: 0.45, persona_training: 0.38 } }
  })
  let pikzels: Pikzonality[] = [
    { id: 'pz1', kind: 'persona', name: 'Adam', status: 'completed', progress: 100, specialInstructions: '', createdAt: now(), sampleImage: placeholder('Adam', 30) },
    { id: 'pz2', kind: 'style', name: 'Bold RC', status: 'completed', progress: 100, specialInstructions: 'Always red text', createdAt: now() },
    { id: 'pz3', kind: 'style', name: 'Finance clean', status: 'processing', progress: 40, specialInstructions: '', createdAt: now() }
  ]
  let library: LibraryAsset[] = ['Like and subscribe', 'Lower third', 'Whoosh', 'Price tag'].map((name, i) => ({
    formatVersion: 1,
    id: `a${i}`,
    name,
    type: i === 2 ? 'sound' : 'graphic',
    description: `${name} in the brand style.`,
    whenToUse: i === 0 ? 'At the end of every video' : '',
    tags: ['brand', name.toLowerCase()],
    scope: i === 3 ? 'rc' : 'shared',
    file: i === 2 ? 'whoosh.wav' : 'graphic.py',
    inputs: { text: { type: 'string' } },
    preferred: i === 0,
    uses: i * 3,
    createdAt: now(),
    updatedAt: now()
  }))
  let recent: RecentProject[] = [
    { id: 'p_lipo', name: 'LiPo battery torture test', path: 'C:\\Projects\\LiPo', profileId: 'rc', lastOpened: now(), status: 'ready_for_review', found: true, thumbnail: 'frame1.png' },
    { id: 'p2', name: 'Budget crawler review', path: 'C:\\Projects\\Crawler', profileId: 'rc', lastOpened: new Date(Date.now() - 86400e3).toISOString(), status: 'exported', found: true, thumbnail: 'frame2.png' },
    { id: 'p3', name: 'Index funds explained', path: 'C:\\Projects\\Index', profileId: 'fin', lastOpened: new Date(Date.now() - 3 * 86400e3).toISOString(), status: 'editing', found: true },
    { id: 'p4', name: 'Old drift video', path: 'E:\\Moved\\Drift', profileId: 'rc', lastOpened: new Date(Date.now() - 20 * 86400e3).toISOString(), status: 'exported', found: false }
  ]
  const versions: VersionInfo[] = [
    { id: 'v1', name: 'Before chat change', createdAt: now(), auto: true, reason: 'Before a chat change' },
    { id: 'v2', name: 'Edit ready', createdAt: now(), auto: true, reason: 'Claude marked the edit ready' },
    { id: 'v3', name: 'before music change', createdAt: now(), auto: false }
  ]

  let doc = buildDoc()
  let open = hash.includes('editor')
  const undoStack: ProjectDoc[] = []
  const redoStack: ProjectDoc[] = []
  let update: UpdateState = { status: 'idle', currentVersion: '0.9.0', dot: true }
  let runner: RunnerState = { status: 'running', connected: true, queue: 1, lastActivity: 'Checking the cut at 3:41 in 5 ms steps' }
  let preview: PreviewState = { status: 'unavailable', version: 1, chunksTotal: 0, chunksDone: 0, chunksPending: 0, message: 'Browser review mode: no render engine' }

  const ev = {
    update: emitter<UpdateState>(),
    change: emitter<ProjectChangeEvent>(),
    runner: emitter<RunnerState>(),
    output: emitter<{ ts: string; text: string; kind: 'text' | 'tool' | 'error' | 'info' }>(),
    preview: emitter<PreviewState>(),
    job: emitter<RenderJobState>(),
    suggestion: emitter<Suggestion>(),
    setup: emitter<{ step: string; percent?: number; message: string; done?: boolean; error?: string }>(),
    themes: emitter<VideoThemeProgress>(),
    check: emitter<string>()
  }

  const undoLabels: string[] = []
  const sampleStats = {
    duration: 812, analyzedSeconds: 720, cuts: 301, cutsPerMinute: 25.1, cutsPerMinuteFirst30s: 42, cutsPerMinuteFirst60s: 36,
    shotSeconds: { median: 1.9, mean: 2.4, p10: 0.8, p90: 4.6 }, pace: [], cutTimes: [],
    speech: { wordsPerMinute: 192, speechShare: 0.86, longPausesPerMinute: 0.4, firstWords: 'This $25 drift car should not be this good…' },
    loudnessLufs: -14.2, sheets: []
  }
  const themes: VideoTheme[] = [
    {
      formatVersion: 1, id: 'vt_demo', name: 'Fast RC review style', createdAt: now(),
      source: { kind: 'channel', input: 'https://www.youtube.com/@SomeRcChannel', title: 'Some RC Channel' },
      videos: [{ title: 'Racing at the beach', channel: 'Some RC Channel', url: 'https://www.youtube.com/watch?v=abc', stats: sampleStats }],
      averages: { cutsPerMinute: 25.1, cutsPerMinuteFirst30s: 42, medianShotSeconds: 1.9, wordsPerMinute: 192, loudnessLufs: -14.2 },
      notes: 'Copy the pace and the punch-in zooms. Skip the meme sound effects.',
      summary: 'Hook in the first 3 seconds with the price on screen. Jump cuts every 1-2 s, punch-in zooms on every claim, bold yellow captions with one emphasized word, B-roll of the car in action every 6-8 s, upbeat music under speech, a whoosh on most cuts.'
    }
  ]

  const snapshot = (): ProjectSnapshot => ({
    path: 'C:\\Projects\\LiPo',
    doc,
    readOnly: false,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoLabel: undoStack.length ? undoLabels[undoLabels.length - 1] ?? 'your change' : undefined,
    undoBy: 'claude',
    undoAt: new Date(Date.now() - 180000).toISOString(),
    missingSources: [],
    profile: profiles.find((p) => p.id === doc.project.profileId) ?? null
  })

  const commit = (fn: (d: ProjectDoc) => void, source: 'user' | 'claude' | 'app', label: string, ids: string[] = []) => {
    undoStack.push(doc)
    undoLabels.push(label)
    redoStack.length = 0
    const next = clone(doc)
    fn(next)
    next.project.updatedAt = now()
    doc = next
    const snap = snapshot()
    ev.change.emit({ snapshot: snap, source, label, changedItemIds: ids })
    return snap
  }

  const applyOp = (op: UserOp, d: ProjectDoc) => {
    const p = d.project
    const r = new TimelineResolver(p, d.transcript)
    const item = 'id' in op ? p.items.find((i) => i.id === op.id) : undefined
    switch (op.op) {
      case 'updateItem':
        Object.assign(item!, op.patch)
        break
      case 'moveItem':
        if (item && item.type !== 'segment') item.anchor = r.anchorAt(op.start)
        break
      case 'trimItem':
        if (item && item.type !== 'segment') {
          const res = r.resolveItem(item)
          if (op.edge === 'start') {
            item.anchor = r.anchorAt(op.time)
            item.duration = Math.max(0.04, res.end - op.time)
          } else item.duration = Math.max(0.04, op.time - res.start)
        }
        break
      case 'deleteItem':
        p.items = p.items.filter((i) => i.id !== op.id)
        break
      case 'nudgeSegment':
        if (item && item.type === 'segment') item[op.edge] = Math.max(0, +(item[op.edge] + op.delta).toFixed(3))
        break
      case 'updateTrack':
        Object.assign(p.tracks.find((t) => t.id === op.id)!, op.patch)
        break
      case 'addTrack':
        p.tracks.push({ id: `${op.kind}_${p.tracks.length}`, kind: op.kind, name: op.name ?? `${op.kind} ${p.tracks.length}`, muted: false, solo: false, volume: 0, hidden: false })
        break
      case 'editWord':
      case 'setEmphasis':
        for (const c of Object.values(d.transcript.clips))
          for (const w of c.words)
            if (w.id === op.wordId) {
              if (op.op === 'editWord') Object.assign(w, { text: op.text, edited: true })
              else w.emphasis = op.emphasis
            }
        break
      case 'setInspiration':
        p.inspiration = op.text
        break
      case 'swapFile':
        if (item && item.type === 'audio') item.file = op.path
        break
      case 'patchProject':
        Object.assign((p as Record<string, unknown>)[op.path] as object, op.patch)
        break
    }
  }

  // Claude "working": every few seconds it nudges a graphic so the pulse and live output can be seen.
  setInterval(() => {
    if (!open) return
    const g = doc.project.items.filter((i) => i.type === 'graphic')
    const it = pick(g)
    commit((d) => {
      const x = d.project.items.find((i) => i.id === it.id)
      if (x && x.type === 'graphic') x.duration = +(1.5 + rand() * 3).toFixed(2)
    }, 'claude', 'Claude changed a graphic', [it.id])
    ev.output.emit({ ts: now(), kind: pick(['tool', 'text', 'info'] as const), text: pick(['update_item gfx12 duration 2.4', 'Checking stills at 4:10', 'get_audio_energy 210.40–210.60 step 5 ms', 'The price tag sits clear of the face now.']) })
    runner = { ...runner, lastActivity: pick(['Placing graphics', 'Checking the cut at 3:41 in 5 ms steps', 'Reviewing stills']) }
    ev.runner.emit(runner)
  }, 5000)

  setTimeout(() => ev.suggestion.emit({ profileId: 'rc', kind: 'music_quieter', text: 'Keep music quieter under speech on this channel?' }), 4000)

  const api: Api = {
    app: {
      info: async () => ({ name: 'AI Video Editor', version: '0.9.0', platform: 'win32', isPackaged: false, userDataPath: 'C:\\Users\\Adam\\AppData\\Roaming\\AI Video Editor', appLogPath: 'app.log' }),
      openPath: async () => undefined,
      showItemInFolder: async () => undefined,
      openExternal: async (url) => void window.open(url, '_blank'),
      pickFolder: async () => 'C:\\Users\\Adam\\Videos\\New footage',
      pickFiles: async (o) => (o.multi ? ['a.jpg', 'b.jpg', 'c.jpg'] : ['C:\\Users\\Adam\\file.wav']),
      saveFile: async () => 'C:\\Users\\Adam\\out.png',
      fileUrl: (path) => placeholder(path.split(/[\\/]/).pop() ?? '', 200),
      copyText: async (t) => navigator.clipboard?.writeText(t).catch(() => undefined),
      saveDiagnostics: async () => 'C:\\Users\\you\\Downloads\\AI-Video-Editor-diagnostics-2026-10-07_11-40.zip',
      onMenu: () => () => undefined
    },
    updates: {
      state: async () => update,
      check: async () => {
        update = { ...update, status: 'checking', dot: false }
        ev.update.emit(update)
        await sleep(700)
        for (let p = 0; p <= 100; p += 20) {
          update = { ...update, status: 'downloading', percent: p, newVersion: '0.9.1' }
          ev.update.emit(update)
          await sleep(250)
        }
        update = { ...update, status: 'downloaded', releaseNotes: '<ul><li>Faster preview</li><li>Fixed a caption timing bug</li></ul>' }
        ev.update.emit(update)
      },
      restartNow: async () => location.reload(),
      later: async () => {
        update = { ...update, status: 'restart_pending' }
        ev.update.emit(update)
      },
      onState: ev.update.on
    },
    setup: {
      status: async () => ({
        gpu: { ok: true, name: 'NVIDIA GeForce RTX 5070 Ti', driver: '581.15', message: 'NVIDIA graphics card found.' },
        python: { ok: !hash.includes('setup'), installing: false, message: hash.includes('setup') ? 'Not installed yet.' : 'Installed.' },
        ffmpeg: { ok: true, nvenc: true, message: 'ffmpeg 8.1 with the NVIDIA encoder.' },
        libraryFolder: { ok: !!settings.libraryFolder, path: settings.libraryFolder },
        claude: { ok: false, message: 'Claude Code was not found on this PC.' }
      }),
      installEnvironment: async () => {
        for (let p = 0; p <= 100; p += 10) {
          ev.setup.emit({ step: 'download', percent: p, message: p < 50 ? 'Downloading PyTorch with CUDA…' : 'Installing faster-whisper…' })
          await sleep(300)
        }
        ev.setup.emit({ step: 'done', percent: 100, message: 'Done', done: true })
      },
      onProgress: ev.setup.on
    },
    settings: {
      get: async () => settings,
      update: async (patch) => (settings = { ...settings, ...patch }),
      setPikzelsKey: async () => undefined,
      hasPikzelsKey: async () => true,
      openAppLog: async () => undefined,
      claudeSetup: async () => ({ command: 'claude mcp add --transport http ave http://127.0.0.1:47821/mcp', json: '{\n  "mcpServers": { "ave": { "type": "http", "url": "http://127.0.0.1:47821/mcp" } }\n}', url: 'http://127.0.0.1:47821/mcp' })
    },
    profiles: {
      list: async () => profiles,
      save: async (p) => {
        profiles = profiles.map((x) => (x.id === p.id ? p : x))
        return p
      },
      create: async (name) => {
        const p = ProfileSchema.parse({ id: `pr${Date.now()}`, name })
        profiles = [...profiles, p]
        return p
      },
      delete: async (id) => void (profiles = profiles.filter((p) => p.id !== id)),
      suggestions: async () => [{ profileId: 'rc', kind: 'graphics_shorter', text: 'Keep graphics on screen for less time on this channel?' }],
      answerSuggestion: async () => undefined,
      onSuggestion: ev.suggestion.on
    },
    music: {
      list: async () => musicTracks(),
      rescan: async () => musicTracks(),
      addFolder: async (path) => (settings.musicFolders = [...settings.musicFolders, { id: `mf${Date.now()}`, path, name: path.split('\\').pop() ?? path }]),
      removeFolder: async (id) => (settings.musicFolders = settings.musicFolders.filter((f) => f.id !== id))
    },
    projects: {
      recent: async () => recent,
      create: async (o) => {
        open = true
        doc = buildDoc()
        doc.project = { ...doc.project, name: o.name, status: 'new', items: [], chat: [], requests: [], notes: [] }
        runner = { status: 'idle', connected: false, queue: 0 }
        ev.runner.emit(runner)
        return snapshot()
      },
      open: async () => {
        open = true
        return snapshot()
      },
      locate: async (id, path) => (recent = recent.map((r) => (r.id === id ? { ...r, path, found: true } : r))),
      removeRecent: async (id) => (recent = recent.filter((r) => r.id !== id)),
      close: async () => void (open = false)
    },
    project: {
      get: async () => (open ? snapshot() : null),
      onChange: ev.change.on,
      apply: async (op) => {
        const named = (id: string) => {
          const it = doc.project.items.find((i) => i.id === id)
          return it?.label ? `"${it.label}"` : 'item'
        }
        const label = op.op === 'resetItem' ? `Reset B-roll clip ${named(op.id)} (position and size, stabilization, 1 effect)` : op.op
        return commit((d) => applyOp(op, d), 'user', label)
      },
      undo: async () => {
        if (undoStack.length) {
          redoStack.push(doc)
          doc = undoStack.pop()!
          undoLabels.pop()
        }
        return snapshot()
      },
      redo: async () => {
        if (redoStack.length) {
          undoStack.push(doc)
          doc = redoStack.pop()!
        }
        return snapshot()
      },
      relinkSource: async () => snapshot(),
      startEdit: async () => {
        commit((d) => void (d.project.status = 'editing'), 'app', 'Start edit')
        runner = { status: 'starting', connected: false, queue: 1, lastActivity: 'Starting Claude Code' }
        ev.runner.emit(runner)
      },
      sendChat: async (o) =>
        void commit((d) => {
          const id = `r${Date.now()}`
          d.project.requests.push({ id, kind: 'chat', status: 'queued', createdAt: now(), text: o.text, range: o.range, context: {} })
          d.project.chat.push({ id: `c${Date.now()}`, role: 'user', text: o.text, ts: now(), requestId: id, range: o.range })
        }, 'user', 'Chat'),
      requestReedit: async (o) =>
        void commit((d) => d.project.requests.push({ id: `r${Date.now()}`, kind: 'reedit', status: 'in_progress', createdAt: now(), text: o.direction, range: o.range, context: {} }), 'user', 'Re-edit'),
      requestFixAudio: async () => undefined,
      addNote: async (o) => void commit((d) => d.project.notes.push({ id: `n${Date.now()}`, text: o.text, itemId: o.itemId, range: o.range, status: 'open', createdAt: now() }), 'user', 'Note'),
      noteToRule: async () => undefined,
      reviewRequest: async (id, decision) => void commit((d) => {
        const r = d.project.requests.find((x) => x.id === id)
        if (r) r.review = decision === 'keep' ? 'kept' : 'reverted'
      }, 'user', 'Review'),
      introDecision: async () => undefined,
      introVersions: async () => ({ versions: [{ id: 'v_i1', name: 'Intro 1', createdAt: now() }], currentId: null }),
      useIntro: async () => undefined,
      setVideoTheme: async (id) => void commit((d) => void (d.project.videoTheme = id ? { id, name: themes.find((t) => t.id === id)?.name ?? '' } : null), 'user', 'Video theme'),
      requestStabilize: async () => undefined,
      requestInsertClip: async () => undefined,
      requestShorts: async () => undefined,
      exportCheck: async () => {
        for (const m of ['Waiting for the preview to finish…', 'Checking the picture and sound…']) {
          ev.check.emit(m)
          await new Promise((r) => setTimeout(r, 500))
        }
        return {
          checked: ['the timeline', 'the picture', 'the sound'],
          skipped: [],
          problems: [
            { id: 'black_1', severity: 'warning', title: 'Black screen for 1.4 s', detail: '3:12.400 to 3:13.800: nothing on screen.', range: { start: 192.4, end: 193.8 } },
            { id: 'silence_1', severity: 'warning', title: '4.2 s of silence', detail: '7:02.000 to 7:06.200: no voice, music or sound. Dead air, or a muted clip?', range: { start: 422, end: 426.2 } },
            { id: 'pending', severity: 'info', title: '1 change waiting for Keep or Revert', detail: 'They are in the video as it stands; the export uses them.' }
          ]
        }
      },
      onCheckProgress: (cb) => ev.check.on(cb),
      regeneratePublish: async () => undefined,
      seamAudio: async () => 'seam.wav',
      waveform: async (key) => {
        const k = JSON.stringify(key)
        let s = 0
        for (const ch of k) s = (s * 31 + ch.charCodeAt(0)) | 0
        const n = 50 * 300
        const peaks = new Array<number>(n)
        for (let i = 0; i < n; i++) peaks[i] = Math.abs(Math.sin(i * 0.013 + s) * Math.sin(i * 0.17) * (0.4 + 0.6 * Math.abs(Math.sin(i * 0.0021 + s))))
        return { peaksPerSecond: 50, peaks }
      },
      frameAt: async () => null,
      versions: {
        list: async () => versions,
        save: async (name) => {
          const v = { id: `v${Date.now()}`, name, createdAt: now(), auto: false }
          versions.push(v)
          return v
        },
        restore: async () => snapshot(),
        remove: async (id) => void versions.splice(versions.findIndex((v) => v.id === id), 1),
        compareFrames: async (a, b, t) => ({ a: placeholder(`${a} @ ${t.toFixed(1)}s`, 120), b: placeholder(`${b} @ ${t.toFixed(1)}s`, 300) })
      },
      exportVideo: async () => {
        const id = `j${Date.now()}`
        void (async () => {
          for (let p = 0; p <= 100; p += 5) {
            ev.job.emit({ id, kind: 'export', status: 'running', percent: p, fps: 34 })
            await sleep(300)
          }
          ev.job.emit({ id, kind: 'export', status: 'done', percent: 100, out: 'C:\\Projects\\LiPo\\exports\\LiPo.mp4' })
        })()
        return id
      },
      cancelExport: async () => undefined,
      onRenderJob: ev.job.on,
      exportLog: async () => 'C:\\Projects\\LiPo\\logs\\export.txt',
      exportPack: async () => 'C:\\Projects\\LiPo\\exports\\pack',
      saveToLibrary: async (_id, meta) => ({ ...library[0], id: `a${Date.now()}`, name: meta.name })
    },
    thumbnails: {
      generate: async () => undefined,
      regenerate: async () => undefined,
      choose: async (id) => void commit((d) => void (d.project.thumbnails.chosenId = id), 'user', 'Choose thumbnail'),
      exportImage: async () => 'C:\\Users\\Adam\\thumb.png',
      recreate: async () => undefined,
      edit: async () => undefined,
      faceSwap: async () => undefined,
      score: async (id, title) => {
        const score = { main: 7.4, subscores: { clarity: 8, emotion: 7, text: 6 }, suggestion: 'Make the text bigger.', title, at: now() }
        commit((d) => {
          const t = d.project.thumbnails.items.find((x) => x.id === id)
          if (t) t.score = score
        }, 'app', 'Score')
        return score
      },
      titles: async () => {
        const out = ['My LiPo Almost Caught Fire', 'Do Not Charge Your LiPo Like This']
        commit((d) => void (d.project.publish.titles = [...out, ...d.project.publish.titles]), 'user', 'Titles')
        return out
      }
    },
    preview: {
      state: async () => preview,
      onState: ev.preview.on,
      showBefore: async () => undefined
    },
    claude: {
      state: async () => runner,
      onState: ev.runner.on,
      onOutput: ev.output.on,
      stop: async () => {
        runner = { status: 'idle', connected: true, queue: 1, pausedAt: 'Self-check' }
        ev.runner.emit(runner)
      },
      resume: async () => {
        runner = { status: 'running', connected: true, queue: 0, lastActivity: 'Resuming at Self-check' }
        ev.runner.emit(runner)
      },
      estimate: async () => ({ usd: 0.35, measured: false, basis: 'a first guess until this PC has measured one' })
    },
    library: {
      list: async (f) => library.filter((a) => (!f?.scope || a.scope === f.scope) && (!f?.type || a.type === f.type) && (!f?.query || a.name.toLowerCase().includes(f.query.toLowerCase()))),
      update: async (id, patch) => {
        library = library.map((a) => (a.id === id ? { ...a, ...patch } : a))
        return library.find((a) => a.id === id)!
      },
      duplicate: async (id) => {
        const a = { ...library.find((x) => x.id === id)!, id: `a${Date.now()}` }
        a.name += ' copy'
        library = [...library, a]
        return a
      },
      remove: async (id) => void (library = library.filter((a) => a.id !== id)),
      placeInProject: async () => undefined,
      changeFolder: async (dest: string) => {
        settings = { ...settings, libraryFolder: dest, libraryFolderConfirmed: true }
        return { moved: library.length, skipped: 0 }
      }
    },
    shorts: {
      state: async () => ({ working: { short_3: 'Rendering the preview… 40%' } }),
      exportShort: async () => 'C:\\Projects\\exports\\Shorts\\LiPo - Short 1.mp4',
      exportAll: async () => [],
      remove: async (id) => void commit((d) => void (d.project.shorts = (d.project.shorts ?? []).filter((x) => x.id !== id)), 'user', 'Delete Short'),
      refresh: async () => undefined,
      onState: () => () => undefined
    },
    themes: {
      list: async () => themes,
      analyze: async (input) => {
        const steps = ['Finding the newest videos…', 'Downloading video 1 of up to 3… 40%', 'Measuring the style of "Racing at the beach"… Finding the cuts (video 1 of 3)…']
        for (const [i, message] of steps.entries()) {
          ev.themes.emit({ step: i === 0 ? 'listing' : i === 1 ? 'download' : 'analyze', message, percent: 10 + i * 30 })
          await new Promise((r) => setTimeout(r, 400))
        }
        const t = { ...themes[0], id: `vt_${Date.now()}`, name: input.name || 'New channel style', createdAt: now(), summary: undefined }
        themes.unshift(t)
        ev.themes.emit({ step: 'done', message: 'Done', percent: 100 })
        return t
      },
      cancel: async () => undefined,
      update: async (id, patch) => {
        const t = themes.find((x) => x.id === id)!
        Object.assign(t, patch.name ? { name: patch.name } : {}, patch.notes !== undefined ? { notes: patch.notes } : {})
        return t
      },
      remove: async (id) => void themes.splice(themes.findIndex((x) => x.id === id), 1),
      sheets: async () => [],
      onProgress: (cb) => ev.themes.on(cb)
    },
    pikzels: {
      list: async () => pikzels,
      create: async (kind, name) => {
        const p: Pikzonality = { id: `pz${Date.now()}`, kind, name, status: 'processing', progress: 5, specialInstructions: '', createdAt: now() }
        pikzels = [p, ...pikzels]
        return p
      },
      refresh: async () => pikzels,
      updateInstructions: async (id, text) => {
        pikzels = pikzels.map((p) => (p.id === id ? { ...p, specialInstructions: text } : p))
        return pikzels.find((p) => p.id === id)!
      },
      remove: async (id) => void (pikzels = pikzels.filter((p) => p.id !== id)),
      rename: async (id, name) => {
        pikzels = pikzels.map((p) => (p.id === id ? { ...p, name } : p))
        return pikzels.find((p) => p.id === id)!
      },
      thumbnailsFromLink: async () => ({ source: 'Mock channel', items: [] }),
      pricing: async () => mockPricing(),
      setPrices: async (o) => {
        priceOverrides = o ?? {}
        return mockPricing()
      }
    }
  }

  function musicTracks(): MusicTrack[] {
    return ['upbeat', 'chill', 'tense'].flatMap((folder, i) =>
      [1, 2, 3].map((n) => ({ path: `D:\\Music\\${folder}\\track${n}.mp3`, name: `track${n}.mp3`, folderId: 'mf1', folder, duration: 120 + n * 30, format: 'mp3', missing: i === 2 && n === 3 }))
    )
  }

  ;(window as unknown as { api: Api }).api = api
}
