# Changelog

Each release's section becomes its GitHub release text and the notes shown in the app's update dialog.
A release is blocked until the section for its version has notes.

## 1.1.0

- **Estimated cost so far.** The editor's top bar shows what this project has cost next to Export: Claude runs (as Claude Code reports them, at API prices) plus Pikzels thumbnails. Click it for the breakdown by part of the edit and by model. It flashes each time a run adds to it, so iterations are easy to follow.
- **Estimates before you run.** Start edit, chat, Re-edit section and Fix clipped audio show what they are likely to cost. The first numbers are rough guesses; they become your own measured averages as you edit.
- **Claude models (Settings).** Each part of an edit now runs on its own model: transcribing, cutting, B-roll, graphics, music and sound, captions, self-check, thumbnails, publishing pack, plus chat, re-edits and Fix clipped audio. The recommended set keeps Opus 5.5 where judgment decides quality and uses Sonnet 5.5 or Haiku 4.5 for well-specified work, about a quarter cheaper with no noticeable quality drop. Reset to recommended at any time.
- **Fewer tokens for the same work.** Claude now hands the app the transcript file faster-whisper wrote instead of typing every word, and the cutting stage writes a plan the later stages follow.
- Popovers under the top bar (progress, cost, update errors) are no longer cut off.

## 1.0.2

- **Creating a persona or style no longer fails with "The request is invalid".** Thumbnails picked from YouTube are sent to Pikzels as links, and image files as image data; if Pikzels rejects one form, the next is tried. A rejected request costs nothing.
- When Pikzels rejects a request, the message now says what Pikzels said, and the app log keeps Pikzels' full answer so any remaining problem can be pinned down.

## 1.0.1

- **Personas and styles from YouTube.** Paste a channel, video or playlist link (or several) in Personas & Styles, click Show thumbnails, and pick the three to train from. No more downloading and uploading thumbnails by hand. Works for both personas and styles.
- A failed update check now says "Update check failed" next to Retry; click it to read the whole message instead of a cut-off line.
- Choosing the asset library folder during first-launch setup now creates it straight away and fills it with the starter assets (like and subscribe, lower third, title card, callouts, sound effects and the music engine), so setup shows it as ready.
- This release also proves the update path: 1.0.0 updates itself to 1.0.1 from the Check for updates button.

## 1.0.0

The first release of AI Video Editor: Claude edits your video through MCP, and you watch the edit land on a timeline, fix what is off, export, and get thumbnails.

- **Updates.** Check for updates in the top bar on every screen. New versions download with a progress percentage and install with Restart now (reopens your project) or Later (installs when you close the app). A quiet check at launch shows a dot and downloads nothing until you click.
- **Projects.** One readable `project.json` per video with a format version, automatic backups, safe upgrades of older projects, and unknown fields kept as they are. Every change saves at once, and undo and redo survive closing the app.
- **Home and profiles.** Recent projects with status, search and profile filter. One profile per channel with thumbnail defaults, music folders, channel notes, editing rules, brand kit, mix levels and export preset.
- **Claude connection.** A local MCP server with tools to read the project, look at frames and audio, set and adjust cuts, place items on any track, write Python graphics, use the music and asset libraries, track progress and export. The app starts Claude Code in the background for Start edit, chat and fixes, queues requests when Claude cannot run, and resumes from the checklist and handoff notes.
- **Editor.** Live timeline with A-roll, B-roll, Graphics, Effects, Captions, Music and Sound effects lanes; nudge cut edges with looping seam audio; move, trim, swap and delete items; notes for Claude; section re-edit with a lock outside the range and Before/After with Keep and Revert; one-click Fix clipped audio.
- **Rendering.** The GPU compositor renders a chunked low-resolution preview and the final export from the same plan, so they match. Whole video, selected section or quick export; cancel at any time.
- **Assets and channel memory.** An asset library on any folder with shared and per-channel sections, inputs, previews and use counts. Learned corrections suggest channel rules, and nothing becomes a rule without your yes.
- **Thumbnails (Pikzels).** Generate 1 to 3 options on PKZ-4.5, 4, 3 or 2 with your persona and theme; recreate from an image, a video frame or a YouTube link; edit with a painted mask; face swap; score; title suggestions. Create, rename, retrain and delete personas and themes. Every action shows its cost, and spend is tracked per project and in total (prices editable in Settings). Your Pikzels key is kept with Windows credential protection and is never touched by updates.
- **Captions and publishing.** word-tied captions in the brand kit style (burned in, subtitle file or both), and a publishing pack of titles, description, chapters and tags.
- **Named versions** with automatic snapshots at key moments, restore and compare.
- **Logs.** A continuous per-project activity log and an app log, exported as text with every step and no API keys or tokens.
