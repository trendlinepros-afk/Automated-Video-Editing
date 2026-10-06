"""The mixer.

The whole timeline is always mixed first, its loudness measured, and ONE master gain chosen to hit
the target (or plan.audio.masterGainDb when set). A true-peak-safe limiter follows. Only then is the
requested range cut out, so a preview, a section export and a full export all share one level.

Buses: voice (A-roll audio and audio on A-roll tracks), music, sfx (sound effects and B-roll sound).
Voice clean-up: 80 Hz high-pass, gentle de-essing and compression, and a fast limiter that catches
mic handling bumps. Music with duck=true sits mix.musicUnderSpeechDb under speech.

Smoothing uses hold-then-average envelopes (a minimum/maximum filter followed by moving averages
that fit inside the hold), which never lets a peak through and needs no per-sample Python loop.
"""
from __future__ import annotations

import hashlib
import json
import math
import os

import numpy as np
from scipy.ndimage import maximum_filter1d, minimum_filter1d, uniform_filter1d
from scipy.signal import butter, sosfilt

from . import VERSION, media
from .loudness import measure, true_peak_envelope

DECLICK = 0.003  # seconds of fade at every clip edge so cuts never click
FRAME = 480  # 10 ms analysis frames at 48 kHz


def db(x: float) -> float:
    return 20 * math.log10(x) if x > 0 else -math.inf


def undb(d: float) -> float:
    return 10 ** (d / 20)


def plan_duration(plan: dict) -> float:
    """Same as planDuration in src/main/engine/plan.ts: A-roll plus anything placed past it (not music)."""
    d = float(plan.get('duration') or 0)
    for l in plan.get('layers') or []:
        d = max(d, float(l.get('end') or 0))
    for a in (plan.get('audio') or {}).get('clips') or []:
        if a.get('role') != 'music':
            d = max(d, float(a.get('end') or 0))
    return d


# ---------------------------------------------------------------------------------------------
# envelopes

def smooth_min(g: np.ndarray, hold: int, avg: int) -> np.ndarray:
    """Hold minima for `hold` samples either side, then average over `avg` (<= hold) samples.
    The result never exceeds g at any point, so a gain built from it is peak safe."""
    hold = max(1, hold)
    avg = max(1, min(avg, hold))
    h = minimum_filter1d(g, size=2 * hold + 1, mode='nearest')
    s = uniform_filter1d(h, size=avg, mode='nearest')
    return uniform_filter1d(s, size=max(1, avg // 2), mode='nearest')


def trailing_max(x: np.ndarray, size: int) -> np.ndarray:
    """max(x[i - size + 1 .. i])"""
    size = max(1, size)
    return maximum_filter1d(x, size=size, origin=(size - 1) // 2, mode='nearest')


def frame_rms_db(x: np.ndarray, frame: int = FRAME) -> np.ndarray:
    """RMS in dBFS per `frame` samples of a mono signal."""
    n = len(x) // frame
    if n == 0:
        return np.zeros(0)
    m = x[: n * frame].reshape(n, frame)
    rms = np.sqrt(np.mean(m * m, axis=1) + 1e-20)
    return 20 * np.log10(rms)


def frames_to_samples(g: np.ndarray, n: int, frame: int = FRAME) -> np.ndarray:
    """Per-frame values interpolated to per-sample (values sit at frame centres)."""
    if len(g) == 0:
        return np.ones(n, dtype=np.float32)
    centres = (np.arange(len(g)) + 0.5) * frame
    return np.interp(np.arange(n), centres, g).astype(np.float32)


# ---------------------------------------------------------------------------------------------
# processors

def limiter(x: np.ndarray, ceiling_db: float, sr: int = 48000, window_ms: float = 8.0) -> np.ndarray:
    """True-peak-safe limiter: gain reduction starts ahead of each peak and releases smoothly."""
    if not len(x):
        return x
    ceiling = undb(ceiling_db)
    out = x
    for _ in range(4):
        tp = true_peak_envelope(out)
        if tp.max() <= ceiling:
            break
        need = np.minimum(1.0, (ceiling * 0.985) / np.maximum(tp, 1e-9)).astype(np.float32)
        w = int(sr * window_ms / 1000)
        g = smooth_min(need, w, w)
        out = (out * g[:, None]).astype(np.float32)
    return out


def peak_limit(x: np.ndarray, ceiling: float, sr: int = 48000) -> np.ndarray:
    """Fast sample-peak limiter (for mic bumps on the voice)."""
    if not len(x):
        return x
    pk = np.abs(x).max(axis=1)
    if pk.max() <= ceiling:
        return x
    need = np.minimum(1.0, ceiling / np.maximum(pk, 1e-9)).astype(np.float32)
    w = int(sr * 0.004)
    g = smooth_min(need, w * 4, w * 4)
    return (x * g[:, None]).astype(np.float32)


def speech_level_db(mono: np.ndarray) -> float | None:
    """Typical loud-speech level (90th percentile of 10 ms RMS over non-silent frames)."""
    r = frame_rms_db(mono)
    r = r[r > -60]
    if len(r) < 10:
        return None
    return float(np.percentile(r, 90))


def compress(x: np.ndarray, threshold_db: float, ratio: float, sr: int = 48000) -> np.ndarray:
    mono = x.mean(axis=1)
    lvl = frame_rms_db(mono)
    if not len(lvl):
        return x
    over = np.maximum(0.0, lvl - threshold_db)
    gr = -over * (1 - 1 / ratio)  # dB, <= 0
    g = np.power(10.0, gr / 20)
    g = smooth_min(g.astype(np.float32), 3, 3)  # ~30 ms
    return (x * frames_to_samples(g, len(x))[:, None]).astype(np.float32)


def deess(x: np.ndarray, sr: int = 48000) -> np.ndarray:
    """Turn down harsh 5.5-9 kHz sibilance when it dominates the voice."""
    sos = butter(2, [5500, 9000], btype='bandpass', fs=sr, output='sos')
    band = sosfilt(sos, x, axis=0).astype(np.float32)
    full = frame_rms_db(x.mean(axis=1))
    sib = frame_rms_db(band.mean(axis=1))
    if not len(full):
        return x
    excess = np.maximum(0.0, sib - (full - 8.0))
    red_db = -np.minimum(8.0, excess * 0.6)
    keep = np.power(10.0, red_db / 20).astype(np.float32)
    keep = smooth_min(keep, 2, 2)
    k = frames_to_samples(keep, len(x))[:, None]
    return (x - band * (1 - k)).astype(np.float32)


def voice_cleanup(x: np.ndarray, sr: int = 48000) -> np.ndarray:
    if not len(x) or not np.any(x):
        return x
    sos = butter(4, 80, btype='highpass', fs=sr, output='sos')
    y = sosfilt(sos, x, axis=0).astype(np.float32)
    lvl = speech_level_db(y.mean(axis=1))
    if lvl is None:
        return y
    # Bumps and pops far above normal speech are caught first, then gentle levelling and de-essing.
    y = peak_limit(y, undb(lvl + 12))
    y = compress(y, lvl - 8, 2.5, sr)
    y = deess(y, sr)
    return y


def duck_gain(voice: np.ndarray, amount_db: float, sr: int = 48000) -> np.ndarray:
    """Per-sample gain for ducked music: amount_db under speech, 0 dB elsewhere, smooth attack/release."""
    n = len(voice)
    if n == 0:
        return np.ones(0, np.float32)
    mono = voice.mean(axis=1)
    lvl = frame_rms_db(mono)
    if not len(lvl):
        return np.ones(n, np.float32)
    ref = speech_level_db(mono)
    if ref is None:
        return np.ones(n, np.float32)
    thr = max(-55.0, ref - 26.0)
    present = np.clip((lvl - thr) / 6.0, 0.0, 1.0)
    # Hold through short pauses between words (release ~350 ms), dip slightly before speech (~60 ms).
    held = trailing_max(present, 35)
    ahead = np.concatenate([held[6:], np.repeat(held[-1:], 6)]) if len(held) > 6 else held
    held = np.maximum(held, ahead)
    smooth = uniform_filter1d(uniform_filter1d(held, size=12, mode='nearest'), size=12, mode='nearest')
    gain_db = -abs(amount_db) * smooth
    return frames_to_samples(np.power(10.0, gain_db / 20), n)


def fade_curve(n: int) -> np.ndarray:
    """0 -> 1 over n samples (sine-squared, so fades in and out sum to one)."""
    if n <= 0:
        return np.ones(0, np.float32)
    x = (np.arange(n, dtype=np.float32) + 0.5) / n
    return np.sin(0.5 * math.pi * x) ** 2


def apply_fades(a: np.ndarray, fade_in: int, fade_out: int) -> np.ndarray:
    n = len(a)
    fi = min(n, max(0, fade_in))
    fo = min(n, max(0, fade_out))
    if fi:
        a[:fi] *= fade_curve(fi)[:, None]
    if fo:
        a[n - fo:] *= fade_curve(fo)[::-1, None]
    return a


# ---------------------------------------------------------------------------------------------
# clip rendering

class SourceCache:
    """Whole-file decodes of sources used by many clips (an A-roll file cut into many segments)."""

    def __init__(self, sr: int, clips: list[dict]):
        self.sr = sr
        self.counts: dict[str, int] = {}
        for c in clips:
            if abs((c.get('speed') or 1) - 1) < 1e-6:
                self.counts[c['path']] = self.counts.get(c['path'], 0) + 1
        self.data: dict[str, np.ndarray] = {}

    def whole(self, path: str) -> np.ndarray:
        if path not in self.data:
            self.data[path] = media.decode_audio(path, sr=self.sr)
        return self.data[path]

    def get(self, path: str, start: float, dur: float, speed: float, loop: bool) -> np.ndarray:
        sr = self.sr
        n = max(0, int(round(dur * sr)))
        if loop:
            src = self.whole(path)
            s0 = int(round(start * sr))
            src = src[s0:] if s0 < len(src) else src[:0]
            if not len(src):
                return np.zeros((n, 2), np.float32)
            return loop_to(src, n, sr)
        if abs(speed - 1) < 1e-6 and (self.counts.get(path, 0) >= 3 or path in self.data):
            src = self.whole(path)
            s0 = int(round(start * sr))
            seg = src[s0:s0 + n]
        else:
            seg = media.decode_audio(path, start=start, duration=dur * speed + 0.05, sr=sr, tempo=speed)[:n]
        if len(seg) < n:
            seg = np.concatenate([seg, np.zeros((n - len(seg), 2), np.float32)])
        return np.array(seg, dtype=np.float32, copy=True)

    def release(self, path: str) -> None:
        self.data.pop(path, None)


def loop_to(src: np.ndarray, n: int, sr: int) -> np.ndarray:
    """Repeat src to n samples with a short crossfade at each seam."""
    if len(src) >= n:
        return np.array(src[:n], dtype=np.float32, copy=True)
    xf = min(int(0.03 * sr), len(src) // 4)
    out = np.zeros((n, src.shape[1]), np.float32)
    pos = 0
    first = True
    while pos < n:
        piece = np.array(src, dtype=np.float32, copy=True)
        if not first and xf:
            piece[:xf] *= fade_curve(xf)[:, None]
        if xf:
            piece[len(piece) - xf:] *= fade_curve(xf)[::-1, None]
        take = min(len(piece), n - pos)
        out[pos:pos + take] += piece[:take]
        pos += len(piece) - xf if xf else len(piece)
        first = False
    return out


def render_clip(cache: SourceCache, clip: dict, sr: int) -> tuple[int, np.ndarray]:
    start, end = float(clip['start']), float(clip['end'])
    dur = max(0.0, end - start)
    speed = float(clip.get('speed') or 1)
    a = cache.get(clip['path'], float(clip.get('sourceIn') or 0), dur, speed, bool(clip.get('loop')))
    g = undb(float(clip.get('gainDb') or 0))
    if g != 1:
        a *= g
    fi = max(int(round(float(clip.get('fadeIn') or 0) * sr)), int(DECLICK * sr))
    fo = max(int(round(float(clip.get('fadeOut') or 0) * sr)), int(DECLICK * sr))
    apply_fades(a, fi, fo)
    return int(round(start * sr)), a


def add_into(bus: np.ndarray, pos: int, a: np.ndarray) -> None:
    if pos >= len(bus) or not len(a):
        return
    if pos < 0:
        a = a[-pos:]
        pos = 0
    n = min(len(a), len(bus) - pos)
    bus[pos:pos + n] += a[:n]


# ---------------------------------------------------------------------------------------------
# the mix

def cache_key(plan: dict, dialogue_only: bool) -> str:
    audio = plan.get('audio') or {}
    sigs = sorted({json.dumps(media.file_signature(c['path'])) for c in audio.get('clips') or []})
    blob = json.dumps({'v': VERSION, 'audio': audio, 'duration': plan_duration(plan), 'dlg': dialogue_only,
                       'sources': sigs}, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()[:24]


def build_buses(plan: dict, dialogue_only: bool, sr: int, log=None) -> dict[str, np.ndarray]:
    audio = plan.get('audio') or {}
    mix = audio.get('mix') or {}
    total = int(math.ceil(plan_duration(plan) * sr))
    clips = [c for c in audio.get('clips') or [] if float(c.get('end', 0)) > float(c.get('start', 0))]
    if dialogue_only:
        clips = [c for c in clips if c.get('role') == 'voice']
    voice = np.zeros((total, 2), np.float32)
    music = np.zeros((total, 2), np.float32)
    music_duck = np.zeros((total, 2), np.float32)
    sfx = np.zeros((total, 2), np.float32)
    cache = SourceCache(sr, clips)
    # Group by file so a whole-file decode is freed as soon as its clips are placed.
    by_path: dict[str, list[dict]] = {}
    for c in clips:
        by_path.setdefault(c['path'], []).append(c)
    for path, group in by_path.items():
        if not os.path.exists(path):
            if log:
                log(f'Audio file not found, skipped: {path}', 'warn')
            continue
        for c in group:
            pos, a = render_clip(cache, c, sr)
            role = c.get('role')
            if role == 'voice':
                add_into(voice, pos, a)
            elif role == 'music':
                add_into(music_duck if c.get('duck') else music, pos, a)
            else:
                add_into(sfx, pos, a)
        cache.release(path)
    if mix.get('voiceCleanup', True):
        voice = voice_cleanup(voice, sr)
    if np.any(music_duck):
        amount = float(mix.get('musicUnderSpeechDb', -15) if mix.get('musicUnderSpeechDb') is not None else -15)
        music_duck *= duck_gain(voice, amount, sr)[:, None]
    music += music_duck
    return {'voice': voice, 'music': music, 'sfx': sfx}


def full_mix(plan: dict, dialogue_only: bool = False, want_stems: bool = False, log=None) -> dict:
    """Mix (or load from cache) the whole timeline. Returns {mix, stems?, lufs, truePeakDb, masterGainDb, sr}."""
    audio = plan.get('audio') or {}
    mix_settings = audio.get('mix') or {}
    sr = int(audio.get('sampleRate') or 48000)
    project_dir = plan.get('projectDir') or ''
    key = cache_key(plan, dialogue_only)
    cdir = os.path.join(project_dir, 'cache', 'audio') if project_dir else None
    stem_names = ('music', 'sfx', 'voice')
    if cdir:
        meta_p = os.path.join(cdir, f'mix-{key}.json')
        mix_p = os.path.join(cdir, f'mix-{key}.npy')
        if os.path.exists(meta_p) and os.path.exists(mix_p):
            try:
                with open(meta_p, encoding='utf-8') as f:
                    meta = json.load(f)
                stems = None
                if want_stems:
                    paths = {n: os.path.join(cdir, f'mix-{key}-{n}.npy') for n in stem_names}
                    if all(os.path.exists(p) for p in paths.values()):
                        stems = {n: np.load(p, mmap_mode='r') for n, p in paths.items()}
                if not want_stems or stems is not None:
                    return {**meta, 'mix': np.load(mix_p, mmap_mode='r'), 'stems': stems, 'cached': True}
            except (OSError, ValueError):
                pass

    buses = build_buses(plan, dialogue_only, sr, log)
    total = buses['voice'] + buses['music'] + buses['sfx']
    lufs_pre, _ = measure(total, sr)
    target = float(mix_settings.get('targetLufs', -14) if mix_settings.get('targetLufs') is not None else -14)
    fixed = audio.get('masterGainDb')
    if fixed is not None and not dialogue_only:
        gain_db = float(fixed)
    elif math.isfinite(lufs_pre):
        gain_db = target - lufs_pre
    else:
        gain_db = 0.0
    tp_ceiling = float(mix_settings.get('truePeakDb', -1) if mix_settings.get('truePeakDb') is not None else -1)
    use_limiter = bool(mix_settings.get('limiter', True))
    measured_gain = fixed is None or dialogue_only
    for attempt in range(4):
        gain_db = max(-60.0, min(40.0, gain_db))
        out = total * undb(gain_db)
        if use_limiter:
            out = limiter(out, tp_ceiling, sr)
        out = out.astype(np.float32)
        lufs, tp = measure(out, sr)
        # The limiter takes a little level off loud mixes; nudge the one master gain to land on target.
        if (attempt == 3 or not measured_gain or not use_limiter or not math.isfinite(lufs)
                or abs(target - lufs) < 0.05):
            break
        gain_db += target - lufs
    g = undb(gain_db)
    meta = {'lufs': lufs, 'truePeakDb': tp, 'masterGainDb': gain_db, 'sr': sr}
    stems = {n: (buses[n] * g).astype(np.float32) for n in stem_names} if want_stems else None
    if cdir:
        try:
            os.makedirs(cdir, exist_ok=True)
            _prune(cdir)
            _save_npy(os.path.join(cdir, f'mix-{key}.npy'), out)
            if stems:
                for n, a in stems.items():
                    _save_npy(os.path.join(cdir, f'mix-{key}-{n}.npy'), a)
            with open(os.path.join(cdir, f'mix-{key}.json'), 'w', encoding='utf-8') as f:
                json.dump({k: (v if not isinstance(v, float) or math.isfinite(v) else None) for k, v in meta.items()}, f)
        except OSError as e:
            if log:
                log(f'Could not write the audio cache: {e}', 'warn')
    return {**meta, 'mix': out, 'stems': stems, 'cached': False}


def _save_npy(path: str, a: np.ndarray) -> None:
    tmp = path + '.part'
    with open(tmp, 'wb') as f:
        np.save(f, a)
    media.replace_file(tmp, path)


def _prune(cdir: str, keep: int = 6) -> None:
    """Keep the cache to the most recent few mixes."""
    try:
        metas = sorted((os.path.getmtime(os.path.join(cdir, f)), f) for f in os.listdir(cdir) if f.endswith('.json'))
    except OSError:
        return
    for _, f in metas[:-keep] if len(metas) > keep else []:
        stem = f[:-5]
        for g in os.listdir(cdir):
            if g.startswith(stem):
                try:
                    os.remove(os.path.join(cdir, g))
                except OSError:
                    pass


def slice_audio(a: np.ndarray, sr: int, start: float | None, end: float | None, fade: float) -> np.ndarray:
    """[start, end) of a full-timeline signal, with clean fades where the slice cuts into it."""
    total = len(a)
    s = 0 if start is None else max(0, int(round(start * sr)))
    e = total if end is None else int(round(end * sr))
    n = max(0, e - s)
    out = np.zeros((n, a.shape[1]), np.float32)
    avail = max(0, min(total, e) - s)
    if avail:
        out[:avail] = a[s:s + avail]
    f = int(round(max(0.0, fade) * sr))
    fi = f if s > 0 else 0
    fo = f if e < total else 0
    return apply_fades(out, fi, fo)
