"""Countdown or progress bar.

mode 'countdown': a big number in a ring that empties, counting down to zero over the item's length.
mode 'bar': a labelled bar along the bottom that fills over the item's length (e.g. "Part 2 of 5").
"""
import math

from PIL import Image, ImageDraw

META = {
    'description': "Countdown timer in a ring ('countdown') or a filling progress bar with a label ('bar').",
    'inputs': {
        'mode': {'type': 'string', 'default': 'countdown', 'description': "'countdown' or 'bar'"},
        'from': {'type': 'number', 'default': 0, 'description': 'Countdown start number; 0 = the item length in seconds'},
        'label': {'type': 'string', 'default': '', 'description': "Text next to the bar, or under the countdown"},
        'start': {'type': 'number', 'default': 0.0, 'description': "Bar: fill at the start (0..1)"},
        'end': {'type': 'number', 'default': 1.0, 'description': "Bar: fill at the end (0..1)"},
        'color': {'type': 'color', 'default': 'primary', 'description': 'Ring / bar color'},
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


def _countdown(t, ctx, img):
    W, H = ctx.width, ctx.height
    p = ctx.params
    color = ctx.color(p.get('color') or 'primary')
    dark = ctx.color('secondary')
    total = float(p.get('from') or 0) or ctx.duration
    left = max(0.0, total * (1 - t / max(1e-6, ctx.duration)))
    n = int(math.ceil(left - 1e-6))
    frac = left - math.floor(left - 1e-6) if left > 0 else 0
    r = H * 0.16
    cx, cy = W / 2, H / 2
    pop = ctx.ease_out_back(ctx.progress(t, 0, 0.3), 1.8) * (1 - ctx.ease_in_cubic(ctx.progress(t, ctx.duration - 0.2, 0.2)))
    if pop <= 0.01:
        return img
    r *= pop
    size = int(r * 2 + H * 0.06)
    layer = Image.new('RGBA', (size * SS, size * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    c = size * SS / 2
    R = r * SS
    d.ellipse([c - R, c - R, c + R, c + R], fill=dark + (230,))
    ring = H * 0.028 * SS
    d.arc([c - R + ring / 2, c - R + ring / 2, c + R - ring / 2, c + R - ring / 2], 0, 360, fill=(255, 255, 255, 60), width=int(ring))
    sweep = 360 * (left / total if total > 0 else 0)
    if sweep > 0.5:
        d.arc([c - R + ring / 2, c - R + ring / 2, c + R - ring / 2, c + R - ring / 2], -90, -90 + sweep, fill=color + (255,), width=int(ring))
    layer = layer.resize((size, size), Image.LANCZOS)
    _paste(img, layer, int(cx - size / 2), int(cy - size / 2))
    # The number pulses each time it changes.
    beat = ctx.ease_out_cubic(min(1.0, (1 - frac) / 0.25)) if n > 0 else 1.0
    f = ctx.font(r * (0.95 + 0.25 * (1 - beat)))
    s = str(n)
    a, de = f.getmetrics()
    ImageDraw.Draw(img).text((cx - f.getlength(s) / 2, cy - (a + de) / 2), s, font=f, fill=(255, 255, 255, 255))
    label = str(p.get('label') or '')
    if label:
        lf = ctx.font(H * 0.045)
        ImageDraw.Draw(img).text((cx - lf.getlength(label) / 2, cy + r + H * 0.03), label, font=lf, fill=(255, 255, 255, 255),
                                 stroke_width=max(1, int(H * 0.004)), stroke_fill=(0, 0, 0, 255))
    return img


def _bar(t, ctx, img):
    W, H = ctx.width, ctx.height
    p = ctx.params
    color = ctx.color(p.get('color') or 'primary')
    dark = ctx.color('secondary')
    a0, a1 = float(p.get('start', 0) or 0), float(p.get('end', 1) if p.get('end') is not None else 1)
    k = ctx.clamp(a0 + (a1 - a0) * ctx.clamp(t / max(1e-6, ctx.duration)))
    show = ctx.ease_out_cubic(ctx.progress(t, 0, 0.3)) * (1 - ctx.ease_in_cubic(ctx.progress(t, ctx.duration - 0.25, 0.25)))
    if show <= 0.01:
        return img
    bw, bh = W * 0.8, H * 0.03
    x0 = (W - bw) / 2
    y0 = H * 0.9 + (1 - show) * H * 0.08
    layer = Image.new('RGBA', (int(bw * SS), int(bh * SS)), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle([0, 0, layer.width - 1, layer.height - 1], radius=int(bh * SS / 2), fill=dark + (200,))
    fw = max(bh, bw * k) * SS
    d.rounded_rectangle([0, 0, fw - 1, layer.height - 1], radius=int(bh * SS / 2), fill=color + (255,))
    layer = layer.resize((int(bw), int(bh)), Image.LANCZOS)
    _paste(img, layer, int(x0), int(y0))
    label = str(p.get('label') or '')
    if label:
        f = ctx.font(H * 0.04)
        a, de = f.getmetrics()
        ImageDraw.Draw(img).text((x0, y0 - (a + de) - H * 0.01), label, font=f, fill=(255, 255, 255, 255),
                                 stroke_width=max(1, int(H * 0.004)), stroke_fill=(0, 0, 0, 255))
    if show < 1:
        img.putalpha(img.getchannel('A').point(lambda v: int(v * show)))
    return img


def render(t, ctx):
    img = ctx.canvas()
    if str(ctx.params.get('mode', 'countdown')).lower() == 'bar':
        return _bar(t, ctx, img)
    return _countdown(t, ctx, img)
