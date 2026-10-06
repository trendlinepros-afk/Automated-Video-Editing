"""Lower third: a name bar with a smaller line under it. Slides in, holds, slides out.

Self-contained graphic for the AI Video Editor engine: render(t, ctx) returns a full-frame RGBA image.
"""
from PIL import Image, ImageDraw

META = {
    'description': 'Bold name bar with a second line, slides in from the side and out at the end.',
    'inputs': {
        'title': {'type': 'string', 'default': 'Your Name', 'description': 'Main line (name or topic)'},
        'subtitle': {'type': 'string', 'default': 'Channel host', 'description': 'Smaller second line; empty hides it'},
        'side': {'type': 'string', 'default': 'left', 'description': "'left' or 'right'"},
        'color': {'type': 'color', 'default': 'primary', 'description': "Bar color: a brand color name or '#RRGGBB'"},
        'height': {'type': 'number', 'default': 0.72, 'description': 'Vertical position of the bar (fraction of frame height)'},
    },
}

SS = 2  # supersampling for smooth shape edges


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


def _rounded(size, radius, fill):
    w, h = size
    layer = Image.new('RGBA', (max(1, int(w * SS)), max(1, int(h * SS))), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle([0, 0, layer.width - 1, layer.height - 1], radius=int(radius * SS), fill=fill)
    return layer.resize((max(1, int(w)), max(1, int(h))), Image.LANCZOS)


def render(t, ctx):
    W, H = ctx.width, ctx.height
    p = ctx.params
    img = ctx.canvas()
    title = str(p.get('title') or '')
    sub = str(p.get('subtitle') or '')
    right = str(p.get('side', 'left')).lower() == 'right'
    bar_color = ctx.color(p.get('color') or 'primary')
    dark = ctx.color('secondary')
    accent = ctx.color('accent')

    # Animation: in over 0.45 s, out over the last 0.35 s.
    t_in = ctx.ease_out_back(ctx.progress(t, 0.0, 0.45), 1.2)
    t_out = ctx.ease_in_cubic(ctx.progress(t, ctx.duration - 0.35, 0.35))
    slide = (1 - t_in) + t_out  # 0 = in place, 1 = off screen
    alpha = ctx.clamp(min(ctx.progress(t, 0, 0.12), 1 - t_out))
    if alpha <= 0:
        return img

    title_font = ctx.font(H * 0.07)
    sub_font = ctx.font(H * 0.038)
    pad_x = H * 0.03
    bar_h = H * 0.105
    sub_h = H * 0.062
    tw = title_font.getlength(title)
    sw = sub_font.getlength(sub) if sub else 0
    bar_w = tw + pad_x * 2 + H * 0.02
    sub_w = sw + pad_x * 2
    margin = W * 0.055
    y = H * float(p.get('height', 0.72))
    stripe_w = H * 0.016

    def place_x(w, delay):
        k = ctx.clamp(slide + delay)
        off = (w + margin + stripe_w) * k
        return (W - margin - w + off) if right else (margin - off)

    # Accent stripe, main bar, second bar (the second bar trails slightly).
    bx = place_x(bar_w, 0)
    stripe = _rounded((stripe_w, bar_h), stripe_w * 0.3, accent + (255,))
    bar = _rounded((bar_w, bar_h), H * 0.012, bar_color + (255,))
    sx = bx + bar_w if right else bx - stripe_w * 1.4
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    _paste(layer, stripe, int(sx), int(y))
    _paste(layer, bar, int(bx), int(y))
    d = ImageDraw.Draw(layer)
    asc, desc = title_font.getmetrics()
    d.text((bx + pad_x, y + (bar_h - (asc + desc)) / 2 + H * 0.002), title, font=title_font, fill=(255, 255, 255, 255))
    if sub:
        sub_k = ctx.ease_out_cubic(ctx.progress(t, 0.18, 0.4))
        sxb = place_x(sub_w, 0.25 * (1 - sub_k) if t_out == 0 else 0)
        sub_bar = _rounded((sub_w, sub_h), H * 0.01, dark + (235,))
        sy = y + bar_h + H * 0.008
        _paste(layer, sub_bar, int(sxb), int(sy))
        a2, d2 = sub_font.getmetrics()
        d.text((sxb + pad_x, sy + (sub_h - (a2 + d2)) / 2), sub, font=sub_font, fill=(255, 255, 255, 255))
    if alpha < 1:
        a = layer.getchannel('A').point(lambda v: int(v * alpha))
        layer.putalpha(a)
    img.alpha_composite(layer)
    return img
