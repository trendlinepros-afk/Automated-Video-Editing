"""Big number / price callout: a punchy badge whose number counts up, with a small label above.

Drawn around the frame centre; move it with the item's transform (x, y, scale) or keyframes.
"""
import math
import re

from PIL import Image, ImageDraw

META = {
    'description': 'Big bold number or price in a badge that pops in and counts up, with a label pill.',
    'inputs': {
        'value': {'type': 'string', 'default': '$1,299', 'description': "The number to show, e.g. '$1,299', '87%', '3x'"},
        'label': {'type': 'string', 'default': 'PRICE', 'description': 'Small label above the number; empty hides it'},
        'count': {'type': 'boolean', 'default': True, 'description': 'Count up to the number'},
        'color': {'type': 'color', 'default': 'primary', 'description': 'Badge color'},
        'textColor': {'type': 'color', 'default': '#FFFFFF', 'description': 'Number color'},
    },
}

SS = 2


def _rounded(w, h, r, fill, rot=0.0):
    layer = Image.new('RGBA', (max(1, int(w * SS)), max(1, int(h * SS))), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle([0, 0, layer.width - 1, layer.height - 1], radius=int(r * SS), fill=fill)
    layer = layer.resize((max(1, int(w)), max(1, int(h))), Image.LANCZOS)
    if rot:
        layer = layer.rotate(rot, resample=Image.BICUBIC, expand=True)
    return layer


def _counted(value: str, k: float) -> str:
    """The value with its number scaled by k, keeping prefix, suffix, separators and decimals."""
    m = re.search(r'\d[\d,]*(?:\.\d+)?', value)
    if not m or k >= 1:
        return value
    num_s = m.group(0)
    decimals = len(num_s.split('.')[1]) if '.' in num_s else 0
    try:
        num = float(num_s.replace(',', ''))
    except ValueError:
        return value
    cur = num * k
    s = f'{cur:,.{decimals}f}' if ',' in num_s else f'{cur:.{decimals}f}'
    return value[: m.start()] + s + value[m.end():]


def render(t, ctx):
    W, H = ctx.width, ctx.height
    p = ctx.params
    img = ctx.canvas()
    value = str(p.get('value', ''))
    label = str(p.get('label') or '')
    color = ctx.color(p.get('color') or 'primary')
    text_color = ctx.color(p.get('textColor') or '#FFFFFF')
    accent = ctx.color('accent')
    dark = ctx.color('secondary')

    pop = ctx.ease_out_back(ctx.progress(t, 0, 0.35), 2.2)
    out = ctx.ease_in_cubic(ctx.progress(t, ctx.duration - 0.25, 0.25))
    scale = max(0.0, pop * (1 - out))
    if scale <= 0.01:
        return img
    count_k = ctx.ease_out_cubic(ctx.progress(t, 0.05, 0.75)) if p.get('count', True) else 1.0
    shown = _counted(value, count_k)

    font = ctx.font(H * 0.16 * scale)
    # Size the badge for the final value so it does not grow while counting.
    full_w = ctx.font(H * 0.16).getlength(value) * scale
    asc, desc = font.getmetrics()
    pad = H * 0.045 * scale
    bw, bh = full_w + pad * 2, (asc + desc) * 0.92 + pad * 1.2
    cx, cy = W / 2, H / 2
    wobble = math.sin(t * 2 * math.pi * 0.6) * 1.2 if t > 0.35 else 0.0
    rot = -3.0 + wobble

    shadow = _rounded(bw, bh, H * 0.03 * scale, (0, 0, 0, 110), rot)
    badge = _rounded(bw, bh, H * 0.03 * scale, color + (255,), rot)
    img.alpha_composite(shadow, (int(cx - shadow.width / 2 + H * 0.012 * scale), int(cy - shadow.height / 2 + H * 0.016 * scale)))
    img.alpha_composite(badge, (int(cx - badge.width / 2), int(cy - badge.height / 2)))

    # Number drawn on its own layer so it rotates with the badge.
    tl = Image.new('RGBA', (int(bw), int(bh)), (0, 0, 0, 0))
    d = ImageDraw.Draw(tl)
    tw = font.getlength(shown)
    d.text(((bw - tw) / 2, (bh - (asc + desc)) / 2 + H * 0.004 * scale), shown, font=font, fill=text_color + (255,),
           stroke_width=max(1, int(H * 0.006 * scale)), stroke_fill=dark + (255,))
    tl = tl.rotate(rot, resample=Image.BICUBIC, expand=True)
    img.alpha_composite(tl, (int(cx - tl.width / 2), int(cy - tl.height / 2)))

    if label:
        lk = ctx.ease_out_back(ctx.progress(t, 0.15, 0.3), 2.0) * (1 - out)
        if lk > 0.01:
            lf = ctx.font(H * 0.045 * lk)
            la, ld = lf.getmetrics()
            lw = lf.getlength(label) + H * 0.04 * lk
            lh = (la + ld) + H * 0.016 * lk
            pill = _rounded(lw, lh, lh / 2, accent + (255,), rot)
            px = cx - bw * 0.42
            py = cy - bh / 2 - lh * 0.55
            img.alpha_composite(pill, (int(px - pill.width / 2 + lw / 2), int(py - pill.height / 2)))
            ll = Image.new('RGBA', (int(lw), int(lh)), (0, 0, 0, 0))
            ImageDraw.Draw(ll).text((H * 0.02 * lk, (lh - (la + ld)) / 2), label, font=lf, fill=dark + (255,))
            ll = ll.rotate(rot, resample=Image.BICUBIC, expand=True)
            img.alpha_composite(ll, (int(px - ll.width / 2 + lw / 2), int(py - ll.height / 2)))
    return img
