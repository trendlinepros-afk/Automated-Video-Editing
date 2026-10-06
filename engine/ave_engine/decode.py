"""Footage decoding: one ffmpeg rawvideo pipe per stream, seeked once per contiguous run and read in order.

A reader outputs frames on the source's own frame grid (ffmpeg's fps filter at the source rate), so
frame n always shows source time n / fps, however the reader got there: by reading on from an earlier
point or by a fresh seek. That keeps chunks identical whatever time they start at.
"""
from __future__ import annotations

import math
import os
import queue
import subprocess
import threading

import numpy as np
from PIL import Image, ImageOps

from . import media


class VideoReader:
    # How far ahead (in source seconds) reading on beats a fresh seek.
    MAX_SKIP_SECONDS = 1.5

    def __init__(self, path: str, info: media.ProbeInfo, vf: str, width: int, height: int):
        self.path = path
        self.info = info
        self.fps = info.fps or 30.0
        self.fps_str = info.fps_str or '30/1'
        self.vf = vf
        self.width = width
        self.height = height
        self.frame_bytes = width * height * 3
        self.last_frame_index = int(math.floor(max(0.0, info.duration) * self.fps - 1e-6)) if info.duration else None
        self.proc: subprocess.Popen | None = None
        self.thread: threading.Thread | None = None
        self.q: queue.Queue | None = None
        self.stop = threading.Event()
        self.next_index = 0
        self.cur_index: int | None = None
        self.cur_frame: np.ndarray | None = None
        self.eof = False
        self.idle = 0
        self.tail = None

    def index_for(self, s: float) -> int:
        n = int(math.floor(max(0.0, s) * self.fps + 1e-3))
        if self.last_frame_index is not None:
            n = min(n, max(0, self.last_frame_index))
        return n

    def distance(self, n: int) -> float:
        """Cost estimate for serving frame n from this reader (lower is better, inf = needs a seek)."""
        if n == self.cur_index:
            return 0
        if self.proc is not None and self.next_index <= n <= self.next_index + self.MAX_SKIP_SECONDS * self.fps:
            return n - self.next_index + 1
        return math.inf

    def _start(self, n: int) -> None:
        self.close()
        t = (n - 0.25) / self.fps
        args = [media.ffmpeg_path(), '-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '0']
        if n > 0:
            args += ['-ss', f'{t:.6f}']
        args += ['-i', self.path, '-map', '0:v:0', '-an', '-sn',
                 '-vf', f'fps={self.fps_str},{self.vf},format=rgb24',
                 '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']
        self.proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     bufsize=0, **media.popen_flags())
        self.tail = media.StderrTail(self.proc.stderr)
        self.q = queue.Queue(maxsize=3)
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._pump, args=(self.proc, self.q, self.stop), daemon=True)
        self.thread.start()
        self.next_index = n
        self.eof = False

    def _pump(self, proc, q, stop) -> None:
        fb = self.frame_bytes
        out = proc.stdout
        while not stop.is_set():
            buf = bytearray(fb)
            view = memoryview(buf)
            got = 0
            while got < fb:
                try:
                    r = out.readinto(view[got:])
                except (OSError, ValueError):
                    r = 0
                if not r:
                    break
                got += r
            if got < fb:
                q.put(None)
                return
            while not stop.is_set():
                try:
                    q.put(buf, timeout=0.2)
                    break
                except queue.Full:
                    continue

    def _read_one(self) -> np.ndarray | None:
        if self.eof or self.q is None:
            return None
        buf = self.q.get()
        if buf is None:
            self.eof = True
            return None
        self.next_index += 1
        return np.frombuffer(buf, dtype=np.uint8).reshape(self.height, self.width, 3)

    def frame(self, s: float) -> np.ndarray:
        self.idle = 0
        n = self.index_for(s)
        if n == self.cur_index and self.cur_frame is not None:
            return self.cur_frame
        if self.distance(n) == math.inf:
            self._start(n)
        frame = None
        while self.next_index <= n:
            f = self._read_one()
            if f is None:
                break
            frame = f
        if frame is None:
            if self.cur_frame is not None and self.cur_index is not None and self.cur_index <= n:
                return self.cur_frame  # past the last decodable frame: hold the last one
            # The seek landed past the real end (the container overstated the duration):
            # step back and hold the true last frame.
            last = None
            for back in (max(0, n - int(self.fps) - 1), 0):
                self._start(back)
                while True:
                    f = self._read_one()
                    if f is None:
                        break
                    last = f
                if last is not None:
                    break
            if last is None:
                raise RuntimeError(f'Could not decode {self.path}: ' + (self.tail.text() if self.tail else ''))
            self.last_frame_index = self.next_index - 1
            frame = last
        self.cur_index, self.cur_frame = n, frame
        return frame

    def close(self) -> None:
        if self.proc is not None:
            self.stop.set()
            try:
                self.proc.kill()
            except OSError:
                pass
            try:
                self.proc.stdout.close()
            except OSError:
                pass
            self.proc.wait()
            if self.q is not None:
                while True:
                    try:
                        self.q.get_nowait()
                    except queue.Empty:
                        break
            if self.thread is not None:
                self.thread.join(timeout=2)
        self.proc = None
        self.thread = None
        self.q = None


class ReaderPool:
    """Shares readers between layers that read the same file the same way, so consecutive A-roll
    segments from one clip keep a single decoder running."""

    MAX_IDLE_FRAMES = 90

    def __init__(self):
        self.readers: dict[tuple, list[VideoReader]] = {}

    def frame(self, path: str, info: media.ProbeInfo, vf: str, width: int, height: int, s: float) -> np.ndarray:
        key = (path, vf, width, height)
        lst = self.readers.setdefault(key, [])
        best = None
        best_cost = math.inf
        for r in lst:
            c = r.distance(r.index_for(s))
            if c < best_cost:
                best, best_cost = r, c
        if best is None:
            # Reuse an idle reader of this stream rather than starting one more process.
            idle = [r for r in lst if r.idle > 1]
            best = idle[0] if idle else None
            if best is None:
                best = VideoReader(path, info, vf, width, height)
                lst.append(best)
        return best.frame(s)

    def tick(self) -> None:
        """Called once per output frame: stops readers nobody has used for a while."""
        for key, lst in list(self.readers.items()):
            for r in list(lst):
                r.idle += 1
                if r.idle > self.MAX_IDLE_FRAMES:
                    r.close()
                    lst.remove(r)
            if not lst:
                del self.readers[key]

    def close(self) -> None:
        for lst in self.readers.values():
            for r in lst:
                r.close()
        self.readers.clear()


_image_cache: dict[tuple, Image.Image] = {}


def load_image(path: str) -> Image.Image:
    """An RGBA still, EXIF orientation applied. Cached per file version."""
    st = os.stat(path)
    key = (os.path.abspath(path), st.st_mtime_ns, st.st_size)
    img = _image_cache.get(key)
    if img is None:
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im)
            img = im.convert('RGBA')
        if len(_image_cache) > 32:
            _image_cache.clear()
        _image_cache[key] = img
    return img
