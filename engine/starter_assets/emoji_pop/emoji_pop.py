"""Emoji pop: a drawn emoji that springs in, wiggles, then floats up and fades.

Emojis are drawn with shapes (no emoji font needed), so they look the same on every PC.
"""
import math

from PIL import Image, ImageDraw

META = {
    'description': "A big emoji that pops in with a spring, wiggles and floats away. Kinds: laugh, shock, heart, fire, star, cool, think.",
    'inputs': {
        'emoji': {'type': 'string', 'default': 'laugh', 'description': 'laugh | shock | heart | fire | star | cool | think'},
        'size': {'type': 'number', 'default': 0.28, 'description': 'Size as a fraction of frame height'},
        'x': {'type': 'number', 'default': 0.0, 'description': 'Horizontal offset from centre (fraction of width)'},
        'y': {'type': 'number', 'default': 0.0, 'description': 'Vertical offset from centre (fraction of height)'},
    },
}

SS = 2


def _paste(dst, layer, x, y):
    """alpha_composite that accepts positions partly off the canvas."""
    x, y = int(x), int(y)
    if x < 0 or y < 0:
        if -x >= layer.width or -y >= layer.height:
            return
        layer = layer.crop((max(0, -x), max(0, -y), layer.width, layer.height))
        x, y = max(0, x), max(0, y)
    if x < dst.width and y < dst.height:
        dst.alpha_composite(layer, (x, y))
YELLOW = (255, 204, 51)
YELLOW_DARK = (235, 150, 20)
OUTLINE = (60, 35, 10)


def _face(d, c, r, mouth='open'):
    d.ellipse([c - r, c - r, c + r, c + r], fill=YELLOW_DARK + (255,))
    d.ellipse([c - r * 0.97, c - r * 0.99, c + r * 0.97, c + r * 0.9], fill=YELLOW + (255,))


def _draw(kind, size):
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = S / 2
    r = S * 0.46
    lw = max(2, int(S * 0.03))
    if kind in ('laugh', 'shock', 'cool', 'think'):
        _face(d, c, r)
    if kind == 'laugh':
        # closed squinting eyes
        for sx in (-1, 1):
            ex = c + sx * r * 0.38
            ey = c - r * 0.22
            d.line([(ex - r * 0.18, ey - r * 0.08), (ex + r * 0.05 * sx, ey), (ex - r * 0.18, ey + r * 0.08)] if sx < 0 else
                   [(ex + r * 0.18, ey - r * 0.08), (ex - r * 0.05, ey), (ex + r * 0.18, ey + r * 0.08)], fill=OUTLINE + (255,), width=lw, joint='curve')
        d.chord([c - r * 0.6, c - r * 0.25, c + r * 0.6, c + r * 0.7], 0, 180, fill=(110, 30, 30, 255))
        d.chord([c - r * 0.42, c + r * 0.28, c + r * 0.42, c + r * 0.66], 0, 180, fill=(235, 80, 90, 255))
        d.rectangle([c - r * 0.55, c + r * 0.22, c + r * 0.55, c + r * 0.3], fill=(255, 255, 255, 255))
        for sx in (-1, 1):  # tears
            tx = c + sx * r * 0.72
            d.ellipse([tx - r * 0.13, c - r * 0.05, tx + r * 0.13, c + r * 0.35], fill=(90, 180, 255, 255))
    elif kind == 'shock':
        for sx in (-1, 1):
            ex = c + sx * r * 0.35
            d.ellipse([ex - r * 0.17, c - r * 0.45, ex + r * 0.17, c - r * 0.05], fill=(255, 255, 255, 255), outline=OUTLINE + (255,), width=lw)
            d.ellipse([ex - r * 0.07, c - r * 0.3, ex + r * 0.07, c - r * 0.16], fill=OUTLINE + (255,))
        d.ellipse([c - r * 0.22, c + r * 0.12, c + r * 0.22, c + r * 0.68], fill=(110, 30, 30, 255))
    elif kind == 'cool':
        d.rounded_rectangle([c - r * 0.75, c - r * 0.4, c - r * 0.06, c + r * 0.05], radius=int(r * 0.15), fill=(20, 20, 25, 255))
        d.rounded_rectangle([c + r * 0.06, c - r * 0.4, c + r * 0.75, c + r * 0.05], radius=int(r * 0.15), fill=(20, 20, 25, 255))
        d.line([(c - r * 0.9, c - r * 0.3), (c + r * 0.9, c - r * 0.3)], fill=(20, 20, 25, 255), width=lw)
        d.line([(c - r * 0.6, c - r * 0.32), (c - r * 0.35, c - r * 0.1)], fill=(255, 255, 255, 120), width=lw)
        d.arc([c - r * 0.45, c + r * 0.05, c + r * 0.45, c + r * 0.55], 20, 160, fill=OUTLINE + (255,), width=lw * 2)
    elif kind == 'think':
        for sx in (-1, 1):
            ex = c + sx * r * 0.33
            d.ellipse([ex - r * 0.1, c - r * 0.32, ex + r * 0.1, c - r * 0.08], fill=OUTLINE + (255,))
        d.line([(c - r * 0.5, c - r * 0.5), (c - r * 0.2, c - r * 0.58)], fill=OUTLINE + (255,), width=lw)
        d.line([(c - r * 0.2, c + r * 0.38), (c + r * 0.3, c + r * 0.3)], fill=OUTLINE + (255,), width=lw * 2)
        d.ellipse([c - r * 0.45, c + r * 0.45, c + r * 0.05, c + r * 0.95], fill=YELLOW_DARK + (255,))  # hand on chin
    elif kind == 'heart':
        pts = []
        for i in range(120):
            a = i / 120 * 2 * math.pi
            x = 16 * math.sin(a) ** 3
            y = -(13 * math.cos(a) - 5 * math.cos(2 * a) - 2 * math.cos(3 * a) - math.cos(4 * a))
            pts.append((c + x / 17 * r, c + y / 17 * r + r * 0.05))
        d.polygon(pts, fill=(235, 30, 60, 255))
        d.ellipse([c - r * 0.6, c - r * 0.55, c - r * 0.3, c - r * 0.25], fill=(255, 255, 255, 140))
    elif kind == 'fire':
        def flame(scale, col, dy=0.0):
            pts = []
            for i in range(100):
                a = i / 100 * 2 * math.pi
                x = math.sin(a) * (0.55 + 0.1 * math.sin(3 * a))
                y = -math.cos(a) * 0.9
                if y < 0:  # pointy top
                    x *= (1 + y) ** 0.9 + 0.05
                pts.append((c + x * r * scale, c + (y * scale + 0.25 + dy) * r))
            d.polygon(pts, fill=col)
        flame(1.0, (240, 70, 20, 255))
        flame(0.72, (255, 150, 30, 255), 0.18)
        flame(0.42, (255, 230, 120, 255), 0.36)
    else:  # star
        pts = []
        for i in range(10):
            a = -math.pi / 2 + i * math.pi / 5
            rr = r if i % 2 == 0 else r * 0.45
            pts.append((c + math.cos(a) * rr, c + math.sin(a) * rr + r * 0.05))
        d.polygon(pts, fill=(255, 205, 40, 255), outline=YELLOW_DARK + (255,), width=lw)
    return img.resize((size, size), Image.LANCZOS)


def render(t, ctx):
    W, H = ctx.width, ctx.height
    p = ctx.params
    img = ctx.canvas()
    size = max(8, int(H * float(p.get('size', 0.28) or 0.28)))
    spring = ctx.ease_out_elastic(ctx.progress(t, 0, 0.6))
    leave = ctx.ease_in_cubic(ctx.progress(t, ctx.duration - 0.4, 0.4))
    k = spring
    if k <= 0.01 or leave >= 1:
        return img
    key = ('_emoji_cache', str(p.get('emoji', 'laugh')), size)
    cache = globals().setdefault('_CACHE', {})
    base = cache.get(key)
    if base is None:
        if len(cache) > 16:
            cache.clear()
        base = _draw(str(p.get('emoji', 'laugh')).lower(), size)
        cache[key] = base
    s = max(1, int(size * k))
    em = base.resize((s, s), Image.BICUBIC) if s != size else base
    wiggle = math.sin(t * 2 * math.pi * 1.6) * 8 * (1 - ctx.progress(t, 0.4, 1.5))
    em = em.rotate(wiggle, resample=Image.BICUBIC, expand=True)
    cx = W * (0.5 + float(p.get('x', 0) or 0))
    cy = H * (0.5 + float(p.get('y', 0) or 0)) - leave * H * 0.12
    _paste(img, em, int(cx - em.width / 2), int(cy - em.height / 2))
    if leave > 0:
        img.putalpha(img.getchannel('A').point(lambda v: int(v * (1 - leave))))
    return img
