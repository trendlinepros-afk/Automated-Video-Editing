"""Burned-in captions: one line of a few words, the spoken word and emphasis words in the highlight color."""
from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw

from .graphics import ease_out_back, hex_rgb, load_font

POP_SECONDS = 0.12


class CaptionDrawer:
    def __init__(self, captions: dict, brand: dict, width: int, height: int):
        self.lines = captions.get('lines') or [] if captions.get('burn') else []
        self.style = captions.get('style') or {}
        self.brand = brand
        self.width = width
        self.height = height
        self.cache: dict[tuple, tuple] = {}
        self._i = 0

    def _line_at(self, t: float):
        lines = self.lines
        if not lines:
            return None
        # Lines are in time order; remember where we were (frames mostly move forward).
        i = self._i if self._i < len(lines) else 0
        if lines[i]['start'] > t:
            i = 0
        while i < len(lines) and lines[i]['end'] <= t:
            i += 1
        self._i = i
        if i < len(lines) and lines[i]['start'] <= t < lines[i]['end']:
            return i
        return None

    def overlay(self, t: float):
        """(rgba uint8 array, x, y) for the caption at time t, or None."""
        i = self._line_at(t)
        if i is None:
            return None
        line = self.lines[i]
        active = -1
        for k, w in enumerate(line['words']):
            if w['start'] <= t < w['end']:
                active = k
        since = t - line['start']
        pop = 1.0 if since >= POP_SECONDS else round(0.8 + 0.2 * ease_out_back(since / POP_SECONDS), 3)
        key = (i, active, pop)
        hit = self.cache.get(key)
        if hit is None:
            if len(self.cache) > 64:
                self.cache.clear()
            hit = self._draw(line, active, pop)
            self.cache[key] = hit
        return hit

    def _draw(self, line: dict, active: int, pop: float):
        st = self.style
        W, H = self.width, self.height
        size = float(st.get('size') or 0.055) * H * pop
        font_path = st.get('font') or None
        words = [w.get('text', '') for w in line['words']]
        color = hex_rgb(st.get('color') or '#FFFFFF')
        hi = hex_rgb(st.get('highlightColor') or '#FFD400')
        outline = hex_rgb(st.get('outlineColor') or '#000000')
        max_w = W * 0.86

        def layout(sz):
            font = load_font(sz, font_path, self.brand)
            space = font.getlength(' ')
            widths = [font.getlength(w) for w in words]
            rows: list[list[int]] = [[]]
            row_w = 0.0
            for k, wd in enumerate(widths):
                add = wd if not rows[-1] else space + wd
                if rows[-1] and row_w + add > max_w and len(rows) < 2:
                    rows.append([k])
                    row_w = wd
                else:
                    rows[-1].append(k)
                    row_w += add
            row_widths = [sum(widths[k] for k in r) + space * max(0, len(r) - 1) for r in rows]
            return font, space, widths, rows, row_widths

        font, space, widths, rows, row_widths = layout(size)
        while max(row_widths) > max_w and size > 6:
            size *= 0.92
            font, space, widths, rows, row_widths = layout(size)
        stroke = max(1, int(round(size * 0.11)))
        ascent, descent = font.getmetrics()
        row_h = (ascent + descent) * 1.05
        pad = stroke * 2 + 2
        img_w = int(max(row_widths) + pad * 2)
        img_h = int(row_h * len(rows) + pad * 2)
        img = Image.new('RGBA', (img_w, img_h), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        for r, row in enumerate(rows):
            x = pad + (img_w - 2 * pad - row_widths[r]) / 2
            y = pad + r * row_h
            for k in row:
                w = line['words'][k]
                fill = hi if (k == active or w.get('emphasis')) else color
                d.text((x, y), words[k], font=font, fill=fill + (255,), stroke_width=stroke, stroke_fill=outline + (255,))
                x += widths[k] + space
        pos = st.get('position') or 'bottom'
        cy = {'top': 0.14, 'middle': 0.5}.get(pos, 0.84) * H
        x0 = int(round((W - img_w) / 2))
        y0 = int(round(cy - img_h / 2))
        return np.asarray(img), x0, y0
