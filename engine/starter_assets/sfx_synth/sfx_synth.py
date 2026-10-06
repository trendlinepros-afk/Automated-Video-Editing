"""Sound effect synthesizer: whoosh, pop, ding, riser, impact, typing, record scratch.

Every sound is made from code (numpy + scipy), so it can be re-made at any length or pitch and
always sounds the same for the same seed.

    python sfx_synth.py whoosh --out whoosh.wav [--seconds 0.8] [--pitch 1.0] [--seed 1]
    python sfx_synth.py all --out-dir sounds/

As a module: `render(kind, seconds=None, pitch=1.0, seed=1) -> float32 array (samples, 2)` at 48 kHz.
"""
import argparse
import math
import os

import numpy as np
from scipy.signal import butter, sosfilt

SR = 48000
KINDS = ('whoosh', 'pop', 'ding', 'riser', 'impact', 'typing', 'record_scratch')
DEFAULT_SECONDS = {'whoosh': 0.8, 'pop': 0.25, 'ding': 1.6, 'riser': 2.5, 'impact': 1.8, 'typing': 1.5, 'record_scratch': 0.7}


def _t(seconds):
    return np.arange(int(seconds * SR)) / SR


def _band(x, lo, hi, order=2):
    hi = min(hi, SR / 2 * 0.95)
    sos = butter(order, [lo, hi], btype='bandpass', fs=SR, output='sos')
    return sosfilt(sos, x)


def _lp(x, f, order=2):
    return sosfilt(butter(order, min(f, SR / 2 * 0.95), btype='lowpass', fs=SR, output='sos'), x)


def _hp(x, f, order=2):
    return sosfilt(butter(order, f, btype='highpass', fs=SR, output='sos'), x)


def _pan(mono, pan):
    """pan: scalar or per-sample array in -1..1 (equal power)."""
    a = (np.asarray(pan) + 1) * math.pi / 4
    return np.stack([mono * np.cos(a), mono * np.sin(a)], axis=1)


def _normalize(x, peak_db=-1.0):
    m = np.max(np.abs(x)) if len(x) else 0
    if m > 0:
        x = x * (10 ** (peak_db / 20) / m)
    return x.astype(np.float32)


def _edges(x, fade_in=0.003, fade_out=0.01):
    n = len(x)
    fi, fo = min(n, int(fade_in * SR)), min(n, int(fade_out * SR))
    if fi:
        x[:fi] *= np.linspace(0, 1, fi)[:, None] if x.ndim == 2 else np.linspace(0, 1, fi)
    if fo:
        x[n - fo:] *= np.linspace(1, 0, fo)[:, None] if x.ndim == 2 else np.linspace(1, 0, fo)
    return x


def whoosh(seconds, pitch, rng):
    t = _t(seconds)
    u = t / seconds
    noise = rng.standard_normal(len(t))
    # Bank of bands; the loudest band sweeps up then down, like air past the ear.
    centres = np.geomspace(200, 7000, 10) * pitch
    sweep = np.log(300 * pitch) + (np.log(3200 * pitch) - np.log(300 * pitch)) * np.sin(np.pi * np.clip(u * 1.1, 0, 1)) ** 1.5
    out = np.zeros(len(t))
    for c in centres:
        b = _band(noise, c / 1.3, c * 1.3)
        w = np.exp(-((np.log(c) - sweep) ** 2) / (2 * 0.45 ** 2))
        out += b * w
    env = np.sin(np.pi * np.clip(u, 0, 1)) ** 2 * (0.35 + 0.65 * u)
    out *= env
    return _pan(out, np.linspace(-0.7, 0.7, len(t)))


def pop(seconds, pitch, rng):
    t = _t(seconds)
    f = (180 + 900 * np.exp(-t / 0.012)) * pitch
    phase = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(phase) * np.exp(-t / 0.045)
    click = _band(rng.standard_normal(len(t)), 1500, 6000) * np.exp(-t / 0.004) * 0.6
    return _pan(body + click, 0.0)


def ding(seconds, pitch, rng):
    t = _t(seconds)
    f0 = 1318.5 * pitch  # E6
    partials = [(1.0, 1.0, 1.2), (2.0, 0.35, 0.6), (2.76, 0.25, 0.45), (5.4, 0.12, 0.2), (8.93, 0.06, 0.1)]
    left = np.zeros(len(t))
    right = np.zeros(len(t))
    for ratio, amp, decay in partials:
        for ch, det in ((left, 0.999), (right, 1.001)):
            ch += amp * np.sin(2 * np.pi * f0 * ratio * det * t) * np.exp(-t / (decay * seconds / 1.6))
    strike = _band(rng.standard_normal(len(t)), 3000, 9000) * np.exp(-t / 0.003) * 0.3
    x = np.stack([left + strike, right + strike], axis=1)
    return x * np.minimum(1, t / 0.002)[:, None]


def riser(seconds, pitch, rng):
    t = _t(seconds)
    u = t / seconds
    f = 110 * pitch * (2 ** (u * 3.0))
    phase = 2 * np.pi * np.cumsum(f) / SR
    saw = sum(np.sin(k * phase) / k for k in range(1, 9))
    fifth = sum(np.sin(k * phase * 1.5) / k for k in range(1, 6))
    tone = _lp(saw + 0.5 * fifth, 4000) * 0.4
    noise = rng.standard_normal(len(t))
    hiss = np.zeros(len(t))
    for i, c in enumerate(np.geomspace(500, 9000, 8)):
        w = np.clip(u * 8 - i * 0.6, 0, 1)
        hiss += _band(noise, c / 1.4, c * 1.4) * w
    env = u ** 2.2
    x = (tone + 0.7 * hiss) * env
    tremolo = 1 + 0.25 * np.sin(2 * np.pi * (4 + 14 * u) * t)
    mono = x * tremolo
    return _edges(_pan(mono, np.sin(2 * np.pi * 0.5 * t) * 0.4), 0.005, 0.02)


def impact(seconds, pitch, rng):
    t = _t(seconds)
    f = (38 + 110 * np.exp(-t / 0.06)) * pitch
    phase = 2 * np.pi * np.cumsum(f) / SR
    boom = np.sin(phase) * np.exp(-t / (0.45 * seconds / 1.8))
    crack = _lp(rng.standard_normal(len(t)), 2500) * np.exp(-t / 0.03) * 0.8
    rumble = _lp(rng.standard_normal(len(t)), 180) * np.exp(-t / 0.5) * 1.5
    x = np.tanh(1.6 * (boom + crack + rumble))
    tail_l = _lp(rng.standard_normal(len(t)), 900) * np.exp(-t / 0.35) * 0.08
    tail_r = _lp(rng.standard_normal(len(t)), 900) * np.exp(-t / 0.35) * 0.08
    return np.stack([x + tail_l, x + tail_r], axis=1)


def typing(seconds, pitch, rng):
    n = int(seconds * SR)
    out = np.zeros((n, 2))
    pos = int(0.02 * SR)
    while pos < n - int(0.05 * SR):
        length = int(0.03 * SR)
        tt = np.arange(length) / SR
        click = _band(rng.standard_normal(length), 2500 * pitch, 7000) * np.exp(-tt / 0.004)
        thock = np.sin(2 * np.pi * rng.uniform(140, 220) * pitch * tt) * np.exp(-tt / 0.012) * 0.6
        k = (click + thock) * rng.uniform(0.6, 1.0)
        if rng.random() < 0.12:  # space bar: deeper
            k = _lp(k, 1500) * 1.4
        out[pos:pos + length] += _pan(k, rng.uniform(-0.3, 0.3))
        pos += int(rng.uniform(0.06, 0.16) * SR)
    return out


def record_scratch(seconds, pitch, rng):
    t = _t(seconds)
    u = t / seconds
    # Hand movement: fast forward-back-forward, then a stop.
    speed = 2.2 * np.sin(2 * np.pi * 2.6 * u) * (1 - u) ** 0.7 + 0.2 * (u < 0.15)
    pos = np.cumsum(speed) / SR
    # The "record": a bright chord, read at the moving position.
    chord = sum(np.sin(2 * np.pi * f * pitch * pos) for f in (220, 277.2, 329.6, 440))
    grit = _band(rng.standard_normal(len(t)), 800, 5000) * np.abs(speed) * 0.35
    x = (_band(chord, 150, 6000) * 0.5 + grit) * np.clip(np.abs(speed) * 1.5, 0, 1)
    x *= np.exp(-np.maximum(0, u - 0.8) * 12)
    return _pan(x, 0.0)


GENERATORS = {'whoosh': whoosh, 'pop': pop, 'ding': ding, 'riser': riser, 'impact': impact, 'typing': typing,
              'record_scratch': record_scratch}


def render(kind, seconds=None, pitch=1.0, seed=1):
    if kind not in GENERATORS:
        raise ValueError(f'Unknown sound {kind!r}; choose from {", ".join(KINDS)}')
    seconds = float(seconds or DEFAULT_SECONDS[kind])
    rng = np.random.default_rng(seed)
    x = GENERATORS[kind](seconds, float(pitch), rng)
    return _normalize(_edges(np.asarray(x, dtype=np.float64)), -1.0)


def write_wav(path, x):
    from scipy.io import wavfile

    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    wavfile.write(path, SR, (np.clip(x, -1, 1) * 32767).round().astype(np.int16))


def main(argv=None):
    p = argparse.ArgumentParser(description='Synthesize a sound effect to a WAV file (48 kHz stereo).')
    p.add_argument('kind', choices=list(KINDS) + ['all'])
    p.add_argument('--out', help='Output WAV (single sound)')
    p.add_argument('--out-dir', help='Output folder (with "all")')
    p.add_argument('--seconds', type=float)
    p.add_argument('--pitch', type=float, default=1.0, help='1.0 = normal; 2.0 = an octave up')
    p.add_argument('--seed', type=int, default=1)
    a = p.parse_args(argv)
    kinds = KINDS if a.kind == 'all' else (a.kind,)
    for k in kinds:
        out = a.out if a.kind != 'all' and a.out else os.path.join(a.out_dir or '.', f'{k}.wav')
        write_wav(out, render(k, a.seconds, a.pitch, a.seed))
        print(out)


if __name__ == '__main__':
    main()
