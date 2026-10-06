"""Encoding: frames go to ffmpeg over a pipe, written from a background thread so compositing the
next frame overlaps with encoding this one."""
from __future__ import annotations

import os
import queue
import subprocess
import threading
from fractions import Fraction

from . import media

COLOR_TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']
RGB_TO_YUV = 'scale=out_color_matrix=bt709:out_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format=yuv420p'

_nvenc_cache: dict[str, bool] = {}


def fps_rational(fps: float) -> str:
    """30 -> '30/1', 29.97 -> '30000/1001', 59.94 -> '60000/1001'."""
    r = round(fps)
    if abs(fps - r) < 1e-6:
        return f'{r}/1'
    ntsc = round(fps * 1.001)
    if abs(fps - ntsc / 1.001) < 0.005:
        return f'{ntsc * 1000}/1001'
    f = Fraction(fps).limit_denominator(1001)
    return f'{f.numerator}/{f.denominator}'


def nvenc_available(codec: str = 'h264') -> bool:
    """True when ffmpeg can actually encode with NVENC on this machine (tried, not just listed)."""
    name = 'hevc_nvenc' if codec == 'hevc' else 'h264_nvenc'
    if name in _nvenc_cache:
        return _nvenc_cache[name]
    ok = False
    try:
        p = subprocess.run([media.ffmpeg_path(), '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
                            'color=c=black:s=256x256:r=30:d=0.2', '-frames:v', '2', '-c:v', name, '-f', 'null', '-'],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30,
                           **media.popen_flags())
        ok = p.returncode == 0
    except (OSError, subprocess.SubprocessError, RuntimeError):
        ok = False
    _nvenc_cache[name] = ok
    return ok


def raw_input_args(width: int, height: int, fps: float, yuv: bool) -> list[str]:
    return ['-f', 'rawvideo', '-pix_fmt', 'yuv420p' if yuv else 'rgb24', '-s', f'{width}x{height}',
            '-framerate', fps_rational(fps), '-i', 'pipe:0']


def preview_video_args(frames: int) -> list[str]:
    """Preview chunks: identical settings for every chunk so they join with `-c copy`; each chunk is one GOP."""
    g = max(1, frames)
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
            '-g', str(g), '-keyint_min', str(g), '-sc_threshold', '0', '-bf', '0',
            '-x264-params', 'scenecut=0:open_gop=0:repeat-headers=1', *COLOR_TAGS]


QUALITY = {
    'h264': {'cpu': {'draft': ('veryfast', 26), 'good': ('medium', 20), 'best': ('slow', 17)},
             'nvenc': {'draft': ('p3', 28), 'good': ('p5', 22), 'best': ('p7', 18)}},
    'hevc': {'cpu': {'draft': ('veryfast', 30), 'good': ('medium', 24), 'best': ('slow', 21)},
             'nvenc': {'draft': ('p3', 30), 'good': ('p5', 24), 'best': ('p7', 20)}},
}


def export_video_args(codec: str, encoder: str, quality: str, fps: float) -> list[str]:
    codec = 'hevc' if codec == 'hevc' else 'h264'
    quality = quality if quality in ('draft', 'good', 'best') else 'best'
    preset, q = QUALITY[codec][encoder][quality]
    gop = str(max(1, int(round(fps * 2))))
    if encoder == 'nvenc':
        args = ['-c:v', 'hevc_nvenc' if codec == 'hevc' else 'h264_nvenc', '-preset', preset, '-tune', 'hq',
                '-rc', 'vbr', '-cq', str(q), '-b:v', '0', '-spatial-aq', '1', '-g', gop, '-bf', '3']
        args += ['-profile:v', 'main' if codec == 'hevc' else 'high']
    elif codec == 'hevc':
        args = ['-c:v', 'libx265', '-preset', preset, '-crf', str(q), '-g', gop, '-x265-params', 'log-level=error']
    else:
        args = ['-c:v', 'libx264', '-preset', preset, '-crf', str(q), '-g', gop, '-profile:v', 'high']
    if codec == 'hevc':
        args += ['-tag:v', 'hvc1']
    return args + ['-pix_fmt', 'yuv420p', *COLOR_TAGS]


class FrameWriter:
    """Feeds raw frames to an ffmpeg process."""

    def __init__(self, args: list[str]):
        self.args = args
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                     bufsize=0, **media.popen_flags())
        self.tail = media.StderrTail(self.proc.stderr)
        self.q: queue.Queue = queue.Queue(maxsize=3)
        self.err: BaseException | None = None
        self.t = threading.Thread(target=self._run, daemon=True)
        self.t.start()

    def _run(self) -> None:
        stdin = self.proc.stdin
        while True:
            item = self.q.get()
            if item is None:
                break
            if self.err is not None:
                continue
            try:
                stdin.write(item)
            except (BrokenPipeError, OSError) as e:
                self.err = e
        try:
            stdin.close()
        except OSError:
            pass

    def write(self, data) -> None:
        if self.err is not None:
            raise media.FfmpegError('The encoder stopped: ' + self.tail.text()[-2000:])
        self.q.put(data)

    def close(self) -> None:
        self.q.put(None)
        self.t.join()
        self.proc.wait()
        if self.proc.returncode != 0 or self.err is not None:
            raise media.FfmpegError(f'Encoding failed (exit {self.proc.returncode}): ' + self.tail.text()[-3000:])

    def abort(self) -> None:
        try:
            self.proc.kill()
        except OSError:
            pass
        self.q.put(None)
        self.t.join(timeout=2)
        self.proc.wait()


def temp_path(out: str) -> str:
    """A sibling temp name with the same extension, so ffmpeg picks the same container."""
    d, name = os.path.split(os.path.abspath(out))
    base, ext = os.path.splitext(name)
    return os.path.join(d, f'.{base}.partial{ext or ".mp4"}')
