/**
 * The machine the engine runs on: the NVIDIA graphics card, the managed Python environment and ffmpeg.
 *
 * The environment is installed once, into %LOCALAPPDATA% (paths.runtime), and app updates never touch it:
 *  - tools/uv-<version>/uv.exe        pinned uv, used to install Python and packages
 *  - tools/pythons/                   the pinned Python, installed by uv
 *  - tools/ffmpeg-<version>/bin/      pinned ffmpeg build with the NVIDIA encoder
 *  - python/                          the virtual environment (torch with CUDA + the engine's requirements)
 *  - engines/<version>/               every engine version ever used, so old projects render the same
 *
 * Every download is checked against its pinned sha256. Each part is built in a temporary folder and
 * renamed into place at the end, so a failed install never leaves half a setup behind. A marker file
 * holding the manifest hash means nothing is downloaded twice.
 *
 * Dev overrides: AVE_PYTHON, AVE_FFMPEG, AVE_FFPROBE use those programs directly; AVE_ENGINE_DIR runs the
 * engine from that folder; AVE_ALLOW_CPU=1 allows running without an NVIDIA card.
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { ENGINE_VERSION } from '@shared/appInfo'
import type { SetupProgress, SetupStatus } from '@shared/ipc'
import type { AppContext, EnvironmentService } from '../context'
import { paths } from '../paths'

const IS_WIN = process.platform === 'win32'
const EXE = IS_WIN ? '.exe' : ''

interface PinnedDownload {
  version: string
  url: string
  sha256: string
  /** Other places holding the same file (same sha256), tried in order if `url` fails. */
  mirrors?: string[]
}

/** engine/runtime.json: the pinned set the managed environment is built from. */
export interface RuntimeManifest {
  python: string
  torchIndexUrl: string
  torchPackages: string[]
  /** Requirements file inside the engine folder (requirements.lock.txt). */
  requirements: string
  uv: PinnedDownload
  ffmpeg: PinnedDownload
  /** yt-dlp, downloaded the first time a video theme is made from a YouTube link. */
  ytdlp?: PinnedDownload & { version: string }
  [k: string]: unknown
}

interface InstallMarker {
  manifestHash: string
  installedAt: string
  python: string
  /** What the engine's `check` command reported right after the install. */
  check?: Record<string, unknown>
}

/**
 * Pinned downloads. engine/runtime.json carries the same "uv" and "ffmpeg" keys and wins when present;
 * these are the fallback so the pins are never lost if that file is rewritten.
 */
export const DEFAULT_UV: PinnedDownload = {
  version: '0.12.23',
  url: 'https://github.com/astral-sh/uv/releases/download/0.12.23/uv-x86_64-pc-windows-msvc.zip',
  sha256: '75d05de6762778c31ee183398de7dd15093fad0ed90b1f236d8205ea5ec00c90'
}
/** BtbN FFmpeg-Builds, win64 GPL, ffmpeg 8.1.3 with NVENC (release autobuild-2026-10-05-13-07). */
export const DEFAULT_FFMPEG: PinnedDownload = {
  version: '8.1.3-14-g330caae0c1',
  url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-05-13-07/ffmpeg-n8.1.3-14-g330caae0c1-win64-gpl-8.1.zip',
  sha256: 'ce8f117aa804906c4a190367babfeeb0b9c8b2ea85ac128fa381b407f964af85'
}

export class SetupError extends Error {}

type GpuInfo = SetupStatus['gpu']

// ------------------------------------------------------------------ small helpers

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; onLine?: (line: string) => void; timeoutMs?: number } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true })
    } catch (err) {
      reject(err)
      return
    }
    let stdout = ''
    let stderr = ''
    let partial = ''
    const timer = opts.timeoutMs ? setTimeout(() => child.kill(), opts.timeoutMs) : null
    const onData = (chunk: Buffer, isErr: boolean) => {
      const text = chunk.toString('utf8')
      if (isErr) stderr = (stderr + text).slice(-200_000)
      else stdout = (stdout + text).slice(-2_000_000)
      if (opts.onLine) {
        partial += text
        const lines = partial.split(/\r?\n|\r/)
        partial = lines.pop() ?? ''
        for (const l of lines) if (l.trim()) opts.onLine(l)
      }
    }
    child.stdout.on('data', (c: Buffer) => onData(c, false))
    child.stderr.on('data', (c: Buffer) => onData(c, true))
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (opts.onLine && partial.trim()) opts.onLine(partial)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** Finds a program on PATH (with PATHEXT on Windows). Absolute paths are checked as they are. */
export function findOnPath(command: string): string | null {
  if (!command) return null
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) return existsSync(command) ? command : null
  const exts = IS_WIN ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of IS_WIN && !/\.[a-z0-9]+$/i.test(command) ? exts : ['']) {
      const full = join(dir.replace(/^"|"$/g, ''), command + ext)
      try {
        if (statSync(full).isFile()) return full
      } catch {
        /* not here */
      }
    }
  }
  return null
}

/** Downloads a file, reporting progress, and checks its sha256. Throws in plain words on any problem. */
/** Downloads a pinned file from its main address, falling back to its mirrors. */
export async function downloadPinned(
  pin: PinnedDownload,
  dest: string,
  onPercent: (pct: number, receivedMb: number, totalMb: number) => void
): Promise<void> {
  const urls = [pin.url, ...(pin.mirrors ?? [])]
  let lastError: unknown
  for (const url of urls) {
    try {
      await download(url, dest, pin.sha256, onPercent)
      return
    } catch (err) {
      lastError = err
      rmSync(dest, { force: true })
    }
  }
  throw lastError
}

export async function download(
  url: string,
  dest: string,
  sha256: string,
  onPercent: (pct: number, receivedMb: number, totalMb: number) => void
): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true })
  let res: Response
  try {
    res = await fetch(url, { redirect: 'follow' })
  } catch (err) {
    throw new SetupError(`Could not download ${basename(url)}. Check your internet connection and try again. (${(err as Error).message})`)
  }
  if (!res.ok || !res.body) throw new SetupError(`Could not download ${basename(url)} (the server answered ${res.status}). Try again later.`)
  const total = Number(res.headers.get('content-length') ?? 0)
  const hash = createHash('sha256')
  const out = createWriteStream(dest)
  let received = 0
  let lastReport = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      received += value.length
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
      const now = Date.now()
      if (now - lastReport > 250) {
        lastReport = now
        onPercent(total ? (received / total) * 100 : 0, received / 1e6, total / 1e6)
      }
    }
  } catch (err) {
    out.destroy()
    rmSync(dest, { force: true })
    throw new SetupError(`The download of ${basename(url)} stopped part way. Check your internet connection and try again. (${(err as Error).message})`)
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
  const got = hash.digest('hex')
  if (got.toLowerCase() !== sha256.toLowerCase()) {
    rmSync(dest, { force: true })
    throw new SetupError(`The downloaded file ${basename(url)} is damaged or not the expected file. Try again.`)
  }
  onPercent(100, received / 1e6, total / 1e6)
}

/** Extracts a zip: tar (built into Windows 10+) first, PowerShell Expand-Archive as a fallback; unzip elsewhere. */
export async function extractZip(zip: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true })
  if (IS_WIN) {
    const tar = await run('tar', ['-xf', zip, '-C', dest]).catch(() => null)
    if (tar && tar.code === 0) return
    const ps = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`
    ])
    if (ps.code !== 0) throw new SetupError(`Could not unpack ${basename(zip)}: ${ps.stderr.trim().slice(-400)}`)
    return
  }
  const r = await run('unzip', ['-q', '-o', zip, '-d', dest])
  if (r.code !== 0) throw new SetupError(`Could not unpack ${basename(zip)}: ${r.stderr.trim().slice(-400)}`)
}

function findFile(dir: string, name: string, depth = 4): string | null {
  if (depth < 0 || !existsSync(dir)) return null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return full
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const hit = findFile(join(dir, entry.name), name, depth - 1)
      if (hit) return hit
    }
  }
  return null
}

function readMarker(file: string): InstallMarker | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as InstallMarker
  } catch {
    return null
  }
}

/** Compares dotted versions ("1.10.0" > "1.9.2"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
  const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    return String(x).localeCompare(String(y))
  }
  return 0
}

/** Copies an engine folder, leaving out tests and Python caches. */
export function copyEngine(from: string, to: string): void {
  const tmp = `${to}.copying-${randomBytes(3).toString('hex')}`
  rmSync(tmp, { recursive: true, force: true })
  cpSync(from, tmp, {
    recursive: true,
    filter: (src) => {
      const name = basename(src)
      if (name === '__pycache__' || name.endsWith('.pyc') || name === '.pytest_cache') return false
      return !(src !== from && name === 'tests' && dirname(src) === from)
    }
  })
  mkdirSync(dirname(to), { recursive: true })
  if (existsSync(to)) {
    // Another call finished first; keep that copy.
    rmSync(tmp, { recursive: true, force: true })
    return
  }
  renameSync(tmp, to)
}

// ------------------------------------------------------------------ the service

export function createEnvironmentService(ctx: AppContext): EnvironmentService {
  let gpuCache: GpuInfo | null = null
  let installing: Promise<void> | null = null

  const bundledEngine = (): string => {
    const candidates = [join(paths.resources, 'engine'), join(process.cwd(), 'engine')]
    return candidates.find((d) => existsSync(join(d, 'ave_engine'))) ?? candidates[0]
  }

  const manifestFile = () => join(bundledEngine(), 'runtime.json')

  const manifest = (): RuntimeManifest => {
    const file = manifestFile()
    if (!existsSync(file)) throw new SetupError(`The engine's runtime list is missing (${file}). Reinstall the app.`)
    const m = JSON.parse(readFileSync(file, 'utf8')) as RuntimeManifest
    if (!m.uv?.url || !m.uv?.sha256) m.uv = DEFAULT_UV
    if (!m.ffmpeg?.url || !m.ffmpeg?.sha256) m.ffmpeg = DEFAULT_FFMPEG
    if (!m.python) throw new SetupError('The engine runtime list is incomplete. Reinstall the app.')
    return m
  }

  /** Hash of everything the Python environment is built from. Changes only when the pins change. */
  const manifestHash = (m: RuntimeManifest): string => {
    const h = createHash('sha256')
    h.update(JSON.stringify({ python: m.python, torchIndexUrl: m.torchIndexUrl, torchPackages: m.torchPackages, uv: m.uv }))
    const req = join(bundledEngine(), m.requirements || 'requirements.lock.txt')
    if (existsSync(req)) h.update(readFileSync(req))
    return h.digest('hex').slice(0, 16)
  }

  const uvDir = (m: RuntimeManifest) => join(paths.toolsDir, `uv-${m.uv.version}`)
  const ffmpegDir = (m: RuntimeManifest) => join(paths.toolsDir, `ffmpeg-${m.ffmpeg.version}`)
  const venvPython = () => (IS_WIN ? join(paths.pythonEnv, 'Scripts', 'python.exe') : join(paths.pythonEnv, 'bin', 'python'))
  const envMarkerFile = () => join(paths.pythonEnv, 'ave-install.json')

  const safeManifest = (): RuntimeManifest | null => {
    try {
      return manifest()
    } catch {
      return null
    }
  }

  const managedFfmpeg = (tool: 'ffmpeg' | 'ffprobe'): string | null => {
    const m = safeManifest()
    if (!m) return null
    const file = join(ffmpegDir(m), 'bin', tool + EXE)
    return existsSync(file) ? file : null
  }

  const pythonInstalled = (): boolean => {
    const m = safeManifest()
    if (!m || !existsSync(venvPython())) return false
    return readMarker(envMarkerFile())?.manifestHash === manifestHash(m)
  }

  const python = (): string => {
    if (process.env.AVE_PYTHON) return process.env.AVE_PYTHON
    if (existsSync(venvPython())) return venvPython()
    return IS_WIN ? venvPython() : 'python3'
  }

  const ffmpeg = (): string => process.env.AVE_FFMPEG || managedFfmpeg('ffmpeg') || 'ffmpeg'
  const ffprobe = (): string => process.env.AVE_FFPROBE || managedFfmpeg('ffprobe') || 'ffprobe'

  const gpu = async (): Promise<GpuInfo> => {
    if (gpuCache) return gpuCache
    let result: GpuInfo
    const r = await run('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'], { timeoutMs: 15000 }).catch(() => null)
    const line = r && r.code === 0 ? r.stdout.split(/\r?\n/).find((l) => l.trim()) : undefined
    if (line) {
      const [name, driver] = line.split(',').map((s) => s.trim())
      result = { ok: true, name, driver, message: `${name} (driver ${driver})` }
    } else if (process.env.AVE_ALLOW_CPU === '1') {
      result = { ok: true, message: 'No NVIDIA graphics card found. Running without one because AVE_ALLOW_CPU=1 is set (rendering is slow).' }
    } else {
      result = {
        ok: false,
        message:
          'No NVIDIA graphics card found. This app renders on an NVIDIA GPU, so it needs one with a current driver. ' +
          'If your PC has one, install the latest NVIDIA driver and restart the app.'
      }
    }
    gpuCache = result
    ctx.appLog.write('app', `Graphics card check: ${result.message}`)
    return result
  }

  const engineDir = (version: string): string => {
    if (process.env.AVE_ENGINE_DIR) return process.env.AVE_ENGINE_DIR
    const bundled = bundledEngine()
    // While developing, run the engine straight from the source folder so edits apply at once.
    if (!ctx.isPackaged && version === ENGINE_VERSION && existsSync(join(bundled, 'ave_engine'))) return bundled
    const target = join(paths.enginesDir, version)
    if (existsSync(join(target, 'ave_engine'))) return target
    if (version === ENGINE_VERSION && existsSync(join(bundled, 'ave_engine'))) {
      copyEngine(bundled, target)
      ctx.appLog.write('render', `Engine ${version} installed`, { dir: target })
      return target
    }
    // The project was made with an engine this PC does not have: use the newest one installed.
    const installed = existsSync(paths.enginesDir)
      ? readdirSync(paths.enginesDir).filter((v) => existsSync(join(paths.enginesDir, v, 'ave_engine')))
      : []
    installed.sort(compareVersions)
    const newest = installed[installed.length - 1]
    if (newest) {
      ctx.appLog.write('render', `Engine ${version} is not installed and not bundled; using engine ${newest} instead. The result may differ slightly.`)
      return join(paths.enginesDir, newest)
    }
    if (!existsSync(join(bundled, 'ave_engine'))) throw new SetupError('The render engine is missing from the app. Reinstall the app.')
    const fallback = join(paths.enginesDir, ENGINE_VERSION)
    copyEngine(bundled, fallback)
    ctx.appLog.write('render', `Engine ${version} is not available; using bundled engine ${ENGINE_VERSION} instead.`)
    return fallback
  }

  const ffmpegHasNvenc = async (file: string): Promise<boolean> => {
    const r = await run(file, ['-hide_banner', '-encoders'], { timeoutMs: 15000 }).catch(() => null)
    return !!r && /h264_nvenc/.test(r.stdout)
  }

  const status = async (): Promise<SetupStatus> => {
    const settings = ctx.settings.get()
    const g = await gpu()
    const marker = readMarker(envMarkerFile())
    const m = safeManifest()
    let pyOk: boolean
    let pyMessage: string
    if (installing) {
      pyOk = false
      pyMessage = 'Installing the render engine…'
    } else if (process.env.AVE_PYTHON) {
      pyOk = existsSync(process.env.AVE_PYTHON) || !!findOnPath(process.env.AVE_PYTHON)
      pyMessage = pyOk ? `Using ${process.env.AVE_PYTHON} (AVE_PYTHON)` : `AVE_PYTHON points to ${process.env.AVE_PYTHON}, which was not found.`
    } else if (pythonInstalled()) {
      pyOk = true
      pyMessage = 'The render engine is installed.'
    } else if (!IS_WIN) {
      pyOk = !!findOnPath('python3')
      pyMessage = pyOk ? 'Using python3 from this system (development).' : 'python3 was not found. Set AVE_PYTHON.'
    } else if (marker && m && marker.manifestHash !== manifestHash(m)) {
      pyOk = false
      pyMessage = 'This version of the app needs an updated render engine. Click Install to download it (one time).'
    } else {
      pyOk = false
      pyMessage = 'The render engine is not installed yet. Click Install to download it (one time, about 4 GB).'
    }
    const details: Record<string, string> = {}
    if (marker?.check) for (const [k, v] of Object.entries(marker.check)) details[k] = String(v)
    if (m) details.pythonPinned = m.python

    const ff = ffmpeg()
    const ffFound = isAbsolute(ff) ? existsSync(ff) : !!findOnPath(ff)
    const nvenc = ffFound ? (marker?.check && 'nvenc' in marker.check ? !!marker.check.nvenc : await ffmpegHasNvenc(ff)) : false
    const ffMessage = !ffFound
      ? 'ffmpeg is not installed yet. It is installed with the render engine.'
      : nvenc
        ? 'ffmpeg with the NVIDIA encoder is ready.'
        : 'ffmpeg is ready, but the NVIDIA encoder is not available. Exports use the slower CPU encoder.'

    const cmd = settings.runner?.command || 'claude'
    const claudePath = findOnPath(cmd)
    const lib = settings.libraryFolder
    return {
      gpu: g,
      python: { ok: pyOk, installing: !!installing, path: pyOk ? python() : undefined, message: pyMessage, details },
      ffmpeg: { ok: ffFound, path: ffFound ? ff : undefined, nvenc, message: ffMessage },
      libraryFolder: { ok: !!lib && existsSync(lib), path: lib || undefined },
      claude: claudePath
        ? { ok: true, message: `Found ${cmd} at ${claudePath}` }
        : {
            ok: false,
            message: `The command "${cmd}" was not found. Install Claude Code and sign in, or change the command in Settings.`
          }
    }
  }

  // ---------------------------------------------------------------- install

  const installUv = async (m: RuntimeManifest, report: (p: SetupProgress) => void): Promise<string> => {
    const dir = uvDir(m)
    const exe = join(dir, 'uv' + EXE)
    if (existsSync(exe)) return exe
    const tmp = `${dir}.tmp-${randomBytes(3).toString('hex')}`
    try {
      const zip = join(tmp, 'uv.zip')
      await downloadPinned(m.uv, zip, (pct) =>
        report({ step: 'uv', percent: Math.round(pct * 0.03), message: `Downloading the installer tool… ${Math.round(pct)}%` })
      )
      await extractZip(zip, join(tmp, 'x'))
      const found = findFile(join(tmp, 'x'), 'uv' + EXE)
      if (!found) throw new SetupError('The installer tool download did not contain uv.')
      mkdirSync(dir + '.stage', { recursive: true })
      for (const f of readdirSync(dirname(found))) renameSync(join(dirname(found), f), join(dir + '.stage', f))
      rmSync(dir, { recursive: true, force: true })
      renameSync(dir + '.stage', dir)
      return exe
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      rmSync(dir + '.stage', { recursive: true, force: true })
    }
  }

  const installFfmpeg = async (m: RuntimeManifest, report: (p: SetupProgress) => void): Promise<void> => {
    const dir = ffmpegDir(m)
    if (existsSync(join(dir, 'bin', 'ffmpeg' + EXE)) && existsSync(join(dir, 'bin', 'ffprobe' + EXE))) return
    const tmp = `${dir}.tmp-${randomBytes(3).toString('hex')}`
    try {
      const zip = join(tmp, 'ffmpeg.zip')
      await downloadPinned(m.ffmpeg, zip, (pct, got, total) =>
        report({
          step: 'ffmpeg',
          percent: 3 + Math.round(pct * 0.12),
          message: `Downloading ffmpeg… ${Math.round(got)} of ${Math.round(total)} MB`
        })
      )
      report({ step: 'ffmpeg', percent: 15, message: 'Unpacking ffmpeg…' })
      await extractZip(zip, join(tmp, 'x'))
      const exe = findFile(join(tmp, 'x'), 'ffmpeg' + EXE)
      if (!exe || !existsSync(join(dirname(exe), 'ffprobe' + EXE))) throw new SetupError('The ffmpeg download did not contain ffmpeg and ffprobe.')
      const root = dirname(dirname(exe)) // <build>/bin/ffmpeg.exe -> <build>
      rmSync(dir, { recursive: true, force: true })
      renameSync(root, dir)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  const installPython = async (m: RuntimeManifest, uv: string, report: (p: SetupProgress) => void): Promise<void> => {
    const engine = bundledEngine()
    const stage = `${paths.pythonEnv}.installing-${randomBytes(3).toString('hex')}`
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      UV_PYTHON_INSTALL_DIR: join(paths.toolsDir, 'pythons'),
      UV_CACHE_DIR: join(paths.runtime, 'uv-cache'),
      UV_NO_CONFIG: '1',
      UV_PYTHON_PREFERENCE: 'only-managed',
      VIRTUAL_ENV: ''
    }
    const tail: string[] = []
    const uvRun = async (args: string[], step: string, from: number, to: number, message: string) => {
      let pct = from
      report({ step, percent: from, message })
      const r = await run(uv, args, {
        env,
        cwd: engine,
        onLine: (line) => {
          tail.push(line)
          if (tail.length > 40) tail.shift()
          // uv prints one line per package; creep forward so the bar moves.
          pct = Math.min(to - 1, pct + 0.3)
          report({ step, percent: Math.round(pct), message })
        }
      })
      if (r.code !== 0) {
        ctx.appLog.write('error', `Setup step failed: uv ${args.join(' ')}`, { output: (r.stderr || tail.join('\n')).slice(-4000) })
        throw new SetupError(`${message.replace(/…$/, '')} failed. ${lastMeaningful(r.stderr || tail.join('\n'))}`)
      }
    }
    try {
      await uvRun(['python', 'install', m.python], 'python', 16, 22, `Installing Python ${m.python}…`)
      await uvRun(['venv', '--relocatable', '--python', m.python, stage], 'python', 22, 24, 'Creating the engine environment…')
      const py = IS_WIN ? join(stage, 'Scripts', 'python.exe') : join(stage, 'bin', 'python')
      const torch = Array.isArray(m.torchPackages) ? m.torchPackages : []
      if (torch.length) {
        await uvRun(
          ['pip', 'install', '--python', py, '--index-url', m.torchIndexUrl, '--extra-index-url', 'https://pypi.org/simple', '--index-strategy', 'unsafe-best-match', ...torch],
          'torch',
          24,
          75,
          'Installing PyTorch with CUDA (about 3 GB, this takes a while)…'
        )
      }
      const req = join(engine, m.requirements || 'requirements.lock.txt')
      if (existsSync(req)) {
        await uvRun(['pip', 'install', '--python', py, '-r', req], 'packages', 75, 92, 'Installing the engine packages…')
      }
      // Swap the finished environment into place.
      const old = `${paths.pythonEnv}.old-${randomBytes(3).toString('hex')}`
      if (existsSync(paths.pythonEnv)) renameSync(paths.pythonEnv, old)
      try {
        renameSync(stage, paths.pythonEnv)
      } catch (err) {
        if (existsSync(old)) renameSync(old, paths.pythonEnv)
        throw err
      }
      rmSync(old, { recursive: true, force: true })
    } finally {
      rmSync(stage, { recursive: true, force: true })
    }
  }

  const engineCheck = async (): Promise<Record<string, unknown> | undefined> => {
    const args = ['-m', 'ave_engine', '--ffmpeg', ffmpeg(), '--ffprobe', ffprobe(), 'check']
    const r = await run(python(), args, { cwd: engineDir(ENGINE_VERSION), timeoutMs: 180000 }).catch(() => null)
    if (!r) return undefined
    for (const line of r.stdout.split(/\r?\n/)) {
      try {
        const e = JSON.parse(line)
        if (e.event === 'result') return e.data as Record<string, unknown>
        if (e.event === 'error') throw new SetupError(`The engine check failed: ${e.message}`)
      } catch (err) {
        if (err instanceof SetupError) throw err
      }
    }
    if (r.code !== 0) throw new SetupError(`The engine check failed. ${lastMeaningful(r.stderr)}`)
    return undefined
  }

  const install = async (onProgress: (p: SetupProgress) => void): Promise<void> => {
    if (installing) return installing
    const report = (p: SetupProgress) => {
      try {
        onProgress(p)
      } catch {
        /* the window may be gone */
      }
    }
    installing = (async () => {
      const started = Date.now()
      ctx.appLog.write('app', 'Render engine setup started')
      try {
        if (!IS_WIN) {
          throw new SetupError(
            'The managed engine installs on Windows only. On this system, use python3 and ffmpeg from the system (set AVE_PYTHON, AVE_FFMPEG and AVE_FFPROBE).'
          )
        }
        const g = await gpu()
        if (!g.ok) throw new SetupError(g.message)
        const m = manifest()
        mkdirSync(paths.toolsDir, { recursive: true })
        const uv = await installUv(m, report)
        await installFfmpeg(m, report)
        const hash = manifestHash(m)
        if (!pythonInstalled()) {
          await installPython(m, uv, report)
          writeFileSync(envMarkerFile(), JSON.stringify({ manifestHash: hash, installedAt: new Date().toISOString(), python: m.python } satisfies InstallMarker, null, 2))
        }
        report({ step: 'check', percent: 94, message: 'Checking the graphics card and encoder…' })
        const check = await engineCheck()
        const marker = readMarker(envMarkerFile())
        if (marker) writeFileSync(envMarkerFile(), JSON.stringify({ ...marker, check }, null, 2))
        ctx.appLog.write('app', `Render engine setup finished in ${Math.round((Date.now() - started) / 1000)} s`, check)
        report({ step: 'done', percent: 100, message: 'The render engine is ready.', done: true })
        // An open project's preview was waiting for the engine.
        ctx.preview?.invalidate()
      } catch (err) {
        const message = err instanceof SetupError ? err.message : `Setup failed: ${(err as Error).message}`
        ctx.appLog.write('error', 'Render engine setup failed', { error: message, stack: (err as Error).stack })
        report({ step: 'error', message, error: message, done: true })
        throw new SetupError(message)
      }
    })()
    try {
      await installing
    } finally {
      installing = null
    }
  }

  /**
   * yt-dlp for reading reference videos (video themes). Downloaded on first use, pinned and checked like ffmpeg;
   * it can update itself later (yt-dlp -U) when YouTube changes. Elsewhere than Windows it is taken from PATH.
   */
  const ytdlp = async (onPercent?: (pct: number) => void): Promise<string> => {
    if (process.env.AVE_YTDLP) return process.env.AVE_YTDLP
    if (!IS_WIN) return 'yt-dlp'
    const m = manifest()
    if (!m.ytdlp?.url) throw new SetupError('The app has no yt-dlp download listed. Reinstall the app.')
    const dir = join(paths.toolsDir, 'yt-dlp')
    const exe = join(dir, 'yt-dlp.exe')
    const marker = join(dir, 'pinned.txt')
    if (existsSync(exe)) return exe
    const tmp = `${exe}.download-${randomBytes(3).toString('hex')}`
    try {
      await downloadPinned(m.ytdlp, tmp, (pct) => onPercent?.(pct))
      mkdirSync(dir, { recursive: true })
      renameSync(tmp, exe)
      writeFileSync(marker, m.ytdlp.version)
    } finally {
      rmSync(tmp, { force: true })
    }
    return exe
  }

  /** The style analysis script (not part of the versioned render engine: it changes nothing in projects). */
  const analysisScript = (): string => join(bundledEngine(), 'analysis', 'style.py')

  return {
    status,
    install,
    python,
    ffmpeg,
    ffprobe,
    engineDir,
    ytdlp,
    analysisScript,
    hasGpu: async () => (await gpu()).ok
  }
}

/** The last line of tool output that says something, for a short error message. */
function lastMeaningful(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(warning|hint|note):/i.test(l))
  return (lines.slice(-2).join(' ') || '').slice(0, 400)
}
