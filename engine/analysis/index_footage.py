"""A footage index: the shots of one video file and what each looks like, measured once so Claude can pick from a list.

    python index_footage.py --ffmpeg FFMPEG --video VIDEO --out-dir DIR [--fps 4] [--width 320] [--threads 0] [--hwaccel auto|none]

Prints one JSON line {"event": "result", "data": {...}} (or {"event": "error", ...}); progress lines before it.
The video is decoded once, small (320 px wide, 4 frames a second). Shots are split at hard cuts, where the view drifts
far from how the shot began (a long pan in raw footage), and every 10 s at most. For each shot: sharpness, motion,
camera movement and shake, brightness, main colours, faces, where the subject is and the best still (sharp, little
motion), saved as a small JPEG in DIR. Sound: loudness for every second. Measurement only: no editing decisions.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time

import numpy as np

MAX_SHOT = 10.0    # seconds: longer takes are split so each piece can be picked on its own
DRIFT_MIN = 3.0    # seconds: a drift split needs at least this much shot before it
EDGE = 0.3         # seconds: the best still keeps this far from a cut (cut times are only as exact as 1/fps)


def emit(event: str, **data) -> None:
    sys.stdout.write(json.dumps({'event': event, **data}) + '\n')
    sys.stdout.flush()


def flags() -> dict:
    return {'creationflags': 0x08000000} if os.name == 'nt' else {}  # CREATE_NO_WINDOW


def probe(ffmpeg: str, video: str) -> tuple[float, int, int, bool]:
    """Duration, picture size and whether there is sound, from ffmpeg's own description of the file."""
    p = subprocess.run([ffmpeg, '-hide_banner', '-nostdin', '-i', video], stdin=subprocess.DEVNULL,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, **flags())
    text = p.stderr.decode('utf-8', 'replace')
    m = re.search(r'Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)', text)
    if not m:
        raise RuntimeError('Could not read the video (no duration).')
    duration = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    v = re.search(r'Stream #.*Video:.*?, (\d{2,5})x(\d{2,5})', text)
    if not v:
        raise RuntimeError('The file has no video stream.')
    w, h = int(v.group(1)), int(v.group(2))
    rot = re.search(r'rotation of (-?\d+(?:\.\d+)?) degrees|rotate\s*:\s*(-?\d+)', text)
    if rot and abs(float(rot.group(1) or rot.group(2))) % 180 == 90:
        w, h = h, w  # phone footage shot upright; ffmpeg turns it when decoding
    return duration, w, h, bool(re.search(r'Stream #.*Audio:', text))


# ------------------------------------------------------------------ sound

def loudness_per_second(ffmpeg: str, video: str) -> list[float]:
    """RMS loudness in dBFS for each second, from mono 8 kHz samples (cheap to decode)."""
    p = subprocess.run([ffmpeg, '-hide_banner', '-nostdin', '-loglevel', 'error', '-i', video, '-vn', '-ac', '1', '-ar', '8000',
                        '-f', 's16le', '-'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **flags())
    if p.returncode != 0 or not p.stdout:
        return []
    a = np.frombuffer(p.stdout, np.int16).astype(np.float32) / 32768.0
    n = int(np.ceil(len(a) / 8000))
    out = []
    for i in range(n):
        s = a[i * 8000:(i + 1) * 8000]
        rms = float(np.sqrt(np.mean(s * s))) if len(s) else 0.0
        out.append(round(max(-90.0, 20 * np.log10(rms + 1e-9)), 1))
    return out


# ------------------------------------------------------------------ picture

def open_frames(ffmpeg: str, video: str, fps: float, w: int, h: int, threads: int, hwaccel: str) -> subprocess.Popen:
    args = [ffmpeg, '-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', str(threads)]
    if hwaccel != 'none':
        args += ['-hwaccel', hwaccel]
    # Frames nothing else refers to (most B-frames) are skipped and so is the deblocking filter: at 4 small frames a
    # second neither is missed, and decoding is most of the cost on 4K footage.
    args += ['-skip_frame', 'noref', '-skip_loop_filter', 'all', '-i', video, '-an', '-sn', '-dn',
             '-vf', f'fps={fps},scale={w}:{h}:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']
    return subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=w * h * 3 * 4, **flags())


def face_detector(w: int, h: int, model: str | None):
    """A function giving the faces in a frame as (x, y, w, h) boxes, or None when no detector is available.

    The Haar face cascade when OpenCV has it (OpenCV 4). OpenCV 5 no longer ships the cascades; then a YuNet model
    file (--face-model, an .onnx from the OpenCV model zoo; by default models/face_detection_yunet_2023mar.onnx next
    to this script) is used when it is there. Without either, faces are
    not checked and the result says so (facesChecked: false).
    """
    try:
        import cv2
    except Exception:  # noqa: BLE001
        return None
    if hasattr(cv2, 'CascadeClassifier') and hasattr(cv2, 'data'):
        c = cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, 'haarcascade_frontalface_default.xml'))
        if not c.empty():
            size = (max(14, h // 14), max(14, h // 14))
            return lambda rgb, gray: [tuple(int(v) for v in r) for r in c.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=5, minSize=size)]
    if model and os.path.exists(model) and hasattr(cv2, 'FaceDetectorYN'):
        try:
            det = cv2.FaceDetectorYN.create(model, '', (w, h), 0.7, 0.3, 50)
            det.setInputSize((w, h))
        except Exception:  # noqa: BLE001
            return None

        def yunet(rgb: np.ndarray, gray: np.ndarray) -> list:
            _, found = det.detect(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
            return [] if found is None else [tuple(int(v) for v in r[:4]) for r in found]
        return yunet
    return None


def colour_hist(rgb: np.ndarray) -> np.ndarray:
    """Hue/saturation/value histogram, normalised: what a cut changes and a moving subject mostly does not."""
    import cv2
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    hist = cv2.calcHist([hsv], [0, 1, 2], None, [16, 4, 4], [0, 180, 0, 256, 0, 256]).flatten()
    return hist / max(1.0, float(hist.sum()))


def hist_distance(a: np.ndarray, b: np.ndarray) -> float:
    """Bhattacharyya distance between two normalised histograms: 0 the same, 1 nothing in common."""
    bc = float(np.sum(np.sqrt(a * b)))
    return float(np.sqrt(max(0.0, 1.0 - bc)))


class Frame:
    __slots__ = ('t', 'sharp', 'bright', 'diff', 'shift', 'hist', 'face')

    def __init__(self, t: float):
        self.t = t
        self.sharp = 0.0
        self.bright = 0.0
        self.diff = 0.0       # change from the frame before, after following the camera (subject motion)
        self.shift = (0.0, 0.0)  # camera movement from the frame before, as a fraction of the width
        self.hist = None
        self.face = 0.0       # largest face as a share of the picture; -1 when not checked


class Shot:
    def __init__(self, start_index: int, boundary: str):
        self.first = start_index
        self.boundary = boundary  # why this shot starts: start, cut, drift (the view changed) or length
        self.frames: list[Frame] = []
        self.best: tuple[float, int, np.ndarray | None] = (-1e9, -1, None)
        self.heat = None
        self.faces = 0
        self.face_share = 0.0
        self.face_box = None


def best_score(f: Frame) -> float:
    """A good still: sharp, little motion or camera movement, not too dark or blown out."""
    move = abs(f.shift[0]) + abs(f.shift[1])
    exposure = 1.0 - min(1.0, abs(f.bright - 0.5) * 2.2)
    return float(np.log1p(f.sharp)) - 12.0 * f.diff - 20.0 * move + 0.8 * exposure


def dominant_colours(rgb: np.ndarray, k: int = 3) -> list[str]:
    import cv2
    small = cv2.resize(rgb, (48, 27), interpolation=cv2.INTER_AREA).reshape(-1, 3).astype(np.float32)
    k = min(k, len(np.unique(small.astype(np.uint8), axis=0)))
    if k < 1:
        return []
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 10, 1.0)
    _, labels, centres = cv2.kmeans(small, k, None, crit, 2, cv2.KMEANS_PP_CENTERS)
    counts = np.bincount(labels.flatten(), minlength=k)
    order = np.argsort(-counts)
    return ['#%02x%02x%02x' % tuple(int(round(c)) for c in centres[i]) for i in order if counts[i] / len(small) >= 0.08]


def subject_box(shot: Shot, best_rgb: np.ndarray | None, w: int, h: int) -> dict | None:
    """Where the subject is: the biggest face, else where things move (camera movement taken out), else the detail."""
    if shot.face_box is not None:
        x, y, fw, fh = shot.face_box
        return {'x': round(x / w, 3), 'y': round(y / h, 3), 'w': round(fw / w, 3), 'h': round(fh / h, 3), 'by': 'face'}
    heat, by = shot.heat, 'motion'
    if heat is None or heat.sum() < 1e-6 or heat.max() < 3 * (heat.mean() + 1e-9):
        if best_rgb is None:
            return None
        import cv2
        g = cv2.cvtColor(cv2.resize(best_rgb, (64, 36), interpolation=cv2.INTER_AREA), cv2.COLOR_RGB2GRAY).astype(np.float32)
        heat = np.abs(cv2.Sobel(g, cv2.CV_32F, 1, 0)) + np.abs(cv2.Sobel(g, cv2.CV_32F, 0, 1))
        heat[heat < np.percentile(heat, 85)] = 0
        by = 'detail'
        if heat.sum() < 1e-6:
            return None
    gh, gw = heat.shape
    ys, xs = np.mgrid[0:gh, 0:gw]
    wsum = heat.sum()

    def spread(coords: np.ndarray, n: int) -> tuple[float, float]:
        flat = coords.flatten()
        order = np.argsort(flat)
        cum = np.cumsum(heat.flatten()[order]) / wsum
        lo = flat[order][np.searchsorted(cum, 0.1)]
        hi = flat[order][min(len(cum) - 1, np.searchsorted(cum, 0.9))]
        return lo / n, (hi + 1) / n

    x0, x1 = spread(xs, gw)
    y0, y1 = spread(ys, gh)
    return {'x': round(float(x0), 3), 'y': round(float(y0), 3), 'w': round(float(x1 - x0), 3), 'h': round(float(y1 - y0), 3), 'by': by}


def scan(a, w: int, h: int, duration: float, hwaccel: str) -> tuple[list[Frame], list[Shot], bool]:
    """One pass over the small frames: measures each frame and splits the shots as it goes."""
    import cv2
    fps = a.fps
    step = 1.0 / fps
    faces = face_detector(w, h, a.face_model)
    face_every = max(1, int(round(fps / 2)))  # faces twice a second is plenty, and the detector is the slow part
    frame_bytes = w * h * 3
    proc = open_frames(a.ffmpeg, a.video, fps, w, h, a.threads, hwaccel)
    shots: list[Shot] = []
    frames: list[Frame] = []
    prev_small = None
    prev_hist = None
    cur: Shot | None = None
    shot_hist = None
    face_hit = None
    last_report = 0.0
    hw, hh = 160, max(2, int(round(160 * h / w / 2)) * 2)
    window = cv2.createHanningWindow((hw, hh), cv2.CV_32F)
    i = 0
    while True:
        buf = proc.stdout.read(frame_bytes)
        if not buf or len(buf) < frame_bytes:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        f = Frame(round(i * step, 3))
        f.sharp = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        f.bright = float(gray.mean()) / 255.0
        f.hist = colour_hist(rgb)
        small = cv2.resize(gray, (hw, hh), interpolation=cv2.INTER_AREA).astype(np.float32)
        cut = False
        heat = None
        if prev_small is not None:
            # phaseCorrelate multiplies its inputs by the window in place, so it gets copies.
            (dx, dy), resp = cv2.phaseCorrelate(prev_small.copy(), small.copy(), window)
            plain = np.abs(small - prev_small)
            if resp < 0.05 or abs(dx) > hw / 3 or abs(dy) > hh / 3 or float((plain < 4).mean()) > 0.7:
                dx, dy = 0.0, 0.0  # no clear match, or most of the picture stands still: the camera is not moving
            f.shift = (dx / hw, dy / hw)
            moved = np.roll(prev_small, (int(round(dy)), int(round(dx))), axis=(0, 1))
            d = np.abs(small - moved)
            m = int(abs(round(dx))) + 1, int(abs(round(dy))) + 1
            inner = d[m[1]:hh - m[1], m[0]:hw - m[0]]
            f.diff = float(inner.mean()) / 255.0 if inner.size else 0.0
            raw = float(plain.mean()) / 255.0
            hd = hist_distance(prev_hist, f.hist)
            # A cut changes the colours and the whole picture at once; a moving subject or a pan changes much less.
            cut = (hd > 0.38 and raw > 0.06) or (hd > 0.25 and raw > 0.12 and f.diff > 0.08)
            if inner.size:
                heat = cv2.resize((inner > 25).astype(np.float32), (32, 18), interpolation=cv2.INTER_AREA)
        if faces is not None and (i % face_every == 0):
            found = faces(rgb, gray)
            if len(found):
                x, y, fw, fh = max(found, key=lambda r: r[2] * r[3])
                f.face = float(fw * fh) / (w * h)
                face_hit = (len(found), f.face, (int(x), int(y), int(fw), int(fh)))
            else:
                face_hit = None
        else:
            f.face = -1.0
            face_hit = None

        length = (f.t - frames[cur.first].t) if cur is not None else 0.0
        boundary = None
        if cur is None:
            boundary = 'start'
        elif cut:
            boundary = 'cut'
        elif length >= MAX_SHOT:
            boundary = 'length'
        elif length >= DRIFT_MIN and shot_hist is not None and hist_distance(shot_hist, f.hist) > 0.45:
            boundary = 'drift'
        if boundary:
            cur = Shot(i, boundary)
            shots.append(cur)
            shot_hist = f.hist
        elif heat is not None:
            cur.heat = heat if cur.heat is None else cur.heat + heat
        frames.append(f)
        cur.frames.append(f)
        if face_hit is not None:
            cur.faces = max(cur.faces, face_hit[0])
            if face_hit[1] > cur.face_share:
                cur.face_share, cur.face_box = face_hit[1], face_hit[2]
        score = best_score(f)
        if score > cur.best[0]:
            cur.best = (score, i, rgb.copy())
        prev_small, prev_hist = small, f.hist
        f.hist = None  # only the previous frame's is needed
        i += 1
        if duration > 0 and f.t - last_report >= max(5.0, duration / 40):
            last_report = f.t
            emit('progress', message='Looking through the footage', done=min(99, int(f.t / duration * 100)), total=100)
    proc.stdout.close()
    err = proc.stderr.read().decode('utf-8', 'replace')
    code = proc.wait()
    if not frames:
        raise RuntimeError('ffmpeg could not read the video: ' + (err.strip()[-400:] or f'exit code {code}'))
    return frames, shots, faces is not None


def analyze(a) -> dict:
    import cv2
    cv2.setNumThreads(1)  # small frames: threads cost more than they save, and ffmpeg needs the cores
    t_begin = time.time()
    duration, sw, sh, has_audio = probe(a.ffmpeg, a.video)
    w = a.width
    h = max(2, int(round(w * sh / sw / 2)) * 2)
    fps = a.fps
    step = 1.0 / fps
    os.makedirs(a.out_dir, exist_ok=True)

    emit('progress', message='Measuring the sound', done=0, total=100)
    loud = loudness_per_second(a.ffmpeg, a.video) if has_audio else []
    if duration > 0:
        loud = loud[: int(np.ceil(duration - 0.05))]  # AAC padding adds a sliver past the end
    try:
        frames, shots, faces_checked = scan(a, w, h, duration, a.hwaccel)
    except RuntimeError:
        if a.hwaccel == 'none':
            raise
        # Some machines cannot decode a file on the graphics card; the processor always can.
        frames, shots, faces_checked = scan(a, w, h, duration, 'none')

    end_time = min(duration, len(frames) * step) if duration > 0 else len(frames) * step
    starts = [frames[s.first].t for s in shots]
    ends = starts[1:] + [round(end_time, 3)]
    med_sharp = float(np.median([np.mean([f.sharp for f in s.frames]) for s in shots])) or 1.0

    out_shots = []
    for n, (s, t0, t1) in enumerate(zip(shots, starts, ends)):
        # The best still keeps away from the cuts at either end, whose times are only as exact as one frame step.
        lo = t0 + (EDGE if s.boundary == 'cut' else 0)
        hi = t1 - (EDGE if n + 1 < len(shots) and shots[n + 1].boundary == 'cut' else 0)
        inside = [f for f in s.frames if lo <= f.t <= hi] or s.frames
        best_f = max(inside, key=best_score)
        best_rgb = s.best[2]
        if best_f.t != frames[s.best[1]].t:
            best_rgb = None  # the overall best was at an edge: grab the chosen one again below
        thumb = f'{a.prefix}{n + 1:04d}.jpg'
        if best_rgb is None:
            best_rgb = grab(a.ffmpeg, a.video, best_f.t, w, h)
        if best_rgb is not None:
            cv2.imwrite(os.path.join(a.out_dir, thumb), cv2.cvtColor(best_rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 82])
        shifts = np.array([f.shift for f in s.frames[1:]]) if len(s.frames) > 1 else np.zeros((1, 2))
        speed = np.linalg.norm(shifts, axis=1)
        # Shake: how much the camera movement jitters around its smoothed path; a smooth pan is not shake.
        if len(shifts) >= 3:
            k = np.ones(3) / 3
            smooth = np.stack([np.convolve(shifts[:, j], k, mode='same') for j in range(2)], axis=1)
            shake = float(np.mean(np.linalg.norm(shifts - smooth, axis=1)))
        else:
            shake = 0.0
        sharp = float(np.mean([f.sharp for f in s.frames]))
        sec = [loud[j] for j in range(int(t0), min(len(loud), int(np.ceil(t1)))) if j < len(loud)]
        out_shots.append({
            'index': n + 1,
            'start': round(t0, 3),
            'end': round(t1, 3),
            'boundary': s.boundary,
            'sharpness': round(sharp, 1),
            'sharpRel': round(sharp / med_sharp, 2),
            'motion': round(float(np.mean([f.diff for f in s.frames[1:]])) if len(s.frames) > 1 else 0.0, 4),
            'cameraMove': round(float(np.mean(speed)) * fps, 4),  # share of the width per second
            'shake': round(shake, 4),
            'brightness': round(float(np.mean([f.bright for f in s.frames])), 3),
            'colors': dominant_colours(best_rgb) if best_rgb is not None else [],
            'faces': s.faces,
            'faceShare': round(s.face_share, 4),
            'subject': subject_box(s, best_rgb, w, h),
            'best': best_f.t,
            'thumb': thumb if best_rgb is not None else None,
            **({'audioDb': round(float(np.mean(sec)), 1), 'audioPeakDb': round(float(np.max(sec)), 1)} if sec else {}),
        })
    emit('progress', message='Done', done=100, total=100)
    return {
        'version': 1,
        'duration': round(duration, 3),
        'width': sw,
        'height': sh,
        'fps': fps,
        'frames': len(frames),
        'hasAudio': has_audio,
        'facesChecked': faces_checked,
        'shots': out_shots,
        'audio': {'step': 1.0, 'db': loud} if loud else None,
        'seconds': round(time.time() - t_begin, 2),
    }


def grab(ffmpeg: str, video: str, t: float, w: int, h: int) -> np.ndarray | None:
    p = subprocess.run([ffmpeg, '-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', f'{t:.3f}', '-i', video, '-frames:v', '1',
                        '-vf', f'scale={w}:{h}:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **flags())
    if p.returncode != 0 or len(p.stdout) < w * h * 3:
        return None
    return np.frombuffer(p.stdout[: w * h * 3], np.uint8).reshape(h, w, 3).copy()


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument('--ffmpeg', default='ffmpeg')
    p.add_argument('--video', required=True)
    p.add_argument('--out-dir', required=True)
    p.add_argument('--prefix', default='shot')
    p.add_argument('--fps', type=float, default=4.0)
    p.add_argument('--width', type=int, default=320)
    p.add_argument('--threads', type=int, default=0)
    p.add_argument('--hwaccel', default='auto')
    p.add_argument('--face-model', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models', 'face_detection_yunet_2023mar.onnx'),
                   help='YuNet .onnx face model, used when OpenCV has no Haar cascades (OpenCV 5)')
    a = p.parse_args()
    try:
        emit('result', data=analyze(a))
    except Exception as e:  # noqa: BLE001
        emit('error', message=str(e) or e.__class__.__name__)
        sys.exit(1)


if __name__ == '__main__':
    main()
