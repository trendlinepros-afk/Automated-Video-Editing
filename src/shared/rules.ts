/**
 * The standard editing rules handed to Claude at the start of every session.
 * They are the October 5 method. Claude applies them; the app does not.
 * A profile can replace this text (Settings > Profiles > Editing rules).
 */
export const DEFAULT_EDITING_RULES = `Standard editing rules (the October 5 method)

1. Review first. Probe every footage file, look at frames, and study the channel's previous export and thumbnail style before deciding anything. Read the inspiration, the channel notes, the channel rules and the brand kit.
2. Transcribe every clip yourself with faster-whisper on the GPU, with word timings. Save it with save_transcript, passing the JSON file faster-whisper wrote (not the words one by one). Split it into phrases at each pause to find retakes.
3. Write an edit decision list of kept phrases with their source times, choosing the best take of each retake. Apply it with set_aroll_cuts. Anchor B-roll, graphics, music cues and sound effects to words in those phrases, never to fixed times, so they move with the words when cuts change.
4. After assembling the dialogue, run run_self_check, transcribe the assembled dialogue again, and compare it with the intended words.
5. Fix every flagged boundary by reading the audio at that spot in 5 ms steps (get_audio_energy with step_ms 5). Do not rely on automatic snapping: it failed on continuous speech on October 5. Adjust each cut with adjust_cut.
6. Treat a doubled word at a boundary as a possible checker error. Confirm it on an isolated snippet (get_audio_snippet, transcribe it alone) before changing the cut, and allow for small drift in transcript timings.
7. Search the asset library before making any graphic, animation, song or sound. Reuse one only when it fits the moment perfectly and is as good as a new one would be; when something new would serve the story or emotion better, make it. Save everything new to the library.
8. Graphics are Python code files (one per graphic) drawn in the channel's brand kit. Preview them as frames before placing them.
9. Music is composed in code by default, as on October 5. Use a track from the music library when that fits better or when asked. Music sits under speech by the profile's mix setting (duck: true).
10. Before the full render, check stills at key moments for graphic placement (get_frame / get_frames) and look at a short motion test (get_range_frames).
11. After export, measure loudness and check frames from the finished file.
12. Keep the progress checklist and handoff notes current after every stage, so a new session can continue without redoing finished work.
13. The app carries out every cut exactly as you give it and adjusts nothing on its own. Every editing decision is yours.`
