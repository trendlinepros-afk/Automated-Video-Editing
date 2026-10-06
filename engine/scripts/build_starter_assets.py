"""Rebuilds the starter asset library in engine/starter_assets: asset.json files, the rendered sound
effect WAVs and every preview.png. Graphic previews come from the engine's own graphic-preview command.

    python engine/scripts/build_starter_assets.py

The app seeds these folders into the user's library folder on first use.
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageDraw

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.join(ENGINE, 'starter_assets')
sys.path.insert(0, ENGINE)
sys.dont_write_bytecode = True

from ave_engine.graphics import load_font  # noqa: E402

STAMP = '2026-10-06T00:00:00.000Z'
W, H = 960, 540

GRAPHICS = {
    'like_and_subscribe': ('Like and subscribe', 'Like button, subscribe button and bell slide up; a cursor clicks each one and the bell rings.',
                           'End of an intro or a natural pause when asking viewers to like and subscribe. 4-5 seconds.',
                           ['subscribe', 'like', 'call to action', 'cta', 'bell'], {}, 4.5, [2.6]),
    'lower_third': ('Lower third', 'Bold name bar with a smaller second line; slides in from the side and back out.',
                    'Introduce a person, a place or a product the first time it appears. 4-6 seconds.',
                    ['lower third', 'name', 'title', 'text', 'introduce'], {'title': 'Alex Rivera', 'subtitle': 'RC car racer'}, 5, [1.5]),
    'title_card': ('Title card', 'Big centred title with a kicker line and a growing underline over a dimmed picture.',
                   'Chapter starts, the video title in the intro, or a big reveal. 2-4 seconds.',
                   ['title', 'chapter', 'heading', 'intro', 'text'], {}, 3, [1.2]),
    'big_number': ('Big number callout', 'A punchy badge whose number counts up (prices, percentages, stats) with a label pill.',
                   'Whenever a price, a percentage or a key number is said. Place it near the thing it is about. 2-4 seconds.',
                   ['price', 'number', 'stat', 'counter', 'callout', 'money'], {}, 3, [1.4]),
    'arrow_callout': ('Arrow callout', 'Curved arrow that draws in towards a point with a label at its tail. The tip follows the item position, so keyframes track a moving object.',
                      'Point at something on screen: a part, a button, a detail. Use keyframes when the target moves.',
                      ['arrow', 'pointer', 'callout', 'look here', 'highlight', 'keyframes'], {}, 3, [1.2]),
    'progress_countdown': ('Countdown and progress bar', "A countdown in an emptying ring, or (mode 'bar') a labelled progress bar that fills.",
                           'Countdowns before a launch or a reveal; a progress bar for "step 2 of 5" or a timed challenge.',
                           ['countdown', 'timer', 'progress', 'bar', 'steps'], {'label': 'GET READY'}, 5, [1.6]),
    'emoji_pop': ('Emoji pop', 'A big drawn emoji springs in, wiggles and floats away. laugh, shock, heart, fire, star, cool, think.',
                  'Reaction beats: a joke, a shock moment, something cool. 1-2 seconds.',
                  ['emoji', 'reaction', 'funny', 'meme', 'pop'], {'emoji': 'laugh'}, 2, [0.9]),
}

SOUNDS = {
    'whoosh': ('Whoosh', 'Air swoosh that sweeps left to right.', 'Transitions, fast B-roll cuts, a graphic sliding in.', ['whoosh', 'swoosh', 'transition']),
    'pop': ('Pop', 'Short bubbly pop.', 'A graphic, emoji or text popping on screen.', ['pop', 'bubble', 'appear', 'ui']),
    'ding': ('Ding', 'Bright bell ding.', 'A correct answer, a good result, a price reveal, a checklist tick.', ['ding', 'bell', 'notification', 'correct']),
    'riser': ('Riser', 'Rising swell that builds tension and stops at its peak.', 'Before a reveal, a drop or a big moment; end it right on the cut.', ['riser', 'build', 'tension', 'swell']),
    'impact': ('Impact', 'Deep boom hit with a crack.', 'A big reveal, a title slam, a crash, the drop after a riser.', ['impact', 'boom', 'hit', 'slam', 'bass']),
    'typing': ('Typing', 'Keyboard typing clicks.', 'On-screen text typing out, searching, writing notes.', ['typing', 'keyboard', 'text', 'computer']),
    'record_scratch': ('Record scratch', 'Vinyl scratch that stops the music.', 'Comedic stop: "wait, what?", a mistake, a hard change of topic.', ['record scratch', 'stop', 'funny', 'comedy']),
}


def asset_json(folder, name, typ, description, when, tags, file, inputs):
    data = {
        'formatVersion': 1, 'id': f'starter-{folder.replace("_", "-")}', 'name': name, 'type': typ,
        'description': description, 'whenToUse': when, 'tags': tags, 'scope': 'shared', 'file': file,
        'preview': 'preview.png', 'inputs': inputs, 'preferred': False, 'uses': 0, 'createdAt': STAMP, 'updatedAt': STAMP,
    }
    with open(os.path.join(ROOT, folder, 'asset.json'), 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
        f.write('\n')


def load(path):
    spec = importlib.util.spec_from_file_location(os.path.basename(path)[:-3], path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def engine(*args):
    env = dict(os.environ, PYTHONPATH=ENGINE)
    out = subprocess.run([sys.executable, '-m', 'ave_engine', *args], capture_output=True, text=True, env=env, check=True)
    for line in out.stdout.splitlines():
        ev = json.loads(line)
        if ev['event'] == 'error':
            raise RuntimeError(ev['message'])
        if ev['event'] == 'result':
            return ev['data']
    raise RuntimeError('no result')


def waveform_png(path, x, title, color=(255, 59, 48)):
    img = Image.new('RGB', (W, H), (17, 17, 17))
    d = ImageDraw.Draw(img)
    mono = np.abs(x).max(axis=1) if x.ndim == 2 else np.abs(x)
    cols = W - 80
    bins = np.array_split(mono, cols)
    peaks = np.array([b.max() if len(b) else 0 for b in bins])
    mid = H * 0.58
    for i, v in enumerate(peaks):
        h = max(1, v * H * 0.3)
        d.line([(40 + i, mid - h), (40 + i, mid + h)], fill=color)
    f = load_font(H * 0.09)
    d.text((40, H * 0.08), title, font=f, fill=(255, 255, 255))
    img.save(path)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        for folder, (name, desc, when, tags, params, dur, times) in GRAPHICS.items():
            py = os.path.join(ROOT, folder, f'{folder}.py')
            mod = load(py)
            files = engine('graphic-preview', '--file', py, '--params', json.dumps(params), '--duration', str(dur),
                           '--times', ','.join(str(t) for t in times), '--width', str(W), '--height', str(H), '--out-dir', tmp)['files']
            os.replace(files[0], os.path.join(ROOT, folder, 'preview.png'))
            asset_json(folder, name, 'graphic', desc, when, tags, f'{folder}.py', mod.META.get('inputs', {}))

    synth = load(os.path.join(ROOT, 'sfx_synth', 'sfx_synth.py'))
    for kind, (name, desc, when, tags) in SOUNDS.items():
        folder = f'sfx_{kind}'
        os.makedirs(os.path.join(ROOT, folder), exist_ok=True)
        x = synth.render(kind)
        synth.write_wav(os.path.join(ROOT, folder, f'{kind}.wav'), x)
        waveform_png(os.path.join(ROOT, folder, 'preview.png'), x, name)
        asset_json(folder, name, 'sound', desc + ' Made by the sound effect synthesizer (asset "Sound effect synthesizer").',
                   when, tags + ['sfx', 'sound effect'], f'{kind}.wav', {})
    asset_json('sfx_synth', 'Sound effect synthesizer', 'sound',
               'Python synthesizer for whoosh, pop, ding, riser, impact, typing and record scratch, at any length and pitch. '
               'Run: python sfx_synth.py <kind> --out file.wav [--seconds S] [--pitch P] [--seed N], or "all --out-dir DIR".',
               'When a ready-made sound effect is the wrong length or pitch, or a variation is needed. Place the WAV it writes on the Sound effects track.',
               ['sfx', 'synth', 'generator', 'sound effect', 'whoosh', 'pop', 'ding', 'riser', 'impact'], 'sfx_synth.py',
               {'kind': {'type': 'string', 'default': 'whoosh', 'description': 'whoosh | pop | ding | riser | impact | typing | record_scratch'},
                'seconds': {'type': 'number', 'description': 'Length in seconds (default depends on the kind)'},
                'pitch': {'type': 'number', 'default': 1.0, 'description': '1.0 = normal, 2.0 = an octave up'},
                'seed': {'type': 'number', 'default': 1, 'description': 'Variation'}})
    strip = np.concatenate([synth.render(k) for k in SOUNDS])
    waveform_png(os.path.join(ROOT, 'sfx_synth', 'preview.png'), strip, 'Sound effect synthesizer', (255, 212, 0))

    music = load(os.path.join(ROOT, 'music_engine', 'music_engine.py'))
    img = Image.new('RGB', (W, H), (17, 17, 17))
    d = ImageDraw.Draw(img)
    f = load_font(H * 0.075)
    small = load_font(H * 0.04)
    d.text((40, 30), 'Music engine: one melody, six moods', font=f, fill=(255, 255, 255))
    moods = list(music.MOODS)
    colors = [(255, 59, 48), (90, 200, 250), (175, 82, 222), (255, 149, 0), (255, 212, 0), (52, 199, 89)]
    for i, m in enumerate(moods):
        x = music.compose(m, seconds=12, seed=3)
        mono = np.abs(x).max(axis=1)
        y0 = 120 + i * 68
        d.text((40, y0 + 18), m, font=small, fill=colors[i])
        bins = np.array_split(mono, W - 260)
        for j, b in enumerate(bins):
            h = max(1, b.max() * 28)
            d.line([(220 + j, y0 + 34 - h), (220 + j, y0 + 34 + h)], fill=colors[i])
    img.save(os.path.join(ROOT, 'music_engine', 'preview.png'))
    asset_json('music_engine', 'Music engine', 'music',
               'Composes a music bed in code: a seed picks one melody, and each mood (upbeat, chill, tense, epic, funny, inspiring) '
               'plays it with its own chords, instruments and groove. Run: python music_engine.py --mood upbeat --seconds 90 --seed 7 --out music.wav '
               '(--bpm to change the tempo, --list for moods).',
               'Default for music: compose the score with one seed for the whole video and switch moods between sections so it stays one theme. '
               'Place the WAV on the Music track with duck on.',
               ['music', 'score', 'composer', 'synth', 'background music', 'mood'], 'music_engine.py',
               {'mood': {'type': 'string', 'default': 'upbeat', 'description': ', '.join(moods)},
                'bpm': {'type': 'number', 'description': 'Tempo (default depends on the mood)'},
                'seconds': {'type': 'number', 'default': 60, 'description': 'Length'},
                'seed': {'type': 'number', 'default': 1, 'description': 'Picks the melody; keep it the same across a video'}})

    # Custom effect preview: before / after on a test picture.
    glitch = load(os.path.join(ROOT, 'glitch', 'glitch.py'))
    from ave_engine.graphics import GraphicContext, merge_brand

    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    base = np.stack([xx / W, yy / H, 0.5 + 0.5 * np.sin(xx / 40) * np.cos(yy / 40)], axis=-1).astype(np.float32)
    out = base
    for tt in np.arange(0, 3, 0.05):
        ctx = GraphicContext(W, H, 3, {'amount': 1.4, 'rate': 6}, 30, merge_brand(None), float(tt), 12345)
        res = glitch.apply(base, float(tt), ctx)
        if res is not base:
            out = res
            break
    Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8)).save(os.path.join(ROOT, 'glitch', 'preview.png'))
    asset_json('glitch', 'Glitch', 'effect',
               "Digital glitch bursts: colour split, slices jumping sideways, blocky noise. Place as an Effects item with effect 'custom' and file glitch.py.",
               'Tech moments, errors, fails, fast transitions or a "system crash" joke. 0.5-2 seconds.',
               ['glitch', 'digital', 'error', 'transition', 'custom effect'], 'glitch.py', glitch.META['inputs'])
    print('Starter assets rebuilt in', ROOT)


if __name__ == '__main__':
    main()
