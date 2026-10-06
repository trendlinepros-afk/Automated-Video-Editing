"""Title card: a big two-line title that punches in, with an underline bar and an optional dim backdrop."""
from PIL import Image, ImageDraw

META = {
    'description': 'Big centred title with a kicker line and an underline that grows; punches in, fades out.',
    'inputs': {
        'title': {'type': 'string', 'default': 'THE BIG REVEAL', 'description': 'Main title'},
        'kicker': {'type': 'string', 'default': 'CHAPTER 1', 'description': 'Small line above the title; empty hides it'},
        'backdrop': {'type': 'number', 'default': 0.45, 'description': 'How much to darken the video behind (0 = none)'},
        'color': {'type': 'color', 'default': 'primary', 'description': 'Underline and kicker color'},
        'textColor': {'type': 'color', 'default': '#FFFFFF', 'description': 'Title color'},
    },
}

SS = 2


def _bar(w, h, r, fill):
    layer = Image.new('RGBA', (max(1, int(w * SS)), max(1, int(h * SS))), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle([0, 0, layer.width - 1, layer.height - 1], radius=int(r * SS), fill=fill)
    return layer.resize((max(1, int(w)), max(1, int(h))), Image.LANCZOS)


def _fit_font(ctx, text, size, max_w):
    f = ctx.font(size)
    while f.getlength(text) > max_w and size > 8:
        size *= 0.93
        f = ctx.font(size)
    return f


def render(t, ctx):
    W, H = ctx.width, ctx.height
    p = ctx.params
    img = ctx.canvas()
    title = str(p.get('title') or '')
    kicker = str(p.get('kicker') or '')
    color = ctx.color(p.get('color') or 'primary')
    text_color = ctx.color(p.get('textColor') or '#FFFFFF')
    fade = ctx.fade(t, 0.15, 0.35)
    if fade <= 0:
        return img

    back = float(p.get('backdrop', 0.45) or 0)
    if back > 0:
        img.paste((0, 0, 0, int(255 * back * fade)), [0, 0, W, H])

    punch = ctx.ease_out_back(ctx.progress(t, 0.0, 0.4), 1.6)
    size = H * 0.15 * (0.7 + 0.3 * punch)
    font = _fit_font(ctx, title, size, W * 0.86)
    asc, desc = font.getmetrics()
    tw = font.getlength(title)
    cy = H * 0.5
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Hard drop shadow, then the title.
    off = H * 0.008
    d.text(((W - tw) / 2 + off, cy - (asc + desc) / 2 + off), title, font=font, fill=(0, 0, 0, 170))
    d.text(((W - tw) / 2, cy - (asc + desc) / 2), title, font=font, fill=text_color + (255,),
           stroke_width=max(1, int(H * 0.004)), stroke_fill=(0, 0, 0, 255))
    # Underline grows from the centre.
    grow = ctx.ease_out_cubic(ctx.progress(t, 0.2, 0.45))
    if grow > 0:
        uw = tw * 0.6 * grow
        uh = H * 0.018
        bar = _bar(uw, uh, uh / 2, color + (255,))
        layer.alpha_composite(bar, (int((W - uw) / 2), int(cy + (asc + desc) / 2 + H * 0.02)))
    if kicker:
        kk = ctx.ease_out_cubic(ctx.progress(t, 0.1, 0.35))
        kf = ctx.font(H * 0.045)
        ka, kd = kf.getmetrics()
        kw = kf.getlength(kicker)
        ky = cy - (asc + desc) / 2 - (ka + kd) - H * 0.02 + (1 - kk) * H * 0.03
        d.text(((W - kw) / 2, ky), kicker, font=kf, fill=color + (int(255 * kk),))
    if fade < 1:
        layer.putalpha(layer.getchannel('A').point(lambda v: int(v * fade)))
    img.alpha_composite(layer)
    return img
