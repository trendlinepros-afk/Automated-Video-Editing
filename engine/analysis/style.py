"""Measures the editing style of a reference video, for a video theme.

    python style.py --ffmpeg FFMPEG --video VIDEO [--subs SUBS.json3|.vtt] --out-dir DIR [--max-seconds 720]

Prints one JSON line {"event": "result", "data": {...}} (or {"event": "error", ...}); progress lines before it.
Measurement only: cuts and shot lengths, speech pace from the captions, loudness, and contact sheets of the
shots so Claude can see the look (captions, graphics, zooms, B-roll, color). It makes no editing decisions.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw


def emit(event: str, **data) -> None:
    sys.stdout.write(json.dumps({'event': event, **data}) + '\n')
    sys.stdout.flush()


def flags() -> dict:
    return {'creationflags': 0x08000000} if os.name == 'nt' else {}  # CREATE_NO_WINDOW


def ffprobe_duration(ffmpeg: str, video: str) -> float:
    p = subprocess.run([ffmpeg, '-hide_banner', '-nostdin', '-i', video], stdin=subprocess.DEVNULL,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, **flags())
    m = re.search(r'Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)', p.stderr.decode('utf-8', 'replace'))
    if not m:
        raise RuntimeError('Could not read the video (no duration).')
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


# ------------------------------------------------------------------ cuts

def scene_scores(ffmpeg: str, video: str, seconds: float) -> tuple[np.ndarray, np.ndarray]:
    """Per-frame scene-change score (0..1) from ffmpeg, on a small copy of each frame."""
    args = [ffmpeg, '-hide_banner', '-nostdin', '-loglevel', 'error', '-t', f'{seconds:.3f}', '-i', video, '-an',
            '-vf', "scale=256:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score:file=-", '-f', 'null', '-']
    p = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **flags())
    if p.returncode != 0:
        raise RuntimeError('ffmpeg could not read the video: ' + p.stderr.decode('utf-8', 'replace')[-400:])
    times, scores, t = [], [], None
    for line in p.stdout.decode('utf-8', 'replace').splitlines():
        m = re.search(r'pts_time:([\d.]+)', line)
        if m:
            t = float(m.group(1))
            continue
        m = re.search(r'lavfi\.scene_score=([\d.]+)', line)
        if m and t is not None:
            times.append(t)
            scores.append(float(m.group(1)))
    return np.array(times), np.array(scores)


def find_cuts(times: np.ndarray, scores: np.ndarray) -> list[float]:
    """Hard cuts, and jump cuts in the same framing: a one-frame spike well above the motion around it."""
    cuts: list[float] = []
    n = len(scores)
    for i in range(1, n):
        s = scores[i]
        lo, hi = max(0, i - 6), min(n, i + 7)
        around = np.delete(scores[lo:hi], i - lo)
        base = float(np.median(around)) if len(around) else 0.0
        # A jump cut moves the picture once; talking and camera motion keep the score up over several frames.
        peak = s >= scores[i - 1] and (i + 1 >= n or s >= scores[i + 1])
        if s > 0.32 or (peak and s > 0.015 and s > 6 * base + 0.008):
            if not cuts or times[i] - cuts[-1] > 0.25:
                cuts.append(round(float(times[i]), 3))
    return cuts


# ------------------------------------------------------------------ speech

def read_words(path: str | None) -> list[tuple[float, str]]:
    """(start seconds, word) from YouTube captions: json3 (word timings) or WebVTT (cue timings)."""
    if not path or not os.path.exists(path):
        return []
    words: list[tuple[float, str]] = []
    if path.endswith('.json3') or path.endswith('.json'):
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        for ev in data.get('events', []):
            t0 = ev.get('tStartMs', 0) / 1000
            for seg in ev.get('segs', []) or []:
                for w in (seg.get('utf8') or '').split():
                    words.append((t0 + seg.get('tOffsetMs', 0) / 1000, w))
    else:
        text = open(path, encoding='utf-8', errors='replace').read()
        seen = set()
        for block in re.split(r'\n\s*\n', text):
            m = re.search(r'(\d+):(\d+):([\d.]+)\s+-->', block) or re.search(r'(\d+):([\d.]+)\s+-->', block)
            if not m:
                continue
            g = m.groups()
            t0 = int(g[0]) * 3600 + int(g[1]) * 60 + float(g[2]) if len(g) == 3 else int(g[0]) * 60 + float(g[1])
            body = re.sub(r'<[^>]+>', '', block.split('\n', 1)[1] if '\n' in block else '')
            for line in body.splitlines():
                line = line.strip()
                if line and '-->' not in line and line not in seen:
                    seen.add(line)  # rolling auto-captions repeat lines
                    words.extend((t0, w) for w in line.split())
    words.sort(key=lambda x: x[0])
    return words


def speech_stats(words: list[tuple[float, str]], seconds: float) -> dict:
    words = [w for w in words if w[0] < seconds and not re.fullmatch(r'\[.*\]', w[1])]
    if len(words) < 10:
        return {}
    t = np.array([w[0] for w in words])
    gaps = np.diff(t)
    speaking = float(np.sum(np.minimum(gaps, 1.0)))  # gaps over 1 s count as silence
    hook = ' '.join(w for s, w in words if s < 15)
    return {
        'wordsPerMinute': round(len(words) / max(speaking, 1) * 60, 1),
        'speechShare': round(min(1.0, speaking / seconds), 3),
        'longPausesPerMinute': round(float(np.sum(gaps > 1.0)) / (seconds / 60), 2),
        'firstWords': hook[:400],
    }


# ------------------------------------------------------------------ loudness

def loudness(ffmpeg: str, video: str, seconds: float) -> float | None:
    p = subprocess.run([ffmpeg, '-hide_banner', '-nostdin', '-t', f'{seconds:.3f}', '-i', video, '-vn', '-af', 'ebur128', '-f', 'null', '-'],
                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **flags())
    m = re.findall(r'I:\s*(-?[\d.]+) LUFS', p.stderr.decode('utf-8', 'replace'))
    return float(m[-1]) if m else None


# ------------------------------------------------------------------ contact sheets

def grab(ffmpeg: str, video: str, t: float, width: int = 320) -> Image.Image | None:
    p = subprocess.run([ffmpeg, '-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', f'{t:.3f}', '-i', video, '-frames:v', '1',
                        '-vf', f'scale={width}:-2', '-f', 'image2pipe', '-vcodec', 'png', '-'],
                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **flags())
    if p.returncode != 0 or not p.stdout:
        return None
    from io import BytesIO
    return Image.open(BytesIO(p.stdout)).convert('RGB')


def sheet(frames: list[tuple[float, Image.Image]], out: str, cols: int = 4) -> None:
    w, h = frames[0][1].size
    rows = (len(frames) + cols - 1) // cols
    img = Image.new('RGB', (cols * w, rows * (h + 18)), (16, 16, 16))
    d = ImageDraw.Draw(img)
    for i, (t, f) in enumerate(frames):
        x, y = (i % cols) * w, (i // cols) * (h + 18)
        img.paste(f.resize((w, h)), (x, y + 18))
        d.text((x + 4, y + 3), f'{int(t // 60)}:{t % 60:04.1f}', fill=(230, 230, 230))
    img.save(out, quality=82)


def contact_sheets(ffmpeg: str, video: str, cuts: list[float], seconds: float, out_dir: str, prefix: str) -> list[dict]:
    """Sheet 1: one frame from each shot in the first minute (the hook). Sheet 2: the rest, evenly spaced."""
    bounds = [0.0] + cuts + [seconds]
    first = [((a + b) / 2) for a, b in zip(bounds, bounds[1:]) if a < 60][:24]
    rest_n = 16
    rest = [60 + (seconds - 60) * (i + 0.5) / rest_n for i in range(rest_n)] if seconds > 90 else []
    sheets = []
    for name, ts, what in (('hook', first, 'one frame from each shot in the first minute'),
                           ('body', rest, f'{len(rest)} frames spread over the rest')):
        frames = [(t, f) for t in ts if (f := grab(ffmpeg, video, t)) is not None]
        if not frames:
            continue
        path = os.path.join(out_dir, f'{prefix}-{name}.jpg')
        sheet(frames, path)
        sheets.append({'file': os.path.basename(path), 'label': what})
    return sheets


# ------------------------------------------------------------------ main

def analyze(a) -> dict:
    duration = ffprobe_duration(a.ffmpeg, a.video)
    seconds = min(duration, a.max_seconds)
    emit('progress', message='Finding the cuts', done=1, total=4)
    times, scores = scene_scores(a.ffmpeg, a.video, seconds)
    cuts = find_cuts(times, scores)
    bounds = [0.0] + cuts + [seconds]
    shots = np.diff(np.array(bounds))
    per_min = lambda lo, hi: round(sum(1 for c in cuts if lo <= c < hi) / max((min(hi, seconds) - lo) / 60, 1 / 60), 1)
    pace = [{'from': int(m * 60), 'cutsPerMinute': per_min(m * 60, (m + 1) * 60)} for m in range(int(np.ceil(seconds / 60)))]
    emit('progress', message='Reading the speech pace', done=2, total=4)
    speech = speech_stats(read_words(a.subs), seconds)
    emit('progress', message='Measuring loudness', done=3, total=4)
    lufs = loudness(a.ffmpeg, a.video, seconds)
    emit('progress', message='Making contact sheets', done=4, total=4)
    os.makedirs(a.out_dir, exist_ok=True)
    sheets = contact_sheets(a.ffmpeg, a.video, cuts, seconds, a.out_dir, a.prefix)
    return {
        'duration': round(duration, 2),
        'analyzedSeconds': round(seconds, 2),
        'cuts': len(cuts),
        'cutsPerMinute': round(len(cuts) / (seconds / 60), 1),
        'cutsPerMinuteFirst30s': per_min(0, 30),
        'cutsPerMinuteFirst60s': per_min(0, 60),
        'shotSeconds': {
            'median': round(float(np.median(shots)), 2),
            'mean': round(float(np.mean(shots)), 2),
            'p10': round(float(np.percentile(shots, 10)), 2),
            'p90': round(float(np.percentile(shots, 90)), 2),
        },
        'pace': pace,
        'cutTimes': cuts[:400],
        **({'speech': speech} if speech else {}),
        **({'loudnessLufs': round(lufs, 1)} if lufs is not None else {}),
        'sheets': sheets,
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument('--ffmpeg', default='ffmpeg')
    p.add_argument('--video', required=True)
    p.add_argument('--subs')
    p.add_argument('--out-dir', required=True)
    p.add_argument('--prefix', default='sheet')
    p.add_argument('--max-seconds', type=float, default=720)
    a = p.parse_args()
    try:
        emit('result', data=analyze(a))
    except Exception as e:  # noqa: BLE001
        emit('error', message=str(e) or e.__class__.__name__)
        sys.exit(1)


if __name__ == '__main__':
    main()
