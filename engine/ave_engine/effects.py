"""Full-frame effects on the Effects lane.

Every effect is drawn in fractions of the frame, and every random choice is seeded from the layer id
and the absolute timeline time, so a frame looks the same at any output size and in any chunk.

Common params (all optional): intensity (0..1+, default 1), fadeIn / fadeOut (seconds over which the
effect blends in and out), scope ('footage' default, or 'all' to apply over graphics too).
Time effects (freeze, speed, replay) change which footage moment is shown; see compositor.py.
"""
from __future__ import annotations

import hashlib
import math

import numpy as np
from PIL import Image, ImageDraw

from .graphics import GraphicContext, clamp, ease_out_cubic, hex_rgb, load_font, load_module, merged_params

TIME_EFFECTS = ('freeze', 'speed', 'replay')


def layer_seed(layer: dict) -> int:
    return int(hashlib.sha1(str(layer.get('id', '')).encode()).hexdigest()[:8], 16)


def time_key(t: float) -> int:
    """Absolute time in whole milliseconds: the same frame gets the same random numbers in any chunk."""
    return int(round(t * 1000))


def rng(seed: int, t: float | None = None, salt: int = 0) -> np.random.Generator:
    parts = [seed & 0xFFFFFFFF, salt]
    if t is not None:
        parts.append(time_key(t) & 0xFFFFFFFF)
    return np.random.default_rng(parts)


def p_float(params: dict, name: str, default: float) -> float:
    try:
        v = params.get(name, default)
        return float(default if v is None else v)
    except (TypeError, ValueError):
        return float(default)


def p_rgb(params: dict, name: str, default) -> tuple:
    v = params.get(name, default)
    if isinstance(v, (int, float)):
        return (float(v),) * 3
    if isinstance(v, (list, tuple)) and len(v) >= 3:
        return tuple(float(x) for x in v[:3])
    return tuple(float(x) for x in default) if isinstance(default, (list, tuple)) else (float(default),) * 3


def blend_weight(layer: dict, t: float) -> float:
    params = layer.get('params') or {}
    u = t - layer['start']
    dur = layer['end'] - layer['start']
    w = 1.0
    fi = p_float(params, 'fadeIn', 0.0)
    fo = p_float(params, 'fadeOut', 0.0)
    if fi > 0:
        w = min(w, clamp(u / fi))
    if fo > 0:
        w = min(w, clamp((dur - u) / fo))
    return w


class EffectContext:
    def __init__(self, renderer, layer: dict, t: float):
        self.r = renderer
        self.B = renderer.B
        self.layer = layer
        self.params = layer.get('params') or {}
        self.t = t
        self.u = t - layer['start']
        self.duration = max(1e-6, layer['end'] - layer['start'])
        self.W = renderer.width
        self.H = renderer.height
        self.fps = renderer.fps
        self.seed = layer_seed(layer)
        self.intensity = p_float(self.params, 'intensity', 1.0)


def low_res_size(W: int, H: int, base: int = 320) -> tuple[int, int]:
    """A fixed-size grid (in frame proportions) for noise, so grain looks the same at any output size."""
    gw = base
    gh = max(2, int(round(base * H / W)))
    return gw, gh


# ---------------------------------------------------------------------------------------------

def fx_grade(F, c: EffectContext):
    p = c.params
    B = c.B
    k = c.intensity
    lift = p_rgb(p, 'lift', 0.0)
    gamma = p_rgb(p, 'gamma', 1.0)
    gain = p_rgb(p, 'gain', 1.0)
    sat = p_float(p, 'saturation', 1.0)
    con = p_float(p, 'contrast', 1.0)
    temp = p_float(p, 'temperature', 0.0)
    x = F
    gain_v = B.upload(np.array(gain, np.float32))
    lift_v = B.upload(np.array(lift, np.float32))
    x = x * gain_v + lift_v * (1 - x)
    x = x.clip(0, 1)
    if any(abs(g - 1) > 1e-6 for g in gamma):
        inv = B.upload(np.array([1.0 / max(1e-3, g) for g in gamma], np.float32))
        x = (x + 1e-6) ** inv
    if abs(con - 1) > 1e-6:
        x = (x - 0.5) * con + 0.5
    if abs(sat - 1) > 1e-6:
        y = B.luma(x)
        x = y + (x - y) * sat
    if abs(temp) > 1e-6:
        x = x * B.upload(np.array([1 + 0.12 * temp, 1 + 0.02 * temp, 1 - 0.12 * temp], np.float32))
    x = x.clip(0, 1)
    if k != 1:
        x = F + (x - F) * k
    return x


def _splat(alpha: np.ndarray, cx: float, cy: float, sigma: float, value: float) -> None:
    h, w = alpha.shape
    r = int(math.ceil(sigma * 2.5)) + 1
    x0, x1 = max(0, int(cx) - r), min(w, int(cx) + r + 2)
    y0, y1 = max(0, int(cy) - r), min(h, int(cy) + r + 2)
    if x0 >= x1 or y0 >= y1:
        return
    ys = np.arange(y0, y1, dtype=np.float32)[:, None] + 0.5 - cy
    xs = np.arange(x0, x1, dtype=np.float32)[None, :] + 0.5 - cx
    blob = np.exp(-(xs * xs + ys * ys) / (2 * sigma * sigma)) * value
    np.maximum(alpha[y0:y1, x0:x1], blob, out=alpha[y0:y1, x0:x1])


def fx_snow(F, c: EffectContext):
    B = c.B
    amount = p_float(c.params, 'amount', 1.0)
    n = int(170 * max(0.0, amount))
    g = rng(c.seed, None, 11)
    x0 = g.random(n)
    y0 = g.random(n)
    speed = g.uniform(0.07, 0.22, n)  # frame heights per second
    size = g.uniform(0.0016, 0.0058, n) * (1 + 0.6 * (g.random(n) < 0.12))  # radius, fraction of height
    sway = g.uniform(0.004, 0.018, n)
    freq = g.uniform(0.3, 1.1, n)
    phase = g.uniform(0, 2 * math.pi, n)
    alpha_v = g.uniform(0.55, 1.0, n)
    # Draw at a capped size; the flakes are soft so upscaling keeps them identical in shape.
    mh = min(c.H, 720)
    mw = max(1, int(round(mh * c.W / c.H)))
    a = np.zeros((mh, mw), np.float32)
    t = c.t
    ys = ((y0 + speed * t) % 1.1) - 0.05
    xs = (x0 + sway * np.sin(freq * t * 2 * math.pi + phase) * (c.H / c.W)) % 1.0
    for i in range(n):
        _splat(a, xs[i] * mw, ys[i] * mh, max(0.6, size[i] * mh), float(alpha_v[i]))
    k = min(1.0, 0.92 * c.intensity)
    am = B.upload(a[..., None])
    if mh != c.H:
        am = B.resize(am, c.W, c.H)
    am = am * k
    return F * (1 - am) + am * 0.97


def fx_light_leak(F, c: EffectContext):
    B = c.B
    g = rng(c.seed, None, 21)
    gw, gh = 96, max(2, int(round(96 * c.H / c.W)))
    ys = (np.arange(gh, dtype=np.float32)[:, None] + 0.5) / gh
    xs = (np.arange(gw, dtype=np.float32)[None, :] + 0.5) / gw
    aspect = c.W / c.H
    palette = [(1.0, 0.45, 0.12), (1.0, 0.78, 0.32), (1.0, 0.25, 0.35), (1.0, 0.6, 0.2)]
    leak = np.zeros((gh, gw, 3), np.float32)
    t = c.t
    for i in range(3):
        ph = g.uniform(0, 2 * math.pi, 2)
        sp = g.uniform(0.12, 0.3, 2)
        cx = 0.5 + 0.65 * math.sin(sp[0] * t + ph[0])
        cy = 0.5 + 0.45 * math.sin(sp[1] * t * 0.8 + ph[1])
        rad = g.uniform(0.35, 0.6)
        d2 = ((xs - cx) * aspect) ** 2 + (ys - cy) ** 2
        blob = np.exp(-d2 / (rad * rad))
        leak += blob[..., None] * np.array(palette[(i + int(g.integers(0, 4))) % 4], np.float32)
    env = math.sin(math.pi * clamp(c.u / c.duration)) ** 0.7
    strength = 0.75 * c.intensity * env
    L = B.resize(B.upload(np.clip(leak, 0, 1.5)), c.W, c.H) * strength
    L = L.clip(0, 1)
    return 1 - (1 - F) * (1 - L)


def _osd(W: int, H: int, label: str) -> np.ndarray:
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    size = H * 0.055
    font = load_font(size)
    x, y = W * 0.05, H * 0.06
    d.text((x, y), label, font=font, fill=(255, 255, 255, 230), stroke_width=max(1, int(size * 0.05)), stroke_fill=(0, 0, 0, 120))
    tx = x + font.getlength(label) + size * 0.4
    tri = [(tx, y + size * 0.2), (tx, y + size * 1.0), (tx + size * 0.7, y + size * 0.6)]
    d.polygon(tri, fill=(255, 255, 255, 230))
    return np.asarray(img)


def fx_vhs(F, c: EffectContext):
    B = c.B
    W, H = c.W, c.H
    k = c.intensity
    x = F
    # Colour bleed: red and blue fringes pull apart horizontally.
    s = 0.0035 * W * k
    r = B.shift_x(x[..., 0:1], s)
    b = B.shift_x(x[..., 2:3], -s)
    x = B.concat([r, x[..., 1:2], b], axis=-1)
    x = (x + B.shift_x(x, 0.0012 * W)) * 0.5  # soft horizontal smear
    # Washed-out tape colour.
    y = B.luma(x)
    x = y + (x - y) * (1 - 0.25 * k)
    x = x * (1 - 0.06 * k) + 0.05 * k
    x = x * B.upload(np.array([1.03, 1.0, 0.95], np.float32))
    # Tracking band rolling down the picture.
    band_y = ((c.t * 0.18 + (c.seed % 1000) / 1000.0) % 1.4) - 0.2
    yy, _ = B.grid(H, W)
    band = ((yy > band_y) & (yy < band_y + 0.035))
    shifted = B.shift_x(x, 0.012 * W * k) * (1 + 0.15 * k)
    x = B.where(band, shifted, x)
    # Scanlines: 120 per picture height, so they sit in the same places at any size.
    lines = 1 - 0.1 * k * (0.5 + 0.5 * B.upload(np.cos(2 * math.pi * 120 * ((np.arange(H, dtype=np.float32) + 0.5) / H))[:, None, None]))
    x = x * lines
    # Grain on a fixed grid.
    gw, gh = low_res_size(W, H, 320)
    noise = rng(c.seed, c.t, 31).normal(0, 1, (gh, gw, 1)).astype(np.float32)
    n = B.resize(B.upload(noise), W, H)
    x = x + n * (0.045 * k)
    x = x.clip(0, 1)
    if c.params.get('osd', True):
        key = ('vhs_osd', W, H, str(c.params.get('label', 'PLAY')))
        osd = c.r.static_cache.get(key)
        if osd is None:
            arr = _osd(W, H, str(c.params.get('label', 'PLAY'))).astype(np.float32) / 255.0
            arr[..., :3] *= arr[..., 3:4]
            osd = B.upload(arr)
            c.r.static_cache[key] = osd
        x = x * (1 - osd[..., 3:4]) + osd[..., :3]
    return x


def _noise1(t: float, seed: int, salt: int, freqs=(1.0, 2.3, 4.1)) -> float:
    g = rng(seed, None, salt)
    ph = g.uniform(0, 2 * math.pi, len(freqs))
    amps = [1.0, 0.5, 0.25]
    v = sum(a * math.sin(2 * math.pi * f * t + p) for a, f, p in zip(amps, freqs, ph))
    return v / sum(amps[: len(freqs)])


def _affine_frame(c: EffectContext, F, zoom: float, cx: float, cy: float, dx: float, dy: float, rot_deg: float):
    """Zoom about (cx, cy) (pixels), rotate and shift the whole frame; returns RGB."""
    th = math.radians(rot_deg)
    cos, sin = math.cos(th), math.sin(th)
    # output point P -> source point S = C + R(-th) (P - C - D) / zoom
    a = cos / zoom
    b = sin / zoom
    ox, oy = cx + dx, cy + dy
    # Output pixel centre P = i + 0.5; source index = M (P - O) + C - 0.5 with M = R(-th) / zoom.
    m = np.array([[a, b, cx - 0.5 + a * (0.5 - ox) + b * (0.5 - oy)],
                  [-b, a, cy - 0.5 - b * (0.5 - ox) + a * (0.5 - oy)]])
    return c.B.warp(F, m, c.W, c.H)


def fx_shake(F, c: EffectContext):
    amt = p_float(c.params, 'amount', 0.015) * c.intensity
    freq = p_float(c.params, 'frequency', 1.0)
    t = c.t * freq
    dx = amt * c.W * _noise1(t * 6.0, c.seed, 41)
    dy = amt * c.H * 1.4 * _noise1(t * 6.5, c.seed, 42)
    rot = amt * 40 * _noise1(t * 4.0, c.seed, 43)
    zoom = 1 + amt * 3.2
    return _affine_frame(c, F, zoom, c.W / 2, c.H / 2, dx, dy, rot)


def fx_flash(F, c: EffectContext):
    col = np.array(hex_rgb(c.params.get('color') or '#FFFFFF'), np.float32) / 255.0
    x = clamp(c.u / c.duration)
    a = c.intensity * (1 - x) ** 2
    if a <= 0:
        return F
    return F * (1 - a) + c.B.upload(col) * a


def fx_zoom(F, c: EffectContext):
    amount = p_float(c.params, 'amount', 0.2)
    ramp = p_float(c.params, 'ramp', 0.0)
    ramp_out = p_float(c.params, 'rampOut', 0.0)
    k = 1.0
    if ramp > 0:
        k = min(k, ease_out_cubic(c.u / ramp))
    if ramp_out > 0:
        k = min(k, ease_out_cubic((c.duration - c.u) / ramp_out))
    zoom = 1 + amount * k * c.intensity
    if zoom <= 1.0005:
        return F
    cx = (0.5 + p_float(c.params, 'x', 0.0) * k) * c.W
    cy = (0.5 + p_float(c.params, 'y', 0.0) * k) * c.H
    # Keep the zoomed view inside the picture.
    hw, hh = c.W / (2 * zoom), c.H / (2 * zoom)
    cx = min(max(cx, hw), c.W - hw)
    cy = min(max(cy, hh), c.H - hh)
    # Show the window around (cx, cy) full frame.
    a = 1 / zoom
    m = np.array([[a, 0.0, cx - 0.5 - a * (c.W / 2 - 0.5)], [0.0, a, cy - 0.5 - a * (c.H / 2 - 0.5)]])
    return c.B.warp(F, m, c.W, c.H)


def fx_vignette(F, c: EffectContext):
    amount = p_float(c.params, 'amount', 0.35) * c.intensity
    soft = p_float(c.params, 'softness', 0.65)
    key = ('vignette', c.W, c.H, round(amount, 4), round(soft, 4))
    mask = c.r.static_cache.get(key)
    if mask is None:
        ys = (np.arange(c.H, dtype=np.float32)[:, None] + 0.5) / c.H - 0.5
        xs = (np.arange(c.W, dtype=np.float32)[None, :] + 0.5) / c.W - 0.5
        r = np.sqrt(xs * xs + ys * ys) / math.sqrt(0.5)
        lo = max(0.0, 1 - soft - 0.15)
        s = np.clip((r - lo) / max(1e-3, 1 - lo), 0, 1)
        s = s * s * (3 - 2 * s)
        mask = c.B.upload((1 - amount * s)[..., None].astype(np.float32))
        c.r.static_cache[key] = mask
    return F * mask


def fx_custom(F, c: EffectContext):
    path = c.layer.get('file')
    if not path:
        raise RuntimeError(f'Custom effect {c.layer.get("id")} has no code file')
    mod = load_module(path)
    fn = getattr(mod, 'apply', None)
    if not callable(fn):
        raise RuntimeError(f'{path} has no apply(frame, t, ctx) function')
    ctx = GraphicContext(c.W, c.H, c.duration, merged_params(mod, c.params), c.fps, c.r.brand, c.t, c.seed)
    frame = c.B.download(F)
    out = fn(frame, c.u, ctx)
    if out is None:
        out = frame
    out = np.asarray(out)
    if out.dtype == np.uint8:
        out = out.astype(np.float32) / 255.0
    out = out.astype(np.float32)
    if out.ndim == 3 and out.shape[2] == 4:
        out = out[..., :3]
    if out.shape[:2] != (c.H, c.W):
        out = np.asarray(c.r.B.download(c.B.resize(c.B.upload(out), c.W, c.H)))
    return c.B.upload(np.clip(out, 0, 1))


EFFECTS = {
    'grade': fx_grade,
    'snow': fx_snow,
    'light_leak': fx_light_leak,
    'vhs': fx_vhs,
    'shake': fx_shake,
    'flash': fx_flash,
    'zoom': fx_zoom,
    'vignette': fx_vignette,
    'custom': fx_custom,
}


def apply_effect(renderer, layer: dict, F, t: float):
    kind = layer.get('effect')
    if kind in TIME_EFFECTS:
        return F
    fn = EFFECTS.get(kind)
    if fn is None:
        return F
    w = blend_weight(layer, t)
    if w <= 0:
        return F
    c = EffectContext(renderer, layer, t)
    out = fn(F, c)
    if w < 1:
        out = F + (out - F) * w
    return out
