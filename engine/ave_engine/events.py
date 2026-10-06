"""The engine's stdout protocol: one JSON object per line.

  {"event":"progress","done":n,"total":n,"fps"?:x,"message"?:s}
  {"event":"chunk_done","index":i,"out":path}
  {"event":"log","level":"info"|"warn"|"error","message":s}
  {"event":"result","data":...}
  {"event":"error","message":s,"trace":s}

claim_stdout() moves the real stdout aside so a stray print (from a graphic file, a library) lands on
stderr instead of corrupting the stream.
"""
from __future__ import annotations

import json
import math
import os
import sys
import threading
import time

_out = None
_lock = threading.Lock()


def claim_stdout() -> None:
    global _out
    if _out is not None:
        return
    sys.stdout.flush()
    try:
        fd = os.dup(1)
        os.dup2(2, 1)
        _out = os.fdopen(fd, 'w', encoding='utf-8', newline='\n')
    except OSError:
        _out = sys.stdout
    sys.stdout = sys.stderr


def _clean(v):
    """JSON cannot hold NaN or infinity; send them as null."""
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, dict):
        return {k: _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    return v


def emit(obj: dict) -> None:
    stream = _out or sys.stdout
    line = json.dumps(_clean(obj), ensure_ascii=False)
    with _lock:
        stream.write(line + '\n')
        stream.flush()


def log(message: str, level: str = 'info') -> None:
    emit({'event': 'log', 'level': level, 'message': message})


def result(data) -> None:
    emit({'event': 'result', 'data': data})


def error(message: str, trace: str = '') -> None:
    emit({'event': 'error', 'message': message, 'trace': trace})


def chunk_done(index: int, out: str) -> None:
    emit({'event': 'chunk_done', 'index': index, 'out': out})


class Progress:
    """Throttled progress events with a frames-per-second estimate."""

    def __init__(self, total: int, every: float = 0.5, message: str | None = None):
        self.total = max(0, int(total))
        self.every = every
        self.message = message
        self.done = 0
        self.t0 = time.perf_counter()
        self.last = 0.0

    def step(self, n: int = 1, force: bool = False) -> None:
        self.done += n
        now = time.perf_counter()
        if force or self.done >= self.total or now - self.last >= self.every:
            self.last = now
            ev = {'event': 'progress', 'done': self.done, 'total': self.total}
            elapsed = now - self.t0
            if elapsed > 0 and self.done:
                ev['fps'] = round(self.done / elapsed, 2)
            if self.message:
                ev['message'] = self.message
            emit(ev)

    @property
    def fps(self) -> float:
        elapsed = time.perf_counter() - self.t0
        return self.done / elapsed if elapsed > 0 else 0.0
