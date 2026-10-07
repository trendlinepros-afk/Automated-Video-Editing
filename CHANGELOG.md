# Changelog

Each release's section becomes its GitHub release text and the notes shown in the app's update dialog.
A release is blocked until the section for its version has notes.

## 1.9.1

- **"Write it for me" is fast now** (usually well under a minute instead of sitting in Claude's queue). The app gathers up to 8 candidate frames from your footage into one sheet and Claude answers in a single quick call, without loading the whole editing session. It works even while no edit is running.
- If Pikzels rejects the base picture, the app tries it in another format, then makes the thumbnail from the description alone and says so, instead of failing.
- When Pikzels rejects a request, the message now includes its own words about what was wrong (for example which field).

## 1.9.0

- **Grab screenshot** in the Thumbnails tab: takes the frame at the playhead straight from the footage at full quality (captions, graphics and effects are left out), sized for the thumbnail (1280x720 for YouTube). It becomes the base picture: Pikzels builds every new thumbnail around it with your persona and style.
- **Claude writes the thumbnail description for you.** When an edit is finished, Claude picks the moment that shows what the video is about best, makes it the base picture, and writes a description in the prompt box that fits your persona, style and the video's story. Change it or delete it and write your own; a picture you grabbed yourself is never replaced. "Write it for me" asks again any time.
- Recreate from a video frame, and frames Claude attaches to thumbnail prompts, are now clean footage too.

## 1.8.1

- Fixed: opening a project that already had an edit could leave the preview on "Building the preview…" forever. Opening a project now always starts its preview.

## 1.8.0

- **The preview is ready much sooner.** It used to start over every time Claude changed something, so nothing finished while Claude worked and the whole video rendered at the end. Now a render runs to the end, and only what changed renders after it.
- The first time a preview renders, the start of the video plays as soon as about 8 seconds are ready, with sound, while the rest finishes behind it.
- **Captions at key moments.** New projects no longer caption every word. Claude captions the hook (about the first 3-6 seconds), then only where captions pull attention back: a key number or price, a punchline, the payoff, hard-to-hear speech. That is usually 10-25 % of the video.
- The CC button on the Captions track now chooses: At key moments, On every word, or Off. Projects made before this update keep captions on every word until you switch.
- Shorts are still captioned all the way through.
- **"Like the intro?"** When the intro plays to its end, the viewer asks: **Yes, edit the rest of the video**, **Change the intro…** or **Stop after the intro**. The button in the corner still works too.
- **Intro buttons in the top bar.** During the intro stage the top bar has **Continue editing** and **Redo intro…**.
- **Compare intros (A/B).** Every redo keeps the intro you had as "Intro 1", "Intro 2" and so on, and the **Intro** picker in the top bar switches between them. Only the edit changes; your chat and settings stay. Undo switches back.
- Fixed: the first version saved in a project showed twice in Versions (once as "Recovered …").
- **Drag the playhead.** Grab the white line on the timeline and drag it to move through the video.
- **Clear a selection with the ×** at its top-right on the time ruler, as well as the button on the left.

## 1.7.0

- **Shorts.** A new Shorts tab in the editor. Press Make Shorts and choose how many: 1, 3, 6, 10 or 15. Claude finds the hook, the high-action moments and anything that stops a scroll, and cuts each into a vertical 9:16 Short from your footage. Each one opens on its hook, cuts the dead air and ends on a payoff.
- **No look-alikes.** Shorts never share more than a quarter of their footage. If the video has fewer strong moments than you asked for, Claude makes fewer and says why.
- **A 30-second recap for unboxings and reviews** (on by default): box open, a quick look at what is inside, it in use, done.
- **Framing that follows the subject.** The app finds your face (or the car, by its motion) and keeps it centred in the vertical frame, smoothly, on your own PC.
- **Bold captions:** big, a few words at a time, in your brand's font and colours.
- **Titles written per platform:** a YouTube Shorts title, a TikTok caption, a description and hashtags, each with a Copy button.
- **Review and export:** preview each Short in the tab. Export one or all at 1080x1920, each with a text file of its titles and hashtags. Change… asks Claude to remake one ("start on the crash").

## 1.6.0

- **A check before every export.** Pressing Export first checks the video, with no Claude usage:
  - Missing footage or files.
  - Graphics and sounds whose word was cut.
  - Claude still working.
  - The self-check not done.
  - In the finished picture and sound: black screens, frozen picture, stretches of silence, loudness off target, and peaks that would distort.
- Photos, freeze frames and fades the edit asks for are not reported.
- If nothing is wrong, the export starts straight away. If something is, you get the list with **Go to** for each problem, **Ask Claude to fix these** (sends the list to the chat) and **Export anyway**. The quick low-resolution export skips the check.
- **Diagnostics zip.** The small log icon at the top right saves a zip to your Downloads folder with everything needed to sort out a problem: app and project logs, Claude's last output, the Claude Code version, settings, update status, and system and graphics card info. API keys and tokens are removed; no footage or transcripts are included.

## 1.5.0

- **Video themes.** Settings > Video themes: paste a YouTube video or channel link (or choose a video file) and the app measures its editing style: cuts per minute, how fast the opening is, shot lengths, speech pace, loudness, and a contact sheet of its shots. For a channel it reads the newest 3 long-form videos (Shorts and live streams skipped). Only the first 12 minutes are read, at low resolution, and the downloads are deleted afterwards. Making a theme uses no Claude usage.
- Choose a theme on the Start edit panel, or later in Inspiration, and Claude edits to a similar pace and style, within your channel's rules and brand kit. The first time it uses a theme, Claude writes a short description of the style, shown in Settings; later edits read that instead of the pictures, which keeps usage down.
- Add your own notes to a theme ("copy the pace and the zooms, skip the meme sounds") and Claude follows them.
- **Everything Claude makes is saved to your asset library**: graphics and animations, custom effects, composed music and sound effects, each with a description of what it is, its mood and when it fits. Anything Claude forgets to save is saved automatically after its run. The library now has a folder from the start (Documents\AI Video Editor Asset Library); change it in Settings.
- **Reuse only when it is just as good.** Claude checks the library before making something, and reuses an asset only when it fits the moment perfectly. It never reuses to save usage: when something new would carry the story or emotion better, it makes the new one.
- **Add clip here.** Right-click a cut between clips (or anywhere on the timeline) and choose Add clip here… to pick a photo or video. Then choose whether to cut it in (the video gets longer) or show it over the video, and how much around it Claude may re-edit so it flows: 5, 10 or 25 seconds each side, or type your own. You get Before and After with Keep and Revert.
- **Send time to chat.** Right-click the timeline (ruler, an empty spot, a clip or a cut) and choose Send 2:35.1 to chat: the time goes into the chat box ("At 2:35.1: "), the playhead jumps there, and you finish typing what you want. With a section selected, the whole section is sent.
- **Choose where the asset library lives.** The app asks once where to keep it (keep the suggested folder or choose another). Changing it later in Settings > General asks whether to move the saved assets to the new folder or leave them where they are.
- **Opus 5.5 by default everywhere quality can show.** The recommended models (Settings > Claude models) are now Opus 5.5 for every part, including graphics, music and sound, captions, thumbnails and titles. Only transcribing stays on Haiku 4.5: Claude only starts faster-whisper on your GPU there, so the transcript is word for word the same. If you never changed the models, this applies by itself; if you did, press Reset to recommended.

## 1.4.0

- **Undo button with words.** The top bar has an Undo button. Clicking it says in plain words what it will take back, who made the change and when ("Move B-roll clip "Charger screen". Made by Claude 3 minutes ago"), and Undo it confirms. Ctrl+Z still undoes at once; either way a message says what was undone, with Redo.
- Changes now have readable names everywhere in the undo history, for your tweaks and Claude's ("Change the volume of sound effect", "Stabilize A-roll cut from 1:02 of the footage") instead of internal ids.
- **Reset a clip.** Right-click any clip, graphic or sound on the timeline and choose Reset to put it back to its original settings: position and size, motion, speed, volume, fades, freeze, mute and stabilization, and effects that sit within it on the Effects track. It stays where it is, on the same part of the footage. One Undo brings everything back.

## 1.3.0

- **Picks up where it left off after running out of usage or credits.** When Claude hits its usage limit, the app now tries again on its own when the limit resets (or every 30 minutes if Claude Code does not say when, for example when API credits run low) and carries on from the same stage. The top bar says when the next try is; Resume still works at any time.
- **Rides out a dropped connection.** If the internet drops or Anthropic is busy, it tries again after 1, 2, 5 and 10 minutes, then every 30 minutes. Turn automatic retries off in Settings > Claude connection.
- **Safe across a power cut.** Every save is flushed to the disk before it replaces the old file, so the project can never be left empty or half-written. Backups of the project and the transcript are now also taken every 10 minutes while you edit, and a file that cannot be read is restored from the newest copy automatically (the damaged one is kept in backups/).
- **Reopening after a crash or power cut** puts the unfinished work back in the queue and says where it carries on ("Claude was interrupted. It carries on from: B-roll"). Press Resume. Finished stages are not redone.
- Claude now records its progress more often within long stages (at least every 10 minutes of footage) and saves each clip's transcript as soon as it is done, so an interruption costs minutes, not a whole stage.

## 1.2.0

- **Stabilize a clip.** Right-click an A-roll cut or a B-roll clip on the timeline and choose Stabilize. Claude makes a stabilized copy of that clip's picture (two-pass vidstab with ffmpeg, keeping the frame rate and as little zoom as the shake allows), checks the framing, and swaps it in. Sound, cuts, captions and timing stay on the original footage.
- It shows up like other changes, with Before / After and Keep or Revert, and the estimated cost before it runs. Stabilized clips have a ◎ mark on the timeline. Right-click again for Remove stabilization (Ctrl+Z brings it back) or Stabilize again.
- Settings → Claude models has a Stabilize row (Sonnet 5.5 by default: ffmpeg does the work, the model runs it and checks the result).

## 1.1.1

- **Continue with the rest of the edit, any time.** After a Just the intro edit, Watch first now shrinks the intro card to a button in the corner of the preview instead of hiding it until the project is reopened. After Stop there, the same button stays, so you can edit the rest of the video whenever you like. The card also shows what continuing is likely to cost.
- Once you continue, the project counts as a whole-video edit, so thumbnails and the publishing pack are made too.

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
