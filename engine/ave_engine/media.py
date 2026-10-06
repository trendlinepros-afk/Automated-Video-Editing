"""ffmpeg and ffprobe: where they are, how to run them, and what a file holds.

ffmpeg's own messages never reach our stdout: they are collected and only shown when a run fails.
"""
from __future__ import annotations

import collections
import json
import os
import shlex
import shutil
import subprocess
import threading
from dataclasses import dataclass, field
from fractions import Fraction

import numpy as np

_paths = {'ffmpeg': None, 'ffprobe': None}

IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff'}
IMAGE_CODECS = {'png', 'mjpeg', 'jpegls', 'webp', 'bmp', 'gif', 'tiff', 'jpeg2000'}


def configure(ffmpeg: str | None = None, ffprobe: str | None = None) -> None:
    if ffmpeg:
        _paths['ffmpeg'] = ffmpeg
    if ffprobe:
        _paths['ffprobe'] = ffprobe


def _find(name: str) -> str:
    if _paths[name]:
        return _paths[name]
    env = os.environ.get('AVE_' + name.upper())
    if env:
        return env
    found = shutil.which(name)
    if found:
        return found
    # ffprobe usually sits next to ffmpeg.
    other = 'ffmpeg' if name == 'ffprobe' else 'ffprobe'
    sibling = _paths[other] or os.environ.get('AVE_' + other.upper())
    if sibling:
        d = os.path.dirname(sibling)
        cand = os.path.join(d, name + ('.exe' if os.name == 'nt' else ''))
        if os.path.exists(cand):
            return cand
    raise RuntimeError(f'{name} was not found. Pass --{name} PATH or set AVE_{name.upper()}.')


def ffmpeg_path() -> str:
    return _find('ffmpeg')


def ffprobe_path() -> str:
    return _find('ffprobe')


def popen_flags() -> dict:
    """No console window per ffmpeg process on Windows."""
    if os.name == 'nt':
        return {'creationflags': 0x08000000}  # CREATE_NO_WINDOW
    return {}


def command_string(args: list[str]) -> str:
    if os.name == 'nt':
        return subprocess.list2cmdline(args)
    return shlex.join(args)


class StderrTail:
    """Keeps the last lines ffmpeg wrote to stderr, read on a thread so the pipe never fills."""

    def __init__(self, stream, keep: int = 60):
        self.lines: collections.deque[str] = collections.deque(maxlen=keep)
        self._t = threading.Thread(target=self._run, args=(stream,), daemon=True)
        self._t.start()

    def _run(self, stream) -> None:
        for raw in iter(stream.readline, b''):
            self.lines.append(raw.decode('utf-8', 'replace').rstrip())
        stream.close()

    def text(self) -> str:
        self._t.join(timeout=2)
        return '\n'.join(self.lines)


class FfmpegError(RuntimeError):
    pass


def run(args: list[str], what: str = 'ffmpeg') -> bytes:
    """Run to completion and return stdout bytes. Raises with ffmpeg's error output on failure."""
    p = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **popen_flags())
    if p.returncode != 0:
        tail = p.stderr.decode('utf-8', 'replace').strip().splitlines()[-25:]
        raise FfmpegError(f'{what} failed (exit {p.returncode}): ' + '\n'.join(tail))
    return p.stdout


def run_with_progress(args: list[str], total_seconds: float, on_progress) -> None:
    """Run an ffmpeg command that has `-progress pipe:1` and report seconds done."""
    p = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **popen_flags())
    tail = StderrTail(p.stderr)
    for raw in iter(p.stdout.readline, b''):
        line = raw.decode('utf-8', 'replace').strip()
        if line.startswith('out_time_us=') or line.startswith('out_time_ms='):
            try:
                us = int(line.split('=', 1)[1])
            except ValueError:
                continue
            on_progress(min(total_seconds, us / 1e6))
    p.wait()
    if p.returncode != 0:
        raise FfmpegError(f'ffmpeg failed (exit {p.returncode}): ' + tail.text()[-3000:])


# ---------------------------------------------------------------------------------------------
# Probing

@dataclass
class ProbeInfo:
    path: str
    kind: str  # video | audio | image
    duration: float
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    fps_str: str | None = None
    has_audio: bool = False
    color: dict = field(default_factory=dict)

    def public(self) -> dict:
        out = {'kind': self.kind, 'duration': round(self.duration, 6), 'hasAudio': self.has_audio}
        if self.width:
            out['width'] = self.width
            out['height'] = self.height
        if self.fps:
            out['fps'] = round(self.fps, 6)
        return out


_probe_cache: dict[tuple, ProbeInfo] = {}


def _rate(s: str | None) -> Fraction | None:
    if not s or s in ('0/0', '0'):
        return None
    try:
        f = Fraction(s)
    except (ValueError, ZeroDivisionError):
        return None
    return f if 0 < f <= 1000 else None


def probe(path: str) -> ProbeInfo:
    if not os.path.exists(path):
        raise FileNotFoundError(f'File not found: {path}')
    st = os.stat(path)
    key = (os.path.abspath(path), st.st_mtime_ns, st.st_size)
    if key in _probe_cache:
        return _probe_cache[key]
    out = run([ffprobe_path(), '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], 'ffprobe')
    data = json.loads(out.decode('utf-8', 'replace') or '{}')
    streams = data.get('streams', [])
    fmt = data.get('format', {})
    ext = os.path.splitext(path)[1].lower()
    video = None
    for s in streams:
        if s.get('codec_type') == 'video' and not (s.get('disposition') or {}).get('attached_pic'):
            video = s
            break
    has_audio = any(s.get('codec_type') == 'audio' for s in streams)
    duration = 0.0
    for v in (fmt.get('duration'), (video or {}).get('duration')):
        try:
            if v is not None:
                duration = max(duration, float(v))
        except ValueError:
            pass
    if video is None:
        info = ProbeInfo(path, 'audio', duration, has_audio=has_audio)
    else:
        w, h = int(video.get('width') or 0), int(video.get('height') or 0)
        rot = 0
        for sd in video.get('side_data_list') or []:
            if 'rotation' in sd:
                try:
                    rot = int(float(sd['rotation']))
                except ValueError:
                    pass
        tags_rot = (video.get('tags') or {}).get('rotate')
        if tags_rot:
            try:
                rot = int(tags_rot)
            except ValueError:
                pass
        if abs(rot) % 180 == 90:
            w, h = h, w
        nb = video.get('nb_frames')
        is_image = (
            ext in IMAGE_EXTS
            or video.get('codec_name') in IMAGE_CODECS and (not duration or duration < 0.05 or nb in ('1', 1))
            or (fmt.get('format_name') or '').endswith('_pipe')
        )
        if is_image:
            info = ProbeInfo(path, 'image', 0.0, w, h, has_audio=False)
        else:
            rate = _rate(video.get('avg_frame_rate')) or _rate(video.get('r_frame_rate')) or Fraction(30)
            if rate > 240:
                rate = _rate(video.get('r_frame_rate')) or Fraction(30)
            color = {k: video[k] for k in ('color_space', 'color_primaries', 'color_transfer', 'color_range')
                     if video.get(k) and video.get(k) != 'unknown'}
            info = ProbeInfo(path, 'video', duration, w, h, float(rate), f'{rate.numerator}/{rate.denominator}',
                             has_audio, color)
    _probe_cache[key] = info
    return info


def file_signature(path: str) -> list:
    try:
        st = os.stat(path)
        return [os.path.abspath(path), st.st_mtime_ns, st.st_size]
    except OSError:
        return [os.path.abspath(path), None, None]


# ---------------------------------------------------------------------------------------------
# Audio decoding

def decode_audio(path: str, start: float = 0.0, duration: float | None = None, sr: int = 48000,
                 channels: int = 2, tempo: float = 1.0) -> np.ndarray:
    """Decode to float32 (samples, channels). `tempo` changes speed without changing pitch."""
    args = [ffmpeg_path(), '-hide_banner', '-nostdin', '-loglevel', 'error']
    if start > 0:
        args += ['-ss', f'{start:.6f}']
    if duration is not None:
        args += ['-t', f'{max(0.0, duration):.6f}']
    args += ['-i', path, '-vn', '-map', '0:a:0?']
    if abs(tempo - 1.0) > 1e-6:
        args += ['-af', atempo_chain(tempo)]
    args += ['-ac', str(channels), '-ar', str(sr), '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1']
    raw = run(args, 'Audio decode')
    a = np.frombuffer(raw, dtype=np.float32)
    n = len(a) // channels
    return a[: n * channels].reshape(n, channels).copy()


def atempo_chain(tempo: float) -> str:
    parts = []
    t = tempo
    while t > 2.0:
        parts.append('atempo=2.0')
        t /= 2.0
    while t < 0.5:
        parts.append('atempo=0.5')
        t /= 0.5
    parts.append(f'atempo={t:.6f}')
    return ','.join(parts)


def stream_audio(path: str, sr: int, channels: int, block_seconds: float = 10.0):
    """Yield float32 (n, channels) blocks of a whole file."""
    args = [ffmpeg_path(), '-hide_banner', '-nostdin', '-loglevel', 'error', '-i', path, '-vn', '-map', '0:a:0',
            '-ac', str(channels), '-ar', str(sr), '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1']
    p = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **popen_flags())
    tail = StderrTail(p.stderr)
    frame_bytes = 4 * channels
    want = int(sr * block_seconds) * frame_bytes
    leftover = b''
    try:
        while True:
            buf = p.stdout.read(want)
            if not buf:
                break
            buf = leftover + buf
            usable = len(buf) - len(buf) % frame_bytes
            leftover = buf[usable:]
            if usable:
                yield np.frombuffer(buf[:usable], dtype=np.float32).reshape(-1, channels)
    finally:
        p.stdout.close()
        p.wait()
    if p.returncode != 0:
        raise FfmpegError('Audio decode failed: ' + tail.text()[-2000:])


def replace_file(tmp: str, path: str, attempts: int = 20) -> None:
    """Move a finished temp file into place. On Windows the target may be open for a moment (the
    preview player reading an older chunk), so retry briefly before giving up."""
    import time

    for i in range(attempts):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(0.1 * (i + 1))


def write_wav(path: str, audio: np.ndarray, sr: int, pcm16: bool = False) -> None:
    """Write a WAV file (float32 by default). Written to a temp name and renamed into place."""
    from scipy.io import wavfile

    a = np.asarray(audio, dtype=np.float32)
    if pcm16:
        a = (np.clip(a, -1.0, 1.0) * 32767.0).round().astype(np.int16)
    tmp = path + '.part'
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(tmp, 'wb') as f:
        wavfile.write(f, sr, a)
    replace_file(tmp, path)
