"""Loudness (ITU-R BS.1770-4 integrated, K-weighted, gated) and true peak (4x oversampled)."""
from __future__ import annotations

import math

import numpy as np
from scipy.signal import resample_poly, sosfilt

# K-weighting at 48 kHz (BS.1770-4, table 1 and 2): high-shelf then high-pass.
_K_SOS_48K = np.array([
    [1.53512485958697, -2.69169618940638, 1.19839281085285, 1.0, -1.69065929318241, 0.73248077421585],
    [1.0, -2.0, 1.0, 1.0, -1.99004745483398, 0.99007225036621],
])


def k_sos(sr: int) -> np.ndarray:
    if sr == 48000:
        return _K_SOS_48K
    # Same filters designed for another rate (bilinear transform of the analogue prototypes).
    f0, g, q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    k = math.tan(math.pi * f0 / sr)
    vh = 10 ** (g / 20)
    vb = vh ** 0.4996667741545416
    a0 = 1 + k / q + k * k
    shelf = [(vh + vb * k / q + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0,
             1.0, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0]
    f0, q = 38.13547087602444, 0.5003270373238773
    k = math.tan(math.pi * f0 / sr)
    a0 = 1 + k / q + k * k
    hp = [1.0, -2.0, 1.0, 1.0, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0]
    return np.array([shelf, hp])


class LoudnessMeter:
    """Feed blocks of (n, channels) float audio; read integrated loudness and true peak at the end."""

    def __init__(self, sr: int = 48000, channels: int = 2):
        self.sr = sr
        self.channels = channels
        self.sos = k_sos(sr)
        self.zi = np.zeros((self.sos.shape[0], 2, channels))
        self.sub = sr // 10  # 100 ms
        self.pending = np.zeros((0, channels))
        self.sub_energy: list[np.ndarray] = []  # per 100 ms: mean square per channel
        self.peak = 0.0
        self.tail = np.zeros((0, channels))

    def add(self, x: np.ndarray) -> None:
        x = np.asarray(x, dtype=np.float64)
        if x.ndim == 1:
            x = x[:, None]
        if not len(x):
            return
        self._true_peak(x)
        y, self.zi = sosfilt(self.sos, x, axis=0, zi=self.zi)
        y = np.concatenate([self.pending, y]) if len(self.pending) else y
        n = len(y) // self.sub
        if n:
            blocks = y[: n * self.sub].reshape(n, self.sub, self.channels)
            self.sub_energy.extend(np.mean(blocks * blocks, axis=1))
        self.pending = y[n * self.sub:]

    def _true_peak(self, x: np.ndarray) -> None:
        ctx = 32
        xx = np.concatenate([self.tail, x]) if len(self.tail) else x
        up = resample_poly(xx, 4, 1, axis=0)
        start = len(self.tail) * 4
        if len(up) > start:
            self.peak = max(self.peak, float(np.max(np.abs(up[start:]))))
        self.peak = max(self.peak, float(np.max(np.abs(x))))
        self.tail = xx[-ctx:]

    def integrated(self) -> float:
        e = np.array(self.sub_energy)
        if len(e) < 4:
            return -math.inf
        # 400 ms blocks with 75 % overlap = sums of 4 consecutive 100 ms blocks.
        blocks = (e[:-3] + e[1:-2] + e[2:-1] + e[3:]) / 4.0
        z = blocks.sum(axis=1)  # channel weights are 1 for left/right
        with np.errstate(divide='ignore'):
            lk = -0.691 + 10 * np.log10(z)
        g1 = z[lk > -70]
        if not len(g1):
            return -math.inf
        rel = -0.691 + 10 * math.log10(float(np.mean(g1))) - 10
        g2 = z[(lk > -70) & (lk > rel)]
        if not len(g2):
            return -math.inf
        return -0.691 + 10 * math.log10(float(np.mean(g2)))

    def true_peak_db(self) -> float:
        return 20 * math.log10(self.peak) if self.peak > 0 else -math.inf


def measure(x: np.ndarray, sr: int = 48000) -> tuple[float, float]:
    """(integrated LUFS, true peak dBTP) of an in-memory signal."""
    x = np.asarray(x)
    ch = 1 if x.ndim == 1 else x.shape[1]
    m = LoudnessMeter(sr, ch)
    step = sr * 20
    for i in range(0, len(x), step):
        m.add(x[i:i + step])
    return m.integrated(), m.true_peak_db()


def true_peak_envelope(x: np.ndarray) -> np.ndarray:
    """Per-sample true-peak estimate (max over channels of the 4x oversampled signal)."""
    if x.ndim == 1:
        x = x[:, None]
    n = len(x)
    out = np.empty(n, dtype=np.float32)
    step = 48000 * 10
    ctx = 64
    for i in range(0, n, step):
        a = max(0, i - ctx)
        b = min(n, i + step + ctx)
        up = resample_poly(x[a:b].astype(np.float64), 4, 1, axis=0)
        up = np.abs(up).max(axis=1)
        seg = up[(i - a) * 4:(i - a) * 4 + (min(n, i + step) - i) * 4]
        out[i:i + len(seg) // 4] = seg.reshape(-1, 4).max(axis=1)
    return np.maximum(out, np.abs(x).max(axis=1))
