"""Motion graphics: each graphic is a self-contained Python file.

A graphic file defines

    META = {'description': '...', 'inputs': {'text': {'type': 'string', 'default': 'Hello', 'description': '...'}}}

    def render(t, ctx):
        # t: seconds since the graphic started. Return a PIL RGBA image (or an HxWx4 uint8 array)
        # of size (ctx.width, ctx.height). Draw sizes relative to ctx.width / ctx.height so the
        # graphic looks the same in the low-resolution preview and the 4K export.
        ...

The context gives width, height, duration, fps, params (META defaults merged with the item's params),
brand (colors, fonts, captionStyle), font(size_px, name=None) and easing helpers.
"""
from __future__ import annotations

import hashlib
import importlib.util
import math
import os
import sys
from functools import lru_cache

import numpy as np
from PIL import Image, ImageFont

FONTS_DIR = os.path.join(os.path.dirname(__file__), 'fonts')
DEFAULT_FONT = os.path.join(FONTS_DIR, 'InterDisplay-Black.otf')
DEFAULT_TEXT_FONT = os.path.join(FONTS_DIR, 'Inter-Bold.otf')

# Bold system fonts tried when a named font is not in the brand kit.
SYSTEM_FONTS = {
    'impact': ['C:/Windows/Fonts/impact.ttf'],
    'arial': ['C:/Windows/Fonts/arialbd.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'],
    'segoe': ['C:/Windows/Fonts/seguibl.ttf', 'C:/Windows/Fonts/segoeuib.ttf'],
    'verdana': ['C:/Windows/Fonts/verdanab.ttf'],
    'dejavu': ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
}

DEFAULT_BRAND = {
    'fonts': [],
    'colors': {'primary': '#FF3B30', 'secondary': '#111111', 'accent': '#FFD400'},
    'logo': {'path': '', 'enabled': False, 'position': 'bottom-right', 'size': 0.08, 'opacity': 0.8},
    'captionStyle': {'font': '', 'size': 0.055, 'position': 'bottom', 'color': '#FFFFFF', 'highlightColor': '#FFD400',
                     'outlineColor': '#000000', 'maxWords': 4},
}


def merge_brand(brand: dict | None) -> dict:
    b = dict(DEFAULT_BRAND)
    if brand:
        for k, v in brand.items():
            if isinstance(v, dict) and isinstance(b.get(k), dict):
                b[k] = {**b[k], **v}
            elif v is not None:
                b[k] = v
    return b


@lru_cache(maxsize=256)
def _truetype(path: str, size: int):
    return ImageFont.truetype(path, size)


def load_font(size_px: float, name: str | None = None, brand: dict | None = None, bold: bool = True):
    """A font at a pixel size: a brand font (by name or file path), a known system font, or the bundled one."""
    size = max(1, int(round(size_px)))
    candidates: list[str] = []
    fonts = (brand or {}).get('fonts') or []
    if name:
        low = name.lower()
        if os.path.isfile(name):
            candidates.append(name)
        for f in fonts:
            if str(f.get('name', '')).lower() == low or os.path.basename(str(f.get('path', ''))).lower().startswith(low):
                candidates.append(f.get('path', ''))
        for key, paths in SYSTEM_FONTS.items():
            if key in low:
                candidates += paths
        win = os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts', name)
        candidates += [win, win + '.ttf']
    else:
        candidates += [f.get('path', '') for f in fonts]
    candidates.append(DEFAULT_FONT if bold else DEFAULT_TEXT_FONT)
    for p in candidates:
        if p and os.path.isfile(p):
            try:
                return _truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default(size)


# Easing helpers (x in 0..1).
def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def lerp(a, b, x):
    return a + (b - a) * x


def progress(t, start, length):
    """0..1 progress of t through [start, start + length]."""
    if length <= 0:
        return 1.0 if t >= start else 0.0
    return clamp((t - start) / length)


def ease_in_cubic(x):
    x = clamp(x)
    return x * x * x


def ease_out_cubic(x):
    x = clamp(x)
    return 1 - (1 - x) ** 3


def ease_in_out_cubic(x):
    x = clamp(x)
    return 4 * x * x * x if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


def ease_out_back(x, s=1.70158):
    x = clamp(x)
    return 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2


def ease_out_elastic(x):
    x = clamp(x)
    if x in (0.0, 1.0):
        return x
    return 2 ** (-10 * x) * math.sin((x * 10 - 0.75) * (2 * math.pi / 3)) + 1


def hex_rgb(color, alpha: int | None = None):
    """'#RRGGBB' / '#RRGGBBAA' / (r, g, b) -> RGB(A) tuple of ints."""
    if isinstance(color, (tuple, list)):
        c = tuple(int(v) for v in color)
    else:
        s = str(color).strip().lstrip('#')
        if len(s) == 3:
            s = ''.join(ch * 2 for ch in s)
        try:
            c = tuple(int(s[i:i + 2], 16) for i in range(0, min(len(s), 8), 2))
        except ValueError:
            c = (255, 255, 255)
        if len(c) < 3:
            c = (255, 255, 255)
    if alpha is not None:
        return c[:3] + (int(alpha),)
    return c


class GraphicContext:
    def __init__(self, width, height, duration, params, fps, brand, time=0.0, seed=0):
        self.width = int(width)
        self.height = int(height)
        self.duration = float(duration)
        self.params = params
        self.fps = float(fps)
        self.brand = brand
        self.colors = brand.get('colors', {})
        self.time = time  # absolute timeline time of this frame
        self.seed = seed
        # helpers
        self.clamp = clamp
        self.lerp = lerp
        self.progress = progress
        self.ease_in_cubic = ease_in_cubic
        self.ease_out_cubic = ease_out_cubic
        self.ease_in_out_cubic = ease_in_out_cubic
        self.ease_out_back = ease_out_back
        self.ease_out_elastic = ease_out_elastic
        self.hex_rgb = hex_rgb

    def font(self, size_px, name=None):
        return load_font(size_px, name, self.brand)

    def text_font(self, size_px, name=None):
        return load_font(size_px, name, self.brand, bold=False)

    def color(self, name_or_hex, alpha=None):
        """A brand color by name ('primary', 'secondary', 'accent') or any hex color, as an RGB(A) tuple."""
        c = self.colors.get(name_or_hex, name_or_hex) if isinstance(name_or_hex, str) else name_or_hex
        return hex_rgb(c, alpha)

    def canvas(self):
        return Image.new('RGBA', (self.width, self.height), (0, 0, 0, 0))

    def fade(self, t, fade_in=0.2, fade_out=0.2):
        """0..1 opacity for a fade in at the start and out at the end of the graphic."""
        a = 1.0
        if fade_in > 0:
            a = min(a, clamp(t / fade_in))
        if fade_out > 0:
            a = min(a, clamp((self.duration - t) / fade_out))
        return a


_modules: dict[str, tuple[int, object]] = {}


def load_module(path: str):
    """Import a graphic or effect file by path. Re-imported when the file changes."""
    path = os.path.abspath(path)
    st = os.stat(path)
    stamp = st.st_mtime_ns ^ st.st_size
    cached = _modules.get(path)
    if cached and cached[0] == stamp:
        return cached[1]
    digest = hashlib.sha1(f'{path}:{stamp}'.encode()).hexdigest()[:12]
    name = f'ave_user_{digest}'
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f'Cannot load {path}')
    mod = importlib.util.module_from_spec(spec)
    folder = os.path.dirname(path)
    added = folder not in sys.path
    if added:
        sys.path.insert(0, folder)  # lets an asset import a helper file that sits next to it
    try:
        spec.loader.exec_module(mod)
    finally:
        if added:
            try:
                sys.path.remove(folder)
            except ValueError:
                pass
    _modules[path] = (stamp, mod)
    return mod


def meta_of(mod) -> dict:
    meta = getattr(mod, 'META', None)
    return meta if isinstance(meta, dict) else {}


def merged_params(mod, params: dict | None) -> dict:
    out = {}
    for k, spec in (meta_of(mod).get('inputs') or {}).items():
        if isinstance(spec, dict) and 'default' in spec:
            out[k] = spec['default']
    out.update(params or {})
    return out


def to_rgba_array(img, width: int, height: int) -> np.ndarray:
    """Whatever render() returned, as an (height, width, 4) uint8 array."""
    if img is None:
        return np.zeros((height, width, 4), dtype=np.uint8)
    if isinstance(img, Image.Image):
        if img.mode != 'RGBA':
            img = img.convert('RGBA')
        if img.size != (width, height):
            img = img.resize((width, height), Image.LANCZOS)
        return np.asarray(img)
    a = np.asarray(img)
    if a.dtype != np.uint8:
        a = (np.clip(a.astype(np.float32), 0, 1) * 255 + 0.5).astype(np.uint8) if a.dtype.kind == 'f' else a.astype(np.uint8)
    if a.ndim == 2:
        a = np.stack([a, a, a, np.full_like(a, 255)], axis=-1)
    if a.shape[2] == 3:
        a = np.concatenate([a, np.full(a.shape[:2] + (1,), 255, dtype=np.uint8)], axis=-1)
    if a.shape[0] != height or a.shape[1] != width:
        a = np.asarray(Image.fromarray(a, 'RGBA').resize((width, height), Image.LANCZOS))
    return a


def render_graphic(path: str, t: float, width: int, height: int, duration: float, params: dict | None,
                   fps: float, brand: dict | None, abs_time: float = 0.0) -> np.ndarray:
    mod = load_module(path)
    fn = getattr(mod, 'render', None)
    if not callable(fn):
        raise RuntimeError(f'{os.path.basename(path)} has no render(t, ctx) function')
    ctx = GraphicContext(width, height, duration, merged_params(mod, params), fps, merge_brand(brand), abs_time,
                         int(hashlib.sha1(path.encode()).hexdigest()[:8], 16))
    return to_rgba_array(fn(t, ctx), width, height)


def checkerboard(width: int, height: int) -> Image.Image:
    sq = max(4, int(round(height / 18)))
    yy, xx = np.mgrid[0:height, 0:width]
    on = ((yy // sq) + (xx // sq)) % 2 == 0
    a = np.where(on[..., None], np.array([200, 200, 200], np.uint8), np.array([150, 150, 150], np.uint8))
    return Image.fromarray(a.astype(np.uint8), 'RGB')
