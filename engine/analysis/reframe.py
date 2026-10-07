"""Where the subject is, over time, for reframing wide footage to a vertical Short.

    python reframe.py --ffmpeg FFMPEG --segments SEGMENTS.json

SEGMENTS.json: [{"path": ..., "in": seconds, "out": seconds}, ...]. Prints one JSON line
{"event": "result", "data": [{"points": [{"t": seconds from the segment start, "x": 0..1, "y": 0..1}], "found": "face"|"motion"|"none"}]}
x and y are the subject's centre as a fraction of the source frame. A face wins; otherwise the main motion; otherwise the
centre. The path is smoothed and only moves when the subject really moves, so the crop does not wobble.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

import numpy as np

STEP = 0.5  # seconds between samples
W = 320     # analysis width


def emit(event: str, **data) -> None:
    sys.stdout.write(json.dumps({'event': event, **data}) + '\n')
    sys.stdout.flush()


def frames(ffmpeg: str, path: str, start: float, dur: float) -> tuple[np.ndarray, int, int]:
    probe = subprocess.run([ffmpeg, '-hide_banner', '-nostdin', '-i', path], capture_output=True, **({'creationflags': 0x08000000} if os.name == 'nt' else {}))
    import re
    m = re.search(r', (\d{2,5})x(\d{2,5})', probe.stderr.decode('utf-8', 'replace'))
    sw, sh = (int(m.group(1)), int(m.group(2))) if m else (16, 9)
    h = max(2, int(round(W * sh / sw / 2)) * 2)
    p = subprocess.run([ffmpeg, '-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', f'{start:.3f}', '-t', f'{max(dur, STEP):.3f}', '-i', path,
                        '-an', '-vf', f'fps={1 / STEP},scale={W}:{h}', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
                       capture_output=True, **({'creationflags': 0x08000000} if os.name == 'nt' else {}))
    if p.returncode != 0:
        raise RuntimeError('ffmpeg could not read ' + os.path.basename(path) + ': ' + p.stderr.decode('utf-8', 'replace')[-300:])
    data = np.frombuffer(p.stdout, np.uint8)
    n = len(data) // (W * h)
    return data[: n * W * h].reshape(n, h, W), W, h


def detector():
    try:
        import cv2
        c = cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, 'haarcascade_frontalface_default.xml'))
        return None if c.empty() else c
    except Exception:  # noqa: BLE001
        return None


def subject_path(fr: np.ndarray, w: int, h: int, faces) -> tuple[list[tuple[float, float]], str]:
    raw: list[tuple[float, float] | None] = []
    kinds = set()
    prev = None
    for f in fr:
        point = None
        if faces is not None:
            found = faces.detectMultiScale(f, scaleFactor=1.15, minNeighbors=5, minSize=(max(12, h // 12), max(12, h // 12)))
            if len(found):
                x, y, fw, fh = max(found, key=lambda r: r[2] * r[3])
                point = ((x + fw / 2) / w, (y + fh / 2) / h)
                kinds.add('face')
        if point is None and prev is not None:
            diff = np.abs(f.astype(np.int16) - prev.astype(np.int16)) > 25
            if diff.mean() > 0.004:
                ys, xs = np.nonzero(diff)
                point = (float(xs.mean()) / w, float(ys.mean()) / h)
                kinds.add('motion')
        raw.append(point)
        prev = f
    # Fill gaps with the last known point (or the centre), then smooth and hold still unless the subject moves.
    filled, last = [], (0.5, 0.5)
    for p in raw:
        last = p or last
        filled.append(last)
    if not filled:
        return [(0.5, 0.5)], 'none'
    xs = np.array([p[0] for p in filled])
    ys = np.array([p[1] for p in filled])
    k = 2
    xs = np.array([np.median(xs[max(0, i - k): i + k + 1]) for i in range(len(xs))])
    ys = np.array([np.median(ys[max(0, i - k): i + k + 1]) for i in range(len(ys))])
    out, cur = [], (float(xs[0]), float(ys[0]))
    for x, y in zip(xs, ys):
        if abs(x - cur[0]) > 0.06 or abs(y - cur[1]) > 0.08:
            cur = (cur[0] + (x - cur[0]) * 0.6, cur[1] + (y - cur[1]) * 0.6)
        out.append((round(cur[0], 4), round(cur[1], 4)))
    return out, 'face' if 'face' in kinds else 'motion' if 'motion' in kinds else 'none'


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument('--ffmpeg', default='ffmpeg')
    p.add_argument('--segments', required=True)
    a = p.parse_args()
    try:
        segs = json.load(open(a.segments, encoding='utf-8'))
        faces = detector()
        result = []
        for i, s in enumerate(segs):
            emit('progress', message=f'Finding the subject ({i + 1} of {len(segs)})', done=i, total=len(segs))
            fr, w, h = frames(a.ffmpeg, s['path'], float(s['in']), float(s['out']) - float(s['in']))
            pts, found = subject_path(fr, w, h, faces) if len(fr) else ([(0.5, 0.5)], 'none')
            result.append({'points': [{'t': round(j * STEP, 3), 'x': x, 'y': y} for j, (x, y) in enumerate(pts)], 'found': found})
        emit('result', data=result)
    except Exception as e:  # noqa: BLE001
        emit('error', message=str(e) or e.__class__.__name__)
        sys.exit(1)


if __name__ == '__main__':
    main()
