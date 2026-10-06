"""Custom effect: a gentle VHS wobble."""
import numpy as np


def apply(frame, t, ctx):
    shift = int(np.sin(t * 20) * 3 * ctx.params.get("amount", 0.4))
    return np.roll(frame, shift, axis=1)
