"""The compositor: draws one frame of the timeline at a timeline time.

Order, bottom to top:
  1. Footage: video layers (A-roll, then B-roll) in plan order. Time effects (freeze, speed, replay)
     decide which footage moment is shown.
  2. Effects with the default scope, on the footage.
  3. Graphics, in plan order.
  4. Effects with params.scope == 'all'.
  5. Captions, then the brand logo.

Layout is resolution-independent: a layer's transform places the centre of its box at
(0.5 + x, 0.5 + y) of the frame, scale 1 = the source fitted inside the frame, rotation in degrees
clockwise. So any output size draws the same picture.
"""
from __future__ import annotations

import math

import numpy as np
from PIL import Image, ImageOps

from . import media
from .backend import get_backend
from .captions import CaptionDrawer
from .decode import ReaderPool, load_image
from .effects import TIME_EFFECTS, apply_effect, p_float
from .graphics import merge_brand, render_graphic

EPS = 1e-6
# Footage within this aspect ratio of the frame fills it (edges cropped); further off, it is fitted
# over a blurred copy of itself.
COVER_TOLERANCE = 1.12
GFX_MIN_HEIGHT = 720


def reduce_premultiplied(rgba: np.ndarray, k: int) -> np.ndarray:
    """uint8 straight-alpha RGBA -> float32 premultiplied RGBA, averaged over k x k blocks."""
    if k > 1:
        img = Image.fromarray(np.ascontiguousarray(rgba), 'RGBA').convert('RGBa').reduce(k)
        return np.asarray(img, dtype=np.float32) * (1.0 / 255.0)
    a = rgba.astype(np.float32) * (1.0 / 255.0)
    a[..., :3] *= a[..., 3:4]
    return a


def active(layer: dict, t: float) -> bool:
    return layer['start'] - EPS <= t < layer['end'] - EPS


def fade_opacity(layer: dict, t: float) -> float:
    u = t - layer['start']
    dur = layer['end'] - layer['start']
    a = 1.0
    fi = layer.get('fadeIn') or 0
    fo = layer.get('fadeOut') or 0
    if fi > 0:
        a = min(a, max(0.0, u / fi))
    if fo > 0:
        a = min(a, max(0.0, (dur - u) / fo))
    return max(0.0, min(1.0, a))


def transform_at(layer: dict, u: float) -> tuple[float, float, float, float, float]:
    """(x, y, scale, rotation, opacity) at u seconds into the layer; keyframes interpolate linearly."""
    tr = layer.get('transform') or {}
    x = float(tr.get('x', 0) or 0)
    y = float(tr.get('y', 0) or 0)
    scale = float(tr.get('scale', 1) or 1)
    rot = float(tr.get('rotation', 0) or 0)
    op = tr.get('opacity', 1)
    op = 1.0 if op is None else float(op)
    kfs = sorted(layer.get('keyframes') or [], key=lambda k: k['t'])
    if kfs:
        def val(k, name, default):
            v = k.get(name)
            return float(default if v is None else v)
        if u <= kfs[0]['t']:
            k = kfs[0]
            x, y, scale = val(k, 'x', x), val(k, 'y', y), val(k, 'scale', scale)
        elif u >= kfs[-1]['t']:
            k = kfs[-1]
            x, y, scale = val(k, 'x', x), val(k, 'y', y), val(k, 'scale', scale)
        else:
            for a, b in zip(kfs, kfs[1:]):
                if a['t'] <= u <= b['t']:
                    f = 0.0 if b['t'] <= a['t'] else (u - a['t']) / (b['t'] - a['t'])
                    x = val(a, 'x', x) + (val(b, 'x', x) - val(a, 'x', x)) * f
                    y = val(a, 'y', y) + (val(b, 'y', y) - val(a, 'y', y)) * f
                    scale = val(a, 'scale', scale) + (val(b, 'scale', scale) - val(a, 'scale', scale)) * f
                    break
    return x, y, max(1e-4, scale), rot, max(0.0, min(1.0, op))


def has_transform(layer: dict) -> bool:
    if layer.get('keyframes'):
        return True
    tr = layer.get('transform')
    if not tr:
        return False
    return (abs(tr.get('x', 0) or 0) > 1e-9 or abs(tr.get('y', 0) or 0) > 1e-9 or abs((tr.get('scale', 1) or 1) - 1) > 1e-9
            or abs(tr.get('rotation', 0) or 0) > 1e-9)


def max_scale(layer: dict) -> float:
    tr = layer.get('transform') or {}
    s = float(tr.get('scale', 1) or 1)
    for k in layer.get('keyframes') or []:
        if k.get('scale') is not None:
            s = max(s, float(k['scale']))
    return max(s, 1e-3)


def fit_size(sw: float, sh: float, W: int, H: int) -> tuple[float, float]:
    if sw / sh > W / H:
        return W, W * sh / sw
    return H * sw / sh, H


def box_matrix(W: int, H: int, x: float, y: float, bw: float, bh: float, rot: float, sw: int, sh: int):
    """Inverse map and output bbox for drawing an sw x sh source as a bw x bh box centred at
    (W (0.5 + x), H (0.5 + y)), rotated rot degrees clockwise. Returns (m_inv, x0, y0, x1, y1) or None."""
    cx, cy = W * (0.5 + x), H * (0.5 + y)
    th = math.radians(rot)
    cos, sin = math.cos(th), math.sin(th)
    corners = []
    for px, py in ((-bw / 2, -bh / 2), (bw / 2, -bh / 2), (bw / 2, bh / 2), (-bw / 2, bh / 2)):
        corners.append((cx + px * cos - py * sin, cy + px * sin + py * cos))
    xs = [c[0] for c in corners]
    ys = [c[1] for c in corners]
    x0, x1 = max(0, int(math.floor(min(xs)))), min(W, int(math.ceil(max(xs))))
    y0, y1 = max(0, int(math.floor(min(ys)))), min(H, int(math.ceil(max(ys))))
    if x0 >= x1 or y0 >= y1:
        return None
    sx, sy = sw / bw, sh / bh
    # Output pixel (i, j) of the bbox has centre P = (x0 + i + 0.5, y0 + j + 0.5).
    # Source continuous = (R(-th) (P - C)) * s + (sw/2, sh/2); source index = that - 0.5.
    a, b, c_, d = cos * sx, sin * sx, -sin * sy, cos * sy
    ox, oy = x0 + 0.5 - cx, y0 + 0.5 - cy
    m = np.array([[a, b, a * ox + b * oy + sw / 2 - 0.5],
                  [c_, d, c_ * ox + d * oy + sh / 2 - 0.5]], dtype=np.float64)
    return m, x0, y0, x1, y1


class Renderer:
    def __init__(self, plan: dict, width: int | None = None, height: int | None = None, fps: float | None = None,
                 backend=None, footage_only: bool = False):
        self.plan = plan
        out = plan.get('output') or {}
        self.width = int(width or out.get('width') or 1920)
        self.height = int(height or out.get('height') or 1080)
        self.fps = float(fps or out.get('fps') or 30)
        self.B = backend or get_backend()
        self.brand = merge_brand(plan.get('brand'))
        self.footage_only = footage_only
        layers = plan.get('layers') or []
        self.video = [l for l in layers if l.get('kind') == 'video']
        effects = [l for l in layers if l.get('kind') == 'effect']
        self.time_effects = [e for e in effects if e.get('effect') in TIME_EFFECTS]
        self.footage_effects = [e for e in effects if e.get('effect') not in TIME_EFFECTS
                                and (e.get('params') or {}).get('scope') != 'all']
        self.top_effects = [e for e in effects if e.get('effect') not in TIME_EFFECTS
                            and (e.get('params') or {}).get('scope') == 'all']
        self.graphics = [l for l in layers if l.get('kind') == 'graphic']
        self.pool = ReaderPool()
        # Graphics and captions are drawn at no less than GFX_MIN_HEIGHT lines and box-reduced, so text
        # in a low-resolution preview matches the export instead of being rasterized at a tiny size.
        self.gfx_k = max(1, math.ceil(GFX_MIN_HEIGHT / self.height))
        self.captions = None if footage_only else CaptionDrawer(plan.get('captions') or {}, self.brand,
                                                                self.width * self.gfx_k, self.height * self.gfx_k)
        self.static_cache: dict = {}
        self._footage_key = None
        self._footage = None
        self._caption = None

    # -- timing -----------------------------------------------------------------------------

    def footage_time(self, t: float) -> float:
        ft = t
        for e in self.time_effects:
            if not active(e, t):
                continue
            p = e.get('params') or {}
            kind = e['effect']
            if kind == 'freeze':
                ft = e['start']
            elif kind == 'speed':
                ft = e['start'] + (t - e['start']) * p_float(p, 'rate', 0.5)
            elif kind == 'replay':
                ft = e['start'] - p_float(p, 'lookback', 3.0) + (t - e['start']) * p_float(p, 'speed', 0.5)
        return max(0.0, ft)

    # -- drawing helpers --------------------------------------------------------------------

    def blend(self, F, src, x0: int, y0: int, opacity: float = 1.0):
        """Blend src (h, w, 3 opaque or 4 premultiplied) onto F at (x0, y0) in place."""
        h, w = src.shape[0], src.shape[1]
        xa, ya = max(0, x0), max(0, y0)
        xb, yb = min(self.width, x0 + w), min(self.height, y0 + h)
        if xa >= xb or ya >= yb or opacity <= 0:
            return F
        s = src[ya - y0:yb - y0, xa - x0:xb - x0]
        region = F[ya:yb, xa:xb]
        if s.shape[2] == 4:
            a = s[..., 3:4] * opacity
            F[ya:yb, xa:xb] = region * (1 - a) + s[..., :3] * opacity
        elif opacity >= 1:
            F[ya:yb, xa:xb] = s
        else:
            F[ya:yb, xa:xb] = region + (s - region) * opacity
        return F

    def with_alpha(self, rgb):
        B = self.B
        ones = B.full(rgb.shape[0], rgb.shape[1], (1.0,))
        return B.concat([rgb, ones], axis=-1)

    def draw_box(self, F, src_rgba, x, y, bw, bh, rot, opacity):
        sh, sw = src_rgba.shape[0], src_rgba.shape[1]
        r = box_matrix(self.width, self.height, x, y, bw, bh, rot, sw, sh)
        if r is None:
            return F
        m, x0, y0, x1, y1 = r
        warped = self.B.warp(src_rgba, m, x1 - x0, y1 - y0)
        return self.blend(F, warped, x0, y0, opacity)

    # -- footage ----------------------------------------------------------------------------

    def _image(self, path: str, mode: str, w: int, h: int):
        key = ('img', path, mode, w, h)
        hit = self.static_cache.get(key)
        if hit is not None:
            return hit
        img = load_image(path)
        if mode == 'cover':
            img = ImageOps.fit(img, (w, h), Image.LANCZOS)
        else:
            img = img.resize((max(1, w), max(1, h)), Image.LANCZOS)
        a = np.asarray(img).astype(np.float32) / 255.0
        a[..., :3] *= a[..., 3:4]
        arr = self.B.upload(a)
        self.static_cache[key] = arr
        return arr

    def _source_frame(self, layer: dict, info, mode: str, w: int, h: int, s: float):
        """RGB (or premultiplied RGBA for images) of the layer's source at source time s, sized w x h."""
        if layer.get('isImage') or info.kind == 'image':
            return self._image(layer['path'], mode, w, h)
        if mode == 'cover':
            vf = f'scale={w}:{h}:force_original_aspect_ratio=increase:flags=bicubic,crop={w}:{h}'
        else:
            vf = f'scale={w}:{h}:flags=bicubic'
        raw = self.pool.frame(layer['path'], info, vf, w, h, s)
        return self.B.from_uint8(raw)

    def draw_video(self, F, layer: dict, ft: float):
        W, H = self.width, self.height
        info = media.probe(layer['path'])
        u = ft - layer['start']
        s = layer.get('sourceIn', 0) if layer.get('hold') else layer.get('sourceIn', 0) + u * (layer.get('speed') or 1)
        if info.kind == 'video' and info.duration:
            s = min(s, max(0.0, info.duration - 0.5 / (info.fps or 30)))
        sw = info.width or layer.get('sourceWidth') or W
        sh = info.height or layer.get('sourceHeight') or H
        fade = fade_opacity(layer, ft)
        if not has_transform(layer):
            op = fade * transform_at(layer, u)[4]
            ratio = (sw / sh) / (W / H)
            if 1 / COVER_TOLERANCE <= ratio <= COVER_TOLERANCE:
                src = self._source_frame(layer, info, 'cover', W, H, s)
                return self.blend(F, src, 0, 0, op)
            bw, bh = fit_size(sw, sh, W, H)
            fw, fh = max(2, int(round(bw))), max(2, int(round(bh)))
            src = self._source_frame(layer, info, 'fit', fw, fh, s)
            if src.shape[2] == 3:
                bg = self._blur_cover(src)
                self.blend(F, bg, 0, 0, op)
            return self.blend(F, src, (W - fw) // 2, (H - fh) // 2, op)
        x, y, scale, rot, op = transform_at(layer, u)
        bw, bh = fit_size(sw, sh, W, H)
        dscale = max_scale(layer)
        dw = max(2, min(int(round(bw * dscale)), W * 2))
        dh = max(2, min(int(round(bh * dscale)), H * 2))
        src = self._source_frame(layer, info, 'fit', dw, dh, s)
        if src.shape[2] == 3:
            src = self.with_alpha(src)
        return self.draw_box(F, src, x, y, bw * scale, bh * scale, rot, op * fade)

    def _blur_cover(self, fitted):
        """A blurred, darkened copy of a fitted frame that fills the whole frame behind it."""
        B = self.B
        W, H = self.width, self.height
        fh, fw = fitted.shape[0], fitted.shape[1]
        sh = 36
        sw = max(2, int(round(fw * sh / fh)))
        small = B.resize(fitted, sw, sh)
        small = B.blur(small, 2.0)
        # crop the small image to the frame's aspect, then scale up
        if sw / sh > W / H:
            cw = max(1, int(round(sh * W / H)))
            x0 = (sw - cw) // 2
            small = small[:, x0:x0 + cw]
        else:
            ch = max(1, int(round(sw * H / W)))
            y0 = (sh - ch) // 2
            small = small[y0:y0 + ch]
        return B.resize(small, W, H) * 0.55

    def footage(self, ft: float):
        B = self.B
        F = B.zeros(self.height, self.width, 3)
        for layer in self.video:
            if active(layer, ft):
                F = self.draw_video(F, layer, ft)
        return F

    # -- graphics, captions, logo ------------------------------------------------------------

    def draw_graphic(self, F, layer: dict, t: float):
        W, H = self.width, self.height
        k = self.gfx_k
        u = t - layer['start']
        dur = layer['end'] - layer['start']
        x, y, scale, rot, op = transform_at(layer, u)
        op *= fade_opacity(layer, t)
        if op <= 0:
            return F
        rgba = render_graphic(layer['file'], u, W * k, H * k, dur, layer.get('params') or {}, self.fps, self.brand, t)
        alpha = rgba[..., 3]
        if not alpha.any():
            return F
        if not has_transform(layer):
            # Upload only the part that has something drawn on it (aligned to the reduction grid).
            rows = np.flatnonzero(alpha.any(axis=1))
            cols = np.flatnonzero(alpha.any(axis=0))
            y0, y1 = rows[0] // k * k, -(-(rows[-1] + 1) // k) * k
            x0, x1 = cols[0] // k * k, -(-(cols[-1] + 1) // k) * k
            part = self.B.upload(reduce_premultiplied(rgba[y0:y1, x0:x1], k))
            return self.blend(F, part, int(x0 // k), int(y0 // k), op)
        src = self.B.upload(reduce_premultiplied(rgba, k))
        return self.draw_box(F, src, x, y, W * scale, H * scale, rot, op)

    def draw_captions(self, F, t: float):
        if self.captions is None:
            return F
        ov = self.captions.overlay(t)
        if ov is None:
            return F
        arr, x0, y0 = ov
        if self._caption is None or self._caption[0] is not arr:
            k = self.gfx_k
            # Pad so the image sits on the reduction grid, then reduce to output size.
            px, py = x0 % k, y0 % k
            h, w = arr.shape[0] + py, arr.shape[1] + px
            h2, w2 = -(-h // k) * k, -(-w // k) * k
            big = np.zeros((h2, w2, 4), np.uint8)
            big[py:py + arr.shape[0], px:px + arr.shape[1]] = arr
            self._caption = (arr, self.B.upload(reduce_premultiplied(big, k)), (x0 - px) // k, (y0 - py) // k)
        return self.blend(F, self._caption[1], self._caption[2], self._caption[3], 1.0)

    def draw_logo(self, F):
        logo = (self.brand.get('logo') or {})
        path = logo.get('path')
        if not logo.get('enabled') or not path:
            return F
        W, H = self.width, self.height
        key = ('logo', path, W, H)
        hit = self.static_cache.get(key)
        if hit is None:
            try:
                img = load_image(path)
            except OSError:
                self.static_cache[key] = False
                return F
            lw = max(2, int(round(float(logo.get('size') or 0.08) * W)))
            lh = max(2, int(round(lw * img.height / img.width)))
            img = img.resize((lw, lh), Image.LANCZOS)
            a = np.asarray(img).astype(np.float32) / 255.0
            a[..., :3] *= a[..., 3:4]
            m = int(round(0.03 * H))
            pos = logo.get('position') or 'bottom-right'
            x0 = m if 'left' in pos else W - lw - m
            y0 = m if 'top' in pos else H - lh - m
            hit = (self.B.upload(a), x0, y0)
            self.static_cache[key] = hit
        if hit is False:
            return F
        arr, x0, y0 = hit
        return self.blend(F, arr, x0, y0, float(logo.get('opacity', 0.8) if logo.get('opacity') is not None else 0.8))

    # -- the frame ---------------------------------------------------------------------------

    def frame(self, t: float):
        """The composited frame at timeline time t, as a backend float RGB array."""
        ft = self.footage_time(t)
        remapped = abs(ft - t) > 1e-9
        if remapped:
            key = round(ft * 1e6)
            if key != self._footage_key:
                self._footage = self.footage(ft)
                self._footage_key = key
            F = self.B.copy(self._footage)
        else:
            F = self.footage(t)
        if self.footage_only:
            self.pool.tick()
            return F
        for e in self.footage_effects:
            if active(e, t):
                F = apply_effect(self, e, F, t)
        for g in self.graphics:
            if active(g, t):
                F = self.draw_graphic(F, g, t)
        for e in self.top_effects:
            if active(e, t):
                F = apply_effect(self, e, F, t)
        F = self.draw_captions(F, t)
        F = self.draw_logo(F)
        self.pool.tick()
        return F

    def frame_uint8(self, t: float) -> np.ndarray:
        return self.B.to_uint8(self.frame(t))

    def close(self) -> None:
        self.pool.close()
