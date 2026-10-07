# AI Video Editor

A Windows desktop app where Claude edits your video through MCP. You watch every decision land on a timeline, fix the few things that are off, export, and get thumbnails and a publishing pack.

The app itself makes no editing decisions: no silence detection, no filler-word removal, no cut snapping, no transcription of its own and no AI model calls. Claude (Claude Code, running on your PC with your own sign-in) makes every decision through the app's tools. The app shows the edit, lets you tweak it, and renders it with the same GPU compositor for the preview and the export.

The full brief is in [docs/SPEC.md](docs/SPEC.md).

## Contents

- [Setup](#setup)
- [Development](#development)
- [Releasing](#releasing)
- [How Claude connects](#how-claude-connects)
- [Project file format](#project-file-format)
- [Where data lives](#where-data-lives)
- [The October 5 scripts](#the-october-5-scripts)
- [Privacy](#privacy)

## Setup

**You need**

- Windows 10 or 11, 64-bit.
- An NVIDIA graphics card with a current driver (the renderer and encoder run on it).
- [Claude Code](https://code.claude.com) installed and signed in on the same PC (`claude` in a terminal should start it). The app uses that sign-in; it holds no Claude API key.
- A Pikzels account with API access, for thumbnails (optional until you want thumbnails).

**Install**

1. Download `AI-Video-Editor-Setup-<version>.exe` from [Releases](https://github.com/trendlinepros-afk/Automated-Video-Editing/releases/latest).
2. Run it. It installs for your Windows user only, so there is no admin prompt. The build is not code-signed, so Windows SmartScreen shows "Windows protected your PC" the first time: click **More info**, then **Run anyway**.

**First launch**

1. **Graphics card check.** The app looks for an NVIDIA card and says plainly if it cannot find one.
2. **Python environment.** Click **Install** once. The app downloads a pinned Python, PyTorch with CUDA, faster-whisper and an ffmpeg build with the NVIDIA encoder into `%LOCALAPPDATA%\AI Video Editor`. Every download is checked against a pinned hash. It takes a while (several GB) and is never re-downloaded by app updates.
3. **Asset library folder.** Pick a folder for reusable graphics and sounds. Any drive works, including a synced one.
4. **Pikzels key.** Paste your Pikzels API key in Settings. It is stored with Windows credential protection and never written to project files or logs.
5. Create a profile for each channel, then **New project**: pick the profile and the footage folder, name it, and press **Start edit**.

## Development

```bash
npm ci
npm run dev          # Electron with hot reload
npm run typecheck    # main/shared/tests and renderer
npx vitest run       # unit tests (tests/*.test.ts)
python -m pytest engine/tests -q   # engine tests (preview/export match and more)
npm run dist         # build the Windows installer into dist/ without publishing
```

Code layout:

| Folder | Holds |
| --- | --- |
| `src/shared/` | The contracts: project format (zod), migrations, timeline/anchor resolution, render plan, settings, IPC types, `appInfo.ts` (app name, IDs, format versions, release repository) |
| `src/main/` | Main process services (see `src/main/context.ts` for who owns what): project store, MCP server and tools, runner, engine bridge, preview, exports, updater |
| `src/preload/` | Exposes `window.api` (the contract in `src/shared/ipc.ts`) |
| `src/renderer/` | The React UI |
| `engine/` | The Python render engine (`ave_engine`), its pinned runtime (`runtime.json`), the October 5 wrappers (`oct5/`) and tests |
| `tests/` | Vitest tests and fixtures, including a sample project from every released format |

**Development overrides** (environment variables)

| Variable | Effect |
| --- | --- |
| `AVE_PYTHON` | Use this Python instead of the managed environment (on Linux/macOS dev machines, `python3` from the system is used) |
| `AVE_FFMPEG`, `AVE_FFPROBE` | Use these ffmpeg/ffprobe programs |
| `AVE_ENGINE_DIR` | Run the engine from this folder (default: `engine/` in the repository) |
| `AVE_ALLOW_CPU=1` | Allow running without an NVIDIA card (slow; used by CI) |
| `AVE_BACKEND=numpy` | Force the engine's CPU code path |
| `AVE_RUNTIME_DIR` | Put the managed runtime somewhere other than `%LOCALAPPDATA%\AI Video Editor` |
| `AVE_UPDATE_FEED_URL` | Read updates from this generic feed URL instead of GitHub (used by the update end-to-end test) |

To rename the app, change `APP_NAME` in `src/shared/appInfo.ts` and `productName` in `electron-builder.yml` (a test checks they match). Never change `APP_DATA_FOLDER` after a release: settings live there.

## Releasing

Releases go straight to this repository's GitHub Releases, and installed apps read them from there. **The repository must be public** for installed apps to read releases without a token.

1. Bump `version` in `package.json` (for example `1.0.1`).
2. Add a `## 1.0.1` section to `CHANGELOG.md`. Its text becomes the GitHub release notes and is shown in the app's update dialog. The release is blocked if the section is missing or empty.
3. Commit and merge into `main`, then start the release: **Actions → Release → Run workflow** on `main` (or push a tag `vX.Y.Z` matching the version). Publishing creates the `vX.Y.Z` tag and release.
4. GitHub Actions (`.github/workflows/release.yml`) then runs:
   - **gate**: a pushed tag must match `package.json`, and the version must not be released already; typecheck; every unit test, including opening and upgrading each sample project, the section lock and log redaction; the engine tests, including preview/export match.
   - **update-e2e** (Windows): builds this code twice, as `0.0.1` and as the release version, both reading updates from a local feed. It installs `0.0.1` silently, writes a file in `%APPDATA%\AI Video Editor`, serves the new build, and runs the installed app with `--update-self-test`. The app checks, downloads (sha512-verified), and installs the new build over itself. The job then checks that the installed program reports the new version and that the settings file is untouched.
   - **publish**: builds the installer, then creates the `vX.Y.Z` release and uploads the installer, `latest.yml` and the blockmap in one step. Running the release again for a version whose release is missing `latest.yml` repairs it.

Every push and pull request runs `.github/workflows/ci.yml`: the same tests plus a Windows installer build that is not published.

**Rollback.** Old releases stay on GitHub. Download an older installer from Releases and run it; it installs over the current version. Settings, profiles and projects are not touched. A project saved by a newer version opens read-only in an older one, with a message to update.

**How updates behave in the app.** A quiet check at launch shows a dot on the button and downloads nothing. Clicking **Check for updates** shows Checking, then Up to date or a download with a percentage. When it finishes, a dialog shows the new version and its release notes with **Restart now** (saves, installs, relaunches and reopens your project; blocked while an export runs) or **Later** (installs when you close the app; the button reads Restart to update). Without a connection you get a plain message and Retry. Every update event goes to the app log and the open project's log.

## How Claude connects

The app runs a local MCP server on `http://127.0.0.1:47821/mcp` (port configurable in Settings). It only listens on your PC and every request needs a bearer token that the app generates and stores encrypted.

**The app starts Claude for you.** Start edit, a chat message, a section re-edit, a note, Fix clipped audio or Stabilize (right-click a clip) adds a request to the project's queue and starts Claude Code in its non-interactive mode (`claude -p ... --output-format stream-json --mcp-config <per-project config> ...`). The per-project MCP config points Claude at this project's tools with the token. The app hands Claude the standard editing rules (the October 5 method), the profile's channel notes and rules, and the request. Progress shows live in the top bar and the chat, with Stop. Follow-ups resume the same Claude session where possible; otherwise a new session reads the progress checklist and handoff notes and carries on from the next unfinished stage.

If Claude cannot start or stops part way (signed out, usage limit, low API credits, lost connection), the request stays queued with the reason shown, and **Resume** runs the queue.

**Interruptions cost little.** An edit runs in stages, each ticked off on the progress checklist with a handoff note, and every change is written to disk the moment it is made (flushed before it replaces the old file, so a power cut leaves the old or the new project.json, never a broken one). Backups of project.json and the transcript are taken on opening and every 10 minutes; a file that cannot be read is restored from the newest copy. After a usage limit the app tries again on its own when the limit resets (or every 30 minutes when Claude Code does not say when); after a dropped connection or a busy API, after 1, 2, 5, 10 and then every 30 minutes (Settings > Claude connection can turn this off). Opening a project that was interrupted puts the unfinished work back in the queue and shows where it carries on; **Resume** continues from that stage, continuing the same Claude session where possible.

**Connecting by hand.** Settings > Claude connection > **Copy setup** copies a command like:

```bash
claude mcp add --transport http ave http://127.0.0.1:47821/mcp --header "Authorization: Bearer <token>"
```

Run it once, then open Claude Code (or the Claude desktop app with the same server) and ask it to work on the open project. A hand-connected Claude picks up any queued requests through the Review tools.

**Another AI tool.** The command the app runs is a setting (Settings > Claude connection): command, arguments with `{prompt}`, `{mcpConfig}`, `{systemPrompt}`, `{allowedTools}` placeholders, and resume arguments with `{sessionId}`. Any command-line AI tool that supports MCP over HTTP can replace Claude Code. An AI that can only edit files can work on `project.json` directly using the format below.

**Tools** (grouped): read (`get_project`, `get_inspiration_and_scope`, `get_transcript`, `list_footage`, `get_profile`, `search_library`), look (`get_frame`, `get_frames`, `get_range_frames`, `get_waveform`, `get_audio_energy`, `get_audio_snippet`), cut (`save_transcript`, `set_aroll_cuts`, `adjust_cut`), place (`add_item`, `update_item`, `move_item`, `remove_item`, `import_file`), graphics (`write_graphic`, `preview_graphic`, `save_to_library`), music, review, progress, thumbnails and output. Every call is validated against the project format, added to undo history and written to the activity log.

## Project file format

A project is a folder. Footage and music stay where they are and are referenced by absolute path; if a file moves, the app asks you to relink it.

| Item | Holds |
| --- | --- |
| `project.json` | Format version, profile, settings, sources, tracks, items, checklist, notes, requests, chat, thumbnails, publishing pack |
| `transcript.json` | Claude's word-timed transcript per source clip |
| `graphics/` | One self-contained Python file per motion graphic |
| `audio/` | Sound effects and audio Claude generated (music, synthesis) |
| `media/` | Other files Claude processed its own way and placed on the timeline |
| `thumbnails/` | Downloaded thumbnail images with their prompts |
| `exports/` | Finished videos, section exports and publishing packs |
| `cache/` | Preview chunks, proxies, waveforms, request attachments. Safe to delete; the app rebuilds it |
| `logs/activity.jsonl` | The activity log for this project, one JSON line per event |
| `backups/` | Automatic copies of `project.json` (before every upgrade, and rotating) |
| `history/` | Undo and redo history, so it survives closing the app |
| `versions/` | Named and automatic versions (project file and graphics only) |

**`project.json`** (schema: `src/shared/project.ts`)

| Field | Meaning |
| --- | --- |
| `formatVersion` | Project format version (currently 2) |
| `id`, `name`, `createdAt`, `updatedAt` | Identity; IDs never change |
| `appVersion`, `engineVersion` | App that last saved it; engine version it renders with |
| `profileId`, `footageFolder`, `status` | Channel profile, source folder, `new` / `editing` / `intro_ready` / `ready_for_review` / `exported` |
| `inspiration`, `scope` | Your direction, Whole video or Just the intro (with optional max length and the approved intro end) |
| `output` | Width, height and frame rate of the edit |
| `settings` | Export preset, mix levels, brand kit, music folders, description template, caption export (copied from the profile at creation) |
| `sources` | Footage, music and other files by absolute path, with probe info |
| `tracks` | Lanes: `aroll`, `broll`, `graphics`, `effects`, `captions`, `music`, `sfx`; more of any kind can be added. Mute, solo, volume (dB) |
| `items` | Everything on the timeline (below) |
| `checklist`, `handoffNotes` | Progress per stage and Claude's notes, used to resume after any interruption |
| `requests`, `chat`, `notes` | The queue for Claude, the chat, and your notes on items or ranges |
| `captions`, `thumbnails`, `publish` | Caption settings, thumbnail options and history, titles/description/chapters/tags |
| `lock` | While Claude re-edits a section, everything outside this range is locked |
| `selfCheck` | Flagged words from Claude's last self-check |

**Items.** Every item has an `id`, a `trackId` and a `type`:

- `segment`: a kept piece of A-roll: `sourceId`, `in`, `out` (source seconds), optional `speed`, `hold` (freeze), volume and fades. Segments play one after another in array order; their total is the video's length.
- `clip` (B-roll, stills, processed files), `graphic` (`file` in `graphics/`, `params`), `effect` (`effect` kind, `params`, or a custom Python `file` with `apply(frame, t, ctx)`), `audio` (music and sound effects, `volume`, fades, `duck`, `loop`). Each has an `anchor` and a `duration`.

**Anchors.** B-roll, graphics, effects and sound effects are anchored to a word: `{"kind": "word", "wordId": "...", "offset": 0.25}`. When cuts change, they move with the word. A word that was cut out follows the nearest kept word after it. Music is usually anchored to the timeline itself: `{"kind": "time", "time": 12.0}`. Anchor resolution lives in `src/shared/timeline.ts`; the engine only ever receives absolute times (`src/shared/plan.ts`).

**`transcript.json`**: `{ "formatVersion": 1, "clips": { "<sourceId>": { "language": "en", "words": [{ "id", "text", "start", "end", "prob?", "emphasis?" }] } } }`. Word IDs never change; captions and anchors refer to them.

**Graphics code contract.** A graphic is a Python file with `render(t, ctx)`:

```python
META = {"description": "Lower third", "inputs": {"text": {"type": "string", "default": "Hello"}}}

def render(t, ctx):
    # t: seconds since the graphic appeared (0 .. ctx.duration)
    # ctx.width, ctx.height, ctx.fps, ctx.duration, ctx.params, ctx.brand, ctx.font(size_px)
    # Return an RGBA PIL Image (or HxWx4 uint8 array) of ctx.width x ctx.height, or None.
    ...
```

Draw every size as a fraction of `ctx.width`/`ctx.height` so the low-resolution preview and the 4K export look the same, and keep it deterministic. Pillow, NumPy, SciPy and OpenCV are available.

**Compatibility rules**

- Each release upgrades every older format one step at a time (`src/shared/migrations.ts`), after saving a copy of the old file in `backups/`. An upgrade never deletes data.
- Fields the app does not recognise are kept as they are when saving (every schema is a loose object).
- A project saved by a newer app opens read-only in an older app, with a message to update.
- Settings, profiles and library assets follow the same versioning and backup rules.

**Adding a migration**

1. Bump `PROJECT_FORMAT_VERSION` in `src/shared/appInfo.ts`.
2. Add a step `N: (doc) => ...` to `PROJECT_STEPS` in `src/shared/migrations.ts` that upgrades format N to N+1 without dropping fields it does not touch.
3. Update the schema in `src/shared/project.ts`.
4. Add a sample project saved by the last released version under `tests/fixtures/projects/`. The upgrade tests open and upgrade every sample, and a release is blocked if any fails.

## Video themes

Settings > Video themes measures the editing style of a YouTube video, a channel's newest three long-form videos, or a video file: cuts per minute (overall, in the first 30 seconds and minute by minute, jump cuts included), shot lengths, speech pace from the captions, loudness, and contact sheets of the shots. The analysis is `engine/analysis/style.py` (measurement only, no Claude usage); yt-dlp is pinned in `engine/runtime.json`, downloaded on first use and updates itself when YouTube changes. Choose a theme on the Start edit panel (or later in Inspiration); Claude reads it with `get_video_theme`, writes a short description of the style once (`save_video_theme_summary`, shown in Settings), and edits to a similar pace and look within the channel's rules and brand kit.

## Shorts

The editor's Shorts tab asks Claude (a `make_shorts` request, Opus by default) for up to 1, 3, 6, 10 or 15 highlight Shorts, plus a 30-second recap for unboxings and reviews. Claude saves each with `save_short`: pieces of the source footage, titles for YouTube Shorts and TikTok, and hashtags. Highlights may share at most 25 % of their footage with each other. The app then finds the subject in each piece (`engine/analysis/reframe.py`: faces first, then motion, smoothed), turns that into a crop that fills the 9:16 frame, renders a preview with the same engine and bold captions, and exports 1080x1920 files to `<exports>/Shorts/` with a text file of titles and hashtags.

## Where data lives

Program files are replaced by updates. Nothing below is.

| Location | Holds |
| --- | --- |
| `%LOCALAPPDATA%\Programs\ai-video-editor\` | The installed program (replaced by each update) |
| `%APPDATA%\AI Video Editor\` | `settings.json`, `profiles\`, `recent.json`, `secrets.json` (encrypted with Windows credential protection), `music-index.json`, `video-themes\` (each theme's measurements and contact sheets), `logs\app.log`, `backups\` |
| `%LOCALAPPDATA%\AI Video Editor\python\` | The managed Python environment |
| `%LOCALAPPDATA%\AI Video Editor\tools\` | Pinned uv, Python and ffmpeg, and yt-dlp once a video theme is made from a YouTube link |
| `%LOCALAPPDATA%\AI Video Editor\engines\<version>\` | Every engine version used, so old projects render the same after updates |
| `%LOCALAPPDATA%\ai-video-editor-updater\` | Downloaded updates waiting to install |
| Your project folders | Everything about each video (see above) |
| Your library folder | Reusable assets, shared and per profile |

The app log is reached from Settings > About > Open app log. The log icon at the top right saves a diagnostics zip (logs, Claude's last output, settings, system info; keys removed) to Downloads. Each project's Export log button saves a text file of everything done on it.

## The October 5 scripts

The rendering code and editing method come from the edit Claude made from a folder on October 5. Those scripts have **not been provided yet**. The music, sound effect and graphics scripts are in the Claude Edit code folder under `Content/P1`; the edit decision list, dialogue assembler, word-boundary checker, mixer and GPU compositor are still needed from that session.

`engine/oct5/README.md` explains how they are added: the scripts are copied in unchanged and wrapped, not rewritten. Until then the engine's own compositor, mixer and graphics runtime do the rendering. The parity check (Claude rebuilds the October 5 video through the app and the owner judges it equal or better) waits on these scripts and on the owner's judgment.

## Privacy

Local first. Footage, renders, projects, transcripts and logs stay on your PC. The app talks to two outside services only:

- **GitHub**, to check for and download updates (no account or token needed).
- **Pikzels**, to generate thumbnails and train personas and styles, with your API key.
- **YouTube**, only when you ask for it: thumbnails for training a persona or style, and a small, temporary copy of a reference video when you make a video theme from a link (downloaded with yt-dlp, measured, then deleted).

Claude Code runs on your PC under your own sign-in and talks to Anthropic as it always does; the app itself makes no AI model calls. API keys and tokens are never written to project files or logs.
