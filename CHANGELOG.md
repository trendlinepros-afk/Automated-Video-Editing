# Changelog

Each release's section becomes its GitHub release text and the notes shown in the app's update dialog.
A release is blocked until the section for its version has notes.

## 1.0.1

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
