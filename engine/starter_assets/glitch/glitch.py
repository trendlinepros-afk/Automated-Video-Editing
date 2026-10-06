"""Glitch: a custom effect (place it as an Effects-lane item with effect 'custom').

apply(frame, t, ctx): frame is a float32 (height, width, 3) array with values 0..1; return the same shape.
Glitches come in short bursts; the random pattern is seeded from the absolute timeline time, so a
frame glitches the same way in the preview and in the export.
"""
import numpy as np

META = {
    'description': 'Digital glitch bursts: colour channels split, slices of the picture jump sideways, blocky noise.',
    'inputs': {
        'amount': {'type': 'number', 'default': 1.0, 'description': 'Strength (0..2)'},
        'rate': {'type': 'number', 'default': 6.0, 'description': 'Glitch bursts per second'},
    },
}


def apply(frame, t, ctx):
    H, W = frame.shape[:2]
    amount = float(ctx.params.get('amount', 1.0))
    rate = max(0.5, float(ctx.params.get('rate', 6.0)))
    slot = int(ctx.time * rate)
    rng = np.random.default_rng([ctx.seed & 0xFFFFFFFF, slot & 0xFFFFFFFF])
    if rng.random() > 0.65:  # quiet between bursts
        return frame
    out = frame.copy()
    # Channel split, in fractions of the width.
    s = int(round(W * 0.012 * amount * rng.uniform(0.4, 1.0)))
    if s:
        out[:, :, 0] = np.roll(frame[:, :, 0], s, axis=1)
        out[:, :, 2] = np.roll(frame[:, :, 2], -s, axis=1)
    # Horizontal slices jump sideways.
    for _ in range(int(rng.integers(2, 7))):
        y0 = int(rng.uniform(0, 1) * H)
        h = max(1, int(rng.uniform(0.01, 0.08) * H))
        dx = int(rng.uniform(-0.08, 0.08) * W * amount)
        out[y0:y0 + h] = np.roll(out[y0:y0 + h], dx, axis=1)
    # A few blocks of solid colour noise on a grid (same layout at any size).
    gx, gy = 32, max(2, round(32 * H / W))
    for _ in range(int(rng.integers(0, 5 * amount + 1))):
        bx, by = int(rng.integers(0, gx)), int(rng.integers(0, gy))
        x0, x1 = bx * W // gx, (bx + int(rng.integers(1, 4))) * W // gx
        y0, y1 = by * H // gy, (by + 1) * H // gy
        out[y0:y1, x0:x1] = rng.random(3).astype(np.float32)
    return out
