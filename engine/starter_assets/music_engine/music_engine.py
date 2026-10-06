"""Music synthesis engine: one melody, many moods.

A seed picks one melody (a motif and its answer, as scale steps). Each mood plays that same melody
with its own scale, chords, instruments, groove and tempo, so a video can move between moods and
still sound like one score.

    python music_engine.py --mood upbeat --bpm 118 --seconds 60 --seed 7 --out music.wav
    python music_engine.py --list

As a module: compose(mood, bpm=None, seconds=60, seed=1) -> float32 array (samples, 2) at 48 kHz.
Moods: upbeat, chill, tense, epic, funny, inspiring.
"""
import argparse
import math
import os

import numpy as np
from scipy.signal import butter, sosfilt

SR = 48000

MAJOR = [0, 2, 4, 5, 7, 9, 11]
MINOR = [0, 2, 3, 5, 7, 8, 10]

# chords as scale degrees (0 = I); one chord per bar
MOODS = {
    'upbeat': {'scale': MAJOR, 'root': 60, 'bpm': 118, 'chords': [0, 4, 5, 3], 'lead': 'pluck', 'pad': 'saw_pad',
               'bass': 'octave', 'drums': 'four', 'swing': 0.0, 'bright': 5000},
    'chill': {'scale': MAJOR, 'root': 57, 'bpm': 82, 'chords': [0, 5, 3, 4], 'lead': 'keys', 'pad': 'soft_pad',
              'bass': 'round', 'drums': 'lofi', 'swing': 0.18, 'bright': 2200, 'sevenths': True},
    'tense': {'scale': MINOR, 'root': 57, 'bpm': 100, 'chords': [0, 0, 5, 4], 'lead': 'pulse', 'pad': 'dark_pad',
              'bass': 'pulse8', 'drums': 'tick', 'swing': 0.0, 'bright': 1800},
    'epic': {'scale': MINOR, 'root': 50, 'bpm': 90, 'chords': [0, 5, 2, 6], 'lead': 'brass', 'pad': 'saw_pad',
             'bass': 'long', 'drums': 'toms', 'swing': 0.0, 'bright': 3500},
    'funny': {'scale': MAJOR, 'root': 65, 'bpm': 128, 'chords': [0, 3, 4, 0], 'lead': 'square', 'pad': None,
              'bass': 'bounce', 'drums': 'bouncy', 'swing': 0.25, 'bright': 6000},
    'inspiring': {'scale': MAJOR, 'root': 62, 'bpm': 96, 'chords': [5, 3, 0, 4], 'lead': 'keys', 'pad': 'soft_pad',
                  'bass': 'long', 'drums': 'four_soft', 'swing': 0.0, 'bright': 4200},
}


# ---------------------------------------------------------------------------------------------
# the melody (shared by every mood)

def melody(seed):
    """8 bars of (beat, length_beats, scale_step) built from a seeded 2-bar motif."""
    rng = np.random.default_rng(seed)
    rhythms = [[1, 0.5, 0.5, 1, 1], [0.5, 0.5, 1, 0.5, 0.5, 1], [1.5, 0.5, 1, 1], [0.5, 0.5, 0.5, 0.5, 2]]
    r1 = rhythms[rng.integers(len(rhythms))]
    r2 = rhythms[rng.integers(len(rhythms))]
    steps = [0]
    for _ in range(len(r1) + len(r2) - 1):
        steps.append(int(np.clip(steps[-1] + rng.choice([-2, -1, 1, 1, 2, 3]), -3, 7)))
    motif = []
    beat = 0.0
    for i, d in enumerate(r1 + r2):
        motif.append((beat, d * 0.95, steps[i]))
        beat += d
    # A A' B A'': the answer moves the motif, the B part climbs, the end resolves to the root.
    out = []
    for bar0, shift in ((0, 0), (2, 2), (4, 4), (6, 0)):
        for b, d, s in motif:
            out.append((bar0 * 4 + b, d, s + shift))
    last = max(n[0] for n in out)
    out = [n for n in out if n[0] < last] + [(last, 2.0, 0)]
    return out


# ---------------------------------------------------------------------------------------------
# instruments

def midi_hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def adsr(n, a, d, s, r):
    a, d, r = int(a * SR), int(d * SR), int(r * SR)
    env = np.full(n + r, s, dtype=np.float64)
    a = min(a, n)
    env[:a] = np.linspace(0, 1, a, endpoint=False) if a else env[:a]
    dd = min(d, max(0, n - a))
    env[a:a + dd] = np.linspace(1, s, dd, endpoint=False) if dd else env[a:a + dd]
    env[n:] = np.linspace(env[n - 1] if n else s, 0, r)
    return env


def osc(kind, f, n, phase0=0.0):
    t = np.arange(n) / SR
    ph = 2 * np.pi * f * t + phase0
    if kind == 'sine':
        return np.sin(ph)
    if kind == 'saw':
        k = max(1, int(min(30, 16000 / max(f, 1))))
        return sum(np.sin(i * ph) / i for i in range(1, k + 1)) * 0.6
    if kind == 'square':
        k = max(1, int(min(30, 16000 / max(f, 1))))
        return sum(np.sin(i * ph) / i for i in range(1, k + 1, 2)) * 0.8
    if kind == 'tri':
        return 2 / np.pi * np.arcsin(np.sin(ph))
    raise ValueError(kind)


def lowpass(x, f, order=2):
    return sosfilt(butter(order, min(f, SR * 0.45), btype='lowpass', fs=SR, output='sos'), x)


def highpass(x, f, order=2):
    return sosfilt(butter(order, f, btype='highpass', fs=SR, output='sos'), x)


_VOICES = {}


def voice(kind, midi, dur, vel, bright):
    """One note. Notes repeat a lot, so each distinct one is synthesized once."""
    key = (kind, midi, round(dur, 4), bright)
    x = _VOICES.get(key)
    if x is None:
        if len(_VOICES) > 2000:
            _VOICES.clear()
        x = _voice(kind, midi, dur, bright)
        _VOICES[key] = x
    return x * vel


def _voice(kind, midi, dur, bright):
    vel = 1.0
    f = midi_hz(midi)
    n = max(1, int(dur * SR))
    if kind == 'pluck':
        e = adsr(n, 0.003, 0.18, 0.15, 0.12)
        x = lowpass(osc('saw', f, len(e)) + 0.5 * osc('square', f * 2.0, len(e)) * 0.3, bright) * e
    elif kind == 'keys':  # soft electric-piano: FM sine with a bell on the attack
        e = adsr(n, 0.004, 0.6, 0.35, 0.35)
        t = np.arange(len(e)) / SR
        mod = np.sin(2 * np.pi * f * 1.0 * t) * 1.6 * np.exp(-t / 0.25)
        x = np.sin(2 * np.pi * f * t + mod) * e
    elif kind == 'pulse':
        e = adsr(n, 0.005, 0.08, 0.5, 0.06)
        x = lowpass(osc('square', f, len(e)), bright) * e * 0.7
    elif kind == 'brass':
        e = adsr(n, 0.06, 0.2, 0.8, 0.25)
        x = lowpass(osc('saw', f, len(e)) + osc('saw', f * 1.004, len(e)), bright) * e * 0.5
    elif kind == 'square':
        e = adsr(n, 0.004, 0.1, 0.5, 0.05)
        x = lowpass(osc('square', f, len(e)), bright) * e * 0.6
    else:
        e = adsr(n, 0.01, 0.1, 0.7, 0.1)
        x = osc('sine', f, len(e)) * e
    return x * vel


_PADS = {}


def pad(kind, midis, dur, bright):
    key = (kind, tuple(midis), round(dur, 4), bright)
    if key not in _PADS:
        if len(_PADS) > 64:
            _PADS.clear()
        _PADS[key] = _pad(kind, midis, dur, bright)
    return _PADS[key]


def _pad(kind, midis, dur, bright):
    n = int(dur * SR)
    e = adsr(n, 0.4 if kind != 'dark_pad' else 0.8, 0.5, 0.8, 0.6)
    x = np.zeros(len(e))
    for m in midis:
        f = midi_hz(m)
        if kind == 'soft_pad':
            x += osc('tri', f, len(e)) + 0.5 * osc('tri', f * 1.003, len(e))
        else:
            x += osc('saw', f, len(e)) * 0.5 + osc('saw', f * 0.997, len(e)) * 0.5
    cut = bright * (0.35 if kind == 'dark_pad' else 0.5)
    return lowpass(x, cut) * e / max(1, len(midis))


def kick(n=None):
    n = n or int(0.35 * SR)
    if n in _KICKS:
        return _KICKS[n]
    _KICKS[n] = _kick(n)
    return _KICKS[n]


_KICKS = {}


def _kick(n):
    t = np.arange(n) / SR
    f = 45 + 110 * np.exp(-t / 0.035)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.12)


def snare(rng):
    n = int(0.25 * SR)
    t = np.arange(n) / SR
    noise = highpass(rng.standard_normal(n), 1500) * np.exp(-t / 0.07)
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.05)
    return noise * 0.6 + tone * 0.5


def clap(rng):
    n = int(0.2 * SR)
    t = np.arange(n) / SR
    env = sum(np.exp(-np.maximum(0, t - o) / 0.01) * (t >= o) for o in (0, 0.01, 0.02)) + np.exp(-t / 0.08) * 0.5
    return highpass(lowpass(rng.standard_normal(n), 6000), 900) * env * 0.5


def hat(rng, open_=False):
    n = int((0.3 if open_ else 0.06) * SR)
    t = np.arange(n) / SR
    return highpass(rng.standard_normal(n), 7000) * np.exp(-t / (0.12 if open_ else 0.015)) * 0.35


def tom(f):
    n = int(0.6 * SR)
    t = np.arange(n) / SR
    ff = f * (1 + 0.5 * np.exp(-t / 0.05))
    return np.sin(2 * np.pi * np.cumsum(ff) / SR) * np.exp(-t / 0.25)


# ---------------------------------------------------------------------------------------------
# arranging

def place(buf, pos, x, pan=0.0, gain=1.0):
    if pos >= len(buf):
        return
    a = (pan + 1) * math.pi / 4
    n = min(len(x), len(buf) - pos)
    buf[pos:pos + n, 0] += x[:n] * math.cos(a) * gain
    buf[pos:pos + n, 1] += x[:n] * math.sin(a) * gain


def degree_midi(scale, root, step):
    octave, idx = divmod(step, 7)
    return root + 12 * octave + scale[idx]


def compose(mood='upbeat', bpm=None, seconds=60.0, seed=1):
    if mood not in MOODS:
        raise ValueError(f'Unknown mood {mood!r}; choose from {", ".join(MOODS)}')
    M = MOODS[mood]
    bpm = float(bpm or M['bpm'])
    beat = 60.0 / bpm
    total = int(seconds * SR)
    buf = np.zeros((total + SR * 2, 2))
    rng = np.random.default_rng(seed * 1000 + 17)
    scale, root, bright = M['scale'], M['root'], M['bright']
    mel = melody(seed)
    bars = int(math.ceil(seconds / (beat * 4)))
    swing = M.get('swing', 0.0)

    def at(bar, b):
        frac = b - math.floor(b)
        if swing and abs(frac - 0.5) < 1e-6:
            b += swing * 0.5
        return int(((bar * 4) + b) * beat * SR)

    for bar in range(bars):
        section = (bar // 8) % 4  # 0 intro, 1 A, 2 B, 3 A again
        intro = bar < 4
        deg = M['chords'][bar % len(M['chords'])]
        chord = [degree_midi(scale, root - 12, deg + k) for k in ((0, 2, 4, 6) if M.get('sevenths') else (0, 2, 4))]
        if M['pad']:
            place(buf, at(bar, 0), pad(M['pad'], chord, beat * 4.2, bright), 0.0, 0.32)
        # Bass.
        bm = degree_midi(scale, root - 24, deg)
        style = M['bass']
        if style == 'octave':
            for i in range(8):
                place(buf, at(bar, i * 0.5), voice('pluck', bm + (12 if i % 2 else 0), beat * 0.45, 0.9, 900), 0, 0.55)
        elif style == 'pulse8':
            for i in range(8):
                place(buf, at(bar, i * 0.5), voice('pulse', bm, beat * 0.35, 0.8, 700), 0, 0.6)
        elif style == 'bounce':
            for i, b in enumerate((0, 1.5, 2, 3)):
                place(buf, at(bar, b), voice('square', bm + (7 if i == 2 else 0), beat * 0.4, 0.8, 1200), 0, 0.5)
        elif style == 'round':
            for b in (0, 2.5):
                place(buf, at(bar, b), voice('sine', bm, beat * 1.4, 1.0, 600), 0, 0.7)
        else:
            place(buf, at(bar, 0), voice('sine', bm, beat * 3.8, 1.0, 600), 0, 0.7)
        # Melody: not in the intro; up an octave in the B part.
        if not intro:
            shift = 7 if section == 2 else 0
            mb = bar % 8
            for b0, d, s in mel:
                if mb * 4 <= b0 < (mb + 1) * 4:
                    m = degree_midi(scale, root, s + shift)
                    v = 0.75 + 0.25 * rng.random()
                    place(buf, at(bar, b0 - mb * 4), voice(M['lead'], m, d * beat, v, bright), 0.15 * math.sin(b0), 0.5)
        # Drums.
        d = M['drums']
        if d in ('four', 'four_soft'):
            g = 0.6 if d == 'four_soft' else 1.0
            for b in range(4):
                place(buf, at(bar, b), kick(), 0, 0.9 * g)
                place(buf, at(bar, b + 0.5), hat(rng), 0.3, 0.5 * g)
            if not intro:
                for b in (1, 3):
                    place(buf, at(bar, b), clap(rng), -0.1, 0.8 * g)
        elif d == 'lofi':
            for b in (0, 2.5):
                place(buf, at(bar, b), lowpass(kick(), 1500), 0, 0.8)
            for b in (1, 3):
                place(buf, at(bar, b), lowpass(snare(rng), 3000), 0, 0.5)
            for i in range(8):
                place(buf, at(bar, i * 0.5), lowpass(hat(rng), 9000), 0.3, 0.35 * (0.7 + 0.3 * rng.random()))
        elif d == 'tick':
            for i in range(16):
                place(buf, at(bar, i * 0.25), hat(rng), 0.4 * math.sin(i), 0.35 if i % 4 else 0.55)
            if not intro:
                place(buf, at(bar, 0), kick(), 0, 0.9)
                place(buf, at(bar, 2.75), kick(), 0, 0.6)
        elif d == 'toms':
            if not intro:
                for b, f in ((0, 80), (1.5, 95), (2, 80), (3, 110), (3.5, 120)):
                    place(buf, at(bar, b), tom(f), (f - 100) / 60, 0.8)
            place(buf, at(bar, 0), kick(), 0, 1.0)
        elif d == 'bouncy':
            for b in (0, 2):
                place(buf, at(bar, b), kick(), 0, 0.8)
            for b in (1, 3):
                place(buf, at(bar, b), snare(rng), 0, 0.5)
            for i in range(8):
                place(buf, at(bar, i * 0.5), hat(rng), -0.3, 0.3)

    x = buf[:total]
    # Glue: gentle compression via soft clipping after levelling, then a short fade at both ends.
    rms = math.sqrt(float(np.mean(x ** 2))) or 1.0
    x = np.tanh(x * (0.18 / rms) * 1.2) / 1.2
    f_in, f_out = int(0.05 * SR), int(min(3.0, seconds * 0.15) * SR)
    x[:f_in] *= np.linspace(0, 1, f_in)[:, None]
    x[len(x) - f_out:] *= np.linspace(1, 0, f_out)[:, None]
    peak = np.max(np.abs(x)) or 1.0
    return (x * (10 ** (-1 / 20) / peak)).astype(np.float32)


def write_wav(path, x):
    from scipy.io import wavfile

    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    wavfile.write(path, SR, (np.clip(x, -1, 1) * 32767).round().astype(np.int16))


def main(argv=None):
    p = argparse.ArgumentParser(description='Compose a music bed (48 kHz stereo WAV). Same seed = same melody in every mood.')
    p.add_argument('--mood', default='upbeat', choices=list(MOODS))
    p.add_argument('--bpm', type=float, help='Tempo; default depends on the mood')
    p.add_argument('--seconds', type=float, default=60.0)
    p.add_argument('--seed', type=int, default=1, help='Picks the melody')
    p.add_argument('--out', help='Output WAV')
    p.add_argument('--list', action='store_true', help='List moods')
    a = p.parse_args(argv)
    if a.list:
        for k, m in MOODS.items():
            print(f'{k}: {m["bpm"]} bpm, {"minor" if m["scale"] is MINOR else "major"}')
        return
    if not a.out:
        p.error('--out is required')
    write_wav(a.out, compose(a.mood, a.bpm, a.seconds, a.seed))
    print(a.out)


if __name__ == '__main__':
    main()
