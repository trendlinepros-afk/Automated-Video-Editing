"""Like and subscribe: a like button and a subscribe button slide up, a cursor clicks both, the bell rings.

Timing scales with the item's length (4-5 seconds works best).
"""
import math

from PIL import Image, ImageDraw

META = {
    'description': 'Animated like + subscribe + bell reminder with a cursor that clicks each button.',
    'inputs': {
        'subscribeText': {'type': 'string', 'default': 'SUBSCRIBE', 'description': 'Button text before the click'},
        'subscribedText': {'type': 'string', 'default': 'SUBSCRIBED', 'description': 'Button text after the click'},
        'position': {'type': 'string', 'default': 'bottom', 'description': "'bottom', 'middle' or 'top'"},
        'color': {'type': 'color', 'default': 'primary', 'description': 'Subscribe button color'},
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
GREY = (60, 60, 64)
LIGHT = (245, 245, 245)


def _pill(w, h, fill, outline=None, ow=0):
    layer = Image.new('RGBA', (max(1, int(w * SS)), max(1, int(h * SS))), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle([0, 0, layer.width - 1, layer.height - 1], radius=int(h * SS / 2),
                                            fill=fill, outline=outline, width=int(ow * SS))
    return layer.resize((max(1, int(w)), max(1, int(h))), Image.LANCZOS)


def _thumb(size, color):
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = S / 10
    d.rounded_rectangle([0.6 * u, 4.4 * u, 2.6 * u, 9.2 * u], radius=int(0.4 * u), fill=color)  # cuff
    # hand: palm block plus raised thumb
    d.rounded_rectangle([3.0 * u, 4.2 * u, 8.9 * u, 9.2 * u], radius=int(1.0 * u), fill=color)
    d.polygon([(3.0 * u, 4.8 * u), (5.0 * u, 1.0 * u), (6.2 * u, 1.1 * u), (6.4 * u, 2.4 * u), (5.8 * u, 4.6 * u)], fill=color)
    d.ellipse([4.7 * u, 0.6 * u, 6.5 * u, 2.4 * u], fill=color)
    for k in range(3):  # finger lines
        y = (5.6 + k * 1.15) * u
        d.line([(6.3 * u, y), (8.6 * u, y)], fill=(0, 0, 0, 70), width=max(1, int(0.25 * u)))
    return img.resize((size, size), Image.LANCZOS)


def _bell(size, color, swing_deg):
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = S / 10
    d.ellipse([4.3 * u, 0.8 * u, 5.7 * u, 2.2 * u], fill=color)
    d.chord([2.2 * u, 1.6 * u, 7.8 * u, 9.0 * u], 180, 360, fill=color)
    d.polygon([(2.2 * u, 5.2 * u), (7.8 * u, 5.2 * u), (8.8 * u, 7.6 * u), (1.2 * u, 7.6 * u)], fill=color)
    d.rounded_rectangle([0.9 * u, 7.2 * u, 9.1 * u, 8.1 * u], radius=int(0.4 * u), fill=color)
    d.ellipse([4.1 * u, 8.0 * u, 5.9 * u, 9.6 * u], fill=color)
    img = img.rotate(swing_deg, resample=Image.BICUBIC, center=(S / 2, S * 0.15))
    return img.resize((size, size), Image.LANCZOS)


def _cursor(size):
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = S / 10
    pts = [(1 * u, 0.5 * u), (1 * u, 8.2 * u), (3.0 * u, 6.4 * u), (4.6 * u, 9.6 * u), (6.0 * u, 8.9 * u), (4.5 * u, 5.8 * u), (7.2 * u, 5.6 * u)]
    d.polygon(pts, fill=(255, 255, 255, 255), outline=(0, 0, 0, 255), width=max(1, int(0.5 * u)))
    return img.resize((size, size), Image.LANCZOS)


def render(t, ctx):
    W, H = ctx.width, ctx.height
    p = ctx.params
    img = ctx.canvas()
    D = max(1.5, ctx.duration)
    red = ctx.color(p.get('color') or 'primary')
    # Key moments, as fractions of the length.
    t_like = D * 0.32
    t_sub = D * 0.55
    t_bell = D * 0.72
    show = ctx.ease_out_back(ctx.progress(t, 0, 0.45), 1.4)
    leave = ctx.ease_in_cubic(ctx.progress(t, D - 0.4, 0.4))
    if show <= 0.001 or leave >= 1:
        return img

    bh = H * 0.13
    like_w = bh * 1.25
    font = ctx.font(bh * 0.42)
    liked = t >= t_like
    subbed = t >= t_sub
    sub_text = str(p.get('subscribedText') if subbed else p.get('subscribeText') or 'SUBSCRIBE')
    sub_w = max(font.getlength(str(p.get('subscribeText') or 'SUBSCRIBE')), font.getlength(str(p.get('subscribedText') or 'SUBSCRIBED'))) + bh * 0.9
    bell_w = bh
    gap = bh * 0.25
    total_w = like_w + gap + sub_w + gap + bell_w
    pos = str(p.get('position', 'bottom')).lower()
    cy = {'top': 0.16, 'middle': 0.5}.get(pos, 0.8) * H
    cy += (1 - show) * H * 0.25 + leave * H * 0.25
    x = (W - total_w) / 2
    y = cy - bh / 2

    def press(at):
        k = ctx.progress(t, at - 0.05, 0.2)
        return 1 - 0.12 * math.sin(math.pi * k) if 0 < k < 1 else 1.0

    # Like button.
    pk = press(t_like)
    lw, lh = like_w * pk, bh * pk
    like_bg = _pill(lw, lh, (255, 255, 255, 255) if not liked else (230, 240, 255, 255))
    _paste(img, like_bg, int(x + (like_w - lw) / 2), int(y + (bh - lh) / 2))
    ts = int(bh * 0.66 * pk)
    thumb = _thumb(ts, (40, 110, 255, 255) if liked else GREY + (255,))
    _paste(img, thumb, int(x + like_w / 2 - ts / 2), int(y + bh / 2 - ts / 2 - bh * 0.02))
    x2 = x + like_w + gap
    # Subscribe button.
    pk = press(t_sub)
    sw, sh = sub_w * pk, bh * pk
    sub_bg = _pill(sw, sh, (GREY + (255,)) if subbed else red + (255,))
    _paste(img, sub_bg, int(x2 + (sub_w - sw) / 2), int(y + (bh - sh) / 2))
    a, de = font.getmetrics()
    d = ImageDraw.Draw(img)
    d.text((x2 + sub_w / 2 - font.getlength(sub_text) / 2, y + bh / 2 - (a + de) / 2), sub_text, font=font, fill=LIGHT + (255,))
    x3 = x2 + sub_w + gap
    # Bell, rings after its click.
    ring = ctx.progress(t, t_bell, 0.9)
    swing = math.sin(ring * math.pi * 6) * 25 * (1 - ring) if 0 < ring < 1 else 0.0
    bg = _pill(bell_w, bh, (255, 255, 255, 255))
    _paste(img, bg, int(x3), int(y))
    bs = int(bh * 0.66)
    bell = _bell(bs, (red if t >= t_bell else GREY) + (255,), swing)
    _paste(img, bell, int(x3 + bell_w / 2 - bs / 2), int(y + bh / 2 - bs / 2))

    # Cursor glides between the three buttons and clicks each.
    targets = [(-0.6, (W * 0.62, H * 1.1)), (t_like, (x + like_w * 0.55, cy)), (t_sub, (x2 + sub_w * 0.6, cy)),
               (t_bell, (x3 + bell_w * 0.55, cy)), (D, (x3 + bell_w * 1.6, cy + bh * 1.6))]
    cx, ccy = targets[-1][1]
    for (ta, pa), (tb, pb) in zip(targets, targets[1:]):
        if t <= tb:
            k = ctx.ease_in_out_cubic(ctx.progress(t, max(ta, tb - 0.45), min(0.45, tb - ta)))
            cx, ccy = pa[0] + (pb[0] - pa[0]) * k, pa[1] + (pb[1] - pa[1]) * k
            break
    cs = int(bh * 0.75)
    click = min(press(t_like), press(t_sub), press(t_bell))
    cur = _cursor(max(4, int(cs * click)))
    _paste(img, cur, int(cx), int(ccy))
    if leave > 0:
        img.putalpha(img.getchannel('A').point(lambda v: int(v * (1 - leave))))
    return img
