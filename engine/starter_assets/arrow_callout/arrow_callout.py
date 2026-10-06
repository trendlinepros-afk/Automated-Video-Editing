"""Arrow callout: a curved arrow that draws itself towards a point, with a label at its tail.

The arrow tip sits at the frame centre plus (targetX, targetY). To follow something that moves, leave
the target at 0, 0 and give the item keyframes: each keyframe's x, y is where the tip points
(fractions of the frame from the centre).
"""
import math

from PIL import Image, ImageDraw

META = {
    'description': 'Curved arrow that draws in and points at a spot, with a label pill at its tail. Keyframe-friendly: the tip follows the item position.',
    'inputs': {
        'label': {'type': 'string', 'default': 'LOOK HERE', 'description': 'Text at the tail; empty hides it'},
        'angle': {'type': 'number', 'default': 225, 'description': 'Direction the arrow comes from, degrees (0 = from the right, 90 = from below, 180 = from the left, 270 = from above)'},
        'length': {'type': 'number', 'default': 0.35, 'description': 'Arrow length (fraction of frame height)'},
        'bend': {'type': 'number', 'default': 0.25, 'description': 'How curved the arrow is (-1..1)'},
        'targetX': {'type': 'number', 'default': 0.0, 'description': 'Tip offset from centre, fraction of width'},
        'targetY': {'type': 'number', 'default': 0.0, 'description': 'Tip offset from centre, fraction of height'},
        'color': {'type': 'color', 'default': 'accent', 'description': 'Arrow color'},
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


def _bezier(p0, p1, p2, n):
    pts = []
    for i in range(n + 1):
        u = i / n
        a = (1 - u) ** 2
        b = 2 * (1 - u) * u
        c = u * u
        pts.append((a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]))
    return pts


def render(t, ctx):
    W, H = ctx.width, ctx.height
    p = ctx.params
    img = ctx.canvas()
    color = ctx.color(p.get('color') or 'accent')
    dark = ctx.color('secondary')
    out = ctx.ease_in_cubic(ctx.progress(t, ctx.duration - 0.25, 0.25))
    draw_k = ctx.ease_out_cubic(ctx.progress(t, 0.0, 0.45))
    if draw_k <= 0 or out >= 1:
        return img

    tip = (W * (0.5 + float(p.get('targetX', 0) or 0)), H * (0.5 + float(p.get('targetY', 0) or 0)))
    ang = math.radians(float(p.get('angle', 225) or 0))
    length = H * float(p.get('length', 0.35) or 0.35)
    tail = (tip[0] + math.cos(ang) * length, tip[1] + math.sin(ang) * length)
    bend = float(p.get('bend', 0.25) or 0)
    mid = ((tip[0] + tail[0]) / 2, (tip[1] + tail[1]) / 2)
    nx, ny = -math.sin(ang), math.cos(ang)
    ctrl = (mid[0] + nx * length * bend, mid[1] + ny * length * bend)
    # Tip bounce once drawn.
    bounce = math.sin(max(0.0, t - 0.45) * 2 * math.pi * 1.2) * H * 0.008 if t > 0.45 else 0.0
    bx, by = math.cos(ang) * bounce, math.sin(ang) * bounce
    pts = _bezier(tail, ctrl, tip, 40)
    n_show = max(2, int(len(pts) * draw_k))
    pts = [(x + bx, y + by) for x, y in pts[:n_show]]

    thick = H * 0.026
    # Draw at SS within the bounding box only.
    xs = [q[0] for q in pts] + [tip[0]]
    ys = [q[1] for q in pts] + [tip[1]]
    pad = H * 0.08
    x0, y0 = int(max(0, min(xs) - pad)), int(max(0, min(ys) - pad))
    x1, y1 = int(min(W, max(xs) + pad)), int(min(H, max(ys) + pad))
    if x1 <= x0 or y1 <= y0:
        return img
    layer = Image.new('RGBA', ((x1 - x0) * SS, (y1 - y0) * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    sp = [((x - x0) * SS, (y - y0) * SS) for x, y in pts]
    for width, fill in ((thick * 1.8, dark + (255,)), (thick, color + (255,))):
        d.line(sp, fill=fill, width=max(1, int(width * SS)), joint='curve')
        r = width * SS / 2
        for q in (sp[0],):
            d.ellipse([q[0] - r, q[1] - r, q[0] + r, q[1] + r], fill=fill)
    # Head, pointing along the last segment.
    hx, hy = sp[-1]
    px, py = sp[-2]
    hd = math.atan2(hy - py, hx - px)
    hs = thick * 2.6 * SS
    for grow, fill in ((1.35, dark + (255,)), (1.0, color + (255,))):
        s = hs * grow
        tipx, tipy = hx + math.cos(hd) * s * 0.35, hy + math.sin(hd) * s * 0.35
        left = (tipx - math.cos(hd - 0.5) * s, tipy - math.sin(hd - 0.5) * s)
        right = (tipx - math.cos(hd + 0.5) * s, tipy - math.sin(hd + 0.5) * s)
        d.polygon([(tipx, tipy), left, right], fill=fill)
    layer = layer.resize((x1 - x0, y1 - y0), Image.LANCZOS)
    _paste(img, layer, x0, y0)

    label = str(p.get('label') or '')
    if label:
        lk = ctx.ease_out_back(ctx.progress(t, 0.25, 0.3), 2.0)
        if lk > 0.01:
            f = ctx.font(H * 0.05 * lk)
            a, de = f.getmetrics()
            tw = f.getlength(label)
            padx = H * 0.022 * lk
            w, h = tw + padx * 2, a + de + H * 0.02 * lk
            cx = tail[0] + math.cos(ang) * w * 0.35
            cy = tail[1] + math.sin(ang) * h * 0.9
            cx = min(max(cx, w / 2 + W * 0.02), W - w / 2 - W * 0.02)
            cy = min(max(cy, h / 2 + H * 0.02), H - h / 2 - H * 0.02)
            pill = Image.new('RGBA', (int(w * SS), int(h * SS)), (0, 0, 0, 0))
            ImageDraw.Draw(pill).rounded_rectangle([0, 0, pill.width - 1, pill.height - 1], radius=int(h * SS / 2),
                                                   fill=color + (255,), outline=dark + (255,), width=max(1, int(H * 0.004 * SS)))
            pill = pill.resize((int(w), int(h)), Image.LANCZOS)
            _paste(img, pill, int(cx - w / 2), int(cy - h / 2))
            ImageDraw.Draw(img).text((cx - tw / 2, cy - (a + de) / 2), label, font=f, fill=dark + (255,))
    if out > 0:
        img.putalpha(img.getchannel('A').point(lambda v: int(v * (1 - out))))
    return img
