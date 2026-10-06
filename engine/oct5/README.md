# The October 5 scripts

The spec asks for the rendering code from the October 5 edit to be reused as it is, wrapped rather than
rewritten. Those scripts were not available when version 1.0.0 was built, so the owner chose to build
without them: engine 1.0.0 (`engine/ave_engine`) is a reference engine written from the spec's account of
that session. This folder is where the original scripts go when they turn up, and this page says how they
will be wired in.

## What goes here

Copy the scripts into this folder unchanged, one subfolder per script set, keeping their own file names:

| Folder | Scripts (from the spec) | Known location |
| --- | --- | --- |
| `oct5/music/` | Music synthesis engine (one melody, several moods) | Claude Edit code folder, `Content/P1` |
| `oct5/sfx/` | Sound effect synthesis and the shared event map | Claude Edit code folder, `Content/P1` |
| `oct5/graphics/` | Graphics drawing script (thumbnail-style graphics, Pillow) | Claude Edit code folder, `Content/P1` |
| `oct5/compositor/` | GPU compositor (decode 1080p, upscale to 4K, effects, graphics, NVENC encode) | Still needed |
| `oct5/mixer/` | Mixer (voice clean-up, limiter, ducking, -14 LUFS) | Still needed |
| `oct5/edl/` | Edit decision list, dialogue assembler, word-boundary checker | Still needed |

Add a `SOURCE.txt` next to each set saying where it came from and its file dates. Do not edit the
scripts; anything that has to change goes in the wrapper.

## How they will be wrapped

The app only talks to the engine through the CLI in `ave_engine/cli.py` (`python -m ave_engine <command>`,
JSON lines on stdout, a render plan JSON as input). That contract does not change. Wrapping means
putting the October 5 code behind those same commands:

1. **Compositor** (`render-chunks`, `export`, `frame`, `frames`). A wrapper module in `ave_engine`
   converts the render plan (`src/shared/plan.ts`: absolute times, layers bottom to top, fractions of
   the frame for layout) into whatever the compositor reads (its EDL and settings), calls the compositor's
   own entry point for a time range and output size, and turns its progress output into `progress`
   and `chunk_done` events. If the compositor writes frames rather than encoding them, the wrapper
   feeds them to the existing encoders in `encode.py` so preview chunks keep identical settings and
   still join with `ffmpeg -f concat -c copy`.
2. **Mixer** (`mix`, the audio in `export`). The wrapper builds the mixer's input from `plan.audio`
   (clips with roles, gains, fades, ducking, loops) and the mix settings, runs it on the whole timeline,
   then keeps today's rules: one master gain measured on the whole timeline, the limiter at
   `truePeakDb`, then slicing with clean fades. The cache in `<project>/cache/audio/` stays.
3. **Music, sound effects, graphics.** These become library assets, like the starter set in
   `engine/starter_assets`: the music engine as a `music` asset, the sound effect synth as a `sound`
   asset with its rendered WAVs, and each graphic style as a `graphic` asset. A graphic asset is a file
   with `render(t, ctx)`; for an October 5 graphic it is a short adapter that imports the original
   drawing function from a copy kept beside it and maps `ctx` (size, params, brand colors and fonts)
   to that function's arguments.
4. **EDL, dialogue assembler, word-boundary checker.** These are Claude's editing tools, not the app's.
   They go into the asset library (or the rules Claude is given) so Claude can run them itself; the app
   stays free of editing logic.

## Versioning and the parity gate

Wrapping the scripts produces a new engine version (for example 1.1.0, set in `ave_engine/__init__.py`
and `ENGINE_VERSION` in `src/shared/appInfo.ts`). Projects record the engine version they were made with
and the app keeps earlier engines, so a project made with 1.0.0 still renders with 1.0.0.

Before the wrapped engine is used, `engine/tests` must pass on it, in particular the preview/export
match test (`AVE_MATCH_SECONDS=30`), and the owner's side-by-side parity check against the October 5
video decides whether it replaces the reference engine as the default.
