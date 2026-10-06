# AI Video Editor: App Spec

Oct 6, 2026 · @Adam

A Windows desktop app where Claude does the edit through MCP and you watch it land on a timeline, fix the few things it gets wrong, export, and get thumbnails. This is the build brief for Claude Code.

## Instructions for Claude Code

This document is the build brief. Build the complete app it describes, in this repository, in one pass.

- Read the whole document before writing any code.
- Before starting, ask for the folder holding the October 5 edit's scripts, and for answers to "Decisions and defaults" near the end. Use the stated default for anything left unanswered.
- Build every feature in this document. No placeholder screens, no stubbed tools, nothing marked "coming soon".
- Follow the order of work in "Build approach and acceptance tests".
- The app contains no editing logic. Do not add silence detection, filler-word removal, automatic cut snapping, transcription of its own, or any call to an AI model API.
- Reuse the October 5 scripts as they are. Wrap them; do not rewrite them.
- Write automated tests for project upgrades, preview and export match, the section re-edit lock, log redaction, and the updater.
- Keep API keys and tokens out of the repository, project files and logs.
- Write a README covering setup, the release process, how Claude connects, and the project file format.
- The build is done when every acceptance check passes, version 1.0.0 is published, and an update to 1.0.1 has been proven. Report any check that needs the owner's judgment as waiting on him, not as passed.

## Summary and principles

The app is a viewer, tweak tool and renderer for edits that an AI makes. Claude makes about 99% of the edit through MCP. You see every decision on a timeline, fix the few that are off, export, and get thumbnails.

**Principles**

- **The AI edits, the app shows.** Claude makes every editing decision, including every cut. The app never detects silence, filler words or cut points itself, and it makes no AI model calls of its own.
- **The project file is the product.** Every cut, graphic, sound and timing lives in one readable JSON file. The app, Claude and you all work from that file.
- **Free-form graphics.** Each motion graphic is its own code file that the project points to. Claude is not limited to a menu of templates.
- **Same engine as the edit that worked.** The rendering code and Claude's editing method come from the folder-based edit Claude did on October 5.
- **Updates never break projects.** Every project file carries a format version, and the app upgrades old projects safely.
- **Local first.** Footage, renders and project data stay on your PC. The only outside services are GitHub for updates and Pikzels for thumbnails.

**Not in version 1**

- Color grading, keyframe editors, effects panels and a multi-track audio mixer.
- Mac or Linux builds. Windows only.
- AI model calls or API keys for language models inside the app.
- Shorts generation and upload to YouTube.

**Stack**

Electron, React and TypeScript, packaged with electron-builder. Rendering uses the October 5 pipeline: a Python compositor running on the NVIDIA graphics card, with ffmpeg for decoding and encoding. Source lives in one GitHub repository, with builds made by GitHub Actions.

**Quality bar: as good as the October 5 edit, or the app is not used**

The app must never produce a worse first pass than Claude editing from a folder. Four requirements enforce that:

- **Same method.** Claude makes every decision the way it did on October 5. The app adds no editing logic of its own that could change the result.
- **Same rendering code.** The scripts from that session are reused as they are, not rewritten.
- **No ceiling.** Anything Claude could do with its own scripts, it can still do. A tool lets it process footage or build an asset its own way and place the finished file on the timeline, so the app's format never limits it.
- **A hard gate.** The build is not done until Claude rebuilds the October 5 video through the app and you judge it equal or better side by side. If it is worse, the cause is fixed before the app is used for real videos.

Until that gate is passed, editing from a folder stays the way to make real videos.

## How the October 5 edit was made

This is the method the app must preserve. It is taken from that session's own account of its work, not from its code, so details marked "likely" need confirming against the scripts.

| Step | What Claude did |
| --- | --- |
| Setup | Ran in Claude Code on the PC. Used ffmpeg 8.1, faster-whisper, PyTorch with CUDA on the RTX 5070 Ti, NumPy, SciPy, Pillow and OpenCV |
| Footage review | Probed every file, looked at frames, and studied the previous export and thumbnail to match the channel's style and its 4K 60 fps output |
| Transcript | Transcribed every clip with faster-whisper on the GPU, with word timings, then split it into phrases at each pause to find retakes |
| Cut decisions | Wrote an edit decision list: every kept phrase with its source times, the best take of each retake, and B-roll cutaways anchored to phrases |
| Cut check | Assembled the dialogue, transcribed it again, and found about 25 clipped or doubled words. Fixed each by reading the audio energy at that spot in 5 ms steps. Automatic snapping had failed on continuous speech |
| Music | Composed in code with its own synthesis engine: one melody reused in several moods. Checked by measurement, since Claude cannot listen |
| Sound effects | Synthesized in code and placed from a shared event map tied to the dialogue, so timing holds when cuts change |
| Mix | Voice clean-up, a limiter for mic handling noise, music lowered about 15 dB under speech, and a final level of -14 LUFS for YouTube |
| Graphics | Drawn by a Python script in the style of the channel's thumbnail, likely with Pillow, and reviewed as a gallery before use |
| Effects | Color grade, snow, light leaks, a VHS look, shake, flashes, a freeze frame and a slow-motion replay |
| Render | A custom GPU compositor decoded the 1080p footage, upscaled to 4K, applied effects and graphics, and encoded with the NVIDIA encoder at 31 to 38 frames a second. About 23 minutes for a 12-minute video |
| Checks | About 60 preview stills at key moments, a 25-second motion test, then loudness and frame checks on the finished file |
| Delivered | A 4K 60 fps MP4, separate music, sound effect and mix files, chapter timestamps, and a folder of scripts |

**What this changes in the app**

- **Graphics and effects are Python, not web code.** The preview cannot play them live in a browser. The preview is a low-resolution render from the same compositor, made in short chunks, with only changed chunks re-rendered.
- **An NVIDIA graphics card is required.** The app checks for one at startup and says so plainly if it is missing.
- **The app manages its own Python environment.** On first launch it installs a pinned set: Python, PyTorch with CUDA, faster-whisper, and ffmpeg with the NVIDIA encoder. This is installed once and is not re-downloaded by app updates.
- **The engine is versioned.** Each project records the engine version it was made with. The app keeps earlier engine versions, so an old project renders the same after any update.
- **An Effects lane.** Full-frame effects, freeze frames and speed changes are items on the timeline that can be moved, shortened or deleted like any other.
- **Music is composed by default.** Claude writes the score in code, as it did on October 5. It can use a track from your music folders when that fits better or when you ask.
- **Reuse starts with the first edit.** The synthesis engine, the sound effect set and the graphic styles from October 5 go into the asset library, so later videos build on them.
- **Mix levels are settings.** How far music sits under the voice is a control per profile. Changing it re-runs the mix script on your PC and uses no Claude usage.
- **Claude cannot hear the result.** The app reminds you to listen through once before export.

## Architecture

&#91;embedded content: architecture · the app, three inputs, three outside pieces\]

Claude works by calling tools on the app's MCP server, the app writes each change to the project folder, and the timeline and renderer both read from that folder. GitHub and Pikzels are the only outside services.

## Updates

The updater is the first thing built inside the single build, and it must work in the very first release. Version 1.0.0 ships with it, and version 1.0.1 is published straight after to prove the update path end to end.

**The button**

Check for updates sits in the top bar on every screen, next to the current version number.

1. Click it. The button shows "Checking".
2. If nothing is new, it shows "Up to date" with the version number.
3. If a new version exists, the download starts and the button shows progress as a percentage.
4. When the download finishes, a dialog shows the new version, its release notes, and two choices: **Restart now** or **Later**.
5. Restart now saves all open projects, installs, relaunches, and reopens the project you were in.
6. Later installs the update the next time you close the app. Until then the button reads "Restart to update".

**Rules**

- The app also checks quietly at launch. It only shows a small dot on the button, and it downloads nothing until you click.
- Restart now is blocked while a render or export is running. The dialog says so and offers Later.
- No connection, a failed download, or a bad file gives a plain message and a Retry button. The app never ends up half-installed.
- An update replaces program files only. Settings, profiles and projects are stored elsewhere and are never touched by the installer.
- Every update event is written to the app log: check, version found, download, install, failure.

**How it works**

- electron-updater reads releases from GitHub Releases. The installer is a per-user Windows installer, so no admin prompt is needed.
- Releasing is one step: push a version tag such as `v0.2.0`. GitHub Actions builds the installer and publishes it with the update manifest.
- Release notes come from the GitHub release text and appear in the update dialog.
- Old releases stay on GitHub, so rolling back means installing an older installer.

**Repository visibility**

electron-updater can read a public repository with no setup. For a private repository, [electron-builder's docs](https://www.electron.build/docs/publish) say the updater needs a GitHub token on the machine. Two workable setups:

| Setup | How updates are read | Trade-off |
| --- | --- | --- |
| Private code, public releases repository (recommended) | A second, public repository holds only the installers | Anyone with the link can download the app, but not the code |
| Fully private | A read-only GitHub token saved in the app's settings on your PC | Nothing is public, but the token must be created and renewed |

**Proof at first release**

- Install 1.0.0, release 1.0.1, click the button, choose Restart now. The app comes back showing 1.0.1.
- Repeat with Later. Closing and reopening the app shows the new version.
- Unplug the network and click the button. The message is clear and the app keeps working.
- A project created in 1.0.0 opens unchanged in 1.0.1.

## Project files and compatibility

A project is a folder with one `project.json` at its center, and no update may leave an existing project unopenable. The rules below enforce that.

**Project folder**

| Item | Holds |
| --- | --- |
| `project.json` | Format version, profile, tracks, items, transcript reference, progress checklist, notes |
| `graphics/` | One self-contained code file per motion graphic |
| `audio/` | Sound effects and any audio Claude generated |
| `thumbnails/` | Downloaded thumbnail options with their prompts |
| `exports/` | Finished videos and section exports |
| `cache/` | Preview proxies, waveforms, transcript. Safe to delete; the app rebuilds it |
| `logs/` | The activity log for this project |
| `backups/` | Automatic copies of `project.json` |

Source footage and music stay where they are and are referenced by path. If a file has moved, the app asks you to relink it.

**Compatibility rules**

- `project.json` carries a format version number. Each app release knows how to upgrade every older format, one step at a time.
- Before upgrading a project, the app saves a copy of the old file in `backups/`. An upgrade never deletes data.
- Fields the app does not recognize are kept as they are when saving. A newer AI or a newer app can add data without an older app erasing it.
- A project saved by a newer app opens read-only in an older app, with a message to update.
- The repository keeps a sample project from every released version. Automated tests open and upgrade each one, and a release is blocked if any of them fails.
- Settings and profiles follow the same versioning and backup rules.

**Timeline model**

- Seven tracks: A-roll, B-roll, Graphics, Effects, Captions, Music, Sound effects. More tracks of any kind can be added.
- Each item has a track, a source file, a start, a length, a volume where relevant, and an ID that never changes.
- B-roll, graphics and sound effects are anchored to a word in the A-roll transcript plus an offset, not to a fixed time. When a cut changes, they move with the words they belong to.
- Music is anchored to the timeline itself and can be set to duck under speech.

**Saving and resuming**

- Every change, from Claude or from you, is saved to disk at once. There is no save button.
- The project keeps a progress checklist of the edit's stages, such as transcript, cuts, B-roll, graphics, audio, self-check and thumbnails, each marked not started, in progress or done.
- Claude writes short handoff notes into the project as it works: what it decided and what is left.
- If Claude stops mid-edit for any reason, including a usage limit, a new session reads the checklist and notes and continues from the next step. Finished work is never redone. At most the one step in flight is repeated.
- Undo and redo cover both your tweaks and Claude's changes, and the history survives closing the app.

## Home, profiles and settings

The app opens on a home page of recent projects, and each project belongs to a channel profile that sets its defaults.

**Home page**

- Recent projects as cards: a frame from the video, project name, profile, last opened, and edit status such as "Editing", "Ready for review" or "Exported".
- New project: pick a profile, pick the footage folder, name it. The app creates the project folder and opens the Start edit panel.
- Open project from disk, for projects not in the recent list.
- Search and a profile filter once the list grows.
- A missing project folder shows as "Not found" with Locate and Remove from list.

**Profiles**

One profile per channel, for example the RC car channel and the finance channel. A profile holds:

| Setting | Used for |
| --- | --- |
| Name and color | Shown on project cards and in the editor's top bar |
| Default Pikzels persona and style | Applied to thumbnails unless you change them in the project |
| Thumbnail count | 1, 2 or 3 options per video |
| Thumbnail direction | Standing notes for thumbnail prompts, such as "big bold text, shocked face" |
| Music folders | Which master folders Claude may use for this channel |
| Channel notes for the AI | Tone, pacing, things to always or never do. Claude reads these through MCP |
| Export preset | Resolution, frame rate and quality |

A new project copies its profile's defaults. Changing the project later does not change the profile, and editing a profile does not alter existing projects.

**Music folders**

- In Settings, add one or more master folders where your music is stored.
- The app indexes them, including subfolders: file name, folder, length and format. It reads the files and never moves or changes them.
- Each profile chooses which master folders apply to it.
- Claude can list and search this library through MCP and place any track on the Music track. Subfolder names such as "upbeat" or "chill" are passed along, so organizing by mood helps it choose.
- A Rescan button picks up new files. Missing files are flagged, not silently dropped.

**Settings**

- Pikzels API key, stored with Windows credential protection. It is never written to project files or logs.
- Default folders for new projects and exports.
- Claude connection: status, the command used to start Claude, and a Copy setup button for connecting by hand.
- About: version, Check for updates, Open app log.

## Editor screen

One window with four areas: a top bar, the preview, a side panel, and the timeline. Everything Claude does appears here as it happens.

**Layout**

| Area | Contents |
| --- | --- |
| Top bar | Back to home, project name, profile chip, Claude connection status, progress checklist, then on the right: Export, Export log, Check for updates |
| Preview, center | The rendered preview with every graphic and effect in place. Play, pause, scrub, frame step, full screen |
| Side panel, right | Tabs: Chat, Inspector for the selected item, Transcript, Thumbnails, Publish, Versions, Notes for Claude |
| Timeline, bottom | One lane per track, a time ruler, zoom, and a playhead |

**Timeline**

- Lanes for A-roll, B-roll, Graphics, Music and Sound effects, each with its own color, plus mute, solo and volume per track.
- Audio items show waveforms. Cuts in the A-roll show as visible seams.
- Items Claude just added or changed pulse briefly, so you can watch the edit being built.
- Clicking a word in the Transcript tab jumps the playhead there, and the current word highlights during playback.

**Tweaks you can make**

- Nudge or drag either edge of a cut. Audio at the seam plays on loop while you adjust, so a clipped word is fixed by ear.
- Move an item along its lane, change its length, or delete it.
- For a graphic: move, scale, change how long it shows, or delete it.
- For music and sound effects: swap the file, change volume, set fades.
- Undo and redo for everything.
- Leave a note for Claude on any item or time range, such as "make this one funnier". Claude reads open notes through MCP, makes the change, and marks the note done.

**Re-edit a section**

1. Drag across the time ruler to select a range. The same selection is used for section export.
2. Click Re-edit section. A box lets you type direction, such as "tighter, and add a graphic for the price". Direction is optional.
3. The request goes to Claude through MCP. If Claude is not connected, it waits in a queue.
4. Claude re-edits only that range. The app rejects any change outside it, so the rest of the video cannot be touched.
5. If the section gets shorter or longer, everything after it shifts to stay in sync.
6. When Claude finishes, the section shows a Before and After toggle with Keep and Revert.

**Fix clipped audio**

1. Right-click any audio on the timeline, or the seam of a cut, and choose Fix clipped audio.
2. The app sends Claude a request scoped to that one spot, with the few seconds of source audio on both sides of the cut.
3. Claude restores the missing part of the word and adjusts the cut. Anything anchored after it shifts to stay in sync.
4. The fix plays back at once, with Undo if it is not right.
5. If Claude is not connected, the request waits in the queue. You can also drag the cut edge yourself.

The app does not try to find the word boundary on its own. Claude makes the fix, which uses a small amount of Claude usage per click.

**Preview**

- The preview is a low-resolution render made by the same compositor that makes the final export, so the two cannot differ.
- The video is rendered in short chunks, and only the chunks a change touches are rendered again. A change shows in the preview within a few seconds.
- The preview and the final export must match. This is tested on a short clip and on the October 5 video.

**Look and feel**

- Dark, quiet interface with one accent color. The video is the brightest thing on screen.
- Few controls visible at once. Options for an item appear only when it is selected.
- Every destructive action can be undone, so there are no "are you sure" dialogs.
- Empty states tell you what to do next, such as "Waiting for Claude to connect" with setup steps.
- Standard keys: Space to play, J K L to shuttle, arrow keys to nudge, Delete to remove, Ctrl+Z and Ctrl+Y.

## Starting an edit and talking to Claude

The app starts Claude for you. Pressing Start edit, sending a chat message, or clicking a fix launches a Claude session in the background, already connected to the project.

**Start edit**

Every new project opens on a Start edit panel with three things:

- **Inspiration.** An optional text box for your vision: tone, pacing, jokes, moments to feature, videos to take after. Leave it empty and Claude does its best from the footage, the channel's rules and the brand kit.
- **Scope.** Whole video, or Just the intro.
- **Start edit.** Nothing else is required.

The inspiration text is saved in the project. You can edit it later and ask for a re-edit that follows the new version.

**Just the intro**

- Claude edits only the opening of the video. Intro length is Auto, where Claude judges where the intro ends, or a maximum you set in seconds.
- The intro gets the full treatment: cuts, B-roll, graphics, music, sound effects and captions.
- Claude still reads the whole video first, so the intro reflects what the video is about.
- When it is done you preview it and choose: Continue with the rest, Redo the intro with new direction, or stop there.
- Continue keeps the approved intro exactly as it is and edits on from its last frame.

**Chat**

- A Chat tab in the side panel takes requests in plain words, such as: "At 2:10 to 2:45, add an animation of a LiPo battery on fire where I am pointing."
- Times typed in a message are recognized and shown as a highlighted range on the timeline. The playhead position and any selected item are attached too, so "here" and "this" work.
- Claude looks at the frames in that range to find what you mean, such as where you are pointing, and makes the change inside that range only.
- Claude replies in the chat with what it did, or asks a question if the request is unclear.
- Every chat change has Before and After with Keep and Revert, like a section re-edit.
- Windows voice typing works in the chat box, so requests can be spoken.
- If the thing you point at moves during the range, Claude positions the animation at several points along the way. You can drag it to correct the placement.

**How the app starts Claude**

- The app runs Claude Code in the background, using its non-interactive mode, with the project's MCP connection and your request. See the [Claude Code docs](https://code.claude.com/docs/en/headless).
- It uses the Claude Code sign-in already on your PC. The app holds no Claude API key and makes no model calls itself.
- Claude's progress shows live in the top bar and the chat, with a Stop button.
- Follow-up requests continue the same Claude session where possible, so it keeps its context. Otherwise a new session starts from the checklist and handoff notes.
- If Claude cannot start, for example at a usage limit or when signed out, the request stays in a queue with the reason shown. Resume runs the queue.
- The command the app runs is a setting. Claude Code is the default, and another AI tool that has a command line and supports MCP can replace it.
- You can still connect Claude by hand from Claude Code or the desktop app. It picks up any queued requests.

## Claude connection

The app runs a local MCP server that only programs on your PC can reach. Claude connects to it, reads the project, and makes every edit through the tools below.

**How a session runs**

1. You create a project and point it at a footage folder. You may write your inspiration, then choose Whole video or Just the intro and press Start edit.
2. The app builds preview proxies and starts Claude with the project connected. It does no transcription or cutting of its own.
3. Claude reads your inspiration, the profile's channel notes, rules and brand kit, and the footage list. It transcribes the footage its own way, saves the transcript, and writes its plan into the progress checklist.
4. Claude searches the asset library, then builds the edit. Each change appears on the timeline as it is made.
5. Claude runs the self-check, marks the project "Ready for review", and produces thumbnails and the publishing pack.
6. You review, tweak, chat, request section re-edits, then export.

**Tools the app exposes**

| Group | Tools | Purpose |
| --- | --- | --- |
| Read | Get project, get inspiration and edit scope, get transcript, list footage, get profile notes, rules and brand kit, search the asset library | Understand the project and the channel |
| Look | Get frame at a time, get waveform for a range, play back a range as frames | Let Claude see and check its own work |
| Cut | Save transcript, set A-roll cuts, adjust one cut | Remove dead space and mistakes |
| Place | Add, update, move or remove an item on any track | B-roll, graphics, music, sound effects |
| Graphics | Write or replace a graphic's code file, preview it as frames, save it to the asset library | Free-form motion graphics |
| Music | List and search the music library | Choose tracks from your folders |
| Review | Get chat messages, open notes, section re-edit requests and clipped-audio fix requests, reply in chat, mark one done | Act on what you asked for |
| Progress | Get and update the checklist, write handoff notes, set project status | Resume after any interruption |
| Thumbnails | Request 1 to 3 thumbnails with prompts | Covered in the Thumbnails section |
| Output | Run self-check, start an export | Finish the job |

Every tool call is checked against the project format before it is applied, added to undo history, and written to the activity log.

**Editing rules Claude follows**

- The app hands these rules to Claude at the start of every session. Claude applies them. The app does not.
- Write an edit decision list of kept phrases with their source times. Anchor B-roll, graphics, music cues and sound effects to those phrases.
- After assembling the dialogue, transcribe it again and compare it with the intended words.
- Fix every flagged boundary by reading the audio at that spot in 5 ms steps. Do not rely on automatic snapping, which failed on continuous speech on October 5.
- Treat a doubled word at a boundary as a possible checker error. Confirm it on an isolated snippet before changing the cut, and allow for small drift in transcript timings.
- Before the full render, check stills at key moments for graphic placement and render a short motion test.
- After export, measure loudness and check frames from the finished file.
- The app carries out every cut exactly as Claude gives it and adjusts nothing on its own.
- The rules can be edited per profile, and learned corrections are added to them.

**Scoped re-edits**

A section re-edit request carries the time range and your direction. While Claude works on it, the app locks every item outside the range and refuses changes to them. The state before the re-edit is kept so Revert is instant.

**Stopping and resuming**

If Claude hits a usage limit or the session ends, the project stays exactly as it was at the last change. A new session reads the checklist and handoff notes and continues from the next unfinished stage. The app shows "Claude disconnected, edit paused at: Graphics" so you know where it stopped.

**Other AI tools**

MCP is an open standard, so any AI client that supports it can use the same tools. Because the project is a plain JSON file with a published format, an AI that can only edit files can also work on it directly.

## Export and logs

Export renders the whole timeline or a selected section, and Export log saves a text file of everything the app did on the open project.

**Export**

- Export in the top bar offers Whole video or Selected section. Selected section is available whenever a range is selected on the time ruler.
- A section export includes every track in that range: footage, B-roll, graphics, music and sound effects, with clean audio fades at both ends.
- Presets come from the profile, such as 1080p or 4K MP4. A quick low-resolution option exists for fast checks.
- Files go to the project's `exports/` folder, named with the project, the range and the time, and a link opens the folder when done.
- Progress shows in the top bar and you can keep reviewing while it renders. Cancel stops cleanly.
- Rendering happens on your PC with the GPU compositor and ffmpeg. It uses no AI credits.

**Export log**

The Export log button sits at the top right of the editor. One click saves a `.txt` file and opens its folder, ready to hand to Claude.

The file starts with a header: app version, project format version, Windows version, profile, and project name. Then one timestamped line per event, oldest first:

| Logged | Detail |
| --- | --- |
| Every MCP tool call | Tool, a summary of what was sent, the result, and how long it took |
| Every manual tweak | What you changed, before and after |
| Chat requests, section re-edits and notes | The range, your direction, and what changed |
| Renders and exports | Settings, the ffmpeg command, duration, and the error output if it failed |
| Self-check results | Each flagged word and its position |
| Thumbnail requests | Prompt, persona and style, Pikzels request ID, and any error code |
| Project upgrades | Old and new format version, and the backup file made |
| Update events | Checks, downloads, installs, failures |
| Errors and crashes | The message and technical trace |

**Log rules**

- The log is written continuously to the project's `logs/` folder, so it survives a crash.
- API keys and tokens never appear in it.
- The export covers the open project. A separate app-level log, reached from Settings, covers startup and update problems when no project is open.
- A filter on the export dialog offers Everything or Last session, to keep the file small when the problem is recent.

## Thumbnails

When an edit is done, the app generates 1, 2 or 3 thumbnail options through the Pikzels API, using the persona and style set for the project. Pikzels calls a theme a "style", so this spec uses that word.

**Flow**

1. Claude marks the edit ready and calls the thumbnail tool with one prompt per option, written from the video's transcript and content. It may attach a frame from the video as a reference image.
2. The app adds the project's persona and style and sends one request per option.
3. Each finished image is downloaded straight into the project's `thumbnails/` folder with its prompt.
4. The Thumbnails tab shows the options side by side. Pick one, regenerate any, or export the image.

**Your controls**

- **Persona and style pickers** in the Thumbnails tab, available at any point in the edit. They start at the profile's defaults and apply to this project only.
- **Prompt field.** Type how you want the thumbnail to look and click Generate. Your text is used as the prompt directly, so this works even with Claude disconnected.
- **Use my direction.** A toggle that passes your prompt text to Claude as guidance, so its next prompts follow it.
- **Count.** 1, 2 or 3 options, defaulting to the profile's setting.
- **History.** Every generated image is kept with its prompt, so nothing good is lost on regenerate.

**Personas and styles**

- A Personas and Styles screen in Settings lists what exists, with status and a sample image.
- Create a persona from a name and three face photos. Create a style from a name and three reference thumbnails. Names are limited to 25 characters.
- Training runs in the background at Pikzels. The app shows progress and marks it ready when complete.
- Each one can carry special instructions, editable in the app.
- The Pikzels docs say only personas and styles created through the API can be used in API requests. Ones made on the Pikzels website will need to be created again in the app.

**What the API allows** (from the [Pikzels API docs](https://docs.pikzels.com/thumbnails/create-from-text.md))

| Fact | Effect on the app |
| --- | --- |
| One image per request | Three options means three requests, run a few at a time |
| Image links expire after 24 hours | The app downloads each image as soon as it is made |
| Personas and styles work only on the two newest models | The app always uses one of those |
| Prompts over 750 characters may be shortened, and prompts cannot contain links | The app warns past 750 characters and strips links |
| Formats are 16:9, 9:16 and 1:1 | 16:9 by default, 9:16 available for Shorts |
| Busy responses ask the client to wait and retry | The app retries with increasing delays |

**Errors and cost**

- Failures show in plain words, such as "Out of Pikzels credits" or "Persona still training", with the request ID logged for support.
- A request that fails is never retried more than three times.
- Thumbnail generation uses Pikzels API credits, not Claude usage.

**Later, not version 1**

Pikzels also offers editing an existing thumbnail, scoring a thumbnail, and title suggestions. Each would fit in the Thumbnails tab once the basics work.

## Asset library

Graphics, animations and sounds that Claude makes can be saved to a folder you choose and reused, so the same asset is never generated twice.

**Where it lives**

- You pick the library folder in Settings. It can be on any drive, including a synced or backed-up one.
- Inside it, one shared section for assets every channel can use, and one section per profile.
- Assets are plain files: the code or audio file, a small description file, and a preview image. Nothing is locked inside the app.

**Saving**

- Right-click any graphic or sound on the timeline and choose Save to library. Give it a name and tags.
- Claude can save an asset itself when it builds something reusable, such as a like and subscribe animation, a lower third or a transition.
- Each asset records what it is, when to use it, its tags, which profile it belongs to, and how often it has been used.

**Reuse**

- Before Claude creates a graphic or sound, the rules tell it to search the library first. The app gives it the matching assets with their descriptions and previews.
- Assets take inputs, such as text, colors, length and position. One lower third works for any name without being rebuilt.
- If nothing fits, Claude makes a new one and offers to save it.
- Placing a library asset copies it into the project, so changing or deleting a library asset later never alters a finished project.

**Managing**

- A Library screen shows every asset with its preview, tags and use count. Filter by profile or type.
- Rename, retag, duplicate, move between shared and a profile, or delete.
- Mark an asset as preferred, and Claude uses it first for that purpose on that channel.
- Library assets carry a format version and follow the same upgrade and backup rules as projects.

## Channel memory and brand kit

Each profile remembers how you like that channel edited and what it looks like, so Claude starts every video already knowing both.

**Learned corrections**

- The app watches for repeated tweaks on a channel, such as lowering music under speech, shortening how long graphics stay up, or deleting the same kind of sound effect.
- After the same kind of change on a few videos, it suggests a rule in plain words: "Keep music quieter under speech on this channel?"
- Nothing becomes a rule without your yes. You can also write a rule yourself at any time.
- Notes you leave for Claude can be saved as a rule with one click.
- Rules live in the profile as readable text. Edit, switch off or delete any of them.
- Claude receives the profile's rules at the start of every edit, along with the standard editing rules.
- The app only records and suggests. It never applies a correction to the video itself.

**Brand kit**

| Item | Used for |
| --- | --- |
| Fonts | Titles, lower thirds and captions. Load your own font files |
| Colors | A primary, a secondary and an accent, applied to graphics and captions |
| Logo and watermark | Placement and size, if you want one on screen |
| Intro and outro | Clips or library assets added at the start and end |
| Caption style | Font, size, position, highlight color |
| Sound signature | A preferred whoosh, pop or sting from the library |

Claude reads the brand kit before making any graphic, and library assets take their fonts and colors from it. The same asset then looks right on the RC channel and on the finance channel.

## Captions and publishing pack

Both come from work Claude has already done on the video, so they add little extra usage.

**Captions**

- Captions are built from the transcript Claude saved, and appear in their own lane on the timeline.
- They are tied to the words, so they stay in sync through cuts, section re-edits and clipped-audio fixes.
- Fix a misheard word by typing over it in the Transcript tab. The caption updates at once.
- Style comes from the profile's brand kit: font, size, position and highlight color.
- At export, choose burned into the video, a separate subtitle file for YouTube, or both. A profile can set its default.
- Claude can mark words for emphasis, and you can add or remove emphasis by clicking a word.

**Publishing pack**

- When the edit is ready, Claude writes title options, a description, chapter timestamps and tags, and saves them to the project.
- A Publish tab shows them with a Copy button on each, next to the chosen thumbnail.
- Chapters are tied to moments in the video, not fixed times. If the edit changes afterward, the timestamps update on their own.
- Each profile holds a description template with your standing links and any disclaimer, such as the one for the finance channel.
- Regenerate any part with your own direction, the same way as thumbnails.
- Export pack saves the video, thumbnail, subtitle file and a text file of the title, description and chapters into one folder.

## Named versions

A version is a saved snapshot of the whole edit that you can return to at any time.

- Save version in the Versions tab stores the current state under a name you give it, such as "before music change".
- The app also saves one automatically at key moments: when Claude marks the edit ready, before every section re-edit, before every export, and before a project upgrade.
- Restoring a version first saves the current state as its own version, so a restore can always be reversed.
- Compare shows two versions side by side at the same moment in the video.
- A version stores the project file and graphic files only, not footage, so each one is small.
- Automatic versions are trimmed to the most recent 20. Named versions are kept until you delete them.

## Build approach and acceptance tests

Eight stages, each a working release delivered through the update button. No stage starts until the one before it passes its test.

**Order of work inside the single build**

1. Repository, automated builds, installer and the updater. Publish a test release early and prove an update, because every later fix arrives through it.
2. Project format with versioning, backups and upgrade tests.
3. The rendering code from the October 5 edit, the managed Python environment, timeline and chunked preview.
4. MCP server and tools, the runner that starts Claude, Start edit with inspiration and intro-only scope, and chat.
5. Manual tweaks, Fix clipped audio, section re-edit, named versions, export and Export log.
6. Asset library, brand kit and learned corrections.
7. Thumbnails, publishing pack and captions.
8. Run every acceptance check, fix what fails, publish 1.0.0, then publish 1.0.1 to prove the update path.

**Acceptance checks**

| Check | Passes when |
| --- | --- |
| Update | 1.0.0 updates itself to 1.0.1 by both Restart now and Later, and a project made before the update opens unchanged |
| Parity | Claude rebuilds the October 5 video through the app, and the owner judges it equal or better side by side with no clipped words |
| Preview match | A 30-second test clip looks the same in the preview and in its export |
| Inspiration | An edit started with inspiration text reflects it, and an edit started with the box empty runs without asking for it |
| Intro only | Just the intro produces a finished intro and leaves the rest untouched. Continue keeps that intro unchanged |
| Chat | A typed request with a time range changes only that range, and Claude replies with what it did |
| Fix clipped audio | One right-click repairs a clipped word |
| Section re-edit | Nothing outside the range changes, and Revert restores the section |
| Resume | A session stopped mid-edit resumes without redoing finished work |
| Asset reuse | A second video on the same channel reuses a saved like and subscribe asset without regenerating it, and follows a rule learned on the first |
| Thumbnails and pack | A finished edit produces three thumbnail options with the right persona and style, plus titles, description and chapters |
| Captions | Captions stay in sync after a section re-edit and match the brand kit |
| Log | Export log shows every step of the session, and no API key appears in any log file |

**Tests that run on every release**

- Every sample project from earlier versions opens and upgrades without loss.
- The preview and export match on the test clip.
- The updater installs the new build over the previous one.
- Section re-edit cannot change items outside its range.
- No API key appears in any log file.

## Decisions and defaults

- [ ] **The October 5 scripts.** The music, sound effect and graphics scripts are saved in the Claude Edit code folder under Content/P1. Still needed from that session: the edit decision list, the dialogue assembler, the word-boundary checker, the mixer and the GPU compositor. There is no default. Without them those parts must be rebuilt and parity is at risk.
- [ ] **Repository setup.** Default: private code with a public releases repository.
- [ ] **Code signing.** Default: unsigned. Windows shows a SmartScreen warning on first install.
- [ ] **App name.** Default: the placeholder "AI Video Editor", set in one place so it is easy to change.
- [ ] **Runner.** Default: Claude Code, signed in on the same PC as the footage.
- [ ] **Transcript.** Settled. Claude runs faster-whisper on the graphics card, as it did on October 5, which gives the word timings that anchoring and captions need.
- [ ] **Pikzels.** Default: the newest model. Confirm API access is enabled on the account.
- [ ] **Intro length.** Default: Auto.
- [ ] **Asset library folder.** Chosen on first launch.

## Sources

- [Pikzels API: quickstart](https://docs.pikzels.com/quickstart)
- [Pikzels API: create thumbnail from text](https://docs.pikzels.com/thumbnails/create-from-text.md)
- [Pikzels API: create persona](https://docs.pikzels.com/pikzonalities/create-persona.md)
- [Pikzels API: create style](https://docs.pikzels.com/pikzonalities/create-style.md)
- [Pikzels API: get persona or style](https://docs.pikzels.com/pikzonalities/get-pikzonality.md)
- [Pikzels API: rate limits](https://docs.pikzels.com/rate-limits.md)
- [electron-builder: publish and auto-update](https://www.electron.build/docs/publish)

* [Claude Code: run Claude Code programmatically](https://code.claude.com/docs/en/headless)
